import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { DuplexWriteGate, StreamClosedError } from "../core/rpc/duplex-write-gate.ts";
import type { IrohBiStreamLike } from "../core/rpc/iroh-transport.ts";
import { encodeControlLine, type RelayCloseReason, type RelayPreamble } from "./control-protocol.ts";

export const RELAY_TOKEN_TTL_MS = 10_000;

const RELAY_READ_LIMIT = 64 * 1024;

export interface PendingRelay {
	relayId: string;
	relayToken: string;
	workspaceName: string;
	sessionId: string;
	clientNodeId: string;
	connectionId: string;
	ownerControlConnectionId: string;
	streamId: string;
	/** The phone's Iroh stream, paused until the TUI redeems the token. */
	stream: IrohBiStreamLike;
	preamble: RelayPreamble;
	expiresAt: number;
	used: boolean;
	/** Resolves when the relay finishes (either side closed). */
	settle(outcome: RelayOutcome): void;
}

export interface RelayOutcome {
	reason: RelayCloseReason;
	bytesUp: number;
	bytesDown: number;
	durationMs: number;
	error?: string;
}

export interface ActiveRelay {
	relayId: string;
	workspaceName: string;
	sessionId: string;
	clientNodeId: string;
	connectionId: string;
	ownerControlConnectionId: string;
	streamId: string;
	close(reason: RelayCloseReason): void;
}

export type RelayRpcAuthorizationResult =
	| { ok: true; relay: ActiveRelay }
	| { ok: false; code: "not_found" | "not_held" | "session_mismatch"; message: string };

export interface MintRelayOptions {
	workspaceName: string;
	sessionId: string;
	clientNodeId: string;
	connectionId: string;
	ownerControlConnectionId: string;
	streamId: string;
	stream: IrohBiStreamLike;
	preamble: Omit<RelayPreamble, "type" | "relayId">;
	now?: number;
	settle(outcome: RelayOutcome): void;
}

/**
 * Daemon-side relay lifecycle: token mint/expiry (10s, single-use), preamble
 * write, and the bidirectional raw byte pump between the phone's Iroh stream
 * and the TUI's relay unix connection. No inspection, no reframing.
 */
export class RelayRegistry {
	private readonly pending = new Map<string, PendingRelay>();
	private readonly active = new Map<string, ActiveRelay>();

	mint(options: MintRelayOptions): PendingRelay {
		const relayId = `rl-${randomUUID()}`;
		const relay: PendingRelay = {
			relayId,
			relayToken: randomBytes(32).toString("base64url"),
			workspaceName: options.workspaceName,
			sessionId: options.sessionId,
			clientNodeId: options.clientNodeId,
			connectionId: options.connectionId,
			ownerControlConnectionId: options.ownerControlConnectionId,
			streamId: options.streamId,
			stream: options.stream,
			preamble: { ...options.preamble, type: "relay_preamble", relayId },
			expiresAt: (options.now ?? Date.now()) + RELAY_TOKEN_TTL_MS,
			used: false,
			settle: options.settle,
		};
		this.pending.set(relayId, relay);
		return relay;
	}

	/** Invalidate an unredeemed offer (rekey, duplicate replacement, expiry). */
	invalidatePending(relayId: string): PendingRelay | undefined {
		const relay = this.pending.get(relayId);
		if (relay) {
			relay.used = true;
			this.pending.delete(relayId);
		}
		return relay;
	}

	pendingForConversation(clientNodeId: string, workspaceName: string, sessionId: string): PendingRelay[] {
		return Array.from(this.pending.values()).filter(
			(relay) =>
				relay.clientNodeId === clientNodeId &&
				relay.workspaceName === workspaceName &&
				relay.sessionId === sessionId,
		);
	}

	activeForConversation(clientNodeId: string, workspaceName: string, sessionId: string): ActiveRelay[] {
		return Array.from(this.active.values()).filter(
			(relay) =>
				relay.clientNodeId === clientNodeId &&
				relay.workspaceName === workspaceName &&
				relay.sessionId === sessionId,
		);
	}

	activeRelays(): ActiveRelay[] {
		return Array.from(this.active.values());
	}

	pendingRelays(): PendingRelay[] {
		return Array.from(this.pending.values());
	}

	activeCount(): number {
		return this.active.size;
	}

	authorizeRpc(
		relayId: string,
		ownerControlConnectionId: string,
		scope: { clientNodeId: string; workspaceName: string; sessionId: string },
	): RelayRpcAuthorizationResult {
		const relay = this.active.get(relayId);
		if (!relay) {
			return { ok: false, code: "not_found", message: "active relay not found" };
		}
		if (relay.ownerControlConnectionId !== ownerControlConnectionId) {
			return { ok: false, code: "not_held", message: "relay is not owned by this control connection" };
		}
		if (
			relay.clientNodeId !== scope.clientNodeId ||
			relay.workspaceName !== scope.workspaceName ||
			relay.sessionId !== scope.sessionId
		) {
			return { ok: false, code: "session_mismatch", message: "relay RPC scope does not match active relay" };
		}
		return { ok: true, relay };
	}

	closeActive(relayId: string, reason: RelayCloseReason): void {
		this.active.get(relayId)?.close(reason);
	}

	/**
	 * Redeem a relay token from a TUI relay hello. On success, acks the socket,
	 * writes the preamble line, and starts the byte pump. Returns false when the
	 * token is invalid/expired/used (caller sends bad_relay_token).
	 */
	admit(relayId: string, relayToken: string, socket: Socket, bufferedRemainder: Buffer, now = Date.now()): boolean {
		const relay = this.pending.get(relayId);
		if (!relay || relay.used || relay.relayToken !== relayToken || now > relay.expiresAt) {
			return false;
		}
		relay.used = true;
		this.pending.delete(relayId);

		socket.write(encodeControlLine({ type: "hello_ack", ok: true }));
		socket.write(encodeControlLine(relay.preamble));

		const startedAt = now;
		const writeGate = new DuplexWriteGate(socket);
		let bytesUp = 0; // TUI -> phone
		let bytesDown = 0; // phone -> TUI
		let settled = false;
		let closeReason: RelayCloseReason | undefined;

		const finish = (reason: RelayCloseReason, error?: string) => {
			if (settled) {
				return;
			}
			settled = true;
			this.active.delete(relay.relayId);
			writeGate.dispose();
			socket.destroy();
			void Promise.resolve(relay.stream.send.finish?.()).catch(() => {});
			void Promise.resolve(relay.stream.recv.stop?.(0n)).catch(() => {});
			relay.settle({
				reason: closeReason ?? reason,
				bytesUp,
				bytesDown,
				durationMs: Date.now() - startedAt,
				...(error === undefined ? {} : { error }),
			});
		};

		const activeRelay: ActiveRelay = {
			relayId: relay.relayId,
			workspaceName: relay.workspaceName,
			sessionId: relay.sessionId,
			clientNodeId: relay.clientNodeId,
			connectionId: relay.connectionId,
			ownerControlConnectionId: relay.ownerControlConnectionId,
			streamId: relay.streamId,
			close: (reason: RelayCloseReason) => {
				closeReason = reason;
				finish(reason);
			},
		};
		this.active.set(relay.relayId, activeRelay);

		// TUI -> phone: socket bytes go straight to the Iroh send stream. The
		// socket is paused while a chunk is in flight so a slow phone link cannot
		// buffer unbounded data in the write queue.
		let writeQueue: Promise<void> = Promise.resolve();
		const enqueueWrite = (chunk: Buffer, pauseSocket: boolean) => {
			bytesUp += chunk.length;
			if (pauseSocket) {
				socket.pause();
			}
			const bytes = Array.from(chunk);
			writeQueue = writeQueue
				.then(() => relay.stream.send.writeAll(bytes))
				.then(() => {
					if (pauseSocket && !settled) {
						socket.resume();
					}
				})
				.catch((error: unknown) => {
					finish("error", error instanceof Error ? error.message : String(error));
				});
		};
		if (bufferedRemainder.length > 0) {
			enqueueWrite(bufferedRemainder, false);
		}
		socket.on("data", (chunk: Buffer) => enqueueWrite(chunk, true));
		socket.on("error", (error: Error) => finish("error", error.message));
		// A close without a daemon-initiated reason or a socket error is the TUI
		// going away (process exit, socket destroy).
		socket.on("close", () => finish(closeReason ?? "tui_disconnected"));
		socket.on("end", () => {
			// TUI half-closed: propagate to the phone's send side.
			void writeQueue.then(() => Promise.resolve(relay.stream.send.finish?.())).catch(() => {});
		});

		// Phone -> TUI: pull from the Iroh recv stream into the socket.
		void (async () => {
			try {
				while (!settled) {
					const chunk = await relay.stream.recv.read(RELAY_READ_LIMIT);
					if (!chunk || chunk.length === 0) {
						break;
					}
					const buffer = Buffer.from(Array.from(chunk));
					bytesDown += buffer.length;
					await writeGate.write(buffer);
					if (settled) {
						break;
					}
				}
				if (!settled) {
					// Phone half-closed or ended: flush any bytes still buffered in the
					// socket write queue and send FIN to the TUI, waiting for the write
					// side to drain before finish() destroys the socket. A bare
					// socket.end() + immediate destroy discards the unflushed tail of the
					// phone's final response.
					await writeGate.end().catch(() => {});
					finish(closeReason ?? "phone_disconnected");
				}
			} catch (error) {
				if (error instanceof StreamClosedError) {
					finish(closeReason ?? "tui_disconnected");
					return;
				}
				finish("error", error instanceof Error ? error.message : String(error));
			}
		})();

		return true;
	}
}
