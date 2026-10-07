/**
 * The TUI's own use of the daemon's control plane: resolving the workspace
 * of a directory, and the `/worktree` command's worktree list, create, and
 * session binding (worktrees design §5.2.1).
 */

import { resolve } from "node:path";
import { VERSION } from "../../config.ts";
import { createDaemonClient, type DaemonClient } from "../../daemon/control-client.ts";
import {
	CONTROL_RPC_GRANTS_CAPABILITY,
	CONTROL_WORKTREES_CAPABILITY,
	type ControlWorktreeStatus,
} from "../../daemon/control-protocol.ts";
import { getDaemonSocketPath } from "../../daemon/paths.ts";
import { type EnsureDaemonResult, ensureDaemonRunning } from "../../daemon/spawn.ts";
import { isPathInside } from "../../daemon/workspace-directory.ts";

/**
 * Resolve the registered workspace for a cwd against the daemon: a
 * daemon-managed worktree containing it (§5.2.2) belongs to its PARENT
 * workspace; otherwise the innermost registered workspace containing it.
 * Nothing is registered here: the daemon registers a TUI's working directory
 * when it opens a conversation there, and asks before a sensitive one (D17).
 */
export async function resolveDaemonWorkspaceForCwd(
	client: Pick<DaemonClient, "request">,
	cwd: string,
): Promise<{ name: string; path: string; worktreeId?: string } | undefined> {
	const status = await client.request({ type: "status" });
	if (status.type !== "status_result") {
		return undefined;
	}
	const resolvedCwd = resolve(cwd);
	try {
		const resolved = await client.request({ type: "worktree_resolve", path: resolvedCwd });
		if (resolved.type === "worktree_resolve_result") {
			return { name: resolved.workspaceName, path: resolved.workspacePath, worktreeId: resolved.worktreeId };
		}
	} catch {
		// A transient failure: fall through to the registered workspaces.
	}
	const match = status.workspaces
		.filter((workspace) => isPathInside(workspace.path, resolvedCwd))
		.sort((left, right) => right.path.length - left.path.length)[0];
	return match ? { name: match.name, path: match.path } : undefined;
}

/** The workspace `/worktree` creates worktrees of: the one named, else the one containing the cwd. */
async function workspaceOf(
	client: DaemonClient,
	options: OpenDaemonWorktreeControlOptions,
): Promise<{ name: string; path: string } | undefined> {
	if (options.workspaceName === undefined) return resolveDaemonWorkspaceForCwd(client, options.cwd);
	const status = await client.request({ type: "status" });
	if (status.type !== "status_result") return undefined;
	return status.workspaces.find((workspace) => workspace.name === options.workspaceName);
}

export interface DaemonWorktreeControl {
	workspaceName: string;
	workspacePath: string;
	listWorktrees(): Promise<ControlWorktreeStatus[]>;
	createWorktree(name?: string): Promise<{ ok: true; worktree: ControlWorktreeStatus } | { ok: false; error: string }>;
	/** Best-effort: records the session→worktree binding in daemon state. */
	bindSession(worktreeId: string, sessionId: string): Promise<boolean>;
	close(): Promise<void>;
}

export interface OpenDaemonWorktreeControlOptions {
	cwd: string;
	agentDir: string;
	/** The conversation's workspace, when the TUI knows it; else the one containing `cwd`. */
	workspaceName?: string;
	/** Injectable for tests; defaults to ensureDaemonRunning. */
	ensureDaemon?: (agentDir: string) => Promise<EnsureDaemonResult>;
}

/**
 * Control-plane handle for the TUI /worktree command (§5.2.1): ensures the
 * daemon is running, takes the conversation's workspace (or resolves the one
 * containing the cwd), and exposes worktree list/create/bind over the
 * control socket.
 */
export async function openDaemonWorktreeControl(
	options: OpenDaemonWorktreeControlOptions,
): Promise<{ ok: true; control: DaemonWorktreeControl } | { ok: false; error: string }> {
	const ensureDaemon = options.ensureDaemon ?? ensureDaemonRunning;
	let ensured: EnsureDaemonResult;
	try {
		ensured = await ensureDaemon(options.agentDir);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	if (!ensured.healthy) {
		return { ok: false, error: `voltd is not available (${ensured.state}); try \`volt daemon start\`` };
	}
	const client = createDaemonClient({
		socketPath: ensured.socketPath ?? getDaemonSocketPath(options.agentDir),
		client: "tui",
		version: VERSION,
		authToken: ensured.authToken,
		reconnect: false,
		capabilities: [CONTROL_WORKTREES_CAPABILITY, CONTROL_RPC_GRANTS_CAPABILITY],
	});
	try {
		await client.connect();
		const workspace = await workspaceOf(client, options);
		if (!workspace) {
			await client.close();
			return {
				ok: false,
				error: "no registered workspace contains the current directory (register it with `volt remote workspace add`)",
			};
		}
		const control: DaemonWorktreeControl = {
			workspaceName: workspace.name,
			workspacePath: workspace.path,
			async listWorktrees() {
				const response = await client.request({ type: "worktree_list", workspaceName: workspace.name });
				return response.type === "worktrees_result" ? response.worktrees : [];
			},
			async createWorktree(name?: string) {
				const response = await client.request({
					type: "worktree_create",
					workspaceName: workspace.name,
					...(name === undefined ? {} : { worktreeName: name }),
				});
				if (response.type === "worktree_result") {
					return { ok: true, worktree: response.worktree };
				}
				const error =
					response.type === "error" ? `${response.code}: ${response.message}` : "unexpected daemon response";
				return { ok: false, error };
			},
			async bindSession(worktreeId: string, sessionId: string) {
				try {
					const response = await client.request({
						type: "worktree_bind",
						workspaceName: workspace.name,
						worktreeId,
						sessionId,
					});
					return response.type === "ok";
				} catch {
					return false;
				}
			},
			close: () => client.close(),
		};
		return { ok: true, control };
	} catch (error) {
		await client.close().catch(() => {});
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
