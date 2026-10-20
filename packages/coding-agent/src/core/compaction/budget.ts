/**
 * Compaction budgets: the sizes a checkpoint may take, the room a native
 * compaction request needs, and where automatic compaction triggers.
 * Triggering, native preflight, retained-message selection and admission
 * share these numbers, so a compaction the trigger starts is one the
 * native request can fit and the rebuilt context can admit.
 */

import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import { type Api, clampThinkingLevel, type Model, type ThinkingBudgets } from "@hansjm10/volt-ai";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../messages.ts";
import type { CheckpointPurpose } from "./checkpoint.ts";

/** Output tokens one built-in checkpoint request asks for. */
export const CHECKPOINT_MAX_TOKENS = 4096;
/** Characters per token used to turn checkpoint token budgets into character limits. */
export const CHECKPOINT_CHARS_PER_TOKEN = 4;
/** Hard limit on the text one built-in checkpoint request may generate. */
export const CHECKPOINT_MAX_CHARS = CHECKPOINT_MAX_TOKENS * CHECKPOINT_CHARS_PER_TOKEN;
/** Small context windows give the generated checkpoint at most this share of the window... */
const CHECKPOINT_WINDOW_SHARE = 0.1;
/** ...but never fewer tokens than this. */
const MIN_CHECKPOINT_TOKENS = 512;
/** Target shares of a request's character limit: the first attempt, then each correction. */
type TargetRatios = readonly [first: number, correction: number, lastCorrection: number];
/** Target shares for the native request. */
export const NATIVE_TARGET_RATIOS: TargetRatios = [0.6, 0.4, 0.25];
/**
 * Target shares for chunked fallback and turn-prefix requests. Measured
 * fallback checkpoints ran 1.3 to 1.7 times their target, which put a 60%
 * first target at the hard limit; these keep that overshoot below it.
 */
export const CHUNK_TARGET_RATIOS: TargetRatios = [0.45, 0.3, 0.2];
/** Oversized checkpoints are regenerated at most this many times per request. */
export const MAX_CHECKPOINT_CORRECTIONS = NATIVE_TARGET_RATIOS.length - 1;
/** Share of a split-turn fallback budget the history summary gets; the turn prefix gets the rest. */
export const SPLIT_HISTORY_SHARE = 0.75;
/** The verbatim user-message record gets at most this many tokens... */
export const USER_MESSAGES_MAX_TOKENS = 4096;
/** ...and at most this share of the context window... */
export const USER_MESSAGES_WINDOW_SHARE = 0.02;
/**
 * ...but never fewer characters than this, so the first message always has
 * room. The record claims these characters from the host-owned blocks' shared
 * budget, so on small windows the file lists get only what the record leaves.
 */
const MIN_USER_MESSAGES_CHARS = 1024;
/** Characters one recorded user message keeps. */
export const USER_MESSAGE_MAX_CHARS = 2000;
/** Characters the rendered read/modified file lists may take. */
export const FILE_LISTS_MAX_CHARS = 8192;
/** Small context windows give the file lists at most this share of the window. */
const FILE_LISTS_WINDOW_SHARE = 0.05;
/** Tokens the native checkpoint instruction takes (rules, scope, and boundary excerpt). */
export const NATIVE_INSTRUCTION_TOKENS = 1536;
/** Framing, provider-added tokens, and estimation slack for one request. */
export const REQUEST_MARGIN_TOKENS = 1024;
/** Separators and the split-turn divider between the parts of a composed checkpoint. */
const CHECKPOINT_FRAMING_CHARS = 512;
/** Automatic compaction never moves its trigger below this share of the context window. */
const MIN_TRIGGER_WINDOW_SHARE = 0.5;

const DEFAULT_REASONING_TOKENS = { minimal: 1024, low: 2048, medium: 8192, high: 16384 } as const;

/** Token counts behind a compaction's strategy and admission decisions, for failure diagnostics. */
export interface CompactionBudgetSnapshot {
	readonly contextWindow: number;
	/** The session's estimate of the request the conversation would send next. */
	readonly estimatedContextTokens?: number;
	readonly instructionTokens?: number;
	readonly outputAllowanceTokens?: number;
	readonly marginTokens?: number;
	/** The configured response reserve the compacted context must leave. */
	readonly reserveTokens?: number;
	/** The context size automatic compaction triggers above, when it applies. */
	readonly triggerTokens?: number;
	readonly retainedTokens?: number;
	/** System prompt, tool definitions and plan checkpoint. */
	readonly fixedTokens?: number;
	/** The estimated compacted context, when a checkpoint was produced. */
	readonly compactedTokens?: number;
}

/** Generated-checkpoint tokens for a context window: 4,096, or a tenth of a small window. */
export function checkpointMaxTokens(contextWindow: number): number {
	if (!(contextWindow > 0)) return CHECKPOINT_MAX_TOKENS;
	return Math.min(
		CHECKPOINT_MAX_TOKENS,
		Math.max(MIN_CHECKPOINT_TOKENS, Math.floor(contextWindow * CHECKPOINT_WINDOW_SHARE)),
	);
}

/** Characters the rendered file lists may take for a context window, when the user-message record leaves room. */
export function fileListsMaxChars(contextWindow: number): number {
	if (!(contextWindow > 0)) return FILE_LISTS_MAX_CHARS;
	return Math.min(
		FILE_LISTS_MAX_CHARS,
		Math.floor(contextWindow * FILE_LISTS_WINDOW_SHARE) * CHECKPOINT_CHARS_PER_TOKEN,
	);
}

/** The target length of a checkpoint request, tightening with each correction. */
export function checkpointTargetChars(maxChars: number, correction: number, purpose: CheckpointPurpose): number {
	const ratios = purpose === "native" ? NATIVE_TARGET_RATIOS : CHUNK_TARGET_RATIOS;
	const ratio = ratios[Math.min(correction, ratios.length - 1)];
	return Math.max(1, Math.floor(maxChars * ratio));
}

/** A split-turn fallback budget divided between the history and the turn-prefix summaries. */
export function splitCheckpointTokens(totalTokens: number): { history: number; turnPrefix: number } {
	const total = Math.max(0, Math.floor(totalTokens));
	const history = Math.floor(total * SPLIT_HISTORY_SHARE);
	return { history, turnPrefix: total - history };
}

/** Characters the verbatim user-message record may take for a context window. */
export function userMessagesMaxChars(contextWindow: number): number {
	const maxChars = USER_MESSAGES_MAX_TOKENS * CHECKPOINT_CHARS_PER_TOKEN;
	if (!(contextWindow > 0)) return maxChars;
	return Math.min(
		maxChars,
		Math.max(
			MIN_USER_MESSAGES_CHARS,
			Math.floor(contextWindow * USER_MESSAGES_WINDOW_SHARE) * CHECKPOINT_CHARS_PER_TOKEN,
		),
	);
}

/**
 * Characters the host-owned blocks take together for a context window: the
 * user-message record's and the file lists' shares of the window, but at least
 * the record's minimum. The record fills it first, then the file lists, so
 * small windows do not stack one minimum per block.
 */
export function hostBlocksMaxChars(contextWindow: number): number {
	const blocks = userMessagesMaxChars(contextWindow) + fileListsMaxChars(contextWindow);
	if (!(contextWindow > 0)) return blocks;
	const windowChars = (share: number): number => Math.floor(contextWindow * share) * CHECKPOINT_CHARS_PER_TOKEN;
	return Math.min(
		blocks,
		Math.max(MIN_USER_MESSAGES_CHARS, windowChars(USER_MESSAGES_WINDOW_SHARE) + windowChars(FILE_LISTS_WINDOW_SHARE)),
	);
}

/** The longest checkpoint built-in compaction composes: generated text, then the host-owned blocks. */
export function maxComposedCheckpointChars(contextWindow: number): number {
	return (
		checkpointMaxTokens(contextWindow) * CHECKPOINT_CHARS_PER_TOKEN +
		hostBlocksMaxChars(contextWindow) +
		CHECKPOINT_FRAMING_CHARS
	);
}

/**
 * Tokens a built-in checkpoint takes in the compacted context at most, given
 * the length of its host-owned blocks: the longest generated text, those
 * blocks, framing, and the summary wrapper. The blocks are rebuilt from the
 * branch, so their length is known before any request.
 */
export function installedCheckpointTokens(contextWindow: number, hostBlocksChars: number): number {
	const wrapperChars = COMPACTION_SUMMARY_PREFIX.length + COMPACTION_SUMMARY_SUFFIX.length;
	return Math.ceil(
		(checkpointMaxTokens(contextWindow) * CHECKPOINT_CHARS_PER_TOKEN +
			hostBlocksChars +
			CHECKPOINT_FRAMING_CHARS +
			wrapperChars) /
			CHECKPOINT_CHARS_PER_TOKEN,
	);
}

/** Tokens the largest built-in checkpoint takes in the compacted context, summary wrapper included. */
export function maxInstalledCheckpointTokens(contextWindow: number): number {
	return installedCheckpointTokens(contextWindow, hostBlocksMaxChars(contextWindow));
}

/** The reasoning level a compaction request runs at for a model. */
export function compactionReasoningLevel(model: Model<Api>, thinkingLevel: ThinkingLevel): ThinkingLevel {
	return model.reasoning ? clampThinkingLevel(model, thinkingLevel) : "off";
}

/** Reasoning tokens a request at this level may spend; levels above high budget as high. */
export function reasoningAllowanceTokens(level: ThinkingLevel, budgets?: ThinkingBudgets): number {
	if (level === "off") return 0;
	const budgetLevel = level === "xhigh" || level === "max" ? "high" : level;
	return budgets?.[budgetLevel] ?? DEFAULT_REASONING_TOKENS[budgetLevel];
}

/** Output tokens one native checkpoint request asks for. Its character limit is four per token. */
export function checkpointOutputTokens(model: Model<Api>): number {
	const tokens = checkpointMaxTokens(model.contextWindow);
	return Math.min(tokens, model.maxTokens > 0 ? model.maxTokens : tokens);
}

/**
 * The response reserve a compacted context must leave: the configured
 * reserve, counting at most half the context window so a small window with
 * a large configured reserve can still compact.
 */
export function compactionResponseReserve(contextWindow: number, reserveTokens: number): number {
	return contextWindow > 0 ? Math.min(reserveTokens, Math.floor(contextWindow / 2)) : reserveTokens;
}

/** Output and reasoning tokens one native checkpoint request may produce, within the model's output limit. */
export function nativeOutputAllowance(
	model: Model<Api>,
	thinkingLevel: ThinkingLevel,
	thinkingBudgets?: ThinkingBudgets,
): number {
	const reasoning = reasoningAllowanceTokens(compactionReasoningLevel(model, thinkingLevel), thinkingBudgets);
	return Math.min(
		checkpointOutputTokens(model) + reasoning,
		model.maxTokens > 0 ? model.maxTokens : Number.MAX_SAFE_INTEGER,
	);
}

/**
 * Tokens a native compaction request needs beside the conversation it
 * compacts: its output and reasoning, its instruction, and a margin.
 */
export function nativeCompactionAllowance(
	model: Model<Api>,
	thinkingLevel: ThinkingLevel,
	thinkingBudgets?: ThinkingBudgets,
): number {
	return (
		nativeOutputAllowance(model, thinkingLevel, thinkingBudgets) + NATIVE_INSTRUCTION_TOKENS + REQUEST_MARGIN_TOKENS
	);
}

/**
 * The reserve automatic compaction triggers with: the configured response
 * reserve plus the native compaction allowance, so the native request fits
 * when compaction starts. The allowance never moves the trigger below half
 * the context window; small windows fall back to chunked summaries instead.
 */
export function compactionTriggerReserve(
	model: Model<Api>,
	reserveTokens: number,
	thinkingLevel: ThinkingLevel,
	thinkingBudgets?: ThinkingBudgets,
): number {
	if (!(model.contextWindow > 0)) return reserveTokens;
	const headroom = Math.max(0, Math.floor(model.contextWindow * MIN_TRIGGER_WINDOW_SHARE) - reserveTokens);
	return reserveTokens + Math.min(nativeCompactionAllowance(model, thinkingLevel, thinkingBudgets), headroom);
}
