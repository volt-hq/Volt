import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, getModel } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AnthropicOptions, streamAnthropic } from "../../../../ai/src/providers/anthropic.ts";
import { createHarness, type Harness } from "../harness.ts";

type AnthropicClient = NonNullable<AnthropicOptions["client"]>;
type AnthropicRequest = Parameters<AnthropicClient["messages"]["create"]>[0];

const model = getModel("anthropic", "claude-haiku-4-5");

function sse(events: object[]): Response {
	return new Response(
		events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
	);
}

/** Stream a complete tool call whose raw `partial_json` fragments concatenate to `argumentsText`. */
function toolUseResponse(argumentsText: string): Response {
	const fragments = argumentsText.match(/[\s\S]{1,5}/g) ?? [];
	return sse([
		{ type: "message_start", message: { id: "msg_tool", usage: { input_tokens: 1, output_tokens: 0 } } },
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_452", name: "edit", input: {} },
		},
		...fragments.map((partial_json) => ({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json },
		})),
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}

function textResponse(text: string): Response {
	return sse([
		{ type: "message_start", message: { id: "msg_text", usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}

function messageTexts(request: AnthropicRequest): string[] {
	return request.messages.map((message) =>
		typeof message.content === "string"
			? message.content
			: message.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n"),
	);
}

describe("issue #452 tool argument JSON feedback", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function setup(responses: Response[]) {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "applied" }], details: {} }));
		const tool: AgentTool = {
			name: "edit",
			label: "Edit",
			description: "Test edit boundary",
			parameters: Type.Object({ text: Type.String() }),
			execute,
		};
		const harness = await createHarness({
			tools: [tool],
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const requests: AnthropicRequest[] = [];
		const client = {
			messages: {
				create: (params: AnthropicRequest) => {
					requests.push(structuredClone(params));
					const response = responses.shift();
					if (!response) throw new Error("No Anthropic response queued");
					return { asResponse: async () => response };
				},
			},
		} as unknown as AnthropicClient;
		const anthropicStep = async (context: Parameters<typeof streamAnthropic>[1]) =>
			streamAnthropic(model, context, { client }).result();
		return { harness, execute, requests, anthropicStep };
	}

	it("rejects literal tabs with a specific reason and explains the rejection on continue", async () => {
		const { harness, execute, requests, anthropicStep } = await setup([
			toolUseResponse('{"text":"private\tindented\tvalue"}'),
			textResponse("Retrying with escaped tabs."),
		]);
		harness.setResponses([anthropicStep, anthropicStep]);

		await harness.session.prompt("Apply the edit");

		expect(execute).not.toHaveBeenCalled();
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(0);
		expect(harness.faux.state.callCount).toBe(1);
		const failure = harness.session.messages.at(-1);
		if (failure?.role !== "assistant") throw new Error("Expected assistant failure");
		expect(failure.stopReason).toBe("error");
		expect(failure.errorMessage).toBe(
			"Tool arguments contained an unescaped tab (U+0009) inside a JSON string; encode it as \\t. No tools were executed.",
		);
		expect(failure.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "invalid_tool_arguments",
				details: { code: "invalid_json", contentIndex: 0, reason: "unescaped_control_character", codePoint: 9 },
			}),
		);
		expect(JSON.stringify(failure.diagnostics)).not.toContain("private");

		await harness.session.prompt("continue");

		expect(requests).toHaveLength(2);
		const texts = messageTexts(requests[1]);
		const feedbackIndex = texts.indexOf(
			"Your previous response was discarded and none of its tool calls were executed. " +
				"The arguments for the `edit` tool call contained an unescaped tab (U+0009) inside a JSON string; encode it as \\t.",
		);
		expect(feedbackIndex).toBeGreaterThan(texts.findIndex((text) => text.includes("Apply the edit")));
		expect(texts.findIndex((text) => text.includes("continue"))).toBeGreaterThan(feedbackIndex);
		const replay = JSON.stringify(requests[1].messages);
		expect(replay).not.toContain("tool_use");
		expect(replay).not.toContain("private");
		expect(execute).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("executes escaped tabs exactly once", async () => {
		const { harness, execute, anthropicStep } = await setup([toolUseResponse('{"text":"a\\tb"}')]);
		harness.setResponses([anthropicStep, fauxAssistantMessage("done")]);

		await harness.session.prompt("Apply the edit");

		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]).toEqual(expect.arrayContaining(["toolu_452", { text: "a\tb" }]));
		expect(harness.faux.state.callCount).toBe(2);
	});
});
