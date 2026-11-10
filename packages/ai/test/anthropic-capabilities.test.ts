import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import {
	getAnthropicThinkingMode,
	isClaudeAtLeast,
	supportsAnthropicPerMessageEffort,
	supportsAnthropicSamplingParameters,
	supportsAnthropicXhighEffort,
} from "../src/providers/anthropic-capabilities.ts";

const PROFILE_ARN = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile";

describe("getAnthropicThinkingMode", () => {
	it.each([
		"claude-sonnet-4-5",
		"claude-sonnet-4-5-20250929",
		"claude-opus-4-5-20251101",
		"claude-haiku-4.5",
		"anthropic/claude-sonnet-4.5",
		"us.anthropic.claude-haiku-4-5-20251001-v1:0",
		"claude-sonnet-4",
		"claude-sonnet-4-20250514",
		"claude-opus-4-1-20250805",
		"claude-3-7-sonnet-20250219",
		"anthropic/claude-3.7-sonnet",
		"anthropic-claude-4.5-sonnet",
	])("uses budget thinking for Claude 4.5 and earlier: %s", (modelId) => {
		expect(getAnthropicThinkingMode(modelId)).toBe("budget");
	});

	it.each([
		"claude-opus-4-6",
		"claude-sonnet-4-6",
		"global.anthropic.claude-opus-4-6-v1",
		"anthropic/claude-opus-4.8",
		"claude-opus-5",
		"claude-sonnet-5",
		"us.anthropic.claude-sonnet-5",
		"anthropic/claude-opus-5-fast",
		"claude-opus-5-5",
		"claude-fable-5-1",
		"claude-mythos-preview",
		"claude-sonnet-6",
	])("uses adaptive thinking for Claude 4.6 and later: %s", (modelId) => {
		expect(getAnthropicThinkingMode(modelId)).toBe("adaptive");
	});

	it.each(["gpt-5.5", "openai/gpt-6-sol", "kimi-k3"])("does not classify non-Claude models: %s", (modelId) => {
		expect(getAnthropicThinkingMode(modelId)).toBeUndefined();
	});

	it("reads the model name when the id does not name a Claude model", () => {
		expect(getAnthropicThinkingMode(PROFILE_ARN, "Claude Sonnet 4.5")).toBe("budget");
		expect(getAnthropicThinkingMode(PROFILE_ARN, "Claude Opus 5")).toBe("adaptive");
		expect(getAnthropicThinkingMode(PROFILE_ARN, "Production profile")).toBeUndefined();
	});

	it("prefers a versioned id over the name", () => {
		expect(getAnthropicThinkingMode("claude-sonnet-4-5", "Claude Opus 5")).toBe("budget");
	});

	it("treats a Claude model without a recognizable version as adaptive", () => {
		expect(getAnthropicThinkingMode(PROFILE_ARN, "My Claude profile")).toBe("adaptive");
	});
});

describe("Claude 4.7 capabilities", () => {
	it.each(["claude-sonnet-4-5", "claude-opus-4-6", "anthropic/claude-sonnet-4.6", "claude-3-5-haiku"])(
		"accepts sampling parameters and no xhigh effort before Claude 4.7: %s",
		(modelId) => {
			expect(supportsAnthropicSamplingParameters(modelId)).toBe(true);
			expect(supportsAnthropicXhighEffort(modelId)).toBe(false);
		},
	);

	it.each(["claude-opus-4-7", "anthropic/claude-opus-4.8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-1"])(
		"rejects sampling parameters and accepts xhigh effort from Claude 4.7: %s",
		(modelId) => {
			expect(supportsAnthropicSamplingParameters(modelId)).toBe(false);
			expect(supportsAnthropicXhighEffort(modelId)).toBe(true);
		},
	);

	it("does not classify non-Claude models", () => {
		expect(supportsAnthropicSamplingParameters("gpt-5.5")).toBeUndefined();
		expect(supportsAnthropicXhighEffort("gpt-5.5")).toBeUndefined();
	});
});

describe("Anthropic per-message effort capability", () => {
	const model = getModel("anthropic", "claude-fable-5-2");

	it.each([
		"claude-fable-5-2",
		"claude-mythos-5-2",
		"claude-fable-5-1",
		"claude-mythos-5-1",
		"claude-opus-5-5",
		"claude-opus-5",
		"claude-sonnet-5-5",
		"claude-haiku-5-5",
	])("accepts the documented alias and date snapshots of %s", (id) => {
		expect(supportsAnthropicPerMessageEffort({ ...model, id })).toBe(true);
		expect(supportsAnthropicPerMessageEffort({ ...model, id: `${id}-20261101` })).toBe(true);
	});

	it.each([
		"claude-opus-4-6",
		"claude-opus-4-8",
		"claude-fable-5",
		"claude-mythos-5",
		"claude-mythos-preview",
		"claude-sonnet-5",
		"claude-opus-6",
		"claude-fable-5-3",
		"claude-opus-5-6",
		"claude-opus-5-50",
		"claude-opus-5-5-preview",
		"claude-opus-5-latest",
		"claude-opus-5.5",
		"claude-opus-5-20261101-extra",
		"anthropic/claude-opus-5-5",
		"us.anthropic.claude-opus-5-5-v1:0",
	])("does not infer support for %s", (id) => {
		expect(supportsAnthropicPerMessageEffort({ ...model, id })).toBe(false);
	});

	it.each([
		"https://proxy.example/anthropic",
		"https://api.anthropic.com.proxy.example",
		"https://api.anthropic.com/proxy",
		"https://api.anthropic.com?upstream=proxy",
		"https://api.anthropic.com#proxy",
		"https://user@api.anthropic.com",
		"https://api.anthropic.com:8443",
		"http://api.anthropic.com",
		"not a URL",
	])("rejects non-direct or ambiguous endpoints: %s", (baseUrl) => {
		expect(supportsAnthropicPerMessageEffort({ ...model, baseUrl })).toBe(false);
	});

	it.each(["github-copilot", "amazon-bedrock", "google-vertex", "cloudflare-ai-gateway", "custom"])(
		"does not enable the beta for provider %s even with a direct-looking URL",
		(provider) => {
			expect(supportsAnthropicPerMessageEffort({ ...model, provider })).toBe(false);
		},
	);

	it("accepts the direct endpoint with a trailing slash", () => {
		expect(supportsAnthropicPerMessageEffort({ ...model, baseUrl: "https://api.anthropic.com/" })).toBe(true);
	});
});

describe("isClaudeAtLeast", () => {
	it("compares major and minor versions", () => {
		expect(isClaudeAtLeast("claude-sonnet-4-5", 4, 0)).toBe(true);
		expect(isClaudeAtLeast("claude-3-7-sonnet", 4, 0)).toBe(false);
		expect(isClaudeAtLeast("claude-opus-4-6", 4, 7)).toBe(false);
		expect(isClaudeAtLeast("claude-opus-5", 4, 7)).toBe(true);
		expect(isClaudeAtLeast("gpt-5.5", 4, 0)).toBeUndefined();
	});
});
