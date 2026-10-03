import type { AgentMessage } from "@hansjm10/volt-agent-core";
import type {
	AssistantMessage,
	AssistantMessageDiagnostic,
	ProviderErrorKind,
	ToolResultMessage,
} from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import {
	hasLocalStreamFailure,
	isRejectedToolCallResponse,
	isRetryableError,
	type RetrySettings,
	retryContextMessages,
	retryDelayMs,
	willRetryAfterRun,
} from "../../src/core/session/retry-policy.ts";

const SETTINGS: RetrySettings = { enabled: true, maxRetries: 3, baseDelayMs: 100 };
const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function failure(
	options: { retryable?: boolean; kind?: ProviderErrorKind; diagnostics?: AssistantMessageDiagnostic[] } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: 1 } }],
		api: "test-api",
		provider: "test",
		model: "model",
		usage: USAGE,
		stopReason: "error",
		error: { kind: options.kind ?? "server", retryable: options.retryable ?? true, message: "failed" },
		...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
		timestamp: 1,
	};
}

const REJECTED: AssistantMessageDiagnostic = {
	type: "invalid_tool_arguments",
	timestamp: 1,
	details: { contentIndex: 0 },
};
const QUEUE_LIMIT: AssistantMessageDiagnostic = { type: "assistant_stream_queue_limit", timestamp: 1 };

function success(): AssistantMessage {
	return { ...failure(), content: [{ type: "text", text: "done" }], stopReason: "stop", error: undefined };
}

describe("retry policy", () => {
	it("retries retryable provider failures and rejected tool calls, never local stream failures", () => {
		expect(isRetryableError(failure())).toBe(true);
		expect(isRetryableError(failure({ retryable: false }))).toBe(false);
		expect(isRetryableError(failure({ retryable: false, diagnostics: [REJECTED] }))).toBe(true);
		expect(isRetryableError(failure({ diagnostics: [QUEUE_LIMIT] }))).toBe(false);
		expect(isRetryableError(failure({ retryable: false, diagnostics: [REJECTED, QUEUE_LIMIT] }))).toBe(false);
		expect(isRetryableError(success())).toBe(false);
		expect(hasLocalStreamFailure([QUEUE_LIMIT])).toBe(true);
		expect(hasLocalStreamFailure(undefined)).toBe(false);
		expect(isRejectedToolCallResponse([REJECTED])).toBe(true);
		expect(isRejectedToolCallResponse([REJECTED, QUEUE_LIMIT])).toBe(false);
	});

	it("backs off exponentially up to the retry limit and retries rejected tool calls at once", () => {
		expect([1, 2, 3, 4].map((attempt) => retryDelayMs(failure(), attempt, SETTINGS))).toEqual([
			100,
			200,
			400,
			undefined,
		]);
		expect(retryDelayMs(failure({ retryable: false, diagnostics: [REJECTED] }), 2, SETTINGS)).toBe(0);
		expect(retryDelayMs(failure(), 1, { ...SETTINGS, enabled: false })).toBeUndefined();
		expect(retryDelayMs(failure({ retryable: false }), 1, SETTINGS)).toBeUndefined();
	});

	it("predicts a retry from the run's last response and the attempts already made", () => {
		const user: AgentMessage = { role: "user", content: "hi", timestamp: 1 };
		expect(willRetryAfterRun([user, failure()], 0, SETTINGS)).toBe(true);
		expect(willRetryAfterRun([user, failure()], 3, SETTINGS)).toBe(false);
		expect(willRetryAfterRun([user, failure()], 0, { ...SETTINGS, enabled: false })).toBe(false);
		expect(willRetryAfterRun([user, success()], 0, SETTINGS)).toBe(false);
		expect(willRetryAfterRun([user], 0, SETTINGS)).toBe(false);
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [],
			isError: false,
			timestamp: 2,
		};
		expect(willRetryAfterRun([failure(), toolResult], 0, SETTINGS)).toBe(true);
		const transactionFailure = failure({
			diagnostics: [{ type: "delivery_transaction_failure", timestamp: 1 }],
		});
		expect(willRetryAfterRun([user, transactionFailure], 0, SETTINGS)).toBe(false);
	});

	it("leaves trailing failures out of a retried request and replaces rejected tool calls with feedback", () => {
		const user: AgentMessage = { role: "user", content: "hi", timestamp: 1 };
		const transient = failure();
		const rejected = failure({ retryable: false, diagnostics: [REJECTED] });
		expect(retryContextMessages([user, transient])).toEqual([user]);
		const projected = retryContextMessages([user, transient, rejected]);
		expect(projected.slice(0, 1)).toEqual([user]);
		expect(projected).toHaveLength(2);
		expect(projected[1]).toMatchObject({ role: "user" });
		expect(JSON.stringify(projected[1])).toContain("none of its tool calls were executed");
		expect(JSON.stringify(projected[1])).toContain("the `read` tool call");
		const settled = [user, success()];
		expect(retryContextMessages(settled)).toEqual(settled);
	});
});
