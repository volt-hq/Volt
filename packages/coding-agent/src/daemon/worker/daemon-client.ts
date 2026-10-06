/**
 * A conversation worker's control connection to its daemon (role `worker`):
 * the requests a worker makes of the daemon, the events the daemon sends it,
 * and the loss of the connection, which the worker treats as the daemon's
 * loss. The connection never reconnects.
 */

import { VERSION } from "../../config.ts";
import type { IrohRemoteHostHandshakeFailureOutcome } from "../../core/remote/iroh/protocol.ts";
import { createDaemonClient, type DaemonClient, type DistributiveOmit } from "../control-client.ts";
import type {
	ControlEvent,
	ControlRequest,
	ControlResponse,
	WorkerHostKind,
	WorkerSpawnSpec,
	WorkerStopReason,
} from "../control-protocol.ts";

/** A `worker_stop` the daemon sent: answer it once with `stopResult`. */
export interface WorkerStopEvent {
	readonly stopId: string;
	readonly reason: WorkerStopReason;
	readonly force: boolean;
}

export interface WorkerDaemonClientOptions {
	readonly socketPath: string;
	readonly workerId: string;
	readonly workerToken: string;
	onStop(stop: WorkerStopEvent): void;
	/** The connection to the daemon dropped. */
	onLost(): void;
}

/** A request the daemon refused. */
export class WorkerRequestError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "WorkerRequestError";
		this.code = code;
	}
}

export class WorkerDaemonClient {
	private readonly client: DaemonClient;
	private readonly spawn = Promise.withResolvers<WorkerSpawnSpec>();
	private readonly workerId: string;
	private connected = false;
	private lost = false;

	constructor(options: WorkerDaemonClientOptions) {
		this.workerId = options.workerId;
		void this.spawn.promise.catch(() => undefined);
		this.client = createDaemonClient({
			socketPath: options.socketPath,
			version: VERSION,
			worker: { workerId: options.workerId, workerToken: options.workerToken },
			reconnect: false,
			onEvent: (event: ControlEvent) => {
				if (event.type === "worker_spawn") {
					if (event.spec.workerId === this.workerId) this.spawn.resolve(event.spec);
					else this.spawn.reject(new Error("The daemon sent another worker's conversation"));
				} else if (event.type === "worker_stop") {
					options.onStop({ stopId: event.stopId, reason: event.reason, force: event.force });
				}
			},
			onConnectionStateChange: (state) => {
				if (state !== "gone" || this.lost) return;
				this.lost = true;
				this.spawn.reject(new Error("The daemon connection closed"));
				if (this.connected) options.onLost();
			},
		});
	}

	/** Connect with the worker's hello; the daemon admits it once, with the token its spawn issued. */
	async connect(): Promise<void> {
		await this.client.connect();
		this.connected = true;
	}

	/** The conversation the daemon spawned the worker for; rejects after `timeoutMs`. */
	async spawnSpec(timeoutMs: number): Promise<WorkerSpawnSpec> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.spawn.promise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("The daemon sent no conversation to open")), timeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private async request(request: DistributiveOmit<ControlRequest, "id">): Promise<ControlResponse> {
		const response = await this.client.request(request);
		if (response.type === "error") throw new WorkerRequestError(response.code, response.message);
		return response;
	}

	ready(sessionIds: readonly string[]): Promise<ControlResponse> {
		return this.request({ type: "worker_ready", sessionIds: [...sessionIds] });
	}

	openFailed(message: string, outcome?: IrohRemoteHostHandshakeFailureOutcome): Promise<ControlResponse> {
		return this.request({
			type: "worker_open_failed",
			message: Array.from(message).slice(0, 1024).join(""),
			...(outcome === undefined ? {} : { outcome }),
		});
	}

	activity(active: boolean): Promise<ControlResponse> {
		return this.request({ type: "worker_activity", active });
	}

	/** Claim `sessionId` before opening it; rejects with code `claimed` when another worker hosts it. */
	hosts(sessionId: string, kind: WorkerHostKind, parentSessionId: string): Promise<ControlResponse> {
		return this.request({ type: "worker_hosts", sessionId, kind, parentSessionId });
	}

	released(sessionId: string): Promise<ControlResponse> {
		return this.request({ type: "worker_released", sessionId });
	}

	stopResult(stopId: string, outcome: "stopped" | "refused_active"): Promise<ControlResponse> {
		return this.request({ type: "worker_stop_result", stopId, outcome });
	}

	close(): Promise<void> {
		this.lost = true;
		return this.client.close();
	}
}
