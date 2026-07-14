import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { REVIEW_UNCOMMITTED_ACTION_ID } from "../src/core/host-actions.ts";
import {
	createEmptyIrohRemoteHostState,
	createIrohRemotePresetAccess,
	hashIrohRemotePushToken,
	IrohRemoteAuditLogger,
	IrohRemoteHostStateManager,
	type IrohRemoteLiveActivityRegistration,
	type IrohRemoteLiveActivityUpdateIntent,
	IrohRemotePushNotificationDispatcher,
	type IrohRemotePushRelayClient,
	IrohRemotePushRelayHttpClient,
	type IrohRemotePushRelayNotificationRequest,
	type IrohRemotePushTarget,
} from "../src/core/remote/iroh/index.ts";
import {
	createTestSession,
	isRecord,
	ManualIrohRecvStream,
	ManualIrohSendStream,
	parseWrittenObjects,
	startIrohRpcMode,
} from "./iroh-stream-doubles.ts";

const reviewMocks = vi.hoisted(() => ({
	runReviewWorkflow: vi.fn(async (options: { newSession: (options?: unknown) => Promise<{ cancelled: boolean }> }) => {
		const newSessionResult = await options.newSession({});
		return {
			status: "completed" as const,
			resolution: {
				description: "uncommitted changes",
				diffCommand: "git diff HEAD",
				diff: "diff",
				truncated: false,
			},
			findingsCount: 1,
			sessionSwitchCancelled: newSessionResult.cancelled,
		};
	}),
}));

vi.mock("../src/core/review.ts", () => ({
	REMOTE_REVIEW_TOOL_NAMES: ["read", "grep", "find", "ls"],
	runReviewWorkflow: reviewMocks.runReviewWorkflow,
}));

import { runIrohRemoteRpcMode } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";

function getNotifications(send: ManualIrohSendStream): Array<Record<string, unknown>> {
	return parseWrittenObjects(send).filter((record) => record.type === "notification_request");
}

class ThrowingIrohSendStream extends ManualIrohSendStream {
	writeAll(_bytes: Array<number>): Promise<void> {
		throw new Error("send closed");
	}
}

const LIVE_ACTIVITY_TOKEN_HASH = "a".repeat(64);

type AssistantAgentMessage = Extract<AgentMessage, { role: "assistant" }>;

function createAssistantMessage(overrides: Partial<AssistantAgentMessage> = {}): AssistantAgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: "gpt-5.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function createLiveActivityRegistration(
	overrides: Partial<IrohRemoteLiveActivityRegistration> = {},
): IrohRemoteLiveActivityRegistration {
	return {
		workspaceName: "volt-app",
		sessionId: "session-one",
		activityId: "activity-1",
		tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
		tokenEnvironment: "production",
		platform: "ios",
		pushTargetId: "relay-target-1",
		createdAt: 30,
		updatedAt: 30,
		...overrides,
	};
}

function createStateManagerWithClient(
	pushTargets: IrohRemotePushTarget[] = [],
	liveActivities: IrohRemoteLiveActivityRegistration[] = [],
): IrohRemoteHostStateManager {
	return new IrohRemoteHostStateManager({
		initialState: {
			...createEmptyIrohRemoteHostState(),
			clients: [
				{
					nodeId: "paired-client",
					label: "phone",
					allowedWorkspaces: [],
					allowedTools: "read",
					rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
					pairedAt: 1,
					lastSeenAt: 2,
					...(pushTargets.length > 0 ? { pushTargets } : {}),
					...(liveActivities.length > 0 ? { liveActivities } : {}),
				},
			],
		},
	});
}

function createEnabledPushTarget(overrides: Partial<IrohRemotePushTarget> = {}): IrohRemotePushTarget {
	return {
		id: "relay-target-1",
		provider: "fcm",
		platform: "ios",
		pushTargetAuthToken: "relay-target-auth-token",
		tokenHash: hashIrohRemotePushToken("fcm-token"),
		enabled: true,
		createdAt: 10,
		updatedAt: 10,
		...overrides,
	};
}

function createRelayClient(overrides: Partial<IrohRemotePushRelayClient> = {}): IrohRemotePushRelayClient {
	return {
		sendNotification: vi.fn(async () => ({ status: "sent" as const })),
		...overrides,
	};
}

afterEach(() => {
	reviewMocks.runReviewWorkflow.mockClear();
});

describe("Iroh remote notification requests", () => {
	test("relay HTTP client posts scoped target credentials to the notification endpoint", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response("{}", { status: 200 });
		});
		const client = new IrohRemotePushRelayHttpClient({ baseUrl: "https://push.example.test", fetcher });

		await expect(
			client.sendNotification({
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "relay-target-auth-token",
				eventId: "event-1",
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
				data: { eventId: "event-1", kind: "conversation_completed" },
			}),
		).resolves.toEqual({ status: "sent" });

		expect(fetcher).toHaveBeenCalledWith(
			"https://push.example.test/v1/notifications",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetcher.mock.calls[0]?.[1];
		if (!init) {
			throw new Error("Expected notification fetch init");
		}
		const body = JSON.parse(String(init.body)) as unknown;
		if (!isRecord(body)) {
			throw new Error("Expected notification body object");
		}
		expect(body).toMatchObject({
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			eventId: "event-1",
		});
	});

	test("relay HTTP client posts Live Activity state to the live activity endpoint", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response("{}", { status: 200 });
		});
		const client = new IrohRemotePushRelayHttpClient({ baseUrl: "https://push.example.test", fetcher });

		await expect(
			client.sendLiveActivityUpdate({
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "relay-target-auth-token",
				activityId: "activity-1",
				activityPushToken: "activity-token",
				eventId: "event-1",
				kind: "live_activity_update",
				contentState: {
					status: "running",
					statusText: "Using read",
					currentTool: { name: "read", symbolName: "doc.text.magnifyingglass", status: "started" },
					recentTools: [{ name: "read", symbolName: "doc.text.magnifyingglass", status: "started" }],
					sessionID: "session-1",
					updatedAtEpochSeconds: 123,
				},
				staleDateEpochSeconds: 213,
			}),
		).resolves.toEqual({ status: "sent" });

		expect(fetcher).toHaveBeenCalledWith(
			"https://push.example.test/v1/live-activities",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetcher.mock.calls[0]?.[1];
		if (!init) {
			throw new Error("Expected live activity fetch init");
		}
		const body = JSON.parse(String(init.body)) as unknown;
		if (!isRecord(body)) {
			throw new Error("Expected live activity body object");
		}
		expect(body).toMatchObject({
			activityId: "activity-1",
			activityPushToken: "activity-token",
			contentState: { statusText: "Using read" },
			eventId: "event-1",
			pushTargetId: "relay-target-1",
		});
	});

	test("relay HTTP client forwards the live activity token environment", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response("{}", { status: 200 });
		});
		const client = new IrohRemotePushRelayHttpClient({ baseUrl: "https://push.example.test", fetcher });

		await client.sendLiveActivityUpdate({
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			activityId: "activity-1",
			activityPushToken: "activity-token",
			tokenEnvironment: "development",
			eventId: "event-1",
			kind: "live_activity_update",
			contentState: {
				status: "running",
				statusText: "Using read",
				recentTools: [],
				updatedAtEpochSeconds: 123,
			},
		});

		const init = fetcher.mock.calls[0]?.[1];
		if (!init) {
			throw new Error("Expected live activity fetch init");
		}
		const body = JSON.parse(String(init.body)) as unknown;
		if (!isRecord(body)) {
			throw new Error("Expected live activity body object");
		}
		expect(body).toMatchObject({ tokenEnvironment: "development" });
	});

	test("relay HTTP client treats 422 as an invalid target so the channel is pruned", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response(JSON.stringify({ error: "live_activity_environment_unsupported" }), { status: 422 });
		});
		const client = new IrohRemotePushRelayHttpClient({ baseUrl: "https://push.example.test", fetcher });

		await expect(
			client.sendLiveActivityUpdate({
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "relay-target-auth-token",
				activityId: "activity-1",
				activityPushToken: "activity-token",
				eventId: "event-1",
				kind: "live_activity_update",
				contentState: {
					status: "running",
					statusText: "Using read",
					recentTools: [],
					updatedAtEpochSeconds: 123,
				},
			}),
		).resolves.toEqual({ status: "invalid_target" });
	});

	test("relay HTTP client surfaces the relay error body in thrown errors", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response(JSON.stringify({ error: "fcm_send_failed", code: "messaging/invalid-argument" }), {
				status: 502,
			});
		});
		const client = new IrohRemotePushRelayHttpClient({ baseUrl: "https://push.example.test", fetcher });

		await expect(
			client.sendNotification({
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "relay-target-auth-token",
				eventId: "event-1",
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
				data: { eventId: "event-1", kind: "conversation_completed" },
			}),
		).rejects.toThrow("Push relay request failed with HTTP 502 (fcm_send_failed: messaging/invalid-argument)");
	});

	test("relay HTTP client sends bearer auth when configured", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response("{}", { status: 200 });
		});
		const client = new IrohRemotePushRelayHttpClient({
			authToken: "relay-secret",
			baseUrl: "https://push.example.test",
			fetcher,
		});

		await client.sendNotification({
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			eventId: "event-1",
			kind: "conversation_completed",
			title: "Volt finished",
			body: "Your conversation is ready.",
			data: { eventId: "event-1", kind: "conversation_completed" },
		});

		const init = fetcher.mock.calls[0]?.[1];
		if (!init || !isRecord(init.headers)) {
			throw new Error("Expected notification fetch headers");
		}
		expect(init.headers).toMatchObject({
			authorization: "Bearer relay-secret",
			"content-type": "application/json",
		});
	});

	test("relay HTTP client ignores client-provided relay URLs when sending host credentials", async () => {
		const fetcher = vi.fn(async (_input: string, _init: RequestInit): Promise<Response> => {
			return new Response("{}", { status: 200 });
		});
		const client = new IrohRemotePushRelayHttpClient({
			authToken: "relay-secret",
			baseUrl: "https://trusted-push.example.test/base",
			fetcher,
		});

		const requestWithClientRelayUrl = {
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			relayUrl: "https://attacker.example.test/steal",
			eventId: "event-1",
			kind: "conversation_completed",
			title: "Volt finished",
			body: "Your conversation is ready.",
			data: { eventId: "event-1", kind: "conversation_completed" },
		};

		await client.sendNotification(requestWithClientRelayUrl);

		expect(fetcher).toHaveBeenCalledWith(
			"https://trusted-push.example.test/base/v1/notifications",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetcher.mock.calls[0]?.[1];
		if (!init) {
			throw new Error("Expected notification fetch init");
		}
		expect(fetcher.mock.calls[0]?.[0]).not.toContain("attacker.example.test");
		expect(String(init.body)).not.toContain("attacker.example.test");
	});

	test("register_push_target persists app-issued relay credentials with redacted audit metadata", async () => {
		const now = 100;
		const session = createTestSession("session-one", "before-run");
		const stateManager = createStateManagerWithClient();
		const relayClient = createRelayClient();
		const auditEvents: object[] = [];
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			auditLogger: new IrohRemoteAuditLogger({
				sink: {
					write: (event) => {
						auditEvents.push(event);
					},
				},
			}),
			clientNodeId: "paired-client",
			now: () => now,
			relayClient,
			stateManager,
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			registerPushTarget: (args) => dispatcher.registerPushTarget(args),
		});

		recv.pushLine(
			JSON.stringify({
				id: "push-1",
				type: "register_push_target",
				args: {
					provider: "fcm",
					platform: "ios",
					pushTargetId: "relay-target-1",
					pushTargetAuthToken: "secret-target-auth-token",
					relayUrl: "https://push.example.test",
					tokenHash: hashIrohRemotePushToken("secret-fcm-token"),
					liveActivity: {
						activityId: "activity-1",
						pushToken: "secret-live-activity-token",
						tokenHash: hashIrohRemotePushToken("secret-live-activity-token"),
					},
					enabled: true,
					clientNodeId: "untrusted-client",
				},
			}),
		);

		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual({
				id: "push-1",
				type: "response",
				command: "register_push_target",
				success: true,
				data: { status: "registered", pushTargetId: "relay-target-1" },
			}),
		);
		const state = await stateManager.getState();
		expect(state.clients[0].pushTargets).toEqual([
			{
				id: "relay-target-1",
				provider: "fcm",
				platform: "ios",
				pushTargetAuthToken: "secret-target-auth-token",
				relayUrl: "https://push.example.test",
				tokenHash: hashIrohRemotePushToken("secret-fcm-token"),
				liveActivity: {
					activityId: "activity-1",
					pushToken: "secret-live-activity-token",
					tokenHash: hashIrohRemotePushToken("secret-live-activity-token"),
					updatedAt: 100,
				},
				enabled: true,
				createdAt: 100,
				updatedAt: 100,
			},
		]);
		expect(JSON.stringify(state)).not.toContain("secret-fcm-token");
		expect(JSON.stringify(auditEvents)).not.toContain("secret-target-auth-token");
		expect(JSON.stringify(auditEvents)).not.toContain("secret-fcm-token");
		expect(JSON.stringify(auditEvents)).not.toContain("secret-live-activity-token");
		expect(auditEvents).toContainEqual(
			expect.objectContaining({
				type: "push_target_registered",
				details: expect.objectContaining({ tokenHash: hashIrohRemotePushToken("secret-fcm-token") }),
			}),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("keeps Live Activity open when the agent run will retry", async () => {
		const sessionHandlers: Array<(event: AgentSessionEvent) => void> = [];
		const session = {
			autoCompactionEnabled: false,
			bindExtensions: vi.fn(async () => {}),
			followUpMode: "all" as const,
			isCompacting: false,
			isStreaming: false,
			messages: [],
			model: undefined,
			modelRegistry: { authStorage: {} },
			pendingMessageCount: 0,
			sessionFile: "/sessions/session-one.jsonl",
			sessionId: "session-one",
			sessionManager: { getLeafId: () => "run-one" },
			settingsManager: {},
			steeringMode: "all" as const,
			subscribe: vi.fn((handler: (event: AgentSessionEvent) => void) => {
				sessionHandlers.push(handler);
				return () => {};
			}),
			thinkingLevel: "off" as const,
			waitForIdle: vi.fn(async () => {}),
			agent: { subscribe: vi.fn(() => () => {}), waitForIdle: vi.fn(async () => {}) },
		};
		const deliveredUpdates: Array<{ activityEvent?: "update" | "end"; kind: string }> = [];
		const recv = new ManualIrohRecvStream();
		const modePromise = runIrohRemoteRpcMode(
			{
				session,
				dispose: vi.fn(async () => {}),
				setRebindSession: vi.fn(),
			} as unknown as AgentSessionRuntime,
			{
				disposeRuntimeOnClose: false,
				rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
				notificationDelivery: {
					deliverNotification: vi.fn(async () => "no_push_target" as const),
					deliverLiveActivityUpdate: vi.fn(async (update) => {
						deliveredUpdates.push({ activityEvent: update.activityEvent, kind: update.kind });
						return "sent" as const;
					}),
				},
				stream: { recv, send: new ManualIrohSendStream() },
				workspacePath: "/workspace",
			},
		);

		await vi.waitFor(() => expect(sessionHandlers.length).toBeGreaterThanOrEqual(2));
		for (const handler of sessionHandlers) {
			handler({ type: "agent_start" });
			handler({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: {}, isError: false });
		}
		await vi.waitFor(() =>
			expect(deliveredUpdates).toContainEqual({ activityEvent: "update", kind: "live_activity_update" }),
		);
		for (const handler of sessionHandlers) {
			handler({ type: "agent_end", messages: [], willRetry: true });
		}
		await new Promise((resolve) => setImmediate(resolve));

		expect(deliveredUpdates).not.toContainEqual({ activityEvent: "end", kind: "live_activity_end" });

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("sends Live Activity tool state through the push relay when an activity target exists", async () => {
		const stateManager = createStateManagerWithClient(
			[
				createEnabledPushTarget({
					liveActivity: {
						activityId: "activity-1",
						pushToken: "activity-token",
						tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
						tokenEnvironment: "production",
						updatedAt: 20,
					},
				}),
			],
			[createLiveActivityRegistration()],
		);
		const relayClient = createRelayClient({
			sendLiveActivityUpdate: vi.fn(async () => ({ status: "sent" as const })),
		});
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const contentState = {
			status: "running" as const,
			statusText: "Using read",
			currentTool: { name: "read", symbolName: "doc.text.magnifyingglass", status: "started" as const },
			recentTools: [{ name: "read", symbolName: "doc.text.magnifyingglass", status: "started" as const }],
			sessionID: "session-one",
			workspaceName: "volt-app",
			updatedAtEpochSeconds: 123,
		};

		await expect(
			dispatcher.deliverLiveActivityUpdate({
				eventId: "live-activity:session-one:run-1:1",
				kind: "live_activity_update",
				contentState,
				staleDateEpochSeconds: 213,
			}),
		).resolves.toBe("sent");

		expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledWith({
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			activityId: "activity-1",
			activityPushToken: "activity-token",
			tokenEnvironment: "production",
			eventId: "live-activity:session-one:run-1:1",
			kind: "live_activity_update",
			contentState,
			staleDateEpochSeconds: 213,
		});
	});

	test("sends Live Activity updates when completion notifications are disabled", async () => {
		const stateManager = createStateManagerWithClient(
			[
				createEnabledPushTarget({
					enabled: false,
					liveActivity: {
						activityId: "activity-1",
						pushToken: "activity-token",
						tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
						tokenEnvironment: "production",
						updatedAt: 20,
					},
				}),
			],
			[createLiveActivityRegistration()],
		);
		const relayClient = createRelayClient({
			sendLiveActivityUpdate: vi.fn(async () => ({ status: "sent" as const })),
		});
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const contentState = {
			status: "running" as const,
			statusText: "Using read",
			currentTool: { name: "read", symbolName: "doc.text.magnifyingglass", status: "started" as const },
			recentTools: [{ name: "read", symbolName: "doc.text.magnifyingglass", status: "started" as const }],
			sessionID: "session-one",
			workspaceName: "volt-app",
			updatedAtEpochSeconds: 123,
		};

		await expect(
			dispatcher.deliverLiveActivityUpdate({
				eventId: "live-activity:session-one:run-1:2",
				kind: "live_activity_update",
				contentState,
			}),
		).resolves.toBe("sent");

		expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				pushTargetId: "relay-target-1",
				activityPushToken: "activity-token",
				contentState,
			}),
		);
	});

	test("prunes invalid Live Activity targets without disabling completion notifications", async () => {
		const otherTokenHash = "b".repeat(64);
		const stateManager = createStateManagerWithClient(
			[
				createEnabledPushTarget({
					liveActivity: {
						activityId: "activity-1",
						pushToken: "activity-token",
						tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
						tokenEnvironment: "production",
						updatedAt: 20,
					},
				}),
				createEnabledPushTarget({
					id: "relay-target-2",
					pushTargetAuthToken: "relay-target-auth-token-2",
					tokenHash: hashIrohRemotePushToken("fcm-token-2"),
					enabled: false,
					liveActivity: {
						activityId: "activity-2",
						pushToken: "activity-token-2",
						tokenHash: otherTokenHash,
						tokenEnvironment: "production",
						updatedAt: 25,
					},
				}),
			],
			[
				createLiveActivityRegistration(),
				createLiveActivityRegistration({
					activityId: "activity-2",
					pushTargetId: "relay-target-2",
					sessionId: "session-two",
					tokenHash: otherTokenHash,
					updatedAt: 31,
				}),
			],
		);
		const sendNotification = vi.fn(async () => ({ status: "sent" as const }));
		const sendLiveActivityUpdate = vi.fn(async () => ({ status: "invalid_target" as const }));
		const relayClient = createRelayClient({ sendNotification, sendLiveActivityUpdate });
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			now: () => 500,
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const contentState = {
			status: "running" as const,
			statusText: "Using read",
			currentTool: { name: "read", symbolName: "doc.text.magnifyingglass", status: "started" as const },
			recentTools: [{ name: "read", symbolName: "doc.text.magnifyingglass", status: "started" as const }],
			sessionID: "session-one",
			workspaceName: "volt-app",
			updatedAtEpochSeconds: 123,
		};

		await expect(
			dispatcher.deliverLiveActivityUpdate({
				eventId: "live-activity:session-one:run-1:invalid",
				kind: "live_activity_update",
				contentState,
			}),
		).resolves.toBe("invalid_target");
		await expect(
			dispatcher.deliverLiveActivityUpdate({
				eventId: "live-activity:session-one:run-1:after-prune",
				kind: "live_activity_update",
				contentState,
			}),
		).resolves.toBe("no_push_target");
		expect(sendLiveActivityUpdate).toHaveBeenCalledOnce();

		const state = await stateManager.getState();
		const invalidTarget = state.clients[0].pushTargets?.find((target) => target.id === "relay-target-1");
		expect(invalidTarget).toMatchObject({ enabled: true, updatedAt: 500 });
		expect(invalidTarget).not.toHaveProperty("liveActivity");
		const otherTarget = state.clients[0].pushTargets?.find((target) => target.id === "relay-target-2");
		expect(otherTarget?.liveActivity).toMatchObject({ tokenHash: otherTokenHash });
		expect(state.clients[0].liveActivities).toEqual([
			expect.objectContaining({ activityId: "activity-2", pushTargetId: "relay-target-2" }),
		]);

		await expect(
			dispatcher.deliverNotification({
				eventId: "conversation:session-one:run-1:completed",
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
			}),
		).resolves.toBe("sent");
		expect(sendNotification).toHaveBeenCalledWith(expect.objectContaining({ pushTargetId: "relay-target-1" }));
	});

	test("routes Live Activity updates through the matching workspace and session registration", async () => {
		const stateManager = createStateManagerWithClient(
			[
				createEnabledPushTarget({
					liveActivity: {
						activityId: "stale-target-activity",
						pushToken: "activity-token",
						tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
						tokenEnvironment: "production",
						updatedAt: 20,
					},
				}),
			],
			[
				createLiveActivityRegistration({ activityId: "activity-1", sessionId: "session-one", updatedAt: 30 }),
				createLiveActivityRegistration({ activityId: "activity-2", sessionId: "session-two", updatedAt: 40 }),
			],
		);
		const relayClient = createRelayClient({
			sendLiveActivityUpdate: vi.fn(async () => ({ status: "sent" as const })),
		});
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const contentState = {
			status: "running" as const,
			statusText: "Using bash",
			currentTool: { name: "bash", symbolName: "terminal", status: "started" as const },
			recentTools: [{ name: "bash", symbolName: "terminal", status: "started" as const }],
			sessionID: "session-two",
			workspaceName: "volt-app",
			updatedAtEpochSeconds: 123,
		};

		await expect(
			dispatcher.deliverLiveActivityUpdate({
				eventId: "live-activity:session-two:run-1:1",
				kind: "live_activity_update",
				contentState,
			}),
		).resolves.toBe("sent");

		expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				activityId: "activity-2",
				activityPushToken: "activity-token",
				contentState,
			}),
		);
	});

	test("replaces and unregisters stream-bound Live Activity registrations", async () => {
		const stateManager = createStateManagerWithClient([
			createEnabledPushTarget({
				liveActivity: {
					activityId: "activity-1",
					pushToken: "activity-token",
					tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
					tokenEnvironment: "production",
					updatedAt: 20,
				},
			}),
		]);
		await expect(
			stateManager.findClientLiveActivityDeliveryChannel("paired-client", {
				tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
				tokenEnvironment: "production",
				platform: "ios",
			}),
		).resolves.toMatchObject({ id: "relay-target-1" });
		await expect(
			stateManager.findClientLiveActivityDeliveryChannel("paired-client", {
				tokenHash: "b".repeat(64),
				tokenEnvironment: "production",
				platform: "ios",
			}),
		).resolves.toBeUndefined();

		await stateManager.registerClientLiveActivity(
			"paired-client",
			createLiveActivityRegistration({
				activityId: "activity-1",
				sessionId: "session-one",
				createdAt: 100,
				updatedAt: 100,
			}),
		);
		const replacement = await stateManager.registerClientLiveActivity(
			"paired-client",
			createLiveActivityRegistration({
				activityId: "activity-1",
				sessionId: "session-two",
				createdAt: 200,
				updatedAt: 200,
			}),
		);
		expect(replacement.replacedRegistration).toMatchObject({ sessionId: "session-one" });
		await expect(stateManager.getClient("paired-client")).resolves.toMatchObject({
			liveActivities: [
				expect.objectContaining({ activityId: "activity-1", createdAt: 100, sessionId: "session-two" }),
			],
		});

		await expect(
			stateManager.unregisterClientLiveActivity("paired-client", "volt-app", "session-one", "activity-1"),
		).resolves.toBe(false);
		await expect(
			stateManager.unregisterClientLiveActivity("paired-client", "volt-app", "session-two", "activity-1"),
		).resolves.toBe(true);
		await expect(stateManager.getClient("paired-client")).resolves.not.toHaveProperty("liveActivities");
	});

	test("Live Activity updater sends running state and keeps completed activities updateable", async () => {
		const session = createTestSession("session-one", "conversation-run");
		const stateManager = createStateManagerWithClient(
			[
				createEnabledPushTarget({
					liveActivity: {
						activityId: "activity-1",
						pushToken: "activity-token",
						tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
						tokenEnvironment: "production",
						updatedAt: 20,
					},
				}),
			],
			[createLiveActivityRegistration()],
		);
		const relayClient = createRelayClient({
			sendLiveActivityUpdate: vi.fn(async () => ({ status: "sent" as const })),
		});
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
			workspaceName: "volt-app",
		});
		const sessionHandlers = session.subscribe.mock.calls.map((call) => call[0] as (event: object) => void);
		if (sessionHandlers.length === 0) {
			throw new Error("Expected Live Activity session subscription");
		}
		const emitSessionEvent = (event: object) => {
			for (const handler of sessionHandlers) {
				handler(event);
			}
		};

		emitSessionEvent({ type: "agent_start" });
		await vi.waitFor(() => expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledTimes(1));
		expect(relayClient.sendLiveActivityUpdate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				activityEvent: "update",
				contentState: expect.objectContaining({ status: "running", statusText: "Volt is thinking" }),
				kind: "live_activity_update",
			}),
		);

		emitSessionEvent({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} });
		await vi.waitFor(() => expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledTimes(2));
		expect(relayClient.sendLiveActivityUpdate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				contentState: expect.objectContaining({
					currentTool: expect.objectContaining({ name: "read", status: "started" }),
					status: "running",
					statusText: "Using read",
				}),
				kind: "live_activity_update",
			}),
		);

		emitSessionEvent({
			type: "tool_execution_end",
			toolCallId: "read-1",
			toolName: "read",
			result: {},
			isError: false,
		});
		await vi.waitFor(() => expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledTimes(3));
		emitSessionEvent({
			type: "tool_execution_end",
			toolCallId: "read-2",
			toolName: "read",
			result: {},
			isError: false,
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledTimes(3);

		emitSessionEvent({
			type: "tool_execution_end",
			toolCallId: "bash-1",
			toolName: "bash",
			result: {},
			isError: false,
		});
		await vi.waitFor(() => expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledTimes(4));
		// A raw agent_end may be followed by proactive compaction and another
		// agent run, so it must not publish a terminal state yet.
		emitSessionEvent({ type: "agent_end", messages: [], willRetry: false });
		await new Promise((resolve) => setImmediate(resolve));
		expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledTimes(4);

		emitSessionEvent({ type: "agent_start" });
		await vi.waitFor(() => expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledTimes(5));
		expect(relayClient.sendLiveActivityUpdate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				activityEvent: "update",
				contentState: expect.objectContaining({ status: "running", statusText: "Volt is thinking" }),
				kind: "live_activity_update",
			}),
		);

		emitSessionEvent({ type: "agent_end", messages: [], willRetry: false });
		await new Promise((resolve) => setImmediate(resolve));
		expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledTimes(5);
		emitSessionEvent({ type: "agent_settled" });
		await vi.waitFor(() => expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledTimes(6));
		expect(relayClient.sendLiveActivityUpdate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				activityEvent: "update",
				contentState: expect.objectContaining({ status: "completed", statusText: "Volt finished" }),
				kind: "live_activity_update",
			}),
		);
		expect(relayClient.sendLiveActivityUpdate).not.toHaveBeenCalledWith(
			expect.objectContaining({ activityEvent: "end", kind: "live_activity_end" }),
		);

		emitSessionEvent({ type: "agent_start" });
		await vi.waitFor(() => expect(relayClient.sendLiveActivityUpdate).toHaveBeenCalledTimes(7));

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("delayed Live Activity settlement cannot deactivate a newer run", async () => {
		const session = createTestSession("session-one", "conversation-run");
		const updates: IrohRemoteLiveActivityUpdateIntent[] = [];
		let releaseFirstTerminal: () => void = () => undefined;
		const firstTerminalRelease = new Promise<void>((resolve) => {
			releaseFirstTerminal = resolve;
		});
		let notifyFirstTerminalStarted: () => void = () => undefined;
		const firstTerminalStarted = new Promise<void>((resolve) => {
			notifyFirstTerminalStarted = resolve;
		});
		let terminalCount = 0;
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push(update);
					if (update.contentState.status === "completed" && ++terminalCount === 1) {
						notifyFirstTerminalStarted();
						await firstTerminalRelease;
					}
					return "sent" as const;
				}),
			},
		});
		const handlers = session.subscribe.mock.calls.map((call) => call[0] as (event: AgentSessionEvent) => void);
		const emit = (event: AgentSessionEvent) => {
			for (const handler of handlers) {
				handler(event);
			}
		};

		emit({ type: "agent_start" });
		await vi.waitFor(() =>
			expect(updates.filter((update) => update.contentState.status === "running")).toHaveLength(1),
		);
		emit({ type: "agent_end", messages: [], willRetry: false });
		emit({ type: "agent_settled" });
		await firstTerminalStarted;

		emit({ type: "agent_start" });
		releaseFirstTerminal();
		await vi.waitFor(() =>
			expect(updates.filter((update) => update.contentState.status === "running")).toHaveLength(2),
		);
		emit({ type: "agent_end", messages: [], willRetry: false });
		emit({ type: "agent_settled" });
		await vi.waitFor(() =>
			expect(updates.filter((update) => update.contentState.status === "completed")).toHaveLength(2),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("Live Activity updater reports terminal assistant errors as failed", async () => {
		const session = createTestSession("session-one", "conversation-run");
		const updates: Array<IrohRemoteLiveActivityUpdateIntent> = [];
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push(update);
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});
		const sessionHandlers = session.subscribe.mock.calls.map((call) => call[0] as (event: AgentSessionEvent) => void);
		if (sessionHandlers.length === 0) {
			throw new Error("Expected Live Activity session subscription");
		}

		for (const handler of sessionHandlers) {
			handler({ type: "agent_start" });
		}
		await vi.waitFor(() =>
			expect(updates).toContainEqual(
				expect.objectContaining({ contentState: expect.objectContaining({ status: "running" }) }),
			),
		);
		for (const handler of sessionHandlers) {
			handler({
				type: "agent_end",
				messages: [
					createAssistantMessage({ stopReason: "error", errorMessage: "No API key for provider: openai-codex" }),
				],
				willRetry: false,
			});
			handler({ type: "agent_settled" });
		}
		await vi.waitFor(() =>
			expect(updates).toContainEqual(
				expect.objectContaining({
					activityEvent: "update",
					contentState: expect.objectContaining({ status: "failed", statusText: "Volt needs attention" }),
					kind: "live_activity_update",
				}),
			),
		);
		expect(updates).not.toContainEqual(
			expect.objectContaining({ contentState: expect.objectContaining({ status: "completed" }) }),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("Live Activity updater reattaches to active runs without reusing event IDs", async () => {
		let currentSession = createTestSession("session-one", "conversation-run");
		const initialHandlers: Array<(event: AgentSessionEvent) => void> = [];
		currentSession.subscribe.mockImplementation((handler: (event: AgentSessionEvent) => void) => {
			initialHandlers.push(handler);
			return () => {};
		});
		const setRebindSession = vi.fn();
		const updates: Array<{ eventId: string; status: string }> = [];
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession,
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, currentSession, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					updates.push({ eventId: update.eventId, status: update.contentState.status });
					return "sent" as const;
				}),
			},
			workspaceName: "volt-app",
		});
		const rebindSession = setRebindSession.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
		if (!rebindSession) {
			throw new Error("Expected runIrohRemoteRpcMode to register a session rebind callback");
		}
		await vi.waitFor(() => expect(initialHandlers.length).toBeGreaterThan(0));

		for (const handler of initialHandlers) {
			handler({ type: "agent_start" });
		}
		await vi.waitFor(() => expect(updates).toContainEqual(expect.objectContaining({ status: "running" })));

		const reattachedSession = createTestSession("session-one", "conversation-run");
		reattachedSession.isStreaming = true;
		const reattachedHandlers: Array<(event: AgentSessionEvent) => void> = [];
		reattachedSession.subscribe.mockImplementation((handler: (event: AgentSessionEvent) => void) => {
			reattachedHandlers.push(handler);
			return () => {};
		});
		currentSession = reattachedSession;
		await rebindSession();
		await vi.waitFor(() => expect(updates.filter((update) => update.status === "running")).toHaveLength(2));

		for (const handler of reattachedHandlers) {
			handler({ type: "agent_end", messages: [], willRetry: false });
			handler({ type: "agent_settled" });
		}
		await vi.waitFor(() => expect(updates).toContainEqual(expect.objectContaining({ status: "completed" })));
		expect(new Set(updates.map((update) => update.eventId)).size).toBe(updates.length);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("updates relayed session id before active Live Activity reattach delivery", async () => {
		let currentSession = createTestSession("session-one", "run-one");
		const setRebindSession = vi.fn();
		let relayedSessionId = currentSession.sessionId;
		const deliveries: Array<{ payloadSessionId: string | undefined; relayedSessionId: string }> = [];
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession,
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, currentSession, {
			notificationDelivery: {
				deliverNotification: vi.fn(async () => "no_push_target" as const),
				deliverLiveActivityUpdate: vi.fn(async (update: IrohRemoteLiveActivityUpdateIntent) => {
					deliveries.push({ payloadSessionId: update.contentState.sessionID, relayedSessionId });
					return "sent" as const;
				}),
			},
			onSessionChanged: async (session) => {
				relayedSessionId = session.sessionId;
			},
			workspaceName: "volt-app",
		});
		const rebindSession = setRebindSession.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
		if (!rebindSession) {
			throw new Error("Expected runIrohRemoteRpcMode to register a session rebind callback");
		}

		const reattachedSession = createTestSession("session-two", "run-two");
		reattachedSession.isStreaming = true;
		currentSession = reattachedSession;
		await rebindSession();

		await vi.waitFor(() =>
			expect(deliveries).toEqual([{ payloadSessionId: "session-two", relayedSessionId: "session-two" }]),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("sends conversation completion notifications through the push relay when a target exists", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
				session.leafId = "conversation-run";
			},
		);
		const stateManager = createStateManagerWithClient([
			createEnabledPushTarget({ relayUrl: "https://attacker.example.test/steal" }),
		]);
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
			workspaceName: "volt-app",
		});

		recv.pushLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));

		const expectedNotification: IrohRemotePushRelayNotificationRequest = {
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			eventId: "conversation:session-one:conversation-run:completed",
			kind: "conversation_completed",
			title: "Volt finished in volt-app",
			body: "Your conversation is ready.",
			workspace: "volt-app",
			data: {
				eventId: "conversation:session-one:conversation-run:completed",
				kind: "conversation_completed",
				sessionId: "session-one",
				workspace: "volt-app",
			},
		};
		await vi.waitFor(() => expect(relayClient.sendNotification).toHaveBeenCalledWith(expectedNotification));
		expect(getNotifications(send)).toEqual([]);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("sends failure notice instead of completion notification when a prompt ends with an assistant error", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
				session.leafId = "conversation-run";
				session.messages = [
					createAssistantMessage({ stopReason: "error", errorMessage: "No API key for provider: openai-codex" }),
				];
			},
		);
		const stateManager = createStateManagerWithClient([
			createEnabledPushTarget({ relayUrl: "https://attacker.example.test/steal" }),
		]);
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
			workspaceName: "volt-app",
		});

		recv.pushLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));

		await vi.waitFor(() =>
			expect(relayClient.sendNotification).toHaveBeenCalledWith(
				expect.objectContaining({
					eventId: "conversation:session-one:conversation-run:failed",
					kind: "host_notice",
					title: "Volt needs attention in volt-app",
					body: "Open Volt to view the error.",
				}),
			),
		);
		expect(relayClient.sendNotification).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "conversation_completed" }),
		);
		expect(getNotifications(send)).toEqual([]);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("does not send a completion notification when a prompt is aborted", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
				session.leafId = "conversation-run";
				session.messages = [createAssistantMessage({ stopReason: "aborted" })];
			},
		);
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		recv.pushLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));

		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({ id: "prompt-1", type: "response", command: "prompt", success: true }),
			),
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(getNotifications(send)).toEqual([]);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("sends push completion notification when accepted prompt response cannot be written", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
				session.leafId = "conversation-run";
			},
		);
		const stateManager = createStateManagerWithClient([createEnabledPushTarget()]);
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const recv = new ManualIrohRecvStream();
		const modePromise = runIrohRemoteRpcMode(runtimeHost, {
			disposeRuntimeOnClose: false,
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			notificationDelivery: dispatcher,
			stream: { recv, send: new ThrowingIrohSendStream() },
			workspacePath: "/workspace",
		});
		void modePromise.catch(() => {});
		await vi.waitFor(() => expect(session.bindExtensions).toHaveBeenCalledOnce());

		recv.pushLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));

		await vi.waitFor(() =>
			expect(relayClient.sendNotification).toHaveBeenCalledWith(
				expect.objectContaining({ eventId: "conversation:session-one:conversation-run:completed" }),
			),
		);
		await expect(modePromise).rejects.toThrow("send closed");
	});

	test("streams displayed review custom messages as transcript entries after session rebind", async () => {
		const initialSession = createTestSession("initial-session", "initial-entry");
		const reviewSession = createTestSession("review-session", "review-entry");
		const reviewContent = [{ type: "text" as const, text: "Review findings" }];
		reviewSession.sessionManager.getBranch.mockReturnValue([
			{
				type: "custom_message",
				id: "review-entry",
				parentId: null,
				timestamp: "2026-06-27T00:00:00.000Z",
				customType: "review",
				content: reviewContent,
				display: true,
			},
		]);
		const reviewSessionHandlers: Array<(event: AgentSessionEvent) => void> = [];
		reviewSession.subscribe.mockImplementation((handler: (event: AgentSessionEvent) => void) => {
			reviewSessionHandlers.push(handler);
			return () => {
				const index = reviewSessionHandlers.indexOf(handler);
				if (index !== -1) {
					reviewSessionHandlers.splice(index, 1);
				}
			};
		});
		let currentSession = initialSession;
		const setRebindSession = vi.fn();
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession,
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, initialSession);
		const rebindSession = setRebindSession.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
		if (!rebindSession) {
			throw new Error("Expected runIrohRemoteRpcMode to register a session rebind callback");
		}

		currentSession = reviewSession;
		await rebindSession();
		for (const handler of reviewSessionHandlers) {
			handler({
				type: "message_end",
				message: {
					role: "custom",
					customType: "review",
					content: reviewContent,
					display: true,
					timestamp: Date.now(),
				},
			} as AgentSessionEvent);
		}

		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual({
				type: "transcript_entry",
				entry: {
					entryId: "review-entry",
					createdAt: "2026-06-27T00:00:00.000Z",
					role: "assistant",
					text: "Review findings",
					truncated: false,
				},
				final: true,
			}),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("streams assistant transcript entries with preserved Markdown formatting", async () => {
		const session = createTestSession("session-one", "leaf-one");
		const formattedText =
			"Here is the plan:\n\n- Keep Markdown lists\n- Preserve code fences\n\n```swift\nlet value = 1\n```";
		const assistantMessage = {
			role: "assistant",
			content: [{ type: "text" as const, text: formattedText }],
			timestamp: 1,
		};
		session.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				id: "assistant-entry",
				parentId: null,
				timestamp: "2026-06-27T00:00:00.000Z",
				message: assistantMessage,
			},
		]);
		const sessionHandlers: Array<(event: AgentSessionEvent) => void> = [];
		session.subscribe.mockImplementation((handler: (event: AgentSessionEvent) => void) => {
			sessionHandlers.push(handler);
			return () => {};
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		for (const handler of sessionHandlers) {
			handler({ type: "message_end", message: assistantMessage } as AgentSessionEvent);
		}

		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual({
				type: "transcript_entry",
				entry: {
					entryId: "assistant-entry",
					createdAt: "2026-06-27T00:00:00.000Z",
					role: "assistant",
					text: formattedText,
					truncated: false,
				},
				final: true,
			}),
		);

		expect(JSON.stringify(parseWrittenObjects(send))).not.toContain(
			"Here is the plan: - Keep Markdown lists - Preserve code fences",
		);
		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("streams assistant transcript entries with canonical text across multiple text parts", async () => {
		const session = createTestSession("session-one", "leaf-one");
		const expectedText = ["Here is a plan:", "- Step one", "- Step two", "```swift", "\tlet value = 1", "```"].join(
			"\n",
		);
		const assistantMessage = {
			role: "assistant",
			content: [
				{ type: "text" as const, text: "Here is a plan:\n- Step one" },
				{ type: "text" as const, text: "- Step two\n```swift\n\tlet value = 1\n```" },
			],
			timestamp: 1,
		};
		session.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				id: "assistant-entry",
				parentId: null,
				timestamp: "2026-06-27T00:00:00.000Z",
				message: assistantMessage,
			},
		]);
		const sessionHandlers: Array<(event: AgentSessionEvent) => void> = [];
		session.subscribe.mockImplementation((handler: (event: AgentSessionEvent) => void) => {
			sessionHandlers.push(handler);
			return () => {};
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		for (const handler of sessionHandlers) {
			handler({ type: "message_end", message: assistantMessage } as AgentSessionEvent);
		}

		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual({
				type: "transcript_entry",
				entry: {
					entryId: "assistant-entry",
					createdAt: "2026-06-27T00:00:00.000Z",
					role: "assistant",
					text: expectedText,
					truncated: false,
				},
				final: true,
			}),
		);

		recv.pushLine(JSON.stringify({ id: "transcript-1", type: "get_transcript", limit: 10 }));
		await vi.waitFor(() =>
			expect(parseWrittenObjects(send)).toContainEqual({
				id: "transcript-1",
				type: "response",
				command: "get_transcript",
				success: true,
				data: {
					sessionId: "session-one",
					items: [
						{
							id: "assistant-entry",
							role: "assistant",
							text: expectedText,
							timestamp: "2026-06-27T00:00:00.000Z",
						},
					],
					hasMore: false,
					nextBeforeEntryId: null,
				},
			}),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("streams completed tool transcript entries with projected metadata", async () => {
		const session = createTestSession("session-one", "leaf-one");
		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "bash-call",
					name: "bash",
					arguments: { command: "pwd && cat /workspace/src/index.ts", timeout: 5 },
				},
				{
					type: "toolCall",
					id: "read-call",
					name: "read",
					arguments: { path: "/workspace/src/index.ts", offset: 3 },
				},
				{
					type: "toolCall",
					id: "registry-call",
					name: "subagent_registry",
					arguments: { list: true, offset: 50 },
				},
			],
			timestamp: 1,
		};
		const bashResult = {
			role: "toolResult",
			toolCallId: "bash-call",
			toolName: "bash",
			content: [{ type: "text", text: "private output" }],
			isError: false,
			timestamp: 2,
		};
		const readResult = {
			role: "toolResult",
			toolCallId: "read-call",
			toolName: "read",
			content: [{ type: "text", text: "private file contents" }],
			isError: false,
			timestamp: 3,
		};
		const registryResult = {
			role: "toolResult",
			toolCallId: "registry-call",
			toolName: "subagent_registry",
			content: [{ type: "text", text: "bounded registry page" }],
			details: {
				mode: "list",
				status: "completed",
				summary: { total: 120, offset: 50, returned: 50, nextOffset: 100 },
			},
			isError: false,
			timestamp: 4,
		};
		session.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				id: "assistant-entry",
				parentId: null,
				timestamp: "2026-06-27T00:00:00.000Z",
				message: assistantMessage,
			},
			{
				type: "message",
				id: "bash-entry",
				parentId: "assistant-entry",
				timestamp: "2026-06-27T00:00:01.000Z",
				message: bashResult,
			},
			{
				type: "message",
				id: "read-entry",
				parentId: "bash-entry",
				timestamp: "2026-06-27T00:00:02.000Z",
				message: readResult,
			},
			{
				type: "message",
				id: "registry-entry",
				parentId: "read-entry",
				timestamp: "2026-06-27T00:00:03.000Z",
				message: registryResult,
			},
		]);
		const sessionHandlers: Array<(event: AgentSessionEvent) => void> = [];
		session.subscribe.mockImplementation((handler: (event: AgentSessionEvent) => void) => {
			sessionHandlers.push(handler);
			return () => {};
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		for (const handler of sessionHandlers) {
			handler({ type: "message_end", message: bashResult } as AgentSessionEvent);
			handler({ type: "message_end", message: readResult } as AgentSessionEvent);
			handler({ type: "message_end", message: registryResult } as AgentSessionEvent);
		}

		await vi.waitFor(() => {
			const objects = parseWrittenObjects(send);
			const transcriptEntries = objects.filter((record) => record.type === "transcript_entry");
			expect(transcriptEntries).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					entry: expect.objectContaining({
						entryId: "bash-entry",
						role: "tool",
						toolName: "bash",
						status: "completed",
						summary: "Ran command: pwd && cat /workspace/src/index.ts (completed)",
						args: { command: "pwd && cat /workspace/src/index.ts", timeout: 5 },
						output: "private output",
						outputTruncated: false,
					}),
				}),
			);
			expect(transcriptEntries).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					entry: expect.objectContaining({
						entryId: "read-entry",
						role: "tool",
						toolName: "read",
						status: "completed",
						path: "/workspace/src/index.ts",
						args: { path: "/workspace/src/index.ts", offset: 3 },
						output: "private file contents",
						outputTruncated: false,
					}),
				}),
			);
			expect(transcriptEntries).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					entry: expect.objectContaining({
						entryId: "registry-entry",
						role: "tool",
						toolName: "subagent_registry",
						status: "completed",
						args: { list: true, offset: 50 },
						details: {
							mode: "list",
							status: "completed",
							summary: { total: 120, offset: 50, returned: 50, nextOffset: 100 },
						},
						output: "bounded registry page",
						outputTruncated: false,
					}),
				}),
			);
		});

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("streams tool transcript entries advertising imageCount without inline image data", async () => {
		const session = createTestSession("session-one", "leaf-one");
		const assistantMessage = {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "read-image-call",
					name: "read",
					arguments: { path: "/workspace/logo.png" },
				},
			],
			timestamp: 1,
		};
		const imageReadResult = {
			role: "toolResult",
			toolCallId: "read-image-call",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 2,
		};
		session.sessionManager.getBranch.mockReturnValue([
			{
				type: "message",
				id: "assistant-entry",
				parentId: null,
				timestamp: "2026-06-27T00:00:00.000Z",
				message: assistantMessage,
			},
			{
				type: "message",
				id: "read-image-entry",
				parentId: "assistant-entry",
				timestamp: "2026-06-27T00:00:01.000Z",
				message: imageReadResult,
			},
		]);
		const sessionHandlers: Array<(event: AgentSessionEvent) => void> = [];
		session.subscribe.mockImplementation((handler: (event: AgentSessionEvent) => void) => {
			sessionHandlers.push(handler);
			return () => {};
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		for (const handler of sessionHandlers) {
			handler({ type: "message_end", message: imageReadResult } as AgentSessionEvent);
		}

		await vi.waitFor(() => {
			const objects = parseWrittenObjects(send);
			const transcriptEntries = objects.filter((record) => record.type === "transcript_entry");
			expect(transcriptEntries).toContainEqual(
				expect.objectContaining({
					type: "transcript_entry",
					entry: expect.objectContaining({
						entryId: "read-image-entry",
						role: "tool",
						toolName: "read",
						status: "completed",
						imageCount: 1,
					}),
				}),
			);
			// Live transcript frames stay text-only; the blocks are fetched per
			// entry via get_message_images.
			expect(JSON.stringify(transcriptEntries)).not.toContain("aW1hZ2UtYnl0ZXM=");
		});

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("falls back to Iroh notification_request when no push target exists", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
				session.leafId = "conversation-run";
			},
		);
		const stateManager = createStateManagerWithClient();
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			stateManager,
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
			workspaceName: "volt-app",
		});

		recv.pushLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));

		await vi.waitFor(() =>
			expect(getNotifications(send)).toEqual([
				{
					type: "notification_request",
					eventId: "conversation:session-one:conversation-run:completed",
					kind: "conversation_completed",
					title: "Volt finished in volt-app",
					body: "Your conversation is ready.",
					sessionId: "session-one",
					workspace: "volt-app",
				},
			]),
		);
		expect(relayClient.sendNotification).not.toHaveBeenCalled();

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("does not send duplicate push notifications for the same eventId", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
				session.leafId = "conversation-run";
			},
		);
		const stateManager = createStateManagerWithClient([createEnabledPushTarget()]);
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
		});

		recv.pushLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));
		await vi.waitFor(() => expect(relayClient.sendNotification).toHaveBeenCalledTimes(1));
		session.leafId = "before-run";
		recv.pushLine(JSON.stringify({ id: "prompt-2", type: "prompt", message: "hello again" }));
		await vi.waitFor(() => expect(session.prompt).toHaveBeenCalledTimes(2));
		await new Promise((resolve) => setImmediate(resolve));
		expect(relayClient.sendNotification).toHaveBeenCalledTimes(1);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("disables push targets reported invalid by the relay", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
				session.leafId = "conversation-run";
			},
		);
		const stateManager = createStateManagerWithClient([
			createEnabledPushTarget({
				liveActivity: {
					activityId: "activity-1",
					pushToken: "activity-token",
					tokenHash: LIVE_ACTIVITY_TOKEN_HASH,
					tokenEnvironment: "production",
					updatedAt: 20,
				},
			}),
		]);
		const relayClient = createRelayClient({
			sendNotification: vi.fn(async () => ({ status: "invalid_target" as const })),
		});
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			clientNodeId: "paired-client",
			now: () => 500,
			relayClient,
			retryDelayMs: 0,
			stateManager,
		});
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session, {
			notificationDelivery: dispatcher,
		});

		recv.pushLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));

		await vi.waitFor(async () => {
			const state = await stateManager.getState();
			expect(state.clients[0].pushTargets?.[0]).toMatchObject({ enabled: false, updatedAt: 500 });
			expect(state.clients[0].pushTargets?.[0]).not.toHaveProperty("liveActivity");
		});
		await vi.waitFor(() =>
			expect(getNotifications(send)).toEqual([
				{
					type: "notification_request",
					eventId: "conversation:session-one:conversation-run:completed",
					kind: "conversation_completed",
					title: "Volt finished",
					body: "Your conversation is ready.",
					sessionId: "session-one",
				},
			]),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("emits one conversation completion notification after prompt completion", async () => {
		const session = createTestSession("session-one", "before-run");
		session.prompt.mockImplementation(
			async (_message: string, options?: { preflightResult?: (success: boolean) => void }): Promise<void> => {
				options?.preflightResult?.(true);
				session.leafId = "conversation-run";
			},
		);
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, session);

		recv.pushLine(JSON.stringify({ id: "prompt-1", type: "prompt", message: "hello" }));

		await vi.waitFor(() =>
			expect(getNotifications(send)).toEqual([
				{
					type: "notification_request",
					eventId: "conversation:session-one:conversation-run:completed",
					kind: "conversation_completed",
					title: "Volt finished",
					body: "Your conversation is ready.",
					sessionId: "session-one",
				},
			]),
		);

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("emits one review completion notification after a remote review action completes", async () => {
		let currentSession = createTestSession("initial-session", "initial-run");
		const runtimeHost = {
			get session() {
				return currentSession;
			},
			cwd: "/workspace",
			services: { agentDir: "/agent" },
			newSession: vi.fn(async () => {
				currentSession = createTestSession("review-session", "review-run");
				return { cancelled: false };
			}),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn(),
		} as unknown as AgentSessionRuntime;
		const startupSession = currentSession;
		const { modePromise, recv, send } = await startIrohRpcMode(runtimeHost, startupSession);

		recv.pushLine(JSON.stringify({ id: "review-1", type: "invoke_ui_action", action: REVIEW_UNCOMMITTED_ACTION_ID }));

		await vi.waitFor(() =>
			expect(getNotifications(send)).toEqual([
				{
					type: "notification_request",
					eventId: "review:review-session:review-run:completed",
					kind: "review_completed",
					title: "Review complete",
					body: "Open Volt to see the findings.",
					sessionId: "review-session",
				},
			]),
		);
		expect(reviewMocks.runReviewWorkflow).toHaveBeenCalledOnce();

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});
});
