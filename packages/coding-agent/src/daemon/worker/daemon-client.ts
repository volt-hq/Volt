/**
 * A conversation worker's control connection to its daemon (role `worker`):
 * the requests a worker makes of the daemon, the events the daemon sends it,
 * and the loss of the connection, which the worker treats as the daemon's
 * loss. The connection never reconnects.
 */

import type { Duplex } from "node:stream";
import type { ControlRelayFrame, ControlRelayOutcome } from "@hansjm10/volt-protocol";
import { VERSION } from "../../config.ts";
import type { IrohRemoteHostHandshakeFailureOutcome } from "../../core/remote/iroh/protocol.ts";
import type {
	IrohRemotePushNotificationDeliveryStatus,
	IrohRemotePushNotificationIntent,
} from "../../core/remote/iroh/push.ts";
import {
	ControlRequestTooLargeError,
	createDaemonClient,
	type DaemonClient,
	type DistributiveOmit,
} from "../control-client.ts";
import {
	type ControlEvent,
	type ControlRequest,
	type ControlResponse,
	ControlValidators,
	type RelayPreamble,
	type WorkerAuthorityLoss,
	type WorkerHostKind,
	type WorkerRelayAuthority,
	type WorkerSpawnSpec,
	type WorkerStopReason,
} from "../control-protocol.ts";

/** A `worker_stop` the daemon sent: answer it once with `stopResult`. */
export interface WorkerStopEvent {
	readonly stopId: string;
	readonly reason: WorkerStopReason;
	readonly force: boolean;
}

/** A relay the daemon offered the worker for a client of a conversation it hosts. */
export type WorkerRelayOffer = Extract<ControlEvent, { type: "relay_offer" }>;

export interface WorkerDaemonClientOptions {
	readonly socketPath: string;
	readonly workerId: string;
	readonly workerToken: string;
	onStop(stop: WorkerStopEvent): void;
	onRelayOffer(offer: WorkerRelayOffer): void;
	/** A relayed client lost its authority: its stream ends with that fatal code. */
	onRelayAuthority(relayId: string, loss: WorkerAuthorityLoss): void;
	/** Stop the running turn of a hosted conversation. */
	onAbort(sessionId: string): void;
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
				} else if (event.type === "relay_offer") {
					options.onRelayOffer(event);
				} else if (event.type === "relay_authority") {
					options.onRelayAuthority(event.relayId, event.loss);
				} else if (event.type === "worker_abort") {
					options.onAbort(event.sessionId);
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

	/** Redeem a relay offer: its preamble, and the client's stream after it. */
	openRelay(offer: WorkerRelayOffer): Promise<{ preamble: RelayPreamble; stream: Duplex }> {
		return this.client.openRelay({ relayId: offer.relayId, relayToken: offer.relayToken });
	}

	/** Run a relayed phone's daemon-backed intent or query with the relay's grant. */
	async forward(relayId: string, frame: ControlRelayFrame): Promise<ControlRelayOutcome | undefined> {
		try {
			const response = await this.request({ type: "worker_forward", relayId, frame });
			return response.type === "worker_forward_result" ? response.frame : undefined;
		} catch (error) {
			// The frame or its answer does not fit a control line: the phone is told, and the connection stays.
			if (
				error instanceof ControlRequestTooLargeError ||
				(error instanceof WorkerRequestError && error.code === "too_large")
			) {
				const reason = { code: "invalid_input" as const, message: "Too large to relay to the host" };
				return frame.type === "query"
					? { type: "query_error", queryId: frame.queryId, reason }
					: { type: "rejected", intentId: frame.intentId, reason };
			}
			return undefined;
		}
	}

	async deliverNotification(
		relayId: string,
		notification: IrohRemotePushNotificationIntent,
	): Promise<IrohRemotePushNotificationDeliveryStatus> {
		// The daemon admits only canonical intents; anything else fails without a round trip.
		if (!ControlValidators.notification.Check(notification)) return "failed";
		try {
			const response = await this.request({ type: "worker_notification_delivery", relayId, notification });
			return response.type === "relay_push_delivery_result" ? response.status : "failed";
		} catch {
			return "failed";
		}
	}

	/** The relay's authority as the daemon reads it now; a failure to ask reads as revoked. */
	async authority(relayId: string): Promise<WorkerRelayAuthority> {
		try {
			const response = await this.request({ type: "worker_authority", relayId });
			return response.type === "worker_authority_result" ? response.authority : "revoked";
		} catch {
			return "revoked";
		}
	}

	moved(from: string, to: string): Promise<ControlResponse> {
		return this.request({ type: "worker_moved", from, to });
	}

	lastSession(relayId: string, sessionId: string): Promise<ControlResponse> {
		return this.request({ type: "worker_last_session", relayId, sessionId });
	}

	/** Report a hosted conversation's branch Git state (null: none to associate). */
	changeObserve(
		workspaceName: string,
		sessionId: string,
		gitContext: { repository: string; branch: string; headOid: string; baseRef?: string } | null,
	): Promise<ControlResponse> {
		return this.request({ type: "change_observe", workspaceName, sessionId, gitContext });
	}

	close(): Promise<void> {
		this.lost = true;
		return this.client.close();
	}
}
