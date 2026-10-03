import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type FileLock, tryAcquireFileLock } from "../core/file-lock.ts";

/**
 * Runtime holders take shared locks; removal takes an exclusive lock through its
 * final filesystem mutation. The lock files live outside disposable checkouts
 * and are NEVER unlinked: replacing the inode would split the lock authority.
 * No TTL, daemon connection, or in-memory registry determines lock ownership.
 */
export function tryAcquireWorktreeLock(agentDir: string, checkoutPath: string, shared: boolean): FileLock | undefined {
	// Resolve the parent rather than the checkout: the identity must remain the
	// same when an archived checkout is absent and across restoration/removal.
	let identity = join(realpathSync.native(dirname(checkoutPath)), basename(checkoutPath));
	if (process.platform === "win32") identity = identity.toLowerCase();
	return tryAcquireFileLock(resolve(agentDir, "worktree-locks"), identity, shared);
}
