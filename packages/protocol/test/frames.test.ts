import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { RPC_COMMAND_SCHEMAS } from "../src/commands.ts";
import { RpcClientMessageSchema, RpcCommandSchema, RpcResponseSchema, RpcServerEventSchema } from "../src/contract.ts";
import { RPC_RESPONSE_SCHEMAS } from "../src/responses.ts";

const ASSISTANT = {
	role: "assistant",
	content: [{ type: "text", text: "hi" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude",
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
};

describe("wire frames", () => {
	it("accepts representative client commands and control messages", () => {
		for (const command of [
			{ type: "prompt", id: "1", clientMessageId: "c-1", message: "hello", streamingBehavior: "followUp" },
			{ type: "set_thinking_level", level: "high" },
			{ type: "get_session_tree", limit: 50, afterOrdinal: 10 },
			{ type: "invoke_ui_action", id: "req-1", action: "agent.mode", args: { mode: "plan" } },
		]) {
			expect(Check(RpcCommandSchema, command), command.type).toBe(true);
		}
		expect(Check(RpcClientMessageSchema, { type: "host_action_response", id: "h1", decision: "approved" })).toBe(
			true,
		);
		expect(Check(RpcClientMessageSchema, { type: "extension_ui_response", id: "u1", cancelled: true })).toBe(true);
	});

	it("rejects unknown command fields and reserved client message identities", () => {
		expect(Check(RPC_COMMAND_SCHEMAS.abort, { type: "abort", force: true })).toBe(false);
		expect(
			Check(RPC_COMMAND_SCHEMAS.prompt, { type: "prompt", clientMessageId: "local-queue:1", message: "x" }),
		).toBe(false);
		expect(Check(RPC_COMMAND_SCHEMAS.invoke_ui_action, { type: "invoke_ui_action", action: "agent.mode" })).toBe(
			false,
		);
	});

	it("accepts success and error responses and rejects mismatched ones", () => {
		expect(
			Check(RpcResponseSchema, {
				type: "response",
				command: "set_thinking_level",
				success: true,
				data: { level: "low" },
			}),
		).toBe(true);
		expect(
			Check(RpcResponseSchema, {
				type: "response",
				command: "prompt",
				success: false,
				error: "busy",
				errorCode: "client_input_conflict",
			}),
		).toBe(true);
		expect(
			Check(RPC_RESPONSE_SCHEMAS.set_thinking_level, {
				type: "response",
				command: "set_thinking_level",
				success: true,
				data: { level: "turbo" },
			}),
		).toBe(false);
		expect(
			Check(RpcResponseSchema, { type: "response", command: "invoke_ui_action", success: false, error: "no id" }),
		).toBe(false);
	});

	it("accepts declared server events and rejects undeclared fields", () => {
		const stream = { epoch: 1, seq: 0 };
		for (const event of [
			{ type: "message_start", stream, message: ASSISTANT },
			{
				type: "message_update",
				stream: { epoch: 1, seq: 1 },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "h" },
			},
			{ type: "models_changed" },
			{ type: "planning_state_changed", planning: { mode: "build", plan: null } },
			{ type: "git_context_changed", gitContext: null, delivery: { subscriptionId: "s", cursor: 3 } },
		]) {
			expect(Check(RpcServerEventSchema, event), event.type).toBe(true);
		}
		expect(Check(RpcServerEventSchema, { type: "models_changed", reason: "refresh" })).toBe(false);
		expect(Check(RpcServerEventSchema, { type: "message_start", stream, message: { ...ASSISTANT, extra: 1 } })).toBe(
			false,
		);
	});
});
