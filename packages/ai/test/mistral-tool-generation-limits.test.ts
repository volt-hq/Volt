import { describe, expect, it, vi } from "vitest";
import { streamMistral } from "../src/providers/mistral.ts";
import type { Model } from "../src/types.ts";
import type { JsonObject } from "../src/utils/json-value.ts";

const mock = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock("@mistralai/mistralai", () => ({
	Mistral: class {
		chat = { stream: mock.stream };
	},
}));

const model: Model<"mistral-conversations"> = {
	id: "test-mistral",
	name: "Test Mistral",
	api: "mistral-conversations",
	provider: "mistral",
	baseUrl: "https://mistral.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 16000,
	maxTokens: 4000,
};

function chunk(index: number, args: JsonObject) {
	return {
		data: {
			choices: [
				{
					index: 0,
					delta: {
						toolCalls: [
							{
								index,
								id: `call-${index}`,
								function: { name: "edit", arguments: args },
							},
						],
					},
				},
			],
		},
	};
}

describe("Mistral native argument replacement limits", () => {
	it("charges interleaved replacements before retaining them or waiting for EOF", async () => {
		let requestSignal: AbortSignal | undefined;
		const reachedEof = vi.fn();
		const closed = vi.fn();
		let release = () => {};
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		mock.stream.mockImplementation(async (_payload, options: { signal: AbortSignal }) => {
			requestSignal = options.signal;
			options.signal.addEventListener("abort", release, { once: true });
			return (async function* () {
				try {
					yield chunk(0, {});
					yield chunk(1, {});
					yield chunk(0, { text: "x".repeat(50) });
					yield chunk(1, { text: "y".repeat(50) });
					await pending;
					reachedEof();
				} finally {
					options.signal.removeEventListener("abort", release);
					closed();
				}
			})();
		});
		try {
			const stream = streamMistral(
				model,
				{ messages: [] },
				{
					apiKey: "test",
					toolArgumentLimits: { maxBytes: 64, maxTotalBytes: 80, maxDurationMs: 1000 },
				},
			);
			const result = await stream.result();
			expect(result).toMatchObject({
				stopReason: "error",
				diagnostics: [
					expect.objectContaining({
						type: "tool_argument_generation_limit",
						details: expect.objectContaining({ limit: "maxTotalBytes", contentIndex: 1 }),
					}),
				],
			});
			expect(requestSignal?.aborted).toBe(true);
			await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
			expect(reachedEof).not.toHaveBeenCalled();
			expect(result.content).toMatchObject([{ arguments: {} }, { arguments: {} }]);
		} finally {
			release();
		}
	});

	it("does not count the first serialized native preview twice", async () => {
		mock.stream.mockImplementation(async () =>
			(async function* () {
				yield chunk(0, { a: 1 });
				yield { data: { choices: [{ index: 0, delta: {}, finishReason: "tool_calls" }] } };
			})(),
		);
		const result = await streamMistral(
			model,
			{ messages: [] },
			{
				apiKey: "test",
				toolArgumentLimits: { maxBytes: 7, maxTotalBytes: 7 },
			},
		).result();
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({ arguments: { a: 1 } });
	});
});
