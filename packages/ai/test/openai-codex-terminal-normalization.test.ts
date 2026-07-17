import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { AssistantMessageEvent, Context, Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "gpt-codex-test",
	name: "Codex Test",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_000,
	maxTokens: 4_000,
};

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function mockToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function createSseResponse(events: ReadonlyArray<Record<string, unknown>>): Response {
	const body = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function runCodexStream(events: ReadonlyArray<Record<string, unknown>>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => createSseResponse(events)),
	);
	const stream = streamOpenAICodexResponses(model, context, {
		apiKey: mockToken(),
		transport: "sse",
	});
	const received: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		received.push(event);
	}
	return { events: received, message: await stream.result() };
}

function textEvents(text: string): Array<Record<string, unknown>> {
	return [
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
	];
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Codex SSE terminal normalization", () => {
	it("turns clean SSE exhaustion without a response terminal into a protocol error", async () => {
		const { events, message } = await runCodexStream(textEvents("partial"));

		expect(events.at(-1)?.type).toBe("error");
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("Codex stream ended before response.completed");
		expect(message.content).toContainEqual(expect.objectContaining({ type: "text", text: "partial" }));
	});

	it("still accepts an explicit completed response", async () => {
		const { events, message } = await runCodexStream([
			...textEvents("complete"),
			{
				type: "response.completed",
				response: {
					id: "resp_1",
					status: "completed",
					usage: {
						input_tokens: 2,
						output_tokens: 1,
						total_tokens: 3,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			},
		]);

		expect(events.at(-1)?.type).toBe("done");
		expect(message).toMatchObject({ stopReason: "stop", responseId: "resp_1" });
	});

	it("preserves explicit response.failed errors", async () => {
		const { events, message } = await runCodexStream([
			{
				type: "response.failed",
				response: { error: { code: "server_error", message: "provider failed" } },
			},
		]);

		expect(events.at(-1)?.type).toBe("error");
		expect(message.errorMessage).toBe("provider failed");
	});

	it("preserves explicit protocol error events", async () => {
		const { events, message } = await runCodexStream([
			{ type: "error", code: "bad_request", message: "invalid request" },
		]);

		expect(events.at(-1)?.type).toBe("error");
		expect(message.errorMessage).toBe("Codex error: invalid request");
	});
});
