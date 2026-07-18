import { Buffer } from "node:buffer";
import { randomBytes, randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { DuplexWriteGate, StreamClosedError } from "../core/rpc/duplex-write-gate.ts";
import type { IrohBiStreamLike } from "../core/rpc/iroh-transport.ts";
import { encodeControlLine, type RelayCloseReason, type RelayPreamble } from "./control-protocol.ts";

export const RELAY_TOKEN_TTL_MS = 10_000;
export const RELAY_OFFER_RETRY_AFTER_MS = 1_000;

const RELAY_READ_LIMIT = 64 * 1024;
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
	preamble: Omit<RelayPreamble, "type" | "relayId">;
	now?: number;
	/** Writes the terminal phone-handshake failure for an unredeemed offer. */
	rejectPending(rejection: RelayPendingRejection): Promise<void> | void;
	/** Exactly-once notification paired with the owner's `settled` promise. */
	onSettled(outcome: RelayOutcome): Promise<void> | void;
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

	private readonly stream: IrohBiStreamLike;
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
		this.stream = options.stream;
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
		this.startTerminalClose(
			{
				reason,
				bytesUp: 0,
				bytesDown: 0,
				durationMs: 0,
			},
			() => this.settleOfferedClose(rejection),
		);
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
		this.writeQueue = this.writeQueue
			.then(() => this.stream.send.writeAll(bytes))
			.then(() => {
				if (pauseSocket && this.lifecyclePhase === "active") {
					this.socket?.resume();
				}
			})
			.catch((error: unknown) => {
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
				await writeGate.write(buffer);
				if (this.lifecyclePhase !== "active") {
					break;
				}
			}
			if (this.lifecyclePhase === "active") {
				this.beginActiveClose(this.closeReason ?? "phone_disconnected", "graceful");
			}
		} catch (error) {
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
		const capturedWriteQueue = this.writeQueue;
		const phoneToTuiPump = this.phoneToTuiPump ?? Promise.resolve();
		if (mode === "abortive") {
			// Stop the local source synchronously. Stream reset/stop begins in the
			// terminal task below before it waits for either retained pump.
			socket?.pause();
			socket?.destroy();
		}
		this.startTerminalClose(
			{
				reason: this.closeReason ?? reason,
				bytesUp: this.bytesUp,
				bytesDown: this.bytesDown,
				durationMs: Date.now() - (this.activeStartedAt ?? Date.now()),
			},
			() =>
				mode === "graceful"
					? this.settleActiveGracefully(capturedWriteQueue, phoneToTuiPump, writeGate, socket)
					: this.settleActiveAbortively(capturedWriteQueue, phoneToTuiPump, writeGate),
		);
	}

	private fenceClosing(): void {
		if (this.lifecyclePhase === "closed") {
			return;
		}
		this.lifecyclePhase = "closed";
		this.clearExpiryTimer();
		this.hooks.onClosing(this);
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

	private async settleOfferedClose(rejection: RelayPendingRejection): Promise<void> {
		await this.observeTerminalOperation(() => this.rejectPending(rejection));
		await Promise.all([
			this.finishSendGracefully(),
			this.observeTerminalOperation(() => this.stream.recv.stop?.(0n)),
		]);
	}

	private async settleActiveGracefully(
		capturedWriteQueue: Promise<void>,
		phoneToTuiPump: Promise<void>,
		writeGate: DuplexWriteGate | undefined,
		socket: Socket | undefined,
	): Promise<void> {
		await this.observePromise(capturedWriteQueue);
		const sendClose = this.writeFailed
			? this.observeTerminalOperation(() => this.resetSend())
			: this.finishSendGracefully();
		await sendClose;

		// Start stop before waiting for the retained recv pump, but await the pump
		// before the stop promise: native read()/stop() may share a stream lock.
		const recvStop = this.observeTerminalOperation(() => this.stream.recv.stop?.(0n));
		await this.observePromise(phoneToTuiPump);
		await recvStop;
		if (writeGate) {
			await this.observeTerminalOperation(() => writeGate.end());
			if (!socket?.destroyed) {
				socket?.destroy();
			}
			await this.observePromise(writeGate.closed);
			writeGate.dispose();
		} else {
			socket?.destroy();
		}
	}

	private async settleActiveAbortively(
		capturedWriteQueue: Promise<void>,
		phoneToTuiPump: Promise<void>,
		writeGate: DuplexWriteGate | undefined,
	): Promise<void> {
		const sendReset = this.observeTerminalOperation(() => this.resetSend());
		const recvStop = this.observeTerminalOperation(() => this.stream.recv.stop?.(0n));
		await Promise.all([this.observePromise(capturedWriteQueue), this.observePromise(phoneToTuiPump)]);
		await Promise.all([sendReset, recvStop]);
		if (writeGate) {
			await this.observePromise(writeGate.closed);
			writeGate.dispose();
		}
	}

	private async observeTerminalOperation(operation: () => Promise<void> | void): Promise<void> {
		try {
			await operation();
		} catch (error: unknown) {
			this.recordTerminalError(error);
		}
	}

	private async observePromise(promise: Promise<void>): Promise<void> {
		try {
			await promise;
		} catch (error: unknown) {
			this.recordTerminalError(error);
		}
	}

	private resetSend(): Promise<void> | void {
		return this.stream.send.reset ? this.stream.send.reset(0n) : this.stream.send.finish?.();
	}

	private async finishSendGracefully(): Promise<void> {
		try {
			await this.stream.send.finish?.();
		} catch (error: unknown) {
			this.recordTerminalError(error);
			if (this.stream.send.reset) {
				await this.observeTerminalOperation(() => this.stream.send.reset?.(0n));
			}
		}
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
