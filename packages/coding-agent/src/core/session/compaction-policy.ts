/**
 * When the session compacts on its own: context overflow, the threshold
 * after a response, and the threshold before a turn continues. Pure
 * functions of the response, the live context, and the compaction settings.
 */

import { type AgentMessage, type ConversationState, isCoreLogEntry } from "@hansjm10/volt-agent-core";
import { type AssistantMessage, isContextOverflow, type Tool } from "@hansjm10/volt-ai";
import {
	type CompactionSettings,
	calculateContextTokens,
	estimateContextTokens,
	shouldCompact,
} from "../compaction/index.ts";

/** The selected model a check runs against. */
export interface CompactionModel {
	readonly provider: string;
	readonly id: string;
	readonly contextWindow?: number;
}

/** The context a check estimates: the branch messages a request would send, and the active tools. */
export interface CompactionContext {
	readonly messages: readonly AgentMessage[];
	readonly tools?: readonly Tool[];
}

export interface ContinuingCompactionCheck extends CompactionContext {
	/** The response that ended the turn. */
	readonly message: AssistantMessage;
	/** Whether the turn continues with another request: tool results to answer, or queued input. */
	readonly continuing: boolean;
	readonly model: CompactionModel | undefined;
	readonly settings: CompactionSettings;
}

/**
 * Whether a turn that would continue with another request stops first for
 * threshold compaction, so it compacts mid-task instead of only after the
 * whole tool loop. Provider usage predates the turn's tool execution, so the
 * estimate comes from the live context, tool results included.
 */
export function shouldCompactBeforeContinuing(check: ContinuingCompactionCheck): boolean {
	const { message, model, settings } = check;
	if (!check.continuing || message.stopReason === "aborted" || message.stopReason === "error") return false;
	if (!model || message.provider !== model.provider || message.model !== model.id) return false;
	if (!settings.enabled) return false;
	const contextTokens = estimateContextTokens([...check.messages], check.tools).tokens;
	return shouldCompact(contextTokens, model.contextWindow ?? 0, settings);
}

export interface ResponseCompactionCheck {
	/** The response a run ended with, or the branch's last response before a prompt. */
	readonly message: AssistantMessage;
	/** Check an aborted response too (the check before a prompt). */
	readonly includeAborted: boolean;
	readonly model: CompactionModel | undefined;
	readonly settings: CompactionSettings;
	/** The run already compacted once to recover from an overflow. */
	readonly overflowRecoveryAttempted: boolean;
	/**
	 * When the branch's latest compaction was committed, in epoch milliseconds;
	 * usage before it is stale. Read only when the response is checked at all.
	 */
	readonly compactedAt: () => number | undefined;
	/** The branch's live context, read only for the threshold. */
	readonly context: () => CompactionContext;
}

export type ResponseCompaction =
	| { readonly kind: "none" }
	/** The context overflowed: compact, then retry the request. */
	| { readonly kind: "overflow" }
	/** The context overflowed again after one compact-and-retry: give up. */
	| { readonly kind: "overflow_exhausted" }
	/** The context is over the threshold: compact, continuing only when a length stop produced nothing visible. */
	| { readonly kind: "threshold"; readonly continueAfterCompaction: boolean };

const NO_COMPACTION: ResponseCompaction = Object.freeze({ kind: "none" });

/**
 * Whether a response calls for compaction. An overflow from the selected model
 * compacts and retries once. Otherwise the threshold applies to an estimate of
 * the live context; an error response needs a usage source newer than the
 * latest compaction. A response older than the latest compaction never
 * compacts again.
 */
export function checkResponseCompaction(check: ResponseCompactionCheck): ResponseCompaction {
	const { message, model, settings } = check;
	if (!settings.enabled) return NO_COMPACTION;
	if (!check.includeAborted && message.stopReason === "aborted") return NO_COMPACTION;
	const contextWindow = model?.contextWindow ?? 0;
	// An overflow from a model with a smaller context says nothing about the selected one.
	const sameModel = model !== undefined && message.provider === model.provider && message.model === model.id;
	const compactedAt = check.compactedAt();
	if (compactedAt !== undefined && message.timestamp <= compactedAt) return NO_COMPACTION;
	if (sameModel && isContextOverflow(message, contextWindow)) {
		return check.overflowRecoveryAttempted ? { kind: "overflow_exhausted" } : { kind: "overflow" };
	}

	const context = check.context();
	const estimate = estimateContextTokens([...context.messages], context.tools);
	let contextTokens: number;
	if (message.stopReason === "error") {
		if (estimate.lastUsageIndex === null) return NO_COMPACTION;
		// Kept pre-compaction messages carry usage of the old, larger context.
		const usageMessage = context.messages[estimate.lastUsageIndex];
		if (compactedAt !== undefined && usageMessage?.role === "assistant" && usageMessage.timestamp <= compactedAt) {
			return NO_COMPACTION;
		}
		contextTokens = estimate.tokens;
	} else {
		// A lone aborted response is no trustworthy estimate source, but its usage beats a character count.
		contextTokens = estimate.lastUsageIndex === null ? calculateContextTokens(message.usage) : estimate.tokens;
	}
	if (!shouldCompact(contextTokens, contextWindow, settings)) return NO_COMPACTION;
	const continueAfterCompaction =
		message.stopReason === "length" &&
		!message.content.some(
			(content) => (content.type === "text" && content.text.trim().length > 0) || content.type === "toolCall",
		);
	return { kind: "threshold", continueAfterCompaction };
}

/** When the active branch's latest compaction was committed, in epoch milliseconds. */
export function latestCompactionTime(state: ConversationState): number | undefined {
	for (let index = state.branch.length - 1; index >= 0; index--) {
		const entry = state.tree.byId.get(state.branch[index] ?? "");
		if (entry && isCoreLogEntry(entry) && entry.type === "compaction") return new Date(entry.timestamp).getTime();
	}
	return undefined;
}
