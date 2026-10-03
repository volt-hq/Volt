import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationLock, ConversationLockedError } from "../../../src/core/conversation-log/conversation-lock.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import {
	type AcquireOutcome,
	createDisabledDaemonAttach,
	type DaemonAttach,
	DaemonLeaseUnavailableError,
	type DaemonLeaseWait,
	openSessionWithDaemonLease,
} from "../../../src/modes/interactive/daemon-attach.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function storedSession(): Promise<{ sessionDir: string; ref: SessionReference }> {
	const root = mkdtempSync(join(tmpdir(), "volt-585-lease-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const sessionDir = join(root, "sessions");
	const manager = await SessionManager.create(root, sessionDir);
	manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
	await manager.flush();
	const ref = manager.getSessionRef()!;
	await manager.closePersistence();
	return { sessionDir, ref };
}

/** A daemon integration whose lease outcome the test controls. */
function fakeAttach(acquire: () => Promise<AcquireOutcome>) {
	const steps: string[] = [];
	const attach: DaemonAttach = {
		...createDisabledDaemonAttach(),
		start: vi.fn(async () => {
			steps.push("start");
		}),
		acquire: vi.fn(async (sessionId: string) => {
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
	return { attach, steps };
}

function keep(opened: { manager: SessionManager }): void {
	cleanups.push(() => opened.manager.closePersistence());
}

describe("regression #585: the TUI takes its daemon lease before opening a session", () => {
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
		const { attach, steps } = fakeAttach(async () => ({ kind: "pending", viewerFeedId: "vf-1", granted }));
		const onWaiting = vi.fn((wait: DaemonLeaseWait) => {
			steps.push("waiting");
			// The user stops the phone's turn; the daemon then disposes its runtime and grants.
			wait.abortRemoteTurn();
			queueMicrotask(grant);
			return () => steps.push("wait ended");
		});

		const opened = await openSessionWithDaemonLease(ref, { createAttach: () => attach, onWaiting });
		keep(opened);

		expect(steps).toEqual(["start", `acquire:${ref.sessionId}`, "waiting", "abort:vf-1", "wait ended"]);
		expect(onWaiting).toHaveBeenCalledTimes(1);
		expect(opened.manager.getSessionId()).toBe(ref.sessionId);
		// The integration keeps the lease for interactive mode.
		expect(opened.attach).toBe(attach);
		expect(ConversationLock.tryAcquire(sessionDir, ref.sessionId)).toEqual({
			status: "held",
			holder: "this_process",
		});
	});

	it("refuses with guidance when another TUI holds the lease, without opening the session", async () => {
		const { sessionDir, ref } = await storedSession();
		const { attach, steps } = fakeAttach(async () => ({ kind: "denied", reason: "held_by_tui" }));

		const error = await openSessionWithDaemonLease(ref, {
			createAttach: () => attach,
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
		const { attach, steps } = fakeAttach(async () => ({
			kind: "pending",
			viewerFeedId: "vf-2",
			granted: Promise.reject(new Error("drain cancelled")),
		}));

		await expect(
			openSessionWithDaemonLease(ref, { createAttach: () => attach, onWaiting: () => () => {} }),
		).rejects.toThrow(`Could not take session ${ref.sessionId} over from the daemon: drain cancelled`);
		expect(steps.at(-1)).toBe("dispose");
	});

	it("cancels the open while waiting, leaving the session to the daemon", async () => {
		const { sessionDir, ref } = await storedSession();
		const daemonRuntimeLock = ConversationLock.acquire(sessionDir, ref.sessionId);
		cleanups.push(() => daemonRuntimeLock.close());
		const { attach, steps } = fakeAttach(async () => ({
			kind: "pending",
			viewerFeedId: "vf-3",
			granted: new Promise<never>(() => {}),
		}));

		await expect(
			openSessionWithDaemonLease(ref, {
				createAttach: () => attach,
				onWaiting: (wait) => {
					queueMicrotask(() => wait.cancel());
					return () => steps.push("wait ended");
				},
			}),
		).rejects.toThrow(
			new DaemonLeaseUnavailableError(`Cancelled opening session ${ref.sessionId}; the daemon keeps it.`),
		);
		// Disposing the integration closes its connection, which cancels the daemon's drain.
		expect(steps).toEqual(["start", `acquire:${ref.sessionId}`, "wait ended", "dispose"]);
	});

	it("opens without a lease when the daemon is unavailable, and reports a lock held elsewhere", async () => {
		const { sessionDir, ref } = await storedSession();
		const noop = fakeAttach(async () => ({ kind: "noop" }));

		const opened = await openSessionWithDaemonLease(ref, {
			createAttach: () => noop.attach,
			onWaiting: () => () => {},
		});
		expect(opened.attach).toBeUndefined();
		expect(noop.steps).toEqual(["start", `acquire:${ref.sessionId}`, "dispose"]);
		await opened.manager.closePersistence();

		// A lease does not override a lock another host holds: the open still fails closed.
		const elsewhere = ConversationLock.acquire(sessionDir, ref.sessionId);
		cleanups.push(() => elsewhere.close());
		const granted = fakeAttach(async () => ({ kind: "granted", handoff: "none" }));
		await expect(
			openSessionWithDaemonLease(ref, { createAttach: () => granted.attach, onWaiting: () => () => {} }),
		).rejects.toBeInstanceOf(ConversationLockedError);
		expect(granted.steps.at(-1)).toBe("dispose");
	});
});
