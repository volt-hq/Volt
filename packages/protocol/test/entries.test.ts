import { Type } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	CORE_LOG_ENTRY_TYPES,
	type CoreLogEntryTypeName,
	defineLogEntryType,
	LOG_ENTRY_ENVELOPE_KEYS,
	type LogEntry,
	LogEntrySchema,
} from "../src/entries.ts";

const TIMESTAMP = "2026-10-03T12:00:00.000Z";
const MESSAGE_TIME = Date.parse(TIMESTAMP);

const PAYLOADS: { [K in CoreLogEntryTypeName]: Record<string, unknown> } = {
	message: { message: { role: "user", content: "hello", timestamp: MESSAGE_TIME } },
	client_input_receipt: {
		clientMessageId: "client-1",
		command: "prompt",
		semanticDigest: "a".repeat(64),
		input: { message: "hello", images: [], streamingBehavior: "steer" },
	},
	client_input_queued: {
		receiptId: "receipt",
		clientMessageId: "client-1",
		queuedInput: { delivery: "follow_up", message: "later", images: [] },
	},
	client_input_state: { receiptId: "receipt", clientMessageId: "client-1", state: "withdrawn" },
	thinking_level_change: { thinkingLevel: "high" },
	fast_mode_change: { enabled: true },
	model_change: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
	planning_state_change: {
		planning: {
			mode: "plan",
			plan: {
				id: "plan-1",
				revision: 2,
				phase: "active",
				steps: [{ id: "s1", text: "Write tests", status: "in_progress" }],
				execution: {
					id: "run-1",
					approvedRevision: 2,
					strategy: "retain_context",
					sourceSessionId: "session-a",
					targetSessionId: "session-a",
				},
			},
		},
	},
	compaction: { summary: "summary", firstKeptEntryId: "e1", tokensBefore: 1200, details: { files: ["a.ts"] } },
	branch_summary: { fromId: "root", summary: "explored an alternative", fromHook: false },
	custom: { customType: "volt.review.run", data: { runId: "r1" } },
	custom_message: { customType: "notice", content: [{ type: "text", text: "heads up" }], display: true },
	label: { targetId: "e1", label: "bookmark" },
	session_info: { name: "Refactor" },
	leaf: { targetId: null },
	subagent_spawn: {
		toolCallId: "call-1",
		subagentId: "sa-1",
		agent: "researcher",
		childSessionId: "child-session",
		childSessionRef: {
			sessionDirectory: "/sessions/child",
			storeId: "store",
			sessionId: "child-session",
			sessionGeneration: "generation",
		},
		requestKey: "request-1",
	},
	forked_from: { sessionId: "source-session", entryId: "e42" },
};

function entryOf(type: CoreLogEntryTypeName, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		ordinal: 7,
		id: `${type}-entry`,
		parentId: "e6",
		type,
		timestamp: TIMESTAMP,
		visibility: CORE_LOG_ENTRY_TYPES[type].visibility,
		payload: PAYLOADS[type],
		...overrides,
	};
}

describe("log entry envelope", () => {
	it("accepts a representative entry of every core type through its own schema and the union", () => {
		for (const type of Object.keys(CORE_LOG_ENTRY_TYPES) as CoreLogEntryTypeName[]) {
			const entry = entryOf(type);
			expect(Check(CORE_LOG_ENTRY_TYPES[type].schema, entry), type).toBe(true);
			expect(Check(LogEntrySchema, entry), type).toBe(true);
		}
	});

	it("keeps host records off the public projection", () => {
		const host = Object.values(CORE_LOG_ENTRY_TYPES)
			.filter((definition) => definition.visibility === "host")
			.map((definition) => definition.type);
		expect(host).toEqual([
			"client_input_receipt",
			"client_input_queued",
			"client_input_state",
			"leaf",
			"subagent_spawn",
			"forked_from",
		]);
		expect(Check(LogEntrySchema, entryOf("leaf", { visibility: "public" }))).toBe(false);
		expect(Check(LogEntrySchema, entryOf("message", { visibility: "host" }))).toBe(false);
	});

	it("carries a client message identity beside a message payload, never inside it", () => {
		const message = entryOf("message", { clientMessageId: "client-1" });
		expect(Check(LogEntrySchema, message)).toBe(true);
		expect(Check(LogEntrySchema, entryOf("message", { clientMessageId: "local-queue:1" }))).toBe(false);
		expect(Check(LogEntrySchema, entryOf("model_change", { clientMessageId: "client-1" }))).toBe(false);
		expect(
			Check(
				LogEntrySchema,
				entryOf("message", {
					payload: { message: { role: "user", content: "hi", timestamp: 1, clientMessageId: "client-1" } },
				}),
			),
		).toBe(false);
	});

	it("rejects unknown fields in the envelope and in payloads", () => {
		expect(Check(LogEntrySchema, entryOf("label", { extra: true }))).toBe(false);
		expect(Check(LogEntrySchema, entryOf("label", { payload: { targetId: "e1", color: "red" } }))).toBe(false);
		expect(
			Check(
				LogEntrySchema,
				entryOf("client_input_receipt", {
					payload: { ...PAYLOADS.client_input_receipt, input: { message: "x", images: [], priority: 1 } },
				}),
			),
		).toBe(false);
	});

	it("rejects malformed envelope positions and identities", () => {
		for (const overrides of [
			{ ordinal: 0 },
			{ ordinal: 1.5 },
			{ id: "" },
			{ id: "bad\u0000id" },
			{ parentId: undefined },
			{ timestamp: "2026-10-03" },
			{ timestamp: "2026-10-03T12:00:00Z" },
			{ type: "unknown_type" },
		]) {
			expect(Check(LogEntrySchema, entryOf("custom", overrides)), JSON.stringify(overrides)).toBe(false);
		}
		expect(Check(LogEntrySchema, entryOf("forked_from", { payload: { sessionId: "-bad-", entryId: "e1" } }))).toBe(
			false,
		);
	});

	it("validates payload vocabularies", () => {
		expect(Check(LogEntrySchema, entryOf("thinking_level_change", { payload: { thinkingLevel: "turbo" } }))).toBe(
			false,
		);
		for (const state of ["accepted", "started", "completed", "failed", "withdrawn"]) {
			const payload = { ...PAYLOADS.client_input_state, state };
			expect(Check(LogEntrySchema, entryOf("client_input_state", { payload })), state).toBe(true);
		}
		expect(
			Check(
				LogEntrySchema,
				entryOf("client_input_state", { payload: { ...PAYLOADS.client_input_state, state: "cancelled" } }),
			),
		).toBe(false);
		expect(Check(LogEntrySchema, entryOf("model_change", { payload: { provider: "", modelId: "m" } }))).toBe(false);
		expect(
			Check(LogEntrySchema, entryOf("compaction", { payload: { ...PAYLOADS.compaction, tokensBefore: -1 } })),
		).toBe(false);
	});

	it("stores every message role the log keeps", () => {
		const messages = [
			{ role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "bashExecution", command: "pwd", output: "/", cancelled: false, truncated: false, timestamp: 4 },
			{ role: "custom", customType: "notice", content: "hi", display: false, timestamp: 5 },
		];
		for (const message of messages) {
			expect(Check(LogEntrySchema, entryOf("message", { payload: { message } })), message.role).toBe(true);
		}
		expect(
			Check(
				LogEntrySchema,
				entryOf("message", {
					payload: { message: { role: "branchSummary", summary: "s", fromId: "x", timestamp: 1 } },
				}),
			),
		).toBe(false);
	});

	it("narrows the static entry union by type", () => {
		const entry = entryOf("model_change") as LogEntry;
		if (entry.type === "model_change") {
			expect(entry.payload.modelId).toBe("claude-sonnet-4-5");
		}
	});
});

describe("product entry types", () => {
	it("defines a host-registered type with the same closed envelope", () => {
		const binding = defineLogEntryType(
			"pr_review_binding",
			"host",
			Type.Object({ placement: Type.Object({ worktreeId: Type.String() }) }, { additionalProperties: false }),
		);
		expect(Object.keys(binding.schema.properties)).toEqual([...LOG_ENTRY_ENVELOPE_KEYS]);
		const entry = {
			ordinal: 1,
			id: "binding",
			parentId: null,
			type: "pr_review_binding",
			timestamp: TIMESTAMP,
			visibility: "host",
			payload: { placement: { worktreeId: "wt-1" } },
		};
		expect(Check(binding.schema, entry)).toBe(true);
		expect(Check(binding.schema, { ...entry, visibility: "public" })).toBe(false);
		expect(Check(LogEntrySchema, entry)).toBe(false);
	});
});
