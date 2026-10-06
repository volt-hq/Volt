/**
 * How the daemon starts conversation workers. A launched worker connects back
 * to the daemon's control socket with role `worker`, presenting the
 * single-use token its launch carried, and receives the conversation it opens
 * over that connection; the daemon observes its exit through `exited`.
 *
 * `ProcessWorkerLauncher` runs each worker as a process of its own (`volt
 * daemon worker`, daemon-hosted conversations RFC §5.1): detached from any
 * terminal, in the conversation's working directory, with the daemon's
 * environment (less the daemon's relay credentials), and its stdout and
 * stderr in `daemon/workers/<workerId>.log` (0600). Its token, worker id, and
 * the socket travel on its stdin, never in its argv or environment, and are
 * never logged; what it opens follows its hello over the socket.
 */

import { spawn } from "node:child_process";
import { closeSync, constants, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { ENV_AGENT_DIR } from "../config.ts";
import { ensurePrivateDirectorySync } from "../utils/private-files.ts";
import { getWorkerLogDirectory } from "./paths.ts";
import { resolveDaemonCliInvocation } from "./spawn.ts";

/** Why a worker exited. */
export type WorkerExitReason =
	/** It was asked to stop and closed its conversations. */
	| "stopped"
	/** Its primary conversation closed without a stop (it lost its log). */
	| "closed"
	/** It could not connect, or could not open its primary conversation. */
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
	/** Single-use; the worker presents it in its hello. Never logged. */
	readonly workerToken: string;
	readonly socketPath: string;
	readonly agentDir: string;
	/** The working directory of the conversation the worker opens. */
	readonly cwd: string;
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

export interface WorkerLauncher {
	launch(request: WorkerLaunchRequest): LaunchedWorker;
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
	closed: 3,
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

/** Worker logs kept beyond those of running workers; older ones are removed as workers start. */
const MAX_WORKER_LOGS = 50;

/** The daemon's own relay credentials: a worker never uses them, and its tools must not see them. */
const DAEMON_ONLY_ENVIRONMENT = ["VOLT_IROH_RELAY_AUTH_TOKEN", "VOLT_PUSH_RELAY_AUTH_TOKEN"] as const;

/** The daemon's environment, without its own credentials, for a worker of the agent directory `agentDir`. */
function workerEnvironment(agentDir: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, [ENV_AGENT_DIR]: agentDir };
	for (const name of DAEMON_ONLY_ENVIRONMENT) delete env[name];
	return env;
}

/** Conversation workers as processes of their own. */
export class ProcessWorkerLauncher implements WorkerLauncher {
	/** Workers this launcher started that have not exited: their logs are kept. */
	private readonly running = new Set<string>();

	launch(request: WorkerLaunchRequest): LaunchedWorker {
		const directory = getWorkerLogDirectory(request.agentDir);
		ensurePrivateDirectorySync(directory);
		this.pruneLogs(directory);
		const logPath = join(directory, `${request.workerId}.log`);
		// A new file of its own: never one planted at its path, and never through a link.
		const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
		const logFd = openSync(
			logPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_APPEND | noFollow,
			0o600,
		);
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(process.execPath, [resolveDaemonCliInvocation().entry, "daemon", "worker"], {
				cwd: request.cwd,
				// Its own process group and session: no terminal's signals reach it, and it outlives no daemon (it exits on daemon loss).
				detached: true,
				windowsHide: true,
				stdio: ["pipe", logFd, logFd],
				env: workerEnvironment(request.agentDir),
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
			kill: () => {
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			},
		};
	}

	/** Remove the oldest logs of workers that are not running, keeping the newest `MAX_WORKER_LOGS - 1`. */
	private pruneLogs(directory: string): void {
		let logs: Array<{ path: string; mtimeMs: number }>;
		try {
			logs = readdirSync(directory)
				.filter((name) => name.endsWith(".log") && !this.running.has(name.slice(0, -".log".length)))
				.map((name) => {
					const path = join(directory, name);
					return { path, mtimeMs: statSync(path).mtimeMs };
				});
		} catch {
			return;
		}
		logs.sort((left, right) => right.mtimeMs - left.mtimeMs);
		for (const { path } of logs.slice(MAX_WORKER_LOGS - 1)) rmSync(path, { force: true });
	}
}
