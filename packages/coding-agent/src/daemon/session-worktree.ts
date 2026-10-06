import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { VERSION } from "../config.ts";
import type { SessionManager, SessionReference } from "../core/session-manager.ts";
import type { NativeFileLock } from "../core/workspace-fs/native-loader.ts";
import { createDaemonClient } from "./control-client.ts";
import { ensureDaemonRunning } from "./spawn.ts";
import { tryAcquireWorktreeLock } from "./worktree-lock.ts";
import { getWorktreesRoot, isPathUnderWorktreesRoot } from "./worktree-manager.ts";

export class LocalSessionWorktreeRestoreError extends Error {
	constructor(cwd: string, cause: unknown) {
		super(
			`Cannot restore the session's managed worktree at ${cwd}: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "LocalSessionWorktreeRestoreError";
	}
}

/**
 * A conversation worker's route to its daemon for managed checkouts, over its
 * own control connection: the daemon restores the archived checkout of a
 * session of the worker's workspace and pins it until the release runs.
 */
export interface SessionWorktreeDaemon {
	restore(sessionRef: SessionReference, cwd: string): Promise<() => Promise<void>>;
}

interface LocalWorktreeOwnership {
	lock: NativeFileLock;
	/** Release the daemon's pin, when the daemon restored the checkout. */
	release?: () => Promise<void>;
	owners: Set<SessionManager>;
}

// Ownership follows the manager from CLI preparation into the runtime. Same-cwd
// replacements retain it before disposing the old session, without a protection gap.
const localWorktrees = new WeakMap<SessionManager, LocalWorktreeOwnership>();

/** This process is a conversation worker: it reaches its daemon only over its own connection. */
let conversationWorkerProcess = false;

/**
 * Mark this process as a conversation worker. A managed checkout opened
 * without the worker's route then fails instead of reaching for a daemon
 * (which, its own daemon gone, would start another from inside the worker).
 */
export function markConversationWorkerProcess(): void {
	conversationWorkerProcess = true;
}

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
	if (ownership.owners.size === 0) {
		try {
			await ownership.release?.();
		} finally {
			ownership.lock.close();
		}
	}
}

export async function closeLocalSessionManager(manager: SessionManager): Promise<void> {
	try {
		await manager.closePersistence();
	} finally {
		await releaseLocalSessionWorktree(manager);
	}
}

/**
 * Restore through the daemon, then retain process-owned protection through
 * teardown. A conversation worker passes its own route to its daemon
 * (`daemon`): it asks only for a checkout that is not there.
 */
export async function restoreLocalSessionWorktree(
	sessionManager: SessionManager,
	agentDir: string,
	daemon?: SessionWorktreeDaemon,
): Promise<void> {
	const cwd = sessionManager.getCwd();
	const sessionRef = sessionManager.getSessionRef();
	if (!isPathUnderWorktreesRoot(agentDir, cwd) || localWorktrees.has(sessionManager)) return;

	try {
		const root = getWorktreesRoot(agentDir);
		const segments = relative(root, cwd).split(sep);
		if (segments.length < 2) throw new Error("The session cwd is not inside a managed checkout");
		const checkoutPath = join(root, segments[0], segments[1]);
		const retain = (release?: () => Promise<void>) => {
			const lock = tryAcquireWorktreeLock(agentDir, checkoutPath, true);
			if (!lock) throw new Error("Managed checkout is being reclaimed; retry the session.");
			if (!existsSync(cwd)) {
				lock.close();
				throw new Error("The session's managed checkout is unavailable; retry the session.");
			}
			localWorktrees.set(sessionManager, { lock, release, owners: new Set([sessionManager]) });
		};
		// Ephemeral sessions cannot request durable restoration, but must still
		// hold checkout protection before running in an existing managed cwd.
		if (!sessionRef) {
			retain();
			return;
		}
		if (daemon) {
			// The daemon prepared the checkout of the conversation the worker opened for, and the
			// worker's hosting protects it: only an archived checkout needs the daemon.
			if (existsSync(cwd)) {
				retain();
				return;
			}
			const release = await daemon.restore(sessionRef, cwd);
			try {
				retain(release);
			} catch (error) {
				await release().catch(() => undefined);
				throw error;
			}
			return;
		}
		if (conversationWorkerProcess) {
			throw new Error("A conversation worker restores a managed checkout only through its daemon connection");
		}
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
				sessionRef,
			});
			if (response.type !== "ok") {
				throw new Error(response.type === "error" ? response.message : "unexpected daemon response");
			}
			// The connection reservation bridges restoration into process-owned
			// protection. If disconnect raced reclamation, exclusive ownership or
			// the missing cwd rejects startup instead of publishing an unsafe runtime.
			retain(() => client.close());
		} catch (error) {
			await client.close();
			throw error;
		}
	} catch (error) {
		throw new LocalSessionWorktreeRestoreError(cwd, error);
	}
}
