import { afterEach, describe, expect, it, vi } from "vitest";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import type { AssistantMessageEvent, StreamOptions } from "../src/types.ts";

afterEach(() => vi.useRealTimers());

function start(options?: StreamOptions) {
	const normalizer = new AssistantStreamNormalizer(options);
	normalizer.push({
		type: "start",
		init: { api: "test", provider: "test", model: "test-model", timestamp: Date.now() },
	});
	return normalizer;
}

async function collect(normalizer: AssistantStreamNormalizer) {
	const events: AssistantMessageEvent[] = [];
	for await (const event of normalizer.stream) events.push(event);
	return { events, message: await normalizer.stream.result() };
}

describe("tool generation limits in the provider stream", () => {
	it("completes a long document that keeps streaming past five minutes with default limits", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const normalizer = start();
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "document", name: "write" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"path":"design.md","content":"' });
		const section = "Design section. ".repeat(100);
		for (let minute = 0; minute < 10; minute++) {
			vi.advanceTimersByTime(60_000);
			normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: section });
		}
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '"}' });
		normalizer.push({ type: "toolcall_end", contentIndex: 0 });
		normalizer.push({ type: "done", reason: "toolUse" });
		const { events, message } = await collect(normalizer);
		expect(message.stopReason).toBe("toolUse");
		expect(message.content[0]).toMatchObject({ arguments: { path: "design.md", content: section.repeat(10) } });
		expect(message.diagnostics).toBeUndefined();
		expect(normalizer.signal.aborted).toBe(false);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts stalled argument generation despite empty deltas and unrelated text", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const normalizer = start({ toolArgumentLimits: { maxIdleMs: 100 } });
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "document", name: "write" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"content":"' });
		normalizer.push({ type: "text_start", contentIndex: 1 });
		for (let index = 0; index < 9; index++) {
			vi.advanceTimersByTime(10);
			normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: "" });
			normalizer.push({ type: "text_delta", contentIndex: 1, delta: "Still here. " });
		}
		vi.advanceTimersByTime(10);
		const { events, message } = await collect(normalizer);
		expect(message.stopReason).toBe("error");
		expect(message.diagnostics?.[0]).toMatchObject({
			type: "tool_argument_generation_limit",
			details: { limit: "maxIdleMs", idleMs: 100 },
		});
		expect(normalizer.signal.aborted).toBe(true);
		expect(events.filter((event) => event.type === "error")).toHaveLength(1);
		expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("terminates a progressing call and aborts its provider signal", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const normalizer = start({ toolArgumentLimits: { maxDurationMs: 100 } });
		const abort = vi.fn();
		normalizer.signal.addEventListener("abort", abort);
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		for (let index = 0; index < 9; index++) {
			vi.advanceTimersByTime(10);
			normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: " " });
		}
		vi.advanceTimersByTime(10);
		// Late adapter cancellation and terminal fragments cannot replace the diagnostic.
		normalizer.push({ type: "error", reason: "aborted", errorMessage: "Request aborted" });
		normalizer.push({ type: "done", reason: "toolUse" });
		const { events, message } = await collect(normalizer);
		expect(abort).toHaveBeenCalledOnce();
		expect(message).toMatchObject({ stopReason: "error", provider: "test", model: "test-model" });
		expect(message.diagnostics?.[0]).toMatchObject({
			type: "tool_argument_generation_limit",
			details: { limit: "maxDurationMs" },
		});
		expect(events.filter((event) => event.type === "error")).toHaveLength(1);
		expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["delta", "final"] as const)("rejects an oversized %s before retaining or parsing it", async (kind) => {
		const normalizer = start({ toolArgumentLimits: { maxBytes: 32 } });
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"preview"}' });
		const oversized = `{"text":"${"private-raw-arguments".repeat(1000)}"}`;
		normalizer.push(
			kind === "delta"
				? { type: "toolcall_delta", contentIndex: 0, argsTextDelta: oversized }
				: { type: "toolcall_end", contentIndex: 0, argumentsText: oversized },
		);
		const { events, message } = await collect(normalizer);
		expect(message.stopReason).toBe("error");
		expect(JSON.stringify(events)).not.toContain("private-raw-arguments");
		expect(message.content[0]).toMatchObject({ type: "toolCall", arguments: { text: "preview" } });
		expect(normalizer.signal.aborted).toBe(true);
		expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
	});

	it("checks a final-only native object before cloning it", async () => {
		const normalizer = start({ toolArgumentLimits: { maxBytes: 32 } });
		normalizer.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: {
				type: "toolCall",
				id: "call",
				name: "edit",
				arguments: { text: "x".repeat(100_000) },
			},
		});
		const { message } = await collect(normalizer);
		expect(message.stopReason).toBe("error");
		expect(message.content[0]).toMatchObject({ type: "toolCall", arguments: {} });
	});

	it("does not reset another interleaved call's deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const normalizer = start({ toolArgumentLimits: { maxDurationMs: 100 } });
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "first", name: "edit" });
		vi.advanceTimersByTime(50);
		normalizer.push({ type: "toolcall_start", contentIndex: 1, id: "second", name: "edit" });
		normalizer.push({ type: "toolcall_end", contentIndex: 1, argumentsText: "{}" });
		vi.advanceTimersByTime(50);
		const { message } = await collect(normalizer);
		expect(message.diagnostics?.[0]?.details).toMatchObject({ contentIndex: 0, limit: "maxDurationMs" });
	});

	it("keeps reasoning and post-completion time outside the deadline", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const normalizer = start({ toolArgumentLimits: { maxDurationMs: 10 } });
		normalizer.push({ type: "thinking_start", contentIndex: 0 });
		vi.advanceTimersByTime(1000);
		normalizer.push({ type: "thinking_end", contentIndex: 0 });
		normalizer.push({ type: "toolcall_start", contentIndex: 1, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_end", contentIndex: 1, argumentsText: '{"text":"done"}' });
		vi.advanceTimersByTime(1000);
		normalizer.push({ type: "done", reason: "toolUse" });
		const { message } = await collect(normalizer);
		expect(message.stopReason).toBe("toolUse");
		expect(message.content[1]).toMatchObject({ arguments: { text: "done" } });
		expect(normalizer.signal.aborted).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves external cancellation and clears its deadlines", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const normalizer = start({ signal: controller.signal });
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"unfinished' });
		controller.abort("user-request");
		expect(normalizer.signal.reason).toBe("user-request");
		expect(vi.getTimerCount()).toBe(0);
		normalizer.push({ type: "error", reason: "aborted", errorMessage: "user cancelled" });
		const { message, events } = await collect(normalizer);
		expect(message.stopReason).toBe("aborted");
		expect(message.diagnostics).toBeUndefined();
		const closed = events.filter((event) => event.type === "toolcall_end");
		expect(closed).toHaveLength(1);
		expect(closed[0]?.toolCall.arguments).toEqual({ text: "unfinished" });
		expect(closed[0]?.toolState).toEqual([]);
		expect(Object.isFrozen(closed[0]?.toolCall.arguments)).toBe(true);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("reports configuration errors through the stream contract", async () => {
		const normalizer = start({ toolArgumentLimits: { maxDurationMs: -1 } });
		const { message } = await collect(normalizer);
		expect(message).toMatchObject({ stopReason: "error", model: "test-model" });
		expect(message.diagnostics?.[0]?.details).toEqual({ code: "invalid_configuration" });
		expect(normalizer.signal.aborted).toBe(true);
	});

	it.each(
		["start", "meta", "error"].flatMap((source) =>
			["tool_argument_generation_limit", "invalid_tool_arguments"].map((type) => ({ source, type })),
		),
	)("preserves $type supplied in $source metadata", async ({ source, type }) => {
		const normalizer = new AssistantStreamNormalizer();
		const diagnostic = { type, timestamp: 1, details: { code: "original_failure" } };
		normalizer.push({
			type: "start",
			init: {
				api: "test",
				provider: "test",
				model: "test-model",
				timestamp: 1,
				...(source === "start" ? { diagnostics: [diagnostic] } : {}),
			},
		});
		if (source === "meta") normalizer.push({ type: "meta", patch: { diagnostics: [diagnostic] } });
		normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" });
		normalizer.push({ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"unfinished' });
		const errorMessage = "Tool preparation failed. No tools were executed.";
		normalizer.push({
			type: "error",
			reason: "error",
			errorMessage,
			...(source === "error" ? { diagnostics: [diagnostic] } : {}),
		});
		const { message } = await collect(normalizer);
		expect(message.errorMessage).toBe(errorMessage);
		expect(message.diagnostics).toEqual([diagnostic]);
	});
});
