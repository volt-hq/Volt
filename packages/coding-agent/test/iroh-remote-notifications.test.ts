/**
 * Completion notifications for paired devices (completion-notifications.ts)
 * over a phone stream on the remote profile, the push relay client and
 * dispatcher, and the transcript views a phone receives for message entries.
 * Notifications go through push delivery only.
 */

import { Buffer } from "node:buffer";
import { join } from "node:path";
import type { ToolResultMessage } from "@hansjm10/volt-ai";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { HostFrame, ProjectedEntry, RemoteGrant } from "@hansjm10/volt-protocol";
import { REMOTE_CAPABILITIES } from "@hansjm10/volt-protocol";
import type { IrohRemotePushNotificationDeliveryStatus } from "@hansjm10/volt-protocol/push";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import type { PlanningState } from "../src/core/planning.ts";
import type { IntentServices } from "../src/core/protocol/intents/types.ts";
import type { ProtocolConnection } from "../src/core/protocol/server/connection.ts";
import type { IrohBiStreamLike } from "../src/core/protocol/transport/iroh-transport.ts";
import type { CompletionNotificationsOptions } from "../src/core/remote/iroh/completion-notifications.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import {
	createEmptyIrohRemoteHostState,
	createIrohRemotePresetAccess,
	hashIrohRemotePushToken,
	IrohRemoteAuditLogger,
	IrohRemoteHostStateManager,
	IrohRemotePushNotificationDispatcher,
	type IrohRemotePushNotificationIntent,
	type IrohRemotePushRelayClient,
	IrohRemotePushRelayHttpClient,
	type IrohRemotePushRelayNotificationRequest,
	type IrohRemotePushTarget,
} from "../src/core/remote/iroh/index.ts";
import type * as ReviewModule from "../src/core/review.ts";
import { type ExecuteReviewWorkflowResult, reviewWorkExecution } from "../src/core/review.ts";
import { reviewWorkInput } from "../src/core/review-work.ts";
import { createHostHarness, type HostHarness } from "./suite/host-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

const reviewMocks = vi.hoisted(() => ({
	prepareReviewWorkflow: vi.fn(async (options: { target: unknown }) => ({
		workflowId: "review:test",
		action: "review.uncommitted",
		startedAt: 1_782_470_400_000,
		target: options.target,
		resolution: {
			description: "uncommitted changes",
			diffCommand: "git diff HEAD",
			diff: "diff",
			truncated: false,
		},
		model: { id: "test-model", provider: "test" },
	})),
	executeReviewWorkflow: vi.fn(async () => ({
		status: "completed" as const,
		raw: "raw reviewer output",
		parsed: {
			completionStatus: "complete" as const,
			summary: "One verified finding.",
			findings: [],
			coverage: {
				changedFileInventoryComplete: true,
				filesInspected: [],
				hunksInspected: [],
				commandsRun: [],
				failedVerificationAttempts: [],
				exclusions: [],
				uncheckedAreas: [],
				residualRisk: [],
				modelReportedLimitations: [],
			},
			overallCorrectness: "correct" as const,
			overallExplanation: "Verification completed.",
		},
		findingsCount: 1,
		completionStatus: "complete" as const,
	})),
}));

vi.mock("../src/core/review.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof ReviewModule>();
	return {
		...actual,
		prepareReviewWorkflow: reviewMocks.prepareReviewWorkflow,
		executeReviewWorkflow: reviewMocks.executeReviewWorkflow,
	};
});

const TEST_HOST_NODE_ID = "a".repeat(64);
const GRANT: RemoteGrant = { schemaVersion: 1, revision: 1, capabilities: [...REMOTE_CAPABILITIES] };

type EntryFrame = Extract<HostFrame, { type: "entry" }>;

function completedReview(
	findingsCount: number,
	completionStatus: "complete" | "incomplete" = "complete",
): ExecuteReviewWorkflowResult {
	return {
		status: "completed",
		raw: "private",
		parsed: {
			completionStatus,
			summary: findingsCount === 0 ? "No findings." : `${findingsCount} findings.`,
			findings: [],
			coverage: {
				changedFileInventoryComplete: true,
				filesInspected: [],
				hunksInspected: [],
				commandsRun: [],
				failedVerificationAttempts: [],
				exclusions: [],
				uncheckedAreas: [],
				residualRisk: [],
				modelReportedLimitations: [],
			},
			...(completionStatus === "complete" ? { overallCorrectness: "correct" as const } : {}),
			overallExplanation:
				completionStatus === "complete" ? "Verification completed." : "Verification was incomplete.",
		},
		findingsCount,
		completionStatus,
	};
}

/** Start review work `workId` of `target` on `conversation`; it ends with the result `finish` gives it. */
function startTestReview(
	conversation: HostedConversation,
	workId: string,
	targetDescription = "uncommitted changes",
): { finish(result: ExecuteReviewWorkflowResult): void } {
	const result = Promise.withResolvers<ExecuteReviewWorkflowResult>();
	void conversation.work.start(
		"review",
		reviewWorkInput("review.uncommitted", targetDescription),
		async () => reviewWorkExecution(await result.promise, targetDescription),
		{ workId },
	);
	return { finish: (value) => result.resolve(value) };
}

function createStateManagerWithClient(pushTargets: IrohRemotePushTarget[] = []): IrohRemoteHostStateManager {
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

function createDispatcher(relayClient: IrohRemotePushRelayClient, stateManager: IrohRemoteHostStateManager) {
	return new IrohRemotePushNotificationDispatcher({
		clientNodeId: "paired-client",
		relayClient,
		retryDelayMs: 0,
		stateManager,
	});
}

/** A push delivery that records what it was asked to deliver and answers `status`. */
function recordingDelivery(status: () => IrohRemotePushNotificationDeliveryStatus = () => "sent") {
	const delivered: IrohRemotePushNotificationIntent[] = [];
	const deliverNotification = vi.fn(async (notification: IrohRemotePushNotificationIntent) => {
		delivered.push(notification);
		return status();
	});
	return { delivered, deliverNotification };
}

function isEntry(frame: HostFrame): frame is EntryFrame {
	return frame.type === "entry";
}

/** The projected entry the phone received for log entry `id`. */
async function entryOf(phone: RemotePhone, id: string): Promise<ProjectedEntry> {
	const frame = await phone.waitFor(
		(candidate): candidate is EntryFrame => isEntry(candidate) && candidate.entry.id === id,
	);
	return frame.entry;
}

describe("Iroh remote completion notifications", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		reviewMocks.prepareReviewWorkflow.mockClear();
		reviewMocks.executeReviewWorkflow.mockClear();
	});

	async function setup(): Promise<{ harness: HostHarness; conversation: HostedConversation }> {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		return { harness, conversation };
	}

	/** A paired device's stream to `conversation`, said hello and subscribed. */
	async function connectDevice(
		harness: HostHarness,
		conversation: HostedConversation,
		options: {
			notifications?: CompletionNotificationsOptions;
			services?: IntentServices;
			stream?: (stream: IrohBiStreamLike) => IrohBiStreamLike;
			subscribe?: boolean;
		} = {},
	): Promise<{ phone: RemotePhone; connection: ProtocolConnection }> {
		const pair = createIrohStreamPair();
		const services = options.services;
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: options.stream ? options.stream(pair.host) : pair.host,
			grant: GRANT,
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
			...(services === undefined ? {} : { services: () => services }),
			...(options.notifications === undefined ? {} : { notifications: options.notifications }),
		});
		void connection.closed.catch(() => undefined);
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		await phone.hello();
		if (options.subscribe !== false) await phone.subscribe(conversation.id);
		return { phone, connection };
	}

	async function prompt(phone: RemotePhone, message: string): Promise<void> {
		expect(await phone.intent("prompt", { message })).toMatchObject({ type: "accepted" });
	}

	async function idle(conversation: HostedConversation): Promise<void> {
		await vi.waitFor(() => expect(conversation.session.isBusy).toBe(false));
		await conversation.session.waitForIdle();
	}

	function completedEventId(conversation: HostedConversation): string {
		return `conversation:${conversation.session.sessionId}:${conversation.session.sessionManager.getLeafId()}:completed`;
	}

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
				hostNodeId: TEST_HOST_NODE_ID,
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
				data: { eventId: "event-1", hostNodeId: TEST_HOST_NODE_ID, kind: "conversation_completed" },
			}),
		).resolves.toEqual({ status: "sent" });

		expect(fetcher).toHaveBeenCalledWith(
			"https://push.example.test/v1/notifications",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetcher.mock.calls[0]?.[1];
		if (!init) throw new Error("Expected notification fetch init");
		expect(JSON.parse(String(init.body))).toMatchObject({
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			eventId: "event-1",
			hostNodeId: TEST_HOST_NODE_ID,
		});
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
				hostNodeId: TEST_HOST_NODE_ID,
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
				data: { eventId: "event-1", hostNodeId: TEST_HOST_NODE_ID, kind: "conversation_completed" },
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
			hostNodeId: TEST_HOST_NODE_ID,
			kind: "conversation_completed",
			title: "Volt finished",
			body: "Your conversation is ready.",
			data: { eventId: "event-1", hostNodeId: TEST_HOST_NODE_ID, kind: "conversation_completed" },
		});

		const init = fetcher.mock.calls[0]?.[1];
		expect(init?.headers).toMatchObject({
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
			hostNodeId: TEST_HOST_NODE_ID,
			kind: "conversation_completed",
			title: "Volt finished",
			body: "Your conversation is ready.",
			data: { eventId: "event-1", hostNodeId: TEST_HOST_NODE_ID, kind: "conversation_completed" },
		};

		await client.sendNotification(requestWithClientRelayUrl);

		expect(fetcher).toHaveBeenCalledWith(
			"https://trusted-push.example.test/base/v1/notifications",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetcher.mock.calls[0]?.[1];
		if (!init) throw new Error("Expected notification fetch init");
		expect(fetcher.mock.calls[0]?.[0]).not.toContain("attacker.example.test");
		expect(String(init.body)).not.toContain("attacker.example.test");
	});

	test("register_push_target persists app-issued relay credentials with redacted audit metadata", async () => {
		const { harness, conversation } = await setup();
		const stateManager = createStateManagerWithClient();
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
			now: () => 100,
			relayClient: createRelayClient(),
			stateManager,
		});
		const { phone } = await connectDevice(harness, conversation, {
			services: { pushTargets: { register: (args) => dispatcher.registerPushTarget(args) } },
		});

		// A client-supplied clientNodeId is contract drift: the schema rejects the
		// intent outright, so the untrusted identity can never reach the dispatcher.
		expect(
			await phone.intent("register_push_target", {
				provider: "fcm",
				platform: "ios",
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "secret-target-auth-token",
				enabled: true,
				clientNodeId: "untrusted-client",
			}),
		).toMatchObject({
			type: "rejected",
			reason: { code: "invalid_input", message: expect.stringContaining("clientNodeId") },
		});
		expect((await stateManager.getState()).clients[0].pushTargets).toBeUndefined();

		expect(
			await phone.intent("register_push_target", {
				provider: "fcm",
				platform: "ios",
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "secret-target-auth-token",
				relayUrl: "https://push.example.test",
				tokenHash: hashIrohRemotePushToken("secret-fcm-token"),
				enabled: true,
			}),
		).toMatchObject({ type: "accepted", result: { status: "registered", pushTargetId: "relay-target-1" } });
		const state = await stateManager.getState();
		expect(state.clients[0].pushTargets).toEqual([
			{
				id: "relay-target-1",
				provider: "fcm",
				platform: "ios",
				pushTargetAuthToken: "secret-target-auth-token",
				relayUrl: "https://push.example.test",
				tokenHash: hashIrohRemotePushToken("secret-fcm-token"),
				enabled: true,
				createdAt: 100,
				updatedAt: 100,
			},
		]);
		expect(JSON.stringify(state)).not.toContain("secret-fcm-token");
		expect(JSON.stringify(auditEvents)).not.toContain("secret-target-auth-token");
		expect(JSON.stringify(auditEvents)).not.toContain("secret-fcm-token");
		expect(auditEvents).toContainEqual(
			expect.objectContaining({
				type: "push_target_registered",
				details: expect.objectContaining({ tokenHash: hashIrohRemotePushToken("secret-fcm-token") }),
			}),
		);
		// The device's own stream never echoes the auth token back.
		expect(JSON.stringify(phone.frames)).not.toContain("secret-target-auth-token");
	});

	test("sends conversation completion notifications through the push relay when a target exists", async () => {
		const { harness, conversation } = await setup();
		const stateManager = createStateManagerWithClient([
			createEnabledPushTarget({ relayUrl: "https://attacker.example.test/steal" }),
		]);
		const relayClient = createRelayClient();
		const { phone } = await connectDevice(harness, conversation, {
			notifications: {
				hostNodeId: TEST_HOST_NODE_ID,
				clientNodeId: "paired-client",
				workspaceName: "volt-app",
				delivery: createDispatcher(relayClient, stateManager),
			},
		});

		await prompt(phone, "hello");
		await idle(conversation);
		const eventId = completedEventId(conversation);
		const sessionId = conversation.session.sessionId;
		const expectedNotification: IrohRemotePushRelayNotificationRequest = {
			pushTargetId: "relay-target-1",
			pushTargetAuthToken: "relay-target-auth-token",
			eventId,
			hostNodeId: TEST_HOST_NODE_ID,
			kind: "conversation_completed",
			title: "Volt finished in volt-app",
			body: "Your conversation is ready.",
			workspaceName: "volt-app",
			data: {
				eventId,
				hostNodeId: TEST_HOST_NODE_ID,
				kind: "conversation_completed",
				sessionId,
				workspaceName: "volt-app",
			},
		};
		await vi.waitFor(() => expect(relayClient.sendNotification).toHaveBeenCalledWith(expectedNotification));
		expect(relayClient.sendNotification).toHaveBeenCalledTimes(1);
		// Push only: the phone's stream carries no notification frames.
		expect(phone.frames.map((frame) => frame.type)).not.toContain("notification_request");
	});

	test("emits plan-ready instead of generic completion and preserves equivalent push metadata", async () => {
		const { harness, conversation } = await setup();
		let planning: PlanningState = {
			mode: "plan",
			plan: { id: "plan-one", revision: 1, phase: "draft", steps: [] },
		};
		vi.spyOn(conversation.session, "getPlanningState").mockImplementation(() => planning);
		harness.faux.setResponses([
			() => {
				planning = {
					mode: "plan",
					plan: {
						id: "plan-one",
						revision: 2,
						phase: "ready",
						title: `${"🚀".repeat(100)}\n/Users/private/project\ngit diff HEAD`,
						steps: [],
					},
				};
				return fauxAssistantMessage("Here is the plan.");
			},
		]);
		const stateManager = createStateManagerWithClient([createEnabledPushTarget()]);
		const relayClient = createRelayClient();
		const { phone } = await connectDevice(harness, conversation, {
			notifications: {
				hostNodeId: TEST_HOST_NODE_ID,
				clientNodeId: "paired-client",
				workspaceName: "volt-app",
				delivery: createDispatcher(relayClient, stateManager),
			},
		});

		await prompt(phone, "make a plan");
		await idle(conversation);
		const sessionId = conversation.session.sessionId;
		const eventId = `plan:${sessionId}:${conversation.session.sessionManager.getLeafId()}:ready`;
		await vi.waitFor(() =>
			expect(relayClient.sendNotification).toHaveBeenCalledWith({
				pushTargetId: "relay-target-1",
				pushTargetAuthToken: "relay-target-auth-token",
				eventId,
				hostNodeId: TEST_HOST_NODE_ID,
				kind: "plan_ready",
				title: "Your plan is ready",
				body: "Open Volt to review and approve it.",
				workspaceName: "volt-app",
				planId: "plan-one",
				data: {
					eventId,
					hostNodeId: TEST_HOST_NODE_ID,
					kind: "plan_ready",
					sessionId,
					workspaceName: "volt-app",
					planId: "plan-one",
				},
			}),
		);
		expect(relayClient.sendNotification).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "conversation_completed" }),
		);
		const pushed = JSON.stringify(vi.mocked(relayClient.sendNotification).mock.calls);
		expect(pushed).not.toContain("Users/private");
		expect(pushed).not.toContain("git diff");
	});

	test("sends failure notice instead of completion notification when a prompt ends with an assistant error", async () => {
		const { harness, conversation } = await setup();
		harness.faux.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "auth", retryable: false, message: "No API key for provider: openai-codex" },
			}),
		]);
		const stateManager = createStateManagerWithClient([
			createEnabledPushTarget({ relayUrl: "https://attacker.example.test/steal" }),
		]);
		const relayClient = createRelayClient();
		const { phone } = await connectDevice(harness, conversation, {
			notifications: {
				hostNodeId: TEST_HOST_NODE_ID,
				clientNodeId: "paired-client",
				workspaceName: "volt-app",
				delivery: createDispatcher(relayClient, stateManager),
			},
		});

		await prompt(phone, "hello");
		await idle(conversation);
		await vi.waitFor(() =>
			expect(relayClient.sendNotification).toHaveBeenCalledWith(
				expect.objectContaining({
					eventId: `conversation:${conversation.session.sessionId}:${conversation.session.sessionManager.getLeafId()}:failed`,
					hostNodeId: TEST_HOST_NODE_ID,
					kind: "host_notice",
					title: "Volt needs attention in volt-app",
					body: "Open Volt to view the error.",
				}),
			),
		);
		expect(relayClient.sendNotification).not.toHaveBeenCalledWith(
			expect.objectContaining({ kind: "conversation_completed" }),
		);
		expect(JSON.stringify(vi.mocked(relayClient.sendNotification).mock.calls)).not.toContain("No API key");
	});

	test("does not send a completion notification when a prompt is aborted", async () => {
		const { harness, conversation } = await setup();
		harness.faux.setResponses([fauxAssistantMessage("", { stopReason: "aborted" }), fauxAssistantMessage("done")]);
		const delivery = recordingDelivery();
		const { phone } = await connectDevice(harness, conversation, {
			notifications: { hostNodeId: TEST_HOST_NODE_ID, clientNodeId: "paired-client", delivery },
		});

		await prompt(phone, "hello");
		await idle(conversation);
		// A later run's notification is pushed after anything the aborted run would have pushed.
		await prompt(phone, "again");
		await idle(conversation);
		const completed = completedEventId(conversation);
		await vi.waitFor(() =>
			expect(delivery.delivered.map((notification) => notification.eventId)).toContain(completed),
		);
		expect(delivery.delivered).toEqual([
			expect.objectContaining({ eventId: completed, kind: "conversation_completed" }),
		]);
	});

	test("sends push completion notification when the accepted prompt outcome cannot be written", async () => {
		const { harness, conversation } = await setup();
		const stateManager = createStateManagerWithClient([createEnabledPushTarget()]);
		const relayClient = createRelayClient();
		const failAccepted = (stream: IrohBiStreamLike): IrohBiStreamLike => ({
			recv: stream.recv,
			send: {
				writeAll: async (bytes) => {
					if (Buffer.from(bytes).toString("utf8").includes('"type":"accepted"')) throw new Error("send closed");
					await stream.send.writeAll(bytes);
				},
				finish: async () => stream.send.finish?.(),
				reset: (errorCode) => stream.send.reset?.(errorCode),
			},
		});
		const { phone, connection } = await connectDevice(harness, conversation, {
			stream: failAccepted,
			notifications: {
				hostNodeId: TEST_HOST_NODE_ID,
				clientNodeId: "paired-client",
				delivery: createDispatcher(relayClient, stateManager),
			},
		});

		phone.send({
			type: "prompt",
			intentId: "prompt-1",
			expectedOrdinal: phone.position(),
			input: { message: "hello" },
		});
		await expect(connection.closed).rejects.toThrow("send closed");
		await idle(conversation);
		await vi.waitFor(() =>
			expect(relayClient.sendNotification).toHaveBeenCalledWith(
				expect.objectContaining({
					eventId: completedEventId(conversation),
					hostNodeId: TEST_HOST_NODE_ID,
					kind: "conversation_completed",
				}),
			),
		);
	});

	test("disables push targets reported invalid by the relay", async () => {
		const { harness, conversation } = await setup();
		const stateManager = createStateManagerWithClient([createEnabledPushTarget()]);
		const relayClient = createRelayClient({
			sendNotification: vi.fn(async () => ({ status: "invalid_target" as const })),
		});
		const { phone } = await connectDevice(harness, conversation, {
			notifications: {
				hostNodeId: TEST_HOST_NODE_ID,
				clientNodeId: "paired-client",
				delivery: new IrohRemotePushNotificationDispatcher({
					clientNodeId: "paired-client",
					now: () => 500,
					relayClient,
					retryDelayMs: 0,
					stateManager,
				}),
			},
		});

		await prompt(phone, "hello");
		await vi.waitFor(async () => {
			const state = await stateManager.getState();
			expect(state.clients[0].pushTargets?.[0]).toMatchObject({ enabled: false, updatedAt: 500 });
		});
		expect(relayClient.sendNotification).toHaveBeenCalledOnce();
	});

	test("audits a notification it skips because the device has no enabled push target", async () => {
		const auditEvents: object[] = [];
		const relayClient = createRelayClient();
		const dispatcher = new IrohRemotePushNotificationDispatcher({
			auditLogger: new IrohRemoteAuditLogger({ sink: { write: (event) => void auditEvents.push(event) } }),
			clientNodeId: "paired-client",
			relayClient,
			stateManager: createStateManagerWithClient(),
		});
		const notification: IrohRemotePushNotificationIntent = {
			eventId: "event-1",
			hostNodeId: TEST_HOST_NODE_ID,
			kind: "conversation_completed",
			sessionId: "session-1",
			title: "Volt",
			body: "Done",
		};

		await expect(dispatcher.deliverNotification(notification)).resolves.toBe("no_push_target");
		await vi.waitFor(() =>
			expect(auditEvents).toContainEqual(
				expect.objectContaining({
					type: "push_notification_skipped",
					success: true,
					details: { eventId: "event-1", kind: "conversation_completed", reason: "no_push_target" },
				}),
			),
		);
		expect(relayClient.sendNotification).not.toHaveBeenCalled();
	});

	test("emits one completion notification per prompt run", async () => {
		const { harness, conversation } = await setup();
		const delivery = recordingDelivery();
		const { phone } = await connectDevice(harness, conversation, {
			notifications: { hostNodeId: TEST_HOST_NODE_ID, clientNodeId: "paired-client", delivery },
		});
		const sessionId = conversation.session.sessionId;

		await prompt(phone, "hello");
		await idle(conversation);
		const first = completedEventId(conversation);
		await vi.waitFor(() => expect(delivery.delivered).toHaveLength(1));
		await prompt(phone, "hello again");
		await idle(conversation);
		const second = completedEventId(conversation);
		await vi.waitFor(() => expect(delivery.delivered).toHaveLength(2));

		expect(first).not.toBe(second);
		expect(delivery.delivered).toEqual([
			{
				eventId: first,
				hostNodeId: TEST_HOST_NODE_ID,
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
				sessionId,
			},
			{
				eventId: second,
				hostNodeId: TEST_HOST_NODE_ID,
				kind: "conversation_completed",
				title: "Volt finished",
				body: "Your conversation is ready.",
				sessionId,
			},
		]);
	});

	test("does not push an event a device already received when its streams reattach", async () => {
		const { harness, conversation } = await setup();
		const stateManager = createStateManagerWithClient([createEnabledPushTarget()]);
		const relayClient = createRelayClient();
		const notifications = {
			hostNodeId: TEST_HOST_NODE_ID,
			clientNodeId: "paired-client",
			delivery: createDispatcher(relayClient, stateManager),
		};
		const first = await connectDevice(harness, conversation, { notifications });
		await prompt(first.phone, "hello");
		await idle(conversation);
		startTestReview(conversation, "review:once", "PR #7").finish(completedReview(0));
		await vi.waitFor(() => expect(relayClient.sendNotification).toHaveBeenCalledTimes(2));
		await first.connection.close();

		// The device's next stream shares its delivery history: neither event is pushed again.
		await connectDevice(harness, conversation, { notifications });
		startTestReview(conversation, "review:later", "PR #8").finish(completedReview(1));
		await vi.waitFor(() =>
			expect(relayClient.sendNotification).toHaveBeenCalledWith(
				expect.objectContaining({ eventId: "review:later:completed" }),
			),
		);
		expect(vi.mocked(relayClient.sendNotification).mock.calls.map(([request]) => request.eventId)).toEqual([
			completedEventId(conversation),
			"review:once:completed",
			"review:later:completed",
		]);
	});

	test("does not push reviews that finished before the device first attached", async () => {
		const { harness, conversation } = await setup();
		startTestReview(conversation, "review:earlier", "PR #5").finish(completedReview(1));
		await vi.waitFor(() => expect(conversation.work.get("review:earlier")?.outcome).toBe("completed"));
		const delivery = recordingDelivery();
		await connectDevice(harness, conversation, {
			notifications: { hostNodeId: TEST_HOST_NODE_ID, clientNodeId: "paired-client", delivery },
		});
		startTestReview(conversation, "review:later", "PR #6").finish(completedReview(0));
		await vi.waitFor(() => expect(delivery.delivered).toHaveLength(1));
		expect(delivery.delivered[0]).toMatchObject({ eventId: "review:later:completed", workId: "review:later" });
	});

	test("formats complete and incomplete review results from finished review work", async () => {
		const { harness, conversation } = await setup();
		const delivery = recordingDelivery();
		await connectDevice(harness, conversation, {
			notifications: { hostNodeId: TEST_HOST_NODE_ID, clientNodeId: "paired-client", delivery },
		});
		const completions: Array<[string, ExecuteReviewWorkflowResult]> = [
			["review:zero", completedReview(0)],
			["review:one", completedReview(1)],
			["review:many", completedReview(4)],
			["review:incomplete", completedReview(0, "incomplete")],
		];
		for (const [index, [workId, result]] of completions.entries()) {
			startTestReview(conversation, workId, "PR #123").finish(result);
			await vi.waitFor(() => expect(delivery.delivered).toHaveLength(index + 1));
		}

		expect(delivery.delivered.map((notification) => notification.body)).toEqual([
			"PR #123 completed with no issues found.",
			"PR #123 completed with 1 finding.",
			"PR #123 completed with 4 findings.",
			"PR #123 review is incomplete.",
		]);
		expect(delivery.delivered.map((notification) => notification.workId)).toEqual([
			"review:zero",
			"review:one",
			"review:many",
			"review:incomplete",
		]);
		expect(delivery.delivered[0]).toEqual({
			eventId: "review:zero:completed",
			hostNodeId: TEST_HOST_NODE_ID,
			kind: "work_finished",
			title: "Your review is ready",
			body: "PR #123 completed with no issues found.",
			sessionId: conversation.session.sessionId,
			workId: "review:zero",
			workKind: "review",
		});
	});

	test("omits malicious review targets and cancelled reviews from lock-screen delivery", async () => {
		const { harness, conversation } = await setup();
		const delivery = recordingDelivery();
		await connectDevice(harness, conversation, {
			notifications: { hostNodeId: TEST_HOST_NODE_ID, clientNodeId: "paired-client", delivery },
		});
		const privateContextResult = completedReview(2);
		if (privateContextResult.status !== "completed") throw new Error("Expected a completed review fixture");
		privateContextResult.parsed.summary = "PRIVATE_LINKED_ISSUE_AND_REVIEW_TEXT";
		privateContextResult.parsed.coverage.context = {
			captureStatus: "complete",
			linkedIssueCount: 2,
			discussionEntryCount: 5,
			limitationCodes: [],
			fingerprint: "e".repeat(64),
			discoveryInspectionComplete: true,
			verificationInspectionComplete: true,
		};
		startTestReview(
			conversation,
			"review:malicious",
			`${"PR #123".repeat(100)}\n/Users/private/project\ngit diff HEAD`,
		).finish(privateContextResult);
		await vi.waitFor(() => expect(delivery.delivered).toHaveLength(1));
		expect(delivery.delivered[0]).toMatchObject({
			body: "Review completed with 2 findings.",
			workId: "review:malicious",
		});
		expect(JSON.stringify(delivery.delivered)).not.toContain("Users/private");
		expect(JSON.stringify(delivery.delivered)).not.toContain("git diff");
		expect(JSON.stringify(delivery.delivered)).not.toContain("PRIVATE_LINKED_ISSUE_AND_REVIEW_TEXT");

		startTestReview(conversation, "review:cancelled").finish({ status: "cancelled" });
		await vi.waitFor(() => expect(conversation.work.get("review:cancelled")?.outcome).toBe("cancelled"));
		// A later completion is pushed after anything the cancelled review would have pushed.
		startTestReview(conversation, "review:after").finish(completedReview(0));
		await vi.waitFor(() => expect(delivery.delivered).toHaveLength(2));
		expect(delivery.delivered.map((notification) => notification.workId)).toEqual([
			"review:malicious",
			"review:after",
		]);
	});

	test("retries a review completion whose push failed when the device reconnects, and never repeats a delivered one", async () => {
		const { harness, conversation } = await setup();
		const unreachable = recordingDelivery(() => "failed");
		const first = await connectDevice(harness, conversation, {
			notifications: { hostNodeId: TEST_HOST_NODE_ID, clientNodeId: "paired-client", delivery: unreachable },
		});
		const review = startTestReview(conversation, "review:reconnect", "PR #151");
		await first.connection.close();
		review.finish(completedReview(0));
		await vi.waitFor(() => expect(conversation.work.get("review:reconnect")?.outcome).toBe("completed"));
		await vi.waitFor(() => expect(unreachable.deliverNotification).toHaveBeenCalledOnce());

		const reachable = recordingDelivery();
		await connectDevice(harness, conversation, {
			notifications: { hostNodeId: TEST_HOST_NODE_ID, clientNodeId: "paired-client", delivery: reachable },
		});
		await vi.waitFor(() =>
			expect(reachable.delivered).toEqual([
				{
					eventId: "review:reconnect:completed",
					hostNodeId: TEST_HOST_NODE_ID,
					kind: "work_finished",
					title: "Your review is ready",
					body: "PR #151 completed with no issues found.",
					sessionId: conversation.session.sessionId,
					workId: "review:reconnect",
					workKind: "review",
				},
			]),
		);

		const third = recordingDelivery();
		await connectDevice(harness, conversation, {
			notifications: { hostNodeId: TEST_HOST_NODE_ID, clientNodeId: "paired-client", delivery: third },
		});
		startTestReview(conversation, "review:next").finish(completedReview(1));
		await vi.waitFor(() => expect(third.delivered).toHaveLength(1));
		expect(third.delivered[0]).toMatchObject({ eventId: "review:next:completed" });
		expect(reachable.delivered).toHaveLength(1);
	});

	test("emits one review completion notification after a remote review's work completes", async () => {
		const { harness, conversation } = await setup();
		const delivery = recordingDelivery();
		const { phone } = await connectDevice(harness, conversation, {
			notifications: { hostNodeId: TEST_HOST_NODE_ID, clientNodeId: "paired-client", delivery },
		});

		expect(await phone.intent("review_uncommitted", {})).toMatchObject({
			type: "accepted",
			result: { workId: "review:test" },
		});
		await vi.waitFor(() =>
			expect(delivery.delivered).toEqual([
				{
					eventId: "review:test:completed",
					hostNodeId: TEST_HOST_NODE_ID,
					kind: "work_finished",
					title: "Your review is ready",
					body: "uncommitted changes completed with 1 finding.",
					sessionId: conversation.session.sessionId,
					workId: "review:test",
					workKind: "review",
				},
			]),
		);
		expect(reviewMocks.executeReviewWorkflow).toHaveBeenCalledOnce();
		// The detached review never moves the client to another conversation.
		expect(harness.host.list()).toEqual([conversation]);
		expect(conversation.closed).toBe(false);
	});
});

describe("Iroh remote transcript views", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function subscribedPhone(): Promise<{ conversation: HostedConversation; phone: RemotePhone }> {
		const harness = await createHostHarness({ whenUnattached: "keep" });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: GRANT,
			redaction: { workspacePath: conversation.cwd },
			redirect: {},
		});
		void connection.closed.catch(() => undefined);
		const phone = connectRemotePhone(pair.phone);
		cleanups.push(async () => {
			await connection.close().catch(() => undefined);
			await phone.close();
		});
		await phone.hello();
		await phone.subscribe(conversation.id);
		return { conversation, phone };
	}

	test("streams displayed review custom messages as assistant transcript entries", async () => {
		const { conversation, phone } = await subscribedPhone();
		const id = await conversation.session.sessionWriter.appendMessage({
			role: "custom",
			customType: "review",
			content: [{ type: "text", text: "Review findings" }],
			display: true,
			timestamp: 1,
		});

		const entry = await entryOf(phone, id);
		expect(entry).not.toHaveProperty("payload");
		expect("view" in entry ? entry.view : undefined).toEqual({
			role: "assistant",
			text: "Review findings",
			truncated: false,
		});
	});

	test("streams assistant transcript entries with preserved Markdown formatting", async () => {
		const { conversation, phone } = await subscribedPhone();
		const formattedText =
			"Here is the plan:\n\n- Keep Markdown lists\n- Preserve code fences\n\n```swift\nlet value = 1\n```";
		const id = await conversation.session.sessionWriter.appendMessage(fauxAssistantMessage(formattedText));

		const entry = await entryOf(phone, id);
		expect("view" in entry ? entry.view : undefined).toMatchObject({
			role: "assistant",
			text: formattedText,
			truncated: false,
			parts: [{ type: "text", text: formattedText, truncated: false }],
		});
		expect(JSON.stringify(phone.frames)).not.toContain(
			"Here is the plan: - Keep Markdown lists - Preserve code fences",
		);
	});

	test("streams assistant transcript entries with canonical text across multiple text parts", async () => {
		const { conversation, phone } = await subscribedPhone();
		const id = await conversation.session.sessionWriter.appendMessage(
			fauxAssistantMessage([
				{ type: "text", text: "Here is a plan:\n- Step one" },
				{ type: "text", text: "\n- Step two\n```swift\n\tlet value = 1\n```" },
			]),
		);

		const entry = await entryOf(phone, id);
		expect("view" in entry ? entry.view : undefined).toMatchObject({
			role: "assistant",
			text: ["Here is a plan:", "- Step one", "- Step two", "```swift", "\tlet value = 1", "```"].join("\n"),
			truncated: false,
			parts: [
				{ type: "text", text: "Here is a plan:\n- Step one", truncated: false },
				{ type: "text", text: "\n- Step two\n```swift\n\tlet value = 1\n```", truncated: false },
			],
		});
	});

	test("streams completed tool transcript entries with projected metadata and redacted paths", async () => {
		const { conversation, phone } = await subscribedPhone();
		const file = join(conversation.cwd, "src", "index.ts");
		const writer = conversation.session.sessionWriter;
		await writer.appendMessage(
			fauxAssistantMessage(
				[
					fauxToolCall("bash", { command: `pwd && cat ${file}`, timeout: 5 }, { id: "bash-call" }),
					fauxToolCall("read", { path: file, offset: 3 }, { id: "read-call" }),
					fauxToolCall("subagent_registry", { list: true, cursor: 50 }, { id: "registry-call" }),
					fauxToolCall("subagent_registry", { follow: "sa_existing" }, { id: "follow-call" }),
				],
				{ stopReason: "toolUse" },
			),
		);
		const result = (
			toolCallId: string,
			toolName: string,
			text: string,
			details?: Record<string, unknown>,
		): ToolResultMessage => ({
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			...(details === undefined ? {} : { details }),
			isError: false,
			timestamp: 2,
		});
		const bashId = await writer.appendMessage(result("bash-call", "bash", "private output"));
		const readId = await writer.appendMessage(result("read-call", "read", "private file contents"));
		const registryId = await writer.appendMessage(
			result("registry-call", "subagent_registry", "bounded registry page", {
				mode: "list",
				status: "completed",
				summary: { total: 120, returned: 50, nextCursor: 20 },
			}),
		);
		const followId = await writer.appendMessage(
			result("follow-call", "subagent_registry", "existing result", {
				mode: "follow",
				status: "completed",
				subagentId: "sa_existing",
				agent: { name: "researcher", source: "built-in" },
			}),
		);

		const view = async (id: string) => {
			const entry = await entryOf(phone, id);
			return "view" in entry ? entry.view : undefined;
		};
		expect(await view(bashId)).toMatchObject({
			role: "tool",
			toolName: "bash",
			status: "completed",
			summary: "Ran command: pwd && cat /workspace/src/index.ts (completed)",
			args: { command: "pwd && cat /workspace/src/index.ts", timeout: 5 },
			output: "private output",
			outputTruncated: false,
		});
		expect(await view(readId)).toMatchObject({
			role: "tool",
			toolName: "read",
			status: "completed",
			path: "/workspace/src/index.ts",
			args: { path: "/workspace/src/index.ts", offset: 3 },
			output: "private file contents",
			outputTruncated: false,
		});
		expect(await view(registryId)).toMatchObject({
			role: "tool",
			toolName: "subagent_registry",
			status: "completed",
			args: { list: true, cursor: 50 },
			details: {
				mode: "list",
				status: "completed",
				summary: { total: 120, returned: 50, nextCursor: 20 },
			},
			output: "bounded registry page",
			outputTruncated: false,
		});
		expect(await view(followId)).toMatchObject({
			role: "tool",
			toolName: "subagent_registry",
			status: "completed",
			args: { follow: "sa_existing" },
			details: {
				mode: "follow",
				status: "completed",
				subagentId: "sa_existing",
				agent: { name: "researcher", source: "built-in" },
			},
			output: "existing result",
			outputTruncated: false,
		});
		expect(JSON.stringify(phone.frames)).not.toContain(conversation.cwd);
	});

	test("streams tool transcript entries advertising imageCount without inline image data", async () => {
		const { conversation, phone } = await subscribedPhone();
		const writer = conversation.session.sessionWriter;
		await writer.appendMessage(
			fauxAssistantMessage(
				fauxToolCall("read", { path: join(conversation.cwd, "logo.png") }, { id: "image-call" }),
				{
					stopReason: "toolUse",
				},
			),
		);
		const id = await writer.appendMessage({
			role: "toolResult",
			toolCallId: "image-call",
			toolName: "read",
			content: [
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" },
			],
			isError: false,
			timestamp: 2,
		});

		const entry = await entryOf(phone, id);
		expect("view" in entry ? entry.view : undefined).toMatchObject({
			role: "tool",
			toolName: "read",
			status: "completed",
			imageCount: 1,
		});
		// Transcript frames stay text-only; the blocks are fetched per entry with the `content` query.
		expect(JSON.stringify(phone.frames)).not.toContain("aW1hZ2UtYnl0ZXM=");
	});
});
