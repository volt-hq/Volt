import { afterEach, describe, expect, test, vi } from "vitest";
import type { PromptPreflightResult } from "../src/core/agent-session.ts";
import { BackgroundJobManager } from "../src/core/background-jobs.ts";
import type { LiveState } from "../src/core/host/live-state.ts";
import { openNewSession, openStoredSessionById } from "../src/core/host/session-intents.ts";
import { isStdoutTakenOver, restoreStdout } from "../src/core/output-guard.ts";
import { createIrohRemoteExplicitAccess, type IrohRemoteRpcCapability } from "../src/core/remote/iroh/access-grant.ts";
import type { RpcCloseHandler, RpcTransport } from "../src/core/rpc/transport.ts";
import type { RpcGitContext } from "../src/core/rpc/types.ts";
import { SessionManager, type SessionReference } from "../src/core/session-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createFakeConversation, createFakeHost } from "./utilities/fake-conversation-host.ts";
import { createLiveRecorder } from "./utilities/live-recorder.ts";

// The modes' structural intents run through the host's session intents; these
// tests stand in for them and move the fake host's client themselves.
vi.mock("../src/core/host/session-intents.ts", () => ({
	openFork: vi.fn(async () => ({ cancelled: true })),
	openImport: vi.fn(async () => ({ cancelled: true })),
	openNewSession: vi.fn(async () => ({ cancelled: true })),
	openStoredSession: vi.fn(async () => ({ cancelled: true })),
	openStoredSessionById: vi.fn(async () => ({ cancelled: true })),
}));

function createSessionRef(sessionId: string): SessionReference {
	return Object.freeze({
		sessionDirectory: "/sessions",
		storeId: "test-store",
		sessionId,
		sessionGeneration: "generation-test",
	});
}

/** A fake host over one fake conversation of `session`; `onClose` runs when the host closes a conversation. */
function createHost<T extends object>(
	session: T,
	options: { onClose?: () => Promise<void> | void; members?: Record<string, unknown> } = {},
) {
	const fake = createFakeHost(options.onClose === undefined ? {} : { onClose: options.onClose });
	const { conversation, loseLog } = createFakeConversation(session, options.members);
	return { ...fake, session, conversation, loseLog };
}

type FakeHosted = ReturnType<typeof createHost>;

function createRuntimeHost(): { hosted: FakeHosted; dispose: FakeHosted["close"] } {
	const sessionId = "runtime-session";
	const hosted = createHost({
		backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
		attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
		sessionId,
		sessionManager: {
			getClientInput: vi.fn(() => undefined),
			getSessionDir: vi.fn(() => "/sessions"),
			getSessionRef: vi.fn(() => createSessionRef(sessionId)),
		},
		subscribe: vi.fn(() => () => {}),
		subscribeRuntimeEvents: vi.fn(() => () => {}),
	});

	return { hosted, dispose: hosted.close };
}

interface RpcModeHarness {
	close(): void;
	modePromise: Promise<void>;
	send(message: object): void;
	writes: object[];
}

function createStateSession(sessionId: string, gitContext: RpcGitContext | null = null) {
	return {
		activeToolExecutions: new Map(),
		subscribeRuntimeEvents: vi.fn(() => () => {}),
		activeCompaction: undefined,
		autoCompactionEnabled: true,
		backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
		attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
		followUpMode: "one-at-a-time" as const,
		gitContextProvider: {
			getSnapshot: vi.fn(() => gitContext),
			refresh: vi.fn(() => new Promise(() => {})),
		},
		isCompacting: false,
		isStreaming: false,
		messages: [],
		model: undefined,
		pendingMessageCount: 0,
		sessionId,
		sessionManager: {
			getSessionDir: () => "/sessions",
			getSessionRef: () => createSessionRef(sessionId),
			getStartingGitContext: () => undefined,
		},
		steeringMode: "one-at-a-time" as const,
		subscribe: vi.fn(() => () => {}),
		thinkingLevel: "off" as const,
		getAvailableThinkingLevels: vi.fn(() => ["off"]),
	};
}

function createPayloadValidationSession() {
	return {
		subscribeRuntimeEvents: vi.fn(() => () => {}),
		backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
		attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
		executeBash: vi.fn(async () => ({ cancelled: false, exitCode: 0, output: "" })),
		followUp: vi.fn(async () => {}),
		prompt: vi.fn(async () => {}),
		sessionId: "payload-validation-session",
		sessionManager: {
			getBranch: vi.fn(() => []),
			getSessionId: vi.fn(() => "payload-validation-session"),
		},
		setAutoCompactionEnabled: vi.fn(),
		setAutoRetryEnabled: vi.fn(),
		setFollowUpMode: vi.fn(),
		setSessionName: vi.fn(),
		setSteeringMode: vi.fn(),
		setThinkingLevel: vi.fn(),
		steer: vi.fn(async () => {}),
		subscribe: vi.fn(() => () => {}),
	};
}

function createPayloadValidationRuntimeHost(session: ReturnType<typeof createPayloadValidationSession>): FakeHosted {
	return createHost(session);
}

async function startRpcModeHarness(hosted: FakeHosted): Promise<RpcModeHarness> {
	let lineHandler: ((line: string) => void) | undefined;
	let closeHandler: RpcCloseHandler | undefined;
	const writes: object[] = [];
	const transport: RpcTransport = {
		write: vi.fn((value) => {
			writes.push(value);
		}),
		onLine: vi.fn((handler) => {
			lineHandler = handler;
			return vi.fn();
		}),
		onClose: vi.fn((handler) => {
			closeHandler = handler;
			return vi.fn();
		}),
		waitForBackpressure: vi.fn(async () => {}),
		flush: vi.fn(async () => {}),
		close: vi.fn(async () => {}),
	};
	let resolveReady: () => void = () => {};
	const ready = new Promise<void>((resolve) => {
		resolveReady = resolve;
	});
	const modePromise = runRpcMode(hosted.host, hosted.conversation, { onReady: resolveReady, transport });
	await ready;
	await vi.waitFor(() => expect(lineHandler).toBeDefined());

	return {
		close() {
			closeHandler?.();
		},
		modePromise,
		send(message: object) {
			if (!lineHandler) {
				throw new Error("RPC line handler was not registered");
			}
			lineHandler(JSON.stringify(message));
		},
		writes,
	};
}

afterEach(() => {
	restoreStdout();
	vi.clearAllMocks();
});

describe("RPC mode caller-provided transports", () => {
	test("lists sessions and switches by session id", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const writes: object[] = [];
		const transport: RpcTransport = {
			write: vi.fn((value) => {
				writes.push(value);
			}),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return detachInput;
			}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
		const makeSession = (sessionId: string) => ({
			backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
			attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
			subscribe: vi.fn(() => detachSession),
			subscribeRuntimeEvents: vi.fn(() => detachBackpressure),
			sessionFile: `/sessions/${sessionId}.jsonl`,
			sessionId,
		});
		const hosted = createHost(makeSession("initial-session"), {
			members: {
				listSessions: vi.fn(async () => [
					{
						current: true,
						createdAt: "2026-01-01T00:00:00.000Z",
						firstMessage: "hello",
						messageCount: 2,
						modifiedAt: "2026-01-01T00:01:00.000Z",
						sessionId: "initial-session",
						sessionName: "Initial",
					},
				]),
			},
		});
		const selected = createFakeConversation(makeSession("selected-session")).conversation;
		vi.mocked(openStoredSessionById).mockImplementationOnce(async (_host, client) => {
			await hosted.move(client, selected);
			return { cancelled: false, sessionId: selected.id, seeded: false };
		});
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(hosted.host, hosted.conversation, {
			onReady: () => {
				resolveReady();
			},
			transport,
		});
		await ready;
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "list-1", type: "list_sessions" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "list-1",
				type: "response",
				command: "list_sessions",
				success: true,
				data: {
					sessions: [
						{
							current: true,
							createdAt: "2026-01-01T00:00:00.000Z",
							firstMessage: "hello",
							messageCount: 2,
							modifiedAt: "2026-01-01T00:01:00.000Z",
							sessionId: "initial-session",
							sessionName: "Initial",
						},
					],
				},
			}),
		);

		lineHandler?.(JSON.stringify({ id: "switch-1", type: "switch_session_by_id", sessionId: "selected-session" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "switch-1",
				type: "response",
				command: "switch_session_by_id",
				success: true,
				data: { cancelled: false, sessionId: "selected-session" },
			}),
		);
		expect(openStoredSessionById).toHaveBeenCalledWith(hosted.host, expect.anything(), "selected-session", {
			assertConversationGenerationCurrent: expect.any(Function),
		});
		// The client follows the move: it is on the selected session and the source closed with its anchor.
		expect(hosted.clientOf(selected)).toBeDefined();
		expect(hosted.close).toHaveBeenCalledWith(hosted.conversation);

		closeHandler?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("get_state returns the cached Git replacement without waiting for refresh", async () => {
		const gitContext: RpcGitContext = {
			repository: "workspace",
			head: { kind: "branch", name: "main", oid: "0123456789abcdef0123456789abcdef01234567" },
			upstream: null,
			base: null,
			status: {
				staged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
				unstaged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
				untracked: 0,
				conflicted: 0,
				total: 0,
				clean: true,
			},
			operation: null,
			revision: 1,
			observedAt: "2026-07-29T00:00:00.000Z",
			stale: false,
		};
		const session = createStateSession("git-state-session", gitContext);
		const hosted = createHost(session);
		const rpc = await startRpcModeHarness(hosted);
		try {
			rpc.send({ id: "git-state", type: "get_state" });
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual(
					expect.objectContaining({
						id: "git-state",
						data: expect.objectContaining({ gitContext }),
					}),
				),
			);
			expect(session.gitContextProvider.refresh).not.toHaveBeenCalled();
		} finally {
			rpc.close();
			await rpc.modePromise.catch(() => {});
		}
	});

	test("serializes regular commands so state reads wait for pending session switches", async () => {
		const hosted = createHost(createStateSession("initial-session"));
		const selected = createFakeConversation(createStateSession("selected-session")).conversation;
		let finishSwitch = (): void => {};
		vi.mocked(openStoredSessionById).mockImplementationOnce(
			(_host, client) =>
				new Promise((resolve, reject) => {
					finishSwitch = () => {
						finishSwitch = () => {};
						hosted
							.move(client, selected)
							.then(() => resolve({ cancelled: false, sessionId: selected.id, seeded: false }), reject);
					};
				}),
		);
		const rpc = await startRpcModeHarness(hosted);

		try {
			rpc.send({ id: "switch-1", type: "switch_session_by_id", sessionId: "selected-session" });
			await vi.waitFor(() => expect(openStoredSessionById).toHaveBeenCalledOnce());
			rpc.send({ id: "state-1", type: "get_state" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(rpc.writes).not.toContainEqual(expect.objectContaining({ id: "state-1" }));

			finishSwitch();
			await vi.waitFor(() =>
				expect(rpc.writes).toContainEqual(
					expect.objectContaining({
						id: "state-1",
						data: expect.objectContaining({ sessionId: "selected-session" }),
					}),
				),
			);
		} finally {
			finishSwitch();
			rpc.close();
			await rpc.modePromise.catch(() => {});
		}
	});

	test("drains an admitted structural command before transport close settles", async () => {
		const hosted = createHost(createStateSession("initial-session"));
		const next = createFakeConversation(createStateSession("next-session")).conversation;
		let finishNewSession = (): void => {};
		vi.mocked(openNewSession).mockImplementationOnce(
			(_host, client) =>
				new Promise((resolve, reject) => {
					finishNewSession = () => {
						finishNewSession = () => {};
						hosted
							.move(client, next)
							.then(() => resolve({ cancelled: false, sessionId: next.id, seeded: false }), reject);
					};
				}),
		);
		const rpc = await startRpcModeHarness(hosted);

		try {
			rpc.send({ id: "new-1", type: "new_session" });
			await vi.waitFor(() => expect(openNewSession).toHaveBeenCalledOnce());

			let modeSettled = false;
			void rpc.modePromise.finally(() => {
				modeSettled = true;
			});
			rpc.close();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(modeSettled).toBe(false);
			expect(hosted.close).not.toHaveBeenCalled();

			finishNewSession();
			await expect(rpc.modePromise).resolves.toBeUndefined();

			expect(rpc.writes).not.toContainEqual(expect.objectContaining({ id: "new-1" }));
			// The anchor's move closed the session it left; the mode closed the one it ended on.
			expect(hosted.close.mock.calls.map(([conversation]) => conversation)).toEqual([hosted.conversation, next]);
		} finally {
			finishNewSession();
			rpc.close();
			await rpc.modePromise.catch(() => {});
		}
	});

	test("bridges host-initiated action requests over RPC", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const writes: object[] = [];
		const transport: RpcTransport = {
			write: vi.fn((value) => {
				writes.push(value);
			}),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return detachInput;
			}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
		const currentSession = {
			backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
			attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
			subscribe: vi.fn(() => detachSession),
			subscribeRuntimeEvents: vi.fn(() => detachBackpressure),
			sessionId: "session-1",
			sessionFile: "/sessions/session-1.jsonl",
		};
		const hosted = createHost(currentSession);
		// Approvals wait in the conversation's live state.
		const hostInteraction = hosted.conversation.liveState.hostInteraction;
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(hosted.host, hosted.conversation, {
			onReady: () => {
				resolveReady();
			},
			transport,
		});
		await ready;
		await vi.waitFor(() => expect(hostInteraction).toBeDefined());

		await expect(
			hostInteraction.requestAction({
				id: "no-caps",
				action: "test.action",
				title: "Unavailable action",
			}),
		).resolves.toMatchObject({ decision: "unavailable" });
		expect(writes).not.toContainEqual(expect.objectContaining({ type: "host_action_request", id: "no-caps" }));

		lineHandler?.(
			JSON.stringify({ id: "caps-1", type: "set_client_capabilities", features: ["host_action_requests.v1"] }),
		);
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "caps-1",
				type: "response",
				command: "set_client_capabilities",
				success: true,
			}),
		);

		const decisionPromise = hostInteraction.requestAction({
			id: "host-1",
			action: "test.action",
			title: "Approve test action?",
			message: "This action is blocking.",
			blocking: true,
		});
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				type: "host_action_request",
				id: "host-1",
				action: "test.action",
				title: "Approve test action?",
				message: "This action is blocking.",
				blocking: true,
			}),
		);
		hostInteraction.updateAction?.({ id: "host-1", action: "test.action", status: "running" });
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				type: "host_action_update",
				id: "host-1",
				action: "test.action",
				status: "running",
			}),
		);

		lineHandler?.(JSON.stringify({ id: "pending-1", type: "get_pending_host_actions" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "pending-1",
				type: "response",
				command: "get_pending_host_actions",
				success: true,
				data: {
					actions: [
						{
							type: "host_action_request",
							id: "host-1",
							action: "test.action",
							title: "Approve test action?",
							message: "This action is blocking.",
							blocking: true,
						},
					],
				},
			}),
		);

		lineHandler?.(JSON.stringify({ type: "host_action_response", id: "host-1", decision: "approved" }));
		await expect(decisionPromise).resolves.toMatchObject({ decision: "approved" });

		const cancelledPromise = hostInteraction.requestAction({
			id: "host-2",
			action: "test.action",
			title: "Cancelled action",
			blocking: true,
		});
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				type: "host_action_request",
				id: "host-2",
				action: "test.action",
				title: "Cancelled action",
				blocking: true,
			}),
		);
		// The only client that took approvals stops taking them: nobody can answer it.
		lineHandler?.(JSON.stringify({ id: "caps-2", type: "set_client_capabilities", features: [] }));
		await expect(cancelledPromise).resolves.toMatchObject({
			decision: "dismissed",
			message: "No client accepts host actions",
		});

		closeHandler?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("preserves pending host action requests across retained runtime reconnects", async () => {
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const currentSession = {
			backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
			attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
			subscribe: vi.fn(() => detachSession),
			subscribeRuntimeEvents: vi.fn(() => detachBackpressure),
			sessionId: "session-1",
			sessionFile: "/sessions/session-1.jsonl",
		};
		const hosted = createHost(currentSession);
		const hostInteraction = hosted.conversation.liveState.hostInteraction;
		const startConnection = async () => {
			let lineHandler: ((line: string) => void) | undefined;
			let closeHandler: RpcCloseHandler | undefined;
			const writes: object[] = [];
			const transport: RpcTransport = {
				write: vi.fn((value) => {
					writes.push(value);
				}),
				onLine: vi.fn((handler) => {
					lineHandler = handler;
					return vi.fn();
				}),
				onClose: vi.fn((handler) => {
					closeHandler = handler;
					return vi.fn();
				}),
				waitForBackpressure: vi.fn(async () => {}),
				flush: vi.fn(async () => {}),
				close: vi.fn(async () => {}),
			};
			let resolveReady: () => void = () => {};
			const ready = new Promise<void>((resolve) => {
				resolveReady = resolve;
			});
			const modePromise = runRpcMode(hosted.host, hosted.conversation, {
				anchor: false,
				onReady: resolveReady,
				transport,
			});
			await ready;
			await vi.waitFor(() => expect(lineHandler).toBeDefined());
			return {
				close: () => {
					closeHandler?.();
				},
				modePromise,
				send: (message: object) => {
					if (!lineHandler) {
						throw new Error("RPC line handler was not registered");
					}
					lineHandler(JSON.stringify(message));
				},
				writes,
			};
		};

		const firstConnection = await startConnection();
		firstConnection.send({
			id: "caps-1",
			type: "set_client_capabilities",
			features: ["host_action_requests.v1"],
		});
		await vi.waitFor(() =>
			expect(firstConnection.writes).toContainEqual({
				id: "caps-1",
				type: "response",
				command: "set_client_capabilities",
				success: true,
			}),
		);
		const retainedHostInteraction = hostInteraction;
		const decisionPromise = retainedHostInteraction.requestAction({
			id: "host-reconnect",
			action: "test.action",
			title: "Approve after reconnect?",
			message: "This request should survive transport close.",
			blocking: true,
		});
		await vi.waitFor(() =>
			expect(firstConnection.writes).toContainEqual({
				type: "host_action_request",
				id: "host-reconnect",
				action: "test.action",
				title: "Approve after reconnect?",
				message: "This request should survive transport close.",
				blocking: true,
			}),
		);

		firstConnection.close();
		await expect(firstConnection.modePromise).resolves.toBeUndefined();
		let settled = false;
		void decisionPromise.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(hosted.close).not.toHaveBeenCalled();

		const secondConnection = await startConnection();
		secondConnection.send({
			id: "caps-2",
			type: "set_client_capabilities",
			features: ["host_action_requests.v1"],
		});
		await vi.waitFor(() =>
			expect(secondConnection.writes).toContainEqual({
				id: "caps-2",
				type: "response",
				command: "set_client_capabilities",
				success: true,
			}),
		);
		secondConnection.send({ id: "pending-2", type: "get_pending_host_actions" });
		await vi.waitFor(() =>
			expect(secondConnection.writes).toContainEqual({
				id: "pending-2",
				type: "response",
				command: "get_pending_host_actions",
				success: true,
				data: {
					actions: [
						{
							type: "host_action_request",
							id: "host-reconnect",
							action: "test.action",
							title: "Approve after reconnect?",
							message: "This request should survive transport close.",
							blocking: true,
						},
					],
				},
			}),
		);

		retainedHostInteraction.updateAction?.({
			id: "host-reconnect",
			action: "test.action",
			status: "running",
		});
		await vi.waitFor(() =>
			expect(secondConnection.writes).toContainEqual({
				type: "host_action_update",
				id: "host-reconnect",
				action: "test.action",
				status: "running",
			}),
		);

		secondConnection.send({
			type: "host_action_response",
			id: "host-reconnect",
			decision: "approved",
			message: "approved after reconnect",
		});
		await expect(decisionPromise).resolves.toMatchObject({
			decision: "approved",
			message: "approved after reconnect",
		});

		secondConnection.close();
		await expect(secondConnection.modePromise).resolves.toBeUndefined();
	});

	test("dismisses retained host action requests when a reconnect disables host action support", async () => {
		const currentSession = {
			backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
			attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
			subscribe: vi.fn(() => () => {}),
			subscribeRuntimeEvents: vi.fn(() => () => {}),
			sessionId: "session-1",
		};
		const hosted = createHost(currentSession);
		const hostInteraction = hosted.conversation.liveState.hostInteraction;
		const startConnection = async () => {
			let lineHandler: ((line: string) => void) | undefined;
			let closeHandler: RpcCloseHandler | undefined;
			const writes: object[] = [];
			const transport: RpcTransport = {
				write: vi.fn((value) => {
					writes.push(value);
				}),
				onLine: vi.fn((handler) => {
					lineHandler = handler;
					return vi.fn();
				}),
				onClose: vi.fn((handler) => {
					closeHandler = handler;
					return vi.fn();
				}),
				waitForBackpressure: vi.fn(async () => {}),
				flush: vi.fn(async () => {}),
				close: vi.fn(async () => {}),
			};
			let resolveReady: () => void = () => {};
			const ready = new Promise<void>((resolve) => {
				resolveReady = resolve;
			});
			const modePromise = runRpcMode(hosted.host, hosted.conversation, {
				anchor: false,
				onReady: resolveReady,
				transport,
			});
			await ready;
			await vi.waitFor(() => expect(lineHandler).toBeDefined());
			return {
				close: () => closeHandler?.(),
				modePromise,
				send: (message: object) => {
					if (!lineHandler) {
						throw new Error("RPC line handler was not registered");
					}
					lineHandler(JSON.stringify(message));
				},
				writes,
			};
		};

		const firstConnection = await startConnection();
		firstConnection.send({
			id: "caps-1",
			type: "set_client_capabilities",
			features: ["host_action_requests.v1"],
		});
		await vi.waitFor(() =>
			expect(firstConnection.writes).toContainEqual(expect.objectContaining({ id: "caps-1", success: true })),
		);
		const decisionPromise = hostInteraction.requestAction({
			id: "host-disabled-reconnect",
			action: "test.action",
			title: "Approve after reconnect?",
		});
		await vi.waitFor(() =>
			expect(firstConnection.writes).toContainEqual(
				expect.objectContaining({ type: "host_action_request", id: "host-disabled-reconnect" }),
			),
		);
		firstConnection.close();
		await expect(firstConnection.modePromise).resolves.toBeUndefined();

		const secondConnection = await startConnection();
		secondConnection.send({ id: "caps-2", type: "set_client_capabilities", features: [] });
		await expect(decisionPromise).resolves.toMatchObject({
			decision: "dismissed",
			message: "No client accepts host actions",
		});
		secondConnection.send({ id: "pending-2", type: "get_pending_host_actions" });
		await vi.waitFor(() =>
			expect(secondConnection.writes).toContainEqual({
				id: "pending-2",
				type: "response",
				command: "get_pending_host_actions",
				success: true,
				data: { actions: [] },
			}),
		);

		secondConnection.close();
		await expect(secondConnection.modePromise).resolves.toBeUndefined();
	});

	test("cancels pending host action requests when disposing the runtime", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		let lineHandler: ((line: string) => void) | undefined;
		const writes: object[] = [];
		const transport: RpcTransport = {
			write: vi.fn((value) => {
				writes.push(value);
			}),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return vi.fn();
			}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return vi.fn();
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
		const hosted = createHost({
			backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
			attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
			subscribe: vi.fn(() => () => {}),
			subscribeRuntimeEvents: vi.fn(() => () => {}),
			sessionId: "session-1",
		});
		const hostInteraction = hosted.conversation.liveState.hostInteraction;
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});
		const modePromise = runRpcMode(hosted.host, hosted.conversation, { onReady: resolveReady, transport });
		await ready;
		await vi.waitFor(() => expect(lineHandler).toBeDefined());
		lineHandler?.(
			JSON.stringify({ id: "caps-1", type: "set_client_capabilities", features: ["host_action_requests.v1"] }),
		);
		await vi.waitFor(() => expect(writes).toContainEqual(expect.objectContaining({ id: "caps-1", success: true })));
		const decisionPromise = hostInteraction.requestAction({
			id: "host-dispose",
			action: "test.action",
			title: "Dispose?",
		});
		await vi.waitFor(() =>
			expect(writes).toContainEqual(expect.objectContaining({ type: "host_action_request", id: "host-dispose" })),
		);

		// The anchor's conversation closes with the mode, and its approvals end.
		closeHandler?.();
		await expect(decisionPromise).resolves.toMatchObject({
			decision: "dismissed",
			message: "The conversation closed",
		});
		await expect(modePromise).resolves.toBeUndefined();
		expect(hosted.close).toHaveBeenCalledOnce();
	});

	test("rejects invalid scalar state mutation payloads before calling session setters", async () => {
		const session = createPayloadValidationSession();
		const rpc = await startRpcModeHarness(createPayloadValidationRuntimeHost(session));
		const invalidCommands = [
			{ id: "auto-compaction-invalid", type: "set_auto_compaction", enabled: "false" },
			{ id: "auto-retry-invalid", type: "set_auto_retry", enabled: "false" },
			{ id: "steering-mode-invalid", type: "set_steering_mode", mode: "bad" },
			{ id: "follow-up-mode-invalid", type: "set_follow_up_mode", mode: "bad" },
			{ id: "thinking-level-invalid", type: "set_thinking_level", level: "bad" },
			{ id: "session-name-invalid", type: "set_session_name", name: 123 },
		];

		try {
			for (const command of invalidCommands) {
				rpc.send(command);
			}

			await vi.waitFor(() => {
				for (const command of invalidCommands) {
					expect(rpc.writes).toContainEqual(
						expect.objectContaining({
							id: command.id,
							type: "response",
							command: command.type,
							success: false,
							error: expect.any(String),
						}),
					);
				}
			});
			expect(session.setAutoCompactionEnabled).not.toHaveBeenCalled();
			expect(session.setAutoRetryEnabled).not.toHaveBeenCalled();
			expect(session.setSteeringMode).not.toHaveBeenCalled();
			expect(session.setFollowUpMode).not.toHaveBeenCalled();
			expect(session.setThinkingLevel).not.toHaveBeenCalled();
			expect(session.setSessionName).not.toHaveBeenCalled();
		} finally {
			rpc.close();
			await rpc.modePromise.catch(() => {});
		}
	});

	test("rejects invalid prompt and bash string payloads before calling session methods", async () => {
		const session = createPayloadValidationSession();
		const rpc = await startRpcModeHarness(createPayloadValidationRuntimeHost(session));
		const invalidCommands = [
			{ id: "prompt-invalid", type: "prompt", clientMessageId: "client-prompt-invalid", message: 123 },
			{ id: "steer-invalid", type: "steer", clientMessageId: "client-steer-invalid", message: 123 },
			{
				id: "follow-up-invalid",
				type: "follow_up",
				clientMessageId: "client-follow-up-invalid",
				message: 123,
			},
			{ id: "bash-invalid", type: "bash", command: 123 },
		];

		try {
			for (const command of invalidCommands) {
				rpc.send(command);
			}

			await vi.waitFor(() => {
				for (const command of invalidCommands) {
					expect(rpc.writes).toContainEqual(
						expect.objectContaining({
							id: command.id,
							type: "response",
							command: command.type,
							success: false,
							error: expect.any(String),
						}),
					);
				}
			});
			expect(session.prompt).not.toHaveBeenCalled();
			expect(session.steer).not.toHaveBeenCalled();
			expect(session.followUp).not.toHaveBeenCalled();
			expect(session.executeBash).not.toHaveBeenCalled();
		} finally {
			rpc.close();
			await rpc.modePromise.catch(() => {});
		}
	});

	test("rejects invalid transcript pagination payloads before projecting the transcript", async () => {
		const session = createPayloadValidationSession();
		const rpc = await startRpcModeHarness(createPayloadValidationRuntimeHost(session));
		const invalidCommands = [
			{ id: "transcript-limit-invalid", type: "get_transcript", limit: "10" },
			{ id: "transcript-before-invalid", type: "get_transcript", beforeEntryId: 123 },
		];

		try {
			for (const command of invalidCommands) {
				rpc.send(command);
			}

			await vi.waitFor(() => {
				for (const command of invalidCommands) {
					expect(rpc.writes).toContainEqual(
						expect.objectContaining({
							id: command.id,
							type: "response",
							command: command.type,
							success: false,
							error: expect.any(String),
						}),
					);
				}
			});
			expect(session.sessionManager.getBranch).not.toHaveBeenCalled();
			expect(session.sessionManager.getSessionId).not.toHaveBeenCalled();
		} finally {
			rpc.close();
			await rpc.modePromise.catch(() => {});
		}
	});

	test("returns projected transcript items", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const writes: object[] = [];
		const transport: RpcTransport = {
			write: vi.fn((value) => {
				writes.push(value);
			}),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return detachInput;
			}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
		const sessionManager = SessionManager.inMemory("/workspace");
		await sessionManager.logWriter.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: 10,
		});
		const currentSession = {
			backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
			attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
			subscribe: vi.fn(() => detachSession),
			subscribeRuntimeEvents: vi.fn(() => detachBackpressure),
			sessionId: sessionManager.getSessionId(),
			sessionManager,
		};
		const hosted = createHost(currentSession);
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(hosted.host, hosted.conversation, {
			onReady: () => {
				resolveReady();
			},
			transport,
		});
		await ready;
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "transcript-1", type: "get_transcript", limit: 10 }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "transcript-1",
				type: "response",
				command: "get_transcript",
				success: true,
				data: {
					sessionId: sessionManager.getSessionId(),
					items: [
						expect.objectContaining({
							role: "user",
							text: "hello",
						}),
					],
					hasMore: false,
					nextBeforeEntryId: null,
				},
			}),
		);

		closeHandler?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("notifies caller when the active session changes", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const writes: object[] = [];
		const transport: RpcTransport = {
			write: vi.fn((value) => {
				writes.push(value);
			}),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return detachInput;
			}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
		const makeSession = (sessionId: string) => ({
			backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
			attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
			subscribe: vi.fn(() => detachSession),
			subscribeRuntimeEvents: vi.fn(() => detachBackpressure),
			sessionId,
			sessionManager: {
				getSessionRef: vi.fn(() => createSessionRef(sessionId)),
			},
		});
		const hosted = createHost(makeSession("initial-session"));
		const next = createFakeConversation(makeSession("next-session")).conversation;
		vi.mocked(openNewSession).mockImplementationOnce(async (_host, client) => {
			await hosted.move(client, next);
			return { cancelled: false, sessionId: next.id, seeded: false };
		});
		const sessionChanges: Array<{ sessionRef?: SessionReference; sessionId: string }> = [];
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(hosted.host, hosted.conversation, {
			onReady: () => {
				resolveReady();
			},
			onSessionChanged: (session) => {
				sessionChanges.push(session);
			},
			transport,
		});
		await ready;
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "new-session-1", type: "new_session" }));
		await vi.waitFor(() =>
			expect(writes).toContainEqual({
				id: "new-session-1",
				type: "response",
				command: "new_session",
				success: true,
				data: { cancelled: false, sessionId: "next-session" },
			}),
		);

		expect(sessionChanges).toEqual([
			{ sessionRef: createSessionRef("initial-session"), sessionId: "initial-session" },
			{ sessionRef: createSessionRef("next-session"), sessionId: "next-session" },
		]);

		closeHandler?.();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("rejects and closes when a command response write rejects", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const writeError = new Error("write failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(() => Promise.reject(writeError)),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return detachInput;
			}),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { hosted, dispose } = createRuntimeHost();

		const modePromise = runRpcMode(hosted.host, hosted.conversation, { transport });
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(JSON.stringify({ id: "write-failure", type: "unknown_command" }));

		await expect(modePromise).rejects.toBe(writeError);
		expect(transport.write).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("rejects and closes when a fire-and-forget prompt response write rejects", async () => {
		let lineHandler: ((line: string) => void) | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const writeError = new Error("write failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(() => Promise.reject(writeError)),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return detachInput;
			}),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { hosted, dispose } = createRuntimeHost();
		Object.assign(hosted.session, {
			prompt: vi.fn((_message: string, options: { preflightResult?: (result: PromptPreflightResult) => void }) => {
				options.preflightResult?.({ success: true, outcome: "admitted" });
				return Promise.resolve();
			}),
		});

		const modePromise = runRpcMode(hosted.host, hosted.conversation, { transport });
		await vi.waitFor(() => expect(lineHandler).toBeDefined());

		lineHandler?.(
			JSON.stringify({
				id: "prompt-write-failure",
				type: "prompt",
				clientMessageId: "client-prompt-write-failure",
				message: "hello",
			}),
		);

		await expect(modePromise).rejects.toBe(writeError);
		expect(transport.write).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("runtime-event backpressure subscriber handles write failures by shutting down", async () => {
		let sessionEventHandler: ((event: object) => void) | undefined;
		let backpressureHandler: (() => Promise<void> | void) | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const writeError = new Error("write failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(() => Promise.reject(writeError)),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const dispose = vi.fn(async () => {});
		const hosted = createHost(
			{
				backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
				attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
				subscribe: vi.fn((handler: (event: object) => void) => {
					sessionEventHandler = handler;
					return detachSession;
				}),
				subscribeRuntimeEvents: vi.fn((handler: () => Promise<void> | void) => {
					backpressureHandler = handler;
					return detachBackpressure;
				}),
			},
			{ onClose: dispose },
		);

		const modePromise = runRpcMode(hosted.host, hosted.conversation, { transport });
		await vi.waitFor(() => expect(sessionEventHandler).toBeDefined());
		await vi.waitFor(() => expect(backpressureHandler).toBeDefined());

		sessionEventHandler?.({ type: "agent_event" });

		await expect(Promise.resolve(backpressureHandler?.())).resolves.toBeUndefined();
		await expect(modePromise).rejects.toBe(writeError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(detachSession).toHaveBeenCalledOnce();
		expect(detachBackpressure).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("does not subscribe after startup close interrupts extension binding", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		let resolveAttach: (() => void) | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const subscribe = vi.fn(() => () => {});
		const runtimeEventSubscribe = vi.fn(() => () => {});
		const dispose = vi.fn(async () => {});
		const hosted = createHost(
			{
				backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
				attachExtensionClient: vi.fn(() => ({
					ready: new Promise<void>((resolve) => {
						resolveAttach = resolve;
					}),
					detach: () => {},
				})),
				subscribe,
				subscribeRuntimeEvents: runtimeEventSubscribe,
			},
			{ onClose: dispose },
		);

		const modePromise = runRpcMode(hosted.host, hosted.conversation, { transport });
		// Startup ends as soon as the transport closes, without waiting for the pending bind.
		void modePromise.catch(() => {});
		await vi.waitFor(() => {
			expect(closeHandler).toBeDefined();
			expect(hosted.session.attachExtensionClient).toHaveBeenCalledOnce();
		});

		closeHandler?.();
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
		expect(resolveAttach).toBeDefined();
		resolveAttach?.();

		await expect(modePromise).rejects.toThrow("RPC transport closed during startup");
		expect(subscribe).not.toHaveBeenCalled();
		expect(runtimeEventSubscribe).not.toHaveBeenCalled();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("startup cleanup treats extension shutdown UI requests as cancelled", async () => {
		let liveState: LiveState | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const startupError = new Error("bind failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		// An extension asks from session_shutdown: the client that failed to start answers nothing.
		const dispose = vi.fn(async () => {
			if (!liveState) {
				throw new Error("missing live state");
			}
			const outcome = await liveState.request({ kind: "confirm", title: "Shutdown", message: "Continue?" });
			expect(outcome).toEqual({ status: "cancelled", reason: "unavailable" });
		});
		const hosted = createHost(
			{
				backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
				attachExtensionClient: vi.fn(() => ({ ready: Promise.reject(startupError), detach: () => {} })),
				subscribe: vi.fn(() => () => {}),
				subscribeRuntimeEvents: vi.fn(() => () => {}),
			},
			{ onClose: dispose },
		);

		liveState = hosted.conversation.liveState;
		await expect(runRpcMode(hosted.host, hosted.conversation, { transport })).rejects.toBe(startupError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(transport.write).not.toHaveBeenCalled();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("cleans up when onReady throws", async () => {
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const detachSession = vi.fn();
		const detachBackpressure = vi.fn();
		const readyError = new Error("ready failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn(() => detachClose),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const dispose = vi.fn(async () => {});
		const hosted = createHost(
			{
				backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
				attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
				subscribe: vi.fn(() => detachSession),
				subscribeRuntimeEvents: vi.fn(() => detachBackpressure),
			},
			{ onClose: dispose },
		);

		const modePromise = runRpcMode(hosted.host, hosted.conversation, {
			transport,
			onReady: () => {
				throw readyError;
			},
		});

		await expect(modePromise).rejects.toBe(readyError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(detachSession).toHaveBeenCalledOnce();
		expect(detachBackpressure).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("close without exiting the embedding process", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { hosted, dispose } = createRuntimeHost();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: string | number | null | undefined) => {
			throw new Error("process.exit called");
		}) as typeof process.exit);

		try {
			let resolveReady: () => void = () => {};
			const ready = new Promise<void>((resolve) => {
				resolveReady = resolve;
			});
			const modePromise = runRpcMode(hosted.host, hosted.conversation, {
				transport,
				onReady: () => {
					resolveReady();
				},
			});
			await ready;
			expect(closeHandler).toBeDefined();

			closeHandler?.();

			await expect(modePromise).resolves.toBeUndefined();
			expect(exitSpy).not.toHaveBeenCalled();
			expect(dispose).toHaveBeenCalledOnce();
			expect(detachInput).toHaveBeenCalledOnce();
			expect(detachClose).toHaveBeenCalledOnce();
			expect(transportClose).toHaveBeenCalledOnce();
		} finally {
			exitSpy.mockRestore();
		}
	});

	test("can close caller-provided transports without disposing the runtime", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { hosted, dispose } = createRuntimeHost();
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(hosted.host, hosted.conversation, {
			anchor: false,
			transport,
			onReady: () => {
				resolveReady();
			},
		});
		await ready;
		expect(closeHandler).toBeDefined();

		closeHandler?.();

		await expect(modePromise).resolves.toBeUndefined();
		expect(dispose).not.toHaveBeenCalled();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("rejects and closes when the input transport closes with an error", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const detachInput = vi.fn();
		const detachClose = vi.fn();
		const inputError = new Error("input failed");
		const transportClose = vi.fn(async () => {});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => detachInput),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return detachClose;
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: transportClose,
		};
		const { hosted, dispose } = createRuntimeHost();

		const modePromise = runRpcMode(hosted.host, hosted.conversation, { transport });
		await vi.waitFor(() => expect(closeHandler).toBeDefined());

		closeHandler?.(inputError);

		await expect(modePromise).rejects.toBe(inputError);
		expect(dispose).toHaveBeenCalledOnce();
		expect(detachInput).toHaveBeenCalledOnce();
		expect(detachClose).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});

	test("closes the transport when shutdown flushing fails", async () => {
		let closeHandler: RpcCloseHandler | undefined;
		const flushError = new Error("flush failed");
		const transportClose = vi.fn(async () => {});
		const transportFlush = vi.fn(async () => {
			throw flushError;
		});
		const transport: RpcTransport = {
			write: vi.fn(),
			onLine: vi.fn(() => () => {}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return () => {};
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: transportFlush,
			close: transportClose,
		};
		const { hosted } = createRuntimeHost();
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(hosted.host, hosted.conversation, {
			transport,
			onReady: () => {
				resolveReady();
			},
		});
		await ready;
		expect(closeHandler).toBeDefined();

		closeHandler?.();

		await expect(modePromise).rejects.toThrow(flushError);
		expect(transportFlush).toHaveBeenCalledOnce();
		expect(transportClose).toHaveBeenCalledOnce();
	});
});

describe("RPC mode host requests on the remote profile", () => {
	/** A remote client on a conversation another client shares, with `capabilities` in its grant. */
	async function startRemote(hosted: FakeHosted, capabilities: IrohRemoteRpcCapability[]) {
		let lineHandler: ((line: string) => void) | undefined;
		let closeHandler: RpcCloseHandler | undefined;
		const writes: Array<Record<string, unknown>> = [];
		const transport: RpcTransport = {
			write: vi.fn((value) => {
				writes.push(value as Record<string, unknown>);
			}),
			onLine: vi.fn((handler) => {
				lineHandler = handler;
				return vi.fn();
			}),
			onClose: vi.fn((handler) => {
				closeHandler = handler;
				return vi.fn();
			}),
			waitForBackpressure: vi.fn(async () => {}),
			flush: vi.fn(async () => {}),
			close: vi.fn(async () => {}),
		};
		const ready = Promise.withResolvers<void>();
		const modePromise = runRpcMode(hosted.host, hosted.conversation, {
			anchor: false,
			onReady: ready.resolve,
			remoteGrant: createIrohRemoteExplicitAccess([], capabilities).rpcGrant,
			transport,
		});
		await ready.promise;
		return {
			writes,
			modePromise,
			send: (message: object) => lineHandler?.(JSON.stringify(message)),
			close: () => closeHandler?.(),
		};
	}

	function createRemoteHost(): FakeHosted {
		return createHost({
			backgroundJobs: new BackgroundJobManager({ isToolAllowed: () => true, getGeneration: () => 0 }),
			attachExtensionClient: vi.fn(() => ({ ready: Promise.resolve(), detach: () => {} })),
			subscribe: vi.fn(() => () => {}),
			subscribeRuntimeEvents: vi.fn(() => () => {}),
			sessionId: "session-remote",
		});
	}

	test("shows approvals only to a client whose grant holds host management", async () => {
		const hosted = createRemoteHost();
		const liveState = hosted.conversation.liveState;
		const phone = await startRemote(hosted, ["conversation.observe.v1", "conversation.control.v1"]);
		// Even a client that claims the capability takes no approval without host management.
		phone.send({ id: "caps", type: "set_client_capabilities", features: ["host_action_requests.v1"] });
		await vi.waitFor(() => expect(phone.writes).toContainEqual(expect.objectContaining({ id: "caps" })));
		await expect(
			liveState.hostInteraction.requestAction({ id: "approval-1", action: "test.action", title: "Approve?" }),
		).resolves.toEqual({ decision: "unavailable" });

		// An approval another client takes stays out of this client's reach.
		const manager = createLiveRecorder(["approval"]);
		const detachManager = liveState.attach("manager", manager);
		const decision = liveState.hostInteraction.requestAction({
			id: "approval-2",
			action: "test.action",
			title: "Approve?",
		});
		// While the manager reconnects, a client that may not answer approvals cannot end them by declining.
		detachManager();
		phone.send({ id: "withdraw", type: "set_client_capabilities", features: [] });
		await vi.waitFor(() => expect(phone.writes).toContainEqual(expect.objectContaining({ id: "withdraw" })));
		expect(liveState.pendingRequest("approval-2")).toBeDefined();
		liveState.attach("manager", manager);
		phone.send({ type: "host_action_response", id: "approval-2", decision: "approved" });
		phone.send({ type: "extension_ui_response", id: "approval-2", confirmed: true });
		phone.send({ id: "pending", type: "get_pending_host_actions" });
		await vi.waitFor(() =>
			expect(phone.writes).toContainEqual(expect.objectContaining({ id: "pending", data: { actions: [] } })),
		);
		expect(phone.writes.filter((write) => write.type === "host_action_request")).toEqual([]);
		expect(liveState.answer("approval-2", { decision: "denied" }, "manager")).toBe("accepted");
		await expect(decision).resolves.toEqual({ decision: "denied" });

		// The client's dialogs are its to answer.
		const asked = liveState.request({ kind: "confirm", title: "Sure?", message: "Really?" });
		await vi.waitFor(() =>
			expect(phone.writes).toContainEqual(
				expect.objectContaining({ type: "extension_ui_request", method: "confirm" }),
			),
		);
		const request = phone.writes.find((write) => write.method === "confirm");
		phone.send({ type: "extension_ui_response", id: request?.id, confirmed: true });
		await expect(asked).resolves.toMatchObject({ status: "answered", response: { confirmed: true } });

		phone.close();
		await expect(phone.modePromise).resolves.toBeUndefined();
	});

	test("shows no extension UI to a client that cannot answer its dialogs", async () => {
		const hosted = createRemoteHost();
		const liveState = hosted.conversation.liveState;
		const observer = await startRemote(hosted, ["conversation.observe.v1", "host.manage.v1"]);
		liveState.set("ext_status/build", { kind: "ext_status", text: "building" });
		liveState.notice("info", "hello");
		await expect(liveState.request({ kind: "confirm", title: "Sure?", message: "Really?" })).resolves.toEqual({
			status: "cancelled",
			reason: "unavailable",
		});
		expect(observer.writes.filter((write) => write.type === "extension_ui_request")).toEqual([]);

		// Its grant holds host management, so it takes approvals once it asks for them.
		observer.send({ id: "caps", type: "set_client_capabilities", features: ["host_action_requests.v1"] });
		await vi.waitFor(() => expect(observer.writes).toContainEqual(expect.objectContaining({ id: "caps" })));
		const decision = liveState.hostInteraction.requestAction({ id: "approval", action: "test.action", title: "Ok?" });
		await vi.waitFor(() =>
			expect(observer.writes).toContainEqual(
				expect.objectContaining({ type: "host_action_request", id: "approval" }),
			),
		);
		observer.send({ type: "host_action_response", id: "approval", decision: "approved" });
		await expect(decision).resolves.toEqual({ decision: "approved" });

		observer.close();
		await expect(observer.modePromise).resolves.toBeUndefined();
	});
});

describe("RPC mode stream discontinuity", () => {
	test("rejects recovery when the transport has no ordered conversation feed", async () => {
		const { hosted } = createRuntimeHost();
		const harness = await startRpcModeHarness(hosted);
		harness.send({
			id: "disc-1",
			type: "report_stream_discontinuity",
			sessionId: "session-1",
			subscriptionId: "subscription-1",
			lastAppliedCursor: 2,
			reason: "cursor_gap",
		});
		await vi.waitFor(() =>
			expect(harness.writes).toContainEqual({
				id: "disc-1",
				type: "response",
				command: "report_stream_discontinuity",
				success: false,
				error: "Ordered conversation recovery is unavailable on this RPC transport",
			}),
		);

		harness.close();
		await harness.modePromise;
	});
});

describe("RPC mode stdio transport", () => {
	test("restores stdout when non-exiting stdio mode closes", async () => {
		const initialEndListenerCount = process.stdin.listenerCount("end");
		const { hosted } = createRuntimeHost();
		let resolveReady: () => void = () => {};
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve;
		});

		const modePromise = runRpcMode(hosted.host, hosted.conversation, {
			exitProcess: false,
			onReady: () => {
				resolveReady();
			},
		});
		await ready;
		expect(process.stdin.listenerCount("end")).toBeGreaterThan(initialEndListenerCount);
		expect(isStdoutTakenOver()).toBe(true);

		process.stdin.emit("end");

		await expect(modePromise).resolves.toBeUndefined();
		expect(isStdoutTakenOver()).toBe(false);
	});
});
