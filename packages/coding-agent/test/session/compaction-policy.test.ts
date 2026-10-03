import { type AgentMessage, type ConversationLogEntry, fold } from "@hansjm10/volt-agent-core";
import type { AssistantMessage, StopReason } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import type { CompactionSettings } from "../../src/core/compaction/index.ts";
import {
	type CompactionModel,
	checkResponseCompaction,
	latestCompactionTime,
	type ResponseCompactionCheck,
	shouldCompactBeforeContinuing,
} from "../../src/core/session/compaction-policy.ts";

const MODEL: CompactionModel = { provider: "test", id: "model", contextWindow: 1_000 };
const SETTINGS: CompactionSettings = { enabled: true, reserveTokens: 100, keepRecentTokens: 100 };

function assistant(
	options: {
		stopReason?: StopReason;
		input?: number;
		text?: string;
		toolCall?: boolean;
		timestamp?: number;
		model?: string;
		overflow?: boolean;
	} = {},
): AssistantMessage {
	const input = options.input ?? 10;
	return {
		role: "assistant",
		content: [
			{ type: "text", text: options.text ?? "answer" },
			...(options.toolCall ? [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: {} }] : []),
		],
		api: "test-api",
		provider: "test",
		model: options.model ?? "model",
		usage: {
			input,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: options.stopReason ?? "stop",
		...(options.overflow ? { error: { kind: "context_overflow", retryable: false, message: "too long" } } : {}),
		timestamp: options.timestamp ?? 100,
	};
}

const user: AgentMessage = { role: "user", content: "question", timestamp: 1 };

function responseCheck(
	message: AssistantMessage,
	changes: Partial<Omit<ResponseCompactionCheck, "context">> & { messages?: readonly AgentMessage[] } = {},
): ResponseCompactionCheck {
	const { messages, ...rest } = changes;
	return {
		message,
		includeAborted: false,
		model: MODEL,
		settings: SETTINGS,
		overflowRecoveryAttempted: false,
		compactedAt: () => undefined,
		context: () => ({ messages: messages ?? [user, message] }),
		...rest,
	};
}

describe("compaction policy", () => {
	it("stops a continuing turn for compaction once the live context crosses the threshold", () => {
		const message = assistant({ input: 950, toolCall: true, stopReason: "toolUse" });
		const check = { message, continuing: true, messages: [user, message], model: MODEL, settings: SETTINGS };
		expect(shouldCompactBeforeContinuing(check)).toBe(true);
		expect(shouldCompactBeforeContinuing({ ...check, continuing: false })).toBe(false);
		expect(shouldCompactBeforeContinuing({ ...check, settings: { ...SETTINGS, enabled: false } })).toBe(false);
		expect(shouldCompactBeforeContinuing({ ...check, model: undefined })).toBe(false);
		expect(shouldCompactBeforeContinuing({ ...check, model: { ...MODEL, id: "other" } })).toBe(false);
		for (const stopReason of ["aborted", "error"] as const) {
			const failed = assistant({ input: 950, stopReason });
			expect(shouldCompactBeforeContinuing({ ...check, message: failed, messages: [user, failed] })).toBe(false);
		}
		const small = assistant({ input: 10, toolCall: true, stopReason: "toolUse" });
		expect(shouldCompactBeforeContinuing({ ...check, message: small, messages: [user, small] })).toBe(false);
		// Tool results after the response count toward the estimate.
		const toolResult: AgentMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "x".repeat(4_000) }],
			isError: false,
			timestamp: 2,
		};
		expect(shouldCompactBeforeContinuing({ ...check, message: small, messages: [user, small, toolResult] })).toBe(
			true,
		);
		// A configured threshold applies below the context limit.
		expect(
			shouldCompactBeforeContinuing({
				...check,
				message: small,
				messages: [user, small],
				settings: { ...SETTINGS, thresholdTokens: 5 },
			}),
		).toBe(true);
	});

	it("compacts and retries an overflow from the selected model once", () => {
		const overflow = assistant({ stopReason: "error", overflow: true });
		expect(checkResponseCompaction(responseCheck(overflow))).toEqual({ kind: "overflow" });
		expect(checkResponseCompaction(responseCheck(overflow, { overflowRecoveryAttempted: true }))).toEqual({
			kind: "overflow_exhausted",
		});
		// An overflow from another model says nothing about the selected one.
		expect(
			checkResponseCompaction(responseCheck(assistant({ stopReason: "error", overflow: true, model: "small" }))),
		).toEqual({
			kind: "none",
		});
		expect(checkResponseCompaction(responseCheck(overflow, { settings: { ...SETTINGS, enabled: false } }))).toEqual({
			kind: "none",
		});
	});

	it("compacts a response over the threshold, continuing only after an empty length stop", () => {
		expect(checkResponseCompaction(responseCheck(assistant({ input: 950 })))).toEqual({
			kind: "threshold",
			continueAfterCompaction: false,
		});
		expect(
			checkResponseCompaction(responseCheck(assistant({ input: 950, stopReason: "length", text: " " }))),
		).toEqual({ kind: "threshold", continueAfterCompaction: true });
		expect(
			checkResponseCompaction(responseCheck(assistant({ input: 950, stopReason: "length", text: "partial" }))),
		).toEqual({ kind: "threshold", continueAfterCompaction: false });
		expect(checkResponseCompaction(responseCheck(assistant({ input: 10 })))).toEqual({ kind: "none" });
	});

	it("checks an aborted response only before a prompt, from its own usage when nothing else reports usage", () => {
		const aborted = assistant({ input: 950, stopReason: "aborted" });
		expect(checkResponseCompaction(responseCheck(aborted))).toEqual({ kind: "none" });
		expect(checkResponseCompaction(responseCheck(aborted, { includeAborted: true }))).toEqual({
			kind: "threshold",
			continueAfterCompaction: false,
		});
	});

	it("never compacts again for usage older than the latest compaction", () => {
		const large = assistant({ input: 950, timestamp: 100 });
		expect(checkResponseCompaction(responseCheck(large, { compactedAt: () => 100 }))).toEqual({ kind: "none" });
		expect(checkResponseCompaction(responseCheck(large, { compactedAt: () => 99 }))).toEqual({
			kind: "threshold",
			continueAfterCompaction: false,
		});
		// An error needs a usage source after the compaction.
		const error = assistant({ stopReason: "error", timestamp: 200 });
		expect(checkResponseCompaction(responseCheck(error, { messages: [user, error] }))).toEqual({ kind: "none" });
		expect(
			checkResponseCompaction(responseCheck(error, { messages: [user, large, error], compactedAt: () => 150 })),
		).toEqual({ kind: "none" });
		expect(
			checkResponseCompaction(responseCheck(error, { messages: [user, large, error], compactedAt: () => 50 })),
		).toEqual({ kind: "threshold", continueAfterCompaction: false });
	});

	it("reads the branch only when a response is checked, and its context only for the threshold", () => {
		const reads: string[] = [];
		const check = (message: AssistantMessage, changes: Partial<ResponseCompactionCheck> = {}) =>
			checkResponseCompaction({
				...responseCheck(message),
				compactedAt: () => {
					reads.push("compaction");
					return undefined;
				},
				context: () => {
					reads.push("context");
					return { messages: [user, message] };
				},
				...changes,
			});
		check(assistant({ input: 950 }), { settings: { ...SETTINGS, enabled: false } });
		check(assistant({ stopReason: "aborted" }));
		expect(reads).toEqual([]);
		check(assistant({ stopReason: "error", overflow: true }));
		expect(reads).toEqual(["compaction"]);
		check(assistant({ input: 950 }));
		expect(reads).toEqual(["compaction", "compaction", "context"]);
	});

	it("finds the active branch's latest compaction in a conversation state", () => {
		const entries: ConversationLogEntry[] = [
			{
				ordinal: 1,
				id: "u1",
				parentId: null,
				type: "message",
				timestamp: "2026-01-01T00:00:00.000Z",
				visibility: "public",
				payload: { message: { role: "user", content: "a", timestamp: 1 } },
			},
			{
				ordinal: 2,
				id: "c1",
				parentId: "u1",
				type: "compaction",
				timestamp: "2026-01-01T00:00:01.000Z",
				visibility: "public",
				payload: { summary: "s", firstKeptEntryId: "u1", tokensBefore: 10 },
			},
			{
				ordinal: 3,
				id: "u2",
				parentId: "c1",
				type: "message",
				timestamp: "2026-01-01T00:00:02.000Z",
				visibility: "public",
				payload: { message: { role: "user", content: "b", timestamp: 2 } },
			},
		];
		expect(latestCompactionTime(fold([]))).toBeUndefined();
		expect(latestCompactionTime(fold(entries))).toBe(Date.parse("2026-01-01T00:00:01.000Z"));
		const branched: ConversationLogEntry = {
			ordinal: 4,
			id: "u3",
			parentId: "u1",
			type: "message",
			timestamp: "2026-01-01T00:00:03.000Z",
			visibility: "public",
			payload: { message: { role: "user", content: "c", timestamp: 3 } },
		};
		expect(latestCompactionTime(fold([...entries, branched]))).toBeUndefined();
	});
});
