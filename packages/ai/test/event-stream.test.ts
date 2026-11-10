import { describe, expect, it, vi } from "vitest";
import {
	drainEventStream,
	EVENT_STREAM_MAX_QUEUED_BYTES,
	EVENT_STREAM_MAX_QUEUED_EVENTS,
	EventStream,
	EventStreamOverflowError,
} from "../src/utils/event-stream.ts";

describe("EventStream", () => {
	it("reports live event and byte pressure without consuming events", async () => {
		const stream = new EventStream<string>(
			(event) => event === "done",
			(event) => event,
		);
		stream.push("first");
		const firstBytes = stream.getQueueMetrics().queuedBytes;
		stream.push("second");
		const totalBytes = stream.getQueueMetrics().queuedBytes;
		expect(firstBytes).toBeGreaterThan(0);
		expect(totalBytes).toBeGreaterThan(firstBytes);
		expect(stream.getQueueMetrics()).toEqual({
			queuedEvents: 2,
			peakQueuedEvents: 2,
			queuedBytes: totalBytes,
			peakQueuedBytes: totalBytes,
			coalescedEvents: 0,
			waitingConsumers: 0,
		});
		const iterator = stream[Symbol.asyncIterator]();
		await expect(iterator.next()).resolves.toEqual({ value: "first", done: false });
		expect(stream.getQueueMetrics().queuedBytes).toBe(totalBytes - firstBytes);
		await iterator.next();
		const waiting = iterator.next();
		expect(stream.getQueueMetrics()).toEqual({
			queuedEvents: 0,
			peakQueuedEvents: 2,
			queuedBytes: 0,
			peakQueuedBytes: totalBytes,
			coalescedEvents: 0,
			waitingConsumers: 1,
		});
		stream.push("done");
		await waiting;
		expect(stream.getQueueMetrics().waitingConsumers).toBe(0);
	});

	it("fails explicitly at the event bound and releases stale events immediately", async () => {
		const stream = new EventStream<number>(
			(event) => event === -1,
			(event) => event,
		);
		for (let index = 0; index < EVENT_STREAM_MAX_QUEUED_EVENTS; index++) stream.push(index);
		expect(() => stream.push(0)).toThrow(EventStreamOverflowError);
		expect(stream.getQueueMetrics()).toMatchObject({
			queuedEvents: 0,
			queuedBytes: 0,
			peakQueuedEvents: EVENT_STREAM_MAX_QUEUED_EVENTS,
		});
		expect(stream.getQueueMetrics().peakQueuedBytes).toBeLessThanOrEqual(EVENT_STREAM_MAX_QUEUED_BYTES);
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

	it.each([false, true])("does not invoke nested getters while accounting for events (frozen: %s)", async (frozen) => {
		let reads = 0;
		const details = {
			get count(): number {
				reads++;
				throw new Error("Invalid diagnostic getter");
			},
		};
		const event = { details };
		if (frozen) {
			Object.freeze(details);
			Object.freeze(event);
		}
		const stream = new EventStream<typeof event>(
			() => true,
			(value) => value,
		);

		expect(() => stream.push(event)).not.toThrow();
		expect(reads).toBe(0);
		expect(await stream.result()).toBe(event);
		expect((await stream[Symbol.asyncIterator]().next()).value).toBe(event);
		expect(reads).toBe(0);
	});

	it("still enforces the byte bound on data beside an accessor", async () => {
		const event = {
			get count(): number {
				throw new Error("Invalid diagnostic getter");
			},
			text: "x".repeat(EVENT_STREAM_MAX_QUEUED_BYTES),
		};
		const stream = new EventStream<typeof event>(
			() => false,
			(value) => value,
		);

		expect(() => stream.push(event)).toThrow(EventStreamOverflowError);
		await expect(stream.result()).rejects.toMatchObject({ limit: "bytes" });
		await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ limit: "bytes" });
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

describe("EventStream coalescing", () => {
	/** An event that starts with "+" extends the queued event before it. */
	const append = (queued: string, next: string): string | undefined =>
		next.startsWith("+") ? queued + next.slice(1) : undefined;

	function coalescingStream(coalesce: (queued: string, next: string) => string | undefined = append) {
		return new EventStream<string>(
			(event) => event === "done",
			(event) => event,
			undefined,
			coalesce,
		);
	}

	/** What a stream charges for holding exactly these events. */
	function chargeOf(events: readonly string[]): number {
		const reference = new EventStream<string>(
			() => false,
			(event) => event,
		);
		for (const event of events) reference.push(event);
		return reference.getQueueMetrics().queuedBytes;
	}

	it("charges only the retained entries and releases each charge when it is consumed", async () => {
		const stream = coalescingStream();
		for (const event of ["a", "+bb", "+ccc", "d", "+e"]) stream.push(event);
		const retained = chargeOf(["abbccc", "de"]);
		expect(stream.getQueueMetrics()).toEqual({
			queuedEvents: 2,
			peakQueuedEvents: 2,
			queuedBytes: retained,
			peakQueuedBytes: retained,
			coalescedEvents: 3,
			waitingConsumers: 0,
		});

		const iterator = stream[Symbol.asyncIterator]();
		await expect(iterator.next()).resolves.toEqual({ value: "abbccc", done: false });
		expect(stream.getQueueMetrics().queuedBytes).toBe(chargeOf(["de"]));
		await expect(iterator.next()).resolves.toEqual({ value: "de", done: false });
		expect(stream.getQueueMetrics()).toMatchObject({
			queuedEvents: 0,
			queuedBytes: 0,
			peakQueuedBytes: retained,
			coalescedEvents: 3,
		});
	});

	it("lowers the charge when a replacement is smaller and keeps the peak", () => {
		const stream = coalescingStream((_queued, next) => (next === "reset" ? "" : undefined));
		stream.push("x".repeat(1000));
		const peak = stream.getQueueMetrics().queuedBytes;
		stream.push("reset");
		expect(stream.getQueueMetrics()).toMatchObject({
			queuedEvents: 1,
			queuedBytes: chargeOf([""]),
			peakQueuedBytes: peak,
			coalescedEvents: 1,
		});
		expect(chargeOf([""])).toBeLessThan(peak);
	});

	it("offers only a queued event and a following non-completion event", async () => {
		const coalesce = vi.fn(append);
		const stream = coalescingStream(coalesce);
		const iterator = stream[Symbol.asyncIterator]();

		// A waiting consumer takes the event; nothing is queued to combine with.
		const waiting = iterator.next();
		stream.push("a");
		await expect(waiting).resolves.toEqual({ value: "a", done: false });
		stream.push("+b");
		expect(coalesce).not.toHaveBeenCalled();

		stream.push("+c");
		stream.push("d");
		stream.push("done");
		expect(coalesce.mock.calls).toEqual([
			["+b", "+c"],
			["+bc", "d"],
		]);
		await expect(stream.result()).resolves.toBe("done");
		const events: string[] = [];
		for (let next = await iterator.next(); !next.done; next = await iterator.next()) events.push(next.value);
		expect(events).toEqual(["+bc", "d", "done"]);
		expect(stream.getQueueMetrics().coalescedEvents).toBe(1);
	});

	it("combines into the tail of a full queue and still bounds events that cannot combine", async () => {
		const stream = coalescingStream();
		for (let index = 0; index < EVENT_STREAM_MAX_QUEUED_EVENTS; index++) stream.push(String(index));
		for (let index = 0; index < EVENT_STREAM_MAX_QUEUED_EVENTS; index++) stream.push("+x");
		expect(stream.getQueueMetrics()).toMatchObject({
			queuedEvents: EVENT_STREAM_MAX_QUEUED_EVENTS,
			peakQueuedEvents: EVENT_STREAM_MAX_QUEUED_EVENTS,
			coalescedEvents: EVENT_STREAM_MAX_QUEUED_EVENTS,
		});
		expect(() => stream.push("separate")).toThrow(EventStreamOverflowError);
		expect(stream.getQueueMetrics()).toMatchObject({ queuedEvents: 0, queuedBytes: 0 });
		await expect(stream.result()).rejects.toMatchObject({ limit: "events" });
	});

	it("fails at the byte bound when a combined entry alone exceeds it", async () => {
		const stream = coalescingStream((_queued, next) =>
			next === "grow" ? "x".repeat(EVENT_STREAM_MAX_QUEUED_BYTES) : undefined,
		);
		stream.push("small");
		expect(() => stream.push("grow")).toThrow(EventStreamOverflowError);
		expect(stream.getQueueMetrics()).toMatchObject({ queuedEvents: 0, queuedBytes: 0, coalescedEvents: 0 });
		await expect(stream.result()).rejects.toMatchObject({ code: "event_stream_queue_overflow", limit: "bytes" });
		await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ limit: "bytes" });
	});

	it("installs the overflow terminal when a combined entry exceeds the byte bound", async () => {
		const overflowEvent = vi.fn((_error: EventStreamOverflowError, _event: string) => "done");
		const stream = new EventStream<string>(
			(event) => event === "done",
			(event) => event,
			overflowEvent,
			(_queued, next) => (next === "grow" ? "x".repeat(EVENT_STREAM_MAX_QUEUED_BYTES) : undefined),
		);
		stream.push("small");
		expect(() => stream.push("grow")).toThrow(EventStreamOverflowError);
		expect(overflowEvent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ limit: "bytes" }), "grow");
		await expect(stream.result()).resolves.toBe("done");
		await expect(stream[Symbol.asyncIterator]().next()).resolves.toEqual({ value: "done", done: false });
	});

	it("queues every event separately without a coalesce hook", () => {
		const stream = new EventStream<string>(
			(event) => event === "done",
			(event) => event,
		);
		for (const event of ["a", "+b", "+c"]) stream.push(event);
		expect(stream.getQueueMetrics()).toMatchObject({
			queuedEvents: 3,
			queuedBytes: chargeOf(["a", "+b", "+c"]),
			coalescedEvents: 0,
		});
	});
});
