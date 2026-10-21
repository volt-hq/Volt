/**
 * The daemon's sweep of a process tree on macOS and Linux (daemon-hosted conversations RFC §5.3, worker process
 * tree), against process tables a test writes: it relies on a sweep only when both reads of the process list
 * found the root running, so a root that died before its exit was observed (a zombie, its children reparented)
 * leads to the after-exit group kill. And the process table it reads: `/proc` on Linux, `ps` on macOS.
 */

import { describe, expect, it } from "vitest";
import { ProcessTreeHold, sweepProcessTree, type TreeSweepEnvironment } from "../src/daemon/process-tree.ts";
import {
	descendantsIn,
	type ProcessTable,
	parseProcStat,
	parsePsOutput,
	processTableFrom,
	readProcessTable,
	readProcessTableSync,
} from "../src/utils/process-table.ts";

const ROOT = 100;

/** A table of `[pid, ppid, state]` entries; the state is `S` unless given. */
function table(entries: ReadonlyArray<readonly [number, number, string?]>): ProcessTable {
	return processTableFrom(entries.map(([pid, ppid, state = "S"]) => ({ pid, ppid, state })));
}

/** An environment whose reads return `reads` in turn (the last one after that), and whose live processes are `alive`. */
function environment(
	reads: ReadonlyArray<ProcessTable | undefined>,
	alive: readonly number[] = [],
): { environment: TreeSweepEnvironment; signals: Array<[number, NodeJS.Signals]> } {
	const signals: Array<[number, NodeJS.Signals]> = [];
	let read = 0;
	return {
		signals,
		environment: {
			readProcessTable: async () => reads[Math.min(read++, reads.length - 1)],
			signal: (pid, signal) => signals.push([pid, signal]),
			isAlive: (pid) => alive.includes(pid),
			wait: async () => {},
		},
	};
}

const running = () => false;

describe("the daemon's sweep of a process tree", () => {
	it("stops the root, ends its descendants deepest first, then those still running and what they started", async () => {
		const first = table([
			[ROOT, 1, "T"],
			[101, ROOT],
			[102, 101],
			[103, ROOT],
		]);
		// 101 ignored SIGTERM and started 104 meanwhile; 102 and 103 ended.
		const second = table([
			[ROOT, 1, "T"],
			[101, ROOT],
			[104, 101],
		]);
		const { environment: env, signals } = environment([first, second], [101]);

		expect(await sweepProcessTree(ROOT, running, true, env)).toBe(true);
		expect(signals).toEqual([
			[ROOT, "SIGSTOP"],
			[102, "SIGTERM"],
			[103, "SIGTERM"],
			[101, "SIGTERM"],
			[101, "SIGKILL"],
			[104, "SIGKILL"],
		]);
	});

	it("also ends what a running root started meanwhile", async () => {
		const first = table([
			[ROOT, 1],
			[101, ROOT],
		]);
		const second = table([
			[ROOT, 1],
			[105, ROOT],
		]);
		const { environment: env, signals } = environment([first, second]);

		expect(await sweepProcessTree(ROOT, running, false, env)).toBe(true);
		expect(signals).toEqual([
			[101, "SIGTERM"],
			[105, "SIGKILL"],
		]);
	});

	it("relies on nothing and signals nothing when the root is a zombie at the first read", async () => {
		// The root died before its exit was observed: its child was reparented, out of the walk's reach.
		const { environment: env, signals } = environment([
			table([
				[ROOT, 1, "Z"],
				[101, 1],
			]),
		]);

		expect(await sweepProcessTree(ROOT, running, false, env)).toBe(false);
		expect(signals).toEqual([]);
	});

	it("treats a dead root (X) like a zombie", async () => {
		const { environment: env } = environment([table([[ROOT, 1, "X"]])]);
		expect(await sweepProcessTree(ROOT, running, false, env)).toBe(false);
	});

	it("does not rely on a sweep whose root died during it, though it ends what it found still running", async () => {
		const first = table([
			[ROOT, 1],
			[101, ROOT],
		]);
		const second = table([
			[ROOT, 1, "Z"],
			[101, 1],
		]);
		const { environment: env, signals } = environment([first, second], [101]);

		expect(await sweepProcessTree(ROOT, running, false, env)).toBe(false);
		expect(signals).toEqual([
			[101, "SIGTERM"],
			[101, "SIGKILL"],
		]);
	});

	it("signals nothing past the stop when the process table cannot be read", async () => {
		const { environment: env, signals } = environment([undefined]);
		expect(await sweepProcessTree(ROOT, running, true, env)).toBe(false);
		expect(signals).toEqual([[ROOT, "SIGSTOP"]]);
	});

	it("does not rely on a sweep whose second read failed, though it ends what it found still running", async () => {
		const first = table([
			[ROOT, 1],
			[101, ROOT],
		]);
		const { environment: env, signals } = environment([first, undefined], [101]);

		expect(await sweepProcessTree(ROOT, running, false, env)).toBe(false);
		expect(signals).toEqual([
			[101, "SIGTERM"],
			[101, "SIGKILL"],
		]);
	});

	it("signals nothing once the root's exit was observed: its id may be another process's", async () => {
		const { environment: env, signals } = environment([table([[ROOT, 1]])]);
		expect(await sweepProcessTree(ROOT, () => true, true, env)).toBe(false);
		expect(signals).toEqual([]);
	});
});

describe.runIf(process.platform !== "win32")("a held process's exit", () => {
	const intact = () =>
		table([
			[ROOT, 1],
			[101, ROOT],
		]);

	it("kills its process group after it died without a sweep the daemon could rely on", () => {
		const { environment: env, signals } = environment([]);
		new ProcessTreeHold(ROOT, running, env).exited();
		expect(signals).toEqual([[-ROOT, "SIGKILL"]]);
	});

	it("leaves its process group alone after the daemon ended its tree while it ran", async () => {
		const { environment: env, signals } = environment([intact()]);
		const hold = new ProcessTreeHold(ROOT, running, env);
		expect(await hold.endDescendants()).toBe(true);
		hold.exited();
		expect(signals).not.toContainEqual([-ROOT, "SIGKILL"]);
	});

	it("kills its process group after a forced stop that found it dead already", async () => {
		// Regression for the zombie window: a worker killed from outside as the forced stop begins.
		const { environment: env, signals } = environment([table([[ROOT, 1, "Z"]])]);
		const hold = new ProcessTreeHold(ROOT, running, env);
		await hold.end();
		hold.exited();
		expect(signals).toEqual([
			[ROOT, "SIGSTOP"],
			[ROOT, "SIGKILL"],
			[-ROOT, "SIGKILL"],
		]);
	});

	it("goes by the daemon's last sweep: a forced stop that fails undoes an earlier one it relied on", async () => {
		const { environment: env, signals } = environment([intact(), intact(), undefined]);
		const hold = new ProcessTreeHold(ROOT, running, env);
		expect(await hold.endDescendants()).toBe(true);
		await hold.end();
		hold.exited();
		expect(signals).toContainEqual([-ROOT, "SIGKILL"]);
	});

	it("is stopped, swept, then killed, once", async () => {
		const { environment: env, signals } = environment([intact()]);
		const hold = new ProcessTreeHold(ROOT, running, env);
		await Promise.all([hold.end(), hold.end()]);
		expect(signals.filter(([pid]) => pid === ROOT)).toEqual([
			[ROOT, "SIGSTOP"],
			[ROOT, "SIGKILL"],
		]);
	});
});

describe("the process table", () => {
	it("reads /proc/<pid>/stat, whose command may hold spaces and parentheses", () => {
		expect(parseProcStat("4242 (my (odd) name) S 17 4242 4242 0 -1 4194560\n")).toEqual({
			pid: 4242,
			ppid: 17,
			state: "S",
		});
		expect(parseProcStat("55 (sh) Z 54 55 55 0 -1")).toEqual({ pid: 55, ppid: 54, state: "Z" });
		expect(parseProcStat("garbage")).toBeUndefined();
		expect(parseProcStat("12 (sh)")).toBeUndefined();
	});

	it("reads `ps -Ao pid=,ppid=,stat=`, by the first letter of the state", () => {
		expect(parsePsOutput("    1     0 Ss\n   55    54 Z+\n  60 55 T\nnot a line\n\n")).toEqual([
			{ pid: 1, ppid: 0, state: "S" },
			{ pid: 55, ppid: 54, state: "Z" },
			{ pid: 60, ppid: 55, state: "T" },
		]);
	});

	it("counts a zombie or dead process as exited, and a stopped one as running", () => {
		const processes = table([
			[10, 1, "Z"],
			[11, 1, "X"],
			[12, 1, "T"],
			[13, 1, "R"],
		]);
		expect([10, 11, 12, 13, 14].map((pid) => processes.runs(pid))).toEqual([false, false, true, true, false]);
	});

	it("lists descendants deepest first, never a root, init, or one twice", () => {
		const processes = table([
			[10, 1],
			[11, 10],
			[12, 11],
			[13, 10],
			[20, 1],
			[21, 20],
			[1, 0],
		]);
		expect(descendantsIn(processes, [10])).toEqual([12, 13, 11]);
		expect(descendantsIn(processes, [10, 11])).toEqual([12, 13]);
		expect(descendantsIn(processes, [0])).toEqual([]);
	});

	it.runIf(process.platform !== "win32")("finds this process running, under its parent", async () => {
		for (const processes of [readProcessTableSync(), await readProcessTable()]) {
			if (!processes) throw new Error("No process table");
			expect(processes.runs(process.pid)).toBe(true);
			expect(processes.children.get(process.ppid)).toContain(process.pid);
		}
	});
});
