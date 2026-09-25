import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";

const model: Model<"openai-codex-responses"> = {
	id: "test-codex",
	name: "Test Codex",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16_000,
	maxTokens: 4000,
};
const mockToken = `test.${Buffer.from(
	JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "test-account" },
	}),
).toString("base64")}.test`;
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
});

function installBody(progressing: boolean, finalArguments?: string, incompleteItem = false) {
	const cancelled = vi.fn();
	let producer: ReturnType<typeof setInterval> | undefined;
	const encode = (event: Record<string, unknown>) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(
				encode({
					type: "response.output_item.added",
					output_index: 0,
					item: {
						type: "function_call",
						id: "fc_test",
						call_id: "call_test",
						name: "edit",
						arguments: "",
					},
				}),
			);
			if (finalArguments !== undefined) {
				controller.enqueue(
					encode(
						incompleteItem
							? {
									type: "response.output_item.done",
									output_index: 0,
									item: {
										type: "function_call",
										id: "fc_test",
										call_id: "call_test",
										name: "edit",
										status: "incomplete",
										arguments: finalArguments,
									},
								}
							: {
									type: "response.function_call_arguments.done",
									output_index: 0,
									name: "edit",
									arguments: finalArguments,
								},
					),
				);
			} else if (progressing) {
				producer = setInterval(
					() =>
						controller.enqueue(
							encode({
								type: "response.function_call_arguments.delta",
								output_index: 0,
								delta: " ",
							}),
						),
					1,
				);
			}
		},
		cancel() {
			if (producer !== undefined) clearInterval(producer);
			cancelled();
		},
	});
	cleanups.push(() => {
		if (producer !== undefined) clearInterval(producer);
	});
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		}),
	);
	return cancelled;
}

describe("Codex tool generation transport shutdown", () => {
	it.each([true, false])(
		"cancels the response reader at the absolute deadline (progressing=%s)",
		async (progressing) => {
			const cancelled = installBody(progressing);
			const stream = streamOpenAICodexResponses(
				model,
				{ messages: [] },
				{
					apiKey: mockToken,
					transport: "sse",
					toolArgumentLimits: { maxDurationMs: 30 },
				},
			);
			const events: AssistantMessageEvent[] = [];
			for await (const event of stream) events.push(event);
			const message = await stream.result();
			expect(message.stopReason).toBe("error");
			expect(message.diagnostics).toContainEqual(
				expect.objectContaining({
					type: "tool_argument_generation_limit",
					details: expect.objectContaining({ limit: "maxDurationMs" }),
				}),
			);
			expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
			await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
		},
		2000,
	);

	it("rejects oversized authoritative arguments before waiting for output-item completion", async () => {
		const cancelled = installBody(false, `{"text":"${"private".repeat(1000)}"}`);
		const stream = streamOpenAICodexResponses(
			model,
			{ messages: [] },
			{
				apiKey: mockToken,
				transport: "sse",
				toolArgumentLimits: { maxBytes: 32 },
			},
		);
		const message = await stream.result();
		expect(message.stopReason).toBe("error");
		expect(message.diagnostics?.[0]?.details).toMatchObject({ limit: "maxBytes" });
		expect(JSON.stringify(message)).not.toContain("private");
		await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
	}, 2000);

	it("bounds an incomplete output item's arguments even though it cannot complete the tool call", async () => {
		const cancelled = installBody(false, `{"text":"${"private".repeat(1000)}"}`, true);
		const stream = streamOpenAICodexResponses(
			model,
			{ messages: [] },
			{
				apiKey: mockToken,
				transport: "sse",
				toolArgumentLimits: { maxBytes: 32 },
			},
		);
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const message = await stream.result();
		expect(message.stopReason).toBe("error");
		expect(message.diagnostics?.[0]?.details).toMatchObject({ limit: "maxBytes" });
		expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
		expect(JSON.stringify(message)).not.toContain("private");
		await vi.waitFor(() => expect(cancelled).toHaveBeenCalledOnce());
	}, 2000);
});
