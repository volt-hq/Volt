import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../src/models.ts";
import { getOpenAIPriorityCost, supportsFastInference } from "../src/providers/openai-fast-inference.ts";
import { streamSimple } from "../src/stream.ts";
import type { SimpleStreamOptions, Usage } from "../src/types.ts";

// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// https://developers.openai.com/api/docs/guides/prompt-caching
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json
// Verified 2026-09-29. These tests never send provider requests.
const cost = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 };
const supportedLevels = ["low", "medium", "high", "xhigh", "max"];

interface ResponsesPayload {
	reasoning?: { effort?: string };
}

describe("GPT-6.1 Sol metadata", () => {
	it.each(["openai", "azure-openai-responses"] as const)("exposes API capabilities through %s", (provider) => {
		const model = getModel(provider, "gpt-6.1-sol");
		expect(model).toMatchObject({
			name: "GPT-6.1 Sol",
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

	it("uses the Codex catalog's default context, reasoning levels, and Fast tier", () => {
		const model = getModel("openai-codex", "gpt-6.1-sol");
		expect(model).toMatchObject({
			api: "openai-codex-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			contextWindow: 272_000,
			maxTokens: 128_000,
			cost,
		});
		expect(getSupportedThinkingLevels(model)).toEqual(supportedLevels);
		expect(supportsFastInference(model)).toBe(true);
	});

	it.each(["openai/gpt-6.1-sol", "openai/gpt-6.1-sol-pro"] as const)(
		"does not advertise rejected reasoning levels through OpenRouter %s",
		(id) => {
			expect(getSupportedThinkingLevels(getModel("openrouter", id))).toEqual(supportedLevels);
		},
	);

	it("supports Fast mode with documented double-rate API pricing", () => {
		const model = getModel("openai", "gpt-6.1-sol");
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
			let captured: ResponsesPayload | undefined;
			await streamSimple(
				{ ...getModel("openai", "gpt-6.1-sol"), baseUrl: "http://127.0.0.1:9" },
				{ messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
				{
					apiKey: "fake-key",
					env: {},
					reasoning,
					onPayload: (payload) => {
						captured = payload as ResponsesPayload;
						throw new Error("payload captured");
					},
				},
			).result();
			expect(captured).toBeDefined();
			expect(captured?.reasoning?.effort).toBe(effort);
		},
	);
});
