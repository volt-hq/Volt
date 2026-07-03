import { Buffer } from "node:buffer";
import type { Duplex } from "node:stream";
import { DuplexWriteGate } from "../../core/rpc/duplex-write-gate.ts";
import type { IrohBiStreamLike, IrohBytes } from "../../core/rpc/iroh-transport.ts";

export interface RelayedIrohStreamLike extends IrohBiStreamLike {
	/** Close both directions; maps to socket.destroy(). */
	close(reason?: string): void;
	readonly closed: Promise<{ reason?: string; error?: Error }>;
}

/**
 * Wrap a relay unix-socket Duplex in the Iroh stream shape consumed by
 * runIrohRemoteRpcMode. The adapter writes no close-reason trailer: the daemon
 * owns close-reason signaling to the phone, so a TUI-initiated destroy
 * surfaces as a generic closure (lease release/rekey closures are executed by
 * the daemon with proper reasons).
 */
export function adaptRelaySocketToIrohStream(socket: Duplex): RelayedIrohStreamLike {
	const chunks: Buffer[] = [];
	const readers: Array<{ resolve(value: IrohBytes | undefined): void; reject(error: Error): void }> = [];
	const writeGate = new DuplexWriteGate(socket);
	let ended = false;
	let closeReason: string | undefined;
	let socketError: Error | undefined;
	let resolveClosed: (value: { reason?: string; error?: Error }) => void = () => {};
	const closed = new Promise<{ reason?: string; error?: Error }>((resolve) => {
		resolveClosed = resolve;
	});

	const flush = () => {
		while (readers.length > 0 && (chunks.length > 0 || ended || socketError)) {
			const reader = readers.shift();
			if (!reader) {
				return;
			}
			const chunk = chunks.shift();
			if (chunk) {
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
		flush();
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
						return Promise.resolve(queued.subarray(0, sizeLimit));
					}
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
