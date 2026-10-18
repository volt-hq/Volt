/**
 * The transcript view of a message-like entry (RFC §4.3): one shape for every
 * projection, a pure function of the entry, the log before it, the
 * projection, and the presenter set. Text is bounded per entry by the
 * projection (`truncated` says the `content` query has the rest); a tool
 * item carries its presentation, presented with its tool call's arguments
 * from the entry's ancestors; a custom message whose type has a presenter
 * carries its presentation. On a transcript projection, a work notice's text
 * is rebuilt from its details.
 */

import type { ImageContent, JsonValue, TextContent, ToolCall } from "@hansjm10/volt-ai";
import {
	type ToolPresentation,
	type TranscriptItem,
	WORK_NOTICE_CUSTOM_TYPE,
	WORK_TITLE_MAX_CHARS,
	WorkNoticeDetailsSchema,
} from "@hansjm10/volt-protocol";
import { Check } from "typebox/value";
import { extractVisibleTextContent } from "../../messages.ts";
import type { CommittedSessionEntry } from "../../session-manager.ts";
import { workText } from "../../work/registry.ts";
import { getRemoteVisibleCustomMessageRole, type Projection } from "../profiles.ts";
import type { ProjectionCache } from "./cache.ts";
import { type PresentationSource, projectMessagePresentation, projectToolPresentation } from "./presentation.ts";

/**
 * The log before a projected entry (lookups by id, host-only records
 * included), what presents its tool calls and custom messages, and the cache
 * of its projected entries.
 */
export interface ProjectionSource extends PresentationSource {
	entry(id: string): CommittedSessionEntry | undefined;
	readonly cache?: ProjectionCache;
}

type AssistantPart = NonNullable<TranscriptItem["parts"]>[number];

/** Ancestors a tool result's call is looked up through, at most. */
const TOOL_CALL_SEARCH_DEPTH = 1_024;

/** What separates an assistant item's text blocks in its `text`: a blank line, as each block is its own Markdown. */
const ASSISTANT_TEXT_BLOCK_SEPARATOR = "\n\n";

/** The first `limit` Unicode scalars of `text`, and whether more remain. */
export function boundScalars(text: string, limit: number): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const scalars = Array.from(text);
	if (scalars.length <= limit) return { text, truncated: false };
	return { text: scalars.slice(0, limit).join(""), truncated: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Inline image blocks on message content. */
export function messageImages(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) return [];
	return content.filter(
		(block): block is ImageContent =>
			isRecord(block) &&
			block.type === "image" &&
			typeof block.data === "string" &&
			block.data.length > 0 &&
			typeof block.mimeType === "string",
	);
}

/** The tool call a tool result answers: the nearest ancestor assistant message that made it. */
function findToolCall(
	entry: CommittedSessionEntry,
	toolCallId: string,
	source: ProjectionSource,
): ToolCall | undefined {
	let parentId = entry.parentId;
	for (let depth = 0; parentId !== null && depth < TOOL_CALL_SEARCH_DEPTH; depth++) {
		const parent = source.entry(parentId);
		if (!parent) return undefined;
		if (parent.type === "message" && parent.message.role === "assistant") {
			const call = parent.message.content.find(
				(block): block is ToolCall => block.type === "toolCall" && block.id === toolCallId,
			);
			if (call) return call;
		}
		parentId = parent.parentId;
	}
	return undefined;
}

/** A text view with the projection's bound, and its image count. */
function textItem(
	role: TranscriptItem["role"],
	content: unknown,
	projection: Projection,
): Pick<TranscriptItem, "role" | "text" | "truncated" | "imageCount"> {
	const text = boundScalars(extractVisibleTextContent(content), projection.textScalars);
	const imageCount = messageImages(content).length;
	return { role, text: text.text, truncated: text.truncated, ...(imageCount > 0 ? { imageCount } : {}) };
}

/** A displayed custom message's view: its text, and its presentation when its type has a presenter. */
function customItem(
	message: { customType: string; content: string | (TextContent | ImageContent)[]; details?: unknown },
	source: ProjectionSource,
	projection: Projection,
): TranscriptItem {
	const presentation = projectMessagePresentation(
		{
			customType: message.customType,
			content: message.content,
			...(message.details === undefined ? {} : { details: message.details as JsonValue }),
		},
		source,
		projection,
	);
	return {
		...textItem(customRole(message.customType), message.content, projection),
		...(presentation === undefined ? {} : { presentation }),
	};
}

/** The role a displayed custom message shows with; remote-visible types keep their remote role. */
function customRole(customType: string): TranscriptItem["role"] {
	return getRemoteVisibleCustomMessageRole(customType, true) ?? "system";
}

/**
 * The text of a work notice as a transcript projection sends it, or undefined
 * for any other entry and on a full-fidelity projection. The notice's content
 * is not sent: it holds titles and results the host cut to a bound, where a
 * cut can leave the start of a root that redaction cannot match, or a kind's
 * own text. The text is rebuilt from the notice's details instead, each cut
 * field losing such a start; a notice whose details are not a work notice's
 * has no text.
 */
export function transcriptWorkNoticeText(entry: CommittedSessionEntry, projection: Projection): string | undefined {
	if (projection.fidelity !== "transcript") return undefined;
	const notice =
		entry.type === "custom_message"
			? entry
			: entry.type === "message" && entry.message.role === "custom"
				? entry.message
				: undefined;
	if (notice?.customType !== WORK_NOTICE_CUSTOM_TYPE || !notice.display) return undefined;
	const details = notice.details;
	if (!Check(WorkNoticeDetailsSchema, details)) return "";
	const cut = (text: string, max?: number): string => workText(projection.sourceCut(text), max);
	const lines = [
		`${cut(details.title, WORK_TITLE_MAX_CHARS)} (${details.kind} ${details.workId}) ${details.outcome}.`,
	];
	if (details.summary) lines.push(cut(details.summary));
	if (details.error) lines.push(`Error: ${cut(details.error)}`);
	return lines.join("\n");
}

function assistantItem(
	content: ReadonlyArray<TextContent | { type: "thinking"; thinking: string; redacted?: boolean } | ToolCall>,
	stopReason: TranscriptItem["stopReason"],
	projection: Projection,
): TranscriptItem {
	let budget = projection.textScalars;
	let truncated = false;
	const parts: AssistantPart[] = [];
	for (const block of content) {
		if (block.type === "text") {
			const bounded = boundScalars(block.text, budget);
			budget -= Array.from(bounded.text).length;
			truncated ||= bounded.truncated;
			parts.push({ type: "text", text: bounded.text, truncated: bounded.truncated });
		} else if (block.type === "thinking") {
			const bounded = boundScalars(block.thinking, budget);
			budget -= Array.from(bounded.text).length;
			truncated ||= bounded.truncated;
			parts.push({
				type: "thinking",
				text: bounded.text,
				...(bounded.truncated ? { truncated: true } : {}),
				...(block.redacted === true ? { redacted: true } : {}),
			});
		}
	}
	// The separators count against the bound too.
	const text = boundScalars(
		parts
			.flatMap((part) => (part.type === "text" && part.text.length > 0 ? [part.text] : []))
			.join(ASSISTANT_TEXT_BLOCK_SEPARATOR),
		projection.textScalars,
	);
	return {
		role: "assistant",
		text: text.text,
		truncated: truncated || text.truncated,
		...(parts.length > 0 ? { parts } : {}),
		...(stopReason === undefined ? {} : { stopReason }),
	};
}

/** Longest text of a tool item, in Unicode scalars. */
const TOOL_TEXT_MAX_SCALARS = 1_000;

/** A tool item's text: its presentation's title on one line, and how the call ended. */
function toolText(
	presentation: ToolPresentation,
	status: "completed" | "failed",
): { text: string; truncated: boolean } {
	const title =
		typeof presentation.title === "string"
			? presentation.title
			: presentation.title.map((span) => span.text).join("");
	return boundScalars(`${title.replace(/\s+/g, " ").trim()} (${status})`, TOOL_TEXT_MAX_SCALARS);
}

function toolResultItem(
	entry: CommittedSessionEntry,
	message: {
		toolCallId: string;
		toolName: string;
		content: ReadonlyArray<TextContent | ImageContent>;
		details?: unknown;
		isError: boolean;
		durationMs?: number;
	},
	source: ProjectionSource,
	projection: Projection,
): TranscriptItem {
	const toolName = message.toolName;
	const call = findToolCall(entry, message.toolCallId, source);
	const args = call === undefined ? undefined : projection.source(call).arguments;
	const status = message.isError ? "failed" : "completed";
	const imageCount = messageImages(message.content).length;
	const presentation = projectToolPresentation(
		toolName,
		{
			args: args ?? {},
			argsComplete: true,
			state: "done",
			result: {
				content: message.content,
				...(message.details === undefined ? {} : { details: message.details }),
				isError: message.isError,
				partial: false,
			},
		},
		// The generic presentation shows a call's arguments only on a full-fidelity projection.
		projection.fidelity === "full" ? (args ?? {}) : {},
		source,
		projection,
	);
	const text = toolText(presentation, status);
	return {
		role: "tool",
		text: text.text,
		truncated: text.truncated,
		toolCallId: message.toolCallId,
		toolName,
		status,
		...(message.durationMs === undefined ? {} : { durationMs: message.durationMs }),
		...(imageCount > 0 ? { imageCount } : {}),
		presentation,
	};
}

function bashItem(
	message: { command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean },
	source: ProjectionSource,
	projection: Projection,
): TranscriptItem {
	const failed = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
	// A user's command presents as the bash tool's would: its output, then how it ended.
	const ending = message.cancelled
		? "Command aborted"
		: message.exitCode !== undefined && message.exitCode !== 0
			? `Command exited with code ${message.exitCode}`
			: "";
	const presentation = projectToolPresentation(
		"bash",
		{
			args: { command: message.command },
			argsComplete: true,
			state: "done",
			result: {
				content: [{ type: "text", text: [message.output, ending].filter(Boolean).join("\n\n") }],
				isError: failed,
				partial: false,
			},
		},
		{ command: message.command },
		source,
		projection,
	);
	const status = failed ? "failed" : "completed";
	const text = toolText(presentation, status);
	return {
		role: "tool",
		text: text.text,
		truncated: text.truncated,
		toolName: "bash",
		status,
		presentation,
	};
}

/**
 * The submitting client's id the transcript view of `entry` carries: a
 * client-submitted user message's, as the projection's source of it.
 */
export function transcriptClientMessageId(entry: CommittedSessionEntry, projection: Projection): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user" || entry.clientMessageId === undefined) {
		return undefined;
	}
	return projection.source(entry.clientMessageId);
}

/**
 * The transcript view of a message-like entry, or none for an entry no
 * transcript shows. The view is projected from the projection's source of
 * the entry, so the remote projection's paths are redacted before any text
 * is cut.
 */
export function projectTranscriptItem(
	entry: CommittedSessionEntry,
	source: ProjectionSource,
	projection: Projection,
): TranscriptItem | undefined {
	const notice = transcriptWorkNoticeText(entry, projection);
	if (notice === undefined) return viewOf(entry, projection.source(entry), source, projection);
	const text = boundScalars(notice, projection.textScalars);
	return { role: customRole(WORK_NOTICE_CUSTOM_TYPE), text: text.text, truncated: text.truncated };
}

/** The view of `raw` from `entry`, the projection's source of it. */
function viewOf(
	raw: CommittedSessionEntry,
	entry: CommittedSessionEntry,
	source: ProjectionSource,
	projection: Projection,
): TranscriptItem | undefined {
	switch (entry.type) {
		case "compaction": {
			const summary = boundScalars(entry.summary, projection.textScalars);
			return { role: "system", text: summary.text, truncated: summary.truncated };
		}
		case "branch_summary": {
			const summary = boundScalars(entry.summary, projection.textScalars);
			return { role: "system", text: summary.text, truncated: summary.truncated };
		}
		case "custom_message":
			return entry.display ? customItem(entry, source, projection) : undefined;
		case "message": {
			const message = entry.message;
			switch (message.role) {
				case "user": {
					const clientMessageId = transcriptClientMessageId(raw, projection);
					return {
						...textItem("user", message.content, projection),
						...(clientMessageId === undefined ? {} : { clientMessageId }),
					};
				}
				case "assistant":
					return assistantItem(message.content, message.stopReason, projection);
				case "toolResult":
					return toolResultItem(entry, message, source, projection);
				case "bashExecution":
					return bashItem(message, source, projection);
				case "custom":
					return message.display ? customItem(message, source, projection) : undefined;
				default:
					return undefined;
			}
		}
		default:
			return undefined;
	}
}
