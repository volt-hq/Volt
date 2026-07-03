import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DuplexWriteGate, StreamClosedError } from "../src/core/rpc/duplex-write-gate.ts";

describe("DuplexWriteGate", () => {
	it("rejects a backpressure write when the stream closes", async () => {
		const stream = new PassThrough({ highWaterMark: 1 });
		const gate = new DuplexWriteGate(stream);
		const write = gate.write(Buffer.alloc(1024));
		stream.destroy();
		await expect(write).rejects.toBeInstanceOf(StreamClosedError);
		gate.dispose();
	});

	it("preserves real write errors", async () => {
		const stream = new PassThrough({ highWaterMark: 1 });
		const gate = new DuplexWriteGate(stream);
		const write = gate.write(Buffer.alloc(1024));
		const error = new Error("boom");
		stream.destroy(error);
		await expect(write).rejects.toBe(error);
		await expect(gate.write(Buffer.from("again"))).rejects.toBe(error);
		gate.dispose();
	});

	it("end resolves when the stream is already destroyed", async () => {
		const stream = new PassThrough();
		const gate = new DuplexWriteGate(stream);
		stream.destroy();
		await expect(gate.end()).resolves.toBeUndefined();
		gate.dispose();
	});
});
