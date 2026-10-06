/**
 * Conversation workers in the test's own process, connected over the
 * daemon's real control socket with role `worker`, so the daemon harness and
 * its tests steer and observe workers without spawning processes. The daemon
 * runs `ProcessWorkerLauncher`; `test/daemon-worker-process.test.ts` covers
 * workers as processes.
 */

import type { RunWorkerOptions } from "../../src/daemon/worker/host.ts";
import { runWorker } from "../../src/daemon/worker/host.ts";
import type {
	LaunchedWorker,
	WorkerExit,
	WorkerLauncher,
	WorkerLaunchRequest,
} from "../../src/daemon/worker-launcher.ts";

export class InProcessWorkerLauncher implements WorkerLauncher {
	private readonly options: Pick<RunWorkerOptions, "lockRetryMs">;

	/** `lockRetryMs`: how long a worker's primary open retries a held lock (75 s by default). */
	constructor(options: Pick<RunWorkerOptions, "lockRetryMs"> = {}) {
		this.options = options;
	}

	launch(request: WorkerLaunchRequest): LaunchedWorker {
		const exited = runWorker(request, this.options).catch(
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
