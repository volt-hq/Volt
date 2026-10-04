import type { IrohRemoteWorktreeSummary as ProtocolIrohRemoteWorktreeSummary } from "@hansjm10/volt-protocol";

/**
 * Wire shape for a worktree on the iroh remote protocol. NOTE: no filesystem
 * paths ever cross the wire; checkout paths stay host-local.
 */
export type IrohRemoteWorktreeSummary = ProtocolIrohRemoteWorktreeSummary;

/** The daemon's worktree operations for one workspace, behind the `create_worktree`, `remove_worktree`, and `worktrees` intents and query. */
export interface IrohRemoteWorktreeRpcBackend {
	createWorktree(
		workspaceName: string,
		options: { id?: string; branch?: string; baseRef?: string; workingDirectory?: string },
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
