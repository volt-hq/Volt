import { describe, expect, test } from "vitest";
import { createLoopbackRpcTransportPair } from "../src/core/rpc/loopback-transport.ts";

describe("loopback RPC transport", () => {
	test("delivers frames as structured values without serialization", () => {
		const pair = createLoopbackRpcTransportPair();
		const received: unknown[] = [];
		pair.server.onValue?.((value) => {
			received.push(value);
		});

		const frame = { type: "prompt", message: "hello", nested: { tokens: [1, 2, 3] } };
		pair.client.write(frame);

		expect(received).toEqual([frame]);
		expect(received[0]).not.toBe(frame);
	});

	test("isolates the receiver from sender mutations after write", () => {
		const pair = createLoopbackRpcTransportPair();
		const received: Array<{ message: { content: string[] } }> = [];
		pair.server.onValue?.((value) => {
			received.push(value as { message: { content: string[] } });
		});

		const frame = { type: "message_update", message: { content: ["partial"] } };
		pair.client.write(frame);
		frame.message.content.push("mutated-after-write");

		expect(received[0]?.message.content).toEqual(["partial"]);
	});

	test("serializes lazily for line subscribers", () => {
		const pair = createLoopbackRpcTransportPair();
		const lines: string[] = [];
		pair.server.onLine((line) => {
			lines.push(line);
		});

		pair.client.write({ type: "response", id: "1" });

		expect(lines).toEqual([JSON.stringify({ type: "response", id: "1" })]);
	});

	test("queues frames written before a subscriber attaches", () => {
		const pair = createLoopbackRpcTransportPair();
		pair.client.write({ type: "first" });
		pair.client.write({ type: "second" });

		const received: unknown[] = [];
		pair.server.onValue?.((value) => {
			received.push(value);
		});

		expect(received).toEqual([{ type: "first" }, { type: "second" }]);
	});

	test("falls back to JSON semantics for non-cloneable frames", () => {
		const pair = createLoopbackRpcTransportPair();
		const received: unknown[] = [];
		pair.server.onValue?.((value) => {
			received.push(value);
		});

		pair.client.write({ type: "event", callback: () => "not cloneable", kept: true } as object);

		expect(received).toEqual([{ type: "event", kept: true }]);
	});

	test("closing one endpoint's output closes the peer input and rejects further writes", () => {
		const pair = createLoopbackRpcTransportPair();
		let closed = false;
		pair.server.onClose?.(() => {
			closed = true;
		});

		pair.client.close();

		expect(closed).toBe(true);
		expect(() => pair.client.write({ type: "late" })).toThrow("output is closed");
	});
});
