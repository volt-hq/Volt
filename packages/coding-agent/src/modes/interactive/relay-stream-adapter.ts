import { Buffer } from "node:buffer";
import type { Duplex } from "node:stream";
import type { IrohBiStreamLike, IrohBytes } from "../../core/rpc/iroh-transport.ts";

export interface RelayedIrohStreamLike extends IrohBiStreamLike {
	/** Close both directions; maps to socket.destroy(). */
	close(reason?: string): void;
	readonly closed: Promise<{ reason?: string }>;
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
	const readers: Array<(value: IrohBytes | undefined) => void> = [];
	let ended = false;
	let closeReason: string | undefined;
	let resolveClosed: (value: { reason?: string }) => void = () => {};
	const closed = new Promise<{ reason?: string }>((resolve) => {
		resolveClosed = resolve;
	});

	const flush = () => {
		while (readers.length > 0 && (chunks.length > 0 || ended)) {
			const reader = readers.shift();
			if (!reader) {
				return;
			}
			reader(chunks.shift());
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
	socket.on("error", () => {
		ended = true;
		flush();
	});
	socket.on("close", () => {
		ended = true;
		flush();
		resolveClosed({ ...(closeReason === undefined ? {} : { reason: closeReason }) });
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
				if (ended) {
					return Promise.resolve(undefined);
				}
				return new Promise((resolve) => {
					readers.push(resolve);
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
				if (socket.destroyed || socket.writableEnded) {
					throw new Error("relay socket is closed");
				}
				const buffer = Buffer.from(bytes);
				if (!socket.write(buffer)) {
					await new Promise<void>((resolve, reject) => {
						const onDrain = () => {
							socket.off("error", onError);
							resolve();
						};
						const onError = (error: Error) => {
							socket.off("drain", onDrain);
							reject(error);
						};
						socket.once("drain", onDrain);
						socket.once("error", onError);
					});
				}
			},
			async finish(): Promise<void> {
				await new Promise<void>((resolve) => {
					socket.end(resolve);
				});
			},
		},
		close(reason?: string): void {
			closeReason = reason;
			socket.destroy();
		},
		closed,
	};
}
