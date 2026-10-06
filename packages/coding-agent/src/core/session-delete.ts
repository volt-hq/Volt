/**
 * Deleting a stored session keeps a recovery snapshot: the session is
 * exported as JSONL into `deleted-session-snapshots` under its session
 * directory, the snapshot goes to the system trash when a `trash` command
 * takes it, and the session is deleted as of the snapshot's last entry.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ensurePrivateDirectorySync } from "../utils/private-files.ts";
import { SessionManager, type SessionReference } from "./session-manager.ts";

/** How long a `trash` command may take before the snapshot stays where it is. */
const TRASH_TIMEOUT_MS = 10_000;

/** Whether a `trash` command moved `path` to the system trash. */
function moveToTrash(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn("trash", path.startsWith("-") ? ["--", path] : [path], { stdio: "ignore" });
		} catch {
			resolve(false);
			return;
		}
		const timer = setTimeout(() => child.kill("SIGKILL"), TRASH_TIMEOUT_MS);
		timer.unref?.();
		child.once("error", () => {
			clearTimeout(timer);
			resolve(false);
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code === 0);
		});
	});
}

/** Delete the stored session `ref` after snapshotting it: whether it was deleted, and whether its snapshot went to the trash. */
export async function deleteStoredSession(ref: SessionReference): Promise<{ deleted: boolean; trashed: boolean }> {
	const recoveryDirectory = join(ref.sessionDirectory, "deleted-session-snapshots");
	ensurePrivateDirectorySync(recoveryDirectory);
	const snapshotPath = join(recoveryDirectory, `volt-session-${ref.sessionId}-${randomUUID()}.jsonl`);
	const snapshot = await SessionManager.exportJsonlSnapshot(ref, snapshotPath);
	const trashed = await moveToTrash(snapshotPath);
	const deleted = await SessionManager.delete(ref, snapshot.lastOrdinal);
	return { deleted, trashed };
}
