import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.ts";
import { transformMessages } from "../src/providers/transform-messages.ts";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "../src/types.ts";
import type { JsonObject } from "../src/utils/json-value.ts";

const model = getModel("openai-codex", "gpt-5.5");
const allowedProviders = new Set(["openai", "openai-codex", "opencode"]);

function assistant(stopReason: AssistantMessage["stopReason"], ...ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id): ToolCall => ({ type: "toolCall", id, name: "edit", arguments: { path: "file.ts" } })),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

function toolResult(id: string, isError = false): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "edit",
		content: [{ type: "text", text: isError ? "Operation aborted" : "Edited file.ts" }],
		isError,
		timestamp: 2,
	};
}

const continuation: Message = { role: "user", content: "Let's continue", timestamp: 3 };

describe("interrupted tool replay (#355)", () => {
	it.each(["aborted", "error"] as const)(
		"omits the %s assistant and all associated results without changing saved history",
		(stopReason) => {
			const completed = assistant("toolUse", "call_completed|fc_completed");
			const completedResult = toolResult("call_completed|fc_completed");
			const interrupted = assistant(stopReason, "call_partial|fc_partial", "call_other|fc_other");
			interrupted.content.unshift({ type: "thinking", thinking: "Unfinished reasoning" });
			const messages: Message[] = [
				completed,
				completedResult,
				interrupted,
				toolResult("call_partial|fc_partial", true),
				continuation,
				toolResult("call_other|fc_other", true),
				continuation,
			];
			const savedHistory = structuredClone(messages);

			const replay = transformMessages(messages, model);

			expect(replay).toEqual([completed, completedResult, continuation, continuation]);
			expect(transformMessages(messages, model)).toEqual(replay);
			expect(messages).toEqual(savedHistory);
		},
	);

	it.each(["aborted", "error"] as const)("does not synthesize results for a trailing %s call", (stopReason) => {
		expect(transformMessages([continuation, assistant(stopReason, "partial")], model)).toEqual([continuation]);
	});

	it("filters results after cross-model normalization and preserves completed calls with tool errors", () => {
		const completed = assistant("toolUse", "completed|foreign/item");
		const interrupted = assistant("aborted", "partial|foreign/item");
		const messages: Message[] = [
			completed,
			toolResult("completed|foreign/item", true),
			interrupted,
			toolResult("partial|foreign/item", true),
			continuation,
		];
		const savedHistory = structuredClone(messages);
		const targetModel = getModel("anthropic", "claude-sonnet-4-6");

		const replay = transformMessages(messages, targetModel, (id) => id.replace(/[^a-zA-Z0-9_-]/g, "_"));

		expect(replay).toEqual([
			{
				...completed,
				content: [{ type: "toolCall", id: "completed_foreign_item", name: "edit", arguments: { path: "file.ts" } }],
			},
			{ ...messages[1], toolCallId: "completed_foreign_item" },
			continuation,
		]);
		expect(messages).toEqual(savedHistory);
	});

	it("preserves a later completed call that reuses an interrupted call ID", () => {
		const completed = assistant("toolUse", "retry");
		const completedResult = toolResult("retry");
		const messages: Message[] = [
			assistant("error", "retry"),
			toolResult("retry", true),
			continuation,
			completed,
			completedResult,
		];

		expect(transformMessages(messages, model)).toEqual([continuation, completed, completedResult]);
	});

	it("continues synthesizing missing results for earlier completed calls", () => {
		const completed = assistant("toolUse", "completed");
		const replay = transformMessages(
			[completed, assistant("aborted", "partial"), toolResult("partial", true), continuation],
			model,
		);

		expect(replay).toEqual([
			completed,
			{
				role: "toolResult",
				toolCallId: "completed",
				toolName: "edit",
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp: expect.any(Number),
			},
			continuation,
		]);
	});

	describe("rejected tool arguments (#452)", () => {
		function rejected(details: JsonObject) {
			const message = assistant("error", "call_rejected");
			// An empty thinking block is dropped from replay, shifting later content indices.
			message.content.unshift({ type: "thinking", thinking: "" });
			message.content[1] = { type: "toolCall", id: "call_rejected", name: "edit", arguments: { secret: "private" } };
			message.diagnostics = [{ type: "invalid_tool_arguments", timestamp: 0, details }];
			return message;
		}

		const prefix = "Your previous response was discarded and none of its tool calls were executed. ";

		it.each<{ details: JsonObject; cause: string }>([
			{
				details: { code: "invalid_json", contentIndex: 1, reason: "unescaped_control_character", codePoint: 9 },
				cause: "The arguments for the `edit` tool call contained an unescaped tab (U+0009) inside a JSON string; encode it as \\t.",
			},
			{
				details: { code: "invalid_json", contentIndex: 1 },
				cause: "The arguments for the `edit` tool call were not a complete, valid JSON object.",
			},
			{
				details: { code: "invalid_json" },
				cause: "The arguments for a tool call were not a complete, valid JSON object.",
			},
			{
				details: { code: "length_limit", contentIndex: 1 },
				cause: "It reached the output length limit before its tool calls were complete.",
			},
			{
				details: { code: "missing_completion", contentIndex: 1 },
				cause: "The provider did not complete the `edit` tool call.",
			},
		])("replaces the rejected call with content-free feedback: $details", ({ details, cause }) => {
			const prompt: Message = { role: "user", content: "Apply the edit", timestamp: 0 };
			const failure = rejected(details);
			const messages: Message[] = [prompt, failure, toolResult("call_rejected", true), continuation];
			const savedHistory = structuredClone(messages);

			const replay = transformMessages(messages, model);

			expect(replay).toEqual([
				prompt,
				{ role: "user", content: [{ type: "text", text: prefix + cause }], timestamp: failure.timestamp },
				continuation,
			]);
			expect(JSON.stringify(replay)).not.toContain("private");
			expect(transformMessages(messages, model)).toEqual(replay);
			expect(messages).toEqual(savedHistory);
		});

		it("does not explain aborted responses", () => {
			const failure = { ...rejected({ code: "invalid_json" }), stopReason: "aborted" as const };
			expect(transformMessages([failure, continuation], model)).toEqual([continuation]);
		});
	});

	describe.each(["aborted", "error"] as const)("Responses replay after %s generation", (stopReason) => {
		it.each([false, true])("emits no orphan function_call_output (cross-provider: %s)", (crossProvider) => {
			const completed = assistant("toolUse", "call_completed|fc_completed");
			const interrupted = assistant(stopReason, "call_partial|fc_partial");
			if (crossProvider) {
				for (const message of [completed, interrupted]) {
					message.provider = "github-copilot";
					message.api = "openai-responses";
				}
			}
			const messages: Message[] = [
				completed,
				toolResult("call_completed|fc_completed"),
				interrupted,
				toolResult("call_partial|fc_partial", true),
				continuation,
			];
			const savedHistory = structuredClone(messages);

			const input = convertResponsesMessages(model, { messages }, allowedProviders);
			const calls = input.filter((item) => item.type === "function_call");
			const outputs = input.filter((item) => item.type === "function_call_output");

			expect(calls.map((item) => item.call_id)).toEqual(["call_completed"]);
			expect(outputs.map((item) => item.call_id)).toEqual(["call_completed"]);
			expect(outputs[0].output).toBe("Edited file.ts");
			expect(input.at(-1)).toMatchObject({
				role: "user",
				content: [{ type: "input_text", text: "Let's continue" }],
			});
			expect(messages).toEqual(savedHistory);
		});
	});
});
