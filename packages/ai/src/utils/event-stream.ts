import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

/**
 * Limits on the events a stream holds for a consumer that has not read them. Assistant streams
 * combine queued deltas for one block, so there the limits bound only backlog that cannot merge:
 * block starts and ends, and deltas that alternate between blocks.
 */
export const EVENT_STREAM_MAX_QUEUED_EVENTS = 1024;
export const EVENT_STREAM_MAX_QUEUED_BYTES = 16 * 1024 * 1024;

export class EventStreamOverflowError extends Error {
	readonly code = "event_stream_queue_overflow";
	readonly limit: "events" | "bytes";

	constructor(limit: "events" | "bytes") {
		super(`Assistant event stream exceeded its queued ${limit} limit; the consumer is not keeping up`);
		this.name = "EventStreamOverflowError";
		this.limit = limit;
	}
}

// Generic event stream class for async iteration
type EventStreamWaiter<T> = {
	resolve: (value: IteratorResult<T>) => void;
	reject: (error: unknown) => void;
};

export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: { event: T; bytes: number }[] = [];
	private queuedBytes = 0;
	private peakQueuedEvents = 0;
	private peakQueuedBytes = 0;
	private coalescedEvents = 0;
	private readonly frozenSizes = new WeakMap<object, number>();
	private waiting: EventStreamWaiter<T>[] = [];
	private done = false;
	private failed = false;
	private failure: unknown;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private rejectFinalResult!: (error: unknown) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;
	private readonly overflowEvent: ((error: EventStreamOverflowError, event: T) => T) | undefined;
	private readonly coalesce: ((queued: T, next: T) => T | undefined) | undefined;

	/**
	 * @param coalesce Returns one event that replaces `queued`, the newest unconsumed event, and stands
	 * for `next` as well, or `undefined` to queue `next` separately. It is never given a completion
	 * event and must not return one.
	 */
	constructor(
		isComplete: (event: T) => boolean,
		extractResult: (event: T) => R,
		overflowEvent?: (error: EventStreamOverflowError, event: T) => T,
		coalesce?: (queued: T, next: T) => T | undefined,
	) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.overflowEvent = overflowEvent;
		this.coalesce = coalesce;
		this.finalResultPromise = new Promise((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
		void this.finalResultPromise.catch(() => {});
	}

	/**
	 * Hand `event` to a waiting consumer, or queue it.
	 *
	 * A queued event may be combined with the event pushed after it (see `coalesce`), so a consumer
	 * that reads more slowly than the producer pushes receives fewer events. Assistant streams combine
	 * queued deltas for one block into one delta with the newest `seq`, snapshot, and tool state, so
	 * `seq` increases and may skip values. Events are never reordered, and an event already handed to
	 * a consumer never changes.
	 *
	 * @throws EventStreamOverflowError when backlog that could not be combined exceeds a queue limit.
	 */
	push(event: T): void {
		if (this.done) return;

		// Charge conservative representation size, including snapshots. Cache only deeply
		// frozen values so unchanged snapshot subtrees do not need another traversal.
		let bytes = 0;
		if (this.waiting.length === 0) {
			const tail = this.queue.at(-1);
			const merged = tail && this.coalesce && !this.isComplete(event) ? this.coalesce(tail.event, event) : undefined;
			if (tail && merged !== undefined) {
				const mergedBytes = this.measureSize(merged, new Set()).bytes;
				const queuedBytes = this.queuedBytes - tail.bytes + mergedBytes;
				if (queuedBytes > EVENT_STREAM_MAX_QUEUED_BYTES) this.overflow("bytes", event);
				this.queue[this.queue.length - 1] = { event: merged, bytes: mergedBytes };
				this.queuedBytes = queuedBytes;
				this.peakQueuedBytes = Math.max(this.peakQueuedBytes, queuedBytes);
				this.coalescedEvents += 1;
				return;
			}
			bytes = this.measureSize(event, new Set()).bytes;
			if (this.queue.length >= EVENT_STREAM_MAX_QUEUED_EVENTS) this.overflow("events", event);
			if (this.queuedBytes + bytes > EVENT_STREAM_MAX_QUEUED_BYTES) this.overflow("bytes", event);
		}

		const completesStream = this.isComplete(event);
		if (completesStream) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter.resolve({ value: event, done: false });
		} else {
			this.queue.push({ event, bytes });
			this.queuedBytes += bytes;
			this.peakQueuedEvents = Math.max(this.peakQueuedEvents, this.queue.length);
			this.peakQueuedBytes = Math.max(this.peakQueuedBytes, this.queuedBytes);
		}

		if (completesStream) {
			while (this.waiting.length > 0) {
				this.waiting.shift()!.resolve({ value: undefined, done: true });
			}
		}
	}

	end(result?: R): void {
		if (this.done) return;
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter.resolve({ value: undefined, done: true });
		}
	}

	fail(error: unknown): void {
		if (this.done) return;
		this.done = true;
		this.failed = true;
		this.failure = error;
		this.rejectFinalResult(error);
		while (this.waiting.length > 0) {
			this.waiting.shift()!.reject(error);
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				const queued = this.queue.shift()!;
				this.queuedBytes -= queued.bytes;
				yield queued.event;
			} else if (this.done) {
				if (this.failed) throw this.failure;
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve, reject) =>
					this.waiting.push({ resolve, reject }),
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}

	/** Passive measurements of retained events and their conservative representation size. */
	getQueueMetrics(): {
		queuedEvents: number;
		peakQueuedEvents: number;
		queuedBytes: number;
		peakQueuedBytes: number;
		coalescedEvents: number;
		waitingConsumers: number;
	} {
		return {
			queuedEvents: this.queue.length,
			peakQueuedEvents: this.peakQueuedEvents,
			queuedBytes: this.queuedBytes,
			peakQueuedBytes: this.peakQueuedBytes,
			coalescedEvents: this.coalescedEvents,
			waitingConsumers: this.waiting.length,
		};
	}

	/** Fail the whole stream at a queue limit, release its backlog, and throw to the producer. */
	private overflow(limit: "events" | "bytes", event: T): never {
		const error = new EventStreamOverflowError(limit);
		// Overflow explicitly fails the whole stream and releases its backlog. Do not
		// make a slow consumer drain stale previews before learning it cannot finish.
		this.queue = [];
		this.queuedBytes = 0;
		if (this.overflowEvent) {
			const terminal = this.overflowEvent(error, event);
			// The failure terminal must itself fit the empty queue. An invalid callback
			// fails explicitly instead of recursively invoking overflow recovery.
			if (
				this.isComplete(terminal) &&
				this.measureSize(terminal, new Set()).bytes <= EVENT_STREAM_MAX_QUEUED_BYTES
			) {
				this.push(terminal);
			} else {
				this.fail(error);
			}
		} else {
			this.fail(error);
		}
		throw error;
	}

	private measureSize(value: unknown, seen: Set<object>): { bytes: number; frozen: boolean } {
		if (typeof value === "string") return { bytes: 32 + value.length * 2, frozen: true };
		if (typeof value !== "object" || value === null) return { bytes: 16, frozen: true };
		const cached = this.frozenSizes.get(value);
		if (cached !== undefined) return { bytes: cached, frozen: true };
		// Cyclic extension events are counted once, and are never cached as immutable trees.
		if (seen.has(value)) return { bytes: 16, frozen: false };
		seen.add(value);
		let bytes = 64;
		let frozen = Object.isFrozen(value);
		for (const key of Object.keys(value)) {
			// Measure retained data without executing accessors in extension metadata.
			// Accessors are opaque and do not establish a deeply immutable subtree.
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			const nested =
				descriptor && "value" in descriptor
					? this.measureSize(descriptor.value, seen)
					: { bytes: 16, frozen: false };
			bytes += 32 + key.length * 2 + nested.bytes;
			frozen &&= nested.frozen;
			if (bytes > EVENT_STREAM_MAX_QUEUED_BYTES) break;
		}
		seen.delete(value);
		if (frozen) this.frozenSizes.set(value, bytes);
		return { bytes, frozen };
	}
}

/** Consume events for callers that only need the final result, keeping the stream queue bounded. */
export async function drainEventStream<T, R>(stream: EventStream<T, R>): Promise<R> {
	for await (const _event of stream) {
		// Deliberately consume each event; result() alone retains events for later iteration.
	}
	return stream.result();
}

export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(
		overflowEvent?: (error: EventStreamOverflowError, event: AssistantMessageEvent) => AssistantMessageEvent,
	) {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") {
					return event.message;
				} else if (event.type === "error") {
					return event.error;
				}
				throw new Error("Unexpected event type for final result");
			},
			overflowEvent ?? assistantOverflowEvent,
			coalesceAssistantDeltas,
		);
	}
}

/**
 * Combine a pushed delta with the unconsumed delta before it when both extend the same block. The
 * result carries the combined delta and the newer event's `seq`, snapshot, and tool state.
 */
function coalesceAssistantDeltas(
	queued: AssistantMessageEvent,
	next: AssistantMessageEvent,
): AssistantMessageEvent | undefined {
	if (next.type === "text_delta" || next.type === "thinking_delta") {
		if (queued.type !== next.type || queued.contentIndex !== next.contentIndex) return undefined;
		return Object.freeze({ ...next, delta: queued.delta + next.delta });
	}
	if (next.type !== "toolcall_delta" || queued.type !== "toolcall_delta") return undefined;
	if (queued.contentIndex !== next.contentIndex) return undefined;
	// A delta that changes the call's identity stays a separate event.
	if (next.id !== undefined && next.id !== queued.id) return undefined;
	if (next.name !== undefined && next.name !== queued.name) return undefined;
	return Object.freeze({
		...next,
		argsTextDelta: queued.argsTextDelta + next.argsTextDelta,
		...(queued.id === undefined ? {} : { id: queued.id }),
		...(queued.name === undefined ? {} : { name: queued.name }),
	});
}

function assistantOverflowEvent(error: EventStreamOverflowError, event: AssistantMessageEvent): AssistantMessageEvent {
	const previous = "snapshot" in event ? event.snapshot : event.type === "done" ? event.message : event.error;
	const content: AssistantMessage["content"] = [];
	const diagnostics: NonNullable<AssistantMessage["diagnostics"]> = [
		Object.freeze({
			type: "assistant_stream_queue_limit",
			timestamp: Date.now(),
			details: Object.freeze({ limit: error.limit, code: error.code }),
		}),
	];
	Object.freeze(content);
	Object.freeze(diagnostics);
	const usage = Object.freeze({
		availability: "unavailable" as const,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
	});
	const message: AssistantMessage = Object.freeze({
		role: "assistant",
		api: previous.api,
		provider: previous.provider,
		model: previous.model,
		timestamp: previous.timestamp,
		usage,
		content,
		stopReason: "error",
		error: Object.freeze({ kind: "stream_limit" as const, retryable: false, message: error.message }),
		diagnostics,
	});
	return Object.freeze({ type: "error", seq: event.seq, reason: "error", error: message });
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
