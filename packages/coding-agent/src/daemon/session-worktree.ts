import { VERSION } from "../config.ts";
import type { SessionManager } from "../core/session-manager.ts";
import { createDaemonClient, type DaemonClient } from "./control-client.ts";
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

interface LocalWorktreeOwnership {
	client: DaemonClient;
	owners: Set<SessionManager>;
}

// Ownership follows the manager from CLI preparation into the runtime. Same-cwd
// replacements retain it before disposing the old session, without a protection gap.
const localWorktrees = new WeakMap<SessionManager, LocalWorktreeOwnership>();

export function retainLocalSessionWorktree(source: SessionManager, target: SessionManager): void {
	const ownership = localWorktrees.get(source);
	if (!ownership || localWorktrees.has(target) || source.getCwd() !== target.getCwd()) return;
	ownership.owners.add(target);
	localWorktrees.set(target, ownership);
}

export async function releaseLocalSessionWorktree(manager: SessionManager): Promise<void> {
	const ownership = localWorktrees.get(manager);
	if (!ownership) return;
	localWorktrees.delete(manager);
	ownership.owners.delete(manager);
	if (ownership.owners.size === 0) await ownership.client.close();
}

export async function closeLocalSessionManager(manager: SessionManager): Promise<void> {
	try {
		await manager.closePersistence();
	} finally {
		await releaseLocalSessionWorktree(manager);
	}
}

/** Restore and pin through the owning daemon before any local cwd-bound startup. */
export async function restoreLocalSessionWorktree(sessionManager: SessionManager, agentDir: string): Promise<void> {
	const cwd = sessionManager.getCwd();
	const sessionRef = sessionManager.getSessionRef();
	if (!sessionRef || !isPathUnderWorktreesRoot(agentDir, cwd)) return;
	const retained = localWorktrees.get(sessionManager);
	if (retained) {
		if (retained.client.connectionState !== "connected")
			throw new LocalSessionWorktreeRestoreError(cwd, "Managed checkout protection was lost; retry the session.");
		return;
	}

	try {
		const ensured = await ensureDaemonRunning(agentDir);
		if (!ensured.healthy) {
			throw new Error(
				`voltd is unavailable (${ensured.state}). Run \`volt daemon start\` and retry; refusing to resume in another directory.`,
			);
		}
		// Daemon-owned runtimes already hold a preparation/lease through their host.
		// Re-entering worktree_restore would contend with that exact preparation.
		if (ensured.pid === process.pid) return;
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
				sessionRef,
			});
			if (response.type !== "ok") {
				throw new Error(response.type === "error" ? response.message : "unexpected daemon response");
			}
			localWorktrees.set(sessionManager, { client, owners: new Set([sessionManager]) });
		} catch (error) {
			await client.close();
			throw error;
		}
	} catch (error) {
		throw new LocalSessionWorktreeRestoreError(cwd, error);
	}
}
