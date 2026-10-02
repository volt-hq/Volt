import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import { streamGoogle, streamSimpleGoogle } from "../src/providers/register-builtins.ts";
import type { AssistantMessageEvent, Context, Model, StreamOptions } from "../src/types.ts";
import { EVENT_STREAM_MAX_QUEUED_EVENTS } from "../src/utils/event-stream.ts";

const state = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined, produced: 0, closed: false }));

async function* produce(options?: StreamOptions): AsyncIterable<AssistantMessageEvent> {
	state.signal = options?.signal;
	try {
		for (let seq = 0; seq < EVENT_STREAM_MAX_QUEUED_EVENTS * 2; seq++) {
			state.produced++;
			yield {
				type: "text_delta",
				seq,
				contentIndex: 0,
				delta: "x",
				toolState: [],
				snapshot: fauxAssistantMessage("x".repeat(seq + 1)),
			};
		}
	} finally {
		state.closed = true;
	}
}

vi.mock("../src/providers/google.ts", () => ({
	streamGoogle: (_model: unknown, _context: Context, options?: StreamOptions) => produce(options),
	streamSimpleGoogle: (_model: unknown, _context: Context, options?: StreamOptions) => produce(options),
}));

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

beforeEach(() => {
	state.signal = undefined;
	state.produced = 0;
	state.closed = false;
});
afterEach(() => vi.restoreAllMocks());

describe("lazy stream queue limits (#354)", () => {
	it.each([false, true])("aborts forwarding without an unhandled rejection (simple: %s)", async (simple) => {
		const abort = vi.spyOn(AbortController.prototype, "abort");
		const caller = new AbortController();
		const response = (simple ? streamSimpleGoogle : streamGoogle)(model, { messages: [] }, { signal: caller.signal });
		const result = await response.result();
		expect(result).toMatchObject({
			stopReason: "error",
			content: [],
			diagnostics: [{ type: "assistant_stream_queue_limit" }],
		});
		await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
		expect(state.signal?.aborted).toBe(true);
		expect(state.closed).toBe(true);
		expect(state.produced).toBeLessThanOrEqual(EVENT_STREAM_MAX_QUEUED_EVENTS + 1);
		expect(caller.signal.aborted).toBe(false);
		const events: AssistantMessageEvent[] = [];
		for await (const event of response) events.push(event);
		expect(events.map((event) => event.type)).toEqual(["error"]);
	});
});
