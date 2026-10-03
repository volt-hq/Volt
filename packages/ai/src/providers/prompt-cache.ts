import type { CacheRetention, Model } from "../types.ts";

export function resolvePromptCacheRetention(
	model: Model<string>,
	cacheRetention: CacheRetention = "short",
	options: { forceShort?: boolean } = {},
): CacheRetention {
	if (cacheRetention === "none") return "none";
	if (!model.promptCache) return options.forceShort ? "short" : "none";
	if (cacheRetention === "long" && model.promptCache.retention.long) return "long";
	return "short";
}

export function supportsPromptCacheMode(model: Model<string>, mode: "implicit" | "explicit"): boolean {
	return model.promptCache?.modes.includes(mode) ?? false;
}
