import { resolve } from "node:path";
import { type FileLock, fileLockPath, tryAcquireFileLock } from "../file-lock.ts";

/** Who holds a conversation lock that could not be taken. */
export type ConversationLockHolder = "this_process" | "another_process";

export type ConversationLockAcquisition =
	| { readonly status: "acquired"; readonly lock: ConversationLock }
	| { readonly status: "held"; readonly holder: ConversationLockHolder };

/**
 * A persisted conversation is open for writing elsewhere: its per-log lock is
 * held by another host. `code` is the stable `conversation_locked` error code
 * that RPC responses and phone handshakes carry.
 */
export class ConversationLockedError extends Error {
	readonly code = "conversation_locked";
	readonly sessionId: string;
	readonly holder: ConversationLockHolder;

	constructor(sessionId: string, holder: ConversationLockHolder) {
		super(
			holder === "this_process"
				? `Session ${sessionId} is already open for writing in this Volt process.`
				: `Session ${sessionId} is open in another Volt process. Quit that session there (or switch it to another session), then retry. Listing, searching, and exporting it still work.`,
		);
		this.name = "ConversationLockedError";
		this.sessionId = sessionId;
		this.holder = holder;
	}
}

/**
 * Held native locks. A collected native lock releases its OS lock, so held
 * locks stay referenced here until `close()`, even if their holder drops them.
 */
const heldLocks = new Set<FileLock>();
/** Lock files held by this process; an exclusive lock file is held at most once. */
const heldPaths = new Set<string>();

/**
 * The per-log writer lock (RFC §4.1, daemon-hosted conversations RFC §5.2):
 * a host takes it before opening a persisted conversation log for writing, so
 * at most one process writes a log. It is an exclusive OS lock on
 * `<sessionDir>/locks/<sha256(sessionId)>.lock`, taken without waiting and
 * released only by `close()` or by the OS when the holder exits. Lock files
 * are never unlinked. A second acquisition is refused even within the holding
 * process.
 *
 * Acquisition never waits, so a host that holds one lock while taking another
 * (a session replacement takes its target's lock before releasing its
 * source's) cannot deadlock: a conflict fails at once with `held`.
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
		const path = fileLockPath(directory, sessionId);
		const fileLock = tryAcquireFileLock(directory, sessionId, false);
		if (!fileLock) return { status: "held", holder: heldPaths.has(path) ? "this_process" : "another_process" };
		heldLocks.add(fileLock);
		heldPaths.add(path);
		return { status: "acquired", lock: new ConversationLock(path, fileLock) };
	}

	/** Take the lock or throw {@link ConversationLockedError}. */
	static acquire(sessionDirectory: string, sessionId: string): ConversationLock {
		const acquisition = ConversationLock.tryAcquire(sessionDirectory, sessionId);
		if (acquisition.status === "held") throw new ConversationLockedError(sessionId, acquisition.holder);
		return acquisition.lock;
	}

	/** Release the lock; later calls do nothing. */
	close(): void {
		if (!this.fileLock) return;
		heldLocks.delete(this.fileLock);
		heldPaths.delete(this.path);
		this.fileLock.close();
		this.fileLock = undefined;
	}
}
