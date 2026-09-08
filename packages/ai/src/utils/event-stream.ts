import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

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

	constructor(
		isComplete: (event: T) => boolean,
		extractResult: (event: T) => R,
		overflowEvent?: (error: EventStreamOverflowError, event: T) => T,
	) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.overflowEvent = overflowEvent;
		this.finalResultPromise = new Promise((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
		void this.finalResultPromise.catch(() => {});
	}

	push(event: T): void {
		if (this.done) return;

		// Charge conservative representation size, including snapshots. Cache only deeply
		// frozen values so unchanged snapshot subtrees do not need another traversal.
		let bytes = 0;
		if (this.waiting.length === 0) {
			bytes = this.measureSize(event, new Set()).bytes;
			const limit =
				this.queue.length >= EVENT_STREAM_MAX_QUEUED_EVENTS
					? "events"
					: this.queuedBytes + bytes > EVENT_STREAM_MAX_QUEUED_BYTES
						? "bytes"
						: undefined;
			if (limit) {
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
		waitingConsumers: number;
	} {
		return {
			queuedEvents: this.queue.length,
			peakQueuedEvents: this.peakQueuedEvents,
			queuedBytes: this.queuedBytes,
			peakQueuedBytes: this.peakQueuedBytes,
			waitingConsumers: this.waiting.length,
		};
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
			const nested = this.measureSize((value as Record<string, unknown>)[key], seen);
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
		);
	}
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
		errorMessage: error.message,
		diagnostics,
	});
	return Object.freeze({ type: "error", seq: event.seq, reason: "error", error: message });
}

/** Factory function for AssistantMessageEventStream (for use in extensions) */
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
	return new AssistantMessageEventStream();
}
