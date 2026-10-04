import { describe, expect, test, vi } from "vitest";
import { createLoopbackRpcTransportPair } from "../src/core/rpc/loopback-transport.ts";
import { runLegacyRemoteRpcMode } from "../src/modes/rpc/legacy-remote-rpc-mode.ts";
import {
	createTestConversation,
	createTestModel,
	createTestSession,
	getCurrentConversationAuthority,
	parseWrittenObjects,
	startIrohRpcMode,
	withCurrentConversationAuthority,
} from "./iroh-stream-doubles.ts";
import { createFakeConversation, createFakeHost } from "./utilities/fake-conversation-host.ts";

// Structural intents are not under test here: they answer cancelled once a command passes its authority check.
vi.mock("../src/core/host/session-intents.ts", () => ({
	openFork: vi.fn(async () => ({ cancelled: true })),
	openImport: vi.fn(async () => ({ cancelled: true })),
	openNewSession: vi.fn(async () => ({ cancelled: true })),
	openStoredSession: vi.fn(async () => ({ cancelled: true })),
	openStoredSessionById: vi.fn(async () => ({ cancelled: true })),
}));

describe("conversation mutation authority", () => {
	test("requires the exact current tuple for every remote conversation mutation", async () => {
		const session = createTestSession("session-one", null);
		const abort = vi.fn(async () => {});
		const steer = vi.fn(async () => {});
		const followUp = vi.fn(async () => {});
		const setModel = vi.fn(async () => {});
		const setThinkingLevel = vi.fn();
		Object.assign(session, {
			abort,
			followUp,
			modelRegistry: {
				authStorage: {},
				getAvailable: vi.fn(async () => [createTestModel("model")]),
			},
			setModel,
			setThinkingLevel,
			steer,
		});
		const target = createTestConversation(session);
		const { modePromise, recv, send } = await startIrohRpcMode(target, session);
		const authority = getCurrentConversationAuthority(send);

		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "exact-prompt",
					type: "prompt",
					clientMessageId: "exact-client-prompt",
					message: "exact",
				}),
			),
		);
		await vi.waitFor(() => {
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({ id: "exact-prompt", command: "prompt", success: true }),
			);
		});
		const exactCommands = [
			{ id: "exact-steer", type: "steer", clientMessageId: "exact-client-steer", message: "steer" },
			{
				id: "exact-follow-up",
				type: "follow_up",
				clientMessageId: "exact-client-follow-up",
				message: "follow up",
			},
			{ id: "exact-abort", type: "abort" },
			{ id: "exact-new", type: "new_session" },
			{ id: "exact-switch", type: "switch_session_by_id", sessionId: "other-session" },
			{ id: "exact-model", type: "set_model", provider: "anthropic", modelId: "model" },
			{ id: "exact-thinking", type: "set_thinking_level", level: "low" },
			{ id: "exact-action", type: "invoke_ui_action", action: "session.new" },
		];
		for (const command of exactCommands) {
			recv.pushLine(JSON.stringify({ ...command, conversationAuthority: authority }));
		}
		await vi.waitFor(() => {
			const responses = parseWrittenObjects(send).filter((record) => record.type === "response");
			for (const command of exactCommands) {
				expect(responses).toContainEqual(expect.objectContaining({ id: command.id, success: true }));
			}
		});

		const missingAuthorityCommands = [
			{ id: "missing-prompt", type: "prompt", clientMessageId: "missing-client-prompt", message: "prompt" },
			{ id: "missing-steer", type: "steer", clientMessageId: "missing-client-steer", message: "steer" },
			{
				id: "missing-follow-up",
				type: "follow_up",
				clientMessageId: "missing-client-follow-up",
				message: "follow up",
			},
			{ id: "missing-abort", type: "abort" },
			{ id: "missing-new", type: "new_session" },
			{ id: "missing-switch", type: "switch_session_by_id", sessionId: "other-session" },
			{ id: "missing-model", type: "set_model", provider: "anthropic", modelId: "model" },
			{ id: "missing-thinking", type: "set_thinking_level", level: "low" },
			{ id: "missing-action", type: "invoke_ui_action", action: "session.new" },
			{ id: "missing-review-ack", type: "acknowledge_review", runId: "review:test" },
		];
		for (const command of missingAuthorityCommands) {
			recv.pushLine(JSON.stringify(command));
		}

		for (const [field, value] of [
			["sessionId", "stale-session"],
			["subscriptionId", "stale-subscription"],
			["branchEpoch", "stale-branch"],
		] as const) {
			recv.pushLine(
				JSON.stringify({
					id: `mismatch-${field}`,
					type: "prompt",
					clientMessageId: `mismatch-client-${field}`,
					message: "stale",
					conversationAuthority: { ...authority, [field]: value },
				}),
			);
		}
		recv.pushLine(
			JSON.stringify({
				id: "malformed-authority",
				type: "abort",
				conversationAuthority: { ...authority, extra: "field" },
			}),
		);

		await vi.waitFor(() => {
			const responses = parseWrittenObjects(send).filter((record) => record.type === "response");
			for (const command of missingAuthorityCommands) {
				expect(responses).toContainEqual(
					expect.objectContaining({
						id: command.id,
						success: false,
						errorCode: "stale_conversation_authority",
					}),
				);
			}
			for (const field of ["sessionId", "subscriptionId", "branchEpoch"]) {
				expect(responses).toContainEqual(
					expect.objectContaining({
						id: `mismatch-${field}`,
						success: false,
						errorCode: "stale_conversation_authority",
					}),
				);
			}
			expect(responses).toContainEqual(
				expect.objectContaining({
					id: "malformed-authority",
					success: false,
					error: expect.stringContaining("must contain exactly"),
				}),
			);
		});
		expect(session.prompt).toHaveBeenCalledTimes(1);
		expect(steer).toHaveBeenCalledOnce();
		expect(followUp).toHaveBeenCalledOnce();
		expect(abort).toHaveBeenCalledOnce();
		expect(setModel).toHaveBeenCalledOnce();
		expect(setThinkingLevel).toHaveBeenCalledOnce();

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("revalidates authority after asynchronous model lookup before mutating the branch", async () => {
		const session = createTestSession("model-race", null);
		let releaseModels = () => {};
		const modelsRelease = new Promise<void>((resolve) => {
			releaseModels = resolve;
		});
		let notifyModelsStarted = () => {};
		const modelsStarted = new Promise<void>((resolve) => {
			notifyModelsStarted = resolve;
		});
		const setModel = vi.fn(async () => {});
		Object.assign(session, {
			modelRegistry: {
				authStorage: {},
				getAvailable: vi.fn(async () => {
					notifyModelsStarted();
					await modelsRelease;
					return [createTestModel("target-model")];
				}),
			},
			setModel,
		});
		const target = createTestConversation(session);
		const { modePromise, recv, send } = await startIrohRpcMode(target, session);
		recv.pushLine(
			JSON.stringify(
				withCurrentConversationAuthority(send, {
					id: "model-race",
					type: "set_model",
					provider: "anthropic",
					modelId: "target-model",
				}),
			),
		);
		await modelsStarted;
		target.conversation.projectionFeed.rotateForBranchRebase();
		releaseModels();

		await vi.waitFor(() => {
			expect(parseWrittenObjects(send)).toContainEqual(
				expect.objectContaining({
					id: "model-race",
					success: false,
					errorCode: "stale_conversation_authority",
				}),
			);
		});
		expect(setModel).not.toHaveBeenCalled();

		recv.end();
		await expect(modePromise).resolves.toBeUndefined();
	});

	test("keeps transport-neutral local RPC prompts compatible without authority", async () => {
		const session = createTestSession("local-session", null);
		const target = createTestConversation(session);
		const pair = createLoopbackRpcTransportPair();
		const received: Array<Record<string, unknown>> = [];
		pair.client.onValue?.((value) => {
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				received.push(value as Record<string, unknown>);
			}
		});
		const modePromise = runLegacyRemoteRpcMode(target.host, target.conversation, {
			anchor: false,
			exitProcess: false,
			transport: pair.server,
		});
		await vi.waitFor(() => expect(session.attachExtensionClient).toHaveBeenCalledOnce());
		pair.client.write({
			id: "local-prompt",
			type: "prompt",
			clientMessageId: "local-client-prompt",
			message: "local",
		});
		await vi.waitFor(() => {
			expect(received).toContainEqual(
				expect.objectContaining({ id: "local-prompt", command: "prompt", success: true }),
			);
		});
		expect(session.prompt).toHaveBeenCalledOnce();
		pair.client.close();
		await expect(modePromise).resolves.toBeUndefined();
	});
});

describe("host requests across conversation authority cuts", () => {
	test("keeps dialogs and approvals pending across branch and authority cuts and with their conversation on a move", async () => {
		const makeSession = (sessionId: string) => {
			const generationListeners = new Set<() => void>();
			const session = Object.assign(createTestSession(sessionId, null), {
				subscribeConversationGenerationChanges(listener: () => void) {
					generationListeners.add(listener);
					return () => generationListeners.delete(listener);
				},
			});
			return { session, generationListeners };
		};

		const old = makeSession("control-old");
		const replacement = makeSession("control-new");
		const fake = createFakeHost();
		const oldConversation = createFakeConversation(old.session).conversation;
		const replacementConversation = createFakeConversation(replacement.session).conversation;
		const pair = createLoopbackRpcTransportPair();
		const received: Array<Record<string, unknown>> = [];
		pair.client.onValue?.((value) => {
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				received.push(value as Record<string, unknown>);
			}
		});
		const modePromise = runLegacyRemoteRpcMode(fake.host, oldConversation, {
			anchor: false,
			exitProcess: false,
			orderedConversation: {
				subscriptionId: "control-subscription",
				branchEpoch: "control-branch",
				async enqueueControl(value) {
					received.push(value as Record<string, unknown>);
				},
				requestCheckpoint(command) {
					return {
						subscriptionId: "control-subscription",
						requestId: command.id,
						checkpointCursor: 1,
					};
				},
				publishExternal() {},
			},
			transport: pair.server,
		});
		await vi.waitFor(() => expect(old.session.attachExtensionClient).toHaveBeenCalledOnce());
		pair.client.write({
			id: "capabilities",
			type: "set_client_capabilities",
			features: ["host_action_requests.v1"],
		});
		await vi.waitFor(() =>
			expect(received).toContainEqual(expect.objectContaining({ id: "capabilities", success: true })),
		);

		/** An extension dialog and an approval in the old conversation, as the client sees them. */
		const startControls = async (suffix: string) => {
			const liveState = oldConversation.liveState;
			const extensionResult = liveState.request({
				kind: "confirm",
				title: `Confirm ${suffix}`,
				message: "Proceed?",
			});
			const hostResult = liveState.hostInteraction.requestAction({
				id: `host-${suffix}`,
				action: "test.action",
				title: `Host ${suffix}`,
			});
			await vi.waitFor(() => {
				expect(received).toContainEqual(
					expect.objectContaining({ type: "extension_ui_request", method: "confirm", title: `Confirm ${suffix}` }),
				);
				expect(received).toContainEqual(
					expect.objectContaining({ type: "host_action_request", id: `host-${suffix}` }),
				);
			});
			const extensionRequest = received
				.slice()
				.reverse()
				.find((record) => record.type === "extension_ui_request" && record.title === `Confirm ${suffix}`);
			if (typeof extensionRequest?.id !== "string") throw new Error("Missing extension request id");
			return { extensionRequestId: extensionRequest.id, extensionResult, hostResult };
		};

		// A branch change commits entries; it never drops a pending dialog or approval (RFC §6.1).
		const branchControls = await startControls("branch");
		for (const listener of old.generationListeners) listener();
		pair.client.write({
			type: "extension_ui_response",
			id: branchControls.extensionRequestId,
			confirmed: true,
		});
		pair.client.write({ type: "host_action_response", id: "host-branch", decision: "approved" });
		await expect(branchControls.extensionResult).resolves.toMatchObject({
			status: "answered",
			response: { confirmed: true },
		});
		await expect(branchControls.hostResult).resolves.toEqual({ decision: "approved" });

		// The client moves to another conversation, as one of its structural intents does. The
		// requests stay with the conversation that asked them, which other clients keep open.
		const rebindControls = await startControls("rebind");
		const client = fake.clientOf(oldConversation);
		if (!client) throw new Error("The RPC client is not attached");
		await fake.move(client, replacementConversation);
		expect(replacement.session.attachExtensionClient).toHaveBeenCalledOnce();
		// Its answers now go to the conversation it is on, which asked nothing.
		pair.client.write({
			type: "extension_ui_response",
			id: rebindControls.extensionRequestId,
			confirmed: true,
		});
		pair.client.write({ type: "host_action_response", id: "host-rebind", decision: "approved" });
		pair.client.write({ id: "pending-after-move", type: "get_pending_host_actions" });
		await vi.waitFor(() => {
			expect(received).toContainEqual(
				expect.objectContaining({
					id: "pending-after-move",
					success: true,
					data: { actions: [] },
				}),
			);
		});
		expect(oldConversation.liveState.pendingRequests().map((pending) => pending.requestId)).toEqual([
			rebindControls.extensionRequestId,
			"host-rebind",
		]);

		// They end when their conversation closes.
		await fake.close(oldConversation);
		await expect(rebindControls.extensionResult).resolves.toEqual({ status: "cancelled", reason: "closed" });
		await expect(rebindControls.hostResult).resolves.toMatchObject({ decision: "dismissed" });

		pair.client.close();
		await expect(modePromise).resolves.toBeUndefined();
	});
});
