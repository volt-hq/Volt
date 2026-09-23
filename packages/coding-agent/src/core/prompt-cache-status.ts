import { type CacheRetention, type Model, type ProviderEnv, resolvePromptCacheRetention } from "@hansjm10/volt-ai";
import type { SessionEntry } from "./session-manager.ts";

/**
 * Documented retention of the prompt prefix the next request for the current
 * model would reuse. This is an estimate: provider eviction, routing, and
 * request-shape changes can still miss earlier.
 */
export type PromptCacheStatus =
	| {
			kind: "retained";
			/** Unix epoch milliseconds when the latest request or cache refresh with the current model started. */
			lastRequestAt: number;
			/** Unix epoch milliseconds when the documented retention window lapses. Absent when the provider publishes none. */
			expiresAt?: number;
			/** Unix epoch milliseconds until which Volt keeps refreshing the idle cache. Absent unless idle keepalive applies. */
			keepAliveUntil?: number;
	  }
	| {
			/** Earlier requests used other models, so the next request cannot reuse their cached prefix. */
			kind: "model_changed";
	  };

export interface PromptCacheStatusInput {
	model: Model<string> | undefined;
	/** Active branch, root first. */
	branch: readonly SessionEntry[];
	cacheRetention?: CacheRetention;
	env?: ProviderEnv;
}

/** Undefined when the model does not cache or the active prefix has no prior request. */
export function resolvePromptCacheStatus(input: PromptCacheStatusInput): PromptCacheStatus | undefined {
	const model = input.model;
	if (!model?.promptCache) return undefined;
	const retention = resolvePromptCacheRetention(model, input.cacheRetention, input.env);
	if (retention === "none") return undefined;

	let sawRequest = false;
	for (let index = input.branch.length - 1; index >= 0; index--) {
		const entry = input.branch[index]!;
		// Compaction replaces the conversation head, so earlier requests cached a different prefix.
		if (entry.type === "compaction") break;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const message = entry.message;
		// Without reported prompt usage there is no evidence the provider processed the prompt.
		if (message.usage.input + message.usage.cacheRead + message.usage.cacheWrite <= 0) continue;
		sawRequest = true;
		if (message.provider !== model.provider || message.model !== model.id) continue;
		const ttlSeconds = model.promptCache.retention[retention]?.ttlSeconds;
		return {
			kind: "retained",
			lastRequestAt: message.timestamp,
			...(ttlSeconds === undefined ? {} : { expiresAt: message.timestamp + ttlSeconds * 1000 }),
		};
	}
	return sawRequest ? { kind: "model_changed" } : undefined;
}

/** A later read that renewed the prefix of the request that started at `basisRequestAt`. */
export interface PromptCacheRefreshRecord {
	basisRequestAt: number;
	/** Unix epoch milliseconds when the renewing request started. */
	at: number;
	/** A keepalive refresh, or a conversation request still in flight. */
	source: "refresh" | "request";
}

/**
 * Extend a branch-derived status by a later refresh of the same request. Refreshes of another
 * request (for example on a different branch) do not apply.
 */
export function applyPromptCacheRefresh(
	status: PromptCacheStatus | undefined,
	refresh: PromptCacheRefreshRecord | undefined,
): PromptCacheStatus | undefined {
	if (status?.kind !== "retained" || !refresh) return status;
	if (refresh.basisRequestAt !== status.lastRequestAt || refresh.at <= status.lastRequestAt) return status;
	return {
		kind: "retained",
		lastRequestAt: refresh.at,
		...(status.expiresAt === undefined ? {} : { expiresAt: refresh.at + (status.expiresAt - status.lastRequestAt) }),
	};
}

export function promptCacheStatusEquals(
	left: PromptCacheStatus | undefined,
	right: PromptCacheStatus | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.kind !== right.kind) return false;
	if (left.kind === "model_changed" || right.kind === "model_changed") return true;
	return (
		left.lastRequestAt === right.lastRequestAt &&
		left.expiresAt === right.expiresAt &&
		left.keepAliveUntil === right.keepAliveUntil
	);
}
