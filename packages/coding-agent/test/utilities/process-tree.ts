/**
 * Processes for testing what ends with a process the daemon starts (daemon-hosted conversations RFC §5.3, worker
 * process tree), the same on every platform: a Node "sleeper" that writes its pid to a file and keeps running,
 * and the source of an extension, `spawner`, that starts sleepers as it loads.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, vi } from "vitest";

/**
 * `node sleeper.mjs <pidFile> [child|orphan <childPidFile>]`: with `child`, it first starts another sleeper as
 * its child; with `orphan`, it starts one that outlives it and exits at once, so the new sleeper has left the
 * tree it was started in. Either way it writes its pid only once its child exists.
 */
const SLEEPER_SOURCE = `import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const [pidFile, kind, childPidFile] = process.argv.slice(2);
const self = fileURLToPath(import.meta.url);
if (kind === "child") spawn(process.execPath, [self, childPidFile], { stdio: "ignore" });
// On macOS and Linux the orphan stays in this process's group. On Windows only a detached child outlives a Node
// parent: libuv ends the others with it.
if (kind === "orphan") {
	spawn(process.execPath, [self, childPidFile], { stdio: "ignore", detached: process.platform === "win32" }).unref();
}
writeFileSync(pidFile, String(process.pid));
if (kind === "orphan") process.exit(0);
setInterval(() => {}, 1_000);
// A sleeper a test failed to end does not outlive the run for long.
setTimeout(() => process.exit(0), 120_000);
`;

/** Write the sleeper script into `directory`; its path. */
export function writeSleeper(directory: string): string {
	const path = join(directory, "sleeper.mjs");
	writeFileSync(path, SLEEPER_SOURCE);
	return path;
}

/** A sleeper the extension starts: its arguments after the script, and whether it is spawned detached. */
export interface SleeperStart {
	readonly args: readonly string[];
	readonly detached?: boolean;
}

/**
 * The source of extension `spawner` (no permissions): its factory starts `starts`, waits until every pid file in
 * `pidFiles` exists, then runs `then` (statements).
 */
export function spawnerExtension(
	sleeper: string,
	starts: readonly SleeperStart[],
	pidFiles: readonly string[],
	then = "",
): string {
	const spawns = starts
		.map(
			(start) =>
				`\tspawn(process.execPath, ${JSON.stringify([sleeper, ...start.args])}, { stdio: "ignore", detached: ${start.detached === true} });`,
		)
		.join("\n");
	return `import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
export const manifest = { id: "spawner", displayName: "Spawner" };
export default async function () {
${spawns}
	const pidFiles = ${JSON.stringify(pidFiles)};
	while (!pidFiles.every((file) => existsSync(file))) await new Promise((resolve) => setTimeout(resolve, 20));
	${then}
}
`;
}

/** The pid a sleeper wrote to `pidFile`, once it has; recorded in `started` for cleanup. */
export async function waitForPid(pidFile: string, started: number[], timeoutMs = 120_000): Promise<number> {
	await vi.waitFor(() => expect(readFileSync(pidFile, "utf8").trim()).toMatch(/^\d+$/), {
		timeout: timeoutMs,
		interval: 100,
	});
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	started.push(pid);
	return pid;
}

export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function expectEnded(pids: readonly number[]): Promise<void> {
	await vi.waitFor(
		() => {
			for (const pid of pids) expect(processIsAlive(pid), `process ${pid}`).toBe(false);
		},
		{ timeout: 10_000, interval: 100 },
	);
}

/** Kill every process in `started`, emptying it. */
export function killStarted(started: number[]): void {
	for (const pid of started.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Ended already.
		}
	}
}
