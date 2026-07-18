import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES } from "../src/core/rpc/types.ts";
import {
	RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_MAX_IMAGES,
	RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES,
	RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES,
	validateRpcCommandPayload,
} from "../src/modes/rpc/rpc-command-validation.ts";

const clientMessageId = "client-message-1";

const invalidPayloadCases: Array<{ name: string; payload: unknown; error: string }> = [
	{
		name: "rejects missing prompt client message identities",
		payload: { type: "prompt", message: "hello" },
		error: 'Invalid RPC command payload: "clientMessageId" is required',
	},
	{
		name: "rejects missing steer client message identities",
		payload: { type: "steer", message: "hello" },
		error: 'Invalid RPC command payload: "clientMessageId" is required',
	},
	{
		name: "rejects missing follow-up client message identities",
		payload: { type: "follow_up", message: "hello" },
		error: 'Invalid RPC command payload: "clientMessageId" is required',
	},
	{
		name: "rejects missing prompt messages",
		payload: { type: "prompt", clientMessageId },
		error: 'Invalid RPC command payload: "message" is required',
	},
	{
		name: "rejects non-string prompt messages",
		payload: { type: "prompt", clientMessageId, message: 1 },
		error: 'Invalid RPC command payload: "message" must be a string',
	},
	{
		name: "rejects invalid prompt images",
		payload: { type: "prompt", clientMessageId, message: "hello", images: [{ type: "image", data: "abc" }] },
		error: 'Invalid RPC command payload: "images" must be an array of image objects',
	},
	{
		name: "rejects invalid prompt streaming behavior",
		payload: { type: "prompt", clientMessageId, message: "hello", streamingBehavior: "queue" },
		error: 'Invalid RPC command payload: "streamingBehavior" must be "steer" or "followUp"',
	},
	{
		name: "rejects invalid steer images",
		payload: { type: "steer", clientMessageId, message: "hello", images: "image" },
		error: 'Invalid RPC command payload: "images" must be an array of image objects',
	},
	{
		name: "rejects invalid new-session parents",
		payload: { type: "new_session", parentSession: 1 },
		error: 'Invalid RPC command payload: "parentSession" must be a string',
	},
	{
		name: "rejects invalid client capability lists",
		payload: { type: "set_client_capabilities", features: ["host_action_requests.v1", 1] },
		error: 'Invalid RPC command payload: "features" must be an array of strings',
	},
	{
		name: "rejects incomplete discontinuity reports",
		payload: { type: "report_stream_discontinuity" },
		error: 'Invalid RPC command payload: "id" is required',
	},
	{
		name: "rejects unsafe discontinuity cursors",
		payload: {
			id: "recovery-1",
			type: "report_stream_discontinuity",
			sessionId: "session-1",
			subscriptionId: "subscription-1",
			lastAppliedCursor: Number.MAX_SAFE_INTEGER + 1,
			reason: "cursor_gap",
		},
		error: 'Invalid RPC command payload: "lastAppliedCursor" must be a safe non-negative integer',
	},
	{
		name: "rejects invalid discontinuity reasons",
		payload: {
			id: "recovery-1",
			type: "report_stream_discontinuity",
			sessionId: "session-1",
			subscriptionId: "subscription-1",
			lastAppliedCursor: 4,
			reason: "unknown",
		},
		error: 'Invalid RPC command payload: "reason" must be "cursor_gap", "assistant_position_gap", or "reducer_divergence"',
	},
	{
		name: "rejects invalid UI action scopes",
		payload: { type: "get_ui_actions", scope: "secondary" },
		error: 'Invalid RPC command payload: "scope" must be "primary", "palette", or "all"',
	},
	{
		name: "rejects incomplete UI action completion requests",
		payload: { type: "get_ui_action_completions", action: "review" },
		error: 'Invalid RPC command payload: "argument" is required',
	},
	{
		name: "rejects invalid UI action invocation args",
		payload: { type: "invoke_ui_action", action: "review", args: [] },
		error: 'Invalid RPC command payload: "args" must be an object',
	},
	{
		name: "rejects invalid push target registrations",
		payload: { type: "register_push_target", args: { provider: "fcm", platform: "ios", enabled: true } },
		error: 'Invalid RPC command payload: "args" must be a push target registration object',
	},
	{
		name: "rejects invalid transcript pagination",
		payload: { type: "get_transcript", limit: "10" },
		error: 'Invalid RPC command payload: "limit" must be a number',
	},
	{
		name: "rejects invalid MCP resource cursor",
		payload: { type: "list_mcp_resources", server: "docs", cursor: 1 },
		error: 'Invalid RPC command payload: "cursor" must be a string',
	},
	{
		name: "rejects invalid MCP prompt cursor",
		payload: { type: "list_mcp_prompts", server: "docs", cursor: 1 },
		error: 'Invalid RPC command payload: "cursor" must be a string',
	},
	{
		name: "rejects invalid model providers",
		payload: { type: "set_model", provider: 1, modelId: "model" },
		error: 'Invalid RPC command payload: "provider" must be a string',
	},
	{
		name: "rejects invalid thinking levels",
		payload: { type: "set_thinking_level", level: "bad" },
		error: 'Invalid RPC command payload: "level" must be a supported thinking level',
	},
	{
		name: "rejects invalid queue modes",
		payload: { type: "set_steering_mode", mode: "latest" },
		error: 'Invalid RPC command payload: "mode" must be "all" or "one-at-a-time"',
	},
	{
		name: "rejects invalid compaction instructions",
		payload: { type: "compact", customInstructions: false },
		error: 'Invalid RPC command payload: "customInstructions" must be a string',
	},
	{
		name: "rejects invalid boolean state mutations",
		payload: { type: "set_auto_retry", enabled: "true" },
		error: 'Invalid RPC command payload: "enabled" must be a boolean',
	},
	{
		name: "rejects invalid bash commands",
		payload: { type: "bash", command: 1 },
		error: 'Invalid RPC command payload: "command" must be a string',
	},
	{
		name: "rejects invalid export paths",
		payload: { type: "export_html", outputPath: 1 },
		error: 'Invalid RPC command payload: "outputPath" must be a string',
	},
	{
		name: "rejects invalid switch-session paths",
		payload: { type: "switch_session", sessionPath: 1 },
		error: 'Invalid RPC command payload: "sessionPath" must be a string',
	},
	{
		name: "rejects invalid switch-session IDs",
		payload: { type: "switch_session_by_id", sessionId: 1 },
		error: 'Invalid RPC command payload: "sessionId" must be a string',
	},
	{
		name: "rejects invalid fork entry IDs",
		payload: { type: "fork", entryId: 1 },
		error: 'Invalid RPC command payload: "entryId" must be a string',
	},
	{
		name: "rejects invalid session names",
		payload: { type: "set_session_name", name: 1 },
		error: 'Invalid RPC command payload: "name" must be a string',
	},
];

describe("RPC command payload validation", () => {
	test.each(invalidPayloadCases)("$name", ({ payload, error }) => {
		expect(validateRpcCommandPayload(payload)).toBe(error);
	});

	test("allows non-command and valid command payloads to continue through dispatch", () => {
		expect(validateRpcCommandPayload("not an object")).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "future_command", message: 1 })).toBeUndefined();
		expect(validateRpcCommandPayload({ type: "set_thinking_level", level: "max" })).toBeUndefined();
		expect(
			validateRpcCommandPayload({
				id: "recovery-1",
				type: "report_stream_discontinuity",
				sessionId: "session-1",
				subscriptionId: "subscription-1",
				lastAppliedCursor: 4,
				assistantPosition: { epoch: 2, seq: 9 },
				reason: "assistant_position_gap",
			}),
		).toBeUndefined();
		expect(
			validateRpcCommandPayload({
				type: "register_push_target",
				args: {
					provider: "fcm",
					platform: "ios",
					pushTargetId: "target-id",
					pushTargetAuthToken: "auth-token",
					enabled: true,
					relayUrl: "https://example.com",
					tokenHash: "token-hash",
					liveActivity: {
						activityId: "activity-id",
						pushToken: "push-token",
						tokenHash: "live-activity-token-hash",
					},
				},
			}),
		).toBeUndefined();
	});

	test("bounds conversation text by UTF-8 bytes for prompt, steer, and follow-up", () => {
		const oversizedUnicode = "🧪".repeat(Math.floor(RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES / 4) + 1);
		for (const type of ["prompt", "steer", "follow_up"]) {
			expect(validateRpcCommandPayload({ type, clientMessageId, message: oversizedUnicode })).toBe(
				`Invalid RPC command payload: "message" exceeds the ${RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES}-byte UTF-8 limit`,
			);
		}
		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId,
				message: "a".repeat(RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES),
			}),
		).toBeUndefined();
	});

	test("bounds ordered-conversation authority identifiers", () => {
		const oversized = "🧪".repeat(Math.floor(RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES / 4) + 1);
		expect(validateRpcCommandPayload({ type: "prompt", clientMessageId: " client-message-1 ", message: "hi" })).toBe(
			'Invalid RPC command payload: "clientMessageId" must not contain surrounding whitespace',
		);
		for (const field of ["id", "sessionId", "subscriptionId"] as const) {
			const command = {
				id: "recovery-1",
				type: "report_stream_discontinuity",
				sessionId: "session-1",
				subscriptionId: "subscription-1",
				lastAppliedCursor: 4,
				reason: "cursor_gap",
				[field]: oversized,
			};
			expect(validateRpcCommandPayload(command)).toBe(
				`Invalid RPC command payload: "${field}" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`,
			);
		}
		expect(validateRpcCommandPayload({ type: "get_transcript", branchEpoch: oversized })).toBe(
			`Invalid RPC command payload: "branchEpoch" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`,
		);
		expect(validateRpcCommandPayload({ type: "prompt", clientMessageId: oversized, message: "hi" })).toBe(
			`Invalid RPC command payload: "clientMessageId" exceeds the ${RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES}-byte UTF-8 limit`,
		);
	});

	test("bounds image count, per-image data, aggregate payload, and serialized input", () => {
		const image = { type: "image", mimeType: "image/png", data: "a" } as const;
		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId,
				message: "image count",
				images: Array.from({ length: RPC_CONVERSATION_INPUT_MAX_IMAGES + 1 }, () => image),
			}),
		).toBe(`Invalid RPC command payload: "images" exceeds the ${RPC_CONVERSATION_INPUT_MAX_IMAGES}-image limit`);

		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId,
				message: "one image",
				images: [{ ...image, data: "a".repeat(RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES + 1) }],
			}),
		).toBe(
			`Invalid RPC command payload: "images[0].data" exceeds the ${RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES}-byte UTF-8 limit`,
		);

		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId,
				message: "aggregate images",
				images: [
					{ ...image, data: "a".repeat(800 * 1024) },
					{ ...image, data: "b".repeat(800 * 1024) },
				],
			}),
		).toBe(
			`Invalid RPC command payload: "images" exceeds the ${RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES}-byte UTF-8 payload limit`,
		);

		const mimeBytes = Buffer.byteLength(image.mimeType, "utf8");
		const combinedDataBytes = RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES - mimeBytes * 2;
		expect(
			validateRpcCommandPayload({
				type: "prompt",
				clientMessageId,
				message: "m".repeat(RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES),
				images: [
					{ ...image, data: "a".repeat(Math.floor(combinedDataBytes / 2)) },
					{ ...image, data: "b".repeat(Math.ceil(combinedDataBytes / 2)) },
				],
			}),
		).toBe(
			`Invalid RPC command payload: conversation input exceeds the ${RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES}-byte serialized limit`,
		);
	});
});
