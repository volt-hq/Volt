/**
 * An extension inventory as a process of its own (`volt daemon extension-inventory`, started from this
 * checkout's source by `ProcessWorkerLauncher`): it loads the root's extensions, writes its result on fd 3
 * whatever the extensions print, keeps a private log beside the workers', and however an evaluation ends (with
 * a result, stopped, or by exiting on its own) ends the processes its extensions started, except one that left
 * its tree.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionInventoryProbeOutputSchema } from "../src/daemon/extension-inventory.ts";
import { getWorkerLogDirectory } from "../src/daemon/paths.ts";
import { CRASH_EXIT_CODE, ProcessWorkerLauncher } from "../src/daemon/worker-launcher.ts";
import { type SleeperStart, spawnerExtension, writeSleeper } from "./utilities/process-tree.ts";

/** The process starts from source here: compiling it can take a while on a cold cache. */
const PROCESS_TEST_TIMEOUT_MS = 180_000;

const tempDirs: string[] = [];
/** Processes the tests' extensions started; killed after each test in case the inventory left them running. */
const extensionPids: number[] = [];

afterEach(() => {
	for (const pid of extensionPids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Ended already.
		}
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A temporary workspace whose one project extension, `spawner`, has `source` as its module. */
function spawnerWorkspace(source: (tempDir: string) => string): { tempDir: string; root: string; agentDir: string } {
	const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-extension-inventory-process-")));
	tempDirs.push(tempDir);
	const root = join(tempDir, "workspace");
	const agentDir = join(tempDir, "agent");
	mkdirSync(join(root, ".volt", "extensions"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(root, ".volt", "extensions", "spawner.ts"), source(tempDir));
	return { tempDir, root, agentDir };
}

/** A shell command that writes its shell's pid to `pidFile`, then becomes `sleep 60` (the same pid). */
function sleeper(pidFile: string): string {
	return `echo $$ > '${pidFile}'; exec sleep 60`;
}

/**
 * The start of the `spawner` module: its manifest, `spawn`, `startedPid(path)` (whether a shell has written its
 * whole pid to `path`), and `until(done)`, which polls `done` until it holds.
 */
const STARTED_PID_SOURCE = `import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
export const manifest = { id: "spawner", displayName: "Spawner" };
const startedPid = (path) => {
	try {
		return /^\\d+$/.test(readFileSync(path, "utf8").trim());
	} catch {
		return false;
	}
};
const until = async (done) => {
	while (!done()) await new Promise((resolve) => setTimeout(resolve, 20));
};
`;

async function waitForPid(pidFile: string): Promise<number> {
	await vi.waitFor(() => expect(readFileSync(pidFile, "utf8").trim()).toMatch(/^\d+$/), {
		timeout: PROCESS_TEST_TIMEOUT_MS - 20_000,
		interval: 100,
	});
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	extensionPids.push(pid);
	return pid;
}

/**
 * A workspace whose extension `spawner` starts Node sleepers (`test/utilities/process-tree.ts`): `plain` with its
 * child `grandchild`, `detached`, and `orphan`, whose parent exits at once so that it has left the inventory's
 * tree (on macOS and Linux it stays in the inventory's process group). Once they all run, the factory runs
 * `then`.
 */
function sleeperWorkspace(then = ""): { root: string; agentDir: string; pidFile: (name: string) => string } {
	const workspace = spawnerWorkspace((dir) => {
		const pidFile = (name: string) => join(dir, `${name}.pid`);
		const starts: SleeperStart[] = [
			{ args: [pidFile("plain"), "child", pidFile("grandchild")] },
			{ args: [pidFile("detached")], detached: true },
			{ args: [pidFile("launcher"), "orphan", pidFile("orphan")] },
		];
		const names = ["plain", "grandchild", "detached", "orphan"];
		return spawnerExtension(writeSleeper(dir), starts, names.map(pidFile), then);
	});
	return { ...workspace, pidFile: (name) => join(workspace.tempDir, `${name}.pid`) };
}

async function expectEnded(pids: readonly number[]): Promise<void> {
	await vi.waitFor(
		() => {
			for (const pid of pids) expect(processIsAlive(pid), `process ${pid}`).toBe(false);
		},
		{ timeout: 5_000, interval: 100 },
	);
}

describe("extension inventory processes", () => {
	it(
		"evaluates the root's extensions in a process of its own and returns them on fd 3",
		async () => {
			const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-extension-inventory-process-")));
			tempDirs.push(tempDir);
			const root = join(tempDir, "workspace");
			const agentDir = join(tempDir, "agent");
			mkdirSync(join(root, ".volt", "extensions"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(
				join(root, ".volt", "extensions", "noisy.ts"),
				`export const manifest = { id: "noisy", displayName: "Noisy" };
export default function (volt) {
	// What an extension prints goes to the log, never into the result.
	console.log("{\\"ok\\":false,\\"error\\":\\"spoofed\\"}");
	volt.registerReviewEngine("quick", { label: "Quick", description: "Fast.", targets: ["pr"], remoteSafe: true, async run() {} });
}
`,
			);

			const launched = new ProcessWorkerLauncher().launchExtensionInventory({
				id: "test-1",
				agentDir,
				root,
				projectTrusted: true,
			});
			const output = await launched.result;

			expect(Compile(ExtensionInventoryProbeOutputSchema).Check(output)).toBe(true);
			expect(output).toMatchObject({
				ok: true,
				projectTrusted: true,
				extensions: [{ id: "noisy", state: "active", scope: "project" }],
				reviewEngines: [{ id: "ext:noisy/quick", label: "Quick", targets: ["pr"], remoteSafe: true }],
			});

			const logPath = join(getWorkerLogDirectory(agentDir), "inventory-test-1.log");
			expect(existsSync(logPath)).toBe(true);
			if (process.platform !== "win32") expect(statSync(logPath).mode & 0o777).toBe(0o600);
			expect(readFileSync(logPath, "utf8")).toContain("spoofed");
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"rejects when killed before it writes a result",
		async () => {
			const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-extension-inventory-process-")));
			tempDirs.push(tempDir);
			const agentDir = join(tempDir, "agent");
			mkdirSync(agentDir, { recursive: true });
			const launched = new ProcessWorkerLauncher().launchExtensionInventory({
				id: "test-2",
				agentDir,
				root: tempDir,
				projectTrusted: false,
			});
			launched.kill();
			await expect(launched.result).rejects.toThrow(/wrote no result/);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform === "win32")(
		"ends a detached shell an extension started when it is stopped",
		async () => {
			const tempDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-extension-inventory-process-")));
			tempDirs.push(tempDir);
			const root = join(tempDir, "workspace");
			const agentDir = join(tempDir, "agent");
			const pidFile = join(tempDir, "shell.pid");
			mkdirSync(join(root, ".volt", "extensions"), { recursive: true });
			mkdirSync(agentDir, { recursive: true });
			// The shell runs in a process group of its own (a detached child the process tracks) and outlives a
			// group kill; the factory never returns, so the evaluation is stopped while it runs.
			writeFileSync(
				join(root, ".volt", "extensions", "spawner.ts"),
				`import { createLocalBashOperations } from "@hansjm10/volt-coding-agent";
export const manifest = { id: "spawner", displayName: "Spawner" };
export default async function () {
	void createLocalBashOperations().exec(${JSON.stringify(`echo $$ > '${pidFile}'; exec sleep 60`)}, ${JSON.stringify(root)}, {
		onData: () => {},
	});
	await new Promise(() => {});
}
`,
			);

			const launched = new ProcessWorkerLauncher().launchExtensionInventory({
				id: "test-3",
				agentDir,
				root,
				projectTrusted: true,
			});
			launched.result.catch(() => undefined);
			await vi.waitFor(() => expect(readFileSync(pidFile, "utf8").trim()).toMatch(/^\d+$/), {
				timeout: PROCESS_TEST_TIMEOUT_MS - 20_000,
				interval: 100,
			});
			const shellPid = Number(readFileSync(pidFile, "utf8").trim());
			expect(processIsAlive(shellPid)).toBe(true);

			launched.kill();
			await expect(launched.result).rejects.toThrow(/wrote no result/);
			await vi.waitFor(() => expect(processIsAlive(shellPid)).toBe(false), { timeout: 5_000, interval: 100 });
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform === "win32")(
		"ends the processes an extension started, in its process group or detached, once it answers",
		async () => {
			// Regression for #952: a plain spawn outlived a successful inventory, reparented to init.
			const { tempDir, root, agentDir } = spawnerWorkspace((dir) => {
				const plain = join(dir, "plain.pid");
				const detached = join(dir, "detached.pid");
				return `${STARTED_PID_SOURCE}export default async function () {
	spawn("sh", ["-c", ${JSON.stringify(sleeper(plain))}], { stdio: "ignore" });
	spawn("sh", ["-c", ${JSON.stringify(sleeper(detached))}], { stdio: "ignore", detached: true });
	await until(() => startedPid(${JSON.stringify(plain)}) && startedPid(${JSON.stringify(detached)}));
}
`;
			});

			const output = await new ProcessWorkerLauncher().launchExtensionInventory({
				id: "test-4",
				agentDir,
				root,
				projectTrusted: true,
			}).result;

			expect(output).toMatchObject({ ok: true, extensions: [{ id: "spawner", state: "active" }] });
			const pids = [await waitForPid(join(tempDir, "plain.pid")), await waitForPid(join(tempDir, "detached.pid"))];
			await expectEnded(pids);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform === "win32")(
		"kills a process an extension started that ignores SIGTERM when it is stopped",
		async () => {
			const { tempDir, root, agentDir } = spawnerWorkspace((dir) => {
				// An ignored SIGTERM stays ignored across exec; the factory never returns.
				const command = `trap "" TERM; ${sleeper(join(dir, "stubborn.pid"))}`;
				return `${STARTED_PID_SOURCE}export default async function () {
	spawn("sh", ["-c", ${JSON.stringify(command)}], { stdio: "ignore" });
	await new Promise(() => {});
}
`;
			});

			const launched = new ProcessWorkerLauncher().launchExtensionInventory({
				id: "test-5",
				agentDir,
				root,
				projectTrusted: true,
			});
			launched.result.catch(() => undefined);
			const pid = await waitForPid(join(tempDir, "stubborn.pid"));
			expect(processIsAlive(pid)).toBe(true);

			launched.kill();
			await expect(launched.result).rejects.toThrow(/wrote no result/);
			await expectEnded([pid]);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"ends the processes still descended from it once it answers, and leaves running one that left its tree",
		async () => {
			const { root, agentDir, pidFile } = sleeperWorkspace();

			const output = await new ProcessWorkerLauncher().launchExtensionInventory({
				id: "test-7",
				agentDir,
				root,
				projectTrusted: true,
			}).result;

			expect(output).toMatchObject({ ok: true, extensions: [{ id: "spawner", state: "active" }] });
			const [plain, grandchild, detached, orphan] = await Promise.all(
				["plain", "grandchild", "detached", "orphan"].map((name) => waitForPid(pidFile(name))),
			);
			await expectEnded([plain, grandchild, detached]);
			expect(processIsAlive(orphan)).toBe(true);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it(
		"ends the processes still descended from it when it exits on an uncaught error",
		async () => {
			const { root, agentDir, pidFile } = sleeperWorkspace(
				`setTimeout(() => { throw new Error("spawner failed"); }, 0);
	await new Promise(() => {});`,
			);

			const launched = new ProcessWorkerLauncher().launchExtensionInventory({
				id: "test-8",
				agentDir,
				root,
				projectTrusted: true,
			});

			await expect(launched.result).rejects.toThrow(`exit code ${CRASH_EXIT_CODE}`);
			const [plain, grandchild, detached, orphan] = await Promise.all(
				["plain", "grandchild", "detached", "orphan"].map((name) => waitForPid(pidFile(name))),
			);
			await expectEnded([plain, grandchild, detached]);
			// It ended its tree itself, so the daemon ends nothing after it: its process group is left alone.
			expect(processIsAlive(orphan)).toBe(true);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);

	it.skipIf(process.platform === "win32")(
		"ends the processes an extension started when the inventory process exits on its own",
		async () => {
			const { tempDir, root, agentDir } = spawnerWorkspace((dir) => {
				const pidFile = join(dir, "orphan.pid");
				return `${STARTED_PID_SOURCE}export default async function () {
	spawn("sh", ["-c", ${JSON.stringify(sleeper(pidFile))}], { stdio: "ignore" });
	await until(() => startedPid(${JSON.stringify(pidFile)}));
	process.kill(process.pid, "SIGKILL");
}
`;
			});

			const launched = new ProcessWorkerLauncher().launchExtensionInventory({
				id: "test-6",
				agentDir,
				root,
				projectTrusted: true,
			});
			await expect(launched.result).rejects.toThrow(/wrote no result/);
			await expectEnded([await waitForPid(join(tempDir, "orphan.pid"))]);
		},
		PROCESS_TEST_TIMEOUT_MS,
	);
});

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}
