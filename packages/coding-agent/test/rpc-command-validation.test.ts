import { describe, expect, test } from "vitest";
import { validateRpcCommandPayload } from "../src/modes/rpc/rpc-command-validation.ts";

const invalidPayloadCases: Array<{ name: string; payload: unknown; error: string }> = [
	{
		name: "rejects missing prompt messages",
		payload: { type: "prompt" },
		error: 'Invalid RPC command payload: "message" is required',
	},
	{
		name: "rejects non-string prompt messages",
		payload: { type: "prompt", message: 1 },
		error: 'Invalid RPC command payload: "message" must be a string',
	},
	{
		name: "rejects invalid prompt images",
		payload: { type: "prompt", message: "hello", images: [{ type: "image", data: "abc" }] },
		error: 'Invalid RPC command payload: "images" must be an array of image objects',
	},
	{
		name: "rejects invalid prompt streaming behavior",
		payload: { type: "prompt", message: "hello", streamingBehavior: "queue" },
		error: 'Invalid RPC command payload: "streamingBehavior" must be "steer" or "followUp"',
	},
	{
		name: "rejects invalid steer images",
		payload: { type: "steer", message: "hello", images: "image" },
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
});
