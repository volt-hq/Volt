import type { ActiveToolCallState, AssistantMessage, AssistantMessageEvent, Usage } from "@hansjm10/volt-ai";
import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { describe, expect, test } from "vitest";
import { RPC_COMMAND_SCHEMAS } from "../src/core/rpc/schema/commands.ts";
import {
	RpcConversationBootstrapEventSchema,
	RpcMessageEndFrameSchema,
	RpcMessageStartFrameSchema,
	RpcMessageUpdateFrameSchema,
	RpcQueueUpdateEventSchema,
	RpcTranscriptEntryEventSchema,
} from "../src/core/rpc/schema/conversation.ts";
import {
	RpcExtensionUIRequestSchema,
	RpcHostActionRequestSchema,
	RpcHostActionUpdateSchema,
	RpcModelsChangedEventSchema,
} from "../src/core/rpc/schema/events.ts";
import { RpcApiSchema } from "../src/core/rpc/schema/external.ts";
import { RpcWorkflowEventSchema } from "../src/core/rpc/schema/projections.ts";
import { RPC_RESPONSE_SCHEMAS, RpcErrorResponseSchema } from "../src/core/rpc/schema/responses.ts";
import { UiActionCapabilityFeatureSchema, UiActionDescriptorSchema } from "../src/core/rpc/schema/ui-actions.ts";
import { projectRpcQueueUpdate } from "../src/core/rpc/session-state.ts";
import { StreamProjector } from "../src/core/rpc/stream-projection.ts";
import type {
	RpcConversationBootstrapEvent,
	RpcExtensionUIRequest,
	RpcHostActionRequest,
	RpcHostActionUpdate,
	RpcTranscriptEntryEvent,
	RpcWorkflowEvent,
	UiActionDescriptor,
} from "../src/core/rpc/types.ts";
import { createRpcErrorResponse, createRpcSuccessResponse } from "../src/modes/rpc/rpc-command-dispatcher.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	content: AssistantMessage["content"] = [],
	overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function check(schema: TSchema, value: unknown): boolean {
	return Compile(schema).Check(value);
}

describe("RPC contract schema integrity", () => {
	test("every command schema's type constant equals its map key", () => {
		for (const [key, schema] of Object.entries(RPC_COMMAND_SCHEMAS)) {
			const typeProperty = schema.properties.type as { const?: string };
			expect(typeProperty.const).toBe(key);
		}
	});

	test("every response schema echoes its command key under type: response", () => {
		for (const [key, schema] of Object.entries(RPC_RESPONSE_SCHEMAS)) {
			const properties = schema.properties as Record<string, { const?: unknown }>;
			expect(properties.type?.const).toBe("response");
			expect(properties.command?.const).toBe(key);
			expect(properties.success?.const).toBe(true);
		}
	});

	test("open string enums accept novel values", () => {
		for (const schema of [RpcApiSchema, UiActionCapabilityFeatureSchema]) {
			expect(check(schema, "some-novel-value.v9")).toBe(true);
			expect(check(schema, 7)).toBe(false);
		}
	});

	test("requires correlation for UI action invocations and their successful responses", () => {
		const command = {
			id: "invoke-exact",
			type: "invoke_ui_action",
			action: "session.new",
		};
		expect(check(RPC_COMMAND_SCHEMAS.invoke_ui_action, command)).toBe(true);
		expect(check(RPC_COMMAND_SCHEMAS.invoke_ui_action, { ...command, id: undefined })).toBe(false);

		const success = createRpcSuccessResponse("invoke-exact", "invoke_ui_action", {
			action: "session.new",
			status: "completed",
		});
		expect(check(RPC_RESPONSE_SCHEMAS.invoke_ui_action, success)).toBe(true);
		expect(check(RPC_RESPONSE_SCHEMAS.invoke_ui_action, { ...success, id: undefined })).toBe(false);

		// Generic malformed-input errors can predate a usable correlation id.
		expect(
			check(RpcErrorResponseSchema, {
				type: "response",
				command: "invoke_ui_action",
				success: false,
				error: 'Invalid RPC command payload: "id" is required',
			}),
		).toBe(true);
	});
});

describe("RPC contract emission conformance", () => {
	test("StreamProjector frames validate against the stream frame schemas", () => {
		const projector = new StreamProjector();
		const startValidator = Compile(RpcMessageStartFrameSchema);
		const updateValidator = Compile(RpcMessageUpdateFrameSchema);
		const endValidator = Compile(RpcMessageEndFrameSchema);

		const snapshot = assistant([{ type: "text", text: "" }]);
		const toolState: readonly ActiveToolCallState[] = [];
		const update = (assistantMessageEvent: AssistantMessageEvent) => ({
			type: "message_update",
			message:
				assistantMessageEvent.type === "done" || assistantMessageEvent.type === "error" ? undefined : snapshot,
			assistantMessageEvent,
		});
		const events: object[] = [
			{ type: "message_start", message: snapshot },
			update({ type: "text_start", seq: 1, contentIndex: 0, snapshot, toolState }),
			update({ type: "text_delta", seq: 2, contentIndex: 0, delta: "hel", snapshot, toolState }),
			update({
				type: "text_end",
				seq: 3,
				contentIndex: 0,
				content: "hello",
				snapshot: assistant([{ type: "text", text: "hello" }]),
				toolState,
			}),
			{ type: "message_end", message: assistant([{ type: "text", text: "hello" }]) },
		];

		const frames = events.flatMap((event) => projector.push(event).frames) as Array<{ type?: string }>;
		expect(frames.length).toBeGreaterThanOrEqual(3);
		for (const frame of frames) {
			const validator =
				frame.type === "message_start"
					? startValidator
					: frame.type === "message_update"
						? updateValidator
						: endValidator;
			expect(validator.Errors(frame)).toEqual([]);
		}
	});

	test("projectRpcQueueUpdate output validates against the queue_update schema", () => {
		const projected = projectRpcQueueUpdate({
			type: "queue_update",
			steering: [{ queueEntryId: "local-queue:1", clientMessageId: "m-1", text: "steer this" }],
			followUp: [{ queueEntryId: "local-queue:2", text: "later" }],
		});
		expect(Compile(RpcQueueUpdateEventSchema).Errors(projected)).toEqual([]);
	});

	test("dispatcher-built responses validate against the response schemas", () => {
		const success = createRpcSuccessResponse("id-1", "set_thinking_level", { level: "high" });
		expect(Compile(RPC_RESPONSE_SCHEMAS.set_thinking_level).Errors(success)).toEqual([]);

		const voidSuccess = createRpcSuccessResponse(undefined, "abort");
		expect(Compile(RPC_RESPONSE_SCHEMAS.abort).Errors(voidSuccess)).toEqual([]);

		const failure = createRpcErrorResponse("id-2", "prompt", 'Invalid RPC command payload: "message" is required');
		expect(Compile(RpcErrorResponseSchema).Errors(failure)).toEqual([]);

		const coded = createRpcErrorResponse("id-3", "prompt", "conflict", { code: "client_input_conflict" });
		expect(Compile(RpcErrorResponseSchema).Errors(coded)).toEqual([]);
	});

	test("typed event payloads validate against their schemas", () => {
		// Typechecked construction + runtime Check proves the compiled schema
		// accepts exactly what the derived static types describe.
		const bootstrap: RpcConversationBootstrapEvent = {
			type: "conversation_bootstrap",
			delivery: { subscriptionId: "sub-1", cursor: 0 },
			conversation: { workspaceName: "workspace", sessionId: "session-1" },
			state: {
				thinkingLevel: "high",
				availableThinkingLevels: ["off", "high"],
				fastModeEnabled: true,
				isStreaming: false,
				isCompacting: false,
				steeringMode: "all",
				followUpMode: "all",
				sessionId: "session-1",
				autoCompactionEnabled: true,
				messageCount: 2,
				pendingMessageCount: 0,
				steeringQueue: [{ clientMessageId: "m-1", text: "queued" }],
				followUpQueue: [],
			},
			transcript: {
				sessionId: "session-1",
				items: [
					{
						entryId: "entry-1",
						ordinal: 1,
						createdAt: "2026-07-20T00:00:00.000Z",
						role: "assistant",
						text: "hello",
						truncated: false,
						parts: [{ type: "text", text: "hello", truncated: false }],
						stopReason: "stop",
					},
				],
				hasMore: false,
				nextBeforeEntryId: null,
				projectionVersion: 3,
				branchEpoch: "epoch-1",
				head: { entryId: "entry-1", ordinal: 1 },
			},
			activeAssistant: {
				stream: { epoch: 1, seq: 4 },
				message: assistant([{ type: "text", text: "hello" }]),
				toolState: [],
			},
			activeWorkflows: [],
			reason: "bootstrap",
		};
		expect(Compile(RpcConversationBootstrapEventSchema).Errors(bootstrap)).toEqual([]);

		const transcriptEntry: RpcTranscriptEntryEvent = {
			type: "transcript_entry",
			entry: {
				entryId: "entry-2",
				ordinal: 2,
				createdAt: "2026-07-20T00:00:01.000Z",
				role: "tool",
				text: "",
				truncated: false,
				toolName: "bash",
				status: "completed",
				summary: "ls",
				output: "README.md",
			},
			final: true,
			delivery: { subscriptionId: "sub-1", cursor: 7 },
		};
		expect(Compile(RpcTranscriptEntryEventSchema).Errors(transcriptEntry)).toEqual([]);

		const workflowEvent: RpcWorkflowEvent = {
			type: "workflow_start",
			workflowId: "review:1",
			kind: "review",
			action: "review.branch",
			title: "Reviewing branch",
			status: "running",
		};
		expect(Compile(RpcWorkflowEventSchema).Errors(workflowEvent)).toEqual([]);

		const hostActionRequest: RpcHostActionRequest = {
			type: "host_action_request",
			id: "action-1",
			action: "session.new",
			title: "Start a new session?",
			blocking: true,
			metadata: { source: "test", attempts: 1, urgent: false, note: null },
		};
		expect(Compile(RpcHostActionRequestSchema).Errors(hostActionRequest)).toEqual([]);

		const hostActionUpdate: RpcHostActionUpdate = {
			type: "host_action_update",
			id: "action-1",
			action: "session.new",
			status: "completed",
			exitCode: null,
		};
		expect(Compile(RpcHostActionUpdateSchema).Errors(hostActionUpdate)).toEqual([]);

		const extensionRequest: RpcExtensionUIRequest = {
			type: "extension_ui_request",
			id: "ui-1",
			method: "select",
			title: "Pick one",
			options: ["a", "b"],
			timeout: 5000,
		};
		expect(Compile(RpcExtensionUIRequestSchema).Errors(extensionRequest)).toEqual([]);

		expect(Compile(RpcModelsChangedEventSchema).Errors({ type: "models_changed" })).toEqual([]);

		const descriptor: UiActionDescriptor = {
			schemaVersion: 1,
			id: "review.branch",
			label: "Review branch",
			source: "builtin",
			category: "review",
			enabled: true,
			remoteSafe: true,
			streamingBehavior: ["queueSteer", "queueFollowUp"],
			state: { type: "boolean", value: true },
		};
		expect(Compile(UiActionDescriptorSchema).Errors(descriptor)).toEqual([]);
	});
});
