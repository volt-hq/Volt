import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
	type ControlClientKind,
	type ControlEvent,
	ControlLineDecoder,
	type ControlRequest,
	type ControlResponse,
	encodeControlLine,
	type HelloAck,
	isControlEvent,
	isControlResponse,
	isHelloAck,
	isRelayPreamble,
	PROTOCOL_VERSION,
	type RelayPreamble,
} from "./control-protocol.ts";

export type DaemonClientConnectionState = "connected" | "reconnecting" | "gone";
export type DaemonClientGoneReason = "closed" | "protocol_mismatch" | "dial_failed";

export interface DaemonClientEndpoint {
	socketPath: string;
	authToken?: string;
}

export interface DaemonClientOptions {
	socketPath: string;
	client: ControlClientKind;
	version: string;
	/** Per-daemon instance token read from the local pidfile. */
	authToken?: string;
	/** Re-read daemon discovery metadata before every dial after the first. */
	refreshEndpoint?(): DaemonClientEndpoint | undefined;
	/** Capabilities advertised in the control hello (e.g. "worktrees"). */
	capabilities?: string[];
	onEvent?(event: ControlEvent): void;
	onConnectionStateChange?(state: DaemonClientConnectionState): void;
	/** Reconnect forever with backoff (default true for TUI clients). */
	reconnect?: boolean;
	minBackoffMs?: number;
	maxBackoffMs?: number;
	helloTimeoutMs?: number;
}

export interface RelayOfferInfo {
	relayId: string;
	relayToken: string;
}

export class DaemonClientClosedError extends Error {
	constructor(message = "daemon connection closed") {
		super(message);
		this.name = "DaemonClientClosedError";
	}
}

export interface DaemonClient {
	readonly connectionState: DaemonClientConnectionState;
	/** hello_ack payload of the current connection, when connected. */
	readonly serverInfo: { version?: string; protocolVersion?: number; connectionId?: string } | undefined;
	readonly goneReason: DaemonClientGoneReason | undefined;
	/** Connect (or await the in-flight connect). Rejects when reconnect is off and the dial fails. */
	connect(): Promise<void>;
	request(req: DistributiveOmit<ControlRequest, "id">): Promise<ControlResponse>;
	/**
	 * Await the next response for a request id (used after a provisional
	 * lease_pending). Rejects with DaemonClientClosedError on disconnect.
	 */
	waitForResponse(id: string): Promise<ControlResponse>;
	/** Dial a fresh control endpoint with role:"relay"; returns the raw duplex after the preamble. */
	openRelay(offer: RelayOfferInfo): Promise<{ preamble: RelayPreamble; stream: Duplex }>;
	close(): Promise<void>;
}

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

interface PendingRequest {
	resolve(response: ControlResponse): void;
	reject(error: Error): void;
}

/** Responses that announce a later terminal response for the same id. */
function isProvisionalControlResponse(response: ControlResponse): boolean {
	return response.type === "lease_pending";
}

const DEFAULT_MIN_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5000;
const DEFAULT_HELLO_TIMEOUT_MS = 5000;

export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
	const reconnectEnabled = options.reconnect ?? true;
	const minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
	const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
	const helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;

	let state: DaemonClientConnectionState = "reconnecting";
	let socket: Socket | undefined;
	let endpoint: DaemonClientEndpoint = {
		socketPath: options.socketPath,
		...(options.authToken === undefined ? {} : { authToken: options.authToken }),
	};
	let connectedEndpoint: DaemonClientEndpoint | undefined;
	let hasAttemptedDial = false;
	// The socket for an in-flight dial (before hello_ack promotes it to `socket`).
	// Tracked so close() can destroy a mid-handshake dial instead of leaking it.
	let dialing: Socket | undefined;
	let serverInfo: { version?: string; protocolVersion?: number; connectionId?: string } | undefined;
	let closed = false;
	let goneReason: DaemonClientGoneReason | undefined;
	let backoffMs = minBackoffMs;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let connectPromise: Promise<void> | undefined;
	const pending = new Map<string, PendingRequest>();
	/**
	 * Terminal-response promises armed when a provisional response resolves the
	 * original request. Armed synchronously inside the data handler: the
	 * provisional and terminal frames can arrive in one socket read, while the
	 * caller's waitForResponse only runs after the resolve's microtask — without
	 * this, the terminal response would resolve the already-resolved original
	 * promise and be lost.
	 */
	const followUps = new Map<string, Promise<ControlResponse>>();

	const setState = (next: DaemonClientConnectionState) => {
		if (state === next) {
			return;
		}
		state = next;
		options.onConnectionStateChange?.(next);
	};

	const failPending = () => {
		const entries = Array.from(pending.values());
		pending.clear();
		followUps.clear();
		for (const entry of entries) {
			entry.reject(new DaemonClientClosedError());
		}
	};

	const scheduleReconnect = () => {
		if (closed || !reconnectEnabled || reconnectTimer) {
			return;
		}
		setState("reconnecting");
		const jitter = 1 + (Math.random() * 0.4 - 0.2);
		const delay = Math.min(maxBackoffMs, backoffMs) * jitter;
		backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = undefined;
			void dial().catch(() => {
				scheduleReconnect();
			});
		}, delay);
		reconnectTimer.unref?.();
	};

	const dial = (): Promise<void> => {
		if (closed) {
			return Promise.reject(new DaemonClientClosedError());
		}
		if (connectPromise) {
			return connectPromise;
		}
		if (socket && !socket.destroyed) {
			// A racing dial (manual connect vs the backoff timer) must never stack
			// a second live connection: the orphaned socket would keep delivering
			// duplicate events and hold a phantom daemon connection open.
			return Promise.resolve();
		}
		if (hasAttemptedDial && options.refreshEndpoint) {
			try {
				const refreshed = options.refreshEndpoint();
				if (refreshed) {
					// Replace the complete endpoint so a tokenless legacy pidfile also
					// clears credentials from the previous daemon instance.
					endpoint = {
						socketPath: refreshed.socketPath,
						...(refreshed.authToken === undefined ? {} : { authToken: refreshed.authToken }),
					};
				}
			} catch (error) {
				const refreshError = error instanceof Error ? error : new Error(String(error));
				if (reconnectEnabled) {
					scheduleReconnect();
				} else {
					goneReason = "dial_failed";
					setState("gone");
				}
				return Promise.reject(refreshError);
			}
		}
		hasAttemptedDial = true;
		const dialEndpoint = endpoint;
		connectPromise = new Promise<void>((resolve, reject) => {
			const dialed = createConnection(dialEndpoint.socketPath);
			dialing = dialed;
			const decoder = new ControlLineDecoder();
			let acked = false;
			let dialSettled = false;
			const helloTimer = setTimeout(() => {
				failDial(new Error("daemon hello timed out"));
			}, helloTimeoutMs);
			helloTimer.unref?.();

			const failDial = (error: Error, fatalReason?: DaemonClientGoneReason) => {
				if (dialSettled) {
					return;
				}
				dialSettled = true;
				clearTimeout(helloTimer);
				connectPromise = undefined;
				dialing = undefined;
				dialed.destroy();
				if (fatalReason) {
					closed = true;
					goneReason = fatalReason;
					setState("gone");
				} else if (reconnectEnabled && !closed) {
					scheduleReconnect();
				} else {
					goneReason = "dial_failed";
					setState("gone");
				}
				reject(error);
			};

			dialed.on("connect", () => {
				dialed.write(
					encodeControlLine({
						type: "hello",
						role: "control",
						protocolVersion: PROTOCOL_VERSION,
						pid: process.pid,
						version: options.version,
						client: options.client,
						...(dialEndpoint.authToken === undefined ? {} : { controlToken: dialEndpoint.authToken }),
						...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
					}),
				);
			});
			dialed.on("data", (chunk) => {
				let messages: unknown[];
				try {
					messages = decoder.push(chunk);
				} catch (error) {
					dialed.destroy(error instanceof Error ? error : new Error(String(error)));
					return;
				}
				for (const message of messages) {
					if (!acked) {
						if (!isHelloAck(message)) {
							failDial(new Error("daemon did not answer hello"));
							return;
						}
						const ack: HelloAck = message;
						if (!ack.ok) {
							failDial(
								new Error(`daemon rejected hello: ${ack.error ?? "unknown"}`),
								ack.error === "protocol_mismatch" ? "protocol_mismatch" : undefined,
							);
							return;
						}
						if (closed) {
							// close() ran while this dial was mid-handshake. Do not adopt
							// the socket or flip to "connected"; drop the late ack and the
							// now-orphaned connection instead of leaking it.
							dialSettled = true;
							clearTimeout(helloTimer);
							connectPromise = undefined;
							dialing = undefined;
							dialed.destroy();
							return;
						}
						acked = true;
						dialSettled = true;
						clearTimeout(helloTimer);
						dialing = undefined;
						socket = dialed;
						connectedEndpoint = dialEndpoint;
						serverInfo = {
							version: ack.version,
							protocolVersion: ack.protocolVersion,
							connectionId: ack.connectionId,
						};
						backoffMs = minBackoffMs;
						// A pending backoff dial is now redundant (and dial()'s live-socket
						// guard would make it a no-op anyway); drop it.
						if (reconnectTimer) {
							clearTimeout(reconnectTimer);
							reconnectTimer = undefined;
						}
						connectPromise = undefined;
						goneReason = undefined;
						setState("connected");
						resolve();
						continue;
					}
					if (isControlResponse(message)) {
						const entry = pending.get(message.id);
						if (entry) {
							if (isProvisionalControlResponse(message)) {
								const followUp = registerPending(message.id);
								// Unclaimed on disconnect is fine; waitForResponse consumers
								// still observe the rejection through the same promise.
								followUp.catch(() => {});
								followUps.set(message.id, followUp);
							} else {
								// Keep any armed followUps entry: the terminal response may
								// resolve it before waitForResponse claims it.
								pending.delete(message.id);
							}
							entry.resolve(message);
						}
						continue;
					}
					if (isControlEvent(message)) {
						options.onEvent?.(message);
					}
				}
			});
			dialed.on("error", (error) => {
				if (!acked) {
					failDial(error instanceof Error ? error : new Error(String(error)));
				}
			});
			dialed.on("close", () => {
				if (!acked) {
					failDial(new DaemonClientClosedError("daemon connection closed before hello"));
					return;
				}
				if (socket === dialed) {
					socket = undefined;
					connectedEndpoint = undefined;
					serverInfo = undefined;
					failPending();
					if (closed) {
						return;
					}
					if (reconnectEnabled) {
						scheduleReconnect();
					} else {
						// A reconnect-disabled client (e.g. `volt remote pair`) has no path
						// back to the daemon once its established connection drops.
						// Transition to "gone" so onConnectionStateChange fires and callers
						// awaiting the connection (whenConnectionLost) unblock instead of
						// hanging forever.
						goneReason = "closed";
						setState("gone");
					}
				}
			});
		});
		return connectPromise;
	};

	const send = (request: ControlRequest): void => {
		if (!socket || socket.destroyed) {
			throw new DaemonClientClosedError("not connected to daemon");
		}
		socket.write(encodeControlLine(request));
	};

	const registerPending = (id: string): Promise<ControlResponse> => {
		return new Promise<ControlResponse>((resolve, reject) => {
			pending.set(id, { resolve, reject });
		});
	};

	return {
		get connectionState() {
			return state;
		},
		get serverInfo() {
			return serverInfo;
		},
		get goneReason() {
			return goneReason;
		},
		async connect() {
			if (closed) {
				throw new DaemonClientClosedError();
			}
			if (socket && !socket.destroyed) {
				return;
			}
			await dial();
		},
		async request(req) {
			if (!socket || socket.destroyed) {
				if (reconnectTimer && !connectPromise) {
					throw new DaemonClientClosedError("not connected to daemon");
				}
				await this.connect();
			}
			const id = randomUUID();
			const responsePromise = registerPending(id);
			send({ ...req, id } as ControlRequest);
			return responsePromise;
		},
		waitForResponse(id: string) {
			const followUp = followUps.get(id);
			if (followUp) {
				followUps.delete(id);
				return followUp;
			}
			return registerPending(id);
		},
		openRelay(offer: RelayOfferInfo) {
			// Established clients use the exact endpoint that issued the offer;
			// direct relay-only clients retain the original static endpoint.
			const relayEndpoint = connectedEndpoint ?? endpoint;
			return new Promise((resolve, reject) => {
				const relaySocket = createConnection(relayEndpoint.socketPath);
				const decoder = new ControlLineDecoder();
				let acked = false;
				let settled = false;

				const fail = (error: Error) => {
					if (settled) {
						return;
					}
					settled = true;
					relaySocket.destroy();
					reject(error);
				};

				const onData = (chunk: Buffer) => {
					try {
						// One line at a time: bytes after the preamble are raw relay
						// payload and must never be JSON-decoded.
						decoder.pushEach(chunk, (message) => {
							if (!acked) {
								if (!isHelloAck(message) || !message.ok) {
									fail(new Error("relay hello rejected"));
									return "stop";
								}
								acked = true;
								return "continue";
							}
							if (!isRelayPreamble(message)) {
								fail(new Error("expected relay preamble"));
								return "stop";
							}
							settled = true;
							relaySocket.removeListener("data", onData);
							relaySocket.pause();
							const remainder = decoder.drainRemainder();
							if (remainder.length > 0) {
								relaySocket.unshift(remainder);
							}
							resolve({ preamble: message, stream: relaySocket });
							return "stop";
						});
					} catch (error) {
						fail(error instanceof Error ? error : new Error(String(error)));
					}
				};

				relaySocket.on("connect", () => {
					relaySocket.write(
						encodeControlLine({
							type: "hello",
							role: "relay",
							protocolVersion: PROTOCOL_VERSION,
							relayId: offer.relayId,
							relayToken: offer.relayToken,
						}),
					);
				});
				relaySocket.on("data", onData);
				relaySocket.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
				relaySocket.on("close", () => fail(new DaemonClientClosedError("relay connection closed")));
			});
		},
		async close() {
			closed = true;
			goneReason = "closed";
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
			failPending();
			socket?.destroy();
			socket = undefined;
			connectedEndpoint = undefined;
			// Destroy a dial that is still mid-handshake; otherwise a late hello_ack
			// would leave a live, owner-less daemon connection open.
			dialing?.destroy();
			dialing = undefined;
			connectPromise = undefined;
			setState("gone");
		},
	};
}
