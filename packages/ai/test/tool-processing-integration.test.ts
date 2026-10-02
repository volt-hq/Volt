import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "../src/models.ts";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import { TOOL_ARGUMENT_BATCH_INTERVAL_MS } from "../src/stream/tool-argument-coalescer.ts";
import type { AssistantMessageEvent } from "../src/types.ts";
import { EVENT_STREAM_MAX_QUEUED_EVENTS, EventStreamOverflowError } from "../src/utils/event-stream.ts";
import * as jsonParse from "../src/utils/json-parse.ts";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

function start(normalizer: AssistantStreamNormalizer): void {
	normalizer.push({ type: "start", init: { api: "faux", provider: "faux", model: "faux", timestamp: 0 } });
}

async function collect(normalizer: AssistantStreamNormalizer): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of normalizer.stream) events.push(event);
	return events;
}

describe("tool limits, strict completion, and processing cooperate", () => {
	it("charges raw deltas immediately while a preview batch is pending", async () => {
		vi.useFakeTimers();
		const parse = vi.spyOn(jsonParse, "parseStreamingJson");
		const normalizer = new AssistantStreamNormalizer({ toolArgumentLimits: { maxBytes: 12 } });
		start(normalizer);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"' });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "abc" });
		expect(parse).toHaveBeenCalledTimes(1);
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "overflow" });
		expect(normalizer.signal.aborted).toBe(true);
		const message = await normalizer.stream.result();
		expect(message.diagnostics).toEqual([
			expect.objectContaining({
				type: "tool_argument_generation_limit",
				details: expect.objectContaining({ limit: "maxBytes", events: 3 }),
			}),
		]);
		expect(message.errorMessage).toContain("maxBytes");
		expect(parse).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		normalizer.push({ type: "toolcall_end", contentIndex: 0, argumentsText: '{"text":"accepted too late"}' });
		normalizer.push({ type: "done", reason: "toolUse" });
		const events = await collect(normalizer);
		expect(events.filter((event) => event.type === "toolcall_end" || event.type === "done")).toEqual([]);
		expect(events.at(-1)?.type).toBe("error");
		expect(await normalizer.stream.result()).toBe(message);
	});

	it("keeps the absolute deadline while coalesced input is still arriving", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const normalizer = new AssistantStreamNormalizer({ toolArgumentLimits: { maxDurationMs: 10 } });
		start(normalizer);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"' });
		vi.advanceTimersByTime(5);
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "progress" });
		vi.advanceTimersByTime(5);
		expect(10).toBeLessThan(TOOL_ARGUMENT_BATCH_INTERVAL_MS);
		expect(normalizer.signal.aborted).toBe(true);
		const message = await normalizer.stream.result();
		expect(message.diagnostics?.[0]).toMatchObject({
			type: "tool_argument_generation_limit",
			details: { limit: "maxDurationMs" },
		});
		expect(message.errorMessage).toContain("maxDurationMs");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("coalesces the actual Responses adapter's repeated identities and preserves complete arguments", async () => {
		vi.useFakeTimers();
		const parse = vi.spyOn(jsonParse, "parseStreamingJson");
		const normalizer = new AssistantStreamNormalizer();
		start(normalizer);
		const model = getModel("openai", "gpt-4o");
		const args = { newText: "λ🌲\n".repeat(8192) };
		const raw = JSON.stringify(args);
		const item = {
			type: "function_call",
			id: "fc_item",
			call_id: "call_edit",
			name: "edit",
			arguments: "",
			status: "in_progress",
		};
		async function* events(): AsyncGenerator<ResponseStreamEvent> {
			yield { type: "response.output_item.added", output_index: 0, item } as ResponseStreamEvent;
			for (let offset = 0; offset < raw.length; offset += 4) {
				yield {
					type: "response.function_call_arguments.delta",
					output_index: 0,
					item_id: "fc_item",
					delta: raw.slice(offset, offset + 4),
				} as ResponseStreamEvent;
			}
			yield {
				type: "response.output_item.done",
				output_index: 0,
				item: { ...item, arguments: raw, status: "completed" },
			} as ResponseStreamEvent;
			yield { type: "response.completed", response: { id: "response", status: "completed" } } as ResponseStreamEvent;
		}
		const completion = await processResponsesStream(events(), normalizer, model);
		normalizer.push({ type: "done", reason: "toolUse" });
		const received: AssistantMessageEvent[] = [];
		for await (const event of normalizer.stream) received.push(event);
		const deltas = received.filter((event) => event.type === "toolcall_delta");
		expect(deltas.map((event) => event.argsTextDelta).join("")).toBe(raw);
		expect(parse.mock.calls.length).toBeLessThan(32);
		expect(completion.stopReason).toBe("toolUse");
		expect(await normalizer.stream.result()).toMatchObject({
			stopReason: "toolUse",
			content: [{ id: "call_edit|fc_item", arguments: args }],
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("flushes a pending call before an interleaved implicit start and preserves both final calls", async () => {
		vi.useFakeTimers();
		const normalizer = new AssistantStreamNormalizer();
		start(normalizer);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "first", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"x":"' });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "pending" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 1, id: "second", name: "read", argsTextDelta: '{"y":' });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '"}' });
		normalizer.push({ type: "toolcall_delta", contentIndex: 1, argsTextDelta: "1}" });
		normalizer.push({ type: "toolcall_end", contentIndex: 1 });
		normalizer.push({ type: "toolcall_end", contentIndex: 0 });
		normalizer.push({ type: "done", reason: "toolUse" });
		const events = await collect(normalizer);
		expect(
			events.slice(1, 6).map((event) => [event.type, "contentIndex" in event ? event.contentIndex : null]),
		).toEqual([
			["toolcall_start", 0],
			["toolcall_delta", 0],
			["toolcall_delta", 0],
			["toolcall_start", 1],
			["toolcall_delta", 1],
		]);
		expect(await normalizer.stream.result()).toMatchObject({
			stopReason: "toolUse",
			content: [
				{ id: "first", name: "edit", arguments: { x: "pending" } },
				{ id: "second", name: "read", arguments: { y: 1 } },
			],
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		{ maxBytes: 12, maxTotalBytes: 100, limit: "maxBytes" },
		{ maxBytes: 100, maxTotalBytes: 20, limit: "maxTotalBytes" },
	])("charges interleaved pending batches against $limit", async ({ maxBytes, maxTotalBytes, limit }) => {
		vi.useFakeTimers();
		const normalizer = new AssistantStreamNormalizer({ toolArgumentLimits: { maxBytes, maxTotalBytes } });
		start(normalizer);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "first", name: "edit" });
		normalizer.push({ type: "toolcall_start", contentIndex: 1, id: "second", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"x":"' });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "12345" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 1, argsTextDelta: '{"y":"' });
		normalizer.push({ type: "toolcall_delta", contentIndex: 1, argsTextDelta: "1" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "678" });
		const message = await normalizer.stream.result();
		expect(message.diagnostics).toEqual([
			expect.objectContaining({
				type: "tool_argument_generation_limit",
				details: expect.objectContaining({ contentIndex: 0, limit, events: 3 }),
			}),
		]);
		expect(normalizer.signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		expect(
			(await collect(normalizer)).filter((event) => event.type === "toolcall_end" || event.type === "done"),
		).toEqual([]);
	});

	it.each(["raw", "native"])("bounds authoritative %s completion before strict parsing", async (representation) => {
		vi.useFakeTimers();
		const normalizer = new AssistantStreamNormalizer({ toolArgumentLimits: { maxBytes: 16 } });
		start(normalizer);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		const args = { text: "secret".repeat(1024) };
		const parse = vi.spyOn(JSON, "parse");
		normalizer.push(
			representation === "raw"
				? { type: "toolcall_end", contentIndex: 0, argumentsText: JSON.stringify(args) }
				: {
						type: "toolcall_end",
						contentIndex: 0,
						toolCall: { type: "toolCall", id: "call", name: "edit", arguments: args },
					},
		);
		expect(parse).not.toHaveBeenCalled();
		const message = await normalizer.stream.result();
		expect(message.diagnostics?.[0]).toMatchObject({
			type: "tool_argument_generation_limit",
			details: { limit: "maxBytes" },
		});
		expect(JSON.stringify(message)).not.toContain("secret");
		expect(
			(await collect(normalizer)).filter((event) => event.type === "toolcall_end" || event.type === "done"),
		).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("settles a deadline against an exactly full queue without throwing from its timer", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const normalizer = new AssistantStreamNormalizer({ toolArgumentLimits: { maxDurationMs: 10 } });
		start(normalizer);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"x":"' });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "pending" });
		// Starting text flushes the pending tool preview: five events are now retained.
		normalizer.push({ type: "text_start", contentIndex: 1 });
		for (let index = 5; index < EVENT_STREAM_MAX_QUEUED_EVENTS; index++) {
			normalizer.push({ type: "text_delta", contentIndex: 1, delta: "" });
		}
		expect(() => vi.advanceTimersByTime(10)).not.toThrow();
		const message = await normalizer.stream.result();
		expect(message).toMatchObject({
			stopReason: "error",
			content: [],
			diagnostics: [{ type: "assistant_stream_queue_limit" }],
		});
		expect((await collect(normalizer)).map((event) => event.type)).toEqual(["error"]);
		expect(normalizer.signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects success when its terminal would overflow the queue", async () => {
		vi.useFakeTimers();
		const normalizer = new AssistantStreamNormalizer();
		start(normalizer);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_end", contentIndex: 0, argumentsText: "{}" });
		normalizer.push({ type: "text_start", contentIndex: 1 });
		for (let index = 5; index < EVENT_STREAM_MAX_QUEUED_EVENTS; index++) {
			normalizer.push({ type: "text_delta", contentIndex: 1, delta: "" });
		}
		normalizer.push({ type: "text_end", contentIndex: 1 });
		expect(() => normalizer.push({ type: "done", reason: "toolUse" })).toThrow(EventStreamOverflowError);
		const message = await normalizer.stream.result();
		expect(message).toMatchObject({
			stopReason: "error",
			content: [],
			diagnostics: [{ type: "assistant_stream_queue_limit" }],
		});
		expect((await collect(normalizer)).map((event) => event.type)).toEqual(["error"]);
		expect(normalizer.signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("lets a deadline win over a pending batch scheduled for the same instant", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const parse = vi.spyOn(jsonParse, "parseStreamingJson");
		const normalizer = new AssistantStreamNormalizer({
			toolArgumentLimits: { maxDurationMs: TOOL_ARGUMENT_BATCH_INTERVAL_MS },
		});
		start(normalizer);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"x":"' });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "pending" });
		vi.advanceTimersByTime(TOOL_ARGUMENT_BATCH_INTERVAL_MS);
		expect(parse).toHaveBeenCalledTimes(1);
		expect((await normalizer.stream.result()).diagnostics?.[0]?.type).toBe("tool_argument_generation_limit");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("discards pending previews and deadlines when the caller aborts", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const normalizer = new AssistantStreamNormalizer({ signal: controller.signal });
		start(normalizer);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"x":"' });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "pending" });
		controller.abort();
		expect(normalizer.signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
		normalizer.push({ type: "error", reason: "aborted", errorMessage: "Operation aborted" });
		const events = await collect(normalizer);
		expect(events.filter((event) => event.type === "toolcall_delta").map((event) => event.argsTextDelta)).toEqual([
			'{"x":"',
		]);
		expect((await normalizer.stream.result()).stopReason).toBe("aborted");
	});

	it("keeps unexpected processing exceptions private and bounded", async () => {
		vi.useFakeTimers();
		const sensitive = "provider-secret".repeat(1024);
		const exception = new Error(`Internal error while parsing ${sensitive}`);
		vi.spyOn(jsonParse, "parseStreamingJson").mockImplementation(() => {
			throw exception;
		});
		const normalizer = new AssistantStreamNormalizer();
		start(normalizer);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		expect(() => normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"x":"' })).toThrow(
			exception,
		);
		const message = await normalizer.stream.result();
		expect(message).toMatchObject({
			stopReason: "error",
			content: [],
			diagnostics: [{ type: "assistant_stream_processing_error", details: {} }],
		});
		expect(message.errorMessage).toBe(
			"Assistant stream processing failed. No tools from this response were executed. Retry explicitly.",
		);
		expect(JSON.stringify(message).length).toBeLessThan(1024);
		expect(JSON.stringify(message)).not.toContain(sensitive);
		expect(normalizer.signal.aborted).toBe(true);
		expect(vi.getTimerCount()).toBe(0);
	});
});
