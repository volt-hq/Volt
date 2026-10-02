/**
 * Doubles for relay tests: a fake phone Iroh bi-stream (raw-byte capable, since
 * relays must be byte-transparent, not just JSONL-transparent) and a raw relay
 * client that speaks the relay hello + preamble framing over a real socket.
 */

import { Buffer } from "node:buffer";
import { createConnection, type Socket } from "node:net";
import type {
	IrohBiStreamLike,
	IrohBytes,
	IrohRecvStreamLike,
	IrohSendStreamLike,
} from "../src/core/rpc/iroh-transport.ts";
import { encodeControlLine, PROTOCOL_VERSION } from "../src/daemon/control-protocol.ts";

type QueuedPhoneRead = { type: "data"; bytes: Buffer } | { type: "end" };

/**
 * The phone's side of an Iroh conversation stream as the daemon holds it after
 * the handshake: recv yields bytes the phone sends, writeAll captures bytes
 * the phone receives.
 */
export class FakePhoneIrohStream implements IrohBiStreamLike {
	private readonly queue: QueuedPhoneRead[] = [];
	private readonly pendingReads: Array<(value: IrohBytes | undefined) => void> = [];
	private readonly receivedChunks: Buffer[] = [];
	finished = false;
	stopped = false;

	readonly recv: IrohRecvStreamLike = {
		read: (_sizeLimit: number): Promise<IrohBytes | undefined> => {
			const queued = this.queue.shift();
			if (queued) {
				return Promise.resolve(queued.type === "data" ? queued.bytes : undefined);
			}
			return new Promise((resolve) => {
				this.pendingReads.push(resolve);
			});
		},
		stop: (_errorCode: bigint): void => {
			this.stopped = true;
			this.enqueue({ type: "end" });
		},
	};

	readonly send: IrohSendStreamLike = {
		writeAll: async (bytes: Array<number>): Promise<void> => {
			this.receivedChunks.push(Buffer.from(bytes));
		},
		finish: async (): Promise<void> => {
			this.finished = true;
		},
	};

	/** Bytes the phone sends toward the daemon. */
	sendBytes(bytes: Buffer): void {
		this.enqueue({ type: "data", bytes: Buffer.from(bytes) });
	}

	/** One JSONL conversation frame from the phone. */
	sendLine(value: object): void {
		this.sendBytes(Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
	}

	/** Phone closes its send side (EOF toward the daemon). */
	end(): void {
		this.enqueue({ type: "end" });
	}

	receivedBytes(): Buffer {
		return Buffer.concat(this.receivedChunks);
	}

	receivedFrames(): Array<Record<string, unknown>> {
		return this.receivedBytes()
			.toString("utf8")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	private enqueue(queued: QueuedPhoneRead): void {
		const reader = this.pendingReads.shift();
		if (!reader) {
			this.queue.push(queued);
			return;
		}
		reader(queued.type === "data" ? queued.bytes : undefined);
	}
}

export interface RawRelayClient {
	socket: Socket;
	/** Decoded control lines (hello_ack, then relay_preamble on success). */
	messages: Array<Record<string, unknown>>;
	/** Raw post-preamble bytes received from the daemon. */
	rawReceived(): Buffer;
	ended: () => boolean;
	closed: Promise<void>;
}

/**
 * Dial a relay connection the way the TUI's control client does, but keep the
 * framing manual so tests can assert ack/preamble ordering and raw-mode
 * switchover byte-exactly. Everything after the relay_preamble line is treated
 * as opaque bytes (never re-framed), including any remainder buffered in the
 * same chunk as the preamble.
 */
export function connectRawRelayClient(
	socketPath: string,
	hello: { relayId: string; relayToken: string; protocolVersion?: number },
): RawRelayClient {
	const socket = createConnection(socketPath);
	const messages: Array<Record<string, unknown>> = [];
	const rawChunks: Buffer[] = [];
	let buffered = Buffer.alloc(0);
	let rawMode = false;
	let sawEnd = false;
	let resolveClosed: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		resolveClosed = resolve;
	});

	socket.on("connect", () => {
		socket.write(
			encodeControlLine({
				type: "hello",
				role: "relay",
				protocolVersion: hello.protocolVersion ?? PROTOCOL_VERSION,
				relayId: hello.relayId,
				relayToken: hello.relayToken,
			}),
		);
	});
	socket.on("data", (chunk: Buffer) => {
		if (rawMode) {
			rawChunks.push(Buffer.from(chunk));
			return;
		}
		buffered = Buffer.concat([buffered, chunk]);
		while (!rawMode) {
			const newlineIndex = buffered.indexOf(0x0a);
			if (newlineIndex === -1) {
				return;
			}
			const line = buffered.subarray(0, newlineIndex).toString("utf8");
			buffered = buffered.subarray(newlineIndex + 1);
			if (line.trim().length === 0) {
				continue;
			}
			const message = JSON.parse(line) as Record<string, unknown>;
			messages.push(message);
			if (message.type === "relay_preamble") {
				rawMode = true;
				if (buffered.length > 0) {
					rawChunks.push(Buffer.from(buffered));
				}
				buffered = Buffer.alloc(0);
			}
		}
	});
	socket.on("end", () => {
		sawEnd = true;
	});
	socket.on("error", () => {});
	socket.on("close", () => {
		resolveClosed();
	});

	return {
		socket,
		messages,
		rawReceived: () => Buffer.concat(rawChunks),
		ended: () => sawEnd,
		closed,
	};
}
