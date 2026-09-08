import { describe, expect, it } from "vitest";
import {
	drainEventStream,
	EVENT_STREAM_MAX_QUEUED_BYTES,
	EVENT_STREAM_MAX_QUEUED_EVENTS,
	EventStream,
	EventStreamOverflowError,
} from "../src/utils/event-stream.ts";

describe("EventStream", () => {
	it("fails explicitly at the event bound and releases stale events immediately", async () => {
		const stream = new EventStream<number>(
			(event) => event === -1,
			(event) => event,
		);
		for (let index = 0; index < EVENT_STREAM_MAX_QUEUED_EVENTS; index++) stream.push(index);
		expect(() => stream.push(0)).toThrow(EventStreamOverflowError);
		await expect(stream.result()).rejects.toMatchObject({ code: "event_stream_queue_overflow", limit: "events" });
		await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ limit: "events" });
		stream.push(-1);
		await expect(stream.result()).rejects.toBeInstanceOf(EventStreamOverflowError);
	});

	it("bounds queued data even when only one oversized event arrives", async () => {
		const stream = new EventStream<string>(
			() => false,
			(event) => event,
		);
		expect(() => stream.push("x".repeat(EVENT_STREAM_MAX_QUEUED_BYTES))).toThrow(EventStreamOverflowError);
		await expect(stream.result()).rejects.toMatchObject({ limit: "bytes" });
	});

	it("charges changing children of shallow-frozen events and releases charges when consumed", async () => {
		const nested = { text: "small" };
		const event = Object.freeze({ nested });
		const stream = new EventStream<typeof event>(
			() => false,
			(value) => value,
		);
		stream.push(event);
		const iterator = stream[Symbol.asyncIterator]();
		await iterator.next();
		nested.text = "x".repeat(EVENT_STREAM_MAX_QUEUED_BYTES);
		expect(() => stream.push(event)).toThrow(EventStreamOverflowError);
		await expect(iterator.next()).rejects.toMatchObject({ limit: "bytes" });
	});

	it("explicit draining supports result-only consumers without changing result replay", async () => {
		const stream = new EventStream<number>(
			(event) => event === -1,
			(event) => event,
		);
		const result = drainEventStream(stream);
		for (let index = 0; index < EVENT_STREAM_MAX_QUEUED_EVENTS * 2; index++) {
			stream.push(index);
			await Promise.resolve();
			await Promise.resolve();
		}
		stream.push(-1);
		await expect(result).resolves.toBe(-1);

		const replay = new EventStream<string>(
			() => true,
			(event) => event,
		);
		replay.push("done");
		await expect(replay.result()).resolves.toBe("done");
		await expect(replay[Symbol.asyncIterator]().next()).resolves.toEqual({ value: "done", done: false });
	});
	it("settles every waiting iterator when a completion event arrives", async () => {
		const stream = new EventStream<string, string>(
			(event) => event === "done",
			(event) => event,
		);
		const firstIterator = stream[Symbol.asyncIterator]();
		const secondIterator = stream[Symbol.asyncIterator]();
		const firstNext = firstIterator.next();
		const secondNext = secondIterator.next();

		stream.push("done");

		await expect(firstNext).resolves.toEqual({ value: "done", done: false });
		await expect(secondNext).resolves.toEqual({ value: undefined, done: true });
		await expect(firstIterator.next()).resolves.toEqual({ value: undefined, done: true });
		await expect(stream.result()).resolves.toBe("done");
	});

	it("rejects iteration and result after draining queued events on failure", async () => {
		const stream = new EventStream<string, string>(
			(event) => event === "done",
			(event) => event,
		);
		const failure = new Error("stream failed");
		stream.push("queued");
		stream.fail(failure);

		const events: string[] = [];
		await expect(
			(async () => {
				for await (const event of stream) {
					events.push(event);
				}
			})(),
		).rejects.toBe(failure);
		expect(events).toEqual(["queued"]);
		await expect(stream.result()).rejects.toBe(failure);
	});

	it("rejects an iterator already waiting for the next event", async () => {
		const stream = new EventStream<string, string>(
			(event) => event === "done",
			(event) => event,
		);
		const iterator = stream[Symbol.asyncIterator]();
		const next = iterator.next();
		const failure = new Error("stream failed");
		stream.fail(failure);

		await expect(next).rejects.toBe(failure);
	});
});
