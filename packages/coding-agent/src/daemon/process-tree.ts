/**
 * The process tree of a process the daemon starts, a conversation worker or an extension inventory
 * (daemon-hosted conversations RFC §5.3, worker process tree). When it exits, every process still descended from
 * it ends; a process whose parent exited first has left the tree and keeps running, the same way on every
 * platform, through every exit the daemon carries out or confirms.
 *
 * The daemon ends the tree itself, while the process runs, and relies only on what it saw. A worker that is about
 * to exit asks it to (`worker_exit`, `ProcessTreeHold.endDescendants`); a forced stop and an inventory's stop end
 * the tree, then the process (`ProcessTreeHold.end`). A sweep counts only when the daemon read the process list
 * and found the process running throughout. After any other exit (an extension's `process.exit`, a crash, a kill
 * from outside, a sweep that failed) the daemon ends what it can still find (`ProcessTreeHold.exited`): on macOS
 * and Linux the process's group, which also holds orphans of its plain children and misses its detached
 * descendants; on Windows its tree, walked from the held process, as every time it exits. The process also ends
 * its own descendants on the exits it performs (`endOwnDescendants`, `killOwnDescendants`,
 * `exitOnUncaughtError`): those are actions, never claims the daemon trusts.
 *
 * macOS and Linux walk parent ids in the process table (`src/utils/process-table.ts`); a live process's id is
 * never reused, and an exited one that is not reaped yet (a zombie) has lost its children to reparenting.
 * Windows walks a process snapshot through the workspace-fs addon, which checks creation times and a second
 * snapshot so that a reused id is never followed, and holds a process the daemon started (its id stays reserved)
 * until the daemon has handled its exit.
 */

import { loadWorkspaceFsNativeAddon, type NativeProcessTree } from "../core/workspace-fs/native-loader.ts";
import { descendantsIn, type ProcessTable, readProcessTable } from "../utils/process-table.ts";
import { killDescendants, terminateDescendants } from "../utils/shell.ts";

/** Grace period between SIGTERM and SIGKILL when the daemon ends a tree. */
const SIGKILL_ESCALATION_MS = 200;

/** Hold process `pid` on Windows; undefined when it cannot be held (it is gone, or the addon is unavailable). */
function holdWindowsTree(pid: number): NativeProcessTree | undefined {
	try {
		return loadWorkspaceFsNativeAddon().openProcessTree(pid) ?? undefined;
	} catch {
		return undefined;
	}
}

/** End the processes descended from the held process, as far as a process snapshot finds them; whether one did. */
function terminateWindowsDescendants(tree: NativeProcessTree | undefined): boolean {
	if (!tree) return false;
	try {
		tree.terminateDescendants();
		return true;
	} catch {
		// No process snapshot: nothing could be found.
		return false;
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
 * code 1. The daemon confirmed no sweep, so it ends what it can still find after the exit.
 */
export function exitOnUncaughtError(label: string): void {
	process.on("uncaughtException", (error: unknown) => {
		const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
		console.error(`${new Date().toISOString()} ${label}: uncaught error; exiting\n${detail}`);
		killOwnDescendants();
		process.exit(1);
	});
}

/** What the daemon's sweep of a tree on macOS and Linux uses; a test substitutes its own. */
export interface TreeSweepEnvironment {
	/** A read of the process table; undefined when it cannot be read. */
	readProcessTable(): Promise<ProcessTable | undefined>;
	/** Signal process `pid` (a negative one: a process group), tolerating one that is gone. */
	signal(pid: number, signal: NodeJS.Signals): void;
	/** Whether process `pid` is still there (a zombie is). */
	isAlive(pid: number): boolean;
	wait(ms: number): Promise<void>;
}

const systemEnvironment: TreeSweepEnvironment = {
	readProcessTable,
	signal: (pid, signal) => {
		// -1 would signal every process the user can reach; 0, the daemon's own group; 1 is init.
		if (!Number.isInteger(pid) || Math.abs(pid) <= 1) return;
		try {
			process.kill(pid, signal);
		} catch {
			// Gone already.
		}
	},
	isAlive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	},
	wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * End the processes descended from the running process `root`, on macOS and Linux: SIGTERM to those a read of the
 * process table finds, then, 200 ms later, SIGKILL to those still running and to whatever they and `root` started
 * meanwhile. Nothing is signalled through a process group, so a process that left the tree keeps running. With
 * `freeze`, `root` is stopped first (SIGSTOP), so that it starts nothing while its tree is ended; the caller then
 * kills it.
 *
 * Resolves whether the sweep can be relied on: both reads succeeded and found `root` running, and
 * `isRootExited` (whether its exit was observed, after which its id may be reused) stayed false. A root that died
 * meanwhile, or had died already (a zombie, its exit not yet observed), had its children reparented out of the
 * walk's reach. Without a first read, nothing is signalled.
 */
export async function sweepProcessTree(
	root: number,
	isRootExited: () => boolean,
	freeze: boolean,
	environment: TreeSweepEnvironment = systemEnvironment,
): Promise<boolean> {
	if (isRootExited()) return false;
	if (freeze) environment.signal(root, "SIGSTOP");
	const first = await environment.readProcessTable();
	if (first === undefined || isRootExited() || !first.runs(root)) return false;
	const descendants = descendantsIn(first, [root]);
	for (const pid of descendants) environment.signal(pid, "SIGTERM");
	await environment.wait(SIGKILL_ESCALATION_MS);
	const remaining = new Set(descendants.filter((pid) => environment.isAlive(pid)));
	const second = await environment.readProcessTable();
	const rootRuns = second !== undefined && !isRootExited() && second.runs(root);
	if (second) {
		for (const pid of descendantsIn(second, rootRuns ? [root, ...remaining] : [...remaining])) remaining.add(pid);
	}
	for (const pid of remaining) environment.signal(pid, "SIGKILL");
	return rootRuns;
}

/**
 * A process the daemon started, held from its spawn until its exit is handled, so that its tree can be ended
 * while it runs and after it died. On Windows the hold keeps its id from being reused, so that its tree can still
 * be walked after it exited.
 */
export class ProcessTreeHold {
	readonly pid: number;
	private readonly isExited: () => boolean;
	private readonly environment: TreeSweepEnvironment;
	private windowsTree: NativeProcessTree | undefined;
	/** The daemon's last sweep of the running process's tree can be relied on: its exit needs no group kill. */
	private swept = false;
	private ending: Promise<void> | undefined;

	/**
	 * Hold process `pid`, a child of this one, started detached (it leads its process group). `isExited` tells
	 * whether its exit was observed (its id may be reused after it).
	 */
	constructor(pid: number, isExited: () => boolean, environment: TreeSweepEnvironment = systemEnvironment) {
		this.pid = pid;
		this.isExited = isExited;
		this.environment = environment;
		if (process.platform === "win32") this.windowsTree = holdWindowsTree(pid);
	}

	/**
	 * End the process's descendants while it keeps running, as it asks before it exits (`worker_exit`): SIGTERM,
	 * then SIGKILL 200 ms later (Windows: at once). Resolves whether that can be relied on: the process list was
	 * read, and found the process running throughout.
	 */
	async endDescendants(): Promise<boolean> {
		this.swept =
			process.platform === "win32"
				? terminateWindowsDescendants(this.windowsTree)
				: await sweepProcessTree(this.pid, this.isExited, false, this.environment);
		return this.swept;
	}

	/**
	 * End the process and its descendants (a forced stop that timed out, an inventory's stop). On macOS and Linux
	 * the process is stopped (SIGSTOP), so that it starts nothing meanwhile, its descendants are ended as
	 * {@link endDescendants} ends them, and the process is killed. On Windows the process is terminated first and
	 * its exit ends its descendants ({@link exited}): the hold keeps its id, so its tree is still walked. Does
	 * nothing once called.
	 */
	end(): Promise<void> {
		this.ending ??= (async () => {
			if (process.platform !== "win32") {
				this.swept = await sweepProcessTree(this.pid, this.isExited, true, this.environment);
			}
			// Its id is its own until its exit is observed: Node reaps it then, and on Windows the hold keeps it.
			if (!this.isExited()) this.environment.signal(this.pid, "SIGKILL");
		})();
		return this.ending;
	}

	/**
	 * The process exited: end what can still be found of its tree, then release the process (on Windows its id
	 * may then be reused). On Windows that is every time: the dead process's tree, walked from the hold as while it
	 * ran. On macOS and Linux it is only when no sweep the daemon could rely on ended the tree while the process
	 * ran: the process group it leads, which also holds orphans of its plain children (they left the tree) and
	 * misses its detached descendants; a group's id is not reused while any of it runs.
	 */
	exited(): void {
		if (process.platform === "win32") terminateWindowsDescendants(this.windowsTree);
		else if (!this.swept) this.environment.signal(-this.pid, "SIGKILL");
		this.windowsTree?.close();
		this.windowsTree = undefined;
	}
}
