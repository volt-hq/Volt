import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { convertResponsesMessages } from "../src/providers/openai-responses-shared.ts";
import { transformMessages } from "../src/providers/transform-messages.ts";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "../src/types.ts";

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
