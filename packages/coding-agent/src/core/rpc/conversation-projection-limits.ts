import type { ActiveToolCallState, AssistantMessage } from "@hansjm10/volt-ai";
import { measureRpcJsonBytesWithin, projectRpcUtf8Prefix } from "./session-state.ts";

/** Hard wire envelope shared by the projection feed and subscriber snapshot builders. */
export const DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES = 4 * 1024 * 1024;

/** Mirrored by VoltRPCConversationProjectionLimits in volt-app. */
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS = 128;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES = 256 * 1024;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES = 64 * 1024;
export const DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES = 384 * 1024;

export class ConversationProjectionLimitError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ConversationProjectionLimitError";
		this.code = code;
	}
}

export interface ConversationProjectionAssistantSnapshotMetrics {
	readonly contentBytes: readonly number[];
	readonly cumulativeContentBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** UTF-8 byte count that stops as soon as the supplied bound is exceeded. */
export function measureConversationProjectionUtf8BytesWithin(value: string, maxBytes: number): number | null {
	const projected = projectRpcUtf8Prefix(value, maxBytes);
	return projected.truncated ? null : projected.utf8Bytes;
}

function assistantBlockBytes(block: unknown, index: number): number {
	const record = isRecord(block) ? block : undefined;
	const type = record?.type;
	if (type === "text") {
		const text = typeof record?.text === "string" ? record.text : "";
		const bytes = measureConversationProjectionUtf8BytesWithin(
			text,
			DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
		);
		if (bytes === null) {
			throw new ConversationProjectionLimitError(
				"assistant_cumulative_content_bytes",
				`Assistant projection exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES}-byte cumulative content limit`,
			);
		}
		return bytes;
	}
	if (type === "thinking") {
		if (record?.redacted === true) return 0;
		const thinking =
			typeof record?.thinking === "string" ? record.thinking : typeof record?.text === "string" ? record.text : "";
		const bytes = measureConversationProjectionUtf8BytesWithin(
			thinking,
			DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
		);
		if (bytes === null) {
			throw new ConversationProjectionLimitError(
				"assistant_cumulative_content_bytes",
				`Assistant projection exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES}-byte cumulative content limit`,
			);
		}
		return bytes;
	}
	if (type === "redacted_thinking" || type === "redactedThinking") {
		return 0;
	}

	const bytes = measureRpcJsonBytesWithin(
		block,
		DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
	);
	if (bytes === null) {
		const toolCall = type === "toolCall" || type === "tool_call" || type === "toolcall" || type === "tool_use";
		throw new ConversationProjectionLimitError(
			toolCall ? "assistant_tool_call_bytes" : "assistant_content_block_bytes",
			`${toolCall ? "Assistant tool call" : "Assistant content block"} ${index} exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES}-byte serialized limit`,
		);
	}
	return bytes;
}

/**
 * Validate one complete assistant message before a projector adopts or clones
 * it. Text/thinking contribute their UTF-8 payload; tool and unknown blocks
 * contribute their serialized JSON, exactly matching volt-app's retained-state
 * accounting.
 */
export function assertConversationProjectionAssistantSnapshotWithinLimits(
	message: AssistantMessage,
	options: { enforceSerializedSnapshot?: boolean } = {},
): ConversationProjectionAssistantSnapshotMetrics {
	if (message.content.length > DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS) {
		throw new ConversationProjectionLimitError(
			"assistant_content_block_count",
			`Assistant projection exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS}-block content limit`,
		);
	}
	if (
		options.enforceSerializedSnapshot !== false &&
		measureRpcJsonBytesWithin(message, DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES) ===
			null
	) {
		throw new ConversationProjectionLimitError(
			"assistant_snapshot_bytes",
			`Assistant projection exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES}-byte snapshot limit`,
		);
	}

	let cumulativeContentBytes = 0;
	const contentBytes: number[] = [];
	for (const [index, block] of message.content.entries()) {
		const bytes = assistantBlockBytes(block, index);
		if (
			bytes >
			DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES - cumulativeContentBytes
		) {
			throw new ConversationProjectionLimitError(
				"assistant_cumulative_content_bytes",
				`Assistant projection exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES}-byte cumulative content limit`,
			);
		}
		cumulativeContentBytes += bytes;
		contentBytes.push(bytes);
	}
	return Object.freeze({
		contentBytes: Object.freeze(contentBytes),
		cumulativeContentBytes,
	});
}

export function assertConversationProjectionToolArgumentWithinLimits(value: string, contentIndex: number): number {
	const bytes = measureConversationProjectionUtf8BytesWithin(
		value,
		DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
	);
	if (bytes === null) {
		throw new ConversationProjectionLimitError(
			"assistant_tool_call_bytes",
			`Assistant tool call ${contentIndex} exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES}-byte raw argument limit`,
		);
	}
	return bytes;
}

export function assertConversationProjectionToolCallWithinLimits(value: unknown, contentIndex: number): number {
	const bytes = measureRpcJsonBytesWithin(
		value,
		DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
	);
	if (bytes === null) {
		throw new ConversationProjectionLimitError(
			"assistant_tool_call_bytes",
			`Assistant tool call ${contentIndex} exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES}-byte serialized limit`,
		);
	}
	return bytes;
}

export function assertConversationProjectionAssistantToolStateWithinLimits(
	message: AssistantMessage,
	toolState: readonly ActiveToolCallState[],
	metrics = assertConversationProjectionAssistantSnapshotWithinLimits(message),
): void {
	const contentBytes = [...metrics.contentBytes];
	let cumulativeContentBytes = metrics.cumulativeContentBytes;
	const seen = new Set<number>();
	for (const entry of toolState) {
		const bytes = assertConversationProjectionToolArgumentWithinLimits(entry.argsText, entry.contentIndex);
		if (seen.has(entry.contentIndex)) continue;
		seen.add(entry.contentIndex);
		const block = message.content[entry.contentIndex];
		if (block?.type !== "toolCall") continue;
		const previousBytes = contentBytes[entry.contentIndex] ?? 0;
		const withoutPrevious = cumulativeContentBytes - previousBytes;
		if (
			withoutPrevious < 0 ||
			bytes > DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES - withoutPrevious
		) {
			throw new ConversationProjectionLimitError(
				"assistant_cumulative_content_bytes",
				`Assistant projection exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES}-byte cumulative content limit`,
			);
		}
		contentBytes[entry.contentIndex] = bytes;
		cumulativeContentBytes = withoutPrevious + bytes;
	}
}

export function assertConversationProjectionCumulativeContentWithinLimits(
	metrics: ConversationProjectionAssistantSnapshotMetrics,
	contentIndex: number,
	nextBytes: number,
): void {
	const previousBytes = metrics.contentBytes[contentIndex] ?? 0;
	const withoutPrevious = metrics.cumulativeContentBytes - previousBytes;
	if (
		withoutPrevious < 0 ||
		nextBytes > DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES - withoutPrevious
	) {
		throw new ConversationProjectionLimitError(
			"assistant_cumulative_content_bytes",
			`Assistant projection exceeded its ${DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES}-byte cumulative content limit`,
		);
	}
}
