import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "../src/providers/faux.ts";
import type { AssistantStreamFragment } from "../src/stream/fragments.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import {
	TOOL_ARGUMENT_BATCH_INTERVAL_MS,
	TOOL_ARGUMENT_BATCH_MAX_CHARS,
	TOOL_ARGUMENT_BATCH_MAX_FRAGMENTS,
	ToolArgumentCoalescer,
} from "../src/stream/tool-argument-coalescer.ts";
import { complete, completeSimple, stream } from "../src/stream.ts";
import type { AssistantMessageEvent } from "../src/types.ts";
import { EVENT_STREAM_MAX_QUEUED_EVENTS, EventStreamOverflowError } from "../src/utils/event-stream.ts";
import * as jsonParse from "../src/utils/json-parse.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("bounded argument processing (#354)", () => {
	it.each([1, 64, 4096])("bounds parsing work before snapshots for %i-character chunks", async (chunkSize) => {
		vi.useFakeTimers();
		const parse = vi.spyOn(jsonParse, "parseStreamingJson");
		const normalizer = new AssistantStreamNormalizer();
		const raw = JSON.stringify({ newText: "x".repeat(64 * 1024) });
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "edit", name: "edit" });
		for (let offset = 0; offset < raw.length; offset += chunkSize) {
			normalizer.push({
				type: "toolcall_delta",
				contentIndex: 0,
				argsTextDelta: raw.slice(offset, offset + chunkSize),
			});
		}
		normalizer.push({ type: "toolcall_end", contentIndex: 0 });
		normalizer.push({ type: "done", reason: "toolUse" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of normalizer.stream) events.push(event);
		const deltas = events.filter((event) => event.type === "toolcall_delta");
		expect(deltas.map((event) => event.argsTextDelta).join("")).toBe(raw);
		const batchChars = Math.min(TOOL_ARGUMENT_BATCH_MAX_CHARS, TOOL_ARGUMENT_BATCH_MAX_FRAGMENTS * chunkSize);
		expect(parse).toHaveBeenCalledTimes(deltas.length);
		expect(parse.mock.calls.length).toBeLessThanOrEqual(2 + Math.ceil(raw.length / batchChars));
		let accumulated = "";
		for (const event of deltas) {
			accumulated += event.argsTextDelta;
			expect(event.toolState[0]?.argsText).toBe(accumulated);
			expect(event.snapshot.content[0]).toMatchObject({ arguments: jsonParse.parseStreamingJson(accumulated) });
			expect(Object.isFrozen(event.snapshot.content[0])).toBe(true);
		}
		expect(events.at(-1)?.type).toBe("done");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("flushes before interleaved identities and semantic events without reordering", () => {
		vi.useFakeTimers();
		const events: AssistantStreamFragment[] = [];
		const coalescer = new ToolArgumentCoalescer(
			(fragment) => events.push(fragment),
			(error) => {
				throw error;
			},
		);
		coalescer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "a" });
		coalescer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "b" });
		coalescer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "c" });
		coalescer.push({ type: "toolcall_delta", contentIndex: 1, argsTextDelta: "d", id: "other" });
		coalescer.push({ type: "toolcall_end", contentIndex: 1 });
		coalescer.push({ type: "done", reason: "toolUse" });
		expect(events).toEqual([
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "a" },
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "bc" },
			{ type: "toolcall_delta", contentIndex: 1, argsTextDelta: "d", id: "other" },
			{ type: "toolcall_end", contentIndex: 1 },
			{ type: "done", reason: "toolUse" },
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("flushes a trailing preview within one interval and cancels pending timers on disposal", () => {
		vi.useFakeTimers();
		const events: AssistantStreamFragment[] = [];
		const coalescer = new ToolArgumentCoalescer(
			(fragment) => events.push(fragment),
			(error) => {
				throw error;
			},
		);
		coalescer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "first" });
		coalescer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "second" });
		expect(events).toHaveLength(1);
		vi.advanceTimersByTime(TOOL_ARGUMENT_BATCH_INTERVAL_MS);
		expect(events).toHaveLength(2);
		coalescer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "third" });
		coalescer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "discard on disposal" });
		coalescer.dispose();
		vi.advanceTimersByTime(TOOL_ARGUMENT_BATCH_INTERVAL_MS);
		expect(events).toHaveLength(3);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("combines repeated identities but flushes before a changed id or name", () => {
		vi.useFakeTimers();
		const events: AssistantStreamFragment[] = [];
		const coalescer = new ToolArgumentCoalescer(
			(fragment) => events.push(fragment),
			(error) => {
				throw error;
			},
		);
		const initial = { type: "toolcall_delta", contentIndex: 0, id: "call", name: "edit" } as const;
		coalescer.push({ ...initial, argsTextDelta: "a" });
		coalescer.push({ ...initial, argsTextDelta: "b" });
		coalescer.push({ ...initial, argsTextDelta: "c" });
		expect(events).toHaveLength(1);
		coalescer.push({ ...initial, id: "final-call", argsTextDelta: "d" });
		coalescer.push({ ...initial, id: "final-call", argsTextDelta: "e" });
		coalescer.push({ ...initial, id: "final-call", name: "final-edit", argsTextDelta: "f" });
		coalescer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "g" });
		coalescer.push({ ...initial, id: "final-call", name: "final-edit", argsTextDelta: "h" });
		coalescer.push({ type: "toolcall_end", contentIndex: 0 });
		expect(events).toEqual([
			{ ...initial, argsTextDelta: "a" },
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "bc" },
			{ ...initial, id: "final-call", argsTextDelta: "d" },
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "e" },
			{ ...initial, id: "final-call", name: "final-edit", argsTextDelta: "f" },
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "gh" },
			{ type: "toolcall_end", contentIndex: 0 },
		]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports overflow as a timely bounded assistant error instead of rejecting the consumer", async () => {
		const normalizer = new AssistantStreamNormalizer();
		normalizer.push({ type: "text_start", contentIndex: 0 });
		expect(() => {
			for (let index = 0; index < EVENT_STREAM_MAX_QUEUED_EVENTS; index++) {
				normalizer.push({ type: "text_delta", contentIndex: 0, delta: "x" });
			}
		}).toThrow(EventStreamOverflowError);
		const result = await normalizer.stream.result();
		expect(result).toMatchObject({
			stopReason: "error",
			content: [],
			diagnostics: [{ type: "assistant_stream_queue_limit" }],
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of normalizer.stream) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["error"]);
		expect(normalizer.signal.aborted).toBe(true);
		normalizer.push({ type: "done", reason: "stop" });
		expect(await normalizer.stream.result()).toBe(result);
	});

	it("coalesces faux-provider tiny chunks for a slow consumer without losing the final arguments", async () => {
		const faux = registerFauxProvider({ tokenSize: { min: 1, max: 1 } });
		const args = { newText: "λ🌲\n".repeat(8192) };
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("edit", args, { id: "large-edit" }), { stopReason: "toolUse" }),
		]);
		try {
			const response = stream(faux.getModel(), { messages: [] });
			// Deliberately leave iteration idle until the producer finishes.
			const result = await response.result();
			expect(result.content[0]).toMatchObject({ arguments: args });
			const deltas: string[] = [];
			for await (const event of response) {
				if (event.type === "toolcall_delta") deltas.push(event.argsTextDelta);
			}
			expect(deltas.join("")).toBe(JSON.stringify(args));
			expect(deltas.length).toBeLessThan(32);
		} finally {
			faux.unregister();
		}
	});

	it("settles timer-driven overflow as an error and releases all pending preview timers", async () => {
		vi.useFakeTimers();
		const normalizer = new AssistantStreamNormalizer();
		normalizer.push({ type: "text_start", contentIndex: 0 });
		for (let index = 0; index < EVENT_STREAM_MAX_QUEUED_EVENTS - 4; index++) {
			normalizer.push({ type: "text_delta", contentIndex: 0, delta: "x" });
		}
		normalizer.push({ type: "toolcall_start", contentIndex: 1, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 1, argsTextDelta: '{"newText":"' });
		normalizer.push({ type: "toolcall_delta", contentIndex: 1, argsTextDelta: "pending" });
		vi.advanceTimersByTime(TOOL_ARGUMENT_BATCH_INTERVAL_MS);
		const result = await normalizer.stream.result();
		expect(result.diagnostics?.[0]?.type).toBe("assistant_stream_queue_limit");
		expect(result.content).toEqual([]);
		expect(normalizer.signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([false, true])("drains long result-only faux completions (simple: %s)", async (simple) => {
		const faux = registerFauxProvider({ tokenSize: { min: 1, max: 1 } });
		const text = "x".repeat(16 * 1024);
		if (simple) faux.setSimpleResponses([fauxAssistantMessage(text)]);
		else faux.setResponses([fauxAssistantMessage(text)]);
		try {
			const result = await (simple ? completeSimple : complete)(faux.getModel(), { messages: [] });
			expect(result.content).toEqual([{ type: "text", text }]);
		} finally {
			faux.unregister();
		}
	});
});
