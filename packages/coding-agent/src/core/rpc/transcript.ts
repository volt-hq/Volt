import { Buffer } from "node:buffer";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type { ImageContent } from "@hansjm10/volt-ai";
import {
	RPC_TRANSCRIPT_PAGE_DEFAULT_ITEMS as DEFAULT_TRANSCRIPT_LIMIT,
	RPC_TRANSCRIPT_PAGE_MAX_ITEMS as MAX_TRANSCRIPT_LIMIT,
	MESSAGE_IMAGES_ENTRY_MAX_ITEMS,
	MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES,
	MESSAGE_IMAGES_PAGE_MAX_ITEMS,
	MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES,
} from "@hansjm10/volt-protocol";
import { type BashExecutionMessage, extractVisibleTextContent } from "../messages.ts";
import {
	boundSummaryWithMetadata,
	boundText,
	boundTextWithMetadata,
	getBoundedString,
	getToolPath,
	MUTATION_PREVIEW_LIMIT,
	projectSubagentDetails,
	projectToolArgs,
	summarizeToolResult,
	TOOL_COMMAND_LIMIT,
	TOOL_SUMMARY_LIMIT,
} from "../protocol/projection/tool-view.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../subagents/tool-names.ts";
import { projectRpcBackgroundJobDetails } from "./background-jobs.ts";
import { getRemoteVisibleCustomMessageRole } from "./custom-message-projection.ts";
import { type ResolvedSessionToolCall, resolveSessionToolCallsByResultEntryId } from "./tool-call-resolution.ts";
import type {
	RpcConversationTranscriptItem,
	RpcMessageImage,
	RpcTranscriptItem,
	RpcTranscriptResponse,
	RpcTranscriptToolItem,
	RpcTranscriptToolStatus,
} from "./types.ts";

const MESSAGE_TEXT_LIMIT = 16_000;
const SUMMARY_TEXT_LIMIT = 1_000;
interface ProjectedTranscriptItem<T extends RpcTranscriptItem = RpcTranscriptItem> {
	item: T;
	truncated: boolean;
}

interface ProjectedTranscriptItems {
	items: RpcTranscriptItem[];
	truncatedEntryIds: ReadonlySet<string>;
}

export interface ProjectSessionTranscriptOptions {
	beforeEntryId?: string;
	limit?: number;
}

export function projectSessionTranscript(
	sessionManager: ReadonlySessionManager,
	options: ProjectSessionTranscriptOptions = {},
): RpcTranscriptResponse {
	const allItems = projectTranscriptItems(sessionManager.getBranch()).items;
	const beforeIndex = options.beforeEntryId
		? allItems.findIndex((item) => item.id === options.beforeEntryId)
		: allItems.length;
	const eligibleItems = beforeIndex === -1 ? [] : allItems.slice(0, beforeIndex);
	const limit = normalizeLimit(options.limit);
	const pageStart = Math.max(0, eligibleItems.length - limit);
	const items = eligibleItems.slice(pageStart);
	const hasMore = pageStart > 0;

	return {
		sessionId: sessionManager.getSessionId(),
		items,
		hasMore,
		nextBeforeEntryId: hasMore ? (items[0]?.id ?? null) : null,
	};
}

/**
 * Serialized-size budget for one get_message_images response. Keeps the frame
 * under volt-app's 4 MiB encoded JSONL cap, with explicit headroom for the
 * response envelope, identifiers, array commas, and the LF framing byte.
 */
export {
	MESSAGE_IMAGES_ENTRY_MAX_ITEMS,
	MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES,
	MESSAGE_IMAGES_PAGE_MAX_ITEMS,
	MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES,
	MESSAGE_IMAGES_RESPONSE_ENVELOPE_HEADROOM_BYTES,
} from "@hansjm10/volt-protocol";

export type ProjectMessageImagesResult =
	| { ok: true; entryId: string; totalImages: number; images: RpcMessageImage[]; nextImageIndex: number | null }
	| {
			ok: false;
			error:
				| "unknown_entry"
				| "invalid_cursor"
				| "image_too_large"
				| "image_count_exceeded"
				| "image_bytes_exceeded";
	  };

function getSerializedMessageImageBytes(image: ImageContent, index: number): number {
	return Buffer.byteLength(JSON.stringify({ ...image, index }), "utf8");
}

/**
 * Recovers the inline image blocks persisted on a session entry, paged from
 * `startImageIndex` under `budgetBytes`. Text-only transcript projections
 * advertise `imageCount`; reconnecting clients call this per entry to restore
 * user-message images after a cold restart.
 */
export function projectMessageImages(
	entries: SessionEntry[],
	entryId: string,
	startImageIndex = 0,
	budgetBytes = MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES,
): ProjectMessageImagesResult {
	const entry = entries.find((candidate) => candidate.id === entryId);
	if (!entry || entry.type !== "message") {
		return { ok: false, error: "unknown_entry" };
	}
	const allImages = extractMessageImages((entry.message as { content?: unknown }).content);
	if (
		!Number.isSafeInteger(startImageIndex) ||
		startImageIndex < 0 ||
		(allImages.length === 0 ? startImageIndex !== 0 : startImageIndex >= allImages.length)
	) {
		return { ok: false, error: "invalid_cursor" };
	}
	if (allImages.length > MESSAGE_IMAGES_ENTRY_MAX_ITEMS) {
		return { ok: false, error: "image_count_exceeded" };
	}
	const serializedImageBytes: number[] = [];
	let totalSerializedBytes = 0;
	for (const [index, image] of allImages.entries()) {
		const serializedBytes = getSerializedMessageImageBytes(image, index);
		if (serializedBytes > budgetBytes) {
			return { ok: false, error: "image_too_large" };
		}
		totalSerializedBytes += serializedBytes;
		if (totalSerializedBytes > MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES) {
			return { ok: false, error: "image_bytes_exceeded" };
		}
		serializedImageBytes.push(serializedBytes);
	}

	const images: RpcMessageImage[] = [];
	let usedBytes = 0;
	for (let index = startImageIndex; index < allImages.length; index++) {
		const image = allImages[index];
		const serializedBytes = serializedImageBytes[index];
		if (images.length >= MESSAGE_IMAGES_PAGE_MAX_ITEMS || usedBytes + serializedBytes > budgetBytes) {
			break;
		}
		images.push({ ...image, index });
		usedBytes += serializedBytes;
	}
	const nextImageIndex = startImageIndex + images.length < allImages.length ? startImageIndex + images.length : null;
	return { ok: true, entryId, totalImages: allImages.length, images, nextImageIndex };
}

/** Inline image blocks on a persisted message's content array. */
export function extractMessageImages(content: unknown): ImageContent[] {
	if (!Array.isArray(content)) {
		return [];
	}
	return content.filter(
		(block): block is ImageContent =>
			isRecord(block) &&
			block.type === "image" &&
			typeof block.data === "string" &&
			block.data.length > 0 &&
			typeof block.mimeType === "string",
	);
}

function normalizeLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
		return DEFAULT_TRANSCRIPT_LIMIT;
	}
	return Math.min(MAX_TRANSCRIPT_LIMIT, Math.floor(limit));
}

function projectTranscriptEntry(
	entry: SessionEntry,
	toolCall: ResolvedSessionToolCall | undefined,
): ProjectedTranscriptItem | undefined {
	if (entry.type === "compaction") {
		const text = boundTextWithMetadata(entry.summary, SUMMARY_TEXT_LIMIT);
		return {
			item: {
				id: entry.id,
				role: "summary",
				timestamp: normalizeTimestamp(entry.timestamp),
				title: "Conversation compacted",
				text: text.text,
			},
			truncated: text.truncated,
		};
	}

	if (entry.type === "custom_message") {
		return projectCustomMessage(entry);
	}

	if (entry.type !== "message") {
		return undefined;
	}

	const message = entry.message;
	if (message.role === "user") {
		const text = boundTextWithMetadata(extractVisibleTextContent(message.content), MESSAGE_TEXT_LIMIT);
		const imageCount = extractMessageImages(message.content).length;
		if (!text.text && imageCount === 0) {
			return undefined;
		}
		return {
			item: {
				id: entry.id,
				role: "user",
				text: text.text,
				timestamp: normalizeTimestamp(entry.timestamp),
				...(entry.clientMessageId === undefined ? {} : { clientMessageId: entry.clientMessageId }),
				...(imageCount > 0 ? { imageCount } : {}),
			},
			truncated: text.truncated,
		};
	}

	if (message.role === "assistant") {
		const text = boundTextWithMetadata(extractVisibleTextContent(message.content), MESSAGE_TEXT_LIMIT);
		if (!text.text) {
			return undefined;
		}
		return {
			item: {
				id: entry.id,
				role: "assistant",
				text: text.text,
				timestamp: normalizeTimestamp(entry.timestamp),
			},
			truncated: text.truncated,
		};
	}

	if (message.role === "toolResult") {
		return projectToolResult(entry.id, entry.timestamp, message, toolCall);
	}

	if (message.role === "bashExecution") {
		return projectBashExecution(entry.id, entry.timestamp, message);
	}

	return undefined;
}

function projectTranscriptItems(entries: SessionEntry[]): ProjectedTranscriptItems {
	const toolCallsByResultEntryId = resolveSessionToolCallsByResultEntryId(entries);
	const items: RpcTranscriptItem[] = [];
	const truncatedEntryIds = new Set<string>();
	for (const entry of entries) {
		const projected = projectTranscriptEntry(entry, toolCallsByResultEntryId.get(entry.id));
		if (!projected) continue;
		items.push(projected.item);
		if (projected.truncated) {
			truncatedEntryIds.add(projected.item.id);
		}
	}
	return { items, truncatedEntryIds };
}

function toConversationTranscriptItem(
	entry: SessionEntry,
	projected: ProjectedTranscriptItem,
): RpcConversationTranscriptItem {
	const item = projected.item;
	if (item.id !== entry.id) {
		throw new Error(`Transcript projection identity mismatch for session entry ${entry.id}`);
	}
	const base = {
		entryId: item.id,
		ordinal: entry.ordinal ?? 0,
		createdAt: item.timestamp,
	};
	if (item.role === "tool") {
		return {
			...base,
			role: "tool",
			text: item.summary,
			truncated: projected.truncated,
			toolName: item.toolName,
			status: item.status === "failed" ? "failed" : "completed",
			summary: item.summary,
			...(item.path === undefined ? {} : { path: item.path }),
			...(item.imageCount === undefined ? {} : { imageCount: item.imageCount }),
			...(item.args === undefined ? {} : { args: item.args }),
			...(item.details === undefined ? {} : { details: item.details }),
		};
	}
	const role = item.role === "summary" ? "system" : item.role;
	return {
		...base,
		role,
		text: item.text,
		truncated: projected.truncated,
		...(item.role === "user" && item.clientMessageId !== undefined ? { clientMessageId: item.clientMessageId } : {}),
		...(item.role === "user" && item.imageCount !== undefined ? { imageCount: item.imageCount } : {}),
	};
}

/** Local-RPC projection for one session-tree entry. */
export function projectConversationTranscriptEntry(
	entry: SessionEntry,
	toolCall: ResolvedSessionToolCall | undefined,
): RpcConversationTranscriptItem | undefined {
	const projected = projectTranscriptEntry(entry, toolCall);
	return projected ? toConversationTranscriptItem(entry, projected) : undefined;
}

/**
 * Local-RPC projection in the canonical conversation-item shape used by
 * session-tree pages. Remote callers use the stricter workspace sanitizer but
 * retain this exact schema.
 */
export function projectConversationTranscriptItems(entries: SessionEntry[]): RpcConversationTranscriptItem[] {
	const toolCallsByResultEntryId = resolveSessionToolCallsByResultEntryId(entries);
	const items: RpcConversationTranscriptItem[] = [];
	for (const entry of entries) {
		const item = projectConversationTranscriptEntry(entry, toolCallsByResultEntryId.get(entry.id));
		if (item) items.push(item);
	}
	return items;
}

function projectCustomMessage(
	entry: Extract<SessionEntry, { type: "custom_message" }>,
): ProjectedTranscriptItem | undefined {
	const role = getRemoteVisibleCustomMessageRole(entry.customType, entry.display);
	if (role === undefined) {
		return undefined;
	}
	const text = boundTextWithMetadata(extractVisibleTextContent(entry.content), MESSAGE_TEXT_LIMIT);
	if (!text.text) {
		return undefined;
	}
	return {
		item: { id: entry.id, role, text: text.text, timestamp: normalizeTimestamp(entry.timestamp) },
		truncated: text.truncated,
	};
}

function projectToolResult(
	entryId: string,
	timestamp: string,
	message: Extract<AgentMessage, { role: "toolResult" }>,
	toolCall: ResolvedSessionToolCall | undefined,
): ProjectedTranscriptItem<RpcTranscriptToolItem> {
	const args = toolCall?.arguments;
	const status: RpcTranscriptToolStatus = message.isError ? "failed" : "completed";
	const path = getToolPath(message.toolName, args);
	const details = isRecord(message.details) ? message.details : undefined;
	const backgroundDetails = projectRpcBackgroundJobDetails(details);
	const summary = backgroundDetails
		? boundSummaryWithMetadata(
				`Background job ${backgroundDetails.backgroundJob.id}: ${backgroundDetails.backgroundJob.status} (snapshot)`,
				TOOL_SUMMARY_LIMIT,
			)
		: summarizeToolResult(message.toolName, status, args, path);
	const item: RpcTranscriptToolItem = {
		id: entryId,
		role: "tool",
		toolName: message.toolName,
		status,
		summary: summary.text,
		timestamp: normalizeTimestamp(timestamp),
	};
	if (path) {
		item.path = path;
	}
	const imageCount = extractMessageImages(message.content).length;
	if (imageCount > 0) {
		item.imageCount = imageCount;
	}
	const diffPreview = getBoundedString(details, "diff", MUTATION_PREVIEW_LIMIT);
	if (diffPreview) {
		item.diffPreview = diffPreview;
	}
	const patchPreview = getBoundedString(details, "patch", MUTATION_PREVIEW_LIMIT);
	if (patchPreview) {
		item.patchPreview = patchPreview;
	}
	const projectedArgs = projectToolArgs(message.toolName, args);
	if (projectedArgs) {
		item.args = projectedArgs;
	}
	if (backgroundDetails) {
		item.details = backgroundDetails;
	} else if (message.toolName === "subagent" || message.toolName === SUBAGENT_REGISTRY_TOOL_NAME) {
		const subagentDetails = projectSubagentDetails(details);
		if (subagentDetails) {
			item.details = subagentDetails;
		}
	}
	return { item, truncated: summary.truncated };
}

function projectBashExecution(
	entryId: string,
	timestamp: string,
	message: BashExecutionMessage,
): ProjectedTranscriptItem<RpcTranscriptToolItem> {
	const failed = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
	const status: RpcTranscriptToolStatus = failed ? "failed" : "completed";
	const command = boundSummaryWithMetadata(message.command, TOOL_COMMAND_LIMIT);
	const summaryParts = [`Ran command: ${command.text}`];
	if (message.truncated) {
		summaryParts.push("output truncated");
	}
	if (message.cancelled) {
		summaryParts.push("cancelled");
	} else if (message.exitCode !== undefined) {
		summaryParts.push(`exit ${message.exitCode}`);
	}
	const summary = boundSummaryWithMetadata(summaryParts.join("; "), TOOL_SUMMARY_LIMIT);
	const item: RpcTranscriptToolItem = {
		id: entryId,
		role: "tool",
		toolName: "bash",
		status,
		summary: summary.text,
		timestamp: normalizeTimestamp(timestamp),
	};
	if (message.command.trim().length > 0) {
		item.args = { command: boundText(message.command, TOOL_COMMAND_LIMIT) };
	}
	return { item, truncated: command.truncated || summary.truncated };
}

function normalizeTimestamp(timestamp: string): string {
	const date = new Date(timestamp);
	return Number.isNaN(date.getTime()) ? timestamp : date.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
