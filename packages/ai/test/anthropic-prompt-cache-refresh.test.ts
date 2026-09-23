import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { refreshPromptCacheAnthropic, streamSimpleAnthropic } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";

const context: Context = {
	systemPrompt: "You are terse.",
	messages: [{ role: "user", content: "Reply with ok", timestamp: 1 }],
	tools: [
		{
			name: "read_file",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
		},
	],
};

function sseResponse(): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } } },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 1 } },
		{ type: "message_stop" },
	];
	const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function captureRequests(respond: () => Response): Array<Record<string, unknown>> {
	const bodies: Array<Record<string, unknown>> = [];
	vi.stubGlobal("fetch", async (_input: unknown, init?: RequestInit) => {
		bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		return respond();
	});
	return bodies;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Anthropic prompt-cache refresh", () => {
	it("replays the streamSimple payload with max_tokens 0 and no streaming", async () => {
		const model = getModel("anthropic", "claude-opus-5-5");
		const options = { apiKey: "sk-ant-api03-test", reasoning: "medium" as const, sessionId: "session-1" };

		const streamed = captureRequests(sseResponse);
		await streamSimpleAnthropic(model, context, options).result();

		const refreshed = captureRequests(
			() =>
				new Response(
					JSON.stringify({
						id: "msg_2",
						type: "message",
						role: "assistant",
						content: [],
						stop_reason: "max_tokens",
						usage: {
							input_tokens: 4,
							output_tokens: 0,
							cache_read_input_tokens: 6000,
							cache_creation_input_tokens: 0,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const result = await refreshPromptCacheAnthropic(model, context, options);

		expect(refreshed).toEqual([{ ...streamed[0], max_tokens: 0, stream: false }]);
		expect(refreshed[0]?.thinking).toMatchObject({ type: "adaptive" });
		expect(result).toMatchObject({
			status: "refreshed",
			usage: { input: 4, output: 0, cacheRead: 6000, cacheWrite: 0, totalTokens: 6004 },
		});
		// Opus 5.5 cache reads cost $0.20/MTok and input $4/MTok.
		expect(result.status === "refreshed" && result.usage.cost.total).toBeCloseTo((6000 * 0.2 + 4 * 4) / 1e6, 12);
	});

	it("applies onPayload to the replayed request before suppressing output", async () => {
		const model = getModel("anthropic", "claude-opus-5-5");
		const refreshed = captureRequests(
			() =>
				new Response(JSON.stringify({ content: [], usage: { input_tokens: 0, output_tokens: 0 } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		await refreshPromptCacheAnthropic(model, context, {
			apiKey: "sk-ant-api03-test",
			onPayload: (payload) => ({ ...(payload as object), metadata: { user_id: "hooked" }, max_tokens: 99 }),
		});

		expect(refreshed[0]).toMatchObject({ metadata: { user_id: "hooked" }, max_tokens: 0, stream: false });
	});

	it("reports budget-based thinking as unsupported without sending a request", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const requests = captureRequests(sseResponse);

		const result = await refreshPromptCacheAnthropic(model, context, {
			apiKey: "sk-ant-api03-test",
			reasoning: "low",
		});

		expect(result.status).toBe("unsupported");
		expect(requests).toEqual([]);
	});

	it("reports disabled caching as unsupported without sending a request", async () => {
		const model = getModel("anthropic", "claude-opus-5-5");
		const requests = captureRequests(sseResponse);

		const result = await refreshPromptCacheAnthropic(model, context, {
			apiKey: "sk-ant-api03-test",
			cacheRetention: "none",
		});

		expect(result.status).toBe("unsupported");
		expect(requests).toEqual([]);
	});
});
