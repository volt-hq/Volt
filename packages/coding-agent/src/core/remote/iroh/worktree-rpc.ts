import { isIrohRemoteWorktreeId } from "./protocol.ts";
import { createIrohRemoteRpcErrorResponse, type IrohRemoteRpcErrorResponse } from "./rpc-command-filter.ts";

export const IROH_REMOTE_CREATE_WORKTREE_RPC_TYPE = "create_worktree";
export const IROH_REMOTE_LIST_WORKTREES_RPC_TYPE = "list_worktrees";
export const IROH_REMOTE_REMOVE_WORKTREE_RPC_TYPE = "remove_worktree";

export const IROH_REMOTE_WORKTREE_RPC_TYPES: ReadonlySet<string> = new Set([
	IROH_REMOTE_CREATE_WORKTREE_RPC_TYPE,
	IROH_REMOTE_LIST_WORKTREES_RPC_TYPE,
	IROH_REMOTE_REMOVE_WORKTREE_RPC_TYPE,
]);

/**
 * Wire shape for a worktree on the iroh remote protocol. NOTE: no filesystem
 * paths ever cross the wire; checkout paths stay host-local.
 */
export interface IrohRemoteWorktreeSummary {
	id: string;
	branch: string;
	baseRef?: string;
	createdAt: number;
	sessionIds: string[];
	available?: boolean;
	/** Uncommitted work in the checkout (`git status --porcelain` non-empty). */
	dirty?: boolean;
	/** Branch commits vs the base ref (merge-back guidance, design §5.3). */
	aheadBehind?: { ahead: number; behind: number };
}

/** Host-side backend the RPC helpers delegate to (the daemon's WorktreeManager). */
export interface IrohRemoteWorktreeRpcBackend {
	createWorktree(
		workspaceName: string,
		options: { id?: string; branch?: string; baseRef?: string },
	): Promise<{ ok: true; worktree: IrohRemoteWorktreeSummary } | { ok: false; error: string; detail?: string }>;
	listWorktrees(
		workspaceName: string,
	): Promise<{ ok: true; worktrees: IrohRemoteWorktreeSummary[] } | { ok: false; error: string; detail?: string }>;
	removeWorktree(
		workspaceName: string,
		worktreeId: string,
		force: boolean,
	): Promise<
		| { ok: true; stoppedRuntimeCount: number; closedStreamCount: number }
		| { ok: false; error: string; detail?: string }
	>;
}

export interface HandleIrohRemoteWorktreeRpcCommandOptions {
	/** The stream-authorized workspace name; cross-workspace requests are session_mismatch. */
	authorizedWorkspaceName: string;
	backend: IrohRemoteWorktreeRpcBackend;
}

export interface IrohRemoteWorktreeRpcSuccessResponse {
	id?: string;
	type: "response";
	command: string;
	success: true;
	data: Record<string, unknown>;
}

export type IrohRemoteWorktreeRpcResponse = IrohRemoteWorktreeRpcSuccessResponse | IrohRemoteRpcErrorResponse;

export type IrohRemoteWorktreeRpcResult =
	| { handled: false }
	| {
			handled: true;
			response: IrohRemoteWorktreeRpcResponse;
			/** Present on success for audit hooks. */
			audit?: { type: string; details: Record<string, unknown> };
	  };

const CREATE_WORKTREE_ALLOWED_FIELDS = new Set(["id", "type", "workspaceName", "worktreeName", "branch", "baseRef"]);
const LIST_WORKTREES_ALLOWED_FIELDS = new Set(["id", "type", "workspaceName"]);
const REMOVE_WORKTREE_ALLOWED_FIELDS = new Set(["id", "type", "workspaceName", "worktreeId", "force"]);

export async function handleIrohRemoteWorktreeRpcCommand(
	command: Record<string, unknown>,
	options: HandleIrohRemoteWorktreeRpcCommandOptions,
): Promise<IrohRemoteWorktreeRpcResult> {
	if (typeof command.type !== "string" || !IROH_REMOTE_WORKTREE_RPC_TYPES.has(command.type)) {
		return { handled: false };
	}
	const commandType = command.type;
	const id = typeof command.id === "string" ? command.id : undefined;
	const fail = (error: string): IrohRemoteWorktreeRpcResult => ({
		handled: true,
		response: createIrohRemoteRpcErrorResponse(id, commandType, error),
	});

	const allowedFields =
		commandType === IROH_REMOTE_CREATE_WORKTREE_RPC_TYPE
			? CREATE_WORKTREE_ALLOWED_FIELDS
			: commandType === IROH_REMOTE_LIST_WORKTREES_RPC_TYPE
				? LIST_WORKTREES_ALLOWED_FIELDS
				: REMOVE_WORKTREE_ALLOWED_FIELDS;
	// No filesystem paths inbound, ever; anything outside the allowlist is invalid.
	for (const field of Object.keys(command)) {
		if (!allowedFields.has(field)) {
			return fail("invalid_request");
		}
	}
	if (typeof command.workspaceName !== "string" || command.workspaceName.length === 0) {
		return fail("invalid_request");
	}
	if (command.workspaceName !== options.authorizedWorkspaceName) {
		return fail("session_mismatch");
	}

	if (commandType === IROH_REMOTE_CREATE_WORKTREE_RPC_TYPE) {
		if (command.worktreeName !== undefined && !isIrohRemoteWorktreeId(command.worktreeName)) {
			return fail("invalid_request");
		}
		if (command.branch !== undefined && typeof command.branch !== "string") {
			return fail("invalid_request");
		}
		if (command.baseRef !== undefined && typeof command.baseRef !== "string") {
			return fail("invalid_request");
		}
		const created = await options.backend.createWorktree(command.workspaceName, {
			...(command.worktreeName === undefined ? {} : { id: command.worktreeName }),
			...(command.branch === undefined ? {} : { branch: command.branch }),
			...(command.baseRef === undefined ? {} : { baseRef: command.baseRef }),
		});
		if (!created.ok) {
			return fail(created.error);
		}
		return {
			handled: true,
			response: {
				...(id === undefined ? {} : { id }),
				type: "response",
				command: commandType,
				success: true,
				data: { worktree: toWorktreeSummary(created.worktree) },
			},
			audit: {
				type: "worktree_created",
				details: { worktreeId: created.worktree.id, branch: created.worktree.branch },
			},
		};
	}

	if (commandType === IROH_REMOTE_LIST_WORKTREES_RPC_TYPE) {
		const listed = await options.backend.listWorktrees(command.workspaceName);
		if (!listed.ok) {
			return fail(listed.error);
		}
		return {
			handled: true,
			response: {
				...(id === undefined ? {} : { id }),
				type: "response",
				command: commandType,
				success: true,
				data: { worktrees: listed.worktrees.map((worktree) => toWorktreeSummary(worktree)) },
			},
		};
	}

	if (!isIrohRemoteWorktreeId(command.worktreeId)) {
		return fail("invalid_request");
	}
	if (command.force !== undefined && typeof command.force !== "boolean") {
		return fail("invalid_request");
	}
	const force = command.force === true;
	const removed = await options.backend.removeWorktree(command.workspaceName, command.worktreeId, force);
	if (!removed.ok) {
		return fail(removed.error);
	}
	return {
		handled: true,
		response: {
			...(id === undefined ? {} : { id }),
			type: "response",
			command: commandType,
			success: true,
			data: {
				worktreeId: command.worktreeId,
				removed: true,
				stoppedRuntimeCount: removed.stoppedRuntimeCount,
				closedStreamCount: removed.closedStreamCount,
			},
		},
		audit: {
			type: "worktree_removed",
			details: { worktreeId: command.worktreeId, force, stoppedRuntimeCount: removed.stoppedRuntimeCount },
		},
	};
}

/** Field allowlist for the wire summary: never leak a `path` or workspaceName. */
function toWorktreeSummary(worktree: IrohRemoteWorktreeSummary): IrohRemoteWorktreeSummary {
	return {
		id: worktree.id,
		branch: worktree.branch,
		...(worktree.baseRef === undefined ? {} : { baseRef: worktree.baseRef }),
		createdAt: worktree.createdAt,
		sessionIds: [...worktree.sessionIds],
		...(worktree.available === undefined ? {} : { available: worktree.available }),
		...(worktree.dirty === undefined ? {} : { dirty: worktree.dirty }),
		...(worktree.aheadBehind === undefined
			? {}
			: { aheadBehind: { ahead: worktree.aheadBehind.ahead, behind: worktree.aheadBehind.behind } }),
	};
}
