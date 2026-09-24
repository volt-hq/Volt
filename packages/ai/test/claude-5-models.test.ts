import { describe, expect, it } from "vitest";
import { getModel, getModels, getProviders, getSupportedThinkingLevels } from "../src/models.ts";
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

const CLAUDE_5_PATTERN = /claude-(?:opus|sonnet)-5$/;

function nativeClaude5Models(): Model<Api>[] {
	return getProviders()
		.flatMap((provider) => getModels(provider) as Model<Api>[])
		.filter((model) => model.api === "anthropic-messages" || model.api === "bedrock-converse-stream")
		.filter((model) => CLAUDE_5_PATTERN.test(model.id));
}

describe("Claude Opus 5 and Claude Sonnet 5", () => {
	it("use adaptive thinking without temperature and expose xhigh and max on native routes", () => {
		const models = nativeClaude5Models();
		expect(models.map((model) => `${model.provider}/${model.id}`)).toEqual(
			expect.arrayContaining([
				"anthropic/claude-opus-5",
				"anthropic/claude-sonnet-5",
				"amazon-bedrock/global.anthropic.claude-sonnet-5",
				"github-copilot/claude-opus-5",
				"github-copilot/claude-sonnet-5",
			]),
		);
		for (const model of models) {
			const label = `${model.provider}/${model.id}`;
			expect(getSupportedThinkingLevels(model), label).toEqual(expect.arrayContaining(["high", "xhigh", "max"]));
			if (model.api === "anthropic-messages") {
				expect(model.compat, label).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false });
			}
		}
	});

	it.each(["high", "xhigh", "max"] as const)(
		"sends adaptive thinking with %s effort to Anthropic and Bedrock",
		async (reasoning) => {
			for (const [anthropicModel, bedrockModel] of [
				[getModel("anthropic", "claude-sonnet-5"), getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5")],
				[getModel("anthropic", "claude-opus-5"), getModel("amazon-bedrock", "global.anthropic.claude-opus-5")],
			] as const) {
				const anthropic = await capturePayload(anthropicModel, reasoning);
				const bedrock = await capturePayload(bedrockModel, reasoning);
				for (const payload of [anthropic, bedrock.additionalModelRequestFields]) {
					expect(payload?.thinking).toEqual({ type: "adaptive", display: "summarized" });
					expect(payload?.output_config).toEqual({ effort: reasoning });
				}
			}
		},
	);

	it("does not send temperature without thinking", async () => {
		for (const model of [
			getModel("anthropic", "claude-sonnet-5"),
			getModel("amazon-bedrock", "global.anthropic.claude-sonnet-5"),
			getModel("amazon-bedrock", "global.anthropic.claude-opus-4-8"),
		]) {
			const payload = await capturePayload(model);
			expect(payload.temperature, model.id).toBeUndefined();
			expect(payload.inferenceConfig?.temperature, model.id).toBeUndefined();
		}
	});

	it("still sends temperature to Claude models that accept it", async () => {
		const anthropic = await capturePayload(getModel("anthropic", "claude-sonnet-4-5"));
		const bedrock = await capturePayload(getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-6"));
		expect(anthropic.temperature).toBe(0.5);
		expect(bedrock.inferenceConfig?.temperature).toBe(0.5);
	});
});

describe("GitHub Copilot Claude 5 routing", () => {
	it.each(["claude-opus-5", "claude-sonnet-5", "claude-fable-5"] as const)(
		"routes %s through Anthropic Messages",
		(modelId) => {
			const model = getModel("github-copilot", modelId);
			expect(model.api).toBe("anthropic-messages");
			expect(model.compat).toMatchObject({ forceAdaptiveThinking: true, supportsTemperature: false });
		},
	);
});
