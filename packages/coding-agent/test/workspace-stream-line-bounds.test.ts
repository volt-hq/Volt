import { Buffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import type { IrohBytes, IrohRecvStreamLike } from "../src/core/rpc/iroh-transport.ts";
import { DEFAULT_IROH_UTILITY_RPC_MAX_LINE_BYTES, readLineFromIroh } from "../src/daemon/workspace-streams.ts";

class FragmentedRecvStream implements IrohRecvStreamLike {
	private readonly bytes: Buffer;
	private offset = 0;

	constructor(bytes: Buffer) {
		this.bytes = bytes;
	}

	read(sizeLimit: number): Promise<IrohBytes | undefined> {
		if (this.offset >= this.bytes.length) {
			return Promise.resolve(undefined);
		}
		const end = Math.min(this.bytes.length, this.offset + 257, this.offset + sizeLimit);
		const chunk = this.bytes.subarray(this.offset, end);
		this.offset = end;
		return Promise.resolve(chunk);
	}
}

describe("workspace utility stream line bounds", () => {
	test("uses a separate 64 KiB utility-RPC ceiling", () => {
		expect(DEFAULT_IROH_UTILITY_RPC_MAX_LINE_BYTES).toBe(64 * 1024);
	});

	test("rejects a fragmented utility line immediately beyond the default ceiling", async () => {
		const recv = new FragmentedRecvStream(Buffer.from("a".repeat(DEFAULT_IROH_UTILITY_RPC_MAX_LINE_BYTES + 1)));

		await expect(readLineFromIroh(recv)).rejects.toThrow(
			`Iroh RPC line exceeds maximum size of ${DEFAULT_IROH_UTILITY_RPC_MAX_LINE_BYTES} bytes`,
		);
	});
});
