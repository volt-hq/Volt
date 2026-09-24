import type { Stats } from "node:fs";
import { hardenPrivateRegularFileSync } from "../../utils/private-files.ts";

/**
 * Keep the store database and its WAL sidecars owner-only, rejecting symlinks
 * and hard links. The database must exist; SQLite removes the sidecars when the
 * last connection closes, so they are optional.
 *
 * This must stay path-based. SQLite's WAL and shared-memory locks are POSIX
 * record locks, and closing *any* descriptor for a file releases every lock
 * this process holds on it. Opening a sidecar here would silently drop a live
 * connection's locks, and the next process to open the store would treat it
 * as abandoned and reinitialize `-shm` underneath it (SIGBUS or torn reads).
 *
 * Returns the validated database identity for post-open identity checks.
 */
export function hardenSessionStoreFiles(databasePath: string): Stats {
	const databaseStat = hardenPrivateRegularFileSync(databasePath);
	for (const path of [`${databasePath}-wal`, `${databasePath}-shm`]) {
		try {
			hardenPrivateRegularFileSync(path);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
	}
	return databaseStat;
}
