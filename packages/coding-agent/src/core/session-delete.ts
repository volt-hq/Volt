/**
 * Deleting a stored session keeps a recovery snapshot: the session is
 * exported as JSONL into `deleted-session-snapshots` under its session
 * directory, the snapshot goes to the system trash when a `trash` command
 * takes it, and the session is deleted as of the snapshot's last entry.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensurePrivateDirectorySync } from "../utils/private-files.ts";
import { SessionManager, type SessionReference } from "./session-manager.ts";

/** Delete the stored session `ref` after snapshotting it: whether it was deleted, and whether its snapshot went to the trash. */
export async function deleteStoredSession(ref: SessionReference): Promise<{ deleted: boolean; trashed: boolean }> {
	const recoveryDirectory = join(ref.sessionDirectory, "deleted-session-snapshots");
	ensurePrivateDirectorySync(recoveryDirectory);
	const snapshotPath = join(recoveryDirectory, `volt-session-${ref.sessionId}-${randomUUID()}.jsonl`);
	const snapshot = await SessionManager.exportJsonlSnapshot(ref, snapshotPath);
	const trash = spawnSync("trash", snapshotPath.startsWith("-") ? ["--", snapshotPath] : [snapshotPath], {
		encoding: "utf8",
	});
	const deleted = await SessionManager.delete(ref, snapshot.lastOrdinal);
	return { deleted, trashed: trash.status === 0 };
}
