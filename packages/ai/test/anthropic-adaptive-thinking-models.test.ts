import { describe, expect, it } from "vitest";
import { getModels, getProviders } from "../src/models.ts";
import {
	getAnthropicThinkingMode,
	supportsAnthropicSamplingParameters,
} from "../src/providers/anthropic-capabilities.ts";
import type { Api, Model } from "../src/types.ts";

const EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS = [
	"anthropic/claude-fable-5",
	"anthropic/claude-opus-4-8",
	"anthropic/claude-opus-5",
	"anthropic/claude-opus-5-5",
	"anthropic/claude-sonnet-5",
	"opencode/claude-opus-4-8",
];

const EXPECTED_CATALOG_ADAPTIVE_THINKING_MODELS = [
	"cloudflare-ai-gateway/claude-fable-5",
	"cloudflare-ai-gateway/claude-sonnet-5",
	"vercel-ai-gateway/anthropic/claude-fable-5",
	"vercel-ai-gateway/anthropic/claude-opus-4.8",
	"vercel-ai-gateway/anthropic/claude-opus-5",
	"vercel-ai-gateway/anthropic/claude-opus-5.5",
	"vercel-ai-gateway/anthropic/claude-sonnet-5",
];

const EXPECTED_BUDGET_THINKING_MODELS = [
	"anthropic/claude-haiku-4-5",
	"anthropic/claude-opus-4-5",
	"anthropic/claude-sonnet-4-5",
];

function getAnthropicMessagesModels(): Model<"anthropic-messages">[] {
	return getProviders()
		.flatMap((provider) => getModels(provider) as Model<Api>[])
		.filter((model): model is Model<"anthropic-messages"> => model.api === "anthropic-messages");
}

function isFlagged(model: Model<"anthropic-messages">): boolean {
	return model.compat?.forceAdaptiveThinking === true;
}

describe("Anthropic adaptive thinking model metadata", () => {
	it("marks built-in Anthropic Messages models that use adaptive thinking", () => {
		const models = getAnthropicMessagesModels();
		const flaggedModels = models
			.filter(isFlagged)
			.map((model) => `${model.provider}/${model.id}`)
			.sort();
		const allModelIds = new Set(models.map((model) => `${model.provider}/${model.id}`));
		const expectedCatalogModels = EXPECTED_CATALOG_ADAPTIVE_THINKING_MODELS.filter((modelId) =>
			allModelIds.has(modelId),
		);

		expect(flaggedModels).toEqual(
			expect.arrayContaining([...EXPECTED_CURRENT_ADAPTIVE_THINKING_MODELS, ...expectedCatalogModels].sort()),
		);
		for (const modelId of EXPECTED_BUDGET_THINKING_MODELS) {
			expect(flaggedModels).not.toContain(modelId);
		}
	});

	it("flags exactly the Claude models that getAnthropicThinkingMode classifies as adaptive", () => {
		const mismatches = getAnthropicMessagesModels()
			.filter((model) => isFlagged(model) !== (getAnthropicThinkingMode(model.id) === "adaptive"))
			.map((model) => `${model.provider}/${model.id}`);

		expect(mismatches).toEqual([]);
	});

	it("disables temperature on exactly the Claude models that reject sampling parameters", () => {
		const mismatches = getAnthropicMessagesModels()
			.filter((model) => supportsAnthropicSamplingParameters(model.id) !== undefined)
			.filter(
				(model) =>
					(model.compat?.supportsTemperature === false) !==
					(supportsAnthropicSamplingParameters(model.id) === false),
			)
			.map((model) => `${model.provider}/${model.id}`);

		expect(mismatches).toEqual([]);
	});
});
