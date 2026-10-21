/**
 * The process tree of a process the daemon starts, a conversation worker or an extension inventory
 * (daemon-hosted conversations RFC §5.3, worker process tree). When it exits, every process still descended from
 * it ends, the same way on every platform; a process whose parent exited first has left the tree and keeps
 * running.
 *
 * Cleanup runs while the tree is intact. The process ends its own descendants on every exit it performs
 * (`endOwnDescendants`, `killOwnDescendants`, `exitOnUncaughtError`), and the daemon ends a process's
 * descendants before it ends the process (`ProcessTreeHold.end`). After a death neither performed (a kill from
 * outside, running out of memory, a native crash), the daemon ends what it can still find
 * (`ProcessTreeHold.endAfterDeath`): on macOS and Linux the process's group, on Windows its tree.
 *
 * macOS and Linux walk parent ids in the process table (`src/utils/shell.ts`); a live process's id is never
 * reused. Windows walks a process snapshot through the workspace-fs addon, which checks creation times so that
 * a reused id is never followed, and holds a process the daemon started (its id stays reserved) until the daemon
 * has handled its exit.
 */

import { loadWorkspaceFsNativeAddon, type NativeProcessTree } from "../core/workspace-fs/native-loader.ts";
import { killDescendants, terminateDescendants } from "../utils/shell.ts";

/** Hold process `pid` on Windows; undefined when it cannot be held (it is gone, or the addon is unavailable). */
function holdWindowsTree(pid: number): NativeProcessTree | undefined {
	try {
		return loadWorkspaceFsNativeAddon().openProcessTree(pid) ?? undefined;
	} catch {
		return undefined;
	}
}

/** End the processes descended from the held process, as far as a process snapshot finds them. */
function terminateWindowsDescendants(tree: NativeProcessTree | undefined): void {
	try {
		tree?.terminateDescendants();
	} catch {
		// No process snapshot: nothing more can be found.
	}
}

function terminateOwnWindowsDescendants(): void {
	const tree = holdWindowsTree(process.pid);
	try {
		terminateWindowsDescendants(tree);
	} finally {
		tree?.close();
	}
}

/**
 * End the processes still descended from this process, before it exits: SIGTERM, then SIGKILL to those still
 * running a moment later (Windows: at once).
 */
export async function endOwnDescendants(): Promise<void> {
	if (process.platform === "win32") terminateOwnWindowsDescendants();
	else await terminateDescendants(process.pid);
}

/** {@link endOwnDescendants} at once (SIGKILL), for exits that cannot wait. */
export function killOwnDescendants(): void {
	if (process.platform === "win32") terminateOwnWindowsDescendants();
	else killDescendants(process.pid);
}

/**
 * On an uncaught error (an unhandled rejection included), log it, end this process's descendants, and exit with
 * `code`: an exit the process performs, which the daemon then does not clean up after.
 */
export function exitOnUncaughtError(label: string, code: number): void {
	process.on("uncaughtException", (error: unknown) => {
		const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
		console.error(`${new Date().toISOString()} ${label}: uncaught error; exiting\n${detail}`);
		killOwnDescendants();
		process.exit(code);
	});
}

/**
 * A process the daemon started, held from its spawn until its exit is handled, so that its tree can be ended
 * while it runs and after it died. On Windows the hold keeps its id from being reused, so that its tree can still
 * be walked after it exited.
 */
export class ProcessTreeHold {
	readonly pid: number;
	private readonly isExited: () => boolean;
	private windowsTree: NativeProcessTree | undefined;
	private endRequested = false;

	/** Hold process `pid`, a child of this one; `isExited` tells whether it has exited (and its id was released). */
	constructor(pid: number, isExited: () => boolean) {
		this.pid = pid;
		this.isExited = isExited;
		if (process.platform === "win32") this.windowsTree = holdWindowsTree(pid);
	}

	/** Whether {@link end} was called: the daemon ended the tree, so the death that follows needs no cleanup. */
	get ended(): boolean {
		return this.endRequested;
	}

	/**
	 * End the process's descendants, then the process: SIGTERM, then SIGKILL to those still running a moment later
	 * (Windows: at once). Does nothing once called.
	 */
	async end(): Promise<void> {
		if (this.endRequested) return;
		this.endRequested = true;
		if (process.platform !== "win32") {
			await terminateDescendants(this.pid, { includeRoot: true, isRootExited: this.isExited });
			return;
		}
		terminateWindowsDescendants(this.windowsTree);
		if (this.isExited()) return;
		try {
			process.kill(this.pid, "SIGKILL");
		} catch {
			// It exited meanwhile.
		}
	}

	/**
	 * After the process died without ending its tree, and was not ended by {@link end}: end what can still be
	 * found. On macOS and Linux that is the process group it leads (it was started detached), which also holds
	 * orphans of its plain children and misses its detached descendants; a group's id is not reused while any of
	 * it runs. On Windows it is the process's tree, walked from the held process.
	 */
	endAfterDeath(): void {
		if (process.platform === "win32") {
			terminateWindowsDescendants(this.windowsTree);
			return;
		}
		try {
			process.kill(-this.pid, "SIGKILL");
		} catch {
			// Nothing of it is left.
		}
	}

	/** Release the process once its exit is handled: on Windows its id may then be reused. */
	release(): void {
		this.windowsTree?.close();
		this.windowsTree = undefined;
	}
}
