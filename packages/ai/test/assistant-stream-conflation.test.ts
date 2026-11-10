import { describe, expect, it, vi } from "vitest";
import { createAiClient } from "../src/client.ts";
import {
	createFauxProvider,
	type FauxProvider,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "../src/providers/faux.ts";
import { streamGoogle } from "../src/providers/register-builtins.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import type { AssistantMessageEvent, Context, Model, StreamOptions } from "../src/types.ts";
import {
	AssistantMessageEventStream,
	EVENT_STREAM_MAX_QUEUED_EVENTS,
	EventStreamOverflowError,
} from "../src/utils/event-stream.ts";

/** The faux provider that stands in for the lazily loaded Google module. */
const lazyModule = vi.hoisted(() => ({ faux: undefined as FauxProvider | undefined }));

vi.mock("../src/providers/google.ts", () => {
	const stream = (_model: unknown, context: Context, options?: StreamOptions) => {
		if (!lazyModule.faux) throw new Error("No faux provider stands in for the Google module");
		return lazyModule.faux.stream(lazyModule.faux.getModel(), context, options);
	};
	return { streamGoogle: stream, streamSimpleGoogle: stream };
});

async function nextEvent(iterator: AsyncIterator<AssistantMessageEvent>): Promise<AssistantMessageEvent> {
	const result = await iterator.next();
	if (result.done) throw new Error("Expected another assistant event");
	return result.value;
}

async function remainingEvents(iterator: AsyncIterator<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for (let result = await iterator.next(); !result.done; result = await iterator.next()) events.push(result.value);
	return events;
}

/** Events with distinct seq, snapshot, and tool state, so a test can tell which event a field came from. */
function eventFactory() {
	let seq = -1;
	const state = () => {
		seq += 1;
		return {
			seq,
			snapshot: fauxAssistantMessage(`snapshot ${seq}`),
			toolState: [{ contentIndex: 9, argsText: `state ${seq}` }],
		};
	};
	return {
		start: (): AssistantMessageEvent => ({ type: "start", ...state() }),
		textStart: (contentIndex: number): AssistantMessageEvent => ({ type: "text_start", contentIndex, ...state() }),
		text: (contentIndex: number, delta: string): AssistantMessageEvent => ({
			type: "text_delta",
			contentIndex,
			delta,
			...state(),
		}),
		textEnd: (contentIndex: number): AssistantMessageEvent => ({
			type: "text_end",
			contentIndex,
			content: "",
			...state(),
		}),
		thinkingStart: (contentIndex: number): AssistantMessageEvent => ({
			type: "thinking_start",
			contentIndex,
			...state(),
		}),
		thinking: (contentIndex: number, delta: string): AssistantMessageEvent => ({
			type: "thinking_delta",
			contentIndex,
			delta,
			...state(),
		}),
		thinkingEnd: (contentIndex: number): AssistantMessageEvent => ({
			type: "thinking_end",
			contentIndex,
			content: "",
			...state(),
		}),
		toolStart: (contentIndex: number): AssistantMessageEvent => ({
			type: "toolcall_start",
			contentIndex,
			id: "",
			name: "",
			...state(),
		}),
		tool: (
			contentIndex: number,
			argsTextDelta: string,
			identity: { id?: string; name?: string } = {},
		): AssistantMessageEvent => ({ type: "toolcall_delta", contentIndex, argsTextDelta, ...identity, ...state() }),
		toolEnd: (contentIndex: number): AssistantMessageEvent => ({
			type: "toolcall_end",
			contentIndex,
			toolCall: fauxToolCall("edit", {}),
			...state(),
		}),
		done: (): AssistantMessageEvent => ({
			type: "done",
			seq: ++seq,
			reason: "stop",
			message: fauxAssistantMessage("final"),
		}),
		error: (): AssistantMessageEvent => ({
			type: "error",
			seq: ++seq,
			reason: "error",
			error: fauxAssistantMessage("failed", { stopReason: "error" }),
		}),
	};
}

type EventFactory = ReturnType<typeof eventFactory>;

/** Push every event with no consumer, then read what the stream delivers. */
async function deliverQueued(events: readonly AssistantMessageEvent[]): Promise<{
	delivered: AssistantMessageEvent[];
	coalescedEvents: number;
}> {
	const stream = new AssistantMessageEventStream();
	const iterator = stream[Symbol.asyncIterator]();
	for (const event of events) stream.push(event);
	const { coalescedEvents } = stream.getQueueMetrics();
	const delivered: AssistantMessageEvent[] = [];
	for (let index = 0; index < events.length - coalescedEvents; index++) delivered.push(await nextEvent(iterator));
	expect(stream.getQueueMetrics().queuedEvents).toBe(0);
	return { delivered, coalescedEvents };
}

describe("assistant stream conflation (#1067)", () => {
	it("keeps a long response when the consumer stalls behind a large block", async () => {
		const normalizer = new AssistantStreamNormalizer();
		const iterator = normalizer.stream[Symbol.asyncIterator]();
		const head = "x".repeat(120_000);
		normalizer.push({
			type: "start",
			init: { api: "test-api", provider: "test-provider", model: "test-model", timestamp: 1 },
		});
		normalizer.push({ type: "text_start", contentIndex: 0 });
		normalizer.push({ type: "text_delta", contentIndex: 0, delta: head });
		expect((await nextEvent(iterator)).type).toBe("start");
		expect((await nextEvent(iterator)).type).toBe("text_start");
		expect(await nextEvent(iterator)).toMatchObject({ type: "text_delta", delta: head });

		// The consumer now stalls while the provider keeps producing.
		const fragments = Array.from({ length: 2000 }, (_, index) => String(index).padStart(4, "0"));
		const tail = fragments.join("");
		expect(() => {
			for (const delta of fragments) normalizer.push({ type: "text_delta", contentIndex: 0, delta });
			normalizer.push({ type: "done", reason: "stop" });
		}).not.toThrow();

		const events = await remainingEvents(iterator);
		const deltas = events.filter((event) => event.type === "text_delta");
		expect(deltas.length).toBeGreaterThan(0);
		expect(events.map((event) => event.type)).toEqual([...deltas.map(() => "text_delta"), "text_end", "done"]);
		expect(deltas.map((event) => event.delta).join("")).toBe(tail);
		expect(deltas.at(-1)?.snapshot.content).toEqual([{ type: "text", text: head + tail }]);

		const result = await normalizer.stream.result();
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: head + tail }]);
	});

	describe("combined events", () => {
		it.each([
			["text_delta", (events: EventFactory, delta: string) => events.text(0, delta)],
			["thinking_delta", (events: EventFactory, delta: string) => events.thinking(0, delta)],
			["toolcall_delta", (events: EventFactory, delta: string) => events.tool(0, delta)],
		] as const)(
			"delivers queued %s events for one block as one frozen event with the newest state",
			async (type, build) => {
				const events = eventFactory();
				const pushed = [build(events, "a"), build(events, "b"), build(events, "c")];
				const copies = pushed.map((event) => ({ ...event }));
				const newest = pushed[2]!;
				if (!("snapshot" in newest)) throw new Error("Expected a delta event");

				const { delivered, coalescedEvents } = await deliverQueued(pushed);

				expect(coalescedEvents).toBe(2);
				const [combined] = delivered;
				if (combined?.type !== type) throw new Error(`Expected one ${type} event`);
				expect(combined.type === "toolcall_delta" ? combined.argsTextDelta : combined.delta).toBe("abc");
				expect(combined.seq).toBe(newest.seq);
				expect(combined.snapshot).toBe(newest.snapshot);
				expect(combined.toolState).toBe(newest.toolState);
				expect(Object.isFrozen(combined)).toBe(true);
				// The pushed events are neither delivered nor changed.
				expect(pushed).not.toContain(combined);
				expect(pushed).toEqual(copies);
			},
		);

		it("keeps the queued tool identity when later deltas omit or repeat it", async () => {
			const events = eventFactory();
			const pushed = [
				events.tool(0, '{"path":', { id: "call-1", name: "edit" }),
				events.tool(0, '"notes.md"'),
				events.tool(0, "}", { id: "call-1", name: "edit" }),
			];

			const { delivered } = await deliverQueued(pushed);

			expect(delivered).toEqual([
				{ ...pushed[2], argsTextDelta: '{"path":"notes.md"}', id: "call-1", name: "edit" },
			]);
		});

		it("combines a run of deltas that follows an event of another kind", async () => {
			const events = eventFactory();
			const pushed = [events.textStart(0), events.text(0, "a"), events.text(0, "b"), events.textEnd(0)];

			const { delivered } = await deliverQueued(pushed);

			expect(delivered).toEqual([pushed[0], { ...pushed[2], delta: "ab" }, pushed[3]]);
			expect(delivered[0]).toBe(pushed[0]);
			expect(delivered[2]).toBe(pushed[3]);
		});
	});

	describe("boundaries", () => {
		it.each([
			["a different block", (events: EventFactory) => [events.text(0, "a"), events.text(1, "b")]],
			["a different delta type", (events: EventFactory) => [events.text(0, "a"), events.thinking(0, "b")]],
			["a tool delta after a text delta", (events: EventFactory) => [events.text(0, "a"), events.tool(0, "b")]],
			["a message start", (events: EventFactory) => [events.start(), events.text(0, "a")]],
			["a text start", (events: EventFactory) => [events.textStart(0), events.text(0, "a")]],
			["a text end", (events: EventFactory) => [events.text(0, "a"), events.textEnd(0), events.text(0, "b")]],
			["a thinking start", (events: EventFactory) => [events.thinkingStart(0), events.thinking(0, "a")]],
			[
				"a thinking end",
				(events: EventFactory) => [events.thinking(0, "a"), events.thinkingEnd(0), events.thinking(0, "b")],
			],
			["a tool-call start", (events: EventFactory) => [events.toolStart(0), events.tool(0, "a")]],
			["a tool-call end", (events: EventFactory) => [events.tool(0, "a"), events.toolEnd(0), events.tool(0, "b")]],
			["a done terminal", (events: EventFactory) => [events.text(0, "a"), events.done()]],
			["an error terminal", (events: EventFactory) => [events.text(0, "a"), events.error()]],
			[
				"an interleaved block",
				(events: EventFactory) => [events.text(0, "a"), events.text(1, "b"), events.text(0, "c")],
			],
			[
				"a tool delta that sets an id",
				(events: EventFactory) => [events.tool(0, "a"), events.tool(0, "b", { id: "late-id" })],
			],
			[
				"a tool delta that sets a name",
				(events: EventFactory) => [events.tool(0, "a"), events.tool(0, "b", { name: "late-name" })],
			],
			[
				"a tool delta that changes the id",
				(events: EventFactory) => [
					events.tool(0, "a", { id: "draft", name: "edit" }),
					events.tool(0, "b", { id: "final", name: "edit" }),
				],
			],
			[
				"a tool delta that changes the name",
				(events: EventFactory) => [
					events.tool(0, "a", { id: "call", name: "draft" }),
					events.tool(0, "b", { id: "call", name: "final" }),
				],
			],
		] as const)("does not combine events across %s", async (_boundary, build) => {
			const pushed = build(eventFactory());

			const { delivered, coalescedEvents } = await deliverQueued(pushed);

			expect(coalescedEvents).toBe(0);
			expect(delivered).toHaveLength(pushed.length);
			for (const [index, event] of delivered.entries()) expect(event).toBe(pushed[index]);
		});

		it("does not change an event the consumer already read", async () => {
			const events = eventFactory();
			const stream = new AssistantMessageEventStream();
			const iterator = stream[Symbol.asyncIterator]();
			const first = events.text(0, "a");
			stream.push(first);
			expect(await nextEvent(iterator)).toBe(first);

			const later = [events.text(0, "b"), events.text(0, "c")];
			for (const event of later) stream.push(event);

			expect(first).toMatchObject({ delta: "a", seq: 0 });
			expect(await nextEvent(iterator)).toEqual({ ...later[1], delta: "bc" });
			expect(stream.getQueueMetrics()).toMatchObject({ queuedEvents: 0, coalescedEvents: 1 });
		});

		it("hands a waiting consumer each event as it was pushed", async () => {
			const events = eventFactory();
			const stream = new AssistantMessageEventStream();
			const iterator = stream[Symbol.asyncIterator]();
			for (const delta of ["a", "b", "c"]) {
				const waiting = iterator.next();
				expect(stream.getQueueMetrics().waitingConsumers).toBe(1);
				const event = events.text(0, delta);
				stream.push(event);
				expect((await waiting).value).toBe(event);
			}
			expect(stream.getQueueMetrics()).toMatchObject({ queuedEvents: 0, peakQueuedEvents: 0, coalescedEvents: 0 });
		});
	});

	describe("limits on backlog that cannot combine", () => {
		/** A normalizer with two open text blocks, each holding `text`, and nothing left to read. */
		async function twoOpenTextBlocks(text: string): Promise<AssistantStreamNormalizer> {
			const normalizer = new AssistantStreamNormalizer();
			const iterator = normalizer.stream[Symbol.asyncIterator]();
			normalizer.push({
				type: "start",
				init: { api: "test-api", provider: "test-provider", model: "test-model", timestamp: 1 },
			});
			for (const contentIndex of [0, 1]) {
				normalizer.push({ type: "text_start", contentIndex });
				normalizer.push({ type: "text_delta", contentIndex, delta: text });
			}
			for (let read = 0; read < 5; read++) await nextEvent(iterator);
			expect(normalizer.stream.getQueueMetrics()).toMatchObject({ queuedEvents: 0, coalescedEvents: 0 });
			return normalizer;
		}

		async function expectQueueLimitTerminal(
			normalizer: AssistantStreamNormalizer,
			limit: "events" | "bytes",
		): Promise<void> {
			const result = await normalizer.stream.result();
			expect(result).toMatchObject({
				stopReason: "error",
				content: [],
				error: { kind: "stream_limit", retryable: false },
				diagnostics: [{ type: "assistant_stream_queue_limit", details: { limit } }],
			});
			const events: AssistantMessageEvent[] = [];
			for await (const event of normalizer.stream) events.push(event);
			expect(events).toEqual([{ type: "error", seq: expect.any(Number), reason: "error", error: result }]);
			expect(normalizer.signal.aborted).toBe(true);
		}

		it("fails at the event limit when queued deltas alternate between two open blocks", async () => {
			const normalizer = await twoOpenTextBlocks("x");
			for (let index = 0; index < EVENT_STREAM_MAX_QUEUED_EVENTS; index++) {
				normalizer.push({ type: "text_delta", contentIndex: index % 2, delta: "x" });
			}
			expect(normalizer.stream.getQueueMetrics()).toMatchObject({
				queuedEvents: EVENT_STREAM_MAX_QUEUED_EVENTS,
				coalescedEvents: 0,
			});
			// A delta for the block at the queue tail still combines into the full queue.
			normalizer.push({ type: "text_delta", contentIndex: 1, delta: "x" });
			expect(normalizer.stream.getQueueMetrics()).toMatchObject({
				queuedEvents: EVENT_STREAM_MAX_QUEUED_EVENTS,
				coalescedEvents: 1,
			});

			expect(() => normalizer.push({ type: "text_delta", contentIndex: 0, delta: "x" })).toThrow(
				expect.objectContaining({ name: "EventStreamOverflowError", limit: "events" }),
			);
			await expectQueueLimitTerminal(normalizer, "events");
		});

		it("fails at the byte limit when queued deltas alternate between two large open blocks", async () => {
			// Every queued delta is charged its whole snapshot: about 2 MiB for these two blocks.
			const normalizer = await twoOpenTextBlocks("x".repeat(512 * 1024));
			let pushed = 0;
			let overflow: unknown;
			try {
				for (; pushed < EVENT_STREAM_MAX_QUEUED_EVENTS; pushed++) {
					normalizer.push({ type: "text_delta", contentIndex: pushed % 2, delta: "x" });
				}
			} catch (error) {
				overflow = error;
			}

			expect(overflow).toBeInstanceOf(EventStreamOverflowError);
			expect(overflow).toMatchObject({ limit: "bytes" });
			expect(pushed).toBeGreaterThan(0);
			expect(pushed).toBeLessThan(16);
			expect(normalizer.stream.getQueueMetrics().coalescedEvents).toBe(0);
			await expectQueueLimitTerminal(normalizer, "bytes");
		});

		it("holds one snapshot for a run of deltas to one of two large open blocks", async () => {
			const normalizer = await twoOpenTextBlocks("x".repeat(512 * 1024));
			for (let index = 0; index < EVENT_STREAM_MAX_QUEUED_EVENTS * 2; index++) {
				normalizer.push({ type: "text_delta", contentIndex: 1, delta: "x" });
			}
			expect(normalizer.stream.getQueueMetrics()).toMatchObject({
				queuedEvents: 1,
				coalescedEvents: EVENT_STREAM_MAX_QUEUED_EVENTS * 2 - 1,
			});
			normalizer.push({ type: "done", reason: "stop" });
			expect((await normalizer.stream.result()).stopReason).toBe("stop");
		});
	});

	describe("forwarding wrappers", () => {
		// 16,384 characters each; four-character faux chunks give 4,096 deltas per block.
		const thinking = Array.from({ length: 2048 }, (_, index) => `t${String(index).padStart(7, "0")}`).join("");
		const text = Array.from({ length: 2048 }, (_, index) => `x${String(index).padStart(7, "0")}`).join("");

		function longResponseProvider(): FauxProvider {
			const faux = createFauxProvider({ tokenSize: { min: 1, max: 1 } });
			faux.setResponses([fauxAssistantMessage([fauxThinking(thinking), fauxText(text)])]);
			return faux;
		}

		/** Leave iteration idle until the producer finishes, then read everything it queued. */
		async function expectWholeResponse(response: AssistantMessageEventStream): Promise<void> {
			const result = await response.result();
			expect(result.stopReason).toBe("stop");
			expect(result.content).toEqual([
				{ type: "thinking", thinking },
				{ type: "text", text },
			]);

			const events: AssistantMessageEvent[] = [];
			for await (const event of response) events.push(event);
			const deltas = (type: "thinking_delta" | "text_delta"): string =>
				events.flatMap((event) => (event.type === type ? [event.delta] : [])).join("");
			expect(deltas("thinking_delta")).toBe(thinking);
			expect(deltas("text_delta")).toBe(text);
			expect(events.map((event) => event.type).filter((type, index, types) => type !== types[index - 1])).toEqual([
				"start",
				"thinking_start",
				"thinking_delta",
				"thinking_end",
				"text_start",
				"text_delta",
				"text_end",
				"done",
			]);
			expect(events.at(-1)).toMatchObject({ type: "done", message: result });
		}

		it("delivers a long response through a client with a credential source", async () => {
			const faux = longResponseProvider();
			const resolve = vi.fn(async () => ({ apiKey: "test-key" }));
			const client = createAiClient({ providers: [faux], credentials: { resolve } });

			await expectWholeResponse(client.stream(faux.getModel(), { messages: [] }));

			expect(resolve).toHaveBeenCalledOnce();
		});

		it("delivers a long response through a lazily loaded built-in provider", async () => {
			lazyModule.faux = longResponseProvider();
			const model: Model<"google-generative-ai"> = {
				id: "test",
				name: "test",
				api: "google-generative-ai",
				provider: "google",
				baseUrl: "https://unused.invalid",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1024,
				maxTokens: 128,
			};

			await expectWholeResponse(streamGoogle(model, { messages: [] }));

			expect(lazyModule.faux.state.callCount).toBe(1);
		});
	});
});
