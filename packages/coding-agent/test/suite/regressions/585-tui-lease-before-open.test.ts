import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationLock, ConversationLockedError } from "../../../src/core/conversation-log/conversation-lock.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import {
	type AcquireOutcome,
	acquireDaemonLease,
	createDisabledDaemonLink,
	DaemonLeaseUnavailableError,
	type DaemonLink,
	type LeaseWait,
	openSessionWithDaemonLease,
} from "../../../src/modes/interactive/host/daemon-link.ts";
import { createScriptedDaemonLink, createTuiHarness, type TuiHarness } from "../tui-harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function storedSession(): Promise<{ sessionDir: string; ref: SessionReference }> {
	const root = mkdtempSync(join(tmpdir(), "volt-585-lease-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const sessionDir = join(root, "sessions");
	const manager = await SessionManager.create(root, sessionDir);
	await manager.logWriter.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	const ref = manager.getSessionRef()!;
	await manager.closePersistence();
	return { sessionDir, ref };
}

/** A daemon link whose lease outcome the test controls. */
function fakeLink(acquire: () => Promise<AcquireOutcome>) {
	const steps: string[] = [];
	const link: DaemonLink = {
		...createDisabledDaemonLink(),
		start: vi.fn(async () => {
			steps.push("start");
		}),
		acquire: vi.fn(async (sessionId: string, _cwd?: string) => {
			steps.push(`acquire:${sessionId}`);
			return acquire();
		}),
		dispose: vi.fn(async () => {
			steps.push("dispose");
		}),
		viewerAbort: vi.fn(async (viewerFeedId: string) => {
			steps.push(`abort:${viewerFeedId}`);
		}),
	};
	return { link, steps };
}

function keep(opened: { manager: SessionManager }): void {
	cleanups.push(() => opened.manager.closePersistence());
}

describe("regression #585: the TUI takes its daemon lease before opening a session at startup", () => {
	it("waits for a pending lease, whose grant frees the daemon's lock, before opening", async () => {
		const { sessionDir, ref } = await storedSession();
		// The daemon hosts the session mid-turn: its runtime holds the lock.
		const daemonRuntimeLock = ConversationLock.acquire(sessionDir, ref.sessionId);
		let grant!: () => void;
		const granted = new Promise<{ handoff: "warm" }>((resolve) => {
			grant = () => {
				// The daemon disposes its runtime before it grants the lease.
				daemonRuntimeLock.close();
				resolve({ handoff: "warm" });
			};
		});
		const { link, steps } = fakeLink(async () => ({ kind: "pending", viewerFeedId: "vf-1", granted }));
		const onWaiting = vi.fn((wait: LeaseWait) => {
			steps.push("waiting");
			// The user stops the phone's turn; the daemon then disposes its runtime and grants.
			wait.abortRemoteTurn();
			queueMicrotask(grant);
			return () => steps.push("wait ended");
		});

		const opened = await openSessionWithDaemonLease(ref, { createLink: () => link, onWaiting });
		keep(opened);

		expect(steps).toEqual(["start", `acquire:${ref.sessionId}`, "waiting", "abort:vf-1", "wait ended"]);
		expect(onWaiting).toHaveBeenCalledTimes(1);
		expect(opened.manager.getSessionId()).toBe(ref.sessionId);
		// The link keeps the lease for the TUI host.
		expect(opened.link).toBe(link);
		expect(ConversationLock.tryAcquire(sessionDir, ref.sessionId)).toEqual({
			status: "held",
			holder: "this_process",
		});
	});

	it("refuses with guidance when another TUI holds the lease, without opening the session", async () => {
		const { sessionDir, ref } = await storedSession();
		const { link, steps } = fakeLink(async () => ({ kind: "denied", reason: "held_by_tui" }));

		const error = await openSessionWithDaemonLease(ref, {
			createLink: () => link,
			onWaiting: () => () => {},
		}).then(
			(opened) => {
				keep(opened);
				return undefined;
			},
			(failure: unknown) => failure,
		);

		expect(error).toBeInstanceOf(DaemonLeaseUnavailableError);
		expect((error as Error).message).toBe(
			`Session ${ref.sessionId} is open in another Volt window (held_by_tui). Quit it there, then retry.`,
		);
		expect(steps).toEqual(["start", `acquire:${ref.sessionId}`, "dispose"]);
		const probe = ConversationLock.tryAcquire(sessionDir, ref.sessionId);
		expect(probe.status).toBe("acquired");
		if (probe.status === "acquired") probe.lock.close();
	});

	it("refuses when the daemon cannot finish the handoff", async () => {
		const { ref } = await storedSession();
		const { link, steps } = fakeLink(async () => ({
			kind: "pending",
			viewerFeedId: "vf-2",
			granted: Promise.reject(new Error("drain cancelled")),
		}));

		await expect(
			openSessionWithDaemonLease(ref, { createLink: () => link, onWaiting: () => () => {} }),
		).rejects.toThrow(`Could not take session ${ref.sessionId} over from the daemon: drain cancelled`);
		expect(steps.at(-1)).toBe("dispose");
	});

	it("cancels the open while waiting, leaving the session to the daemon", async () => {
		const { sessionDir, ref } = await storedSession();
		const daemonRuntimeLock = ConversationLock.acquire(sessionDir, ref.sessionId);
		cleanups.push(() => daemonRuntimeLock.close());
		const { link, steps } = fakeLink(async () => ({
			kind: "pending",
			viewerFeedId: "vf-3",
			granted: new Promise<never>(() => {}),
		}));

		await expect(
			openSessionWithDaemonLease(ref, {
				createLink: () => link,
				onWaiting: (wait) => {
					queueMicrotask(() => wait.cancel());
					return () => steps.push("wait ended");
				},
			}),
		).rejects.toThrow(
			new DaemonLeaseUnavailableError(`Cancelled opening session ${ref.sessionId}; the daemon keeps it.`),
		);
		// Disposing the link closes its connection, which cancels the daemon's drain.
		expect(steps).toEqual(["start", `acquire:${ref.sessionId}`, "wait ended", "dispose"]);
	});

	it("opens without a lease when the daemon is unavailable, and reports a lock held elsewhere", async () => {
		const { sessionDir, ref } = await storedSession();
		const noop = fakeLink(async () => ({ kind: "noop" }));

		const opened = await openSessionWithDaemonLease(ref, {
			createLink: () => noop.link,
			onWaiting: () => () => {},
		});
		expect(opened.link).toBeUndefined();
		expect(noop.steps).toEqual(["start", `acquire:${ref.sessionId}`, "dispose"]);
		await opened.manager.closePersistence();

		// A lease does not override a lock another host holds: the open still fails closed.
		const elsewhere = ConversationLock.acquire(sessionDir, ref.sessionId);
		cleanups.push(() => elsewhere.close());
		const granted = fakeLink(async () => ({ kind: "granted", handoff: "none" }));
		await expect(
			openSessionWithDaemonLease(ref, { createLink: () => granted.link, onWaiting: () => () => {} }),
		).rejects.toBeInstanceOf(ConversationLockedError);
		expect(granted.steps.at(-1)).toBe("dispose");
	});

	it("leases a session the running TUI switches to in that session's directory, keeping its link", async () => {
		const granted = fakeLink(async () => ({ kind: "granted", handoff: "none" }));
		await expect(
			acquireDaemonLease(granted.link, "s-2", { cwd: "/elsewhere", onWaiting: () => () => {} }),
		).resolves.toBe(true);
		expect(granted.link.acquire).toHaveBeenCalledWith("s-2", "/elsewhere");

		const denied = fakeLink(async () => ({ kind: "denied", reason: "held_by_tui" }));
		await expect(
			acquireDaemonLease(denied.link, "s-3", { cwd: "/elsewhere", onWaiting: () => () => {} }),
		).rejects.toBeInstanceOf(DaemonLeaseUnavailableError);
		// Only startup disposes a link it created; the running TUI keeps its own.
		expect(denied.steps).toEqual(["acquire:s-3"]);
	});
});

describe.each(["regular", "fullscreen"] as const)(
	"regression #585: the TUI shows the wait for the daemon's turn as a dialog (%s)",
	(tuiMode) => {
		let harness: TuiHarness | undefined;

		afterEach(async () => {
			await harness?.cleanup();
			harness = undefined;
		});

		async function resumeWaiting(granted: Promise<{ handoff: "warm" }>) {
			const link = createScriptedDaemonLink();
			const created = await createTuiHarness({ link });
			harness = created;
			const tui = await created.startMode({ tuiMode, columns: 120, rows: 30 });
			const target = await created.storeSession();
			link.outcomes.set(target.sessionId, () => ({ kind: "pending", viewerFeedId: "vf-tui", granted }));
			const resuming = tui.resume(target);
			await vi.waitFor(() => expect(tui.screen()).toContain("Waiting for the remote turn"));
			expect(tui.screen()).toContain("Stop remote turn");
			expect(tui.screen()).toContain("Cancel");
			return { link, tui, target, resuming, harness: created };
		}

		it("cancels the resume on Esc, keeping the session it shows; the daemon keeps the target", async () => {
			const { link, tui, target, resuming, harness } = await resumeWaiting(new Promise<never>(() => {}));
			const shown = harness.startup.id;

			tui.terminal.sendInput("\x1b");

			await expect(resuming).resolves.toEqual({ cancelled: true });
			expect(harness.connector.conversation.id).toBe(shown);
			expect(link.steps).toEqual([
				`acquire:${shown}`,
				`acquire:${target.sessionId}`,
				`release:${target.sessionId}:switch`,
				`acquire:${shown}`,
			]);
			await tui.terminal.waitForRender();
			expect(tui.screen()).not.toContain("Waiting for the remote turn");
		});

		it("stops the remote turn on its action, then opens the session once the lease is granted", async () => {
			const granted = Promise.withResolvers<{ handoff: "warm" }>();
			const { link, tui, target, resuming, harness } = await resumeWaiting(granted.promise);

			tui.terminal.sendInput("\r");
			await vi.waitFor(() => expect(tui.screen()).toContain("Stopping the remote turn"));
			expect(link.steps).toContain("abort:vf-tui");
			granted.resolve({ handoff: "warm" });

			await expect(resuming).resolves.toMatchObject({ cancelled: false, sessionId: target.sessionId });
			expect(harness.connector.conversation.id).toBe(target.sessionId);
			await tui.terminal.waitForRender();
			expect(tui.screen()).not.toContain("Stopping the remote turn");
		});
	},
);
