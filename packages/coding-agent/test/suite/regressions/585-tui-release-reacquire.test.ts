import { setKeybindings, type TUI } from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationLock } from "../../../src/core/conversation-log/conversation-lock.ts";
import type { ConversationHost } from "../../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import type { HostClient } from "../../../src/core/host/targets.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { DaemonLeaseWaitComponent } from "../../../src/modes/interactive/components/daemon-lease-wait.ts";
import {
	type AcquireOutcome,
	createDisabledDaemonAttach,
	type DaemonAttach,
	type DaemonLeaseWait,
} from "../../../src/modes/interactive/daemon-attach.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { connectTestClient, type TestClient } from "../../utilities/host-client.ts";
import { createExtensionRuntime, type ExtensionRuntime } from "../extension-runtime.ts";

type Outcomes = Map<string, () => AcquireOutcome>;

/** A connected daemon integration recording lease calls into `steps`. */
function fakeAttach(steps: string[], outcomes: Outcomes): DaemonAttach {
	return {
		...createDisabledDaemonAttach(),
		connectionState: () => "connected",
		acquire: vi.fn(async (sessionId: string): Promise<AcquireOutcome> => {
			steps.push(`acquire:${sessionId}`);
			return outcomes.get(sessionId)?.() ?? { kind: "granted", handoff: "none" };
		}),
		release: vi.fn(async (sessionId: string, reason?: string) => {
			steps.push(`release:${sessionId}:${reason}`);
		}),
		viewerAbort: vi.fn(async (viewerFeedId: string) => {
			steps.push(`abort:${viewerFeedId}`);
		}),
	};
}

interface ModeDouble {
	host: ConversationHost;
	client: HostClient;
	readonly conversation: HostedConversation;
	daemonLeaseTail: Promise<void>;
	daemonRelayServers: Map<Promise<void>, string>;
	showError: ReturnType<typeof vi.fn>;
	showStatus: ReturnType<typeof vi.fn>;
	showDaemonLeaseWait: (sessionId: string, wait: DaemonLeaseWait) => () => void;
}

function call<T>(mode: ModeDouble, method: string, ...args: unknown[]): Promise<T> {
	const implementation = Reflect.get(InteractiveMode.prototype, method) as (...values: unknown[]) => Promise<T>;
	return implementation.apply(mode, args);
}

describe("regression #585: the TUI releases the session it leaves and acquires the one it opens", () => {
	const cleanups: Array<() => Promise<void> | void> = [];
	let steps: string[];
	let outcomes: Outcomes;
	let fixture: ExtensionRuntime;
	/** The TUI's client of its host: its surface moves with it. */
	let runtime: TestClient;
	let mode: ModeDouble;

	beforeEach(async () => {
		steps = [];
		outcomes = new Map();
		fixture = await createExtensionRuntime(
			(volt) => {
				volt.on("session_start", (_event, ctx) => {
					steps.push(`start:${ctx.sessionManager.getSessionId()}`);
				});
				volt.on("session_shutdown", (_event, ctx) => {
					steps.push(`shutdown:${ctx.sessionManager.getSessionId()}`);
				});
			},
			{ extensionMode: "tui" },
		);
		cleanups.push(() => fixture.dispose());
		const tui = await connectTestClient(fixture.host, fixture.conversation, { id: "tui", surface: {} });
		runtime = tui;
		const fields = {
			host: fixture.host,
			client: tui.client,
			// The conversation the TUI shows follows its client's moves.
			get conversation() {
				return tui.conversation;
			},
			options: { daemonAttach: fakeAttach(steps, outcomes) },
			daemonWorkObservation: { bind: vi.fn(), dispose: vi.fn() },
			daemonRelayServers: new Map<Promise<void>, string>(),
			daemonLeaseTail: Promise.resolve(),
			isShuttingDown: false,
			endingLostSession: false,
			statusContainer: { clear: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			renderCurrentSessionState: vi.fn(),
			updatePhoneFooterIndicator: vi.fn(),
			createProjectTrustContext: (cwd: string) => ({ cwd, mode: "tui", hasUI: false }),
			showDaemonLeaseWait: () => () => {},
		};
		mode = Object.defineProperties(
			Object.create(InteractiveMode.prototype),
			Object.getOwnPropertyDescriptors(fields),
		) as ModeDouble;
		await call(mode, "initDaemonAttach");
		steps.splice(0);
	});

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function storedSession(): Promise<SessionReference> {
		const manager = await SessionManager.create(fixture.tempDir, runtime.session.sessionManager.getSessionDir());
		await manager.logWriter.appendSessionInfo("stored");
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("the session is not stored");
		await manager.closePersistence();
		return ref;
	}

	it("on /new, releases the session it left once it closed and its relayed phones ended, then acquires the new one", async () => {
		const source = runtime.session.sessionId;
		const relay = Promise.withResolvers<void>();
		mode.daemonRelayServers.set(relay.promise, source);

		const created = await runtime.newSession();
		if (created.cancelled) throw new Error("the new session was cancelled");
		await vi.waitFor(() => expect(steps).toEqual([`start:${created.sessionId}`, `shutdown:${source}`]));
		// The phone relayed into the session the TUI left hears where to reconnect first.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(steps).toHaveLength(2);
		relay.resolve();
		await vi.waitFor(() => expect(steps).toHaveLength(4));
		await mode.daemonLeaseTail;
		expect(steps).toEqual([
			`start:${created.sessionId}`,
			`shutdown:${source}`,
			`release:${source}:switch`,
			`acquire:${created.sessionId}`,
		]);
	});

	it("on /resume, acquires the target before opening it, then releases the session it left", async () => {
		const source = runtime.session.sessionId;
		const target = await storedSession();

		const resumed = await call<{ cancelled: boolean }>(mode, "handleResumeSession", target);
		await mode.daemonLeaseTail;

		expect(resumed).toMatchObject({ cancelled: false, sessionId: target.sessionId });
		expect(runtime.session.sessionId).toBe(target.sessionId);
		expect(steps).toEqual([
			`acquire:${target.sessionId}`,
			`start:${target.sessionId}`,
			`shutdown:${source}`,
			`release:${source}:switch`,
			// The handover points the daemon at the session the TUI shows; its lease is already held.
			`acquire:${target.sessionId}`,
		]);
	});

	it("shows an error and stays when the target is open for writing elsewhere, handing its lease back", async () => {
		const source = runtime.session.sessionId;
		const target = await storedSession();
		const elsewhere = ConversationLock.acquire(target.sessionDirectory, target.sessionId);
		cleanups.push(() => elsewhere.close());

		const resumed = await call<{ cancelled: boolean }>(mode, "handleResumeSession", target);

		expect(resumed).toEqual({ cancelled: true });
		expect(runtime.session.sessionId).toBe(source);
		expect(mode.showError).toHaveBeenCalledWith(
			expect.stringContaining(`Session ${target.sessionId} is already open`),
		);
		expect(steps).toEqual([`acquire:${target.sessionId}`, `release:${target.sessionId}:switch`, `acquire:${source}`]);
	});

	it("points the daemon back at the session it shows when a resume took no lease and failed", async () => {
		const source = runtime.session.sessionId;
		const target = await storedSession();
		outcomes.set(target.sessionId, () => ({ kind: "noop" }));
		const elsewhere = ConversationLock.acquire(target.sessionDirectory, target.sessionId);
		cleanups.push(() => elsewhere.close());

		expect(await call(mode, "handleResumeSession", target)).toEqual({ cancelled: true });
		expect(runtime.session.sessionId).toBe(source);
		expect(steps).toEqual([`acquire:${target.sessionId}`, `release:${target.sessionId}:switch`, `acquire:${source}`]);
	});

	it("shows an error and opens nothing when another TUI holds the target's lease", async () => {
		const source = runtime.session.sessionId;
		const target = await storedSession();
		outcomes.set(target.sessionId, () => ({ kind: "denied", reason: "held_by_tui" }));

		const resumed = await call<{ cancelled: boolean }>(mode, "handleResumeSession", target);

		expect(resumed).toEqual({ cancelled: true });
		expect(runtime.session.sessionId).toBe(source);
		expect(mode.showError).toHaveBeenCalledWith(
			`Session ${target.sessionId} is open in another Volt window (held_by_tui). Quit it there, then retry.`,
		);
		expect(steps).toEqual([`acquire:${target.sessionId}`, `release:${target.sessionId}:switch`, `acquire:${source}`]);
	});

	it("waits in the TUI for the daemon's turn: stopping it opens the session, cancelling keeps the current one", async () => {
		const source = runtime.session.sessionId;
		const cancelled = await storedSession();
		outcomes.set(cancelled.sessionId, () => ({
			kind: "pending",
			viewerFeedId: "vf-cancel",
			granted: new Promise<never>(() => {}),
		}));
		const endWait = vi.fn();
		mode.showDaemonLeaseWait = (_sessionId, wait) => {
			queueMicrotask(() => wait.cancel());
			return endWait;
		};

		expect(await call(mode, "handleResumeSession", cancelled)).toEqual({ cancelled: true });
		expect(endWait).toHaveBeenCalledOnce();
		expect(mode.showStatus).toHaveBeenCalledWith(
			`Cancelled opening session ${cancelled.sessionId}; the daemon keeps it.`,
		);
		expect(mode.showError).not.toHaveBeenCalled();
		expect(runtime.session.sessionId).toBe(source);
		expect(steps).toEqual([
			`acquire:${cancelled.sessionId}`,
			`release:${cancelled.sessionId}:switch`,
			`acquire:${source}`,
		]);

		steps.splice(0);
		const drained = await storedSession();
		const granted = Promise.withResolvers<{ handoff: "warm" }>();
		outcomes.set(drained.sessionId, () => ({ kind: "pending", viewerFeedId: "vf-stop", granted: granted.promise }));
		const waited: string[] = [];
		mode.showDaemonLeaseWait = (sessionId, wait) => {
			waited.push(sessionId);
			wait.abortRemoteTurn();
			queueMicrotask(() => granted.resolve({ handoff: "warm" }));
			return () => {};
		};

		const resumed = await call<{ cancelled: boolean }>(mode, "handleResumeSession", drained);
		await mode.daemonLeaseTail;
		expect(resumed).toMatchObject({ cancelled: false, sessionId: drained.sessionId });
		expect(waited).toEqual([drained.sessionId]);
		expect(steps).toEqual([
			`acquire:${drained.sessionId}`,
			"abort:vf-stop",
			`start:${drained.sessionId}`,
			`shutdown:${source}`,
			`release:${source}:switch`,
			`acquire:${drained.sessionId}`,
		]);
	});

	it("maps the wait's keys: interrupt stops the remote turn once, clear cancels", () => {
		initTheme("dark");
		setKeybindings(KeybindingsManager.create());
		const wait = { abortRemoteTurn: vi.fn(), cancel: vi.fn() };
		const view = new DaemonLeaseWaitComponent({ requestRender: vi.fn() } as unknown as TUI, "s-1", wait);
		cleanups.push(() => view.dispose());

		view.handleInput("\x1b");
		view.handleInput("\x1b");
		expect(wait.abortRemoteTurn).toHaveBeenCalledOnce();
		expect(wait.cancel).not.toHaveBeenCalled();
		view.handleInput("\x03");
		expect(wait.cancel).toHaveBeenCalledOnce();
	});
});
