import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteActiveStreamRegistry } from "../src/core/remote/iroh/active-stream-registry.ts";
import { type IrohRemoteAuditEvent, IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { ConversationCoordinatorRegistry } from "../src/daemon/conversation-coordinator.ts";
import { IntegratedRuntimeRegistry } from "../src/daemon/integrated-runtimes.ts";
import {
	collectClientAuthorityInvalidationRuntimes,
	collectClientAuthorityInvalidationStreams,
} from "../src/daemon/iroh-service.ts";
import { LeaseBroker } from "../src/daemon/lease-broker.ts";
import type { IrohRemoteAgentRuntime } from "../src/modes/rpc/iroh-remote-agent-runtime.ts";
import {
	createTestConversation,
	createTestDaemonRuntime,
	createTestSession,
	parseWrittenObjects,
	startIrohRpcMode,
	withCurrentConversationAuthority,
} from "./iroh-stream-doubles.ts";

let fixtureRoot: string;
let workspacePath: string;
let agentDir: string;

function createConversationAuthorityEffects(coordinators: ConversationCoordinatorRegistry) {
	return {
		beginTuiLeaseHandoff: (workspaceName: string, sessionId: string, connectionId: string) => {
			coordinators.getOrCreate(workspaceName, sessionId).beginTuiLeaseHandoff(connectionId);
		},
		commitTuiLeaseHandoff: (workspaceName: string, sessionId: string, connectionId: string) => {
			const coordinator = coordinators.get(workspaceName, sessionId);
			if (!coordinator) throw new Error("missing test conversation coordinator");
			coordinator.commitTuiLeaseHandoff(connectionId);
		},
		cancelTuiLeaseHandoff: (workspaceName: string, sessionId: string, connectionId: string) => {
			coordinators.get(workspaceName, sessionId)?.cancelTuiLeaseHandoff(connectionId);
		},
		releaseTuiLease: (workspaceName: string, sessionId: string, connectionId: string) => {
			coordinators.get(workspaceName, sessionId)?.releaseTuiLease(connectionId);
		},
	};
}

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

let newSessionSequence = 0;

function createHello(
	target: { target: "new"; sessionId?: string } | { target: "session"; sessionId: string },
): IrohRemoteHello {
	return {
		type: "volt_iroh_hello",
		protocol: "volt-rpc/0",
		workspace: "ws",
		mode: "conversation",
		conversation:
			target.target === "new"
				? { ...target, sessionId: target.sessionId ?? `new-session-${++newSessionSequence}` }
				: target,
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
		const auditEvents: IrohRemoteAuditEvent[] = [];
		// Both phones' streams are served from this one conversation.
		const runtimeHost = createTestConversation(fanout.session, { cwd: workspacePath, close: dispose });

		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: (event) => {
						auditEvents.push(event);
					},
				},
			}),
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
		await expect(
			registry.commitEntry(first.entry, first.sessionSelection, phoneB, first.attachClaim),
		).rejects.toMatchObject({ outcome: "duplicate_conversation_connection" });
		expect(first.entry.lifecycle).toBe("prepared");
		await registry.commitEntry(first.entry, first.sessionSelection, phoneA, first.attachClaim);

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
		await registry.commitEntry(second.entry, second.sessionSelection, phoneB, second.attachClaim);

		const subscriberA = await registry.attachSubscriber(first.entry, first.attachClaim);
		const subscriberB = await registry.attachSubscriber(first.entry, second.attachClaim);
		first.attachClaim.release();
		second.attachClaim.release();
		expect(first.entry.subscribers.size).toBe(2);
		expect([subscriberA.clientNodeId, subscriberB.clientNodeId]).toEqual(["n-phone-a", "n-phone-b"]);
		expect(
			auditEvents.filter((event) => event.type === "remote_subscriber_attached").map((event) => event.clientNodeId),
		).toEqual(["n-phone-a", "n-phone-b"]);

		// Serve both phones from the same runtime.
		const modeA = await startIrohRpcMode(runtimeHost, fanout.session);
		fanout.session.attachExtensionClient.mockClear();
		const modeB = await startIrohRpcMode(runtimeHost, fanout.session);

		// A session event fans out to both streams.
		fanout.emit({ type: "agent_start" } as AgentSessionEvent);
		await vi.waitFor(() => {
			expect(parseWrittenObjects(modeA.send).some((frame) => frame.type === "agent_start")).toBe(true);
			expect(parseWrittenObjects(modeB.send).some((frame) => frame.type === "agent_start")).toBe(true);
		});

		// Abort from phone B stops the turn; BOTH streams stay open and the
		// runtime stays live (no dispose, no stream invalidation).
		modeB.recv.pushLine(JSON.stringify(withCurrentConversationAuthority(modeB.send, { id: "a1", type: "abort" })));
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

		await registry.detachSubscriber(first.entry, subscriberB, "phone_b_closed");
		await registry.detachSubscriber(first.entry, subscriberA, "phone_a_closed");
		expect(
			auditEvents.filter((event) => event.type === "remote_subscriber_detached").map((event) => event.clientNodeId),
		).toEqual(["n-phone-b", "n-phone-a"]);
		expect(
			auditEvents.filter((event) => event.type === "remote_runtime_detached").map((event) => event.clientNodeId),
		).toEqual(["n-phone-a"]);
		await registry.stopAll("test_cleanup");
	});

	it("attributes a co-attaching client's pre-subscriber detach to that client", async () => {
		const auditEvents: IrohRemoteAuditEvent[] = [];
		const runtime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("s-pre-subscriber", null),
			close: vi.fn(async () => {}),
			listSessions: vi.fn(async () => []),
		});
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: (event) => {
						auditEvents.push(event);
					},
				},
			}),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "s-pre-subscriber" },
			}),
		});
		const phoneA = createAuthorization("n-phone-a");
		const phoneB = createAuthorization("n-phone-b");

		const creatorAttach = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phoneA,
		);
		await registry.commitEntry(
			creatorAttach.entry,
			creatorAttach.sessionSelection,
			phoneA,
			creatorAttach.attachClaim,
		);
		const coattach = await registry.getOrCreateEntry(
			{
				hello: createHello({ target: "session", sessionId: "s-pre-subscriber" }),
				response: HANDSHAKE_RESPONSE,
			},
			phoneB,
		);
		await registry.commitEntry(coattach.entry, coattach.sessionSelection, phoneB, coattach.attachClaim);
		expect(creatorAttach.entry.subscribers.size).toBe(0);
		expect(creatorAttach.entry.detachedAt).toBeUndefined();

		await registry.detachWithoutSubscriber(creatorAttach.entry, coattach.attachClaim, "phone_b_attach_failed");

		expect(auditEvents.filter((event) => event.type === "remote_runtime_detached")).toEqual([
			expect.objectContaining({
				clientNodeId: "n-phone-b",
				details: expect.objectContaining({ reason: "phone_b_attach_failed" }),
			}),
		]);
		creatorAttach.attachClaim.release();
		coattach.attachClaim.release();
		await registry.stopAll("test_cleanup");
	});

	it("cancels provisional attach without waiting and audits failed cleanup of a retained late row", async () => {
		const abortController = new AbortController();
		const cleanupError = new Error("injected late runtime cleanup failure");
		const sessionDir = join(fixtureRoot, "late-runtime-sessions");
		const sessionManager = await SessionManager.create(workspacePath, sessionDir, { id: "late-runtime" });
		const sessionRef = sessionManager.getSessionRef();
		if (!sessionRef) throw new Error("Expected a persisted late-runtime reference");
		const auditEvents: IrohRemoteAuditEvent[] = [];
		const dispose = vi.fn(async () => {
			await sessionManager.closePersistence();
			throw cleanupError;
		});
		const lateRuntime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("late-runtime", null),
			close: dispose,
			listSessions: vi.fn(async () => []),
		});
		type RuntimeResult = {
			runtime: IrohRemoteAgentRuntime;
			sessionSelection: { kind: "created"; sessionId: string };
		};
		let resolveRuntime = (_result: RuntimeResult): void => {};
		const createRuntime = vi.fn(
			() =>
				new Promise<RuntimeResult>((resolve) => {
					resolveRuntime = resolve;
				}),
		);
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: (event) => {
						auditEvents.push(event);
					},
				},
			}),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime,
		});
		const authorization = createAuthorization("n-cancelled-attach");
		let reopened: SessionManager | undefined;
		try {
			const pending = registry.getOrCreateEntry(
				{ hello: createHello({ target: "new", sessionId: "late-runtime" }), response: HANDSHAKE_RESPONSE },
				authorization,
				{ signal: abortController.signal },
			);
			await vi.waitFor(() => expect(createRuntime).toHaveBeenCalledOnce());

			abortController.abort();
			await expect(pending).rejects.toThrow("Conversation attach cancelled because daemon admission closed");
			expect(registry.size).toBe(0);
			expect(dispose).not.toHaveBeenCalled();

			resolveRuntime({
				runtime: lateRuntime,
				sessionSelection: { kind: "created", sessionId: "late-runtime" },
			});
			await vi.waitFor(() =>
				expect(auditEvents).toContainEqual(
					expect.objectContaining({
						type: "runtime_start_cleanup_failed",
						clientNodeId: "n-cancelled-attach",
						workspace: "ws",
						success: false,
						error: cleanupError.message,
						details: expect.objectContaining({ reason: "attach_cancelled", sessionId: "late-runtime" }),
					}),
				),
			);
			expect(dispose).toHaveBeenCalledOnce();
			expect(registry.size).toBe(0);
			expect(registry.findOwner("ws", "late-runtime")).toBeUndefined();
			expect(await SessionManager.findForResume(sessionDir, "late-runtime")).toEqual(sessionRef);
			reopened = await SessionManager.open(sessionRef);
			expect(reopened.getSessionRef()).toEqual(sessionRef);
		} finally {
			await reopened?.closePersistence().catch(() => undefined);
			await sessionManager.closePersistence().catch(() => undefined);
		}
	});

	it("starts recovered input only on the committed winner after subscriber admission", async () => {
		const sessionId = "recovery-race";
		const starts = [vi.fn(async () => {}), vi.fn(async () => {})];
		const disposes = [vi.fn(async () => {}), vi.fn(async () => {})];
		const runtimes = starts.map((startRecoveredClientInputs, index) =>
			createTestDaemonRuntime({
				cwd: workspacePath,
				session: createTestSession(sessionId, null),
				close: disposes[index],
				startRecoveredClientInputs,
				listSessions: vi.fn(async () => []),
			}),
		);
		let runtimeCalls = 0;
		let releaseFactoryBarrier = (): void => {};
		const factoryBarrier = new Promise<void>((resolve) => {
			releaseFactoryBarrier = resolve;
		});
		const createRuntime = vi.fn(async () => {
			const runtime = runtimes[runtimeCalls++]!;
			if (runtimeCalls === runtimes.length) releaseFactoryBarrier();
			await factoryBarrier;
			return {
				runtime,
				sessionSelection: { kind: "resumed" as const, requestedSessionId: sessionId, sessionId },
			};
		});
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime,
		});
		const authorization = createAuthorization("n-recovery-race");
		const open = () =>
			registry.getOrCreateEntry(
				{ hello: createHello({ target: "session", sessionId }), response: HANDSHAKE_RESPONSE },
				authorization,
			);
		const results = await Promise.allSettled([open(), open()]);
		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof open>>> => result.status === "fulfilled",
		);
		expect(fulfilled).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const winner = fulfilled[0]!.value;
		const winnerIndex = runtimes.indexOf(winner.entry.runtime);
		const loserIndex = winnerIndex === 0 ? 1 : 0;
		expect(starts[0]).not.toHaveBeenCalled();
		expect(starts[1]).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(disposes[loserIndex]).toHaveBeenCalledOnce());

		await registry.commitEntry(winner.entry, winner.sessionSelection, authorization, winner.attachClaim);
		expect(() =>
			registry.startRecoveredClientInputs(winner.entry, winner.attachClaim, {
				id: "not-admitted",
				clientNodeId: authorization.client.nodeId,
				attachedAt: Date.now(),
			}),
		).toThrow(/subscriber is not owned/);
		const subscriber = await registry.attachSubscriber(winner.entry, winner.attachClaim);
		await registry.startRecoveredClientInputs(winner.entry, winner.attachClaim, subscriber);
		expect(starts[winnerIndex]).toHaveBeenCalledOnce();
		expect(starts[loserIndex]).not.toHaveBeenCalled();
		await registry.detachSubscriber(winner.entry, subscriber, "test_cleanup");
		winner.attachClaim.release();
		await registry.stopAll("test_cleanup");
	});

	it("never starts recovered input for an attach cancelled before ownership commit", async () => {
		const startRecoveredClientInputs = vi.fn(async () => {});
		const dispose = vi.fn(async () => {});
		const sessionId = "recovery-cancelled";
		const runtime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession(sessionId, null),
			close: dispose,
			startRecoveredClientInputs,
			listSessions: vi.fn(async () => []),
		});
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
				sessionSelection: { kind: "resumed", requestedSessionId: sessionId, sessionId },
			}),
		});
		const authorization = createAuthorization("n-recovery-cancelled");
		const prepared = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId }), response: HANDSHAKE_RESPONSE },
			authorization,
		);

		await registry.abortPreparedEntry(prepared.entry, prepared.sessionSelection, prepared.attachClaim);
		expect(startRecoveredClientInputs).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledOnce();
		expect(() =>
			registry.startRecoveredClientInputs(prepared.entry, prepared.attachClaim, {
				id: "never-admitted",
				clientNodeId: authorization.client.nodeId,
				attachedAt: Date.now(),
			}),
		).toThrow(/stale|ownership changed/);
	});

	it("cannot publish a prepared runtime after attach admission closes during persistence", async () => {
		const abortController = new AbortController();
		let resolvePersistence = (): void => {};
		const persistence = new Promise<void>((resolve) => {
			resolvePersistence = resolve;
		});
		const setClientLastSessionId = vi.fn(async () => {
			await persistence;
			return undefined;
		});
		const dispose = vi.fn(async () => {});
		const runtime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("cancelled-commit", null),
			close: dispose,
			listSessions: vi.fn(async () => []),
		});
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
				runtime,
				sessionSelection: { kind: "created", sessionId: "cancelled-commit" },
			}),
		});
		const authorization = createAuthorization("n-cancelled-commit");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			authorization,
			{ signal: abortController.signal },
		);
		const committing = registry.commitEntry(
			created.entry,
			created.sessionSelection,
			authorization,
			created.attachClaim,
			abortController.signal,
		);
		await vi.waitFor(() => expect(setClientLastSessionId).toHaveBeenCalledOnce());
		expect(registry.size).toBe(1);
		expect(created.entry.lifecycle).toBe("prepared");

		abortController.abort();
		await expect(committing).rejects.toThrow("Conversation attach cancelled because daemon admission closed");
		expect(registry.size).toBe(0);
		expect(created.entry.lifecycle).toBe("prepared");

		await registry.abortPreparedEntry(created.entry, created.sessionSelection, created.attachClaim);
		expect(dispose).toHaveBeenCalledOnce();
		expect(created.entry.lifecycle).toBe("retired");

		resolvePersistence();
		await Promise.resolve();
		expect(registry.size).toBe(0);
		expect(registry.findOwner("ws", "cancelled-commit")).toBeUndefined();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("rejects co-attach when an existing runtime exceeds the attaching client's grant", async () => {
		const runtime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("s-policy", null),
			close: vi.fn(async () => {}),
			listSessions: vi.fn(async () => []),
		});
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
		await registry.commitEntry(created.entry, created.sessionSelection, broadPhone, created.attachClaim);
		created.attachClaim.release();

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
		attached.attachClaim.release();
		await registry.stopAll("test_cleanup");
	});

	it("moves only the phone that changed sessions: its co-attached phone stays on the conversation", async () => {
		const setClientLastSessionId = vi.fn(async () => undefined);
		const sourceClose = vi.fn(async () => {});
		const runtime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("shared-source", null),
			close: sourceClose,
			listSessions: vi.fn(async () => []),
		});
		const auditEvents: IrohRemoteAuditEvent[] = [];
		const onConversationMoved = vi.fn();
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger({ sink: { write: (event) => void auditEvents.push(event) } }),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId,
			onConversationMoved,
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "shared-source" },
			}),
		});
		const phoneA = createAuthorization("n-phone-a");
		const phoneB = createAuthorization("n-phone-b");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phoneA,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phoneA, created.attachClaim);
		const attached = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "shared-source" }), response: HANDSHAKE_RESPONSE },
			phoneB,
		);
		await registry.commitEntry(attached.entry, attached.sessionSelection, phoneB, attached.attachClaim);
		const subscriberA = await registry.attachSubscriber(created.entry, created.attachClaim);
		const subscriberB = await registry.attachSubscriber(created.entry, attached.attachClaim);
		created.attachClaim.release();
		attached.attachClaim.release();
		setClientLastSessionId.mockClear();

		// Phone A starts a new session on its stream: the conversation opens in the source's host.
		const { hostTarget } = registry.streamRedirect(created.entry, phoneA);
		const moved = createTestDaemonRuntime(
			{
				cwd: workspacePath,
				session: createTestSession("moved-to", null),
				listSessions: vi.fn(async () => []),
			},
			runtime.host,
		);
		if (!hostTarget) throw new Error("The phone's stream does not host its moves");
		await (await hostTarget({ sessionId: "moved-to", conversation: moved.conversation })).commit();

		const target = registry.findOwner("ws", "moved-to");
		expect(target).toMatchObject({
			lifecycle: "active",
			clientNodeId: "n-phone-a",
			runtime: { host: runtime.host, conversation: moved.conversation },
		});
		expect(target?.toolPolicy).toEqual(created.entry.toolPolicy);
		expect(target?.subscribers.size).toBe(0);
		expect(onConversationMoved).toHaveBeenCalledExactlyOnceWith(created.entry, target);
		// Only phone A's last session moves; phone B stays on the source.
		expect(setClientLastSessionId).toHaveBeenCalledExactlyOnceWith("n-phone-a", "ws", "moved-to");
		expect(registry.findOwner("ws", "shared-source")).toBe(created.entry);
		expect(created.entry.subscribers.size).toBe(2);
		expect(auditEvents).toContainEqual(
			expect.objectContaining({
				type: "session_changed",
				clientNodeId: "n-phone-a",
				details: { reason: "conversation_moved", previousSessionId: "shared-source", sessionId: "moved-to" },
			}),
		);

		// Phone A's stream ends; phone B keeps the source open.
		await registry.detachSubscriber(created.entry, subscriberA, "conversation_moved", undefined, { retainMs: 0 });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(registry.findOwner("ws", "shared-source")).toBe(created.entry);
		expect(sourceClose).not.toHaveBeenCalled();
		await registry.detachSubscriber(created.entry, subscriberB, "transport_closed");
		await registry.stopAll("test_cleanup");
	});

	it("publishes nothing for a phone whose access changed during the move, and releases an abandoned target", async () => {
		const setClientLastSessionId = vi.fn(async () => undefined);
		let authorizationCurrent = true;
		const runtime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("revoked-source", null),
			close: vi.fn(async () => {}),
			listSessions: vi.fn(async () => []),
		});
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId,
			isAuthorizationCurrent: async () => authorizationCurrent,
			createRuntime: async () => ({ runtime, sessionSelection: { kind: "created", sessionId: "revoked-source" } }),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		created.attachClaim.release();
		setClientLastSessionId.mockClear();
		const { hostTarget } = registry.streamRedirect(created.entry, phone);
		if (!hostTarget) throw new Error("The phone's stream does not host its moves");
		/** A conversation a move opened in the source's host, and its close. */
		const opened = (sessionId: string) => {
			const close = vi.fn(async () => {});
			const { conversation } = createTestDaemonRuntime(
				{
					cwd: workspacePath,
					session: createTestSession(sessionId, null),
					close,
					listSessions: vi.fn(async () => []),
				},
				runtime.host,
			);
			return { conversation, close };
		};

		// The client is revoked while the move writes through the source.
		const revoked = opened("revoked-target");
		const prepared = await hostTarget({ sessionId: "revoked-target", conversation: revoked.conversation });
		authorizationCurrent = false;
		await expect(prepared.commit()).rejects.toThrow("Client access changed");
		expect(registry.findOwner("ws", "revoked-target")).toBeUndefined();
		expect(revoked.close).toHaveBeenCalled();
		expect(setClientLastSessionId).not.toHaveBeenCalled();

		// A target the move gave up on is released and never published.
		authorizationCurrent = true;
		const abandoned = opened("abandoned-target");
		const abandonedTarget = await hostTarget({ sessionId: "abandoned-target", conversation: abandoned.conversation });
		await abandonedTarget.abort();
		expect(registry.findOwner("ws", "abandoned-target")).toBeUndefined();
		expect(abandoned.close).toHaveBeenCalled();
		await expect(abandonedTarget.commit()).rejects.toThrow("already settled");

		// The source stays usable for the next move.
		const next = opened("next-target");
		await (await hostTarget({ sessionId: "next-target", conversation: next.conversation })).commit();
		expect(registry.findOwner("ws", "next-target")).toMatchObject({ lifecycle: "active" });
		await registry.stopAll("test_cleanup");
	});

	it("records a switch to a stored session as the phone's last session without opening it", async () => {
		const setClientLastSessionId = vi.fn(async () => undefined);
		const runtime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("switch-source", null),
			close: vi.fn(async () => {}),
			listSessions: vi.fn(async () => []),
		});
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
				runtime,
				sessionSelection: { kind: "created", sessionId: "switch-source" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		created.attachClaim.release();
		setClientLastSessionId.mockClear();

		const { hostTarget } = registry.streamRedirect(created.entry, phone);
		if (!hostTarget) throw new Error("The phone's stream does not host its moves");
		await (await hostTarget({ sessionId: "stored-session" })).commit();

		expect(setClientLastSessionId).toHaveBeenCalledExactlyOnceWith("n-phone-a", "ws", "stored-session");
		expect(registry.findOwner("ws", "stored-session")).toBeUndefined();
		await registry.stopAll("test_cleanup");
	});

	it("closes a conversation its last phone moved away from once it is idle", async () => {
		let releaseTurn!: () => void;
		const turn = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		const session = Object.assign(createTestSession("moved-away", null), {
			isBusy: true,
			waitForNotBusy: vi.fn(() => turn),
		});
		const dispose = vi.fn(async () => {});
		const runtime = createTestDaemonRuntime({
			cwd: workspacePath,
			session,
			close: dispose,
			listSessions: vi.fn(async () => []),
		});
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			createRuntime: async () => ({ runtime, sessionSelection: { kind: "created", sessionId: "moved-away" } }),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		const subscriber = await registry.attachSubscriber(created.entry, created.attachClaim);
		created.attachClaim.release();

		await registry.detachSubscriber(created.entry, subscriber, "conversation_moved", undefined, { retainMs: 0 });
		// The turn continues detached; the conversation closes once it ends, not after the configured TTL.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(registry.findOwner("ws", "moved-away")).toBe(created.entry);
		expect(dispose).not.toHaveBeenCalled();
		session.isBusy = false;
		releaseTurn();
		await vi.waitFor(() => expect(registry.findOwner("ws", "moved-away")).toBeUndefined());
		expect(dispose).toHaveBeenCalledOnce();
	});

	it("does not resurrect a runtime stopped while commit audit publication is paused", async () => {
		let releaseAudit!: () => void;
		let markAuditStarted!: () => void;
		const auditStarted = new Promise<void>((resolve) => {
			markAuditStarted = resolve;
		});
		const auditGate = new Promise<void>((resolve) => {
			releaseAudit = resolve;
		});
		let releaseRetirement!: () => void;
		let markRetirementStarted!: () => void;
		const retirementStarted = new Promise<void>((resolve) => {
			markRetirementStarted = resolve;
		});
		const retirementGate = new Promise<void>((resolve) => {
			releaseRetirement = resolve;
		});
		const dispose = vi.fn(async () => {});
		const onRuntimeDisposed = vi.fn();
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: async (event) => {
						if (event.type === "session_created") {
							markAuditStarted();
							await auditGate;
						}
					},
				},
			}),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			beforeRuntimeStop: async () => {
				markRetirementStarted();
				await retirementGate;
			},
			onRuntimeDisposed,
			createRuntime: async () => ({
				runtime: createTestDaemonRuntime({
					cwd: workspacePath,
					session: createTestSession("commit-stop-race", null),
					close: dispose,
					listSessions: vi.fn(async () => []),
				}),
				sessionSelection: { kind: "created", sessionId: "commit-stop-race" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);

		const committing = registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		await auditStarted;
		const stopping = registry.stopEntry(created.entry, "access_updated");
		await retirementStarted;
		expect(created.entry.lifecycle).toBe("retiring");
		let abortSettled = false;
		const abortingFailedAttach = committing
			.catch(() => registry.abortPreparedEntry(created.entry, created.sessionSelection, created.attachClaim))
			.then(() => {
				abortSettled = true;
			});
		releaseAudit();

		await expect(committing).rejects.toMatchObject({ outcome: "duplicate_conversation_connection" });
		await Promise.resolve();
		expect(abortSettled).toBe(false);
		releaseRetirement();
		await abortingFailedAttach;
		await stopping;
		expect(dispose).toHaveBeenCalledOnce();
		expect(onRuntimeDisposed).toHaveBeenCalledOnce();
		expect(onRuntimeDisposed).toHaveBeenCalledWith(created.entry, "access_updated");
		expect(created.entry.lifecycle).toBe("retired");
		expect(registry.findOwner("ws", "commit-stop-race")).toBeUndefined();
	});

	it("serializes an idle TUI handoff behind paused cross-layer runtime publication", async () => {
		let releasePublication!: () => void;
		let markPublicationStarted!: () => void;
		const publicationStarted = new Promise<void>((resolve) => {
			markPublicationStarted = resolve;
		});
		const publicationGate = new Promise<void>((resolve) => {
			releasePublication = resolve;
		});
		const runtimeDispose = vi.fn(async () => {});
		let registry!: IntegratedRuntimeRegistry;
		const disposeRuntime = vi.fn(async (workspaceName: string, sessionId: string, reason: string) => {
			const entry = registry.findOwner(workspaceName, sessionId);
			if (entry) {
				await registry.stopEntry(entry, reason);
			}
		});
		const coordinators = new ConversationCoordinatorRegistry();
		const broker = new LeaseBroker({
			...createConversationAuthorityEffects(coordinators),
			isRuntimeStreaming: () => false,
			waitForRuntimeIdle: async () => {},
			disposeRuntime,
			closePhoneStreams: () => {},
			closeRelays: () => {},
			audit: () => {},
		});
		coordinators.bindLeaseBroker(broker);
		registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			coordinators,
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => {
				markPublicationStarted();
				await publicationGate;
				return undefined;
			}),
			createRuntime: async () => ({
				runtime: createTestDaemonRuntime({
					cwd: workspacePath,
					session: createTestSession("publication-handoff", null),
					close: runtimeDispose,
					listSessions: vi.fn(async () => []),
				}),
				sessionSelection: { kind: "created", sessionId: "publication-handoff" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const prepared = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		const begun = broker.beginDaemonAttach("ws", "publication-handoff");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") return;
		const brokerCommit = prepared.entry.coordinator.commitDaemonRuntime(begun.claim).outcome;
		expect(brokerCommit.ok).toBe(true);
		if (!brokerCommit.ok) return;

		const publishing = registry.commitEntry(prepared.entry, prepared.sessionSelection, phone, prepared.attachClaim);
		await publicationStarted;
		let handoffSettled = false;
		const handoff = broker
			.acquireForTui({ connectionId: "tui-publication", workspaceName: "ws", sessionId: "publication-handoff" })
			.then((outcome) => {
				handoffSettled = true;
				return outcome;
			});
		await Promise.resolve();
		expect(handoffSettled).toBe(false);
		expect(disposeRuntime).not.toHaveBeenCalled();
		expect(prepared.entry.lifecycle).toBe("prepared");

		releasePublication();
		await publishing;
		const finalization = prepared.entry.coordinator.finalizeDaemonRuntimeCommit(brokerCommit.token);
		expect(finalization.kind).toBe("finalized");
		prepared.attachClaim.release();

		expect(await handoff).toEqual({ kind: "granted", handoff: "warm" });
		expect(disposeRuntime).toHaveBeenCalledOnce();
		expect(runtimeDispose).toHaveBeenCalledOnce();
		expect(prepared.entry.lifecycle).toBe("retired");
		expect(registry.findOwner("ws", "publication-handoff")).toBeUndefined();
		expect(broker.lookup("ws", "publication-handoff")?.state).toBe("tui-owned");
		expect(broker.releaseFromTui("tui-publication", "ws", "publication-handoff")).toEqual({ ok: true });
	});

	it("settles failed publication only after its prepared runtime cleanup has finished", async () => {
		let releaseRuntimeDispose!: () => void;
		let markRuntimeDisposeStarted!: () => void;
		const runtimeDisposeStarted = new Promise<void>((resolve) => {
			markRuntimeDisposeStarted = resolve;
		});
		const runtimeDisposeGate = new Promise<void>((resolve) => {
			releaseRuntimeDispose = resolve;
		});
		const runtimeDispose = vi.fn(async () => {
			markRuntimeDisposeStarted();
			await runtimeDisposeGate;
		});
		const keyBasedDispose = vi.fn(async () => {});
		const coordinators = new ConversationCoordinatorRegistry();
		const broker = new LeaseBroker({
			...createConversationAuthorityEffects(coordinators),
			isRuntimeStreaming: () => false,
			waitForRuntimeIdle: async () => {},
			disposeRuntime: keyBasedDispose,
			closePhoneStreams: () => {},
			closeRelays: () => {},
			audit: () => {},
		});
		coordinators.bindLeaseBroker(broker);
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			coordinators,
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => {
				throw new Error("session persistence failed");
			}),
			createRuntime: async () => ({
				runtime: createTestDaemonRuntime({
					cwd: workspacePath,
					session: createTestSession("publication-failed", null),
					close: runtimeDispose,
					listSessions: vi.fn(async () => []),
				}),
				sessionSelection: { kind: "created", sessionId: "publication-failed" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const prepared = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		const begun = broker.beginDaemonAttach("ws", "publication-failed");
		expect(begun.kind).toBe("proceed");
		if (begun.kind !== "proceed") return;
		const brokerCommit = prepared.entry.coordinator.commitDaemonRuntime(begun.claim).outcome;
		expect(brokerCommit.ok).toBe(true);
		if (!brokerCommit.ok) return;

		await expect(
			registry.commitEntry(prepared.entry, prepared.sessionSelection, phone, prepared.attachClaim),
		).rejects.toThrow("session persistence failed");
		let handoffSettled = false;
		const handoff = broker
			.acquireForTui({ connectionId: "tui-failed", workspaceName: "ws", sessionId: "publication-failed" })
			.then((outcome) => {
				handoffSettled = true;
				return outcome;
			});

		// This mirrors the service transaction's failure ordering: clean up the
		// prepared registry/runtime owner first, then settle the broker token last.
		const aborting = registry.abortPreparedEntry(prepared.entry, prepared.sessionSelection, prepared.attachClaim);
		await runtimeDisposeStarted;
		await Promise.resolve();
		expect(handoffSettled).toBe(false);
		expect(keyBasedDispose).not.toHaveBeenCalled();

		releaseRuntimeDispose();
		await aborting;
		expect(registry.findOwner("ws", "publication-failed")).toBeUndefined();
		expect(broker.rollbackDaemonRuntimeCommit(brokerCommit.token)).toBe(false);

		expect(await handoff).toEqual({ kind: "granted", handoff: "none" });
		expect(runtimeDispose).toHaveBeenCalledOnce();
		expect(keyBasedDispose).not.toHaveBeenCalled();
		expect(broker.lookup("ws", "publication-failed")?.state).toBe("tui-owned");
		expect(broker.releaseFromTui("tui-failed", "ws", "publication-failed")).toEqual({ ok: true });
	});

	it("rolls back a provisional subscriber stopped while attach audit publication is paused", async () => {
		let pauseSubscriberAudit = false;
		let releaseAudit!: () => void;
		let markAuditStarted!: () => void;
		const auditStarted = new Promise<void>((resolve) => {
			markAuditStarted = resolve;
		});
		const auditGate = new Promise<void>((resolve) => {
			releaseAudit = resolve;
		});
		const dispose = vi.fn(async () => {});
		let attachSettled: Promise<void> = Promise.resolve();
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: async (event) => {
						if (pauseSubscriberAudit && event.type === "remote_subscriber_attached") {
							markAuditStarted();
							await auditGate;
						}
					},
				},
			}),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			beforeRuntimeStop: async () => {
				await attachSettled;
			},
			createRuntime: async () => ({
				runtime: createTestDaemonRuntime({
					cwd: workspacePath,
					session: createTestSession("attach-stop-race", null),
					close: dispose,
					listSessions: vi.fn(async () => []),
				}),
				sessionSelection: { kind: "created", sessionId: "attach-stop-race" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		created.attachClaim.release();
		const capturedAttach = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "attach-stop-race" }), response: HANDSHAKE_RESPONSE },
			createAuthorization("n-phone-b"),
		);

		pauseSubscriberAudit = true;
		const attaching = registry.attachSubscriber(created.entry, capturedAttach.attachClaim);
		attachSettled = attaching.then(
			() => undefined,
			() => undefined,
		);
		await auditStarted;
		expect(created.entry.subscribers.size).toBe(1);
		const stopping = registry.stopEntry(created.entry, "access_updated");
		expect(created.entry.lifecycle).toBe("retiring");
		releaseAudit();

		await expect(attaching).rejects.toMatchObject({ outcome: "duplicate_conversation_connection" });
		await stopping;
		expect(created.entry.subscribers.size).toBe(0);
		expect(dispose).toHaveBeenCalledOnce();
		expect(created.entry.lifecycle).toBe("retired");
		expect(registry.findOwner("ws", "attach-stop-race")).toBeUndefined();
	});

	it("fences a captured attach before awaiting owner retirement", async () => {
		let releaseRetirement!: () => void;
		let markRetirementStarted!: () => void;
		const retirementStarted = new Promise<void>((resolve) => {
			markRetirementStarted = resolve;
		});
		const retirementGate = new Promise<void>((resolve) => {
			releaseRetirement = resolve;
		});
		const runtime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("retiring-session", null),
			close: vi.fn(async () => {}),
			listSessions: vi.fn(async () => []),
		});
		const registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams: new IrohRemoteActiveStreamRegistry(),
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			beforeRuntimeStop: async () => {
				markRetirementStarted();
				await retirementGate;
			},
			createRuntime: async () => ({
				runtime,
				sessionSelection: { kind: "created", sessionId: "retiring-session" },
			}),
		});
		const phone = createAuthorization("n-phone-a");
		const created = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
		created.attachClaim.release();
		const capturedAttach = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "retiring-session" }), response: HANDSHAKE_RESPONSE },
			createAuthorization("n-phone-b"),
		);
		const capturedGeneration = created.entry.generation;

		const stopping = registry.stopEntry(created.entry, "access_updated");
		await retirementStarted;
		expect(created.entry.lifecycle).toBe("retiring");
		expect(created.entry.generation).toBeGreaterThan(capturedGeneration);
		await expect(registry.attachSubscriber(created.entry, capturedAttach.attachClaim)).rejects.toMatchObject({
			outcome: "duplicate_conversation_connection",
		});
		await expect(
			registry.commitEntry(
				created.entry,
				capturedAttach.sessionSelection,
				createAuthorization("n-phone-b"),
				capturedAttach.attachClaim,
			),
		).rejects.toMatchObject({ outcome: "duplicate_conversation_connection" });

		releaseRetirement();
		await stopping;
		expect(created.entry.lifecycle).toBe("retired");
		expect(registry.findOwner("ws", "retiring-session")).toBeUndefined();
	});

	it("does not let attachable subagent sessions overwrite the client's last top-level session", async () => {
		const parentRuntime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("parent-session", null),
			close: vi.fn(async () => {}),
			listSessions: vi.fn(async () => []),
		});
		const childRuntime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("child-session", null),
			close: vi.fn(async () => {}),
			listSessions: vi.fn(async () => []),
		});
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
		await registry.commitEntry(parent.entry, parent.sessionSelection, phone, parent.attachClaim);
		parent.attachClaim.release();
		expect(setClientLastSessionId).toHaveBeenLastCalledWith("n-phone-a", "ws", "parent-session");

		setClientLastSessionId.mockClear();
		const registration = await registry.registerSubagentRuntime(
			{
				id: "sa-child",
				parentSessionId: "parent-session",
				host: childRuntime.host,
				conversation: childRuntime.conversation,
				sessionId: "child-session",
			},
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
		await registry.commitEntry(child.entry, child.sessionSelection, phone, child.attachClaim);
		child.attachClaim.release();
		expect(setClientLastSessionId).not.toHaveBeenCalled();

		await registry.stopAll("test_cleanup");
	});

	it("disposes a prepared subagent runtime that is rolled back before prompt acceptance", async () => {
		const parentRuntime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("parent-session", null),
			close: vi.fn(async () => {}),
			listSessions: vi.fn(async () => []),
		});
		const childDispose = vi.fn(async () => {});
		const childRuntime = createTestDaemonRuntime({
			cwd: workspacePath,
			session: createTestSession("child-session", null),
			close: childDispose,
			listSessions: vi.fn(async () => []),
		});
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
		await registry.commitEntry(parent.entry, parent.sessionSelection, phone, parent.attachClaim);
		parent.attachClaim.release();

		const registration = await registry.registerSubagentRuntime(
			{
				id: "sa-child",
				parentSessionId: "parent-session",
				host: childRuntime.host,
				conversation: childRuntime.conversation,
				sessionId: "child-session",
			},
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
			waitForNotBusy: vi.fn(() => new Promise<void>(() => {})),
		});
		const dispose = vi.fn(async () => {
			await abort();
		});
		const runtime = createTestDaemonRuntime({
			cwd: workspacePath,
			session,
			close: dispose,
			listSessions: vi.fn(async () => []),
		});
		let registry!: IntegratedRuntimeRegistry;
		registry = new IntegratedRuntimeRegistry({
			agentDir,
			auditLogger: new IrohRemoteAuditLogger(),
			stateManager: new IrohRemoteHostStateManager(),
			activeStreams,
			detachedRuntimeTtlMs: () => 60_000,
			getAllowTools: () => undefined,
			getProjectTrustedForWorkspace: () => false,
			setClientLastSessionId: vi.fn(async () => undefined),
			beforeRuntimeStop: async (entry, reason) => {
				for (const stream of activeStreams.entriesForConversationKey(entry.workspaceName, entry.sessionId)) {
					await stream.close(reason);
					activeStreams.unregister(stream);
				}
				for (const subscriber of [...entry.subscribers]) {
					await registry.detachSubscriber(entry, subscriber, reason);
				}
			},
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
		await registry.commitEntry(created.entry, created.sessionSelection, creator, created.attachClaim);
		await registry.attachSubscriber(created.entry, created.attachClaim);
		const coattach = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "session", sessionId: "s-blocking" }), response: HANDSHAKE_RESPONSE },
			createAuthorization("n-attached"),
		);
		await registry.attachSubscriber(created.entry, coattach.attachClaim);
		created.attachClaim.release();
		coattach.attachClaim.release();
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

		expect(session.waitForNotBusy).not.toHaveBeenCalled();
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
				waitForNotBusy: vi.fn(() => idle),
			});
			const dispose = vi.fn(async () => {});
			const runtimeHost = createTestDaemonRuntime({
				cwd: workspacePath,
				session,
				close: dispose,
				listSessions: vi.fn(async () => []),
			});
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
			await registry.commitEntry(created.entry, created.sessionSelection, phone, created.attachClaim);
			const subscriber = await registry.attachSubscriber(created.entry, created.attachClaim);
			created.attachClaim.release();
			await registry.detachSubscriber(created.entry, subscriber, "test_detach");

			expect(session.waitForNotBusy).toHaveBeenCalledOnce();
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
		const makeRuntimeHost = (sessionId: string, dispose: () => Promise<void>) =>
			createTestDaemonRuntime({
				cwd: workspacePath,
				session: createTestSession(sessionId, null),
				close: dispose,
				listSessions: vi.fn(async () => []),
			});
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
		await registry.commitEntry(first.entry, first.sessionSelection, phone, first.attachClaim);
		await registry.stopEntry(first.entry, "test_stop");
		expect(disposeA).toHaveBeenCalledTimes(1);
		expect(registry.findOwner("ws", "s-stale")).toBeUndefined();

		// A replacement runtime takes over the same (workspace, sessionId) key.
		nextRuntime = makeRuntimeHost("s-stale", disposeB);
		const second = await registry.getOrCreateEntry(
			{ hello: createHello({ target: "new" }), response: HANDSHAKE_RESPONSE },
			phone,
		);
		await registry.commitEntry(second.entry, second.sessionSelection, phone, second.attachClaim);
		second.attachClaim.release();
		expect(second.entry).not.toBe(first.entry);

		// A stale stop of the FIRST entry must not evict the replacement.
		await registry.stopEntry(first.entry, "stale_stop");
		expect(registry.findOwner("ws", "s-stale")).toBe(second.entry);
		expect(disposeB).not.toHaveBeenCalled();
		expect(disposeA).toHaveBeenCalledTimes(1);
	});
});
