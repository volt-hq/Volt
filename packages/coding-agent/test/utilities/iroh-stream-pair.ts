/**
 * Two connected in-memory Iroh bidirectional streams: what one side writes,
 * the other reads. A side's `finish` ends the other side's reads; `stop` ends
 * its own.
 */

import { Buffer } from "node:buffer";
import type { IrohBiStreamLike, IrohBytes } from "../../src/core/rpc/iroh-transport.ts";

class Pipe {
	private readonly chunks: Buffer[] = [];
	private readonly readers: Array<{ sizeLimit: number; resolve: (value: IrohBytes | undefined) => void }> = [];
	private ended = false;

	write(bytes: Buffer): void {
		if (this.ended) throw new Error("The stream is finished");
		this.chunks.push(bytes);
		this.flush();
	}

	end(): void {
		this.ended = true;
		this.flush();
	}

	read(sizeLimit: number): Promise<IrohBytes | undefined> {
		return new Promise((resolve) => {
			this.readers.push({ sizeLimit, resolve });
			this.flush();
		});
	}

	private flush(): void {
		while (this.readers.length > 0 && (this.chunks.length > 0 || this.ended)) {
			const reader = this.readers.shift()!;
			const chunk = this.chunks.shift();
			if (!chunk) {
				reader.resolve(undefined);
				continue;
			}
			if (chunk.length > reader.sizeLimit) {
				this.chunks.unshift(chunk.subarray(reader.sizeLimit));
				reader.resolve(chunk.subarray(0, reader.sizeLimit));
			} else {
				reader.resolve(chunk);
			}
		}
	}
}

export interface IrohStreamPair {
	/** The host's end. */
	readonly host: IrohBiStreamLike;
	/** The phone's end. */
	readonly phone: IrohBiStreamLike;
}

export function createIrohStreamPair(): IrohStreamPair {
	const toHost = new Pipe();
	const toPhone = new Pipe();
	const end = (into: Pipe, from: Pipe): IrohBiStreamLike => ({
		recv: {
			read: (sizeLimit) => from.read(sizeLimit),
			stop: () => from.end(),
		},
		send: {
			writeAll: async (bytes) => into.write(Buffer.from(bytes)),
			finish: async () => into.end(),
			reset: () => into.end(),
		},
	});
	return { host: end(toPhone, toHost), phone: end(toHost, toPhone) };
}
