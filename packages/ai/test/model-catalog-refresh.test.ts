import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getModels, getProviders, getSupportedThinkingLevels } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { Api, Model, SimpleStreamOptions } from "../src/types.ts";

interface RequestPayload {
	model?: string;
	thinking?: { type: string; display?: string };
	output_config?: { effort: string };
	reasoning?: { effort: string };
	reasoning_effort?: string;
	temperature?: number;
	inferenceConfig?: { temperature?: number };
	additionalModelRequestFields?: RequestPayload;
}

async function capturePayload(
	model: Model<Api>,
	reasoning?: SimpleStreamOptions["reasoning"],
): Promise<RequestPayload> {
	let captured: RequestPayload | undefined;
	await streamSimple(
		{ ...model, baseUrl: "http://127.0.0.1:9" },
		{ messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
		{
			apiKey: "fake-key",
			env: {},
			reasoning,
			onPayload: (payload) => {
				captured = payload as RequestPayload;
				throw new Error("payload captured");
			},
		},
	).result();
	if (!captured) throw new Error("Expected payload capture before network request");
	return captured;
}

// https://platform.claude.com/docs/en/models/sonnet-5-5/overview
// https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5
// https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
// Verified 2026-09-28. These tests never send provider requests.
describe("Claude Sonnet 5.5 catalog", () => {
	const nativeModels = [
		getModel("anthropic", "claude-sonnet-5-5"),
		getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5-5"),
	];

	it("exposes documented limits, pricing, and native prompt caching", () => {
		for (const model of nativeModels) {
			expect(model).toMatchObject({
				reasoning: true,
				input: ["text", "image"],
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
				promptCache: {
					modes: ["explicit"],
					retention: { short: { ttlSeconds: 300 }, long: { ttlSeconds: 3_600 } },
				},
			});
		}
	});

	it("exposes low through max, without advertising disabled thinking, across catalog routes", () => {
		const models = getProviders()
			.flatMap((provider) => getModels(provider) as Model<Api>[])
			.filter((model) => /sonnet[-.]5[-.]5/.test(model.id));
		expect(models.map((model) => `${model.provider}/${model.id}`)).toEqual(
			expect.arrayContaining([
				"anthropic/claude-sonnet-5-5",
				"amazon-bedrock/global.anthropic.claude-sonnet-5-5",
				"opencode/claude-sonnet-5-5",
				"openrouter/anthropic/claude-sonnet-5.5",
				"vercel-ai-gateway/anthropic/claude-sonnet-5.5",
			]),
		);
		for (const model of models) {
			expect(getSupportedThinkingLevels(model), `${model.provider}/${model.id}`).toEqual([
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
			]);
			expect(clampThinkingLevel(model, "off")).toBe("low");
			if (model.api === "anthropic-messages") {
				expect(model.compat).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false });
			}
		}
	});

	it.each(["low", "medium", "high", "xhigh", "max"] as const)(
		"sends adaptive thinking at %s effort",
		async (reasoning) => {
			for (const model of nativeModels) {
				const payload = await capturePayload(model, reasoning);
				const thinkingPayload =
					model.api === "bedrock-converse-stream" ? payload.additionalModelRequestFields : payload;
				expect(thinkingPayload?.thinking).toEqual({ type: "adaptive", display: "summarized" });
				expect(thinkingPayload?.output_config).toEqual({ effort: reasoning });
			}
		},
	);

	it("does not send rejected disabled thinking when no effort is requested", async () => {
		for (const model of nativeModels) {
			const payload = await capturePayload(model);
			expect(payload.thinking).toBeUndefined();
			expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
		}
	});
});

describe("Daybreak catalog aliases", () => {
	it.each(["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"] as const)("maps reasoning for %s", async (id) => {
		const model = getModel("openai", id);
		expect(model.api).toBe("openai-responses");
		expect(model.input).toEqual(["text", "image"]);
		expect(model.maxTokens).toBe(128_000);
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		for (const [reasoning, effort] of [
			[undefined, "none"],
			["minimal", "low"],
			["xhigh", "xhigh"],
			["max", "max"],
		] as const) {
			const payload = await capturePayload(model, reasoning);
			expect(payload.model).toBe(id);
			expect(payload.reasoning).toMatchObject({ effort });
		}
	});
});

// https://api-docs.deepseek.com/api/list-models/
// https://api-docs.deepseek.com/api/create-chat-completion/
// https://api-docs.deepseek.com/quick_start/pricing/
describe("current direct DeepSeek catalog", () => {
	it("lists V4.1 Flash with vision and published off-peak prices", () => {
		for (const id of ["deepseek-flash", "deepseek-v4-flash"] as const) {
			expect(getModel("deepseek", id)).toMatchObject({
				name: "DeepSeek V4.1 Flash",
				api: "openai-completions",
				input: ["text", "image"],
				cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
			});
		}
		expect(getModel("deepseek", "deepseek-v4-pro").cost).toEqual({
			input: 0.66,
			output: 1.98,
			cacheRead: 0.022,
			cacheWrite: 0,
		});
	});

	it.each(["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"] as const)(
		"sends supported reasoning for %s",
		async (id) => {
			const model = getModel("deepseek", id);
			expect(model.contextWindow).toBe(1_048_576);
			expect(model.maxTokens).toBe(393_216);
			expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
			for (const reasoning of ["low", "high", "max"] as const) {
				const payload = await capturePayload(model, reasoning);
				expect(payload.thinking).toEqual({ type: "enabled" });
				expect(payload.reasoning_effort).toBe(reasoning);
			}
			const offPayload = await capturePayload(model);
			expect(offPayload.thinking).toEqual({ type: "disabled" });
		},
	);
});
