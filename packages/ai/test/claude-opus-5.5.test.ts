import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getModels, getProviders, getSupportedThinkingLevels } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { Api, Model, SimpleStreamOptions } from "../src/types.ts";

interface ThinkingPayload {
	thinking?: { type: string; display?: string; budget_tokens?: number };
	output_config?: { effort: string };
	temperature?: number;
	inferenceConfig?: { temperature?: number };
	additionalModelRequestFields?: ThinkingPayload;
}

async function capturePayload(
	model: Model<Api>,
	reasoning?: SimpleStreamOptions["reasoning"],
): Promise<ThinkingPayload> {
	let captured: ThinkingPayload | undefined;
	await streamSimple(
		{ ...model, baseUrl: "http://127.0.0.1:9" },
		{ messages: [{ role: "user", content: "Hello", timestamp: 0 }] },
		{
			apiKey: "fake-key",
			env: {},
			reasoning,
			temperature: 0.5,
			onPayload: (payload) => {
				captured = payload as ThinkingPayload;
				throw new Error("payload captured");
			},
		},
	).result();
	if (!captured) throw new Error("Expected payload capture before network request");
	return captured;
}

describe("Claude Opus 5.5", () => {
	it("exposes documented capabilities and prices", () => {
		expect(getModel("anthropic", "claude-opus-5-5")).toMatchObject({
			name: "Claude Opus 5.5",
			api: "anthropic-messages",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 128_000,
			cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
			compat: { forceAdaptiveThinking: true, supportsTemperature: false },
			promptCache: {
				modes: ["explicit"],
				retention: { short: { ttlSeconds: 300 }, long: { ttlSeconds: 3_600 } },
			},
		});
	});

	it("exposes only supported reasoning levels across catalog routes", () => {
		const models = getProviders()
			.flatMap((provider) => getModels(provider) as Model<Api>[])
			.filter((model) => /opus[-.]5[-.]5/.test(model.id));
		expect(models.length).toBeGreaterThan(0);
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
		"sends adaptive thinking with %s effort to Anthropic and Bedrock",
		async (reasoning) => {
			const anthropic = await capturePayload(getModel("anthropic", "claude-opus-5-5"), reasoning);
			const bedrock = await capturePayload(
				getModel("amazon-bedrock", "global.anthropic.claude-opus-5-5"),
				reasoning,
			);
			for (const payload of [anthropic, bedrock.additionalModelRequestFields]) {
				expect(payload?.thinking).toEqual({ type: "adaptive", display: "summarized" });
				expect(payload?.output_config).toEqual({ effort: reasoning });
			}
			expect(anthropic.temperature).toBeUndefined();
			expect(bedrock.inferenceConfig?.temperature).toBeUndefined();
		},
	);

	it("does not send disabled thinking or temperature when no effort is requested", async () => {
		for (const model of [
			getModel("anthropic", "claude-opus-5-5"),
			getModel("amazon-bedrock", "global.anthropic.claude-opus-5-5"),
		]) {
			const payload = await capturePayload(model);
			expect(payload.thinking).toBeUndefined();
			expect(payload.additionalModelRequestFields?.thinking).toBeUndefined();
			expect(payload.temperature).toBeUndefined();
			expect(payload.inferenceConfig?.temperature).toBeUndefined();
		}
	});
});
