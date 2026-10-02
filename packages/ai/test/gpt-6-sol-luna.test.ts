import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../src/models.ts";
import { applyOpenAIPriorityPricing, supportsFastInference } from "../src/providers/openai-fast-inference.ts";
import { streamSimple } from "../src/stream.ts";
import type { SimpleStreamOptions, Usage } from "../src/types.ts";

const models = [
	{ id: "gpt-6-sol", name: "GPT-6 Sol", cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
	{ id: "gpt-6-luna", name: "GPT-6 Luna", cost: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 } },
] as const;

interface ResponsesPayload {
	reasoning?: { effort?: string };
	prompt_cache_options?: { mode?: string; ttl?: string };
	prompt_cache_retention?: string;
}

describe.each(models)("$name metadata", ({ id, name, cost }) => {
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
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		expect(clampThinkingLevel(model, "minimal")).toBe("low");
	});

	it("uses the authenticated Codex catalog's default context and reasoning levels", () => {
		const model = getModel("openai-codex", id);
		expect(model).toMatchObject({
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			contextWindow: 272_000,
			maxTokens: 128_000,
			cost,
		});
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(clampThinkingLevel(model, "off")).toBe("low");
		expect(clampThinkingLevel(model, "minimal")).toBe("low");
		expect(supportsFastInference(model)).toBe(true);
	});

	it("supports Fast mode with documented double-rate API pricing", () => {
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
		expect(applyOpenAIPriorityPricing(usage, model)).toBe(true);
		expect(usage.cost).toMatchObject({
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
		"sends effort=$effort and falls back from long retention to the default 30-minute cache",
		async ({ reasoning, effort }) => {
			let captured: ResponsesPayload | undefined;
			await streamSimple(
				{ ...getModel("openai", id), baseUrl: "http://127.0.0.1:9" },
				{ messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
				{
					apiKey: "fake-key",
					env: {},
					reasoning,
					cacheRetention: "long",
					onPayload: (payload) => {
						captured = payload as ResponsesPayload;
						throw new Error("payload captured");
					},
				},
			).result();
			expect(captured).toBeDefined();
			expect(captured?.reasoning?.effort).toBe(effort);
			expect(captured?.prompt_cache_options).toBeUndefined();
			expect(captured?.prompt_cache_retention).toBeUndefined();
		},
	);
});
