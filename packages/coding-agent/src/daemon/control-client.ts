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

export interface DaemonClientOptions {
	socketPath: string;
	client: ControlClientKind;
	version: string;
	onEvent?(event: ControlEvent): void;
	onConnectionStateChange?(state: DaemonClientConnectionState): void;
	/** Reconnect forever with backoff (default true for TUI clients). */
	reconnect?: boolean;
	minBackoffMs?: number;
	maxBackoffMs?: number;
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
	/** Connect (or await the in-flight connect). Rejects when reconnect is off and the dial fails. */
	connect(): Promise<void>;
	request(req: DistributiveOmit<ControlRequest, "id">): Promise<ControlResponse>;
	/**
	 * Await the next response for a request id (used after a provisional
	 * lease_pending). Rejects with DaemonClientClosedError on disconnect.
	 */
	waitForResponse(id: string): Promise<ControlResponse>;
	/** Dial a fresh unix connection with role:"relay"; returns the raw duplex after the preamble. */
	openRelay(offer: RelayOfferInfo): Promise<{ preamble: RelayPreamble; stream: Duplex }>;
	close(): Promise<void>;
}

export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

interface PendingRequest {
	resolve(response: ControlResponse): void;
	reject(error: Error): void;
	/** keep the entry alive after a provisional response */
	provisionalSeen?: boolean;
}

const DEFAULT_MIN_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 5000;

export function createDaemonClient(options: DaemonClientOptions): DaemonClient {
	const reconnectEnabled = options.reconnect ?? true;
	const minBackoffMs = options.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
	const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

	let state: DaemonClientConnectionState = "reconnecting";
	let socket: Socket | undefined;
	let serverInfo: { version?: string; protocolVersion?: number; connectionId?: string } | undefined;
	let closed = false;
	let backoffMs = minBackoffMs;
	let reconnectTimer: NodeJS.Timeout | undefined;
	let connectPromise: Promise<void> | undefined;
	const pending = new Map<string, PendingRequest>();

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
		if (connectPromise) {
			return connectPromise;
		}
		connectPromise = new Promise<void>((resolve, reject) => {
			const dialed = createConnection(options.socketPath);
			const decoder = new ControlLineDecoder();
			let acked = false;

			const failDial = (error: Error) => {
				connectPromise = undefined;
				dialed.destroy();
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
							if (ack.error === "protocol_mismatch") {
								closed = true;
								setState("gone");
							}
							failDial(new Error(`daemon rejected hello: ${ack.error ?? "unknown"}`));
							return;
						}
						acked = true;
						socket = dialed;
						serverInfo = {
							version: ack.version,
							protocolVersion: ack.protocolVersion,
							connectionId: ack.connectionId,
						};
						backoffMs = minBackoffMs;
						connectPromise = undefined;
						setState("connected");
						resolve();
						continue;
					}
					if (isControlResponse(message)) {
						const entry = pending.get(message.id);
						if (entry) {
							if (message.type !== "lease_pending" && message.type !== "pair_started") {
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
				if (socket === dialed) {
					socket = undefined;
					serverInfo = undefined;
					failPending();
					if (!closed) {
						scheduleReconnect();
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
			await this.connect();
			const id = randomUUID();
			const responsePromise = registerPending(id);
			send({ ...req, id } as ControlRequest);
			return responsePromise;
		},
		waitForResponse(id: string) {
			return registerPending(id);
		},
		openRelay(offer: RelayOfferInfo) {
			return new Promise((resolve, reject) => {
				const relaySocket = createConnection(options.socketPath);
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
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
			failPending();
			socket?.destroy();
			socket = undefined;
			setState("gone");
		},
	};
}
