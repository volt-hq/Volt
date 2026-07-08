import { Buffer } from "node:buffer";
import type { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../core/remote/iroh/authorization.ts";
import { isIrohRemoteWorkspaceName } from "../core/remote/iroh/handshake.ts";
import { sanitizeIrohRemoteOutbound } from "../core/remote/iroh/outbound-filter.ts";
import { isIrohRemoteWorkingDirectory } from "../core/remote/iroh/protocol.ts";
import { createIrohRemoteRpcErrorResponse } from "../core/remote/iroh/rpc-command-filter.ts";
import {
	handleIrohRemoteWorktreeRpcCommand,
	IROH_REMOTE_WORKTREE_RPC_TYPES,
	type IrohRemoteWorktreeRpcBackend,
} from "../core/remote/iroh/worktree-rpc.ts";
import {
	DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	type IrohBiStreamLike,
	type IrohBytes,
	type IrohRecvStreamLike,
} from "../core/rpc/iroh-transport.ts";
import { serializeJsonLine } from "../core/rpc/jsonl.ts";
import {
	type ConversationCommandContext,
	createRemoteListSessionsRpcResponse,
	createRpcSuccessResponse,
	getRpcResponseId,
	type RemoteRpcCommand,
} from "./conversation-commands.ts";
import { listWorkspaceDirectories } from "./workspace-directory.ts";

const DEFAULT_READ_LIMIT = 64 * 1024;

export const WORKSPACE_UNREGISTERED_CLOSE_REASON = "workspace_unregistered";
const LIST_WORKSPACE_DIRECTORIES_RPC_TYPE = "list_workspace_directories";

export async function readLineFromIroh(
	recv: IrohRecvStreamLike,
	initial: Buffer = Buffer.alloc(0),
	options: { maxLineBytes?: number } = {},
): Promise<{ line: string | undefined; rest: Buffer }> {
	const maxLineBytes = options.maxLineBytes;
	const readLimit = Math.min(DEFAULT_READ_LIMIT, maxLineBytes === undefined ? DEFAULT_READ_LIMIT : maxLineBytes + 1);
	let buffer = Buffer.from(initial);

	while (true) {
		const newlineIndex = buffer.indexOf(10);
		if (newlineIndex !== -1) {
			let lineBuffer = buffer.subarray(0, newlineIndex);
			if (lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === 13) {
				lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
			}
			if (maxLineBytes !== undefined && lineBuffer.length > maxLineBytes) {
				throw new Error(`Line exceeds maximum size of ${maxLineBytes} bytes`);
			}
			return {
				line: lineBuffer.toString("utf8"),
				rest: buffer.subarray(newlineIndex + 1),
			};
		}

		if (maxLineBytes !== undefined && buffer.length > maxLineBytes) {
			throw new Error(`Line exceeds maximum size of ${maxLineBytes} bytes`);
		}

		const chunk = await recv.read(readLimit);
		if (!chunk || chunk.length === 0) {
			return { line: undefined, rest: buffer };
		}
		buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
	}
}

export interface RemoteSanitizerOverrides {
	/** Sanitizer root override (worktree-bound streams use the worktree path). */
	workspacePath?: string;
	/** Extra roots (parent checkout, worktrees root) redacted to /workspace. */
	additionalRedactedPaths?: string[];
}

export function getRemoteSanitizerOptions(
	authorization: IrohRemoteClientAuthorizationSuccess,
	overrides: RemoteSanitizerOverrides = {},
): {
	remoteWorkspacePath: string;
	workspacePath: string;
	additionalRedactedPaths?: string[];
} {
	return {
		remoteWorkspacePath: "/workspace",
		workspacePath: overrides.workspacePath ?? authorization.workspace.path,
		...(overrides.additionalRedactedPaths === undefined
			? {}
			: { additionalRedactedPaths: overrides.additionalRedactedPaths }),
	};
}

export async function writeIrohRemoteJsonLine(
	send: IrohBiStreamLike["send"],
	value: object,
	authorization: IrohRemoteClientAuthorizationSuccess,
	sanitizerOverrides: RemoteSanitizerOverrides = {},
): Promise<void> {
	const sanitized = sanitizeIrohRemoteOutbound(value, getRemoteSanitizerOptions(authorization, sanitizerOverrides));
	await send.writeAll(Array.from(Buffer.from(serializeJsonLine(sanitized), "utf8")));
}

export function parseRemoteRpcCommandLine(
	line: string,
): { ok: true; command: RemoteRpcCommand } | { ok: false; response: object } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return {
			ok: false,
			response: createIrohRemoteRpcErrorResponse(undefined, "parse", "invalid_request"),
		};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {
			ok: false,
			response: createIrohRemoteRpcErrorResponse(undefined, "unknown", "invalid_request"),
		};
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.type !== "string") {
		return {
			ok: false,
			response: createIrohRemoteRpcErrorResponse(getRpcResponseId(record), "unknown", "invalid_request"),
		};
	}
	return { ok: true, command: record as RemoteRpcCommand };
}

async function runWorkspaceUtilityRpcLoop(
	stream: IrohBiStreamLike,
	initialInput: IrohBytes,
	handleCommand: (line: string) => Promise<boolean>,
): Promise<void> {
	let buffer: Buffer = Buffer.from(Array.from(initialInput));
	while (true) {
		const result = await readLineFromIroh(stream.recv, buffer, {
			maxLineBytes: DEFAULT_IROH_RPC_MAX_LINE_BYTES,
		});
		if (result.line === undefined) {
			if (result.rest.length > 0) {
				const shouldClose = await handleCommand(result.rest.toString("utf8"));
				if (shouldClose) {
					return;
				}
			}
			return;
		}

		const shouldClose = await handleCommand(result.line);
		if (shouldClose) {
			return;
		}
		buffer = result.rest;
	}
}

export interface WorkspaceStreamHooks {
	auditLogger: IrohRemoteAuditLogger;
	commandContext: ConversationCommandContext;
	/** Unregister the workspace and tear down its streams/runtimes. Returns close counts. */
	unregisterWorkspace(
		workspaceName: string,
		excludedStreamClose: () => void,
	): Promise<{ ok: true; closedStreamCount: number; stoppedRuntimeCount: number } | { ok: false; error: string }>;
}

export interface WorkspaceStreamContext {
	stream: IrohBiStreamLike;
	initialInput: IrohBytes;
	authorization: IrohRemoteClientAuthorizationSuccess;
	closeStream(reason?: string): void;
}

/** Serve a workspaceDiscovery stream: list_sessions only. */
export async function runWorkspaceDiscoveryStream(
	context: WorkspaceStreamContext,
	hooks: Pick<WorkspaceStreamHooks, "commandContext">,
): Promise<void> {
	const { stream, authorization } = context;
	await runWorkspaceUtilityRpcLoop(stream, context.initialInput, async (line) => {
		const parsed = parseRemoteRpcCommandLine(line);
		if (!parsed.ok) {
			await writeIrohRemoteJsonLine(stream.send, parsed.response, authorization);
			return false;
		}
		if (parsed.command.type !== "list_sessions") {
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(
					getRpcResponseId(parsed.command),
					parsed.command.type,
					"unsupported_on_workspace_discovery_stream",
				),
				authorization,
			);
			return false;
		}
		await writeIrohRemoteJsonLine(
			stream.send,
			await createRemoteListSessionsRpcResponse(parsed.command, authorization, hooks.commandContext),
			authorization,
		);
		return false;
	});
}

function parseWorkspaceManagementWorkspaceRequest(
	command: RemoteRpcCommand,
	authorization: IrohRemoteClientAuthorizationSuccess,
	allowedFields: readonly string[],
): { ok: true; workspaceName: string } | { ok: false; error: string } {
	if (typeof command.workspaceName !== "string" || !isIrohRemoteWorkspaceName(command.workspaceName)) {
		return { ok: false, error: "invalid_workspace_payload" };
	}
	if (command.workspaceName !== authorization.workspace.name) {
		return { ok: false, error: "session_mismatch" };
	}
	const allowed = new Set(allowedFields);
	for (const field of Object.keys(command)) {
		if (!allowed.has(field)) {
			return { ok: false, error: "invalid_request" };
		}
	}
	return { ok: true, workspaceName: command.workspaceName };
}

function parseWorkspaceDirectoryPath(command: RemoteRpcCommand): string | undefined | { error: string } {
	if (command.path === undefined) {
		return undefined;
	}
	if (typeof command.path !== "string" || !isIrohRemoteWorkingDirectory(command.path)) {
		return { error: "invalid_working_directory" };
	}
	return command.path;
}

/** Serve a workspaceManagement stream: workspace management RPCs. */
export async function runWorkspaceManagementStream(
	context: WorkspaceStreamContext,
	hooks: WorkspaceStreamHooks,
): Promise<void> {
	const { stream, authorization } = context;
	await runWorkspaceUtilityRpcLoop(stream, context.initialInput, async (line) => {
		const parsed = parseRemoteRpcCommandLine(line);
		if (!parsed.ok) {
			await writeIrohRemoteJsonLine(stream.send, parsed.response, authorization);
			return false;
		}
		if (
			parsed.command.type !== "unregister_workspace" &&
			parsed.command.type !== LIST_WORKSPACE_DIRECTORIES_RPC_TYPE
		) {
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(
					getRpcResponseId(parsed.command),
					parsed.command.type,
					"unsupported_on_workspace_management_stream",
				),
				authorization,
			);
			return false;
		}
		const id = getRpcResponseId(parsed.command);
		if (parsed.command.type === LIST_WORKSPACE_DIRECTORIES_RPC_TYPE) {
			const request = parseWorkspaceManagementWorkspaceRequest(parsed.command, authorization, [
				"id",
				"type",
				"workspaceName",
				"path",
			]);
			if (!request.ok) {
				await writeIrohRemoteJsonLine(
					stream.send,
					createIrohRemoteRpcErrorResponse(id, LIST_WORKSPACE_DIRECTORIES_RPC_TYPE, request.error),
					authorization,
				);
				return false;
			}
			const path = parseWorkspaceDirectoryPath(parsed.command);
			if (typeof path === "object") {
				await writeIrohRemoteJsonLine(
					stream.send,
					createIrohRemoteRpcErrorResponse(id, LIST_WORKSPACE_DIRECTORIES_RPC_TYPE, path.error),
					authorization,
				);
				return false;
			}
			const listed = await listWorkspaceDirectories(authorization.workspace.path, path);
			if (!listed.ok) {
				await writeIrohRemoteJsonLine(
					stream.send,
					createIrohRemoteRpcErrorResponse(id, LIST_WORKSPACE_DIRECTORIES_RPC_TYPE, listed.error),
					authorization,
				);
				return false;
			}
			await writeIrohRemoteJsonLine(
				stream.send,
				createRpcSuccessResponse(id, LIST_WORKSPACE_DIRECTORIES_RPC_TYPE, {
					workspaceName: request.workspaceName,
					...(listed.currentPath === undefined ? {} : { path: listed.currentPath }),
					directories: listed.directories,
				}),
				authorization,
			);
			return false;
		}
		const request = parseWorkspaceManagementWorkspaceRequest(parsed.command, authorization, [
			"id",
			"type",
			"workspaceName",
		]);
		if (!request.ok) {
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(id, "unregister_workspace", request.error),
				authorization,
			);
			return false;
		}

		let excludedClosed = false;
		const result = await hooks.unregisterWorkspace(request.workspaceName, () => {
			excludedClosed = true;
		});
		if (!result.ok) {
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(id, "unregister_workspace", result.error),
				authorization,
			);
			return false;
		}
		await hooks.auditLogger
			.log({
				type: "workspace_unregistered",
				clientNodeId: authorization.client.nodeId,
				workspace: request.workspaceName,
				success: true,
				details: {
					closedStreamCount: result.closedStreamCount,
					source: "remote_workspace_management_stream",
					stoppedRuntimeCount: result.stoppedRuntimeCount,
				},
			})
			.catch(() => {});
		await writeIrohRemoteJsonLine(
			stream.send,
			createRpcSuccessResponse(id, "unregister_workspace", {
				workspaceName: request.workspaceName,
				unregistered: true,
			}),
			authorization,
		);
		if (!excludedClosed) {
			context.closeStream(WORKSPACE_UNREGISTERED_CLOSE_REASON);
		}
		return true;
	});
}

export interface WorktreeStreamHooks {
	auditLogger: IrohRemoteAuditLogger;
	worktrees: IrohRemoteWorktreeRpcBackend;
	/** Extra roots redacted on every frame of this stream (worktrees root). */
	additionalRedactedPaths?: string[];
}

/** Serve a manage_worktrees workspaceManagement stream: create/list/remove worktrees only. */
export async function runWorktreeManagementStream(
	context: WorkspaceStreamContext,
	hooks: WorktreeStreamHooks,
): Promise<void> {
	const { stream, authorization } = context;
	const sanitizerOverrides = { additionalRedactedPaths: hooks.additionalRedactedPaths };
	await runWorkspaceUtilityRpcLoop(stream, context.initialInput, async (line) => {
		const parsed = parseRemoteRpcCommandLine(line);
		if (!parsed.ok) {
			await writeIrohRemoteJsonLine(stream.send, parsed.response, authorization, sanitizerOverrides);
			return false;
		}
		if (!IROH_REMOTE_WORKTREE_RPC_TYPES.has(parsed.command.type)) {
			await writeIrohRemoteJsonLine(
				stream.send,
				createIrohRemoteRpcErrorResponse(
					getRpcResponseId(parsed.command),
					parsed.command.type,
					"unsupported_on_workspace_management_stream",
				),
				authorization,
				sanitizerOverrides,
			);
			return false;
		}
		const result = await handleIrohRemoteWorktreeRpcCommand(parsed.command, {
			authorizedWorkspaceName: authorization.workspace.name,
			backend: hooks.worktrees,
		});
		if (!result.handled) {
			return false;
		}
		if (parsed.command.type !== "list_worktrees") {
			await hooks.auditLogger
				.log({
					type:
						result.audit?.type ??
						(parsed.command.type === "create_worktree" ? "worktree_created" : "worktree_removed"),
					clientNodeId: authorization.client.nodeId,
					workspace: authorization.workspace.name,
					success: result.response.success,
					...(result.response.success ? {} : { error: result.response.error }),
					details: { source: "remote_worktree_management_stream", ...(result.audit?.details ?? {}) },
				})
				.catch(() => {});
		}
		await writeIrohRemoteJsonLine(stream.send, result.response, authorization, sanitizerOverrides);
		return false;
	});
}
