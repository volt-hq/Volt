/**
 * The worker gate: a restarted daemon admits nothing until the previous
 * daemon's conversation workers have exited (docs/tla/WorkerRegistry.tla,
 * `RestartWaitsForOrphans`). Every worker holds a shared OS lock on the gate
 * for its whole life, taken before it connects to its daemon; a daemon takes
 * the gate exclusively, and releases it, before it serves anything. A worker
 * that loses its daemon finishes its turn (60 s cap) and exits, which the OS
 * turns into the release of its share.
 *
 * A worker that cannot take its share (a daemon is waiting on the gate)
 * belongs to a daemon that is gone: it never connects, so it opens nothing.
 */

import { join } from "node:path";
import { type FileLock, tryAcquireFileLock } from "../core/file-lock.ts";
import { WorkspaceFsNativeUnavailableError } from "../core/workspace-fs/native-loader.ts";
import { getDaemonDir } from "./paths.ts";

const GATE_IDENTITY = "conversation-workers";
const GATE_POLL_MS = 100;

function gateDirectory(agentDir: string): string {
	return join(getDaemonDir(agentDir), "locks");
}

/** A worker's share of the gate; `close()` releases it, and so does the worker's exit. */
export type WorkerGateShare = FileLock;

/**
 * Take a worker's share of the gate. Undefined when a daemon holds the gate
 * (it is waiting for the workers of a daemon that is gone). Throws where the
 * native lock is unavailable: a worker without its share opens nothing.
 */
export function holdWorkerGate(agentDir: string): WorkerGateShare | undefined {
	return tryAcquireFileLock(gateDirectory(agentDir), GATE_IDENTITY, true);
}

export type WorkerGateWait =
	/** No worker of an earlier daemon is running. */
	| { readonly status: "open"; readonly waitedMs: number }
	/** Workers of an earlier daemon still ran when `timeoutMs` elapsed. */
	| { readonly status: "timed_out"; readonly waitedMs: number }
	/** The native lock is unavailable: no worker can have held the gate (or any conversation lock). */
	| { readonly status: "unavailable"; readonly reason: string };

/**
 * Wait until the gate can be taken exclusively, then release it at once:
 * every worker of an earlier daemon has exited. `onWaiting` runs once if the
 * first attempt finds the gate held.
 */
export async function waitForWorkerGate(
	agentDir: string,
	options: { readonly timeoutMs: number; readonly onWaiting?: () => void },
): Promise<WorkerGateWait> {
	const startedAt = Date.now();
	let waiting = false;
	for (;;) {
		let gate: FileLock | undefined;
		try {
			gate = tryAcquireFileLock(gateDirectory(agentDir), GATE_IDENTITY, false);
		} catch (error) {
			if (error instanceof WorkspaceFsNativeUnavailableError)
				return { status: "unavailable", reason: error.message };
			throw error;
		}
		const waitedMs = Date.now() - startedAt;
		if (gate) {
			gate.close();
			return { status: "open", waitedMs };
		}
		if (waitedMs >= options.timeoutMs) return { status: "timed_out", waitedMs };
		if (!waiting) {
			waiting = true;
			options.onWaiting?.();
		}
		await new Promise((resolve) => setTimeout(resolve, GATE_POLL_MS));
	}
}
