import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.ts";
import { getOpenAIPriorityCost, supportsFastInference } from "../src/providers/openai-fast-inference.ts";
import type { Api, Model, SimpleStreamOptions, Usage } from "../src/types.ts";
import { streamSimple } from "./test-client.ts";

// https://developers.openai.com/api/docs/models/gpt-6.1-terra
// https://developers.openai.com/api/docs/guides/prompt-caching
// https://github.com/openai/codex/blob/126a0ee92ed2c5e73cd8a8f7e37563e8527552d7/codex-rs/models-manager/models.json
// https://developers.openai.com/codex/speed
// Verified 2026-11-17. These tests never send provider requests.
const cost = { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 };
const apiLevels = ["off", "low", "medium", "high", "xhigh", "max"];

interface ReasoningPayload {
	reasoning?: { effort?: string };
}

async function captureReasoning(
	model: Model<Api>,
	reasoning: SimpleStreamOptions["reasoning"],
): Promise<ReasoningPayload["reasoning"]> {
	let captured: ReasoningPayload | undefined;
	await streamSimple(
		{ ...model, baseUrl: "http://127.0.0.1:9" },
		{ messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
		{
			apiKey: "fake-key",
			env: {},
			reasoning,
			onPayload: (payload) => {
				captured = payload as ReasoningPayload;
				throw new Error("payload captured");
			},
		},
	).result();
	if (!captured) throw new Error("Expected payload capture before network request");
	return captured.reasoning;
}

describe("GPT-6.1 Terra metadata", () => {
	it.each(["openai", "azure-openai-responses"] as const)("exposes API capabilities through %s", (provider) => {
		const model = getModel(provider, "gpt-6.1-terra");
		expect(model).toMatchObject({
			name: "GPT-6.1 Terra",
			reasoning: true,
			input: ["text", "image"],
			cost,
			contextWindow: 1_050_000,
			maxTokens: 128_000,
		});
		expect(model.promptCache).toEqual({
			modes: ["implicit", "explicit"],
			retention: { short: { ttlSeconds: 1_800 } },
			refreshesOnHit: true,
		});
		expect(getSupportedThinkingLevels(model)).toEqual(apiLevels);
	});

	it("uses the 500k Codex default context, low through max, and Fast tier", () => {
		const model = getModel("openai-codex", "gpt-6.1-terra");
		expect(model).toMatchObject({
			name: "GPT-6.1 Terra",
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			contextWindow: 500_000,
			maxTokens: 128_000,
			cost,
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(supportsFastInference(model)).toBe(true);
	});

	it.each(["openai/gpt-6.1-terra", "openai/gpt-6.1-terra-pro"] as const)(
		"offers xhigh and max without minimal through OpenRouter %s",
		(id) => {
			expect(getSupportedThinkingLevels(getModel("openrouter", id))).toEqual(apiLevels);
		},
	);

	it("supports Fast mode at the documented double API rate", () => {
		const model = getModel("openai", "gpt-6.1-terra");
		const usage: Usage = {
			availability: "complete",
			input: 1_000,
			output: 1_000,
			cacheRead: 1_000,
			cacheWrite: 1_000,
			totalTokens: 4_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		expect(supportsFastInference(model)).toBe(true);
		expect(getOpenAIPriorityCost(usage, model)).toMatchObject({
			input: cost.input / 500,
			output: cost.output / 500,
			cacheRead: cost.cacheRead / 500,
			cacheWrite: cost.cacheWrite / 500,
		});
	});

	it.each([
		{ reasoning: undefined, effort: "none" },
		{ reasoning: "minimal", effort: "low" },
		{ reasoning: "xhigh", effort: "xhigh" },
		{ reasoning: "max", effort: "max" },
	] satisfies { reasoning: SimpleStreamOptions["reasoning"]; effort: string }[])(
		"sends effort=$effort and never the unsupported minimal effort",
		async ({ reasoning, effort }) => {
			for (const model of [getModel("openai", "gpt-6.1-terra"), getModel("openrouter", "openai/gpt-6.1-terra")]) {
				expect((await captureReasoning(model as Model<Api>, reasoning))?.effort, model.provider).toBe(effort);
			}
		},
	);
});
