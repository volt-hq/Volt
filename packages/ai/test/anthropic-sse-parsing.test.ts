import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

const minimalAnthropicEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: {
					input_tokens: 12,
					output_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "Hello" },
		}),
	},
	{
		event: "content_block_stop",
		data: JSON.stringify({ type: "content_block_stop", index: 0 }),
	},
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: {
				input_tokens: 12,
				output_tokens: 5,
				cache_read_input_tokens: 0,
				cache_creation_input_tokens: 0,
			},
		}),
	},
	{
		event: "message_stop",
		data: JSON.stringify({ type: "message_stop" }),
	},
];

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: {
			create: () => ({
				asResponse: async () => response,
			}),
		},
	} as unknown as Anthropic;
}

describe("Anthropic raw SSE parsing", () => {
	it.each([
		{ input: {}, parts: ['{"text":"unfinished'], blockStop: true, stopReason: "tool_use", expected: "error" },
		{ input: {}, parts: ['{"text":"done"}'], blockStop: false, stopReason: "tool_use", expected: "error" },
		{ input: {}, parts: ['{"text":"done"}'], blockStop: true, stopReason: "max_tokens", expected: "error" },
		{ input: null, parts: [], blockStop: true, stopReason: "tool_use", expected: "error" },
		{ input: {}, parts: [], blockStop: true, stopReason: "tool_use", expected: "toolUse" },
		{ input: {}, parts: ['{"text":', '"done"}'], blockStop: true, stopReason: "tool_use", expected: "toolUse" },
	])("requires complete strict arguments: %j", async ({ input, parts, blockStop, stopReason, expected }) => {
		const events = [
			JSON.parse(minimalAnthropicEvents[0].data),
			{
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "call-1", name: "edit", input },
			},
			...parts.map((partial_json) => ({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json },
			})),
			...(blockStop ? [{ type: "content_block_stop", index: 0 }] : []),
			{ type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		];
		const result = await streamAnthropic(
			getModel("anthropic", "claude-haiku-4-5"),
			{
				messages: [{ role: "user", content: "edit", timestamp: 0 }],
			},
			{
				client: createFakeAnthropicClient(
					createSseResponse(events.map((event) => ({ event: event.type, data: JSON.stringify(event) }))),
				),
			},
		).result();
		expect(result.stopReason).toBe(expected);
		if (expected === "error") {
			expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "invalid_tool_arguments" }));
		} else {
			expect(result.content[0]).toMatchObject({ arguments: parts.length > 0 ? { text: "done" } : {} });
		}
	});

	it("rejects malformed SSE JSON instead of repairing authoritative tool input", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
			tools: [
				{
					name: "edit",
					description: "Edit a file.",
					parameters: Type.Object({
						path: Type.String(),
						text: Type.String(),
					}),
				},
			],
		};

		const malformedToolJsonDelta = String.raw`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"path\":\"A\H\",\"text\":\"col1	col2\"}"}}`;

		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_test",
						usage: {
							input_tokens: 12,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "content_block_start",
				data: JSON.stringify({
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "tool_use",
						id: "toolu_test",
						name: "edit",
						input: {},
					},
				}),
			},
			{ event: "content_block_delta", data: malformedToolJsonDelta },
			{
				event: "content_block_stop",
				data: JSON.stringify({ type: "content_block_stop", index: 0 }),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: { stop_reason: "tool_use" },
					usage: {
						input_tokens: 12,
						output_tokens: 5,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "invalid_tool_arguments" }));
	});

	it("classifies malformed native tool input before the tool starts without exposing the payload", async () => {
		const response = createSseResponse([
			minimalAnthropicEvents[0],
			{
				event: "content_block_start",
				data: String.raw`{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"edit","input":{"text":"sensitive timeout \q"}}}`,
			},
		]);
		const result = await streamAnthropic(
			getModel("anthropic", "claude-haiku-4-5"),
			{
				messages: [{ role: "user", content: "edit", timestamp: 0 }],
			},
			{ client: createFakeAnthropicClient(response) },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).not.toContain("sensitive");
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "invalid_tool_arguments" }));
	});

	it.each([
		{
			event: "content_block_start",
			data: '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call","name":"edit","input":{"text":"sensitive timeout"',
		},
		{
			event: "content_block_delta",
			data: '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"sensitive timeout',
		},
		{ event: "content_block_start", data: '{"type":"content_block_start","input":{"text":"sensitive timeout"}}' },
	])("classifies unparseable potentially tool-bearing $event events before a block exists", async (event) => {
		const response = createSseResponse([minimalAnthropicEvents[0], event]);
		const result = await streamAnthropic(
			getModel("anthropic", "claude-haiku-4-5"),
			{ messages: [] },
			{ client: createFakeAnthropicClient(response) },
		).result();
		expect(result.stopReason).toBe("error");
		expect(result.content).toEqual([]);
		expect(JSON.stringify(result)).not.toContain("sensitive");
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "invalid_tool_arguments" }));
	});

	it("preserves refusal stop details from message_delta", async () => {
		const model = getModel("anthropic", "claude-fable-5");
		const context: Context = {
			messages: [{ role: "user", content: "blocked request", timestamp: Date.now() }],
		};
		const explanation =
			"This request triggered restrictions on violative cyber content and was blocked under Anthropic's Usage Policy. To learn more, provide feedback, or request an exemption based on how you use Claude, visit our help center: https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude.";
		const response = createSseResponse([
			{
				event: "message_start",
				data: JSON.stringify({
					type: "message_start",
					message: {
						id: "msg_01XFUDYJgAACzvnptvVoYEL",
						usage: {
							input_tokens: 412,
							output_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation_input_tokens: 0,
						},
					},
				}),
			},
			{
				event: "message_delta",
				data: JSON.stringify({
					type: "message_delta",
					delta: {
						stop_reason: "refusal",
						stop_details: {
							type: "refusal",
							category: "cyber",
							explanation,
						},
					},
					usage: {
						input_tokens: 412,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				}),
			},
			{
				event: "message_stop",
				data: JSON.stringify({ type: "message_stop" }),
			},
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(explanation);
	});

	it("ignores unknown SSE events after message_stop", async () => {
		const model = getModel("anthropic", "claude-haiku-4-5");
		const context: Context = {
			messages: [{ role: "user", content: "Say hello.", timestamp: Date.now() }],
		};
		const response = createSseResponse([
			...minimalAnthropicEvents,
			{ event: "done", data: "[DONE]" },
			{ event: "proxy.stats", data: "not json" },
		]);

		const stream = streamAnthropic(model, context, {
			client: createFakeAnthropicClient(response),
		});
		const result = await stream.result();

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "Hello" }]);
	});
});
