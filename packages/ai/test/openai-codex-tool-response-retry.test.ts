import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import {
	closeOpenAICodexWebSocketSessions,
	getOpenAICodexWebSocketDebugStats,
	resetOpenAICodexWebSocketDebugStats,
	streamOpenAICodexResponses,
} from "../src/providers/openai-codex-responses.ts";
import type { Context } from "../src/types.ts";

const model = getModel("openai-codex", "gpt-5.4");
const context: Context = { messages: [{ role: "user", content: "write the report", timestamp: 0 }] };
const payload = Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } }),
).toString("base64");
const token = `test.${payload}.test`;
const partialEvents = [
	{
		type: "response.output_item.added",
		output_index: 0,
		item: {
			type: "function_call",
			id: "fc_failed",
			call_id: "failed",
			name: "write",
			arguments: "",
			status: "in_progress",
		},
	},
	{
		type: "response.function_call_arguments.delta",
		output_index: 0,
		delta: '{"path":"report.md","content":"unfinished',
	},
];

function sse(events: Record<string, unknown>[]): string {
	return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}`;
}

afterEach(() => {
	closeOpenAICodexWebSocketSessions();
	resetOpenAICodexWebSocketDebugStats();
	vi.unstubAllGlobals();
});

describe("Codex interrupted tool response recovery", () => {
	it("preserves the WebSocket failure and uses SSE for the next request in the same session", async () => {
		const connected = vi.fn();
		class InterruptedWebSocket extends EventTarget {
			constructor() {
				super();
				connected();
				queueMicrotask(() => this.dispatchEvent(new Event("open")));
			}
			send(): void {
				queueMicrotask(() => {
					for (const event of partialEvents)
						this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) }));
					this.dispatchEvent(new Event("error"));
				});
			}
			close(): void {}
		}
		vi.stubGlobal("WebSocket", InterruptedWebSocket);
		const item = {
			type: "function_call",
			id: "fc_replacement",
			call_id: "replacement",
			name: "write",
			arguments: '{"path":"report.md","content":"complete report"}',
			status: "completed",
		};
		const fetchMock = vi.fn(
			async () =>
				new Response(
					sse([
						{
							type: "response.output_item.added",
							output_index: 0,
							item: { ...item, arguments: "", status: "in_progress" },
						},
						{ type: "response.output_item.done", output_index: 0, item },
						{ type: "response.completed", response: { status: "completed" } },
					]),
					{ status: 200, headers: { "content-type": "text/event-stream" } },
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const options = { apiKey: token, sessionId: "interrupted-tool-response", transport: "auto" as const };

		const failed = await streamOpenAICodexResponses(model, context, options).result();

		expect(failed).toMatchObject({ stopReason: "error", errorMessage: "WebSocket error" });
		expect(failed.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "write" }));
		expect(failed.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "provider_transport_failure",
				error: expect.objectContaining({ message: "WebSocket error" }),
				details: expect.objectContaining({ eventsEmitted: true, phase: "after_message_stream_start" }),
			}),
		);
		expect(failed.diagnostics?.some((diagnostic) => diagnostic.type === "invalid_tool_arguments")).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(getOpenAICodexWebSocketDebugStats(options.sessionId)).toMatchObject({ websocketFallbackActive: true });

		const replacement = await streamOpenAICodexResponses(model, context, options).result();

		expect(connected).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(replacement).toMatchObject({
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					id: "replacement|fc_replacement",
					name: "write",
					arguments: { path: "report.md", content: "complete report" },
				},
			],
		});
	});

	it("preserves an SSE body failure during tool arguments without misclassifying it as invalid JSON", async () => {
		let sent = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent) {
					controller.error(new TypeError("fetch failed"));
					return;
				}
				sent = true;
				controller.enqueue(new TextEncoder().encode(sse(partialEvents)));
			},
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(body, { status: 200 })),
		);
		const result = await streamOpenAICodexResponses(model, context, { apiKey: token, transport: "sse" }).result();
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "fetch failed" });
		expect(result.content).toContainEqual(expect.objectContaining({ type: "toolCall", name: "write" }));
		expect(result.diagnostics?.some((diagnostic) => diagnostic.type === "invalid_tool_arguments")).not.toBe(true);
	});
});
