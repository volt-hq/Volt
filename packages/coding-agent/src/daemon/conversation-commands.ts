import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import { handleIrohRemoteDeviceLogUploadRpcCommand } from "../core/remote/iroh/device-log-rpc.ts";
import { sanitizeIrohRemoteOutbound } from "../core/remote/iroh/outbound-filter.ts";
import {
	createIrohRemoteRpcErrorResponse,
	type IrohRemoteRpcErrorResponse,
} from "../core/remote/iroh/rpc-command-filter.ts";
import type { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import {
	type IrohRemoteTranscriptTextLayout,
	sanitizeIrohRemoteTranscriptText,
} from "../core/remote/iroh/transcript-text.ts";
import { getIrohRemoteWorkspaceAvailabilityStatus } from "../core/remote/iroh/workspace.ts";
import {
	handleIrohRemoteWorkspaceUnregisterRpcCommand,
	IROH_REMOTE_UNREGISTER_WORKSPACE_RPC_TYPE,
} from "../core/remote/iroh/workspace-rpc.ts";
import {
	handleIrohRemoteWorktreeRpcCommand,
	IROH_REMOTE_CREATE_WORKTREE_RPC_TYPE,
	IROH_REMOTE_LIST_WORKTREES_RPC_TYPE,
	type IrohRemoteWorktreeRpcBackend,
} from "../core/remote/iroh/worktree-rpc.ts";
import { extractMessageImages, projectMessageImages } from "../core/rpc/transcript.ts";
import type { RpcKeepAwakeStatus } from "../core/rpc/types.ts";
import { getDefaultSessionDir, type SessionEntry, SessionManager } from "../core/session-manager.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../core/subagents/tool-names.ts";
import type { KeepAwakeStatus } from "./keep-awake.ts";
import type { LeaseState } from "./lease-broker.ts";
import { getRegisteredWorkingDirectoryForWorktree } from "./worktree-manager.ts";

export const INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES: ReadonlySet<string> = new Set([
	"new_session",
	"switch_session_by_id",
	"get_messages",
]);

/**
 * Commands that start or extend a turn. While a lease is draining to a TUI,
 * these are rejected with `lease_draining` so the drain converges; read-only
 * commands and abort pass through.
 */
export const TURN_INITIATING_RPC_TYPES: ReadonlySet<string> = new Set([
	"prompt",
	"invoke_ui_action",
	"steer",
	"follow_up",
]);

export const LEASE_DRAINING_RETRY_AFTER_MS = 1000;

export const REMOTE_SESSION_LIST_DEFAULT_LIMIT = 50;
export const REMOTE_SESSION_LIST_MAX_LIMIT = 200;
export const REMOTE_SESSION_LIST_CURSOR_TTL_MS = 10 * 60 * 1000;
export const REMOTE_SESSION_LIST_CURSOR_MAX_BYTES = 512;
/**
 * Per-client cap on retained pagination cursors. The cursor map is shared across
 * every stream on the daemon; without a bound a client that never echoes the
 * returned cursor (each no-cursor list_sessions mints a fresh snapshot of up to
 * REMOTE_SESSION_LIST_MAX_LIMIT summaries) would grow it without limit for the
 * whole TTL window. Bounding per client (rather than globally) prevents one client
 * from evicting another's cursors — mirrors the push deduper's per-client cap.
 */
export const REMOTE_SESSION_LIST_MAX_CURSORS_PER_CLIENT = 64;
const REMOTE_TRANSCRIPT_DEFAULT_LIMIT = 200;
const REMOTE_TRANSCRIPT_MAX_LIMIT = 200;
const REMOTE_TRANSCRIPT_CURSOR_MAX_BYTES = 2048;
const REMOTE_TRANSCRIPT_CURSOR_MAX_SCALARS = 512;
const REMOTE_TOOL_COMMAND_MAX_SCALARS = 500;
const REMOTE_TOOL_ARGUMENT_MAX_SCALARS = 500;
const REMOTE_TOOL_ARGUMENT_KEYS_MAX = 12;
export const REMOTE_TOOL_OUTPUT_MAX_SCALARS = 8_000;

export type RemoteRpcCommand = Record<string, unknown> & { type: string };

export type RemoteSessionRuntimeState = Exclude<LeaseState, "unowned">;

export interface RemoteSessionListEntry {
	sessionId: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** "subagent" when this session was created for a delegated subagent run. */
	origin?: "subagent";
	/** Live host ownership for this session. Omitted when no runtime is currently owned. */
	runtimeState?: RemoteSessionRuntimeState;
	/** Present when the session is bound to a daemon-managed worktree (worktrees.v1). */
	worktreeId?: string;
	/** POSIX-style path relative to the registered workspace root. Omitted for root. */
	workingDirectory?: string;
}

export interface RemoteSessionListCursorEntry {
	clientNodeId: string;
	workspaceName: string;
	sessions: RemoteSessionListEntry[];
	nextIndex: number;
	expiresAt: number;
}

/** Minimal runtime surface the conversation command handlers consume. */
export interface ConversationCommandRuntime {
	session: {
		sessionId: string;
		sessionManager: Pick<SessionManager, "getBranch">;
	};
	listSessions(): Promise<
		Array<{
			sessionId: string;
			sessionName?: string;
			createdAt: string;
			modifiedAt: string;
			messageCount: number;
			firstMessage: string;
			cwd?: string;
			origin?: "subagent";
		}>
	>;
}

export interface ConversationCommandContext {
	agentDir?: string;
	auditLogger?: IrohRemoteAuditLogger;
	hostEngine?: { clearPairingSecretForWorkspace(workspaceName: string): void };
	stateManager: IrohRemoteHostStateManager;
	sessionListCursors: Map<string, RemoteSessionListCursorEntry>;
	sessionListCursorTtlMs: number;
	now?: () => number;
	/** Batch live-runtime presence for list_sessions; absent on hosts without a daemon broker. */
	listRuntimeStates?: (
		workspaceName: string,
	) => Promise<ReadonlyMap<string, RemoteSessionRuntimeState>> | ReadonlyMap<string, RemoteSessionRuntimeState>;
	/** True while this conversation's lease is draining to a TUI (§4.5 rejection). */
	isDraining?: () => boolean;
	/**
	 * True when this conversation runtime is a subagent child session. Subagent
	 * sessions are observe-only for remote clients: the parent agent owns the
	 * delegated turn, so turn-initiating commands are rejected.
	 */
	isSubagentSession?: () => boolean;
	/** Host cleanup after a successful workspace unregister (streams, runtimes, live activities, relays). */
	onWorkspaceUnregistered?: (workspaceName: string) => Promise<void>;
	/** Host keep-awake control; absent when no daemon owns the host (e.g. plain rpc mode). */
	keepAwake?: {
		setEnabled(enabled: boolean): KeepAwakeStatus;
		readonly status: KeepAwakeStatus;
	};
	/** Persist the desired keep-awake setting after a successful set_keep_awake. */
	onKeepAwakeSetting?: (enabled: boolean) => void;
	/** Host web-search key control; absent when no daemon owns the host (e.g. plain rpc mode). */
	webSearchKey?: {
		set(apiKey: string | null): void;
		readonly configured: boolean;
	};
	/**
	 * Worktree RPC backend for the stream-bound workspace (worktrees.v1);
	 * absent when no daemon owns the host (create/list_worktrees then fail
	 * with unsupported_remote_command).
	 */
	createWorktreeBackend?: (workspace: { name: string; path: string }) => IrohRemoteWorktreeRpcBackend;
}

export function createLeaseDrainingRpcErrorResponse(command: RemoteRpcCommand): Record<string, unknown> {
	const id = getRpcResponseId(command);
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command: command.type,
		success: false,
		error: {
			code: "lease_draining",
			message: "Handing off to the desktop TUI; retry shortly.",
			retryAfterMs: LEASE_DRAINING_RETRY_AFTER_MS,
		},
	};
}

export function createSubagentSessionReadOnlyRpcErrorResponse(command: RemoteRpcCommand): Record<string, unknown> {
	const id = getRpcResponseId(command);
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command: command.type,
		success: false,
		error: {
			code: "subagent_session_read_only",
			message: "Subagent sessions are observe-only; prompt the parent agent instead.",
		},
	};
}

function contextNow(context: ConversationCommandContext): number {
	return (context.now ?? Date.now)();
}

async function logAudit(
	auditLogger: IrohRemoteAuditLogger | undefined,
	event: Parameters<IrohRemoteAuditLogger["log"]>[0],
): Promise<void> {
	try {
		await auditLogger?.log(event);
	} catch {
		// Audit logging is best-effort and must not change remote runtime behavior.
	}
}

export function getRpcResponseId(command: Record<string, unknown>): string | undefined {
	return typeof command.id === "string" ? command.id : undefined;
}

export function createRpcSuccessResponse(
	id: string | undefined,
	command: string,
	data?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		...(id === undefined ? {} : { id }),
		type: "response",
		command,
		success: true,
		...(data === undefined ? {} : { data }),
	};
}

function getRemoteSanitizerOptions(authorization: IrohRemoteClientAuthorizationSuccess) {
	return {
		remoteWorkspacePath: "/workspace",
		workspacePath: authorization.workspace.path,
	};
}

function truncateUnicodeScalars(value: string, maxLength: number): string {
	const scalars = Array.from(value);
	return scalars.length <= maxLength ? value : scalars.slice(0, maxLength).join("");
}

function sanitizeRemoteTextField(
	value: string,
	maxLength: number,
	authorization: IrohRemoteClientAuthorizationSuccess,
): string {
	const sanitized = (
		sanitizeIrohRemoteOutbound({ value }, getRemoteSanitizerOptions(authorization)) as { value?: unknown }
	).value;
	return truncateUnicodeScalars(typeof sanitized === "string" ? sanitized : "", maxLength);
}

function sanitizeRemoteTranscriptText(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	layout: IrohRemoteTranscriptTextLayout = "preserve",
) {
	return sanitizeIrohRemoteTranscriptText(
		typeof value === "string" ? value : "",
		getRemoteSanitizerOptions(authorization),
		layout,
	);
}

// ============================================================================
// Transcript projection
// ============================================================================

interface RemoteTranscriptRequest {
	limit: number;
	beforeEntryId?: string;
}

function parseRemoteTranscriptLimit(
	command: Record<string, unknown>,
): { ok: true; limit: number } | { ok: false; error: string } {
	if (command.limit === undefined) {
		return { ok: true, limit: REMOTE_TRANSCRIPT_DEFAULT_LIMIT };
	}
	if (
		typeof command.limit !== "number" ||
		!Number.isFinite(command.limit) ||
		!Number.isInteger(command.limit) ||
		command.limit <= 0
	) {
		return { ok: false, error: "invalid_limit" };
	}
	return { ok: true, limit: Math.min(command.limit, REMOTE_TRANSCRIPT_MAX_LIMIT) };
}

function isValidRemoteTranscriptCursor(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		Array.from(value).length <= REMOTE_TRANSCRIPT_CURSOR_MAX_SCALARS &&
		Buffer.byteLength(value, "utf8") <= REMOTE_TRANSCRIPT_CURSOR_MAX_BYTES
	);
}

function parseRemoteTranscriptRequest(
	command: Record<string, unknown>,
): ({ ok: true } & RemoteTranscriptRequest) | { ok: false; error: string } {
	const limit = parseRemoteTranscriptLimit(command);
	if (!limit.ok) {
		return limit;
	}
	if (command.beforeEntryId !== undefined && !isValidRemoteTranscriptCursor(command.beforeEntryId)) {
		return { ok: false, error: "invalid_cursor" };
	}
	return {
		ok: true,
		limit: limit.limit,
		...(command.beforeEntryId === undefined ? {} : { beforeEntryId: command.beforeEntryId as string }),
	};
}

function extractTranscriptContentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(part): part is { type: "text"; text: string } =>
				isRemoteRecord(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("");
}

export interface RemoteTranscriptItem {
	entryId: string;
	createdAt: string;
	role: "user" | "assistant" | "system" | "tool";
	text: string;
	truncated: boolean;
	/** Inline image blocks persisted on the message (user attachments or tool
	 *  results such as image reads); recoverable per entry via
	 *  get_message_images. */
	imageCount?: number;
	toolName?: string;
	status?: "completed" | "failed";
	summary?: string;
	path?: string;
	args?: Record<string, unknown>;
	details?: Record<string, unknown>;
	output?: string;
	outputTruncated?: boolean;
}

/**
 * Sanitized, bounded tool result text for remote clients. Layout is preserved
 * (unlike tool summaries) so the phone can render real output; the scalar cap
 * keeps a single transcript item within remote stream size expectations.
 */
function sanitizeRemoteToolOutput(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	hostTruncated = false,
): { text: string; truncated: boolean } | undefined {
	if (typeof value !== "string" || value.trim().length === 0) {
		return undefined;
	}
	const sanitized = sanitizeRemoteTranscriptText(value, authorization, "preserve");
	const scalars = Array.from(sanitized.text);
	const truncated = sanitized.truncated || hostTruncated || scalars.length > REMOTE_TOOL_OUTPUT_MAX_SCALARS;
	return {
		text:
			scalars.length > REMOTE_TOOL_OUTPUT_MAX_SCALARS
				? scalars.slice(0, REMOTE_TOOL_OUTPUT_MAX_SCALARS).join("")
				: sanitized.text,
		truncated,
	};
}

function createRemoteTranscriptItem(
	entry: SessionEntry,
	role: RemoteTranscriptItem["role"],
	text: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	layout: IrohRemoteTranscriptTextLayout = role === "tool" ? "summary" : "preserve",
): RemoteTranscriptItem {
	const sanitized = sanitizeRemoteTranscriptText(text, authorization, layout);
	return {
		entryId: entry.id,
		createdAt: toRemoteSessionTimestamp(entry.timestamp),
		role,
		text: sanitized.text,
		truncated: sanitized.truncated,
	};
}

interface RemoteToolCallRecord {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

function projectRemoteTranscriptEntry(
	entry: SessionEntry,
	authorization: IrohRemoteClientAuthorizationSuccess,
	toolCallsById: Map<string, RemoteToolCallRecord>,
): RemoteTranscriptItem | undefined {
	if (!entry || typeof entry !== "object") {
		return undefined;
	}
	if (entry.type === "compaction") {
		return createRemoteTranscriptItem(entry, "system", entry.summary, authorization);
	}
	if (entry.type === "custom_message") {
		if (entry.customType !== "review" || entry.display !== true) {
			return undefined;
		}
		const text = extractTranscriptContentText(entry.content);
		return text ? createRemoteTranscriptItem(entry, "assistant", text, authorization) : undefined;
	}
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
		return undefined;
	}
	const message = entry.message as unknown as Record<string, unknown>;
	if (message.role === "user" || message.role === "assistant") {
		const text = extractTranscriptContentText(message.content);
		const imageCount = message.role === "user" ? extractMessageImages(message.content).length : 0;
		if (!text && imageCount === 0) {
			return undefined;
		}
		const item = createRemoteTranscriptItem(entry, message.role, text, authorization);
		if (imageCount > 0) {
			item.imageCount = imageCount;
		}
		return item;
	}
	if (message.role === "toolResult") {
		const status = message.isError ? "failed" : "completed";
		const toolName =
			typeof message.toolName === "string" && message.toolName.trim() ? message.toolName.trim() : "tool";
		const toolCall = typeof message.toolCallId === "string" ? toolCallsById.get(message.toolCallId) : undefined;
		const args = isRemoteRecord(toolCall?.arguments) ? toolCall.arguments : undefined;
		const path = getRemoteToolPath(toolName, args, authorization);
		const summary = summarizeRemoteToolResult(toolName, status, args, path, authorization);
		const item = createRemoteTranscriptItem(entry, "tool", summary, authorization);
		item.toolName = toolName;
		item.status = status;
		item.summary = summary;
		if (path) {
			item.path = path;
		}
		const projectedArgs = projectRemoteToolArgs(toolName, args, authorization);
		if (projectedArgs) {
			item.args = projectedArgs;
		}
		if (toolName === "subagent" || toolName === SUBAGENT_REGISTRY_TOOL_NAME) {
			const details = projectRemoteSubagentDetails(message.details, authorization);
			if (details) {
				item.details = details;
			}
		}
		const output = sanitizeRemoteToolOutput(extractTranscriptContentText(message.content), authorization);
		if (output) {
			item.output = output.text;
			item.outputTruncated = output.truncated;
		}
		const imageCount = extractMessageImages(message.content).length;
		if (imageCount > 0) {
			item.imageCount = imageCount;
		}
		return item;
	}
	if (message.role === "bashExecution") {
		const failed = message.cancelled === true || (message.exitCode !== undefined && message.exitCode !== 0);
		const status = failed ? "failed" : "completed";
		const exit = message.cancelled
			? "cancelled"
			: message.exitCode === undefined
				? status
				: `exit ${message.exitCode}`;
		const command = remoteString(message.command, authorization, REMOTE_TOOL_COMMAND_MAX_SCALARS);
		const summary = command ? `Ran command: ${command} (${exit})` : `bash ${exit}`;
		const item = createRemoteTranscriptItem(entry, "tool", summary, authorization);
		item.toolName = "bash";
		item.status = status;
		item.summary = summary;
		if (command) {
			item.args = { command };
		}
		const output = sanitizeRemoteToolOutput(message.output, authorization, message.truncated === true);
		if (output) {
			item.output = output.text;
			item.outputTruncated = output.truncated;
		}
		return item;
	}
	return undefined;
}

function projectRemoteTranscriptItems(
	sessionManager: Pick<SessionManager, "getBranch">,
	authorization: IrohRemoteClientAuthorizationSuccess,
): RemoteTranscriptItem[] {
	const branch = sessionManager.getBranch();
	const toolCallsById = collectRemoteToolCalls(branch);
	return branch
		.map((entry) => projectRemoteTranscriptEntry(entry, authorization, toolCallsById))
		.filter((item): item is RemoteTranscriptItem => item !== undefined);
}

function collectRemoteToolCalls(entries: SessionEntry[]): Map<string, RemoteToolCallRecord> {
	const toolCallsById = new Map<string, RemoteToolCallRecord>();
	for (const entry of entries) {
		if (entry.type !== "message") {
			continue;
		}
		const message = entry.message as unknown as Record<string, unknown>;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) {
			continue;
		}
		for (const block of message.content) {
			if (
				isRemoteRecord(block) &&
				block.type === "toolCall" &&
				typeof block.id === "string" &&
				typeof block.name === "string" &&
				isRemoteRecord(block.arguments)
			) {
				toolCallsById.set(block.id, {
					id: block.id,
					name: block.name,
					arguments: block.arguments,
				});
			}
		}
	}
	return toolCallsById;
}

function projectRemoteToolArgs(
	toolName: string,
	args: Record<string, unknown> | undefined,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Record<string, unknown> | undefined {
	if (toolName === "subagent" || toolName === SUBAGENT_REGISTRY_TOOL_NAME) {
		return projectRemoteSubagentArgs(args, authorization);
	}
	if (!isRemoteRecord(args)) {
		return undefined;
	}

	const projected: Record<string, unknown> = {};
	switch (toolName) {
		case "bash":
			copyRemoteString(args, projected, "command", authorization, REMOTE_TOOL_COMMAND_MAX_SCALARS);
			copyRemoteNumber(args, projected, "timeout");
			break;
		case "read":
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "file_path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "offset");
			copyRemoteNumber(args, projected, "limit");
			break;
		case "edit":
		case "write":
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "file_path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			break;
		case "grep":
			copyRemoteString(args, projected, "pattern", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "glob", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "include", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "exclude", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteBoolean(args, projected, "ignoreCase");
			copyRemoteBoolean(args, projected, "literal");
			copyRemoteNumber(args, projected, "context");
			break;
		case "find":
			copyRemoteString(args, projected, "query", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "pattern", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "glob", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "name", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "limit");
			break;
		case "ls":
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "limit");
			break;
		case "lsp":
			copyRemoteString(args, projected, "action", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "symbol", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteString(args, projected, "file_path", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "line");
			break;
		case "web_search":
			copyRemoteString(args, projected, "query", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteStringArray(args, projected, "domains", authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
			copyRemoteNumber(args, projected, "limit");
			copyRemoteNumber(args, projected, "recencyDays");
			break;
		default:
			break;
	}

	return Object.keys(projected).length > 0 ? projected : undefined;
}

function getRemoteToolPath(
	toolName: string,
	args: Record<string, unknown> | undefined,
	authorization: IrohRemoteClientAuthorizationSuccess,
): string | undefined {
	if (!isRemoteRecord(args)) {
		return undefined;
	}
	switch (toolName) {
		case "read":
		case "edit":
		case "write":
		case "lsp":
			return (
				remoteString(args.path, authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS) ??
				remoteString(args.file_path, authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS)
			);
		case "grep":
		case "find":
		case "ls":
			return remoteString(args.path, authorization, REMOTE_TOOL_ARGUMENT_MAX_SCALARS);
		default:
			return undefined;
	}
}

function summarizeRemoteToolResult(
	toolName: string,
	status: "completed" | "failed",
	args: Record<string, unknown> | undefined,
	path: string | undefined,
	authorization: IrohRemoteClientAuthorizationSuccess,
): string {
	const statusText = status === "failed" ? "failed" : "completed";
	if (toolName === "bash") {
		const command = remoteString(args?.command, authorization, REMOTE_TOOL_COMMAND_MAX_SCALARS);
		if (command) {
			return `Ran command: ${command} (${statusText})`;
		}
	}
	if (toolName === "read" && path) {
		return `Read ${path} (${statusText})`;
	}
	if (path) {
		return `${toolName} ${path} (${statusText})`;
	}
	return `${toolName} ${statusText}`;
}

function projectRemoteSubagentArgs(
	args: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Record<string, unknown> | undefined {
	if (!isRemoteRecord(args)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	copyRemoteString(args, projected, "agent", authorization, 200);
	copyRemoteString(args, projected, "task", authorization, 1000);
	const tasks = projectRemoteSubagentInputArray(args.tasks, authorization);
	if (tasks) {
		projected.tasks = tasks;
	}
	const chain = projectRemoteSubagentInputArray(args.chain, authorization);
	if (chain) {
		projected.chain = chain;
	}
	if (typeof args.list === "boolean") {
		projected.list = args.list;
	}
	copyRemoteNumber(args, projected, "cursor");
	copyRemoteString(args, projected, "follow", authorization, 200);
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemoteSubagentInputArray(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Array<{ agent: string; task: string }> | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const projected = value
		.map((item) => {
			if (!isRemoteRecord(item)) {
				return undefined;
			}
			const agent = remoteString(item.agent, authorization, 200);
			const task = remoteString(item.task, authorization, 1000);
			return agent && task ? { agent, task } : undefined;
		})
		.filter((item): item is { agent: string; task: string } => item !== undefined);
	return projected.length > 0 ? projected : undefined;
}

function projectRemoteSubagentDetails(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Record<string, unknown> | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	copyRemoteString(value, projected, "mode", authorization, 200);
	copyRemoteString(value, projected, "status", authorization, 200);
	copyRemoteString(value, projected, "subagentId", authorization, 200);
	copyRemoteString(value, projected, "sessionId", authorization, 200);
	copyRemoteSubagentNumericDetails(value, projected);
	copyRemoteString(value, projected, "currentActivity", authorization, 300);
	const summary = projectRemoteSubagentSummary(value.summary);
	if (summary) {
		projected.summary = summary;
	}
	const childSessions = projectRemoteSubagentDetailArray(value.childSessions, authorization);
	if (childSessions) {
		projected.childSessions = childSessions;
	}
	const agent = projectRemoteSubagentAgent(value.agent, authorization);
	if (agent) {
		projected.agent = agent;
	}
	const output = projectRemoteSubagentOutput(value.output, authorization);
	if (output) {
		projected.output = output;
	}
	const error = projectRemoteSubagentError(value.error, authorization);
	if (error) {
		projected.error = error;
	}
	const children = projectRemoteSubagentDetailArray(value.children, authorization);
	if (children) {
		projected.children = children;
	}
	const tasks = projectRemoteSubagentDetailArray(value.tasks, authorization);
	if (tasks) {
		projected.tasks = tasks;
	}
	const steps = projectRemoteSubagentDetailArray(value.steps, authorization);
	if (steps) {
		projected.steps = steps;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

const REMOTE_SUBAGENT_NUMERIC_KEYS = ["startedAt", "durationMs", "toolCalls", "tokens"] as const;
const REMOTE_SUBAGENT_TREE_DEPTH_LIMIT = 5;

function copyRemoteSubagentNumericDetails(from: Record<string, unknown>, to: Record<string, unknown>): void {
	for (const key of REMOTE_SUBAGENT_NUMERIC_KEYS) {
		const numberValue = remoteFiniteNumber(from[key]);
		if (numberValue !== undefined) {
			to[key] = numberValue;
		}
	}
}

function projectRemoteSubagentSummary(value: unknown): Record<string, number> | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const projected: Record<string, number> = {};
	for (const key of [
		"total",
		"completed",
		"failed",
		"aborted",
		"running",
		"maxConcurrency",
		"stoppedAt",
		"returned",
		"nextCursor",
		"omittedTasks",
	]) {
		const numberValue = remoteFiniteNumber(value[key]);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemoteSubagentDetailArray(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	depth = 0,
): Array<Record<string, unknown>> | undefined {
	if (!Array.isArray(value) || depth >= REMOTE_SUBAGENT_TREE_DEPTH_LIMIT) {
		return undefined;
	}
	const projected = value
		.map((item) => projectRemoteSubagentTask(item, authorization, depth))
		.filter((item): item is Record<string, unknown> => item !== undefined);
	return projected.length > 0 ? projected : undefined;
}

function projectRemoteSubagentTask(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	depth = 0,
): Record<string, unknown> | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	const index = remoteFiniteNumber(value.index);
	if (index !== undefined) {
		projected.index = index;
	}
	copyRemoteString(value, projected, "subagentId", authorization, 200);
	copyRemoteString(value, projected, "sessionId", authorization, 200);
	const agent = projectRemoteSubagentAgent(value.agent, authorization);
	if (agent) {
		projected.agent = agent;
	}
	copyRemoteString(value, projected, "status", authorization, 200);
	copyRemoteString(value, projected, "task", authorization, 1_000);
	copyRemoteSubagentNumericDetails(value, projected);
	copyRemoteString(value, projected, "currentActivity", authorization, 300);
	const error = projectRemoteSubagentError(value.error, authorization);
	if (error) {
		projected.error = error;
	}
	const children = projectRemoteSubagentDetailArray(value.children, authorization, depth + 1);
	if (children) {
		projected.children = children;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemoteSubagentAgent(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Record<string, unknown> | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	copyRemoteString(value, projected, "name", authorization, 200);
	copyRemoteString(value, projected, "source", authorization, 200);
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemoteSubagentOutput(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): Record<string, unknown> | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const projected: Record<string, unknown> = {};
	copyRemoteString(value, projected, "text", authorization, 1000);
	for (const key of ["bytes", "omittedBytes", "maxBytes"]) {
		const numberValue = remoteFiniteNumber(value[key]);
		if (numberValue !== undefined) {
			projected[key] = numberValue;
		}
	}
	if (typeof value.truncated === "boolean") {
		projected.truncated = value.truncated;
	}
	return Object.keys(projected).length > 0 ? projected : undefined;
}

function projectRemoteSubagentError(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
): { message: string } | undefined {
	if (!isRemoteRecord(value)) {
		return undefined;
	}
	const message = remoteString(value.message, authorization, 1000);
	return message ? { message } : undefined;
}

function remoteString(
	value: unknown,
	authorization: IrohRemoteClientAuthorizationSuccess,
	maxLength: number,
): string | undefined {
	return typeof value === "string" && value.trim()
		? sanitizeRemoteTextField(value, maxLength, authorization)
		: undefined;
}

function copyRemoteString(
	from: Record<string, unknown>,
	to: Record<string, unknown>,
	key: string,
	authorization: IrohRemoteClientAuthorizationSuccess,
	maxLength: number,
): void {
	const value = remoteString(from[key], authorization, maxLength);
	if (value) {
		to[key] = value;
	}
}

function copyRemoteNumber(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
	const value = remoteFiniteNumber(from[key]);
	if (value !== undefined) {
		to[key] = value;
	}
}

function copyRemoteBoolean(from: Record<string, unknown>, to: Record<string, unknown>, key: string): void {
	if (typeof from[key] === "boolean") {
		to[key] = from[key];
	}
}

function copyRemoteStringArray(
	from: Record<string, unknown>,
	to: Record<string, unknown>,
	key: string,
	authorization: IrohRemoteClientAuthorizationSuccess,
	maxLength: number,
): void {
	const value = from[key];
	if (!Array.isArray(value)) {
		return;
	}
	const projected = value
		.slice(0, REMOTE_TOOL_ARGUMENT_KEYS_MAX)
		.map((entry) => remoteString(entry, authorization, maxLength))
		.filter((entry): entry is string => entry !== undefined);
	if (projected.length > 0) {
		to[key] = projected;
	}
}

function remoteFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRemoteRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createRemoteTranscriptPage(items: RemoteTranscriptItem[], request: RemoteTranscriptRequest) {
	const beforeIndex =
		request.beforeEntryId === undefined
			? items.length
			: items.findIndex((item) => item.entryId === request.beforeEntryId);
	if (beforeIndex === -1) {
		return undefined;
	}
	const eligibleItems = items.slice(0, beforeIndex);
	const pageStart = Math.max(0, eligibleItems.length - request.limit);
	const pageItems = eligibleItems.slice(pageStart);
	const hasMore = pageStart > 0;
	return {
		items: pageItems,
		hasMore,
		nextBeforeEntryId: hasMore ? (pageItems[0]?.entryId ?? null) : null,
	};
}

export function createRemoteGetTranscriptRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	runtime: ConversationCommandRuntime,
): object {
	const id = getRpcResponseId(command);
	const request = parseRemoteTranscriptRequest(command);
	if (!request.ok) {
		return createIrohRemoteRpcErrorResponse(id, "get_transcript", request.error);
	}
	const items = projectRemoteTranscriptItems(runtime.session.sessionManager, authorization);
	const page = createRemoteTranscriptPage(items, request);
	if (!page) {
		return createIrohRemoteRpcErrorResponse(id, "get_transcript", "invalid_cursor");
	}
	return createRpcSuccessResponse(id, "get_transcript", {
		workspaceName: authorization.workspace.name,
		sessionId: runtime.session.sessionId,
		...page,
	});
}

export function createRemoteGetMessageImagesRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	runtime: ConversationCommandRuntime,
): object {
	const id = getRpcResponseId(command);
	if (!isValidRemoteTranscriptCursor(command.entryId)) {
		return createIrohRemoteRpcErrorResponse(id, "get_message_images", "invalid_cursor");
	}
	let startImageIndex = 0;
	if (command.startImageIndex !== undefined) {
		if (
			typeof command.startImageIndex !== "number" ||
			!Number.isInteger(command.startImageIndex) ||
			command.startImageIndex < 0
		) {
			return createIrohRemoteRpcErrorResponse(id, "get_message_images", "invalid_request");
		}
		startImageIndex = command.startImageIndex;
	}
	const result = projectMessageImages(runtime.session.sessionManager.getBranch(), command.entryId, startImageIndex);
	if (!result.ok) {
		return createIrohRemoteRpcErrorResponse(id, "get_message_images", result.error);
	}
	return createRpcSuccessResponse(id, "get_message_images", {
		workspaceName: authorization.workspace.name,
		sessionId: runtime.session.sessionId,
		entryId: result.entryId,
		totalImages: result.totalImages,
		images: result.images,
		nextImageIndex: result.nextImageIndex,
	});
}

// ============================================================================
// Session listing
// ============================================================================

function toRemoteSessionTimestamp(value: string | number | Date): string {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function getRemoteSessionTimestampMs(value: string): number {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? 0 : date.getTime();
}

interface RemoteSessionSummaryInput {
	sessionId: string;
	title: unknown;
	createdAt: string | Date;
	updatedAt: string | Date;
	messageCount: number;
	cwd?: string;
	origin?: "subagent";
}

function getRelativeWorkingDirectory(rootPath: string, cwd: string | undefined): string | null | undefined {
	if (!cwd) {
		return undefined;
	}
	const root = resolve(rootPath);
	const child = resolve(cwd);
	const relativePath = relative(root, child);
	if (relativePath === "" || relativePath === ".") {
		return undefined;
	}
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
		return null;
	}
	return relativePath.split(sep).join("/");
}

interface RemoteSessionSummary {
	sortUpdatedAtMs: number;
	session: RemoteSessionListEntry;
	cwd?: string;
}

function createRemoteSessionSummary(
	input: RemoteSessionSummaryInput,
	authorization: IrohRemoteClientAuthorizationSuccess,
): RemoteSessionSummary {
	const createdAt = toRemoteSessionTimestamp(input.createdAt);
	const updatedAt = toRemoteSessionTimestamp(input.updatedAt);
	const workingDirectory = getRelativeWorkingDirectory(authorization.workspace.path, input.cwd);
	return {
		sortUpdatedAtMs: getRemoteSessionTimestampMs(updatedAt),
		session: {
			sessionId: input.sessionId,
			title: sanitizeRemoteTextField(typeof input.title === "string" ? input.title : "", 160, authorization),
			createdAt,
			updatedAt,
			messageCount: input.messageCount,
			...(input.origin === undefined ? {} : { origin: input.origin }),
			...(workingDirectory === undefined || workingDirectory === null ? {} : { workingDirectory }),
		},
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
	};
}

function sortRemoteSessionSummaries(left: RemoteSessionSummary, right: RemoteSessionSummary): number {
	return right.sortUpdatedAtMs - left.sortUpdatedAtMs || left.session.sessionId.localeCompare(right.session.sessionId);
}

export async function listRemoteWorkspaceSessionSummaries(
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
	runtime?: ConversationCommandRuntime,
): Promise<RemoteSessionSummary[]> {
	const bySessionId = new Map<string, RemoteSessionSummary>();
	if (runtime === undefined || context.agentDir !== undefined) {
		for (const info of await SessionManager.list(
			authorization.workspace.path,
			getDefaultSessionDir(authorization.workspace.path, context.agentDir),
		)) {
			const summary = createRemoteSessionSummary(
				{
					sessionId: info.id,
					title: info.name ?? info.firstMessage,
					createdAt: info.created,
					updatedAt: info.modified,
					messageCount: info.messageCount,
					cwd: info.cwd,
					...(info.origin === undefined ? {} : { origin: info.origin }),
				},
				authorization,
			);
			bySessionId.set(summary.session.sessionId, summary);
		}
	}
	if (runtime !== undefined) {
		for (const liveSummary of await runtime.listSessions()) {
			const summary = createRemoteSessionSummary(
				{
					sessionId: liveSummary.sessionId,
					title: liveSummary.sessionName ?? liveSummary.firstMessage,
					createdAt: liveSummary.createdAt,
					updatedAt: liveSummary.modifiedAt,
					messageCount: liveSummary.messageCount,
					cwd: liveSummary.cwd,
					...(liveSummary.origin === undefined ? {} : { origin: liveSummary.origin }),
				},
				authorization,
			);
			bySessionId.set(summary.session.sessionId, summary);
		}
	}
	// Worktree attribution (worktrees.v1): join the persisted session bindings so
	// clients can badge worktree-bound sessions without a separate list_worktrees
	// round trip. Ids only — checkout paths never reach the wire.
	try {
		for (const worktree of await context.stateManager.listWorktrees(authorization.workspace.name)) {
			for (const sessionId of worktree.sessionIds) {
				const summary = bySessionId.get(sessionId);
				if (summary) {
					summary.session.worktreeId = worktree.id;
					const worktreeRelativeDirectory = getRelativeWorkingDirectory(worktree.path, summary.cwd);
					if (worktreeRelativeDirectory === null) {
						delete summary.session.workingDirectory;
						continue;
					}
					const workingDirectory = getRegisteredWorkingDirectoryForWorktree(worktree, worktreeRelativeDirectory);
					if (workingDirectory === undefined) {
						delete summary.session.workingDirectory;
					} else {
						summary.session.workingDirectory = workingDirectory;
					}
				}
			}
		}
	} catch {
		// Attribution is best-effort; the session list itself stays authoritative.
	}
	try {
		const runtimeStates = await context.listRuntimeStates?.(authorization.workspace.name);
		if (runtimeStates) {
			for (const [sessionId, runtimeState] of runtimeStates) {
				const summary = bySessionId.get(sessionId);
				if (summary) {
					summary.session.runtimeState = runtimeState;
				}
			}
		}
	} catch {
		// Presence is best-effort; persisted session discovery remains authoritative.
	}
	return Array.from(bySessionId.values()).sort(sortRemoteSessionSummaries);
}

function cleanupExpiredSessionListCursors(context: ConversationCommandContext, now = contextNow(context)): void {
	for (const [cursor, entry] of context.sessionListCursors) {
		if (entry.expiresAt <= now) {
			context.sessionListCursors.delete(cursor);
		}
	}
}

function evictExcessSessionListCursors(
	context: ConversationCommandContext,
	clientNodeId: string,
	maxForClient: number,
): void {
	// Map iteration is insertion order, so this client's oldest cursors come first.
	const clientCursors: string[] = [];
	for (const [cursor, entry] of context.sessionListCursors) {
		if (entry.clientNodeId === clientNodeId) {
			clientCursors.push(cursor);
		}
	}
	// Drop oldest until inserting one more keeps this client within the cap.
	for (let index = 0; index <= clientCursors.length - maxForClient; index++) {
		context.sessionListCursors.delete(clientCursors[index]);
	}
}

function createSessionListCursor(
	context: ConversationCommandContext,
	authorization: IrohRemoteClientAuthorizationSuccess,
	sessions: RemoteSessionListEntry[],
	nextIndex: number,
): string {
	// Sweep expired entries on every insert (not only on the cursored read path) and
	// bound this client's retained cursors so a client that never echoes the returned
	// cursor cannot grow the shared, daemon-wide map without limit.
	cleanupExpiredSessionListCursors(context);
	evictExcessSessionListCursors(context, authorization.client.nodeId, REMOTE_SESSION_LIST_MAX_CURSORS_PER_CLIENT);
	const cursor = randomUUID();
	context.sessionListCursors.set(cursor, {
		clientNodeId: authorization.client.nodeId,
		workspaceName: authorization.workspace.name,
		sessions,
		nextIndex,
		expiresAt: contextNow(context) + context.sessionListCursorTtlMs,
	});
	return cursor;
}

function getSessionListCursorEntry(
	context: ConversationCommandContext,
	authorization: IrohRemoteClientAuthorizationSuccess,
	cursor: string,
): RemoteSessionListCursorEntry | undefined {
	cleanupExpiredSessionListCursors(context);
	const entry = context.sessionListCursors.get(cursor);
	if (
		!entry ||
		entry.clientNodeId !== authorization.client.nodeId ||
		entry.workspaceName !== authorization.workspace.name
	) {
		return undefined;
	}
	return entry;
}

function parseRemoteSessionListLimit(
	command: Record<string, unknown>,
): { ok: true; limit: number } | { ok: false; error: string } {
	if (command.limit === undefined) {
		return { ok: true, limit: REMOTE_SESSION_LIST_DEFAULT_LIMIT };
	}
	if (typeof command.limit !== "number" || !Number.isInteger(command.limit) || command.limit <= 0) {
		return { ok: false, error: "invalid_limit" };
	}
	return { ok: true, limit: Math.min(command.limit, REMOTE_SESSION_LIST_MAX_LIMIT) };
}

function parseRemoteSessionListRequest(
	command: Record<string, unknown>,
): { ok: true; limit: number; cursor?: string } | { ok: false; error: string } {
	if (Object.hasOwn(command, "sessionId")) {
		return { ok: false, error: "unexpected_session_id" };
	}
	for (const field of ["workspace", "workspaceName", "clientNodeId", "hostNodeId"]) {
		if (Object.hasOwn(command, field)) {
			return { ok: false, error: "session_mismatch" };
		}
	}
	for (const field of Object.keys(command)) {
		if (field !== "id" && field !== "type" && field !== "limit" && field !== "cursor") {
			return { ok: false, error: "invalid_request" };
		}
	}
	const limit = parseRemoteSessionListLimit(command);
	if (!limit.ok) {
		return limit;
	}
	if (command.cursor !== undefined) {
		if (
			typeof command.cursor !== "string" ||
			command.cursor.length === 0 ||
			Buffer.byteLength(command.cursor, "utf8") > REMOTE_SESSION_LIST_CURSOR_MAX_BYTES
		) {
			return { ok: false, error: "invalid_cursor" };
		}
	}
	return {
		ok: true,
		limit: limit.limit,
		...(command.cursor === undefined ? {} : { cursor: command.cursor as string }),
	};
}

export async function createRemoteListSessionsRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
	runtime?: ConversationCommandRuntime,
): Promise<object> {
	const id = getRpcResponseId(command);
	const request = parseRemoteSessionListRequest(command);
	if (!request.ok) {
		return createIrohRemoteRpcErrorResponse(id, "list_sessions", request.error);
	}

	let sessions: RemoteSessionListEntry[];
	let startIndex: number;
	if (request.cursor) {
		const cursorEntry = getSessionListCursorEntry(context, authorization, request.cursor);
		if (!cursorEntry) {
			return createIrohRemoteRpcErrorResponse(id, "list_sessions", "invalid_cursor");
		}
		sessions = cursorEntry.sessions;
		startIndex = cursorEntry.nextIndex;
	} else {
		sessions = (await listRemoteWorkspaceSessionSummaries(authorization, context, runtime)).map(
			(summary) => summary.session,
		);
		startIndex = 0;
	}

	const nextIndex = startIndex + request.limit;
	const page = sessions.slice(startIndex, nextIndex);
	const hasMore = nextIndex < sessions.length;
	return createRpcSuccessResponse(id, "list_sessions", {
		sessions: page,
		hasMore,
		nextCursor: hasMore ? createSessionListCursor(context, authorization, sessions, nextIndex) : null,
	});
}

// ============================================================================
// Live Activities
// ============================================================================

interface RemoteLiveActivityCommandScope {
	workspaceName: string;
	sessionId: string;
	activityId: string;
}

interface RemoteLiveActivityRegistrationRequest extends RemoteLiveActivityCommandScope {
	tokenHash: string;
	tokenEnvironment: "development" | "production";
	platform: "ios";
}

function parseRemoteLiveActivityRegistrationCommand(
	command: Record<string, unknown>,
	authorization: IrohRemoteClientAuthorizationSuccess,
	expectedSessionId: string,
): ({ ok: true } & RemoteLiveActivityRegistrationRequest) | { ok: false; error: string } {
	const common = parseRemoteLiveActivityCommandScope(command, authorization, expectedSessionId);
	if (!common.ok) {
		return common;
	}
	if (typeof command.tokenHash !== "string") {
		return { ok: false, error: "invalid_live_activity_token" };
	}
	if (!/^[0-9a-f]{64}$/.test(command.tokenHash)) {
		return { ok: false, error: "invalid_live_activity_token" };
	}
	if (command.tokenEnvironment !== "development" && command.tokenEnvironment !== "production") {
		return { ok: false, error: "invalid_live_activity_registration" };
	}
	if (command.platform !== "ios") {
		return { ok: false, error: "invalid_live_activity_registration" };
	}
	return {
		...common,
		tokenHash: command.tokenHash,
		tokenEnvironment: command.tokenEnvironment,
		platform: command.platform,
	};
}

function parseRemoteLiveActivityUnregistrationCommand(
	command: Record<string, unknown>,
	authorization: IrohRemoteClientAuthorizationSuccess,
	expectedSessionId: string,
): ({ ok: true } & RemoteLiveActivityCommandScope) | { ok: false; error: string } {
	return parseRemoteLiveActivityCommandScope(command, authorization, expectedSessionId);
}

function parseRemoteLiveActivityCommandScope(
	command: Record<string, unknown>,
	authorization: IrohRemoteClientAuthorizationSuccess,
	expectedSessionId: string,
): ({ ok: true } & RemoteLiveActivityCommandScope) | { ok: false; error: string } {
	if (
		typeof command.workspaceName !== "string" ||
		typeof command.sessionId !== "string" ||
		typeof command.activityId !== "string"
	) {
		return { ok: false, error: "invalid_live_activity_registration" };
	}
	if (command.workspaceName !== authorization.workspace.name || command.sessionId !== expectedSessionId) {
		return { ok: false, error: "session_mismatch" };
	}
	if (!isValidLiveActivityId(command.activityId)) {
		return { ok: false, error: "invalid_live_activity_registration" };
	}
	return {
		ok: true,
		workspaceName: command.workspaceName,
		sessionId: command.sessionId,
		activityId: command.activityId,
	};
}

function isValidLiveActivityId(activityId: string): boolean {
	return activityId.length > 0 && Array.from(activityId).length <= 128 && Buffer.byteLength(activityId, "utf8") <= 512;
}

async function logLiveActivityRegistrationAudit(
	context: ConversationCommandContext,
	authorization: IrohRemoteClientAuthorizationSuccess,
	command: RemoteRpcCommand,
	success: boolean,
	error?: string,
	request?: Partial<RemoteLiveActivityRegistrationRequest>,
	extraDetails: Record<string, unknown> = {},
): Promise<void> {
	const details: Record<string, unknown> = {
		command: command.type,
		...(request
			? {
					sessionId: request.sessionId,
					activityId: request.activityId,
					tokenHash: request.tokenHash,
					tokenEnvironment: request.tokenEnvironment,
					platform: request.platform,
				}
			: {}),
		...extraDetails,
	};
	await logAudit(context.auditLogger, {
		type: command.type === "unregister_live_activity" ? "live_activity_unregistered" : "live_activity_registered",
		clientNodeId: authorization.client.nodeId,
		workspace: request?.workspaceName ?? authorization.workspace.name,
		success,
		error,
		details,
	});
}

export async function createRemoteRegisterLiveActivityRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
	expectedSessionId: string,
): Promise<object> {
	const id = getRpcResponseId(command);
	const request = parseRemoteLiveActivityRegistrationCommand(command, authorization, expectedSessionId);
	if (!request.ok) {
		await logLiveActivityRegistrationAudit(context, authorization, command, false, request.error);
		return createIrohRemoteRpcErrorResponse(id, "register_live_activity", request.error);
	}
	const deliveryChannel = await context.stateManager.findClientLiveActivityDeliveryChannel(
		authorization.client.nodeId,
		{
			tokenHash: request.tokenHash,
			tokenEnvironment: request.tokenEnvironment,
			platform: request.platform,
		},
	);
	if (!deliveryChannel?.liveActivity) {
		await logLiveActivityRegistrationAudit(
			context,
			authorization,
			command,
			false,
			"unknown_live_activity_token",
			request,
		);
		return createIrohRemoteRpcErrorResponse(id, "register_live_activity", "unknown_live_activity_token");
	}
	const now = contextNow(context);
	const result = await context.stateManager.registerClientLiveActivity(authorization.client.nodeId, {
		workspaceName: request.workspaceName,
		sessionId: request.sessionId,
		activityId: request.activityId,
		tokenHash: request.tokenHash,
		tokenEnvironment: request.tokenEnvironment,
		platform: request.platform,
		pushTargetId: deliveryChannel.id,
		createdAt: now,
		updatedAt: now,
	});
	if (!result.registration) {
		await logLiveActivityRegistrationAudit(
			context,
			authorization,
			command,
			false,
			"unknown_live_activity_token",
			request,
		);
		return createIrohRemoteRpcErrorResponse(id, "register_live_activity", "unknown_live_activity_token");
	}
	await logLiveActivityRegistrationAudit(context, authorization, command, true, undefined, request, {
		pushTargetId: deliveryChannel.id,
		replaced: result.replacedRegistration !== undefined,
	});
	return createRpcSuccessResponse(id, "register_live_activity", {
		status: "registered",
		activityId: request.activityId,
	});
}

export async function createRemoteUnregisterLiveActivityRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
	expectedSessionId: string,
): Promise<object> {
	const id = getRpcResponseId(command);
	const request = parseRemoteLiveActivityUnregistrationCommand(command, authorization, expectedSessionId);
	if (!request.ok) {
		await logLiveActivityRegistrationAudit(context, authorization, command, false, request.error);
		return createIrohRemoteRpcErrorResponse(id, "unregister_live_activity", request.error);
	}
	const removed = await context.stateManager.unregisterClientLiveActivity(
		authorization.client.nodeId,
		request.workspaceName,
		request.sessionId,
		request.activityId,
	);
	await logLiveActivityRegistrationAudit(context, authorization, command, true, undefined, request, { removed });
	return createRpcSuccessResponse(id, "unregister_live_activity", {
		status: "unregistered",
		activityId: request.activityId,
	});
}

// ============================================================================
// Identity checks, device logs, host commands
// ============================================================================

export function getIntegratedConversationIdentityError(
	command: Record<string, unknown>,
	authorization: IrohRemoteClientAuthorizationSuccess,
	runtime: ConversationCommandRuntime,
): string | undefined {
	const expectedWorkspaceName = authorization.workspace.name;
	for (const field of ["workspace", "workspaceName"]) {
		if (
			Object.hasOwn(command, field) &&
			(typeof command[field] !== "string" || command[field] !== expectedWorkspaceName)
		) {
			return "session_mismatch";
		}
	}
	if (
		Object.hasOwn(command, "sessionId") &&
		(typeof command.sessionId !== "string" || command.sessionId !== runtime.session.sessionId)
	) {
		return "session_mismatch";
	}
	return undefined;
}

async function createRemoteUploadDeviceLogsRpcResponse(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
): Promise<object> {
	const response = await handleIrohRemoteDeviceLogUploadRpcCommand(command, {
		workspacePath: authorization.workspace.path,
	});
	await logAudit(context.auditLogger, {
		type: "device_log_uploaded",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: response.success === true,
		error: response.success === true ? undefined : response.error,
		details: response.success === true ? { path: response.data.path, byteCount: response.data.byteCount } : undefined,
	});
	return response;
}

function updateAuthorizationWorkspaceMetadata(
	authorization: IrohRemoteClientAuthorizationSuccess,
	metadata: { workspaceNames: string[]; workspaces: Array<{ name: string; status: string }> },
): void {
	authorization.workspaceNames = [...metadata.workspaceNames];
	authorization.workspaces = metadata.workspaces.map((workspace) => ({
		...workspace,
	})) as typeof authorization.workspaces;
}

export async function handleRemoteHostRpcCommand(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
): Promise<object | undefined> {
	// create_worktree / list_worktrees are accepted on conversation streams so a
	// phone can spin up a parallel isolated session without opening a separate
	// manage_worktrees stream. remove_worktree stays management-stream-only (a
	// destructive op keeps the narrower surface); the passthrough filter and the
	// relay command set never admit it here.
	if (command.type === IROH_REMOTE_CREATE_WORKTREE_RPC_TYPE || command.type === IROH_REMOTE_LIST_WORKTREES_RPC_TYPE) {
		const backend = context.createWorktreeBackend?.(authorization.workspace);
		if (!backend) {
			return createIrohRemoteRpcErrorResponse(getRpcResponseId(command), command.type, "unsupported_remote_command");
		}
		const worktreeResult = await handleIrohRemoteWorktreeRpcCommand(command, {
			authorizedWorkspaceName: authorization.workspace.name,
			backend,
		});
		if (!worktreeResult.handled) {
			return undefined;
		}
		if (worktreeResult.audit) {
			await logAudit(context.auditLogger, {
				type: worktreeResult.audit.type,
				clientNodeId: authorization.client.nodeId,
				workspace: authorization.workspace.name,
				success: true,
				details: { ...worktreeResult.audit.details, source: "remote_rpc" },
			});
		}
		return worktreeResult.response;
	}
	if (command.type === IROH_REMOTE_UNREGISTER_WORKSPACE_RPC_TYPE) {
		// Conversation and relay unregister is scoped to the stream-bound workspace:
		// the documented `workspaceName` must be present and equal the authorized
		// workspace, so a client cannot unregister an unrelated registered workspace
		// by name. The relay path bypasses getIntegratedConversationIdentityError, so
		// this is the authoritative scope check for it; the dedicated
		// workspaceManagement stream enforces the same rule (workspace-streams.ts).
		if (typeof command.workspaceName !== "string" || command.workspaceName !== authorization.workspace.name) {
			return createIrohRemoteRpcErrorResponse(getRpcResponseId(command), command.type, "session_mismatch");
		}
	}
	let result: Awaited<ReturnType<typeof handleIrohRemoteWorkspaceUnregisterRpcCommand>>;
	try {
		result = await handleIrohRemoteWorkspaceUnregisterRpcCommand(command, {
			classifyWorkspaceAvailability: getIrohRemoteWorkspaceAvailabilityStatus,
			stateManager: context.stateManager,
		});
	} catch (error) {
		return createIrohRemoteRpcErrorResponse(
			getRpcResponseId(command),
			command.type,
			error instanceof Error ? error.message : String(error),
		);
	}
	if (!result.handled) {
		return undefined;
	}
	if (result.metadata) {
		updateAuthorizationWorkspaceMetadata(authorization, result.metadata);
	}
	if (result.response.success === true) {
		context.hostEngine?.clearPairingSecretForWorkspace(authorization.workspace.name);
		await context.onWorkspaceUnregistered?.(authorization.workspace.name);
	}
	await logAudit(context.auditLogger, {
		type: "workspace_unregistered",
		clientNodeId: authorization.client.nodeId,
		workspace: authorization.workspace.name,
		success: result.response.success === true,
		error: result.response.success === true ? undefined : result.response.error,
		details: { source: "remote_rpc" },
	});
	return result.response;
}

/**
 * `set_keep_awake` / `get_keep_awake` from a phone. Host-level (not
 * conversation-level): any paired client with stream access may toggle it. The
 * wire status strips the host-local mechanism name.
 */
export function createKeepAwakeRpcResponse(
	command: RemoteRpcCommand,
	context: ConversationCommandContext,
): Record<string, unknown> | IrohRemoteRpcErrorResponse {
	const id = getRpcResponseId(command);
	const keepAwake = context.keepAwake;
	if (!keepAwake) {
		return createIrohRemoteRpcErrorResponse(id, command.type, "unsupported_remote_command");
	}
	if (command.type === "set_keep_awake") {
		if (typeof command.enabled !== "boolean") {
			return createIrohRemoteRpcErrorResponse(id, command.type, "set_keep_awake requires a boolean enabled");
		}
		const status = keepAwake.setEnabled(command.enabled);
		context.onKeepAwakeSetting?.(command.enabled);
		return createRpcSuccessResponse(id, command.type, { keepAwake: toRpcKeepAwakeStatus(status) });
	}
	return createRpcSuccessResponse(id, command.type, { keepAwake: toRpcKeepAwakeStatus(keepAwake.status) });
}

/**
 * `set_web_search_key` / `get_web_search_status` from a phone. Host-level (not
 * conversation-level): any paired client with stream access may set it. The
 * wire status never includes the key itself, only whether one is stored.
 */
export function createWebSearchKeyRpcResponse(
	command: RemoteRpcCommand,
	context: ConversationCommandContext,
): Record<string, unknown> | IrohRemoteRpcErrorResponse {
	const id = getRpcResponseId(command);
	const webSearchKey = context.webSearchKey;
	if (!webSearchKey) {
		return createIrohRemoteRpcErrorResponse(id, command.type, "unsupported_remote_command");
	}
	if (command.type === "set_web_search_key") {
		const apiKey = command.apiKey;
		if (apiKey !== undefined && apiKey !== null && typeof apiKey !== "string") {
			return createIrohRemoteRpcErrorResponse(
				id,
				command.type,
				"set_web_search_key requires apiKey to be a string or null",
			);
		}
		const normalized = typeof apiKey === "string" ? apiKey.trim() : "";
		webSearchKey.set(normalized.length > 0 ? normalized : null);
	}
	return createRpcSuccessResponse(id, command.type, { webSearch: { configured: webSearchKey.configured } });
}

export function toRpcKeepAwakeStatus(status: KeepAwakeStatus): RpcKeepAwakeStatus {
	return {
		enabled: status.enabled,
		state: status.state,
		...(status.reason === undefined ? {} : { reason: status.reason }),
	};
}

// ============================================================================
// Dispatch
// ============================================================================

/**
 * Host-side handler for conversation-stream RPC commands that are not served
 * directly by the runtime's rpc mode. Returns undefined for commands the rpc
 * mode should handle itself — including abort, which stops the turn while the
 * stream stays open and the runtime stays live.
 */
export async function handleIntegratedConversationRpcCommand(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	context: ConversationCommandContext,
	runtime: ConversationCommandRuntime,
): Promise<object | undefined> {
	if (context.isDraining?.() && TURN_INITIATING_RPC_TYPES.has(command.type)) {
		return createLeaseDrainingRpcErrorResponse(command);
	}
	// Defense in depth: the phone hides the composer for subagent tabs, but a
	// stray client must not be able to inject turns into a delegated child run.
	if (context.isSubagentSession?.() && TURN_INITIATING_RPC_TYPES.has(command.type)) {
		return createSubagentSessionReadOnlyRpcErrorResponse(command);
	}
	if (command.type === "list_sessions") {
		return await createRemoteListSessionsRpcResponse(command, authorization, context, runtime);
	}
	if (command.type === "set_keep_awake" || command.type === "get_keep_awake") {
		return createKeepAwakeRpcResponse(command, context);
	}
	if (command.type === "set_web_search_key" || command.type === "get_web_search_status") {
		return createWebSearchKeyRpcResponse(command, context);
	}
	if (INTEGRATED_CONVERSATION_UNSUPPORTED_RPC_TYPES.has(command.type)) {
		return createIrohRemoteRpcErrorResponse(getRpcResponseId(command), command.type, "unsupported_remote_command");
	}
	if (command.type === "register_live_activity") {
		return await createRemoteRegisterLiveActivityRpcResponse(
			command,
			authorization,
			context,
			runtime.session.sessionId,
		);
	}
	if (command.type === "unregister_live_activity") {
		return await createRemoteUnregisterLiveActivityRpcResponse(
			command,
			authorization,
			context,
			runtime.session.sessionId,
		);
	}
	const identityError = getIntegratedConversationIdentityError(command, authorization, runtime);
	if (identityError) {
		return createIrohRemoteRpcErrorResponse(getRpcResponseId(command), command.type, identityError);
	}
	if (command.type === "upload_device_logs") {
		return await createRemoteUploadDeviceLogsRpcResponse(command, authorization, context);
	}
	if (command.type === "get_transcript") {
		return createRemoteGetTranscriptRpcResponse(command, authorization, runtime);
	}
	if (command.type === "get_message_images") {
		return createRemoteGetMessageImagesRpcResponse(command, authorization, runtime);
	}
	return await handleRemoteHostRpcCommand(command, authorization, context);
}
