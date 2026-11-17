import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../src/models.ts";
import { getOpenAIPriorityCost, supportsFastInference } from "../src/providers/openai-fast-inference.ts";
import type { Api, Model, SimpleStreamOptions, Usage } from "../src/types.ts";
import { streamSimple } from "./test-client.ts";

// https://developers.openai.com/api/docs/models/gpt-6.2-astra
// https://developers.openai.com/api/docs/models/gpt-6.2-sol
// https://developers.openai.com/api/docs/guides/prompt-caching
// https://developers.openai.com/codex/models
// https://developers.openai.com/codex/speed
// Verified 2026-11-17. These tests never send provider requests.
const models = {
	"gpt-6.2-astra": {
		name: "GPT-6.2 Astra",
		cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 },
		codexContextWindow: 272_000,
	},
	"gpt-6.2-sol": {
		name: "GPT-6.2 Sol",
		cost: { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		codexContextWindow: 500_000,
	},
} as const;
const ids = Object.keys(models) as (keyof typeof models)[];
const supportedLevels = ["low", "medium", "high", "xhigh", "max"];

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

describe.each(ids)("%s", (id) => {
	const { name, cost, codexContextWindow } = models[id];

	it.each(["openai", "azure-openai-responses"] as const)("exposes API capabilities through %s", (provider) => {
		const model = getModel(provider, id);
		expect(model).toMatchObject({
			name,
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
		expect(getSupportedThinkingLevels(model)).toEqual(supportedLevels);
		expect(clampThinkingLevel(model, "off")).toBe("low");
		expect(clampThinkingLevel(model, "minimal")).toBe("low");
	});

	it("uses the documented Codex default context, reasoning levels, and Fast tier", () => {
		const model = getModel("openai-codex", id);
		expect(model).toMatchObject({
			name,
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			contextWindow: codexContextWindow,
			maxTokens: 128_000,
			cost,
		});
		expect(getSupportedThinkingLevels(model)).toEqual(supportedLevels);
		expect(supportsFastInference(model)).toBe(true);
	});

	it("does not advertise rejected reasoning levels through OpenRouter", () => {
		for (const routeId of [`openai/${id}`, `openai/${id}-pro`] as const) {
			expect(getSupportedThinkingLevels(getModel("openrouter", routeId)), routeId).toEqual(supportedLevels);
		}
	});

	it("supports Fast mode at the documented double API rate", () => {
		const model = getModel("openai", id);
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
		{ reasoning: undefined, effort: undefined },
		{ reasoning: "minimal", effort: "low" },
		{ reasoning: "xhigh", effort: "xhigh" },
		{ reasoning: "max", effort: "max" },
	] satisfies { reasoning: SimpleStreamOptions["reasoning"]; effort: string | undefined }[])(
		"sends effort=$effort and never the rejected none effort",
		async ({ reasoning, effort }) => {
			for (const model of [getModel("openai", id), getModel("openrouter", `openai/${id}`)] as Model<Api>[]) {
				expect((await captureReasoning(model, reasoning))?.effort, model.provider).toBe(effort);
			}
		},
	);
});
