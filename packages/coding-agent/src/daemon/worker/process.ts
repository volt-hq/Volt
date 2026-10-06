/**
 * `volt daemon worker` (hidden): one conversation worker as a process of its
 * own, started by the daemon's `ProcessWorkerLauncher`. Its worker id, its
 * single-use token, and the daemon's socket arrive as one JSON line on stdin,
 * never in argv or the environment, and are never logged; everything else
 * follows its hello over the socket. Its stdout and stderr are its log.
 *
 * It exits with a code that tells the daemon why (`WORKER_EXIT_CODES`). A
 * stop of any kind arms a deadline: past the 60 s turn cap, and margin, the
 * process exits even if closing its conversations hangs, so a worker never
 * outlives its daemon for long and a restarted daemon (which waits for it on
 * the worker gate) starts. SIGTERM or SIGINT stop it as a forced stop does; a
 * second one exits at once.
 */

import { SettingsManager } from "../../core/settings-manager.ts";
import { initTheme } from "../../core/theme/runtime.ts";
import { WORKER_EXIT_CODES, type WorkerBootstrap, type WorkerExitReason } from "../worker-launcher.ts";
import { runWorker, WORKER_TURN_CAP_MS } from "./host.ts";

/** How long a worker waits for its bootstrap line. */
const BOOTSTRAP_TIMEOUT_MS = 30_000;
const MAX_BOOTSTRAP_BYTES = 16 * 1024;
/** Past the turn cap: closing the conversations and the process' teardown. */
const EXIT_DEADLINE_MARGIN_MS = 10_000;
const CRASHED_EXIT_CODE = 1;

function isBootstrap(value: unknown): value is WorkerBootstrap {
	if (typeof value !== "object" || value === null) return false;
	const fields = value as Record<string, unknown>;
	return (
		typeof fields.workerId === "string" &&
		/^w-[0-9a-f-]{36}$/.test(fields.workerId) &&
		typeof fields.workerToken === "string" &&
		fields.workerToken.length > 0 &&
		typeof fields.socketPath === "string" &&
		fields.socketPath.length > 0
	);
}

/** Read the bootstrap line from stdin, then stop reading it. */
function readBootstrap(): Promise<WorkerBootstrap> {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		let buffered = "";
		const finish = (error: Error | undefined, bootstrap?: WorkerBootstrap) => {
			clearTimeout(timer);
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			stdin.off("error", onEnd);
			stdin.pause();
			stdin.destroy();
			if (error) reject(error);
			else if (bootstrap) resolve(bootstrap);
		};
		const onData = (chunk: string) => {
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline === -1) {
				if (buffered.length > MAX_BOOTSTRAP_BYTES) finish(new Error("The worker bootstrap is too large"));
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(buffered.slice(0, newline));
			} catch {
				finish(new Error("The worker bootstrap is not JSON"));
				return;
			}
			if (!isBootstrap(parsed)) finish(new Error("The worker bootstrap is malformed"));
			else finish(undefined, parsed);
		};
		const onEnd = () => finish(new Error("No worker bootstrap on stdin"));
		const timer = setTimeout(() => finish(new Error("No worker bootstrap on stdin")), BOOTSTRAP_TIMEOUT_MS);
		stdin.setEncoding("utf8");
		stdin.on("data", onData);
		stdin.once("end", onEnd);
		stdin.once("error", onEnd);
	});
}

function exitCode(reason: WorkerExitReason): number {
	return reason === "crashed" ? CRASHED_EXIT_CODE : WORKER_EXIT_CODES[reason];
}

/** Run the worker the daemon's launch describes; resolves with the process' exit code. */
export async function runWorkerProcess(agentDir: string): Promise<number> {
	process.title = "volt-worker";
	let bootstrap: WorkerBootstrap;
	try {
		bootstrap = await readBootstrap();
	} catch (error) {
		console.error(`volt worker: ${error instanceof Error ? error.message : String(error)}`);
		return WORKER_EXIT_CODES.failed;
	}
	const { workerId } = bootstrap;
	// Names only: values (credentials among them) are never logged.
	console.error(
		`${new Date().toISOString()} worker ${workerId} pid ${process.pid} started in ${process.cwd()}; environment: ${Object.keys(
			process.env,
		)
			.sort()
			.join(", ")}`,
	);
	// The theme extensions see; the global one, as a process hosting RPC conversations uses.
	initTheme(SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getTheme(), false);

	const halt = new AbortController();
	let deadline: ReturnType<typeof setTimeout> | undefined;
	const onStopping = (reason: WorkerExitReason) => {
		console.error(`${new Date().toISOString()} worker ${workerId} stopping (${reason})`);
		deadline ??= setTimeout(() => {
			console.error(`${new Date().toISOString()} worker ${workerId} did not finish stopping; exiting`);
			process.exit(exitCode(reason));
		}, WORKER_TURN_CAP_MS + EXIT_DEADLINE_MARGIN_MS);
		deadline.unref();
	};
	const onSignal = (signal: NodeJS.Signals) => {
		if (halt.signal.aborted) process.exit(CRASHED_EXIT_CODE);
		console.error(`${new Date().toISOString()} worker ${workerId} received ${signal}`);
		halt.abort();
	};
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	const exit = await runWorker({ ...bootstrap, agentDir, cwd: process.cwd() }, { signal: halt.signal, onStopping });
	console.error(
		`${new Date().toISOString()} worker ${workerId} exited: ${exit.reason}${exit.error === undefined ? "" : ` (${exit.error})`}`,
	);
	return exitCode(exit.reason);
}
