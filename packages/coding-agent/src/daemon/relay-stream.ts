import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { DuplexWriteGate, StreamClosedError } from "../core/protocol/transport/duplex-write-gate.ts";
import type { IrohBiStreamLike, IrohBytes } from "../core/protocol/transport/iroh-transport.ts";
import type { DistributiveOmit } from "./control-client.ts";
import { encodeControlLine, type RelayCloseReason, type RelayPreamble } from "./control-protocol.ts";
import {
	createLifecycleFencedIrohStream,
	type IrohPhysicalTaskObserver,
	isIrohStreamLifecycleClosedError,
	runLifecycleFencedPhysicalOperation,
} from "./iroh-stream-lifecycle.ts";

export const RELAY_TOKEN_TTL_MS = 10_000;
export const RELAY_OFFER_RETRY_AFTER_MS = 1_000;

const RELAY_READ_LIMIT = 64 * 1024;
/** Bytes a relayed socket's adapter holds unread before it stops reading the socket. */
export const RELAY_SOCKET_BUFFER_BYTES = 1024 * 1024;
const RELAY_EXPIRY_MESSAGE = "relay offer expired; retry";
const RELAY_PENDING_CLOSE_MESSAGE = "relay offer cancelled; retry";

export type RelayLifecyclePhase = "offered" | "active" | "closed";

export interface RelayOutcome {
	reason: RelayCloseReason;
	bytesUp: number;
	bytesDown: number;
	durationMs: number;
	error?: string;
}

export interface RelayPendingRejection {
	message: string;
	retryAfterMs?: number;
}

export interface RelayCloseOptions {
	/** Deferred phone-handshake failure sent only when the relay is still offered. */
	pendingMessage?: string;
	retryAfterMs?: number;
	/** Optional diagnostic attached to the terminal relay outcome. */
	error?: string;
}

export type RelayRpcAuthorizationResult =
	| { ok: true; relay: RelayLifecycleOwner }
	| { ok: false; code: "not_found" | "not_held" | "session_mismatch"; message: string };

export interface MintRelayOptions {
	workspaceName: string;
	sessionId: string;
	clientNodeId: string;
	connectionId: string;
	ownerControlConnectionId: string;
	streamId: string;
	stream: IrohBiStreamLike;
	preamble: DistributiveOmit<RelayPreamble, "type" | "relayId">;
	now?: number;
	/** Writes the terminal phone-handshake failure for an unredeemed offer. */
	rejectPending(rejection: RelayPendingRejection): Promise<void> | void;
	/** Exactly-once notification paired with the owner's `settled` promise. */
	onSettled(outcome: RelayOutcome): Promise<void> | void;
	/** Owns raw phone/socket settlement after logical relay closure. */
	observePhysicalTask?: IrohPhysicalTaskObserver;
}

type RelayLifecycleOwnerHooks = {
	onClosing(owner: RelayLifecycleOwner): void;
};

/**
 * One stable lifecycle owner from relay offer through redemption and close.
 * It owns token expiry, the promoted byte pump, and exactly-once settlement.
 */
export class RelayLifecycleOwner {
	readonly relayId: string;
	readonly relayToken: string;
	readonly workspaceName: string;
	readonly sessionId: string;
	readonly clientNodeId: string;
	readonly connectionId: string;
	readonly ownerControlConnectionId: string;
	readonly streamId: string;
	readonly preamble: RelayPreamble;
	readonly expiresAt: number;
	readonly settled: Promise<RelayOutcome>;

	private readonly physicalStream: IrohBiStreamLike;
	private readonly stream: IrohBiStreamLike;
	private readonly closeController = new AbortController();
	private readonly observePhysicalTask: IrohPhysicalTaskObserver;
	private readonly rejectPending: MintRelayOptions["rejectPending"];
	private readonly onSettled: MintRelayOptions["onSettled"];
	private readonly hooks: RelayLifecycleOwnerHooks;
	private resolveSettled: (outcome: RelayOutcome) => void = () => {};
	private expiryTimer: ReturnType<typeof setTimeout> | undefined;
	private lifecyclePhase: RelayLifecyclePhase = "offered";
	private activeStartedAt: number | undefined;
	private socket: Socket | undefined;
	private writeGate: DuplexWriteGate | undefined;
	private closeReason: RelayCloseReason | undefined;
	private bytesUp = 0;
	private bytesDown = 0;
	private writeQueue: Promise<void> = Promise.resolve();
	private physicalWriteTail: Promise<void> = Promise.resolve();
	private phoneToTuiPump: Promise<void> | undefined;
	private terminalClosePromise: Promise<void> | undefined;
	private terminalError: string | undefined;
	private writeFailed = false;

	private constructor(options: MintRelayOptions, hooks: RelayLifecycleOwnerHooks) {
		this.relayId = `rl-${randomUUID()}`;
		this.relayToken = randomBytes(32).toString("base64url");
		this.workspaceName = options.workspaceName;
		this.sessionId = options.sessionId;
		this.clientNodeId = options.clientNodeId;
		this.connectionId = options.connectionId;
		this.ownerControlConnectionId = options.ownerControlConnectionId;
		this.streamId = options.streamId;
		this.physicalStream = options.stream;
		this.observePhysicalTask = (task) => {
			void task.catch(() => {});
			options.observePhysicalTask?.(task);
		};
		this.stream = createLifecycleFencedIrohStream(
			options.stream,
			this.closeController.signal,
			this.observePhysicalTask,
		);
		this.preamble = { ...options.preamble, type: "relay_preamble", relayId: this.relayId };
		this.expiresAt = (options.now ?? Date.now()) + RELAY_TOKEN_TTL_MS;
		this.rejectPending = options.rejectPending;
		this.onSettled = options.onSettled;
		this.hooks = hooks;
		this.settled = new Promise<RelayOutcome>((resolve) => {
			this.resolveSettled = resolve;
		});

		const expiryDelayMs = Math.max(0, this.expiresAt - Date.now());
		this.expiryTimer = setTimeout(() => {
			void this.close("error", {
				pendingMessage: RELAY_EXPIRY_MESSAGE,
				retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
			});
		}, expiryDelayMs);
		this.expiryTimer.unref?.();
	}

	static create(options: MintRelayOptions, hooks: RelayLifecycleOwnerHooks): RelayLifecycleOwner {
		return new RelayLifecycleOwner(options, hooks);
	}

	get phase(): RelayLifecyclePhase {
		return this.lifecyclePhase;
	}

	/**
	 * Promote this exact owner from offered to active and install its raw pump.
	 * Invalid, expired, already-used, and closed offers fail without replacement.
	 */
	redeem(relayToken: string, socket: Socket, bufferedRemainder: Buffer, now = Date.now()): boolean {
		if (this.lifecyclePhase !== "offered" || this.relayToken !== relayToken) {
			return false;
		}
		if (now > this.expiresAt) {
			void this.close("error", {
				pendingMessage: RELAY_EXPIRY_MESSAGE,
				retryAfterMs: RELAY_OFFER_RETRY_AFTER_MS,
			});
			return false;
		}

		this.lifecyclePhase = "active";
		this.clearExpiryTimer();
		this.activeStartedAt = now;
		this.socket = socket;
		this.writeGate = new DuplexWriteGate(socket);
		this.observePhysicalTask(this.writeGate.closed);

		socket.write(encodeControlLine({ type: "hello_ack", ok: true }));
		socket.write(encodeControlLine(this.preamble));

		if (bufferedRemainder.length > 0) {
			this.enqueueWrite(bufferedRemainder, false);
		}
		socket.on("data", (chunk: Buffer) => this.enqueueWrite(chunk, true));
		socket.on("error", (error: Error) => this.beginActiveClose("error", "abortive", error.message));
		// A close without a daemon-initiated reason or a socket error is the TUI
		// going away (process exit, socket destroy).
		socket.on("close", () => this.beginActiveClose(this.closeReason ?? "tui_disconnected", "abortive"));
		socket.on("end", () => {
			// TUI half-closed: preserve every admitted byte before sending FIN.
			this.beginActiveClose(this.closeReason ?? "tui_disconnected", "graceful");
		});

		this.phoneToTuiPump = this.pumpPhoneToTui();
		return true;
	}

	/**
	 * Fence and close this owner exactly once. Offered closes reject the deferred
	 * phone handshake; active closes tear down the promoted pump.
	 */
	close(reason: RelayCloseReason, options: RelayCloseOptions = {}): Promise<RelayOutcome> {
		if (this.lifecyclePhase === "closed") {
			return this.settled;
		}
		if (this.lifecyclePhase === "active") {
			this.closeReason ??= reason;
			this.beginActiveClose(reason, "abortive", options.error);
			return this.settled;
		}

		this.fenceClosing();
		this.recordTerminalError(options.error);
		const rejection: RelayPendingRejection = {
			message: options.pendingMessage ?? RELAY_PENDING_CLOSE_MESSAGE,
			...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
		};
		this.startOfferedPhysicalClose(rejection);
		this.startTerminalClose(
			{
				reason,
				bytesUp: 0,
				bytesDown: 0,
				durationMs: 0,
			},
			() => Promise.resolve(),
		);
		this.fencePhysicalWaits();
		return this.settled;
	}

	private clearExpiryTimer(): void {
		if (this.expiryTimer !== undefined) {
			clearTimeout(this.expiryTimer);
			this.expiryTimer = undefined;
		}
	}

	private enqueueWrite(chunk: Buffer, pauseSocket: boolean): void {
		if (this.lifecyclePhase !== "active") {
			return;
		}
		this.bytesUp += chunk.length;
		if (pauseSocket) {
			this.socket?.pause();
		}
		const bytes = Array.from(chunk);
		const physicalWrite = this.physicalWriteTail.then(() => this.physicalStream.send.writeAll(bytes));
		this.observePhysicalTask(physicalWrite);
		this.physicalWriteTail = physicalWrite.catch(() => {
			this.writeFailed = true;
		});
		this.writeQueue = this.writeQueue
			.then(() =>
				runLifecycleFencedPhysicalOperation(
					() => physicalWrite,
					this.closeController.signal,
					() => {},
				),
			)
			.then(() => {
				if (pauseSocket && this.lifecyclePhase === "active") {
					this.socket?.resume();
				}
			})
			.catch((error: unknown) => {
				if (isIrohStreamLifecycleClosedError(error)) {
					return;
				}
				this.writeFailed = true;
				this.beginActiveClose("error", "abortive", this.toErrorMessage(error));
			});
	}

	private async pumpPhoneToTui(): Promise<void> {
		try {
			while (this.lifecyclePhase === "active") {
				const chunk = await this.stream.recv.read(RELAY_READ_LIMIT);
				// read() may have been pending when a competing terminal signal fenced
				// this owner. Never admit newly returned phone bytes after that fence.
				if (this.lifecyclePhase !== "active") {
					break;
				}
				if (!chunk || chunk.length === 0) {
					break;
				}
				const buffer = Buffer.from(Array.from(chunk));
				this.bytesDown += buffer.length;
				const writeGate = this.writeGate;
				if (!writeGate) {
					break;
				}
				await this.runPhysicalOperation(() => writeGate.write(buffer));
				if (this.lifecyclePhase !== "active") {
					break;
				}
			}
			if (this.lifecyclePhase === "active") {
				this.beginActiveClose(this.closeReason ?? "phone_disconnected", "graceful");
			}
		} catch (error) {
			if (isIrohStreamLifecycleClosedError(error)) {
				return;
			}
			if (error instanceof StreamClosedError) {
				this.beginActiveClose(this.closeReason ?? "tui_disconnected", "abortive");
				return;
			}
			this.beginActiveClose("error", "abortive", this.toErrorMessage(error));
		}
	}

	private beginActiveClose(reason: RelayCloseReason, mode: "graceful" | "abortive", error?: string): void {
		if (this.lifecyclePhase !== "active") {
			this.recordTerminalError(error);
			return;
		}
		this.closeReason ??= reason;
		this.recordTerminalError(error);
		this.fenceClosing();

		const socket = this.socket;
		const writeGate = this.writeGate;
		const logicalWriteQueue = this.writeQueue;
		const logicalPhonePump = this.phoneToTuiPump ?? Promise.resolve();
		if (mode === "abortive") {
			// Stop the local source synchronously. Stream reset/stop begins in the
			// terminal task below before it waits for either retained pump.
			socket?.pause();
			socket?.destroy();
		}
		this.startActivePhysicalClose(mode, writeGate, socket);
		this.startTerminalClose(
			{
				reason: this.closeReason ?? reason,
				bytesUp: this.bytesUp,
				bytesDown: this.bytesDown,
				durationMs: Date.now() - (this.activeStartedAt ?? Date.now()),
			},
			() => Promise.allSettled([logicalWriteQueue, logicalPhonePump]).then(() => undefined),
		);
		this.fencePhysicalWaits();
	}

	private fenceClosing(): void {
		if (this.lifecyclePhase === "closed") {
			return;
		}
		this.lifecyclePhase = "closed";
		this.clearExpiryTimer();
		this.hooks.onClosing(this);
	}

	private fencePhysicalWaits(): void {
		if (!this.closeController.signal.aborted) {
			this.closeController.abort();
		}
	}

	private startTerminalClose(outcome: Omit<RelayOutcome, "error">, terminalWork: () => Promise<void>): void {
		if (this.terminalClosePromise !== undefined) {
			return;
		}
		this.terminalClosePromise = (async () => {
			try {
				await terminalWork();
			} catch (error: unknown) {
				this.recordTerminalError(error);
			}
			const terminalOutcome: RelayOutcome = {
				...outcome,
				...(this.terminalError === undefined ? {} : { error: this.terminalError }),
			};
			try {
				await this.onSettled(terminalOutcome);
			} catch {
				// Observer failure cannot reopen a physically settled owner.
			}
			this.resolveSettled(terminalOutcome);
		})();
	}

	private startOfferedPhysicalClose(rejection: RelayPendingRejection): void {
		const rejected = this.startRawPhysicalOperation(() => this.rejectPending(rejection));
		const afterRejection = rejected.catch(() => undefined);
		this.observePhysicalTask(afterRejection.then(() => this.finishPhysicalSendAfterWrites()));
		this.observePhysicalTask(afterRejection.then(() => this.physicalStream.recv.stop?.(0n)));
	}

	private startActivePhysicalClose(
		mode: "graceful" | "abortive",
		writeGate: DuplexWriteGate | undefined,
		socket: Socket | undefined,
	): void {
		if (mode === "graceful") {
			this.observePhysicalTask(this.finishPhysicalSendAfterWrites());
			if (writeGate) {
				const ending = this.startRawPhysicalOperation(() => writeGate.end());
				const destroyed = ending.finally(() => {
					if (!socket?.destroyed) socket?.destroy();
				});
				this.observePhysicalTask(destroyed);
				const disposed = writeGate.closed.finally(() => writeGate.dispose());
				this.observePhysicalTask(disposed);
			} else {
				socket?.destroy();
			}
		} else {
			this.startRawPhysicalOperation(() => this.resetPhysicalSend());
			if (writeGate) {
				const disposed = writeGate.closed.finally(() => writeGate.dispose());
				this.observePhysicalTask(disposed);
			}
		}
		this.startRawPhysicalOperation(() => this.physicalStream.recv.stop?.(0n));
	}

	private startRawPhysicalOperation(operation: () => Promise<void> | void): Promise<void> {
		let task: Promise<void>;
		try {
			task = Promise.resolve(operation());
		} catch (error: unknown) {
			this.recordTerminalError(error);
			task = Promise.reject(error);
		}
		this.observePhysicalTask(task);
		void task.catch(() => {});
		return task;
	}

	private finishPhysicalSendAfterWrites(): Promise<void> {
		const closeTask = this.physicalWriteTail.then(async () => {
			if (this.writeFailed) {
				await this.resetPhysicalSend();
				return;
			}
			try {
				await this.physicalStream.send.finish?.();
			} catch {
				await this.physicalStream.send.reset?.(0n);
			}
		});
		this.observePhysicalTask(closeTask);
		void closeTask.catch(() => {});
		return closeTask;
	}

	private runPhysicalOperation<T>(operation: () => Promise<T> | T): Promise<T> {
		return runLifecycleFencedPhysicalOperation(operation, this.closeController.signal, this.observePhysicalTask);
	}

	private resetPhysicalSend(): Promise<void> | void {
		return this.physicalStream.send.reset ? this.physicalStream.send.reset(0n) : this.physicalStream.send.finish?.();
	}

	private recordTerminalError(error: unknown): void {
		if (error === undefined || this.terminalError !== undefined) {
			return;
		}
		this.terminalError = this.toErrorMessage(error);
	}

	private toErrorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Lookup and token-admission index for relay lifecycle owners. The owner—not
 * the registry—controls expiry, promotion, close, and settlement.
 */
export class RelayRegistry {
	private readonly owners = new Map<string, RelayLifecycleOwner>();

	mint(options: MintRelayOptions): RelayLifecycleOwner {
		const owner = RelayLifecycleOwner.create(options, {
			onClosing: (closingOwner) => {
				if (this.owners.get(closingOwner.relayId) === closingOwner) {
					this.owners.delete(closingOwner.relayId);
				}
			},
		});
		this.owners.set(owner.relayId, owner);
		return owner;
	}

	get(relayId: string): RelayLifecycleOwner | undefined {
		return this.owners.get(relayId);
	}

	all(phase?: Exclude<RelayLifecyclePhase, "closed">): RelayLifecycleOwner[] {
		const owners = Array.from(this.owners.values());
		return phase === undefined ? owners : owners.filter((owner) => owner.phase === phase);
	}

	forConversation(
		clientNodeId: string,
		workspaceName: string,
		sessionId: string,
		phase?: Exclude<RelayLifecyclePhase, "closed">,
	): RelayLifecycleOwner[] {
		return this.all(phase).filter(
			(owner) =>
				owner.clientNodeId === clientNodeId &&
				owner.workspaceName === workspaceName &&
				owner.sessionId === sessionId,
		);
	}

	activeCount(): number {
		return this.all("active").length;
	}

	authorizeRpc(
		relayId: string,
		ownerControlConnectionId: string,
		scope: { clientNodeId: string; workspaceName: string; sessionId: string },
	): RelayRpcAuthorizationResult {
		const relay = this.owners.get(relayId);
		if (!relay || relay.phase !== "active") {
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

	/** Token lookup only; the stable owner performs the actual promotion. */
	admit(relayId: string, relayToken: string, socket: Socket, bufferedRemainder: Buffer, now = Date.now()): boolean {
		return this.owners.get(relayId)?.redeem(relayToken, socket, bufferedRemainder, now) ?? false;
	}
}

export interface RelayedIrohStreamLike extends IrohBiStreamLike {
	/** Close both directions; maps to socket.destroy(). */
	close(reason?: string): void;
	readonly closed: Promise<{ reason?: string; error?: Error }>;
}

/**
 * Wrap a relay unix-socket Duplex in the Iroh stream shape the remote
 * connection consumes. The adapter writes no close-reason trailer: a
 * host-initiated destroy surfaces as a generic closure. A stream that ends on
 * purpose writes its last frame first and finishes gracefully. It reads from
 * the socket only while less than `RELAY_SOCKET_BUFFER_BYTES` wait unread.
 */
export function adaptRelaySocketToIrohStream(socket: Duplex): RelayedIrohStreamLike {
	const chunks: Buffer[] = [];
	let bufferedBytes = 0;
	let paused = false;
	const readers: Array<{ resolve(value: IrohBytes | undefined): void; reject(error: Error): void }> = [];
	const writeGate = new DuplexWriteGate(socket);
	let ended = false;
	let closeReason: string | undefined;
	let socketError: Error | undefined;
	let resolveClosed: (value: { reason?: string; error?: Error }) => void = () => {};
	const closed = new Promise<{ reason?: string; error?: Error }>((resolve) => {
		resolveClosed = resolve;
	});

	/** Read from the socket again once what waits unread fell under the bound. */
	const consumed = (bytes: number) => {
		bufferedBytes -= bytes;
		if (paused && bufferedBytes < RELAY_SOCKET_BUFFER_BYTES) {
			paused = false;
			socket.resume();
		}
	};

	const flush = () => {
		while (readers.length > 0 && (chunks.length > 0 || ended || socketError)) {
			const reader = readers.shift();
			if (!reader) {
				return;
			}
			const chunk = chunks.shift();
			if (chunk) {
				consumed(chunk.length);
				reader.resolve(chunk);
				continue;
			}
			if (socketError) {
				reader.reject(socketError);
				continue;
			}
			reader.resolve(undefined);
		}
	};

	socket.on("data", (chunk: Buffer) => {
		chunks.push(Buffer.from(chunk));
		bufferedBytes += chunk.length;
		flush();
		if (!paused && bufferedBytes >= RELAY_SOCKET_BUFFER_BYTES) {
			paused = true;
			socket.pause();
		}
	});
	socket.on("end", () => {
		ended = true;
		flush();
	});
	socket.on("error", (error: Error) => {
		socketError = error;
		ended = true;
		flush();
	});
	socket.on("close", () => {
		ended = true;
		flush();
		writeGate.dispose();
		resolveClosed({
			...(closeReason === undefined ? {} : { reason: closeReason }),
			...(socketError === undefined ? {} : { error: socketError }),
		});
	});
	// The relay client hands the socket over explicitly paused (with the
	// post-preamble remainder unshifted); a data listener alone does not
	// un-pause an explicitly paused stream.
	socket.resume();

	return {
		recv: {
			read(sizeLimit: number): Promise<IrohBytes | undefined> {
				const queued = chunks.shift();
				if (queued) {
					if (queued.length > sizeLimit) {
						chunks.unshift(queued.subarray(sizeLimit));
						consumed(sizeLimit);
						return Promise.resolve(queued.subarray(0, sizeLimit));
					}
					consumed(queued.length);
					return Promise.resolve(queued);
				}
				if (socketError) {
					return Promise.reject(socketError);
				}
				if (ended) {
					return Promise.resolve(undefined);
				}
				return new Promise((resolve, reject) => {
					readers.push({ resolve, reject });
				});
			},
			stop(_errorCode: bigint): void {
				ended = true;
				flush();
				socket.destroy();
			},
		},
		send: {
			async writeAll(bytes: number[]): Promise<void> {
				await writeGate.write(Buffer.from(bytes));
			},
			async finish(): Promise<void> {
				await writeGate.end();
			},
		},
		close(reason?: string): void {
			closeReason = reason;
			socket.destroy();
		},
		closed,
	};
}
