import { createHash } from "node:crypto";
import { join } from "node:path";
import { ensurePrivateDirectorySync } from "../utils/private-files.ts";
import { loadWorkspaceFsNativeAddon, type NativeFileLock } from "./workspace-fs/native-loader.ts";

/**
 * A process-owned OS lock: `flock` on Unix, `LockFileEx` on Windows, taken
 * through the workspace-fs native addon. Independent acquisitions use
 * independent handles, so a second acquisition in the same process conflicts
 * like one in another process. `close()` releases it; the OS releases it when
 * the holder exits.
 */
export type FileLock = NativeFileLock;

/** The lock file for `identity` in `directory`: `<directory>/<sha256(identity)>.lock`. */
export function fileLockPath(directory: string, identity: string): string {
	return join(directory, `${createHash("sha256").update(identity).digest("hex")}.lock`);
}

/**
 * Take the lock for `identity` without waiting; `undefined` when another holder
 * conflicts. Shared holders coexist; an exclusive holder excludes every other.
 *
 * `directory` must be absolute and private to the user. Lock files are NEVER
 * unlinked: replacing the inode would split the lock authority. Throws
 * `WorkspaceFsNativeUnavailableError` where the native addon is unavailable;
 * there is no JavaScript fallback, so callers fail closed.
 */
export function tryAcquireFileLock(directory: string, identity: string, shared: boolean): FileLock | undefined {
	ensurePrivateDirectorySync(directory);
	return loadWorkspaceFsNativeAddon().tryAcquireFileLock(fileLockPath(directory, identity), shared) ?? undefined;
}
