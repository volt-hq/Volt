import { resolve } from "node:path";
import { type FileLock, fileLockPath, tryAcquireFileLock } from "../file-lock.ts";

export type ConversationLockAcquisition =
	| { readonly status: "acquired"; readonly lock: ConversationLock }
	| { readonly status: "held" };

/**
 * Held native locks. A collected native lock releases its OS lock, so held
 * locks stay referenced here until `close()`, even if their holder drops them.
 */
const heldLocks = new Set<FileLock>();

/**
 * The per-log writer lock (RFC §4.1, daemon-hosted conversations RFC §5.2):
 * a host takes it before opening a persisted conversation log for writing, so
 * at most one process writes a log. It is an exclusive OS lock on
 * `<sessionDir>/locks/<sha256(sessionId)>.lock`, taken without waiting and
 * released only by `close()` or by the OS when the holder exits. Lock files
 * are never unlinked. A second acquisition is refused even within the holding
 * process.
 *
 * An OS lock gives no loss signal; a writer that is no longer the only one is
 * detected at commit time by the log's ordinal fence.
 *
 * Fails closed: where the workspace-fs native addon is unavailable,
 * `tryAcquire` throws `WorkspaceFsNativeUnavailableError` and no persisted log
 * can be opened for writing.
 */
export class ConversationLock {
	readonly path: string;
	private fileLock: FileLock | undefined;

	private constructor(path: string, fileLock: FileLock) {
		this.path = path;
		this.fileLock = fileLock;
	}

	static tryAcquire(sessionDirectory: string, sessionId: string): ConversationLockAcquisition {
		const directory = resolve(sessionDirectory, "locks");
		const fileLock = tryAcquireFileLock(directory, sessionId, false);
		if (!fileLock) return { status: "held" };
		heldLocks.add(fileLock);
		return { status: "acquired", lock: new ConversationLock(fileLockPath(directory, sessionId), fileLock) };
	}

	/** Release the lock; later calls do nothing. */
	close(): void {
		if (!this.fileLock) return;
		heldLocks.delete(this.fileLock);
		this.fileLock.close();
		this.fileLock = undefined;
	}
}
