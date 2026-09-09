import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";

describe("Anthropic tool generation limit cancellation", () => {
	it.each(["silent", "oversize-native"] as const)(
		"cancels a %s SSE body and preserves the limit failure",
		async (kind) => {
			const cancel = vi.fn();
			const input = kind === "oversize-native" ? { text: "private-input".repeat(100) } : {};
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const event of [
						{ type: "message_start", message: { id: "msg", usage: { input_tokens: 1, output_tokens: 0 } } },
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "tool_use", id: "call", name: "edit", input },
						},
					]) {
						controller.enqueue(
							new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
						);
					}
				},
				cancel,
			});
			let requestSignal: AbortSignal | undefined;
			const client = {
				messages: {
					create: (_params: unknown, options: { signal?: AbortSignal }) => {
						requestSignal = options.signal;
						return { asResponse: async () => new Response(body) };
					},
				},
			} as unknown as Anthropic;
			const stream = streamAnthropic(
				getModel("anthropic", "claude-haiku-4-5"),
				{ messages: [] },
				{
					client,
					toolArgumentLimits: { maxBytes: 32, maxDurationMs: 30 },
				},
			);
			const result = await stream.result();
			await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
			expect(requestSignal?.aborted).toBe(true);
			expect(result).toMatchObject({
				stopReason: "error",
				diagnostics: [
					expect.objectContaining({
						type: "tool_argument_generation_limit",
						details: expect.objectContaining({ limit: kind === "silent" ? "maxDurationMs" : "maxBytes" }),
					}),
				],
			});
			expect(JSON.stringify(result)).not.toContain("private-input");
		},
	);
});
