/**
 * How the daemon starts conversation workers. A launched worker connects back
 * to the daemon's control socket with role `worker`, presenting the
 * single-use token its launch carried, and receives the conversation it opens
 * over that connection; the daemon observes its exit through `exited`.
 *
 * `InProcessWorkerLauncher` runs each worker in the daemon's own process,
 * over the real socket, until workers run as processes of their own (Phase 7
 * slice 5).
 */

import { runWorker } from "./worker/host.ts";

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
}

export interface LaunchedWorker {
	readonly pid: number;
	/** Settles once the worker exited; never rejects. */
	readonly exited: Promise<WorkerExit>;
	/** Stop a worker that did not exit after a forced stop. */
	kill(): void;
}

export interface WorkerLauncher {
	launch(request: WorkerLaunchRequest): LaunchedWorker;
}

/** Workers in the daemon's own process, connected over the daemon's control socket. */
export class InProcessWorkerLauncher implements WorkerLauncher {
	launch(request: WorkerLaunchRequest): LaunchedWorker {
		const exited = runWorker(request).catch(
			(error: unknown): WorkerExit => ({
				reason: "crashed",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
		return {
			pid: process.pid,
			exited,
			// A worker in this process cannot be killed; its forced stop already aborted its turn.
			kill: () => {},
		};
	}
}
