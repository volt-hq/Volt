import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteActiveStreamRegistry } from "../src/core/remote/iroh/active-stream-registry.ts";
import { IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import type { SubagentRuntimeRegistration } from "../src/core/subagents/index.ts";
import { IntegratedRuntimeRegistry } from "../src/daemon/integrated-runtimes.ts";
import {
	collectClientAuthorityInvalidationRuntimes,
	collectClientAuthorityInvalidationStreams,
} from "../src/daemon/iroh-service.ts";
import { createTestSession, parseWrittenObjects, startIrohRpcMode } from "./iroh-stream-doubles.ts";

let fixtureRoot: string;
let workspacePath: string;
let agentDir: string;

beforeAll(async () => {
	fixtureRoot = await mkdtemp(join(tmpdir(), "volt-daemon-co-attach-"));
	workspacePath = fixtureRoot;
	agentDir = join(fixtureRoot, "agent");
});

afterAll(async () => {
	await rm(fixtureRoot, { recursive: true, force: true });
});

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

function createAuthorization(clientNodeId: string, allowTools = "read"): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools,
		client: {
			nodeId: clientNodeId,
			label: clientNodeId,
			allowedWorkspaces: ["ws"],
			allowedTools: allowTools,
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: workspacePath },
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
			cwd: workspacePath,
			session: fanout.session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;

		const registry = new IntegratedRuntimeRegistry({
			agentDir,
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

	it("rejects co-attach when an existing runtime exceeds the attaching client's grant", async () => {
		const runtime = {
			cwd: workspacePath,
			session: createTestSession("s-policy", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "s-policy" },
			}),
		});
		const broadPhone = createAuthorization("n-phone-broad", "read,bash");
		const narrowPhone = createAuthorization("n-phone-narrow", "read");
		const equallyBroadPhone = createAuthorization("n-phone-equal", "read,bash,edit");

		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			broadPhone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, broadPhone);

		await expect(
			registry.getOrCreateEntry(
				{ hello: createHello({ target: "session", sessionId: "s-policy" }), response: HANDSHAKE_RESPONSE },
				narrowPhone,
			),
		).rejects.toMatchObject({ outcome: "conversation_in_use" });

		const attached = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "s-policy" }), response: HANDSHAKE_RESPONSE },
			equallyBroadPhone,
		);
		expect(attached.created).toBe(false);
		expect(attached.entry).toBe(created.entry);
		await registry.stopAll("test_cleanup");
	});

	it("does not let attachable subagent sessions overwrite the client's last top-level session", async () => {
		const parentRuntime = {
			cwd: workspacePath,
			session: createTestSession("parent-session", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const childRuntime = {
			cwd: workspacePath,
			session: createTestSession("child-session", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const setClientLastSessionId = vi.fn(async () => undefined);
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
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
		const registration = (
			registry as unknown as {
				registerSubagentRuntime(
					event: { id: string; parentSessionId: string; runtime: AgentSessionRuntime; sessionId: string },
					authorization: IrohRemoteClientAuthorizationSuccess,
				): SubagentRuntimeRegistration;
			}
		).registerSubagentRuntime(
			{ id: "sa-child", parentSessionId: "parent-session", runtime: childRuntime, sessionId: "child-session" },
			phone,
		);
		expect(registry.findOwner("ws", "child-session")).toBeUndefined();
		registration.commit();
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

	it("disposes a prepared subagent runtime that is rolled back before prompt acceptance", async () => {
		const parentRuntime = {
			cwd: workspacePath,
			session: createTestSession("parent-session", null),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const childDispose = vi.fn(async () => {});
		const childRuntime = {
			cwd: workspacePath,
			session: createTestSession("child-session", null),
			dispose: childDispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
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

		const registration = (
			registry as unknown as {
				registerSubagentRuntime(
					event: { id: string; parentSessionId: string; runtime: AgentSessionRuntime; sessionId: string },
					authorization: IrohRemoteClientAuthorizationSuccess,
				): SubagentRuntimeRegistration;
			}
		).registerSubagentRuntime(
			{ id: "sa-child", parentSessionId: "parent-session", runtime: childRuntime, sessionId: "child-session" },
			phone,
		);

		expect(registry.findOwner("ws", "child-session")).toBeUndefined();
		await registration.rollback();
		await registration.rollback();

		expect(childDispose).toHaveBeenCalledOnce();
		expect(registry.findOwner("ws", "child-session")).toBeUndefined();
		registration.commit();
		expect(registry.findOwner("ws", "child-session")).toBeUndefined();
		await registry.stopAll("test_cleanup");
	});

	it("invalidates the whole shared runtime when any attached client is updated or revoked", () => {
		const activeStreams = new IrohRemoteActiveStreamRegistry();
		const makeStream = (clientNodeId: string, sessionId: string) => ({
			clientNodeId,
			workspaceName: "ws",
			sessionId,
			connectionId: `conn-${clientNodeId}-${sessionId}`,
			streamId: `stream-${clientNodeId}-${sessionId}`,
			close: vi.fn(),
		});
		const creatorStream = makeStream("n-creator", "s-shared");
		const attachedStream = makeStream("n-attached", "s-shared");
		const attachedOtherStream = makeStream("n-attached", "s-other");
		activeStreams.register(creatorStream);
		activeStreams.register(attachedStream);
		activeStreams.register(attachedOtherStream);
		const runtimes = [
			{ clientNodeId: "n-creator", workspaceName: "ws", sessionId: "s-shared" },
			{ clientNodeId: "n-other", workspaceName: "ws", sessionId: "s-other" },
		];

		expect([...collectClientAuthorityInvalidationStreams(activeStreams, runtimes, "n-creator")]).toEqual([
			creatorStream,
			attachedStream,
		]);
		expect([...collectClientAuthorityInvalidationStreams(activeStreams, runtimes, "n-attached")]).toEqual([
			attachedStream,
			attachedOtherStream,
			creatorStream,
		]);
		expect([...collectClientAuthorityInvalidationRuntimes(activeStreams, runtimes, "n-attached")]).toEqual(runtimes);
	});

	it("selects and stops a two-client runtime even while its turn is blocking", async () => {
		const activeStreams = new IrohRemoteActiveStreamRegistry();
		const abort = vi.fn(async () => {});
		const session = Object.assign(createTestSession("s-blocking", null), {
			abort,
			isBusy: true,
			isStreaming: true,
			waitForIdle: vi.fn(() => new Promise<void>(() => {})),
		});
		const dispose = vi.fn(async () => {
			await abort();
		});
		const runtime = {
			cwd: workspacePath,
			session,
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams,
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "s-blocking" },
			}),
		});
		const creator = createAuthorization("n-creator");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			creator,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, creator);
		await registry.attachSubscriber(created.entry);
		await registry.attachSubscriber(created.entry);
		for (const clientNodeId of ["n-creator", "n-attached"]) {
			activeStreams.register({
				clientNodeId,
				workspaceName: "ws",
				sessionId: "s-blocking",
				connectionId: `conn-${clientNodeId}`,
				streamId: `stream-${clientNodeId}`,
				close: vi.fn(),
			});
		}

		const affected = collectClientAuthorityInvalidationRuntimes(activeStreams, registry.values(), "n-attached");
		expect([...affected]).toEqual([created.entry]);
		for (const entry of affected) {
			await registry.stopEntry(entry, "access_updated");
		}

		expect(session.waitForIdle).not.toHaveBeenCalled();
		expect(abort).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(created.entry.subscribers.size).toBe(0);
		expect(registry.findOwner("ws", "s-blocking")).toBeUndefined();
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
				cwd: workspacePath,
				session,
				dispose,
				setRebindSession: vi.fn(),
				listSessions: vi.fn(async () => []),
			} as unknown as AgentSessionRuntime;
			const registry = new IntegratedRuntimeRegistry({
				agentDir,
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
				cwd: workspacePath,
				session: createTestSession(sessionId, null),
				dispose,
				setRebindSession: vi.fn(),
				listSessions: vi.fn(async () => []),
			}) as unknown as AgentSessionRuntime;
		const disposeA = vi.fn(async () => {});
		const disposeB = vi.fn(async () => {});
		let nextRuntime = makeRuntimeHost("s-stale", disposeA);

		const registry = new IntegratedRuntimeRegistry({
			agentDir,
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
