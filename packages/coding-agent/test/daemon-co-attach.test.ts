import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { IrohRemoteActiveStreamRegistry } from "../src/core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { IntegratedRuntimeRegistry } from "../src/daemon/integrated-runtimes.ts";
import { createTestSession, parseWrittenObjects, startIrohRpcMode } from "./iroh-stream-doubles.ts";

function createFanoutSession(sessionId: string) {
	const session = createTestSession(sessionId, null);
	const subscribers = new Set<(event: AgentSessionEvent) => void>();
	session.subscribe = vi.fn((handler: (event: AgentSessionEvent) => void) => {
		subscribers.add(handler);
		return () => {
			subscribers.delete(handler);
		};
	});
	const abort = vi.fn(async () => {});
	return {
		session: Object.assign(session, { abort }),
		abort,
		emit(event: AgentSessionEvent) {
			for (const handler of Array.from(subscribers)) {
				handler(event);
			}
		},
	};
}

function createAuthorization(clientNodeId: string): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: clientNodeId,
			label: clientNodeId,
			allowedWorkspaces: ["ws"],
			allowedTools: "read",
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: "/tmp/ws" },
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

function createHello(
	target: IrohRemoteHello["mode"] extends never ? never : { target: "new" } | { target: "session"; sessionId: string },
): IrohRemoteHello {
	return {
		type: "volt_iroh_hello",
		protocol: "volt-rpc/0",
		workspace: "ws",
		mode: "conversation",
		conversation: target,
	} as IrohRemoteHello;
}

const HANDSHAKE_RESPONSE = {
	child: "volt",
	features: ["multi_streams.v1", "conversation_streams.v1"],
} as unknown as IrohRemoteHandshakeSuccess;

describe("daemon co-attach (one runtime per conversation)", () => {
	it("two phones with distinct clientNodeIds share one runtime, both stream, and abort keeps streams open", async () => {
		const fanout = createFanoutSession("s-co");
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			cwd: "/tmp/ws",
			session: fanout.session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;

		const registry = new IntegratedRuntimeRegistry({
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime: runtimeHost,
				sessionSelection: { kind: "created", sessionId: "s-co" },
			}),
		});

		const phoneA = createAuthorization("n-phone-a");
		const phoneB = createAuthorization("n-phone-b");

		// Phone A creates the runtime.
		const first = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phoneA,
		);
		expect(first.created).toBe(true);
		await registry.commitEntry(first.entry, first.sessionSelection, phoneA);

		// Phone B (different clientNodeId) attaches to the SAME runtime — no
		// conversation_in_use rejection.
		const second = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "s-co" }), response: HANDSHAKE_RESPONSE },
			phoneB,
		);
		expect(second.created).toBe(false);
		expect(second.entry).toBe(first.entry);
		expect(second.sessionSelection).toEqual({
			kind: "resumed",
			requestedSessionId: "s-co",
			sessionId: "s-co",
		});

		await registry.attachSubscriber(first.entry);
		await registry.attachSubscriber(first.entry);
		expect(first.entry.subscribers.size).toBe(2);

		// Serve both phones from the same runtime.
		const modeA = await startIrohRpcMode(runtimeHost, fanout.session);
		fanout.session.bindExtensions.mockClear();
		const modeB = await startIrohRpcMode(runtimeHost, fanout.session);

		// A session event fans out to both streams.
		fanout.emit({ type: "agent_start" } as AgentSessionEvent);
		await vi.waitFor(() => {
			expect(parseWrittenObjects(modeA.send).some((frame) => frame.type === "agent_start")).toBe(true);
			expect(parseWrittenObjects(modeB.send).some((frame) => frame.type === "agent_start")).toBe(true);
		});

		// Abort from phone B stops the turn; BOTH streams stay open and the
		// runtime stays live (no dispose, no stream invalidation).
		modeB.recv.pushLine(JSON.stringify({ id: "a1", type: "abort" }));
		await vi.waitFor(() => {
			const responses = parseWrittenObjects(modeB.send).filter((frame) => frame.command === "abort");
			expect(responses).toHaveLength(1);
			expect(responses[0]?.success).toBe(true);
		});
		expect(fanout.abort).toHaveBeenCalled();
		expect(modeA.send.finished).toBe(false);
		expect(modeB.send.finished).toBe(false);
		expect(dispose).not.toHaveBeenCalled();

		// Both streams still receive events after the abort.
		fanout.emit({ type: "agent_end" } as unknown as AgentSessionEvent);
		await vi.waitFor(() => {
			expect(parseWrittenObjects(modeA.send).some((frame) => frame.type === "agent_end")).toBe(true);
			expect(parseWrittenObjects(modeB.send).some((frame) => frame.type === "agent_end")).toBe(true);
		});

		modeA.recv.end();
		modeB.recv.end();
		await modeA.modePromise;
		await modeB.modePromise;
		expect(dispose).not.toHaveBeenCalled();
	});

	it("does not let attachable subagent sessions overwrite the client's last top-level session", async () => {
		const parentRuntime = {
			cwd: "/tmp/ws",
			session: createTestSession("parent-session", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const childRuntime = {
			cwd: "/tmp/ws",
			session: createTestSession("child-session", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const setClientLastSessionId = vi.fn(async () => undefined);
		const registry = new IntegratedRuntimeRegistry({
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId,
			createRuntime: async () => ({
				runtime: parentRuntime,
				sessionSelection: { kind: "created", sessionId: "parent-session" },
			}),
		});
		const phone = createAuthorization("n-phone-a");

		const parent = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(parent.entry, parent.sessionSelection, phone);
		expect(setClientLastSessionId).toHaveBeenLastCalledWith("n-phone-a", "ws", "parent-session");

		setClientLastSessionId.mockClear();
		await (
			registry as unknown as {
				registerSubagentRuntime(
					event: { id: string; parentSessionId: string; runtime: AgentSessionRuntime; sessionId: string },
					authorization: IrohRemoteClientAuthorizationSuccess,
				): Promise<void>;
			}
		).registerSubagentRuntime(
			{ id: "sa-child", parentSessionId: "parent-session", runtime: childRuntime, sessionId: "child-session" },
			phone,
		);
		expect(setClientLastSessionId).not.toHaveBeenCalled();

		setClientLastSessionId.mockClear();
		const child = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "child-session" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		expect(child.created).toBe(false);
		expect(child.entry).toMatchObject({ parentSessionId: "parent-session", subagentId: "sa-child" });
		await registry.commitEntry(child.entry, child.sessionSelection, phone);
		expect(setClientLastSessionId).not.toHaveBeenCalled();

		await registry.handleSessionChanged(child.entry, undefined, { sessionId: "child-session-rekeyed" }, phone);
		expect(setClientLastSessionId).not.toHaveBeenCalled();

		await registry.stopAll("test_cleanup");
	});

	it("retains a detached runtime while prompt preflight is busy", async () => {
		vi.useFakeTimers();
		try {
			let resolveIdle = () => {};
			const idle = new Promise<void>((resolve) => {
				resolveIdle = resolve;
			});
			const session = Object.assign(createTestSession("s-busy", null), {
				isBusy: true,
				isStreaming: false,
				waitForIdle: vi.fn(() => idle),
			});
			const dispose = vi.fn(async () => {});
			const runtimeHost = {
				cwd: "/tmp/ws",
				session,
				dispose,
				setRebindSession: vi.fn(),
				listSessions: vi.fn(async () => []),
			} as unknown as AgentSessionRuntime;
			const registry = new IntegratedRuntimeRegistry({
				auditLogger: new IrohRemoteAuditLogger(),
				stateManager: new IrohRemoteHostStateManager(),
				activeStreams: new IrohRemoteActiveStreamRegistry(),
				detachedRuntimeTtlMs: () => 1000,
				getAllowTools: () => undefined,
				getProjectTrustedForWorkspace: () => false,
				setClientLastSessionId: vi.fn(async () => undefined),
				createRuntime: async () => ({
					runtime: runtimeHost,
					sessionSelection: { kind: "created", sessionId: "s-busy" },
				}),
			});
			const phone = createAuthorization("n-phone-a");
			const created = await registry.getOrCreateEntry(
				{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
				phone,
			);
			await registry.commitEntry(created.entry, created.sessionSelection, phone);
			const subscriber = await registry.attachSubscriber(created.entry);
			await registry.detachSubscriber(created.entry, subscriber, "test_detach");

			expect(session.waitForIdle).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(5000);
			expect(dispose).not.toHaveBeenCalled();

			session.isBusy = false;
			resolveIdle();
			await vi.advanceTimersByTimeAsync(999);
			expect(dispose).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(dispose).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("ignores stopEntry for a stale reference whose key now belongs to a replacement runtime", async () => {
		// Regression guard: stopEntry used to delete by key alone, so a stale
		// entry reference could evict a replacement runtime from the registry
		// while leaving it running unmanaged.
		const makeRuntimeHost = (sessionId: string, dispose: ReturnType<typeof vi.fn>) =>
			({
				cwd: "/tmp/ws",
				session: createTestSession(sessionId, null),
				dispose,
				setRebindSession: vi.fn(),
				listSessions: vi.fn(async () => []),
			}) as unknown as AgentSessionRuntime;
		const disposeA = vi.fn(async () => {});
		const disposeB = vi.fn(async () => {});
		let nextRuntime = makeRuntimeHost("s-stale", disposeA);

		const registry = new IntegratedRuntimeRegistry({
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime: nextRuntime,
				sessionSelection: { kind: "created", sessionId: "s-stale" },
			}),
		});
		const phone = createAuthorization("n-phone-a");

		const first = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(first.entry, first.sessionSelection, phone);
		await registry.stopEntry(first.entry, "test_stop");
		expect(disposeA).toHaveBeenCalledTimes(1);
		expect(registry.findOwner("ws", "s-stale")).toBeUndefined();

		// A replacement runtime takes over the same (workspace, sessionId) key.
		nextRuntime = makeRuntimeHost("s-stale", disposeB);
		const second = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(second.entry, second.sessionSelection, phone);
		expect(second.entry).not.toBe(first.entry);

		// A stale stop of the FIRST entry must not evict the replacement.
		await registry.stopEntry(first.entry, "stale_stop");
		expect(registry.findOwner("ws", "s-stale")).toBe(second.entry);
		expect(disposeB).not.toHaveBeenCalled();
		expect(disposeA).toHaveBeenCalledTimes(1);
	});
});
