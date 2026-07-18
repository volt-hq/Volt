import { Buffer } from "node:buffer";
import type { AgentSession } from "../agent-session.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../subagents/tool-names.ts";
import { projectSubagentDetails } from "./transcript.ts";
import type {
	RpcActiveToolExecution,
	RpcProjectionCollectionTruncation,
	RpcProjectionTruncation,
	RpcSessionState,
	RpcSessionStateProjection,
} from "./types.ts";

export const RPC_SESSION_STATE_MAX_SERIALIZED_BYTES = 768 * 1024;
export const RPC_SESSION_MODEL_MAX_SERIALIZED_BYTES = 32 * 1024;
export const RPC_SESSION_QUEUE_MAX_SERIALIZED_BYTES = 128 * 1024;
export const RPC_SESSION_QUEUE_MAX_ITEMS = 128;
export const RPC_SESSION_QUEUE_ITEM_MAX_UTF8_BYTES = 16 * 1024;
export const RPC_SESSION_ACTIVE_TOOLS_MAX_SERIALIZED_BYTES = 256 * 1024;
export const RPC_SESSION_ACTIVE_TOOLS_MAX_ITEMS = 128;
export const RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES = 12 * 1024;
export const RPC_ACTIVE_TOOL_DETAILS_MAX_SERIALIZED_BYTES = 20 * 1024;
export const RPC_PROJECTION_STRING_MAX_UTF8_BYTES = 4 * 1024;

const RPC_SESSION_LABEL_MAX_UTF8_BYTES = 8 * 1024;
const RPC_PROJECTION_MAX_DEPTH = 6;
const RPC_PROJECTION_MAX_COLLECTION_ENTRIES = 32;
const RPC_PROJECTION_MAX_TOP_LEVEL_ENTRIES = 64;

export interface RpcBoundedRecordProjection {
	value: Record<string, unknown>;
	projection?: RpcProjectionTruncation;
}

export interface RpcBoundedStringProjection {
	value: string;
	projection?: RpcProjectionTruncation;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function measureRpcJsonBytes(value: unknown): number | null {
	try {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
	} catch {
		return null;
	}
}

function measureRpcJsonStringBytesWithin(value: string, maxBytes: number): number | null {
	let bytes = 2;
	for (let index = 0; index < value.length; index++) {
		const codeUnit = value.charCodeAt(index);
		if (
			codeUnit === 0x22 ||
			codeUnit === 0x5c ||
			codeUnit === 0x08 ||
			codeUnit === 0x09 ||
			codeUnit === 0x0a ||
			codeUnit === 0x0c ||
			codeUnit === 0x0d
		) {
			bytes += 2;
		} else if (codeUnit < 0x20) {
			bytes += 6;
		} else if (codeUnit <= 0x7f) {
			bytes += 1;
		} else if (codeUnit <= 0x7ff) {
			bytes += 2;
		} else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index++;
			} else {
				bytes += 6;
			}
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			bytes += 6;
		} else {
			bytes += 3;
		}
		if (bytes > maxBytes) return null;
	}
	return bytes;
}

function measureRpcJsonValueWithin(value: unknown, maxBytes: number, seen: WeakSet<object>): number | null {
	if (maxBytes < 0) return null;
	if (value === null) return maxBytes >= 4 ? 4 : null;
	if (typeof value === "string") return measureRpcJsonStringBytesWithin(value, maxBytes);
	if (typeof value === "boolean") {
		const bytes = value ? 4 : 5;
		return bytes <= maxBytes ? bytes : null;
	}
	if (typeof value === "number") {
		const bytes = Buffer.byteLength(JSON.stringify(Number.isFinite(value) ? value : null), "utf8");
		return bytes <= maxBytes ? bytes : null;
	}
	if (typeof value !== "object" || seen.has(value) || typeof (value as { toJSON?: unknown }).toJSON === "function") {
		return null;
	}
	seen.add(value);
	let bytes = 2;
	let entries = 0;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			if (entries > 0) bytes++;
			const entry = value[index];
			const entryBytes =
				typeof entry === "undefined" || typeof entry === "function" || typeof entry === "symbol"
					? 4
					: measureRpcJsonValueWithin(entry, maxBytes - bytes, seen);
			if (entryBytes === null) {
				seen.delete(value);
				return null;
			}
			bytes += entryBytes;
			if (bytes > maxBytes) {
				seen.delete(value);
				return null;
			}
			entries++;
		}
	} else {
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const entry = (value as Record<string, unknown>)[key];
			if (typeof entry === "undefined" || typeof entry === "function" || typeof entry === "symbol") continue;
			const keyBytes = measureRpcJsonStringBytesWithin(key, maxBytes - bytes);
			if (keyBytes === null) {
				seen.delete(value);
				return null;
			}
			if (entries > 0) bytes++;
			bytes += keyBytes + 1;
			const entryBytes = measureRpcJsonValueWithin(entry, maxBytes - bytes, seen);
			if (entryBytes === null) {
				seen.delete(value);
				return null;
			}
			bytes += entryBytes;
			if (bytes > maxBytes) {
				seen.delete(value);
				return null;
			}
			entries++;
		}
	}
	seen.delete(value);
	return bytes <= maxBytes ? bytes : null;
}

/** Exact JSON byte count only when the value fits, without allocating the serialized value. */
export function measureRpcJsonBytesWithin(value: unknown, maxBytes: number): number | null {
	requirePositiveSafeInteger(maxBytes, "maxBytes");
	return measureRpcJsonValueWithin(value, maxBytes, new WeakSet<object>());
}

function requirePositiveSafeInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive safe integer`);
	}
}

export interface RpcUtf8PrefixProjection {
	value: string;
	utf8Bytes: number;
	truncated: boolean;
	inspectedCodeUnits: number;
}

/** UTF-8 prefix scan that stops immediately after proving the value is oversized. */
export function projectRpcUtf8Prefix(value: string, maxBytes: number): RpcUtf8PrefixProjection {
	requirePositiveSafeInteger(maxBytes, "maxBytes");
	let bytes = 0;
	let index = 0;
	while (index < value.length) {
		const codePoint = value.codePointAt(index)!;
		const codeUnits = codePoint > 0xffff ? 2 : 1;
		const scalarBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
		if (bytes + scalarBytes > maxBytes) {
			return {
				value: value.slice(0, index),
				utf8Bytes: bytes,
				truncated: true,
				inspectedCodeUnits: index + codeUnits,
			};
		}
		bytes += scalarBytes;
		index += codeUnits;
	}
	return { value, utf8Bytes: bytes, truncated: false, inspectedCodeUnits: index };
}

function truncateUtf8(value: string, maxBytes: number): string {
	return projectRpcUtf8Prefix(value, maxBytes).value;
}

export function projectRpcBoundedString(value: string, maxUtf8Bytes: number): RpcBoundedStringProjection {
	requirePositiveSafeInteger(maxUtf8Bytes, "maxUtf8Bytes");
	const prefix = projectRpcUtf8Prefix(value, maxUtf8Bytes);
	if (!prefix.truncated) {
		return { value };
	}
	return {
		value: prefix.value,
		projection: {
			truncated: true,
			originalBytes: null,
			projectedBytes: measureRpcJsonStringBytesWithin(prefix.value, Number.MAX_SAFE_INTEGER) ?? 0,
		},
	};
}

function normalizeRpcJsonValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
	if (value === null || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return truncateUtf8(value, RPC_PROJECTION_STRING_MAX_UTF8_BYTES);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (typeof value !== "object" || depth >= RPC_PROJECTION_MAX_DEPTH) {
		return undefined;
	}
	if (seen.has(value)) {
		return null;
	}
	seen.add(value);
	if (Array.isArray(value)) {
		const projected: unknown[] = [];
		for (const entry of value.slice(0, RPC_PROJECTION_MAX_COLLECTION_ENTRIES)) {
			const normalized = normalizeRpcJsonValue(entry, depth + 1, seen);
			projected.push(normalized === undefined ? null : normalized);
		}
		seen.delete(value);
		return projected;
	}
	const projected: Record<string, unknown> = {};
	let entries = 0;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		if (entries >= RPC_PROJECTION_MAX_COLLECTION_ENTRIES) break;
		const entry = (value as Record<string, unknown>)[key];
		const normalized = normalizeRpcJsonValue(entry, depth + 1, seen);
		if (normalized !== undefined) {
			projected[key] = normalized;
		}
		entries++;
	}
	seen.delete(value);
	return projected;
}

/**
 * Deterministically project a JSON-like record inside an exact serialized-byte
 * budget. Top-level key order is retained and nested strings/collections are
 * prefix-bounded before the exact budget check.
 */
export function projectRpcBoundedRecord(
	value: Record<string, unknown>,
	maxSerializedBytes: number,
): RpcBoundedRecordProjection {
	requirePositiveSafeInteger(maxSerializedBytes, "maxSerializedBytes");
	const originalBytes = measureRpcJsonBytesWithin(value, maxSerializedBytes);
	if (originalBytes !== null) {
		return { value: { ...value } };
	}

	const projected: Record<string, unknown> = {};
	let inspectedEntries = 0;
	for (const key in value) {
		if (!Object.hasOwn(value, key)) continue;
		if (inspectedEntries >= RPC_PROJECTION_MAX_TOP_LEVEL_ENTRIES) break;
		const entry = value[key];
		const normalized = normalizeRpcJsonValue(entry, 0, new WeakSet<object>());
		if (normalized === undefined) {
			inspectedEntries++;
			continue;
		}
		const candidate = { ...projected, [key]: normalized };
		const candidateBytes = measureRpcJsonBytes(candidate);
		if (candidateBytes === null || candidateBytes > maxSerializedBytes) {
			inspectedEntries++;
			continue;
		}
		projected[key] = normalized;
		inspectedEntries++;
	}
	return {
		value: projected,
		projection: {
			truncated: true,
			originalBytes: null,
			projectedBytes: measureRpcJsonBytes(projected) ?? 0,
		},
	};
}

function projectRpcStringQueue(values: readonly string[]): {
	value: string[];
	projection?: RpcProjectionCollectionTruncation;
} {
	const projected: string[] = [];
	const truncatedItems: NonNullable<RpcProjectionCollectionTruncation["truncatedItems"]> = [];
	for (let index = 0; index < values.length && index < RPC_SESSION_QUEUE_MAX_ITEMS; index++) {
		const item = projectRpcBoundedString(values[index]!, RPC_SESSION_QUEUE_ITEM_MAX_UTF8_BYTES);
		const candidate = [...projected, item.value];
		const candidateBytes = measureRpcJsonBytes(candidate);
		if (candidateBytes === null || candidateBytes > RPC_SESSION_QUEUE_MAX_SERIALIZED_BYTES) {
			break;
		}
		projected.push(item.value);
		if (item.projection) {
			truncatedItems.push({
				index,
				originalBytes: item.projection.originalBytes,
				projectedBytes: item.projection.projectedBytes,
			});
		}
	}
	const omittedCount = values.length - projected.length;
	if (omittedCount === 0 && truncatedItems.length === 0) {
		return { value: projected };
	}
	return {
		value: projected,
		projection: {
			truncated: true,
			originalBytes: null,
			projectedBytes: measureRpcJsonBytes(projected) ?? 0,
			totalCount: values.length,
			projectedCount: projected.length,
			omittedCount,
			...(omittedCount === 0 ? {} : { omittedEntries: omittedCount }),
			...(truncatedItems.length === 0 ? {} : { truncatedItems }),
		},
	};
}

function projectRpcActiveTool(execution: {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	latestDetails?: unknown;
}): RpcActiveToolExecution {
	const args = projectRpcBoundedRecord(execution.args, RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES);
	const boundedDetailsSource = isRecord(execution.latestDetails)
		? projectRpcBoundedRecord(execution.latestDetails, RPC_ACTIVE_TOOL_DETAILS_MAX_SERIALIZED_BYTES)
		: undefined;
	const policyDetails =
		boundedDetailsSource === undefined
			? undefined
			: execution.toolName === "subagent" || execution.toolName === SUBAGENT_REGISTRY_TOOL_NAME
				? projectSubagentDetails(boundedDetailsSource.value)
				: boundedDetailsSource.value;
	const details =
		policyDetails === undefined
			? undefined
			: projectRpcBoundedRecord(policyDetails, RPC_ACTIVE_TOOL_DETAILS_MAX_SERIALIZED_BYTES);
	const projected: RpcActiveToolExecution = {
		toolCallId: execution.toolCallId,
		toolName: execution.toolName,
		status: "started",
		args: args.value,
		...(details ? { details: details.value } : {}),
	};
	const fields: Record<string, RpcProjectionTruncation> = {};
	if (args.projection) fields.args = args.projection;
	if (boundedDetailsSource?.projection) fields.details = boundedDetailsSource.projection;
	else if (details?.projection) fields.details = details.projection;
	if (Object.keys(fields).length === 0) {
		return projected;
	}
	return {
		...projected,
		projection: {
			truncated: true,
			originalBytes: null,
			projectedBytes: measureRpcJsonBytes(projected) ?? 0,
			fields,
		},
	};
}

function omitRpcActiveToolPayload(tool: RpcActiveToolExecution): RpcActiveToolExecution {
	const projected: RpcActiveToolExecution = {
		toolCallId: tool.toolCallId,
		toolName: tool.toolName,
		status: "started",
	};
	const fields: Record<string, RpcProjectionTruncation> = {};
	if (tool.args !== undefined) {
		fields.args = {
			truncated: true,
			originalBytes: tool.projection?.fields?.args?.originalBytes ?? measureRpcJsonBytes(tool.args),
			projectedBytes: 0,
			omittedEntries: Object.keys(tool.args).length,
		};
	}
	if (tool.details !== undefined) {
		fields.details = {
			truncated: true,
			originalBytes: tool.projection?.fields?.details?.originalBytes ?? measureRpcJsonBytes(tool.details),
			projectedBytes: 0,
			omittedEntries: Object.keys(tool.details).length,
		};
	}
	return {
		...projected,
		projection: {
			truncated: true,
			originalBytes: tool.projection?.originalBytes ?? measureRpcJsonBytes(tool),
			projectedBytes: measureRpcJsonBytes(projected) ?? 0,
			...(Object.keys(fields).length === 0 ? {} : { fields }),
		},
	};
}

function projectRpcActiveTools(
	executions: Iterable<{
		toolCallId: string;
		toolName: string;
		args: Record<string, unknown>;
		latestDetails?: unknown;
	}>,
	totalCount: number,
): { value: RpcActiveToolExecution[]; projection?: RpcProjectionCollectionTruncation } {
	const projected: RpcActiveToolExecution[] = [];
	const truncatedItems: NonNullable<RpcProjectionCollectionTruncation["truncatedItems"]> = [];
	let index = 0;
	for (const execution of executions) {
		if (index >= RPC_SESSION_ACTIVE_TOOLS_MAX_ITEMS) break;
		const item = projectRpcActiveTool(execution);
		let candidateItem = item;
		let candidate = [...projected, candidateItem];
		let candidateBytes = measureRpcJsonBytes(candidate);
		if (candidateBytes === null || candidateBytes > RPC_SESSION_ACTIVE_TOOLS_MAX_SERIALIZED_BYTES) {
			candidateItem = omitRpcActiveToolPayload(item);
			candidate = [...projected, candidateItem];
			candidateBytes = measureRpcJsonBytes(candidate);
		}
		if (candidateBytes === null || candidateBytes > RPC_SESSION_ACTIVE_TOOLS_MAX_SERIALIZED_BYTES) {
			break;
		}
		projected.push(candidateItem);
		if (candidateItem.projection) {
			truncatedItems.push({
				index,
				originalBytes: candidateItem.projection.originalBytes ?? 0,
				projectedBytes: candidateItem.projection.projectedBytes,
			});
		}
		index++;
	}
	const omittedCount = totalCount - projected.length;
	if (omittedCount === 0 && truncatedItems.length === 0) {
		return { value: projected };
	}
	return {
		value: projected,
		projection: {
			truncated: true,
			originalBytes: null,
			projectedBytes: measureRpcJsonBytes(projected) ?? 0,
			totalCount,
			projectedCount: projected.length,
			omittedCount,
			...(omittedCount === 0 ? {} : { omittedEntries: omittedCount }),
			...(truncatedItems.length === 0 ? {} : { truncatedItems }),
		},
	};
}

function projectOptionalStateString(value: string | undefined): {
	value?: string;
	projection?: RpcProjectionTruncation;
} {
	if (value === undefined) return {};
	const projected = projectRpcBoundedString(value, RPC_SESSION_LABEL_MAX_UTF8_BYTES);
	return { value: projected.value, ...(projected.projection ? { projection: projected.projection } : {}) };
}

/**
 * Synchronously capture the session-state portion shared by get_state,
 *
 * Keep this function free of awaits: callers use it inside the feed's atomic
 * snapshot-and-subscribe cut.
 */
export function buildRpcSessionState(session: AgentSession): RpcSessionState {
	const activeCompaction = session.activeCompaction;
	const activeTools = projectRpcActiveTools(
		session.agent.state.pendingToolExecutions.values(),
		session.agent.state.pendingToolExecutions.size,
	);
	const steeringQueue = projectRpcStringQueue(
		typeof session.getSteeringMessages === "function" ? session.getSteeringMessages() : [],
	);
	const followUpQueue = projectRpcStringQueue(
		typeof session.getFollowUpMessages === "function" ? session.getFollowUpMessages() : [],
	);
	const sessionFile = projectOptionalStateString(session.sessionFile);
	const sessionName = projectOptionalStateString(session.sessionName);
	const modelBytes =
		session.model === undefined
			? null
			: measureRpcJsonBytesWithin(session.model, RPC_SESSION_MODEL_MAX_SERIALIZED_BYTES);
	const includeModel = session.model !== undefined && modelBytes !== null;
	const retryAttempt =
		Number.isSafeInteger(session.retryAttempt) && session.retryAttempt > 0 ? session.retryAttempt : 0;
	const retrySettings =
		retryAttempt > 0 && typeof session.settingsManager?.getRetrySettings === "function"
			? session.settingsManager.getRetrySettings()
			: undefined;
	const projection: RpcSessionStateProjection = {};
	if (session.model !== undefined && !includeModel) {
		projection.model = {
			truncated: true,
			originalBytes: modelBytes,
			projectedBytes: 0,
		};
	}
	if (sessionFile.projection) projection.sessionFile = sessionFile.projection;
	if (sessionName.projection) projection.sessionName = sessionName.projection;
	if (steeringQueue.projection) projection.steeringQueue = steeringQueue.projection;
	if (followUpQueue.projection) projection.followUpQueue = followUpQueue.projection;
	if (activeTools.projection) projection.activeTools = activeTools.projection;

	const state: RpcSessionState = {
		...(includeModel ? { model: session.model } : {}),
		thinkingLevel: session.thinkingLevel,
		availableThinkingLevels: session.getAvailableThinkingLevels(),
		isStreaming: session.isStreaming,
		isBusy: session.isBusy,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		...(sessionFile.value === undefined ? {} : { sessionFile: sessionFile.value }),
		sessionId: session.sessionId,
		...(sessionName.value === undefined ? {} : { sessionName: sessionName.value }),
		autoCompactionEnabled: session.autoCompactionEnabled,
		messageCount: session.messages.length,
		pendingMessageCount: session.pendingMessageCount,
		steeringQueue: steeringQueue.value,
		followUpQueue: followUpQueue.value,
		...(activeTools.value.length === 0 ? {} : { activeTools: activeTools.value }),
		...(activeCompaction ? { activeCompaction } : {}),
		...(retryAttempt === 0 || retrySettings === undefined
			? {}
			: { activeRetry: { attempt: retryAttempt, maxAttempts: retrySettings.maxRetries } }),
		...(Object.keys(projection).length === 0 ? {} : { projection }),
	};
	const stateBytes = measureRpcJsonBytes(state);
	if (stateBytes === null || stateBytes > RPC_SESSION_STATE_MAX_SERIALIZED_BYTES) {
		throw new Error(
			`RPC session state projection exceeded its ${RPC_SESSION_STATE_MAX_SERIALIZED_BYTES}-byte contract`,
		);
	}
	return state;
}
