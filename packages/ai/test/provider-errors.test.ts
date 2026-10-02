import { describe, expect, it } from "vitest";
import type { AssistantStreamFragment } from "../src/stream/fragments.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import {
	classifyHttpStatus,
	classifyProviderCode,
	classifyProviderError,
	classifyTransportError,
	createProviderError,
	ProviderStreamError,
	parseRetryAfterMs,
	readRetryAfterMs,
} from "../src/stream/provider-errors.ts";

describe("provider error classification", () => {
	it.each([
		[400, "bad request", "invalid_request", false],
		[400, "prompt is too long: 213462 tokens > 200000 maximum", "context_overflow", false],
		[401, "unauthorized", "auth", false],
		[402, "insufficient credits", "quota", false],
		[403, "forbidden", "auth", false],
		[404, "model not found", "invalid_request", false],
		[408, "request timeout", "timeout", true],
		[409, "conflict", "server", true],
		[413, "request too large", "context_overflow", false],
		[422, "unprocessable", "invalid_request", false],
		[429, "too many requests", "rate_limit", true],
		[429, "Too many tokens, please wait", "rate_limit", true],
		[500, "internal", "server", true],
		[502, "bad gateway", "server", true],
		[503, "unavailable", "overloaded", true],
		[504, "gateway timeout", "timeout", true],
		[529, "overloaded", "overloaded", true],
	] as const)("classifies HTTP %i (%s) as %s", (status, message, kind, retryable) => {
		expect(classifyHttpStatus(status, message)).toEqual({
			kind,
			retryable,
			providerCode: String(status),
			message,
		});
	});

	it.each([
		["overloaded_error", 529, "overloaded"],
		["rate_limit_error", 429, "rate_limit"],
		["billing_error", 400, "quota"],
		["insufficient_quota", 429, "quota"],
		["usage_limit_reached", 429, "quota"],
		["GoUsageLimitError", 429, "quota"],
		["context_length_exceeded", 400, "context_overflow"],
		["authentication_error", 401, "auth"],
	] as const)("lets provider code %s override status %i", (code, status, kind) => {
		expect(classifyHttpStatus(status, "failure", code)).toMatchObject({ kind, providerCode: code });
	});

	it("classifies SDK errors from their status and code", () => {
		const error = Object.assign(new Error("429 quota"), { status: 429, code: "insufficient_quota" });
		expect(classifyProviderError(error)).toEqual({
			kind: "quota",
			retryable: false,
			providerCode: "insufficient_quota",
			message: "429 quota",
		});
		const anthropic = Object.assign(new Error("529 overloaded"), { status: 529, type: "overloaded_error" });
		expect(classifyProviderError(anthropic)).toMatchObject({ kind: "overloaded", retryable: true });
	});

	it("classifies status codes reported as statusCode", () => {
		expect(classifyProviderError(Object.assign(new Error("boom"), { statusCode: 503 }))).toMatchObject({
			kind: "overloaded",
		});
	});

	it("classifies mid-stream error codes without a status", () => {
		expect(classifyProviderCode("rate_limit_exceeded", "slow down")).toMatchObject({
			kind: "rate_limit",
			retryable: true,
		});
		expect(classifyProviderCode("server_error", "oops")).toMatchObject({ kind: "server", retryable: true });
		expect(classifyProviderCode("weird", "Provider finish_reason: model_context_window_exceeded")).toMatchObject({
			kind: "context_overflow",
			retryable: false,
		});
		expect(classifyProviderCode(undefined, "something odd")).toEqual({
			kind: "unknown",
			retryable: false,
			message: "something odd",
		});
	});

	it("finds transport failures along the cause chain", () => {
		const reset = new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNRESET" }) });
		expect(classifyTransportError(reset)).toBe("network");
		expect(classifyTransportError(new TypeError("terminated"))).toBe("network");
		const timeout = new Error("outer", { cause: Object.assign(new Error("y"), { code: "UND_ERR_HEADERS_TIMEOUT" }) });
		expect(classifyTransportError(timeout)).toBe("timeout");
		expect(classifyTransportError(Object.assign(new Error("z"), { name: "TimeoutError" }))).toBe("timeout");
		expect(classifyTransportError(new Error("plain"))).toBeUndefined();
		expect(classifyProviderError(reset)).toEqual({ kind: "network", retryable: true, message: "fetch failed" });
	});

	it("reports unrecognized failures as unknown and non-retryable", () => {
		expect(classifyProviderError(new Error("mystery"))).toEqual({
			kind: "unknown",
			retryable: false,
			message: "mystery",
		});
		expect(classifyProviderError({ detail: 1 })).toMatchObject({ kind: "unknown", message: '{"detail":1}' });
	});

	it("keeps the classification of a typed provider failure", () => {
		const error = new ProviderStreamError("network", "stream ended", { providerCode: "eof" });
		expect(classifyProviderError(error, { message: "ignored" })).toEqual({
			kind: "network",
			retryable: true,
			providerCode: "eof",
			message: "stream ended",
		});
	});

	it("lets callers override retryability", () => {
		expect(createProviderError("server", "not implemented", { retryable: false })).toEqual({
			kind: "server",
			retryable: false,
			message: "not implemented",
		});
	});
});

describe("retry-after parsing", () => {
	it("prefers retry-after-ms, then seconds, then an HTTP date", () => {
		expect(parseRetryAfterMs("1500", "60")).toBe(1500);
		expect(parseRetryAfterMs(undefined, "60")).toBe(60_000);
		const date = new Date(Date.now() + 45_000).toUTCString();
		expect(parseRetryAfterMs(undefined, date)).toBeGreaterThan(40_000);
		expect(parseRetryAfterMs(undefined, "soon")).toBeUndefined();
		expect(parseRetryAfterMs(undefined, undefined)).toBeUndefined();
	});

	it("reads Headers instances and plain header records", () => {
		expect(readRetryAfterMs({ headers: new Headers({ "retry-after": "2" }) })).toBe(2000);
		expect(readRetryAfterMs({ headers: { "retry-after-ms": "250" } })).toBe(250);
		expect(readRetryAfterMs(new ProviderStreamError("rate_limit", "x", { retryAfterMs: 10 }))).toBe(10);
		expect(readRetryAfterMs(new Error("no headers"))).toBeUndefined();
	});
});

describe("typed errors on normalized assistant messages", () => {
	const init = { api: "test", provider: "test", model: "test", timestamp: 0 };

	async function finish(
		fragments: AssistantStreamFragment[],
		options?: ConstructorParameters<typeof AssistantStreamNormalizer>[0],
	) {
		const normalizer = new AssistantStreamNormalizer(options);
		normalizer.push({ type: "start", init });
		for (const fragment of fragments) normalizer.push(fragment);
		normalizer.end();
		return normalizer.stream.result();
	}

	it("reports rejected tool arguments as a non-retryable invalid tool call", async () => {
		const result = await finish([
			{ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" },
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"unfinished' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse" },
		]);
		expect(result.error).toEqual({
			kind: "invalid_tool_call",
			retryable: false,
			message: "Tool arguments must be a complete, valid JSON object. No tools were executed.",
		});
		expect(Object.isFrozen(result.error)).toBe(true);
	});

	it("keeps the abort as the cause after rejected tool arguments", async () => {
		const result = await finish([
			{ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" },
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"unfinished' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "error", reason: "aborted", error: createProviderError("aborted", "Request was aborted") },
		]);
		expect(result).toMatchObject({ stopReason: "aborted", error: { kind: "aborted" } });
	});

	it("reports a tool argument limit as a non-retryable stream limit", async () => {
		const result = await finish(
			[
				{ type: "toolcall_start", contentIndex: 0, id: "call", name: "edit" },
				{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"far too long for the limit"}' },
			],
			{ toolArgumentLimits: { maxBytes: 8 } },
		);
		expect(result.error).toMatchObject({ kind: "stream_limit", retryable: false });
		expect(result.diagnostics).toContainEqual(expect.objectContaining({ type: "tool_argument_generation_limit" }));
	});

	it("reports a fragment source that ended without a terminal as a retryable network failure", async () => {
		const result = await finish([{ type: "text_start", contentIndex: 0 }]);
		expect(result.error).toEqual({
			kind: "network",
			retryable: true,
			message: "Assistant stream ended without a terminal fragment",
		});
	});
});
