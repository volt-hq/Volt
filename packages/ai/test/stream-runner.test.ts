import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderStreamError } from "../src/stream/provider-errors.ts";
import {
	createProviderStream,
	type ProviderRequest,
	type ProviderStreamSink,
	type StopReasonMapping,
	type StreamProvider,
} from "../src/stream/runner.ts";
import type { AssistantMessageEvent, Model, StreamOptions, Usage } from "../src/types.ts";

const model: Model<"test-api"> = {
	id: "test-model",
	name: "Test",
	api: "test-api",
	provider: "test-provider",
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

type Stop = "end" | "max" | "blocked";

interface Script {
	/** Send outcomes in order; an Error rejects that attempt. */
	sends?: (Error | "ok")[];
	parse?: (sink: ProviderStreamSink<Stop, number>, signal: AbortSignal) => Promise<void>;
	request?: Partial<ProviderRequest<{ prompt: string } | undefined, string>>;
	provider?: Partial<StreamProvider<"test-api", StreamOptions, { prompt: string } | undefined, string, Stop, number>>;
}

function scriptedStream(script: Script) {
	const sent: unknown[] = [];
	const sends = [...(script.sends ?? ["ok"])];
	const stream = createProviderStream<"test-api", StreamOptions, { prompt: string } | undefined, string, Stop, number>(
		{
			buildRequest: () => ({
				payload: { prompt: "hello" },
				async send(payload) {
					sent.push(payload);
					const outcome = sends.shift() ?? "ok";
					if (outcome instanceof Error) throw outcome;
					return { response: { status: 200, headers: { "x-test": "1" } }, body: "body" };
				},
				...script.request,
			}),
			parse: async (_body, sink, ctx) => {
				if (script.parse) {
					await script.parse(sink, ctx.options.signal);
					return;
				}
				sink.push({ type: "text_start", contentIndex: 0 });
				sink.push({ type: "text_delta", contentIndex: 0, delta: "hi" });
				sink.push({ type: "text_end", contentIndex: 0 });
				sink.stop("end");
			},
			mapStopReason: (stop): StopReasonMapping =>
				stop === "blocked"
					? {
							stopReason: "error",
							error: {
								kind: "refusal",
								retryable: false,
								providerCode: "blocked",
								message: "blocked by policy",
							},
						}
					: { stopReason: stop === "max" ? "length" : "stop" },
			mapUsage: (count): Usage | undefined =>
				count < 0
					? undefined
					: {
							availability: "complete",
							input: count,
							output: count,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2 * count,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
			...script.provider,
		},
	);
	return { stream, sent };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function httpError(status: number, headers?: Record<string, string>): Error {
	return Object.assign(new Error(`${status} failure`), { status, ...(headers ? { headers } : {}) });
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("stream runner lifecycle and hooks", () => {
	it("starts lazily, maps the stop reason, and ends with done", async () => {
		const { stream } = scriptedStream({});
		const events = await collect(stream(model, { messages: [] }));
		expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		const result = await stream(model, { messages: [] }).result();
		expect(result).toMatchObject({
			api: "test-api",
			provider: "test-provider",
			model: "test-model",
			stopReason: "stop",
			content: [{ type: "text", text: "hi" }],
		});
	});

	it("maps an error stop reason to an error terminal", async () => {
		const { stream } = scriptedStream({ parse: async (sink) => sink.stop("blocked") });
		const events = await collect(stream(model, { messages: [] }));
		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(events[1]).toMatchObject({
			reason: "error",
			error: { error: { kind: "refusal", retryable: false, providerCode: "blocked", message: "blocked by policy" } },
		});
	});

	it("passes an unreported stop reason to the hook as undefined", async () => {
		const mapStopReason = vi.fn((): StopReasonMapping => ({ stopReason: "length" }));
		const { stream } = scriptedStream({ parse: async () => {}, provider: { mapStopReason } });
		expect((await stream(model, { messages: [] }).result()).stopReason).toBe("length");
		expect(mapStopReason).toHaveBeenCalledWith(undefined, expect.anything());
	});

	it("records usage mapped by the usage hook and ignores unmapped reports", async () => {
		const { stream } = scriptedStream({
			parse: async (sink) => {
				sink.usage(3);
				sink.usage(-1);
				sink.stop("end");
			},
		});
		const result = await stream(model, { messages: [] }).result();
		expect(result.usage).toMatchObject({ availability: "complete", input: 3, output: 3, totalTokens: 6 });
	});

	it("passes the payload through onPayload once and reports the accepted response", async () => {
		const onPayload = vi.fn(() => ({ prompt: "replaced" }));
		const onResponse = vi.fn();
		const { stream, sent } = scriptedStream({});
		await stream(model, { messages: [] }, { onPayload, onResponse }).result();
		expect(onPayload).toHaveBeenCalledWith({ prompt: "hello" }, model, undefined);
		expect(sent).toEqual([{ prompt: "replaced" }]);
		expect(onResponse).toHaveBeenCalledWith({ status: 200, headers: { "x-test": "1" } }, model);
	});

	it("skips onPayload when the provider has no wire payload", async () => {
		const onPayload = vi.fn();
		const { stream } = scriptedStream({ request: { payload: undefined } });
		await stream(model, { messages: [] }, { onPayload }).result();
		expect(onPayload).not.toHaveBeenCalled();
	});

	it("runs finish before the terminal fragment on success and on failure", async () => {
		for (const sends of [["ok"], [httpError(400)]] as const) {
			const order: string[] = [];
			const { stream } = scriptedStream({
				sends: [...sends],
				request: {
					finish: async () => {
						order.push("finish");
					},
				},
			});
			const events = stream(model, { messages: [] });
			for await (const event of events) {
				if (event.type === "done" || event.type === "error") order.push(event.type);
			}
			expect(order).toEqual(["finish", sends[0] === "ok" ? "done" : "error"]);
		}
	});

	it("reports build failures as error terminals", async () => {
		const { stream } = scriptedStream({
			provider: {
				buildRequest: () => {
					throw new ProviderStreamError("auth", "No API key for provider: test-provider");
				},
			},
		});
		const events = await collect(stream(model, { messages: [] }));
		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(events[1]).toMatchObject({
			error: { error: { kind: "auth", retryable: false, message: "No API key for provider: test-provider" } },
		});
	});

	it("attaches the diagnostics of a typed provider failure", async () => {
		const diagnostic = { type: "invalid_tool_arguments", timestamp: 1, details: { code: "invalid_json" } };
		const { stream } = scriptedStream({
			parse: async () => {
				throw new ProviderStreamError("invalid_tool_call", "bad arguments", { diagnostics: [diagnostic] });
			},
		});
		const result = await stream(model, { messages: [] }).result();
		expect(result).toMatchObject({
			stopReason: "error",
			error: { kind: "invalid_tool_call", message: "bad arguments" },
		});
		expect(result.diagnostics).toEqual([diagnostic]);
	});

	it("falls back to the shared classification when mapError throws", async () => {
		const { stream } = scriptedStream({
			sends: [httpError(400)],
			provider: {
				mapError: () => {
					throw new Error("mapping failed");
				},
			},
		});
		expect(await stream(model, { messages: [] }).result()).toMatchObject({
			stopReason: "error",
			error: { kind: "invalid_request", retryable: false, providerCode: "400", message: "400 failure" },
		});
	});
});

describe("stream runner abort mapping", () => {
	it("maps an already-aborted signal to an aborted terminal", async () => {
		const controller = new AbortController();
		controller.abort();
		const { stream, sent } = scriptedStream({});
		const events = await collect(stream(model, { messages: [] }, { signal: controller.signal }));
		expect(events.map((event) => event.type)).toEqual(["start", "error"]);
		expect(events[1]).toMatchObject({
			reason: "aborted",
			error: { stopReason: "aborted", error: { kind: "aborted", retryable: false, message: "Request was aborted" } },
		});
		expect(sent).toHaveLength(0);
	});

	it("maps an abort during parsing to an aborted terminal regardless of the thrown error", async () => {
		const controller = new AbortController();
		const { stream } = scriptedStream({
			parse: async (sink) => {
				sink.push({ type: "text_start", contentIndex: 0 });
				sink.push({ type: "text_delta", contentIndex: 0, delta: "partial" });
				controller.abort();
				throw httpError(500);
			},
		});
		const result = await stream(model, { messages: [] }, { signal: controller.signal }).result();
		expect(result).toMatchObject({
			stopReason: "aborted",
			error: { kind: "aborted", message: "Request was aborted" },
			content: [{ type: "text", text: "partial" }],
		});
	});

	it("maps an abort after a successful parse to an aborted terminal", async () => {
		const controller = new AbortController();
		const { stream } = scriptedStream({
			parse: async (sink) => {
				sink.stop("end");
				controller.abort();
			},
		});
		const result = await stream(model, { messages: [] }, { signal: controller.signal }).result();
		expect(result.stopReason).toBe("aborted");
	});

	it("stops waiting for a retry when aborted", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const { stream, sent } = scriptedStream({ sends: [httpError(503), "ok"] });
		const result = stream(model, { messages: [] }, { signal: controller.signal, maxRetries: 1 }).result();
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		expect(await result).toMatchObject({ stopReason: "aborted", error: { kind: "aborted" } });
		expect(sent).toHaveLength(1);
	});
});

describe("stream runner retry policy", () => {
	it("does not retry by default", async () => {
		const { stream, sent } = scriptedStream({ sends: [httpError(503), "ok"] });
		expect(await stream(model, { messages: [] }).result()).toMatchObject({
			stopReason: "error",
			error: { kind: "overloaded", retryable: true, message: "503 failure" },
		});
		expect(sent).toHaveLength(1);
	});

	it("retries retryable send failures with exponential backoff up to maxRetries", async () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const { stream, sent } = scriptedStream({ sends: [httpError(429), httpError(500), httpError(529), "ok"] });
		const result = stream(model, { messages: [] }, { maxRetries: 3 }).result();
		await vi.advanceTimersByTimeAsync(7_000);
		expect((await result).stopReason).toBe("stop");
		expect(sent).toHaveLength(4);
		const delays = setTimeoutSpy.mock.calls.map((call) => call[1]).filter((delay) => typeof delay === "number");
		expect(delays).toEqual(expect.arrayContaining([1000, 2000, 4000]));
	});

	it("gives up after maxRetries", async () => {
		vi.useFakeTimers();
		const { stream, sent } = scriptedStream({ sends: [httpError(503), httpError(503), "ok"] });
		const result = stream(model, { messages: [] }, { maxRetries: 1 }).result();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(await result).toMatchObject({
			stopReason: "error",
			error: { kind: "overloaded", message: "503 failure" },
		});
		expect(sent).toHaveLength(2);
	});

	it.each([
		[400, "invalid_request"],
		[401, "auth"],
		[402, "quota"],
		[413, "context_overflow"],
	])("does not retry status %i (%s)", async (status) => {
		const { stream, sent } = scriptedStream({ sends: [httpError(status), "ok"] });
		expect((await stream(model, { messages: [] }, { maxRetries: 3 }).result()).stopReason).toBe("error");
		expect(sent).toHaveLength(1);
	});

	it("does not retry a quota error reported with a 429", async () => {
		const quota = Object.assign(httpError(429), { code: "insufficient_quota" });
		const { stream, sent } = scriptedStream({ sends: [quota, "ok"] });
		expect((await stream(model, { messages: [] }, { maxRetries: 3 }).result()).stopReason).toBe("error");
		expect(sent).toHaveLength(1);
	});

	it("retries transport failures found along the cause chain", async () => {
		vi.useFakeTimers();
		const network = new TypeError("fetch failed", {
			cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
		});
		const { stream, sent } = scriptedStream({ sends: [network, "ok"] });
		const result = stream(model, { messages: [] }, { maxRetries: 1 }).result();
		await vi.advanceTimersByTimeAsync(1_000);
		expect((await result).stopReason).toBe("stop");
		expect(sent).toHaveLength(2);
	});

	it("waits the server-requested delay", async () => {
		vi.useFakeTimers();
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
		const { stream, sent } = scriptedStream({ sends: [httpError(429, { "retry-after": "7" }), "ok"] });
		const result = stream(model, { messages: [] }, { maxRetries: 1 }).result();
		await vi.advanceTimersByTimeAsync(7_000);
		expect((await result).stopReason).toBe("stop");
		expect(sent).toHaveLength(2);
		expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 7_000);
	});

	it("fails immediately when the server asks for longer than maxRetryDelayMs", async () => {
		const { stream, sent } = scriptedStream({ sends: [httpError(429, { "retry-after": "120" }), "ok"] });
		const result = await stream(model, { messages: [] }, { maxRetries: 1, maxRetryDelayMs: 60_000 }).result();
		expect(result.stopReason).toBe("error");
		expect(result.error?.message).toContain("429 failure");
		expect(result.error?.message).toContain("120s retry delay");
		expect(sent).toHaveLength(1);
	});

	it("honors any server-requested delay when the cap is disabled", async () => {
		vi.useFakeTimers();
		const { stream, sent } = scriptedStream({ sends: [httpError(429, { "retry-after-ms": "120000" }), "ok"] });
		const result = stream(model, { messages: [] }, { maxRetries: 1, maxRetryDelayMs: 0 }).result();
		await vi.advanceTimersByTimeAsync(120_000);
		expect((await result).stopReason).toBe("stop");
		expect(sent).toHaveLength(2);
	});

	it("never retries a failure after the response was accepted", async () => {
		const { stream, sent } = scriptedStream({
			sends: ["ok", "ok"],
			parse: async (sink) => {
				sink.push({ type: "text_start", contentIndex: 0 });
				throw new ProviderStreamError("network", "connection dropped");
			},
		});
		const result = await stream(model, { messages: [] }, { maxRetries: 3 }).result();
		expect(result).toMatchObject({
			stopReason: "error",
			error: { kind: "network", retryable: true, message: "connection dropped" },
		});
		expect(sent).toHaveLength(1);
	});
});
