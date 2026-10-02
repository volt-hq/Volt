import type * as BedrockRuntime from "@aws-sdk/client-bedrock-runtime";
import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamBedrock } from "../src/providers/amazon-bedrock.ts";
import { streamAnthropic } from "../src/providers/anthropic.ts";
import { fauxAssistantMessage, registerFauxProvider } from "../src/providers/faux.ts";
import { streamGoogle } from "../src/providers/google.ts";
import { streamGoogleVertex } from "../src/providers/google-vertex.ts";
import { streamMistral } from "../src/providers/mistral.ts";
import { streamOpenAICompletions } from "../src/providers/openai-completions.ts";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import { stream } from "../src/stream.ts";
import type { AssistantMessageEvent, Context, Usage } from "../src/types.ts";
import { drainEventStream } from "../src/utils/event-stream.ts";

const mock = vi.hoisted(() => ({ chunks: [] as unknown[] }));

async function* chunks() {
	for (const chunk of mock.chunks) {
		if (chunk instanceof Error) throw chunk;
		if (typeof chunk === "function") chunk();
		else yield chunk;
	}
}

vi.mock("openai", () => ({
	default: class {
		chat = {
			completions: {
				create: () => ({
					withResponse: async () => ({ data: chunks(), response: { status: 200, headers: new Headers() } }),
				}),
			},
		};
	},
}));
vi.mock("@anthropic-ai/sdk", () => ({
	default: class {
		messages = {
			create: () => ({
				asResponse: async () =>
					new Response(
						mock.chunks
							.map((chunk) => {
								if (chunk instanceof Error) return `event: error\ndata: ${JSON.stringify(chunk.message)}\n\n`;
								const event = chunk as { type: string };
								return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
							})
							.join(""),
					),
			}),
		};
	},
}));
vi.mock("@mistralai/mistralai", () => ({
	Mistral: class {
		chat = { stream: async () => chunks() };
	},
}));
vi.mock("@google/genai", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	GoogleGenAI: class {
		models = { generateContentStream: async () => chunks() };
	},
}));
vi.mock("@aws-sdk/client-bedrock-runtime", async (importOriginal) => ({
	...(await importOriginal<typeof BedrockRuntime>()),
	BedrockRuntimeClient: class {
		send = async () => ({ $metadata: {}, stream: chunks() });
	},
}));

const context: Context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] };
const base = {
	id: "test-model",
	name: "Test",
	baseUrl: "https://example.invalid/v1",
	reasoning: false,
	input: ["text" as const],
	cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1.25 },
	contextWindow: 1000,
	maxTokens: 100,
};
const init = { api: "test", provider: "test", model: "test", timestamp: 0 };
const zero: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Provider = "openai" | "mistral" | "google" | "vertex" | "anthropic" | "bedrock" | "responses";
function usageEvent(
	provider: Provider,
	count: number | "empty" | undefined | Record<string, number | null>,
	final: boolean,
): unknown {
	const value = count === "empty" ? undefined : count;
	const usage =
		count === undefined
			? undefined
			: count === "empty"
				? {}
				: typeof count === "object"
					? count
					: provider === "anthropic" || provider === "responses"
						? { input_tokens: value, output_tokens: value, total_tokens: 2 * count }
						: provider === "openai"
							? { prompt_tokens: value, completion_tokens: value, total_tokens: 2 * count }
							: provider === "mistral"
								? { promptTokens: value, completionTokens: value, totalTokens: 2 * count }
								: provider === "bedrock"
									? { inputTokens: value, outputTokens: value, totalTokens: 2 * count }
									: { promptTokenCount: value, candidatesTokenCount: value, totalTokenCount: 2 * count };
	switch (provider) {
		case "openai":
			return { usage, choices: [{ delta: { content: "ok" }, finish_reason: final ? "stop" : null }] };
		case "mistral":
			return { data: { usage, choices: [{ delta: { content: "ok" }, finishReason: final ? "stop" : null }] } };
		case "google":
		case "vertex":
			return {
				usageMetadata: usage,
				candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: final ? "STOP" : undefined }],
			};
		case "anthropic":
			return final
				? { type: "message_delta", delta: { stop_reason: "end_turn" }, usage }
				: { type: "message_start", message: { id: "msg-1", usage } };
		case "bedrock":
			return { metadata: { usage } };
		case "responses":
			return {
				type: final ? "response.completed" : "response.in_progress",
				response: { id: "resp-1", status: final ? "completed" : "in_progress", usage },
			};
	}
}

function run(provider: Provider, signal?: AbortSignal) {
	const options = { apiKey: "test", signal };
	switch (provider) {
		case "openai":
			return streamOpenAICompletions({ ...base, api: "openai-completions", provider }, context, options);
		case "mistral":
			return streamMistral({ ...base, api: "mistral-conversations", provider }, context, options);
		case "google":
			return streamGoogle({ ...base, api: "google-generative-ai", provider }, context, options);
		case "vertex":
			return streamGoogleVertex({ ...base, api: "google-vertex", provider }, context, options);
		case "anthropic":
			return streamAnthropic({ ...base, api: "anthropic-messages", provider }, context, options);
		case "bedrock":
			return streamBedrock({ ...base, api: "bedrock-converse-stream", provider }, context, options);
		case "responses": {
			const normalizer = new AssistantStreamNormalizer(options);
			normalizer.push({ type: "start", init });
			void (async () => {
				try {
					const result = await processResponsesStream(chunks() as AsyncIterable<ResponseStreamEvent>, normalizer, {
						...base,
						api: "openai-responses",
						provider,
					});
					normalizer.push({ type: "done", reason: result.stopReason as "stop" });
				} catch (error) {
					normalizer.push({
						type: "error",
						reason: signal?.aborted ? "aborted" : "error",
						errorMessage: String(error),
					});
				}
			})();
			return normalizer.stream;
		}
	}
}

function endEvents(provider: Provider): unknown[] {
	return provider === "anthropic"
		? [{ type: "message_stop" }]
		: provider === "bedrock"
			? [{ messageStop: { stopReason: "end_turn" } }]
			: [];
}

describe.each<Provider>(["openai", "mistral", "google", "vertex", "anthropic", "bedrock", "responses"])(
	"%s usage evidence",
	(provider) => {
		it.each([undefined, "empty"] as const)(
			"does not mistake missing counts (%s) for reported zero",
			async (count) => {
				mock.chunks = [usageEvent(provider, count, true), ...endEvents(provider)];
				const result = await drainEventStream(run(provider));
				expect(result.stopReason).toBe("stop");
				expect(result.usage.availability).toBe("unavailable");
				expect(result.usage.totalTokens).toBe(0);
			},
		);

		it.each([0, 7])("recognizes provider-final counts of %s", async (count) => {
			mock.chunks = [usageEvent(provider, count, true), ...endEvents(provider)];
			const result = await drainEventStream(run(provider));
			expect(result.usage).toMatchObject({
				availability: "complete",
				input: count,
				output: count,
				totalTokens: 2 * count,
			});
			expect(result.usage.cost.total).toBeCloseTo((3 * count) / 1_000_000);
		});

		const [inputField, outputField, auxiliaryField] = {
			openai: ["prompt_tokens", "completion_tokens", "total_tokens"],
			mistral: ["promptTokens", "completionTokens", "totalTokens"],
			google: ["promptTokenCount", "candidatesTokenCount", "totalTokenCount"],
			vertex: ["promptTokenCount", "candidatesTokenCount", "totalTokenCount"],
			anthropic: ["input_tokens", "output_tokens", "cache_read_input_tokens"],
			bedrock: ["inputTokens", "outputTokens", "totalTokens"],
			responses: ["input_tokens", "output_tokens", "total_tokens"],
		}[provider];

		it.each([0, 7])("requires raw input and output counters, including zero (%s)", async (count) => {
			for (const reported of [
				{ [inputField]: count },
				{ [outputField]: count },
				{ [auxiliaryField]: count },
				{ [inputField]: count, [outputField]: null },
				{ [inputField]: null, [outputField]: count },
				{ [inputField]: count, [auxiliaryField]: count },
				{ [outputField]: count, [auxiliaryField]: count },
			]) {
				mock.chunks = [usageEvent(provider, reported, true), ...endEvents(provider)];
				const result = await drainEventStream(run(provider));
				expect(result.stopReason).toBe("stop");
				expect(result.usage.availability, JSON.stringify(reported)).toBe("partial");
				// Missing counters keep their existing numeric defaults, not reported-zero evidence.
				expect(result.usage.input).toBe(reported[inputField] ?? 0);
				expect(result.usage.output).toBe(reported[outputField] ?? 0);

				mock.chunks = [usageEvent(provider, reported, true), new Error("interrupted after usage")];
				const failed = await drainEventStream(run(provider));
				expect(failed.stopReason).toBe("error");
				expect(failed.errorMessage).toContain("interrupted after usage");
				expect(failed.usage).toStrictEqual(result.usage);
			}
		});

		it("replaces cumulative usage instead of adding snapshots", async () => {
			mock.chunks = [usageEvent(provider, 3, false), usageEvent(provider, 7, true), ...endEvents(provider)];
			const result = await drainEventStream(run(provider));
			expect(result.usage).toMatchObject({ availability: "complete", input: 7, output: 7, totalTokens: 14 });
		});

		it("marks failures before usage unavailable", async () => {
			mock.chunks = [new Error("failed before usage")];
			const result = await drainEventStream(run(provider));
			expect(result.stopReason).toBe("error");
			expect(result.usage.availability).toBe("unavailable");
		});

		it.each([0, 3])("retains reported counts of %s on stream failure", async (count) => {
			mock.chunks = [usageEvent(provider, count, false), new Error("interrupted")];
			const result = await drainEventStream(run(provider));
			expect(result.stopReason).toBe("error");
			expect(result.usage).toMatchObject({
				availability: provider === "bedrock" ? "complete" : "partial",
				input: count,
				output: count,
			});
		});

		if (provider !== "bedrock")
			it("does not promote earlier counts when the final event omits usage", async () => {
				mock.chunks = [
					usageEvent(provider, 3, false),
					usageEvent(provider, undefined, true),
					...endEvents(provider),
				];
				const result = await drainEventStream(run(provider));
				expect(result.usage).toMatchObject({ availability: "partial", input: 3, output: 3 });
			});

		if (["openai", "mistral", "google", "vertex"].includes(provider))
			it("retains interim usage on abort", async () => {
				const controller = new AbortController();
				mock.chunks = [usageEvent(provider, 3, false), () => controller.abort(), new Error("aborted")];
				const result = await drainEventStream(run(provider, controller.signal));
				expect(result.stopReason).toBe("aborted");
				expect(result.usage).toMatchObject({ availability: "partial", input: 3, output: 3 });
			});
	},
);

describe("provider-specific usage events", () => {
	it("does not present a requested Responses tier as provider-confirmed while preserving pricing fallback", async () => {
		mock.chunks = [usageEvent("responses", 3, true)];
		const normalizer = new AssistantStreamNormalizer();
		normalizer.push({ type: "start", init });
		const applyServiceTierPricing = vi.fn();
		await processResponsesStream(
			chunks() as AsyncIterable<ResponseStreamEvent>,
			normalizer,
			{
				...base,
				api: "openai-responses",
				provider: "openai",
			},
			{ serviceTier: "priority", applyServiceTierPricing },
		);
		normalizer.push({ type: "done", reason: "stop" });
		const result = await drainEventStream(normalizer.stream);
		expect(result.usage.serviceTier).toEqual({ requested: "priority" });
		expect(applyServiceTierPricing).toHaveBeenCalledWith(expect.anything(), "priority");
	});

	it("accepts Completions usage-only terminal chunks", async () => {
		mock.chunks = [
			usageEvent("openai", undefined, true),
			{ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
		];
		expect((await drainEventStream(run("openai"))).usage.availability).toBe("complete");
	});

	it("accepts Completions choice-level usage", async () => {
		mock.chunks = [
			{ choices: [{ delta: {}, finish_reason: "stop", usage: { prompt_tokens: 2, completion_tokens: 3 } }] },
		];
		expect((await drainEventStream(run("openai"))).usage).toMatchObject({
			availability: "complete",
			input: 2,
			output: 3,
		});
	});

	it("preserves Anthropic input counts when only final output counts arrive", async () => {
		mock.chunks = [
			usageEvent("anthropic", 3, false),
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
			...endEvents("anthropic"),
		];
		expect((await drainEventStream(run("anthropic"))).usage).toMatchObject({
			availability: "complete",
			input: 3,
			output: 0,
			totalTokens: 3,
		});
	});

	it.each([0, 3])("requires Anthropic reported input before accepting final output of %s", async (count) => {
		mock.chunks = [
			usageEvent("anthropic", { output_tokens: count }, false),
			usageEvent("anthropic", { output_tokens: count }, true),
			...endEvents("anthropic"),
		];
		expect((await drainEventStream(run("anthropic"))).usage).toMatchObject({
			availability: "partial",
			input: 0,
			output: count,
		});
	});

	it("does not treat Anthropic initial output as a final report", async () => {
		mock.chunks = [
			usageEvent("anthropic", 3, false),
			usageEvent("anthropic", { input_tokens: 3 }, true),
			...endEvents("anthropic"),
		];
		expect((await drainEventStream(run("anthropic"))).usage.availability).toBe("partial");
	});

	it.each<Provider>(["google", "vertex"])(
		"requires %s candidate counts even with reasoning counts",
		async (provider) => {
			mock.chunks = [usageEvent(provider, { promptTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 5 }, true)];
			expect((await drainEventStream(run(provider))).usage).toMatchObject({
				availability: "partial",
				input: 3,
				output: 2,
			});
		},
	);

	it.each([{ total_tokens: 3 }, { prompt_tokens: 2 }, { completion_tokens: 1 }])(
		"requires complete counters on Completions choice-level usage: %j",
		async (usage) => {
			mock.chunks = [{ choices: [{ delta: {}, finish_reason: "stop", usage }] }];
			expect((await drainEventStream(run("openai"))).usage.availability).toBe("partial");
		},
	);

	it("captures usage carried by a failed Responses event", async () => {
		mock.chunks = [
			{
				type: "response.failed",
				response: { usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 }, error: { message: "failed" } },
			},
		];
		const result = await drainEventStream(run("responses"));
		expect(result.stopReason).toBe("error");
		expect(result.usage).toMatchObject({ availability: "partial", input: 2, output: 1 });
	});
});

describe("normalizer usage evidence", () => {
	it("marks synthetic defaults unavailable", async () => {
		const normalizer = new AssistantStreamNormalizer();
		normalizer.end();
		expect((await drainEventStream(normalizer.stream)).usage.availability).toBe("unavailable");
	});

	it.each(["stop", "error", "aborted"] as const)("preserves unknown custom usage on %s", async (reason) => {
		const normalizer = new AssistantStreamNormalizer();
		normalizer.push({ type: "start", init });
		const usage = { ...zero, input: 12, totalTokens: 12 };
		if (reason === "stop") normalizer.push({ type: "done", reason, usage });
		else normalizer.push({ type: "error", reason, errorMessage: "failure", usage });
		const result = await drainEventStream(normalizer.stream);
		expect(result.usage).not.toHaveProperty("availability");
		expect(result.usage).toStrictEqual(usage);
		expect(JSON.parse(JSON.stringify(result))).toStrictEqual(result);
	});

	it("omits unknown availability from custom meta patches and canonical JSON snapshots", async () => {
		const normalizer = new AssistantStreamNormalizer();
		normalizer.push({ type: "start", init });
		normalizer.push({ type: "meta", patch: { usage: { input: 12, totalTokens: 12 } } });
		normalizer.push({ type: "text_delta", contentIndex: 0, delta: "ok" });
		normalizer.push({ type: "meta", patch: { usage: { cost: { total: 0.1 } } } });
		normalizer.push({ type: "done", reason: "stop" });
		for await (const event of normalizer.stream) {
			expect(JSON.parse(JSON.stringify(event))).toStrictEqual(event);
			if ("snapshot" in event && event.type !== "start") {
				expect(event.snapshot.usage).not.toHaveProperty("availability");
			}
		}
		const result = await normalizer.stream.result();
		expect(result.usage).not.toHaveProperty("availability");
		expect(result.usage).toMatchObject({ input: 12, totalTokens: 12, cost: { total: 0.1 } });
	});

	it("preserves partial evidence and immutable cumulative snapshots through failure", async () => {
		const normalizer = new AssistantStreamNormalizer();
		normalizer.push({ type: "start", init });
		for (const input of [2, 5]) {
			normalizer.push({
				type: "meta",
				patch: { usage: { ...zero, availability: "partial", input, totalTokens: input } },
			});
			normalizer.push({ type: "text_delta", contentIndex: 0, delta: "ok" });
		}
		normalizer.push({ type: "meta", patch: { usage: { cost: { total: 0.1 } } } });
		normalizer.push({ type: "error", reason: "aborted", errorMessage: "aborted" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of normalizer.stream) events.push(event);
		expect(events.filter((event) => event.type === "text_delta").map((event) => event.snapshot.usage.input)).toEqual([
			2, 5,
		]);
		expect((await normalizer.stream.result()).usage).toMatchObject({
			availability: "partial",
			input: 5,
			totalTokens: 5,
		});
	});
});

const registrations: ReturnType<typeof registerFauxProvider>[] = [];
afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});
describe("faux usage fixtures", () => {
	it.each([undefined, "complete", "partial", "unavailable"] as const)(
		"preserves explicit usage with %s availability",
		async (availability) => {
			const registration = registerFauxProvider();
			registrations.push(registration);
			const usage: Usage = { ...zero, ...(availability === undefined ? {} : { availability }) };
			registration.setResponses([fauxAssistantMessage("a nonempty answer", { usage })]);
			expect((await drainEventStream(stream(registration.getModel(), context))).usage).toEqual(usage);
		},
	);

	it("preserves explicit helper-default usage instead of generating estimates", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const usage = fauxAssistantMessage("").usage;
		registration.setResponses([fauxAssistantMessage("ok", { usage })]);
		expect((await drainEventStream(stream(registration.getModel(), context))).usage).toEqual(usage);
	});

	it("preserves supplied counts, costs and metadata on an error", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		const usage: Usage = {
			...zero,
			availability: "partial",
			input: 9,
			output: 3,
			cacheRead: 2,
			cacheWrite: 1,
			cacheWrite1h: 1,
			totalTokens: 15,
			cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
			serviceTier: { requested: "priority", effective: "default" },
		};
		registration.setResponses([
			fauxAssistantMessage("partial", { usage, stopReason: "error", errorMessage: "failed" }),
		]);
		expect((await drainEventStream(stream(registration.getModel(), context))).usage).toEqual(usage);
	});

	it("marks generated estimates complete and synthetic failures unavailable", async () => {
		const registration = registerFauxProvider();
		registrations.push(registration);
		registration.setResponses([fauxAssistantMessage("ok")]);
		expect((await drainEventStream(stream(registration.getModel(), context))).usage.availability).toBe("complete");
		expect((await drainEventStream(stream(registration.getModel(), context))).usage.availability).toBe("unavailable");
	});
});
