import { existsSync } from "node:fs";
import { VERSION } from "../config.ts";
import type { SessionManager } from "../core/session-manager.ts";
import { createDaemonClient } from "./control-client.ts";
import { ensureDaemonRunning } from "./spawn.ts";
import { isPathUnderWorktreesRoot } from "./worktree-manager.ts";

export class LocalSessionWorktreeRestoreError extends Error {
	constructor(cwd: string, cause: unknown) {
		super(
			`Cannot restore the session's managed worktree at ${cwd}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "LocalSessionWorktreeRestoreError";
	}
}

/** Restore through the owning daemon before local missing-cwd handling can redirect a session. */
export async function restoreLocalSessionWorktree(sessionManager: SessionManager, agentDir: string): Promise<void> {
	const cwd = sessionManager.getCwd();
	if (!sessionManager.getSessionRef() || !isPathUnderWorktreesRoot(agentDir, cwd) || existsSync(cwd)) return;

	try {
		const ensured = await ensureDaemonRunning(agentDir);
		if (!ensured.healthy) {
			throw new Error(
				`voltd is unavailable (${ensured.state}). Run \`volt daemon start\` and retry; refusing to resume in another directory.`,
			);
		}
		const client = createDaemonClient({
			socketPath: ensured.socketPath,
			authToken: ensured.authToken,
			client: "cli",
			version: VERSION,
			reconnect: false,
		});
		try {
			const response = await client.request({
				type: "worktree_restore",
				path: cwd,
				sessionId: sessionManager.getSessionId(),
			});
			if (response.type !== "ok") {
				throw new Error(response.type === "error" ? response.message : "unexpected daemon response");
			}
		} finally {
			await client.close();
		}
	} catch (error) {
		throw new LocalSessionWorktreeRestoreError(cwd, error);
	}
}
