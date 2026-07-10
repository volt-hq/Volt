/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@earendil-works/volt-agent-core";
import type { Message } from "@earendil-works/volt-ai";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = block.arguments as Record<string, unknown> | undefined;
		if (!args) continue;

		const path = typeof args.path === "string" ? args.path : undefined;
		if (!path) continue;

		switch (block.name) {
			case "read":
				fileOps.read.add(path);
				break;
			case "write":
				fileOps.written.add(path);
				break;
			case "edit":
				fileOps.edited.add(path);
				break;
		}
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as XML tags for summary.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) {
		sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	}
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Aggregate character budget for a serialized conversation (~50k tokens).
 *
 * Per-part truncation alone does not bound the request: a long session can
 * accumulate thousands of parts. The aggregate cap keeps the summarization
 * request within a conservative budget for any compaction model.
 */
export const CONVERSATION_MAX_CHARS = 200_000;

/** Conservative upper bound for code, JSON, identifiers, and multilingual text. */
const SERIALIZED_CHARS_PER_TOKEN = 1;
/** Request framing, provider-added tokens, and token-estimation safety margin. */
const SUMMARIZATION_OVERHEAD_TOKENS = 1024;

/** Clamp requested output so mandatory prompt text still fits the model context. */
export function getSummarizationOutputTokenBudget(
	contextWindow: number,
	requestedOutputTokens: number,
	fixedPromptChars = 0,
): number {
	const requested = Number.isFinite(requestedOutputTokens) ? Math.max(0, Math.floor(requestedOutputTokens)) : 0;
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return requested;
	}
	const available = Math.floor(contextWindow) - SUMMARIZATION_OVERHEAD_TOKENS - Math.max(0, fixedPromptChars);
	return Math.min(requested, Math.max(0, available));
}

/**
 * Derive a conversation serialization budget from the selected model.
 * Unknown context windows retain the aggregate safety cap.
 */
export function getConversationCharBudget(
	contextWindow: number,
	maxOutputTokens: number,
	fixedPromptChars = 0,
): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
		return CONVERSATION_MAX_CHARS;
	}
	const outputTokens = Number.isFinite(maxOutputTokens) ? Math.max(0, maxOutputTokens) : 0;
	const inputTokens = Math.max(
		0,
		Math.floor(contextWindow) - Math.floor(outputTokens) - SUMMARIZATION_OVERHEAD_TOKENS,
	);
	const availableChars = inputTokens * SERIALIZED_CHARS_PER_TOKEN - Math.max(0, fixedPromptChars);
	return Math.min(CONVERSATION_MAX_CHARS, Math.max(0, Math.floor(availableChars)));
}

/** Budget share reserved for the opening of the conversation (the original goal). */
const CONVERSATION_HEAD_BUDGET_RATIO = 0.25;

/**
 * Truncate text to a maximum character length for summarization.
 * Keeps the beginning and appends a truncation marker when the budget permits.
 */
function truncateForSummary(text: string, maxChars: number): string {
	const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : text.length;
	if (text.length <= budget) return text;

	let keptChars = budget;
	while (keptChars >= 0) {
		const truncatedChars = text.length - keptChars;
		const marker = `\n\n[... ${truncatedChars} more characters truncated]`;
		if (marker.length > budget) {
			return text.slice(0, budget);
		}
		const nextKeptChars = Math.min(keptChars, budget - marker.length);
		if (nextKeptChars === keptChars) {
			return `${text.slice(0, keptChars)}${marker}`;
		}
		keptChars = nextKeptChars;
	}

	return "";
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Tool results are truncated per part, and the joined output is capped by an
 * aggregate budget that keeps the opening of the conversation plus the most
 * recent parts. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[], options?: { maxChars?: number }): string {
	const parts: string[] = [];

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: string[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => `${k}=${JSON.stringify(v)}`)
						.join(", ");
					toolCalls.push(`${block.name}(${argsStr})`);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
			}
		}
	}

	return joinPartsWithinBudget(parts, options?.maxChars ?? CONVERSATION_MAX_CHARS);
}

/**
 * Join serialized conversation parts under an aggregate character budget.
 *
 * When over budget, keeps the opening part (which usually states the user's
 * goal) and a contiguous run of the newest parts, replacing the omitted middle
 * with a marker. Contiguity is preserved so the summary model never sees a
 * misleading, cherry-picked narrative.
 */
function joinPartsWithinBudget(parts: string[], maxChars: number): string {
	const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : Number.MAX_SAFE_INTEGER;
	const full = parts.join("\n\n");
	if (full.length <= budget) {
		return full;
	}
	if (parts.length === 0 || budget === 0) {
		return "";
	}
	if (parts.length === 1) {
		return truncateForSummary(parts[0], budget);
	}

	const head = truncateForSummary(parts[0], Math.max(1, Math.floor(budget * CONVERSATION_HEAD_BUDGET_RATIO)));
	const tail: string[] = [];
	let omittedCount = parts.length - 1;
	let marker = createConversationOmissionMarker(omittedCount, head, tail, budget);
	if (marker === undefined) {
		return truncateForSummary(parts[0], budget);
	}

	for (let i = parts.length - 1; i >= 1; i--) {
		const candidateTail = [parts[i], ...tail];
		const candidateOmittedCount = i - 1;
		const candidateMarker = createConversationOmissionMarker(candidateOmittedCount, head, candidateTail, budget);
		if (candidateMarker === undefined) {
			if (tail.length === 0) {
				// The newest part is more important than retaining it intact. Reserve
				// at least one character for it, then truncate it into the remaining
				// tail budget instead of returning only the head and omission marker.
				const fittedMarker = createConversationOmissionMarker(candidateOmittedCount, head, [""], budget - 1);
				if (fittedMarker !== undefined) {
					const prefix = [head, ...(candidateOmittedCount === 0 ? [] : [fittedMarker]), ""].join("\n\n");
					const fittedPart = truncateForSummary(parts[i], budget - prefix.length);
					if (fittedPart.length > 0) {
						tail.unshift(fittedPart);
						omittedCount = candidateOmittedCount;
						marker = fittedMarker;
					}
				}
			}
			break;
		}
		tail.unshift(parts[i]);
		omittedCount = candidateOmittedCount;
		marker = candidateMarker;
	}

	return [head, ...(omittedCount === 0 ? [] : [marker]), ...tail].join("\n\n");
}

function createConversationOmissionMarker(
	omittedCount: number,
	head: string,
	tail: string[],
	budget: number,
): string | undefined {
	if (omittedCount === 0) {
		return [head, ...tail].join("\n\n").length <= budget ? "" : undefined;
	}

	const fullMarker = `[... ${omittedCount} earlier conversation ${omittedCount === 1 ? "part" : "parts"} omitted to fit the summarization budget ...]`;
	const compactMarker = `[... ${omittedCount} earlier ${omittedCount === 1 ? "part" : "parts"} omitted ...]`;
	for (const marker of [fullMarker, compactMarker]) {
		if ([head, marker, ...tail].join("\n\n").length <= budget) {
			return marker;
		}
	}
	return undefined;
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;
