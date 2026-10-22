/**
 * The process table on macOS and Linux, read in one pass: each process's parent and whether it still runs. Linux
 * reads `/proc` directly; macOS runs `ps`. A read that fails (no `/proc`, no `ps`, or `ps` past its timeout) gives
 * no table, never a partial one. Windows walks its process table through the workspace-fs addon
 * (`src/daemon/process-tree.ts`).
 */

import { execFile, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

/** Cap on a `ps` read, so that it cannot stall a shutdown path. */
const PS_TIMEOUT_MS = 1000;
const PS_MAX_BUFFER = 8 * 1024 * 1024;
const PS_ARGS = ["-Ao", "pid=,ppid=,stat="];
/** Process states that mean exited, though still listed: a zombie (not reaped yet), and dead. */
const EXITED_STATES = new Set(["Z", "X", "x"]);

/** One process in the table. */
export interface ProcessEntry {
	readonly pid: number;
	readonly ppid: number;
	/** Its state's letter: `R`, `S`, `T`, `Z` (exited, not reaped yet), ... */
	readonly state: string;
}

/** A read of the process table. */
export interface ProcessTable {
	/** Each listed process's children, by parent id. */
	readonly children: ReadonlyMap<number, readonly number[]>;
	/** Whether `pid` is listed and has not exited: a zombie has, and so have its children left it. */
	runs(pid: number): boolean;
}

/** The table of `entries`. */
export function processTableFrom(entries: Iterable<ProcessEntry>): ProcessTable {
	const children = new Map<number, number[]>();
	const running = new Set<number>();
	for (const { pid, ppid, state } of entries) {
		if (!EXITED_STATES.has(state)) running.add(pid);
		const siblings = children.get(ppid);
		if (siblings) siblings.push(pid);
		else children.set(ppid, [pid]);
	}
	return { children, runs: (pid) => running.has(pid) };
}

/**
 * The processes descended from `roots` in `table`, deepest first, so that a parent cannot replace a child that
 * was just ended. Never a root; each process once.
 */
export function descendantsIn(table: ProcessTable, roots: readonly number[]): number[] {
	const seen = new Set<number>(roots);
	const found: number[] = [];
	const queue = [...roots];
	for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
		for (const child of table.children.get(next) ?? []) {
			if (child <= 1 || seen.has(child)) continue;
			seen.add(child);
			found.push(child);
			queue.push(child);
		}
	}
	return found.reverse();
}

/** The entry of `/proc/<pid>/stat`: `pid (comm) state ppid ...`, where `comm` may hold spaces and parentheses. */
export function parseProcStat(text: string): ProcessEntry | undefined {
	const open = text.indexOf(" (");
	const close = text.lastIndexOf(")");
	if (open === -1 || close < open) return undefined;
	const pid = Number(text.slice(0, open));
	const [state, ppidText] = text
		.slice(close + 1)
		.trim()
		.split(" ", 2);
	const ppid = Number(ppidText);
	if (!Number.isInteger(pid) || !Number.isInteger(ppid) || state === undefined || state.length !== 1) return undefined;
	return { pid, ppid, state };
}

/** The entries of `ps -Ao pid=,ppid=,stat=` output; its state is the first letter of `stat`. */
export function parsePsOutput(text: string): ProcessEntry[] {
	const entries: ProcessEntry[] = [];
	for (const line of text.split("\n")) {
		const [pidText, ppidText, stat] = line.trim().split(/\s+/);
		const pid = Number(pidText);
		const ppid = Number(ppidText);
		if (!pidText || !ppidText || !Number.isInteger(pid) || !Number.isInteger(ppid) || !stat) continue;
		entries.push({ pid, ppid, state: stat.charAt(0) });
	}
	return entries;
}

function isProcessId(name: string): boolean {
	return /^\d+$/.test(name);
}

/** The process table now, read synchronously (signal handlers cannot wait); undefined when it cannot be read. */
export function readProcessTableSync(): ProcessTable | undefined {
	if (process.platform === "win32") return undefined;
	if (process.platform === "linux") {
		let names: string[];
		try {
			names = readdirSync("/proc");
		} catch {
			return undefined;
		}
		const entries: ProcessEntry[] = [];
		for (const name of names) {
			if (!isProcessId(name)) continue;
			try {
				const entry = parseProcStat(readFileSync(`/proc/${name}/stat`, "utf8"));
				if (entry) entries.push(entry);
			} catch {
				// It exited meanwhile.
			}
		}
		return processTableFrom(entries);
	}
	const result = spawnSync("ps", PS_ARGS, { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER });
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") return undefined;
	return processTableFrom(parsePsOutput(result.stdout));
}

/** The process table now, without blocking the event loop; undefined when it cannot be read. */
export async function readProcessTable(): Promise<ProcessTable | undefined> {
	if (process.platform === "win32") return undefined;
	if (process.platform === "linux") {
		let names: string[];
		try {
			names = await readdir("/proc");
		} catch {
			return undefined;
		}
		const entries = await Promise.all(
			names.filter(isProcessId).map((name) =>
				readFile(`/proc/${name}/stat`, "utf8").then(
					(text) => parseProcStat(text),
					// It exited meanwhile.
					() => undefined,
				),
			),
		);
		return processTableFrom(entries.filter((entry) => entry !== undefined));
	}
	return new Promise((resolve) => {
		execFile("ps", PS_ARGS, { encoding: "utf8", timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER }, (error, stdout) =>
			resolve(error ? undefined : processTableFrom(parsePsOutput(stdout))),
		);
	});
}
