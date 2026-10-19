/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { AssistantMessage, JsonValue, Model, SimpleStreamOptions, Tool, Usage } from "@hansjm10/volt-ai";
import { estimateToolDefinitionTokens } from "@hansjm10/volt-ai";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import type { CompactionEntry, SessionEntry } from "../session-manager.ts";
import {
	CHECKPOINT_CHARS_PER_TOKEN,
	fileListsMaxChars,
	reasoningAllowanceTokens,
	splitCheckpointTokens,
} from "./budget.ts";
import {
	CHECKPOINT_FORMAT,
	CHECKPOINT_RULES,
	type CheckpointPurpose,
	type CheckpointRequester,
	type CheckpointTarget,
	checkpointLengthRules,
	composeCheckpoint,
	formatFileLists,
	generateCheckpoint,
	streamCheckpointRequester,
	stripHostBlocks,
	TURN_PREFIX_FORMAT,
	TURN_PREFIX_RULES,
} from "./checkpoint.ts";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	getConversationCharBudget,
	getSummarizationOutputTokenBudget,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** One dispatched session-compaction request, including retries and fallback chunks. */
export type CompactionRequestUsage = {
	strategy: "native" | "chunked";
	/** What the request summarized: the whole conversation (native), a history chunk, or a split turn's prefix. */
	purpose: CheckpointPurpose;
	/** One-based dispatch order across the entire compaction, not completion order. */
	attempt: number;
	provider: string;
	model: string;
	/** Dispatch time in epoch milliseconds. */
	startedAt: number;
	/** Characters the request asked the checkpoint to stay within. */
	targetChars: number;
	/** Characters above which the candidate was rejected. */
	maxChars: number;
	/** Visible text characters the response produced, or streamed before it was stopped. */
	textChars?: number;
	/** The candidate exceeded its limit and was discarded; a shorter retry follows unless attempts ran out. */
	rejected?: "oversized";
	/** Milliseconds from dispatch to the first stream event. */
	timeToFirstEventMs?: number;
	/** Milliseconds from dispatch to the first summary text; reasoning usually precedes it. */
	timeToFirstTextMs?: number;
	/** Milliseconds from dispatch until the request settled. */
	durationMs?: number;
	/** Omitted when the request failed before a terminal provider response. */
	stopReason?: AssistantMessage["stopReason"];
	/** Provider-reported token counts; omitted when unavailable or invalid. */
	usage?: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">;
	/** Owned, redacted Codex request diagnostics; unrelated or invalid telemetry is omitted. */
	diagnostics?: Pick<NonNullable<AssistantMessage["diagnostics"]>[number], "type" | "timestamp" | "details">[];
};

/** Details stored in CompactionEntry.details for file tracking and request accounting. */
export type CompactionDetails = {
	readFiles: string[];
	modifiedFiles: string[];
	/** Captured by built-in session compaction, not the standalone summarization helper. */
	requests?: CompactionRequestUsage[];
};

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if volt-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = JsonValue> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Estimated context tokens after rebuilding from the new compaction boundary. */
	estimatedTokensAfter?: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	/** Resolved absolute threshold for the selected model; 0 or omitted uses only the context-limit trigger. */
	thresholdTokens?: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
};

export interface SummarizationRetryOptions {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: readonly AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Sum per-message token estimates, ignoring any usage data on the messages.
 * Use for rebuilt contexts (e.g. after compaction), where retained assistant
 * messages carry usage from the pre-compaction context that would be stale.
 */
export function estimateMessagesTokens(messages: readonly AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 * Provider usage already includes the request's tool definitions, so active tools are
 * added only when no valid provider usage exists.
 */
export function estimateContextTokens(
	messages: readonly AgentMessage[],
	tools?: readonly Tool[],
): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		const estimated = estimateMessagesTokens(messages) + estimateToolDefinitionTokens(tools);
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/** The context a request sends: messages, active tool definitions, and system prompt. */
export interface RequestTokenContext {
	readonly messages: readonly AgentMessage[];
	readonly tools?: readonly Tool[];
	readonly systemPrompt?: string;
}

/**
 * Estimate the tokens a request with this context sends. Provider usage of the
 * latest response newer than the latest compaction already counts the system
 * prompt and tools; later messages are added by character estimate. Without
 * such usage (retained responses carry usage of the larger pre-compaction
 * context), everything is estimated from characters.
 */
export function estimateRequestTokens(context: RequestTokenContext): number {
	const { messages } = context;
	let compactedAt = Number.NEGATIVE_INFINITY;
	for (const message of messages) {
		if (message.role === "compactionSummary") compactedAt = Math.max(compactedAt, message.timestamp);
	}
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		const usage = getAssistantUsage(message);
		if (!usage || message.timestamp <= compactedAt) continue;
		const usageTokens = calculateContextTokens(usage);
		if (!(usageTokens > 0)) continue;
		let tokens = usageTokens;
		for (let j = i + 1; j < messages.length; j++) tokens += estimateTokens(messages[j]);
		return tokens;
	}
	return (
		estimateMessagesTokens(messages) +
		estimateToolDefinitionTokens(context.tools) +
		Math.ceil((context.systemPrompt?.length ?? 0) / 4)
	);
}

/**
 * Check if compaction should trigger based on context usage.
 */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	const threshold = settings.thresholdTokens;
	return (
		contextTokens > contextWindow - settings.reserveTokens ||
		(typeof threshold === "number" && Number.isSafeInteger(threshold) && threshold > 0 && contextTokens >= threshold)
	);
}

// ============================================================================
// Cut point detection
// ============================================================================

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | Array<{ type: string; text?: string }>): number {
	if (typeof content === "string") {
		return content.length;
	}

	let chars = 0;
	for (const block of content) {
		if (block.type === "text" && block.text) {
			chars += block.text.length;
		} else if (block.type === "image") {
			chars += ESTIMATED_IMAGE_CHARS;
		}
	}
	return chars;
}

/**
 * Estimate token count for a message using chars/4 heuristic.
 * This is conservative (overestimates tokens).
 */
export function estimateTokens(message: AgentMessage): number {
	let chars = 0;

	switch (message.role) {
		case "user": {
			chars = estimateTextAndImageContentChars(
				(message as { content: string | Array<{ type: string; text?: string }> }).content,
			);
			return Math.ceil(chars / 4);
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					chars += block.text.length;
				} else if (block.type === "thinking") {
					chars += block.thinking.length;
				} else if (block.type === "toolCall") {
					chars += block.name.length + JSON.stringify(block.arguments).length;
				}
			}
			return Math.ceil(chars / 4);
		}
		case "custom":
		case "toolResult": {
			chars = estimateTextAndImageContentChars(message.content);
			return Math.ceil(chars / 4);
		}
		case "bashExecution": {
			chars = message.command.length + message.output.length;
			return Math.ceil(chars / 4);
		}
		case "branchSummary":
		case "compactionSummary": {
			chars = message.summary.length;
			return Math.ceil(chars / 4);
		}
	}

	return 0;
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "fast_mode_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
			case "session_info":
				break;
		}

		// branch_summary and custom_message are user-role messages, valid cut points
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps at most `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated context entry sizes.
 * Stop before retaining an entry that would exceed keepRecentTokens.
 *
 * Can cut at user, assistant, custom message, or branch summary entries (never tool
 * results). When cutting at an assistant message with tool calls, its tool results
 * come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated context message sizes.
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first context entry.

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const message = getMessageFromEntryForCompaction(entries[i]);
		if (!message) continue;

		const messageTokens = estimateTokens(message);
		if (accumulatedTokens + messageTokens > keepRecentTokens) {
			// Exclude the crossing message by cutting at the next valid boundary. If
			// there is no later boundary, retain the newest valid suffix so compaction
			// still advances without separating tool results from their assistant call.
			cutIndex = cutPoints.find((candidate) => candidate > i) ?? cutPoints[cutPoints.length - 1];
			break;
		}
		accumulatedTokens += messageTokens;
	}

	// Scan backwards from cutIndex to include preceding non-context entries.
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (getMessageFromEntryForCompaction(prevEntry)) {
			break;
		}
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Summarization
// ============================================================================

const HISTORY_INTRO =
	"The messages above are a conversation to summarize. Create a structured context checkpoint that another LLM will use to continue the work.";

const HISTORY_UPDATE_INTRO = `The messages above are the NEXT chronological part of the conversation. <previous-summary> holds the checkpoint of everything before them.

Write ONE updated checkpoint covering the whole conversation so far: carry its durable sections forward, add a History line for the newly summarized phase, and rewrite the current-state sections from the new messages. Do not output two checkpoints.`;

const TURN_PREFIX_INTRO = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix.`;

const TURN_PREFIX_UPDATE_INTRO = `The messages above are the next chronological part of a turn prefix that was too large to keep. <previous-summary> holds the summary of the earlier part.

Write ONE updated prefix summary covering the whole prefix so far.`;

/** The longest length instruction a prompt can carry, for sizing the source a request leaves room for. */
const LONGEST_TARGET: CheckpointTarget = {
	targetChars: 99_999_999,
	maxChars: 99_999_999,
	correction: { observedChars: 99_999_999 },
};

type SummaryKind = "history" | "turn_prefix";

function summaryPrompt(
	kind: SummaryKind,
	update: boolean,
	target: CheckpointTarget,
	customInstructions: string | undefined,
): string {
	const parts =
		kind === "history"
			? [
					update ? HISTORY_UPDATE_INTRO : HISTORY_INTRO,
					`Use this EXACT format:\n\n${CHECKPOINT_FORMAT}`,
					CHECKPOINT_RULES,
				]
			: [
					update ? TURN_PREFIX_UPDATE_INTRO : TURN_PREFIX_INTRO,
					`Use this EXACT format:\n\n${TURN_PREFIX_FORMAT}`,
					TURN_PREFIX_RULES,
				];
	parts.push(checkpointLengthRules(target));
	if (customInstructions) parts.push(`Additional focus: ${customInstructions}`);
	return parts.join("\n\n");
}

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

const MIN_SUMMARIZATION_SOURCE_CHARS = 2048;
const DEFAULT_SUMMARIZATION_CONTEXT_WINDOW = 128_000;

function createSummarizationTokenPlan(
	model: Model<any>,
	requestedMaxTokens: number,
	outputCapacity: number,
	thinkingLevel: ThinkingLevel | undefined,
): { maxTokens: number; effectiveOutputTokens: number; thinkingLevel: ThinkingLevel | undefined } {
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		const thinkingBudget = reasoningAllowanceTokens(thinkingLevel);
		const maxTokens = Math.min(requestedMaxTokens, Math.max(0, outputCapacity - thinkingBudget));
		const effectiveOutputTokens = Math.min(
			maxTokens + thinkingBudget,
			model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		);
		if (maxTokens >= 1 && effectiveOutputTokens <= outputCapacity) {
			return { maxTokens, effectiveOutputTokens, thinkingLevel };
		}
	}

	const maxTokens = Math.min(requestedMaxTokens, outputCapacity);
	return { maxTokens, effectiveOutputTokens: maxTokens, thinkingLevel: undefined };
}

/** Output tokens a summary gets from a response reserve, within the model's output limit. */
function summaryOutputTokens(model: Model<any>, reserveTokens: number): number {
	return Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
}

/**
 * Summarize one chronological chunk, rewriting `previousSummary` to cover it
 * when given. The request's character limit follows its output tokens, and
 * an oversized summary is regenerated from the same chunk and summary.
 */
async function summarizeChunk(
	kind: SummaryKind,
	requester: CheckpointRequester,
	messages: AgentMessage[],
	model: Model<any>,
	requestedMaxTokens: number,
	signal: AbortSignal | undefined,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: SummarizationRetryOptions | undefined,
): Promise<string> {
	// The host rebuilds the user-message record and file lists; the model carries only its own text.
	const previous = previousSummary ? stripHostBlocks(previousSummary) || undefined : undefined;
	const update = previous !== undefined;
	const instructions = kind === "history" ? customInstructions : undefined;
	// Leave model-specific room for instructions, the previous summary, and output.
	const fixedPromptChars =
		SUMMARIZATION_SYSTEM_PROMPT.length +
		summaryPrompt(kind, update, LONGEST_TARGET, instructions).length +
		(previous?.length ?? 0) +
		128;
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARIZATION_CONTEXT_WINDOW;
	const outputCapacity = getSummarizationOutputTokenBudget(
		contextWindow,
		Number.MAX_SAFE_INTEGER,
		fixedPromptChars + MIN_SUMMARIZATION_SOURCE_CHARS,
	);
	if (outputCapacity < 1) {
		throw new Error("Summarization instructions exceed the selected model context window");
	}
	const tokenPlan = createSummarizationTokenPlan(model, requestedMaxTokens, outputCapacity, thinkingLevel);
	// Serialize conversation to text so the model doesn't try to continue it.
	const conversationText = serializeConversation(convertToLlm(messages), {
		maxChars: getConversationCharBudget(contextWindow, tokenPlan.effectiveOutputTokens, fixedPromptChars),
	});
	const timestamp = Date.now();
	return generateCheckpoint(
		requester,
		{
			purpose: kind,
			operation: kind === "history" ? "Summarization" : "Turn prefix summarization",
			model,
			options: createSummarizationOptions(model, tokenPlan.maxTokens, signal, tokenPlan.thinkingLevel),
			maxChars: tokenPlan.maxTokens * CHECKPOINT_CHARS_PER_TOKEN,
			context: (target) => ({
				systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [
							{
								type: "text",
								text: [
									`<conversation>\n${conversationText}\n</conversation>`,
									...(previous === undefined ? [] : [`<previous-summary>\n${previous}\n</previous-summary>`]),
									summaryPrompt(kind, update, target, instructions),
								].join("\n\n"),
							},
						],
						timestamp,
					},
				],
			}),
		},
		retry,
	);
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, the summary is rewritten to cover both.
 * The summary gets about 80% of `reserveTokens` of output at four characters
 * per token; an oversized summary is regenerated shorter, at most twice.
 *
 * @param streamFn - Stream function that sends the request, such as an `AiClient`'s `streamSimple`
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	streamFn: StreamFn,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	retry?: SummarizationRetryOptions,
): Promise<string> {
	return summarizeChunk(
		"history",
		streamCheckpointRequester(streamFn),
		currentMessages,
		model,
		summaryOutputTokens(model, reserveTokens),
		signal,
		customInstructions,
		previousSummary,
		thinkingLevel,
		retry,
	);
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionContextBudget {
	tools?: readonly Tool[];
	contextWindow?: number;
	/**
	 * Tokens the compacted context spends beside its retained messages and tools:
	 * the system prompt, the plan checkpoint, and the largest checkpoint
	 * compaction installs. The response reserve is subtracted separately.
	 */
	fixedTokens?: number;
}

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
}

/**
 * Prepare compacting the branch `pathEntries`, root first. `messages` is that
 * branch's model context (the fold's `context.messages` for it); it measures
 * `tokensBefore`.
 */
export function prepareCompaction(
	pathEntries: SessionEntry[],
	messages: readonly AgentMessage[],
	settings: CompactionSettings,
	context: CompactionContextBudget = {},
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;
	const toolTokens = estimateToolDefinitionTokens(context.tools);
	const tokensBefore = estimateContextTokens(messages, context.tools).tokens;
	const fixedTokens = Math.max(0, context.fixedTokens ?? 0);
	const retainedMessageTokens =
		context.contextWindow !== undefined && context.contextWindow > 0
			? Math.min(
					settings.keepRecentTokens,
					Math.max(0, context.contextWindow - settings.reserveTokens - toolTokens - fixedTokens),
				)
			: settings.keepRecentTokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, retainedMessageTokens);

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const SUMMARIZATION_CHUNK_MAX_CHARS = 75_000;

function getSummarizationChunkBudget(model: Model<any>): number {
	const contextWindow = model.contextWindow > 0 ? model.contextWindow : DEFAULT_SUMMARIZATION_CONTEXT_WINDOW;
	return Math.max(
		MIN_SUMMARIZATION_SOURCE_CHARS,
		Math.min(SUMMARIZATION_CHUNK_MAX_CHARS, Math.floor(contextWindow * 0.25)),
	);
}

function groupMessagesForSummarization(messages: AgentMessage[]): AgentMessage[][] {
	const groups: AgentMessage[][] = [];
	for (let index = 0; index < messages.length; index += 1) {
		const message = messages[index];
		const group = [message];
		if (message.role === "assistant" && message.content.some((content) => content.type === "toolCall")) {
			while (messages[index + 1]?.role === "toolResult") {
				group.push(messages[index + 1]);
				index += 1;
			}
		}
		groups.push(group);
	}
	return groups;
}

function chunkMessagesForSummarization(messages: AgentMessage[], maxChars: number): AgentMessage[][] {
	const chunks: AgentMessage[][] = [];
	let current: AgentMessage[] = [];
	let currentChars = 0;

	for (const group of groupMessagesForSummarization(messages)) {
		const groupChars = serializeConversation(convertToLlm(group), {
			maxChars: Number.MAX_SAFE_INTEGER,
		}).length;
		const separatorChars = current.length === 0 ? 0 : 2;
		if (current.length > 0 && currentChars + separatorChars + groupChars > maxChars) {
			chunks.push(current);
			current = [];
			currentChars = 0;
		}
		current.push(...group);
		currentChars += (currentChars === 0 ? 0 : 2) + groupChars;
	}
	if (current.length > 0) {
		chunks.push(current);
	}
	return chunks;
}

async function generateSummaryInChunks(
	requester: CheckpointRequester,
	messages: AgentMessage[],
	model: Model<any>,
	maxTokens: number,
	signal: AbortSignal | undefined,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: SummarizationRetryOptions | undefined,
): Promise<string> {
	const chunks = chunkMessagesForSummarization(messages, getSummarizationChunkBudget(model));
	if (chunks.length === 0) {
		return summarizeChunk(
			"history",
			requester,
			[],
			model,
			maxTokens,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			retry,
		);
	}
	let summary = previousSummary;
	for (const chunk of chunks) {
		summary = await summarizeChunk(
			"history",
			requester,
			chunk,
			model,
			maxTokens,
			signal,
			customInstructions,
			summary,
			thinkingLevel,
			retry,
		);
	}
	return summary ?? "No prior history.";
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	requester: CheckpointRequester,
	messages: AgentMessage[],
	model: Model<any>,
	maxTokens: number,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	retry: SummarizationRetryOptions | undefined,
): Promise<string> {
	const chunks = chunkMessagesForSummarization(messages, getSummarizationChunkBudget(model));
	let summary: string | undefined;
	for (const chunk of chunks) {
		summary = await summarizeChunk(
			"turn_prefix",
			requester,
			chunk,
			model,
			maxTokens,
			signal,
			undefined,
			summary,
			thinkingLevel,
			retry,
		);
	}
	return summary ?? "No earlier turn context.";
}

/**
 * The generated checkpoint text for a preparation, without host-owned
 * blocks: the history summary, followed by a split turn's prefix summary.
 * Both share one output budget of about 80% of the preparation's
 * `reserveTokens`, split 75/25. Chunks are summarized chronologically, one
 * request at a time, so providers that permit only one active request can
 * compact; a failed or cancelled history summary never starts the prefix.
 */
export async function summarizeCompactionHistory(
	preparation: CompactionPreparation,
	model: Model<any>,
	requester: CheckpointRequester,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	retry?: SummarizationRetryOptions,
): Promise<string> {
	const { messagesToSummarize, turnPrefixMessages, isSplitTurn, previousSummary, settings } = preparation;
	const totalTokens = summaryOutputTokens(model, settings.reserveTokens);
	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const budget = splitCheckpointTokens(totalTokens);
		const historySummary =
			messagesToSummarize.length > 0 || previousSummary
				? await generateSummaryInChunks(
						requester,
						messagesToSummarize,
						model,
						budget.history,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						retry,
					)
				: "No prior history.";
		const turnPrefixSummary = await generateTurnPrefixSummary(
			requester,
			turnPrefixMessages,
			model,
			budget.turnPrefix,
			signal,
			thinkingLevel,
			retry,
		);
		return `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixSummary}`;
	}
	return generateSummaryInChunks(
		requester,
		messagesToSummarize,
		model,
		totalTokens,
		signal,
		customInstructions,
		previousSummary,
		thinkingLevel,
		retry,
	);
}

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param streamFn - Stream function that sends the summary requests, such as an `AiClient`'s `streamSimple`
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	streamFn: StreamFn,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	retry?: SummarizationRetryOptions,
): Promise<CompactionResult<CompactionDetails> & { details: CompactionDetails }> {
	const summary = await summarizeCompactionHistory(
		preparation,
		model,
		streamCheckpointRequester(streamFn),
		customInstructions,
		signal,
		thinkingLevel,
		retry,
	);
	if (!preparation.firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}
	const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
	return {
		summary: composeCheckpoint(summary, {
			fileLists: formatFileLists(readFiles, modifiedFiles, fileListsMaxChars(model.contextWindow)),
		}),
		firstKeptEntryId: preparation.firstKeptEntryId,
		tokensBefore: preparation.tokensBefore,
		details: { readFiles, modifiedFiles },
	};
}
