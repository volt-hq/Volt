/**
 * The footer's view model from what the TUI's client holds (architecture
 * rewrite §10): the client fold's name, model, thinking level, and Fast mode;
 * the live `usage`, `git`, `prompt_cache`, `presence`, and extension status
 * values; and the `models`, `settings`, and `conversation_info` catalogs.
 */

import type { LiveValue, ProjectedEntry, RpcPromptCacheStatus } from "@hansjm10/volt-protocol";
import { renderStyledText } from "@hansjm10/volt-tui";
import type { FooterModel, FooterUsage, FooterViewModel } from "../components/footer.ts";
import { TUI_SEMANTIC_THEME } from "../ui-node/semantic-theme.ts";
import type { TuiCatalogs } from "./tui-catalogs.ts";
import type { TuiStore } from "./tui-store.ts";

/** What the footer takes from the TUI besides its store and catalogs. */
export interface FooterLocal {
	/** Context tokens from which the context shows as a warning (a display setting). */
	readonly contextWarningTokens: number;
	/** How the footer shows paired devices attached to the conversation, by their count. */
	readonly phoneLabel: (count: number) => string;
}

const STATUS_KEY = "ext_status/";
/** The key the phone indicator sorts under among the extensions' status items. */
const PHONE_STATUS_KEY = "__phone_attached";

function liveValue<K extends LiveValue["kind"]>(
	store: TuiStore,
	key: string,
	kind: K,
): Extract<LiveValue, { kind: K }> | undefined {
	const value = store.value(key);
	return value?.kind === kind ? (value as Extract<LiveValue, { kind: K }>) : undefined;
}

const hitRates = new WeakMap<readonly ProjectedEntry[], number | undefined>();

/** The cache hit rate of the newest assistant message of `entries`, in percent. */
export function latestCacheHitRate(entries: readonly ProjectedEntry[]): number | undefined {
	if (hitRates.has(entries)) return hitRates.get(entries);
	let rate: number | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		const message = entry?.type === "message" ? entry.payload?.message : undefined;
		if (message?.role !== "assistant") continue;
		const prompt = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
		rate = prompt > 0 ? (message.usage.cacheRead / prompt) * 100 : undefined;
		break;
	}
	hitRates.set(entries, rate);
	return rate;
}

/** The conversation's Git branch: `detached` on a detached HEAD, null outside a repository. */
export function gitBranchOf(store: TuiStore): string | null {
	const git = liveValue(store, "git", "git")?.gitContext;
	if (!git) return null;
	return git.head.kind === "detached" ? "detached" : git.head.name;
}

/** The status items the footer shows: the extensions', and the paired devices attached. */
export function footerStatuses(store: TuiStore, phoneLabel: (count: number) => string): Map<string, string> {
	const statuses = new Map<string, string>();
	for (const [key, value] of store.live.values) {
		if (value.kind !== "ext_status" || !key.startsWith(STATUS_KEY)) continue;
		statuses.set(key.slice(STATUS_KEY.length), renderStyledText(value.text, TUI_SEMANTIC_THEME).replace(/\n/g, " "));
	}
	const phones = liveValue(store, "presence", "presence")?.remote ?? 0;
	if (phones > 0) statuses.set(PHONE_STATUS_KEY, phoneLabel(phones));
	return statuses;
}

/** The footer's view of the conversation the store shows. */
export function footerViewModel(store: TuiStore, catalogs: TuiCatalogs, local: FooterLocal): FooterViewModel {
	const state = store.state;
	const ref = state.model;
	const catalogModel =
		ref === null
			? undefined
			: catalogs.models?.models.find((model) => model.provider === ref.provider && model.id === ref.modelId);
	const model: FooterModel | undefined =
		ref === null
			? undefined
			: {
					provider: ref.provider,
					id: ref.modelId,
					reasoning: catalogModel?.reasoning ?? false,
					contextWindow: catalogModel?.contextWindow ?? 0,
				};
	const providers = new Set(catalogs.models?.cycleScope.map((scoped) => scoped.provider) ?? []);
	const usageValue = liveValue(store, "usage", "usage");
	const usage: FooterUsage = {
		input: usageValue?.tokens.input ?? 0,
		output: usageValue?.tokens.output ?? 0,
		cacheRead: usageValue?.tokens.cacheRead ?? 0,
		cacheWrite: usageValue?.tokens.cacheWrite ?? 0,
		cost: usageValue?.cost ?? 0,
		...(usageValue?.contextUsage === undefined ? {} : { contextUsage: usageValue.contextUsage }),
	};
	const hitRate = latestCacheHitRate(state.entries);
	const promptCache: RpcPromptCacheStatus | undefined =
		liveValue(store, "prompt_cache", "prompt_cache")?.promptCache ?? undefined;
	return {
		cwd: catalogs.conversationInfo?.cwd ?? "",
		gitBranch: gitBranchOf(store),
		sessionName: state.name,
		model,
		thinkingLevel: state.thinkingLevel,
		fastMode: state.fastMode,
		availableProviderCount: providers.size,
		usingSubscription: catalogModel?.auth === "oauth",
		autoCompact: catalogs.settings?.autoCompaction ?? true,
		contextWarningTokens: local.contextWarningTokens,
		usage: hitRate === undefined ? usage : { ...usage, latestCacheHitRate: hitRate },
		promptCache,
		statuses: footerStatuses(store, local.phoneLabel),
	};
}
