import { describe, expect, it } from "vitest";
import {
	getAnthropicThinkingMode,
	isClaudeAtLeast,
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

describe("isClaudeAtLeast", () => {
	it("compares major and minor versions", () => {
		expect(isClaudeAtLeast("claude-sonnet-4-5", 4, 0)).toBe(true);
		expect(isClaudeAtLeast("claude-3-7-sonnet", 4, 0)).toBe(false);
		expect(isClaudeAtLeast("claude-opus-4-6", 4, 7)).toBe(false);
		expect(isClaudeAtLeast("claude-opus-5", 4, 7)).toBe(true);
		expect(isClaudeAtLeast("gpt-5.5", 4, 0)).toBeUndefined();
	});
});
