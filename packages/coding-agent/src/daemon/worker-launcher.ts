/**
 * How the daemon starts conversation workers. A launched worker connects back
 * to the daemon's control socket with role `worker`, proving the single-use
 * token its launch carried (without sending it), and receives the
 * conversation it opens over that connection; the daemon observes its exit
 * through `exited`.
 *
 * `ProcessWorkerLauncher` runs each worker as a process of its own (`volt
 * daemon worker`, daemon-hosted conversations RFC §5.1), from the daemon's
 * own installation (a standalone binary re-executes itself, by absolute
 * path): detached from any terminal, in the conversation's working
 * directory, with the environment of the client whose open spawned it (a
 * TUI's, carried by `conversation_open`; the daemon's own for a phone's),
 * less the daemon's relay credentials (`DAEMON_ONLY_ENVIRONMENT`), and its
 * stdout and stderr in `daemon/workers/<workerId>.log` (0600). Its token,
 * worker id, and the socket travel on its stdin, never in its argv or
 * environment, and are never logged; what it opens follows its hello over
 * the socket. Its environment's values are never logged either: the worker
 * logs their names.
 *
 * It also runs extension inventories (`volt daemon extension-inventory`):
 * one-shot processes, started the same way in the root they evaluate, with
 * the daemon's environment. The request travels on stdin and the result comes
 * back as one JSON line on fd 3, so nothing an extension prints to stdout can
 * corrupt it; stdout and stderr go to `inventory-<id>.log` beside the
 * workers' logs.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, constants, lstatSync, openSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { ENV_AGENT_DIR } from "../config.ts";
import { ensurePrivateDirectorySync } from "../utils/private-files.ts";
import { getWorkerLogDirectory } from "./paths.ts";
import { resolveDaemonCliInvocation } from "./spawn.ts";
import { withoutDaemonCredentials } from "./worker-spawn-options.ts";

/** Why a worker exited. */
export type WorkerExitReason =
	/** It was asked to stop and closed its conversations. */
	| "stopped"
	/** It could not connect, or could not open the conversation it was spawned for. */
	| "failed"
	/** Its control connection to the daemon dropped; it finished its turn and exited. */
	| "daemon_lost"
	/** It failed unexpectedly. */
	| "crashed";

export interface WorkerExit {
	readonly reason: WorkerExitReason;
	readonly error?: string;
}

export interface WorkerLaunchRequest {
	readonly workerId: string;
	/** Single-use; the worker proves it in its hello. Never logged, never sent over the socket. */
	readonly workerToken: string;
	readonly socketPath: string;
	readonly agentDir: string;
	/** The worker process's working directory: its workspace (each conversation runs in a directory of its own). */
	readonly cwd: string;
	/** The environment of the TUI whose open spawned the worker; the daemon's own without one. Never logged. */
	readonly env?: Readonly<Record<string, string>>;
}

export interface LaunchedWorker {
	readonly pid: number;
	/** The worker's log, when it runs as a process of its own. */
	readonly logPath?: string;
	/** Settles once the worker exited; never rejects. */
	readonly exited: Promise<WorkerExit>;
	/** Stop a worker that did not exit after a forced stop. */
	kill(): void;
}

/** What an extension inventory process evaluates; written to its stdin as one JSON line. */
export interface ExtensionInventoryProbeRequest {
	/** The root a conversation there loads its project resources from: the workspace, or a worktree checkout. */
	readonly root: string;
	/** The daemon's trust decision for the workspace. */
	readonly projectTrusted: boolean;
	readonly profile?: string;
}

export interface ExtensionInventoryLaunchRequest extends ExtensionInventoryProbeRequest {
	/** Names its log. */
	readonly id: string;
	readonly agentDir: string;
}

/** Largest result an extension inventory process may write, in bytes. */
export const EXTENSION_INVENTORY_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface LaunchedExtensionInventory {
	/**
	 * The JSON line the process wrote on fd 3, parsed; rejects when it wrote none (it exited, crashed, or was
	 * killed first), wrote more than {@link EXTENSION_INVENTORY_MAX_OUTPUT_BYTES}, or wrote something else.
	 */
	readonly result: Promise<unknown>;
	/** Kill the process and what it started. */
	kill(): void;
}

export interface WorkerLauncher {
	launch(request: WorkerLaunchRequest): LaunchedWorker;
	/** Run an extension inventory; a launcher without it cannot (tests of the control plane). */
	launchExtensionInventory?(request: ExtensionInventoryLaunchRequest): LaunchedExtensionInventory;
}

/** What a worker process reads from its stdin, as one JSON line, before anything else. */
export interface WorkerBootstrap {
	readonly workerId: string;
	readonly workerToken: string;
	readonly socketPath: string;
}

/** A worker process's exit code for each way it exits; any other code or a signal reads as crashed. */
export const WORKER_EXIT_CODES = {
	stopped: 0,
	failed: 4,
	daemon_lost: 5,
} as const satisfies Record<Exclude<WorkerExitReason, "crashed">, number>;

/** How a worker process exited, from its exit code or signal. */
export function workerExitFromCode(code: number | null, signal: NodeJS.Signals | null): WorkerExit {
	for (const [reason, exitCode] of Object.entries(WORKER_EXIT_CODES) as Array<
		[keyof typeof WORKER_EXIT_CODES, number]
	>) {
		if (signal === null && code === exitCode) return { reason };
	}
	return { reason: "crashed", error: signal === null ? `exit code ${code}` : `signal ${signal}` };
}

/** Kill `child`'s process group (it and the children it did not detach), else `child` itself, unless it exited. */
function killGroup(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform !== "win32" && child.pid !== undefined) {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// Fall back to the process itself.
		}
	}
	child.kill("SIGKILL");
}

/** Worker logs kept beyond those of running workers; older ones are removed as workers start. */
const MAX_WORKER_LOGS = 50;

/**
 * A worker's environment: `base` (its opener's; the daemon's own by default)
 * without the daemon's credentials, for the agent directory `agentDir`.
 */
export function workerEnvironment(
	agentDir: string,
	base: Readonly<Record<string, string | undefined>> = process.env,
): NodeJS.ProcessEnv {
	return { ...withoutDaemonCredentials(base), [ENV_AGENT_DIR]: agentDir };
}

/** Conversation workers as processes of their own. */
export class ProcessWorkerLauncher implements WorkerLauncher {
	/** Workers this launcher started that have not exited: their logs are kept. */
	private readonly running = new Set<string>();

	launch(request: WorkerLaunchRequest): LaunchedWorker {
		const { logPath, logFd } = this.openLog(request.agentDir, request.workerId);
		let child: ReturnType<typeof spawn>;
		try {
			const invocation = resolveDaemonCliInvocation();
			child = spawn(invocation.command, [...invocation.entryArgs, "daemon", "worker"], {
				cwd: request.cwd,
				// Its own process group and session: no terminal's signals reach it, and it outlives no daemon (it exits on daemon loss).
				detached: true,
				windowsHide: true,
				stdio: ["pipe", logFd, logFd],
				env: workerEnvironment(request.agentDir, request.env),
			});
		} finally {
			// The child has its own copy of the descriptor.
			closeSync(logFd);
		}
		this.running.add(request.workerId);
		const exited = new Promise<WorkerExit>((resolve) => {
			const settle = (exit: WorkerExit) => {
				this.running.delete(request.workerId);
				resolve(exit);
			};
			child.once("exit", (code, signal) => settle(workerExitFromCode(code, signal)));
			// A process that never started; a failed signal to a running one is not its exit.
			child.once("error", (error) => {
				if (child.pid === undefined) settle({ reason: "failed", error: error.message });
			});
		});
		const bootstrap: WorkerBootstrap = {
			workerId: request.workerId,
			workerToken: request.workerToken,
			socketPath: request.socketPath,
		};
		// A worker that exits before it reads its stdin closes the pipe; its exit says so.
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(`${JSON.stringify(bootstrap)}\n`);
		child.unref();
		return {
			pid: child.pid ?? 0,
			logPath,
			exited,
			kill: () => killGroup(child),
		};
	}

	launchExtensionInventory(request: ExtensionInventoryLaunchRequest): LaunchedExtensionInventory {
		const name = `inventory-${request.id}`;
		const { logFd } = this.openLog(request.agentDir, name);
		let child: ReturnType<typeof spawn>;
		try {
			const invocation = resolveDaemonCliInvocation();
			child = spawn(invocation.command, [...invocation.entryArgs, "daemon", "extension-inventory"], {
				cwd: request.root,
				detached: true,
				windowsHide: true,
				stdio: ["pipe", logFd, logFd, "pipe"],
				env: workerEnvironment(request.agentDir),
			});
		} finally {
			closeSync(logFd);
		}
		this.running.add(name);
		const exited = new Promise<WorkerExit>((resolve) => {
			const settle = (exit: WorkerExit) => {
				this.running.delete(name);
				resolve(exit);
			};
			child.once("exit", (code, signal) => settle(workerExitFromCode(code, signal)));
			child.once("error", (error) => {
				if (child.pid === undefined) settle({ reason: "failed", error: error.message });
			});
		});
		const output = child.stdio[3] as Readable | null | undefined;
		const written = new Promise<string>((resolve, reject) => {
			if (!output) {
				reject(new Error("The extension inventory process has no result pipe"));
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			output.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > EXTENSION_INVENTORY_MAX_OUTPUT_BYTES) {
					output.destroy();
					killGroup(child);
					reject(new Error("The extension inventory result is too large"));
					return;
				}
				chunks.push(chunk);
			});
			output.once("error", () => undefined);
			output.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
		});
		const bytes = `${JSON.stringify({
			root: request.root,
			projectTrusted: request.projectTrusted,
			...(request.profile === undefined ? {} : { profile: request.profile }),
		} satisfies ExtensionInventoryProbeRequest)}\n`;
		child.stdin?.on("error", () => undefined);
		child.stdin?.end(bytes);
		child.unref();
		const result = (async (): Promise<unknown> => {
			const [text, exit] = await Promise.all([written, exited]);
			const newline = text.indexOf("\n");
			if (newline === -1) {
				throw new Error(
					`The extension inventory process wrote no result (${exit.reason}${exit.error === undefined ? "" : `: ${exit.error}`})`,
				);
			}
			try {
				return JSON.parse(text.slice(0, newline)) as unknown;
			} catch {
				throw new Error("The extension inventory result is not JSON");
			}
		})();
		return { result, kill: () => killGroup(child) };
	}

	/** A new log file of its own for `name`, in the agent's worker log directory: never one planted at its path, never through a link. */
	private openLog(agentDir: string, name: string): { logPath: string; logFd: number } {
		const directory = getWorkerLogDirectory(agentDir);
		ensurePrivateDirectorySync(directory);
		this.pruneLogs(directory);
		const logPath = join(directory, `${name}.log`);
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const logFd = openSync(
			logPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | noFollow,
			0o600,
		);
		return { logPath, logFd };
	}

	/**
	 * Remove the oldest logs of workers that are not running, keeping the
	 * newest `MAX_WORKER_LOGS - 1`. Only regular files are logs; anything
	 * that cannot be read or removed is left, and never fails a launch.
	 */
	private pruneLogs(directory: string): void {
		let names: string[];
		try {
			names = readdirSync(directory);
		} catch {
			return;
		}
		const logs: Array<{ path: string; mtimeMs: number }> = [];
		for (const name of names) {
			if (!name.endsWith(".log") || this.running.has(name.slice(0, -".log".length))) continue;
			const path = join(directory, name);
			try {
				const stats = lstatSync(path);
				if (stats.isFile()) logs.push({ path, mtimeMs: stats.mtimeMs });
			} catch {
				// Gone already.
			}
		}
		logs.sort((left, right) => right.mtimeMs - left.mtimeMs);
		for (const { path } of logs.slice(MAX_WORKER_LOGS - 1)) {
			try {
				rmSync(path, { force: true });
			} catch {
				// Left for a later launch.
			}
		}
	}
}
