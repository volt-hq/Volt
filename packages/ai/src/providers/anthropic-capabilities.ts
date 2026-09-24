/**
 * Claude request capabilities, derived from the model version so that new Claude releases work
 * without a code change. A Claude model without a recognizable version counts as the newest release.
 *
 * - Claude 4.6 and later take adaptive thinking. Claude 4.7 and later reject `budget_tokens`; the 4.6
 *   models accept both and use adaptive, which Anthropic recommends.
 * - Claude 4.7 and later reject non-default temperature, top_p, and top_k, and accept the xhigh and
 *   max effort levels.
 *
 * https://platform.claude.com/docs/en/build-with-claude/extended-thinking
 * https://platform.claude.com/docs/en/build-with-claude/effort
 */

import type { Model, SimpleStreamOptions } from "../types.ts";

/**
 * How a Claude model accepts extended thinking: "budget" is `thinking.type: "enabled"` with
 * `budget_tokens`; "adaptive" is `thinking.type: "adaptive"` with an effort level.
 */
export type AnthropicThinkingMode = "adaptive" | "budget";

/** `claude-sonnet-4-5`, `claude-opus-4-1-20250805`, `claude-haiku-4.5` (after normalization). */
const FAMILY_FIRST_VERSION = /claude-(?:opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/;
/** `claude-3-7-sonnet`, `claude-3-5-haiku`, `claude-3-opus`. */
const VERSION_FIRST_VERSION = /claude-(\d+)(?:-(\d{1,2})(?!\d))?-(?:opus|sonnet|haiku)/;

/**
 * Whether the model is Claude `major.minor` or later, read from its id and then its display name
 * (Bedrock application inference profile ARNs carry the model only in the name). A Claude model
 * without a recognizable version is the newest release. Undefined when neither names a Claude model.
 */
export function isClaudeAtLeast(
	modelId: string,
	major: number,
	minor: number,
	modelName?: string,
): boolean | undefined {
	let isClaude = false;
	for (const value of modelName === undefined ? [modelId] : [modelId, modelName]) {
		const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
		if (!normalized.includes("claude")) continue;
		isClaude = true;
		const version = FAMILY_FIRST_VERSION.exec(normalized) ?? VERSION_FIRST_VERSION.exec(normalized);
		if (!version) continue;
		const versionMajor = Number(version[1]);
		const versionMinor = Number(version[2] ?? 0);
		return versionMajor > major || (versionMajor === major && versionMinor >= minor);
	}
	return isClaude ? true : undefined;
}

/** Thinking mode of a Claude model, or undefined for other models. */
export function getAnthropicThinkingMode(modelId: string, modelName?: string): AnthropicThinkingMode | undefined {
	const adaptive = isClaudeAtLeast(modelId, 4, 6, modelName);
	if (adaptive === undefined) return undefined;
	return adaptive ? "adaptive" : "budget";
}

/**
 * Whether a Claude model accepts non-default temperature, top_p, and top_k. Claude 4.7 and later
 * reject them with a 400. Undefined for other models.
 */
export function supportsAnthropicSamplingParameters(modelId: string, modelName?: string): boolean | undefined {
	const current = isClaudeAtLeast(modelId, 4, 7, modelName);
	return current === undefined ? undefined : !current;
}

/** Whether a Claude model accepts the xhigh and max effort levels. Undefined for other models. */
export function supportsAnthropicXhighEffort(modelId: string, modelName?: string): boolean | undefined {
	return isClaudeAtLeast(modelId, 4, 7, modelName);
}

/**
 * Whether an Anthropic Messages request with these options can refresh its prompt cache with
 * `max_tokens: 0`. Budget-based thinking cannot: the API rejects a budget without room for output, and
 * dropping thinking would change the cached prefix.
 */
export function canRefreshAnthropicPromptCache(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): boolean {
	return !options?.reasoning || model.compat?.forceAdaptiveThinking === true;
}
