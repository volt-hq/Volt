/**
 * The transcript view of a message-like entry (RFC §4.3): one shape for every
 * profile, a pure function of the entry and the log before it. Text is
 * bounded per entry by the profile (`truncated` says the `content` query has
 * the rest); tool items carry their tool call's arguments from the entry's
 * ancestors and, on full-fidelity profiles, diff and patch previews.
 */

import type { ImageContent, TextContent, ToolCall } from "@hansjm10/volt-ai";
import type { TranscriptItem } from "@hansjm10/volt-protocol";
import { extractVisibleTextContent } from "../../messages.ts";
import { projectRpcBackgroundJobDetails } from "../../rpc/background-jobs.ts";
import { getRemoteVisibleCustomMessageRole } from "../../rpc/custom-message-projection.ts";
import type { CommittedSessionEntry } from "../../session-manager.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../../subagents/tool-names.ts";
import type { Profile } from "../profiles.ts";
import {
	boundSummaryWithMetadata,
	boundText,
	getBoundedString,
	getToolPath,
	MUTATION_PREVIEW_LIMIT,
	projectSubagentDetails,
	projectToolArgs,
	summarizeToolResult,
	TOOL_COMMAND_LIMIT,
	TOOL_SUMMARY_LIMIT,
} from "./tool-view.ts";

/** The log before a projected entry: lookups by id, host-only records included. */
export interface ProjectionSource {
	entry(id: string): CommittedSessionEntry | undefined;
}

type AssistantPart = NonNullable<TranscriptItem["parts"]>[number];

/** Ancestors a tool result's call is looked up through, at most. */
const TOOL_CALL_SEARCH_DEPTH = 1_024;

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

/** A text view with the profile's bound, and its image count. */
function textItem(
	role: TranscriptItem["role"],
	content: unknown,
	profile: Profile,
): Pick<TranscriptItem, "role" | "text" | "truncated" | "imageCount"> {
	const text = boundScalars(extractVisibleTextContent(content), profile.limits.textScalars);
	const imageCount = messageImages(content).length;
	return { role, text: text.text, truncated: text.truncated, ...(imageCount > 0 ? { imageCount } : {}) };
}

/** The role a displayed custom message shows with; remote-visible types keep their remote role. */
function customRole(customType: string): TranscriptItem["role"] {
	return getRemoteVisibleCustomMessageRole(customType, true) ?? "system";
}

function assistantItem(
	content: ReadonlyArray<TextContent | { type: "thinking"; thinking: string; redacted?: boolean } | ToolCall>,
	stopReason: TranscriptItem["stopReason"],
	profile: Profile,
): TranscriptItem {
	let budget = profile.limits.textScalars;
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
	const text = parts
		.filter((part): part is Extract<AssistantPart, { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("");
	return {
		role: "assistant",
		text,
		truncated,
		...(parts.length > 0 ? { parts } : {}),
		...(stopReason === undefined ? {} : { stopReason }),
	};
}

function toolResultItem(
	entry: CommittedSessionEntry,
	message: {
		toolCallId: string;
		toolName: string;
		content: ReadonlyArray<TextContent | ImageContent>;
		details?: unknown;
		isError: boolean;
	},
	source: ProjectionSource,
	profile: Profile,
): TranscriptItem {
	const toolName = message.toolName;
	const args = findToolCall(entry, message.toolCallId, source)?.arguments;
	const status = message.isError ? "failed" : "completed";
	const path = getToolPath(toolName, args);
	const details = isRecord(message.details) ? message.details : undefined;
	const background = projectRpcBackgroundJobDetails(details);
	const summary = background
		? boundSummaryWithMetadata(
				`Background job ${background.backgroundJob.id}: ${background.backgroundJob.status} (snapshot)`,
				TOOL_SUMMARY_LIMIT,
			)
		: summarizeToolResult(toolName, status, args, path);
	const projectedArgs = projectToolArgs(toolName, args);
	const projectedDetails = background
		? background
		: toolName === "subagent" || toolName === SUBAGENT_REGISTRY_TOOL_NAME
			? projectSubagentDetails(details)
			: undefined;
	const output = boundScalars(extractVisibleTextContent(message.content), profile.limits.textScalars);
	const imageCount = messageImages(message.content).length;
	const full = profile.fidelity === "full";
	const diffPreview = full ? getBoundedString(details, "diff", MUTATION_PREVIEW_LIMIT) : undefined;
	const patchPreview = full ? getBoundedString(details, "patch", MUTATION_PREVIEW_LIMIT) : undefined;
	return {
		role: "tool",
		text: summary.text,
		truncated: summary.truncated,
		toolCallId: message.toolCallId,
		toolName,
		status,
		summary: summary.text,
		...(path === undefined ? {} : { path }),
		...(projectedArgs === undefined ? {} : { args: projectedArgs }),
		...(projectedDetails === undefined ? {} : { details: projectedDetails }),
		...(output.text.length > 0 ? { output: output.text, outputTruncated: output.truncated } : {}),
		...(imageCount > 0 ? { imageCount } : {}),
		...(diffPreview === undefined ? {} : { diffPreview }),
		...(patchPreview === undefined ? {} : { patchPreview }),
	};
}

function bashItem(
	message: { command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean },
	profile: Profile,
): TranscriptItem {
	const failed = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
	const command = boundSummaryWithMetadata(message.command, TOOL_COMMAND_LIMIT);
	const parts = [`Ran command: ${command.text}`];
	if (message.truncated) parts.push("output truncated");
	if (message.cancelled) parts.push("cancelled");
	else if (message.exitCode !== undefined) parts.push(`exit ${message.exitCode}`);
	const summary = boundSummaryWithMetadata(parts.join("; "), TOOL_SUMMARY_LIMIT);
	const output = boundScalars(message.output, profile.limits.textScalars);
	return {
		role: "tool",
		text: summary.text,
		truncated: command.truncated || summary.truncated,
		toolName: "bash",
		status: failed ? "failed" : "completed",
		summary: summary.text,
		...(message.command.trim().length > 0
			? { args: { command: boundText(message.command, TOOL_COMMAND_LIMIT) } }
			: {}),
		...(output.text.length > 0
			? { output: output.text, outputTruncated: output.truncated || message.truncated }
			: {}),
	};
}

/** The transcript view of a message-like entry, or none for an entry no transcript shows. */
export function projectTranscriptItem(
	entry: CommittedSessionEntry,
	source: ProjectionSource,
	profile: Profile,
): TranscriptItem | undefined {
	switch (entry.type) {
		case "compaction": {
			const summary = boundScalars(entry.summary, profile.limits.textScalars);
			return { role: "system", text: summary.text, truncated: summary.truncated };
		}
		case "branch_summary": {
			const summary = boundScalars(entry.summary, profile.limits.textScalars);
			return { role: "system", text: summary.text, truncated: summary.truncated };
		}
		case "custom_message":
			return entry.display ? textItem(customRole(entry.customType), entry.content, profile) : undefined;
		case "message": {
			const message = entry.message;
			switch (message.role) {
				case "user":
					return {
						...textItem("user", message.content, profile),
						...(entry.clientMessageId === undefined ? {} : { clientMessageId: entry.clientMessageId }),
					};
				case "assistant":
					return assistantItem(message.content, message.stopReason, profile);
				case "toolResult":
					return toolResultItem(entry, message, source, profile);
				case "bashExecution":
					return bashItem(message, profile);
				case "custom":
					return message.display ? textItem(customRole(message.customType), message.content, profile) : undefined;
				default:
					return undefined;
			}
		}
		default:
			return undefined;
	}
}
