import { Type } from "typebox";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	CORE_LOG_ENTRY_TYPES,
	type CoreLogEntryTypeName,
	clientInputDigestMaterial,
	defineLogEntryType,
	LOG_ENTRY_ENVELOPE_KEYS,
	type LogEntry,
	LogEntrySchema,
	WorkNoticeDetailsSchema,
} from "../src/entries.ts";
import {
	WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
	WORK_DATA_MAX_SERIALIZED_BYTES,
	WORK_INPUT_MAX_SERIALIZED_BYTES,
	WORK_OUTPUT_MAX_UTF8_BYTES,
	WorkKindSchema,
	workPayloadBoundsError,
} from "../src/work.ts";

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
	forked_from: { sessionId: "source-session", entryId: "e42" },
	work_started: {
		workId: "sa_1",
		kind: "subagent",
		title: "Research the cache layer",
		parentWorkId: "job-1",
		input: { prompt: "look", agent: "researcher" },
		cancellable: true,
		delivery: "none",
		resume: true,
		state: "running",
		toolCallId: "call-1",
		child: {
			conversation: "child-session",
			ref: {
				sessionDirectory: "/sessions/child",
				storeId: "store",
				sessionId: "child-session",
				sessionGeneration: "generation",
			},
		},
	},
	work_checkpoint: {
		workId: "sa_1",
		state: "cancelling",
		progress: { text: "wave 2", value: 2, max: 3, steps: [{ key: "w1", label: "Wave 1", status: "done" }] },
		detail: { type: "text", text: "two of three waves" },
	},
	work_finished: {
		workId: "sa_1",
		outcome: "completed",
		result: {
			summary: "found it",
			output: { text: "tail", truncated: true },
			child: { conversation: "discussion" },
			data: { findings: 2 },
		},
	},
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
			"forked_from",
			"work_started",
			"work_checkpoint",
			"work_finished",
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

	it("records a host origin and the messages a host input queues", () => {
		const notice = { role: "custom", customType: "notice", content: "done", display: true, timestamp: 1 };
		expect(
			Check(
				LogEntrySchema,
				entryOf("client_input_receipt", { payload: { ...PAYLOADS.client_input_receipt, origin: "host" } }),
			),
		).toBe(true);
		expect(
			Check(
				LogEntrySchema,
				entryOf("client_input_receipt", { payload: { ...PAYLOADS.client_input_receipt, origin: "client" } }),
			),
		).toBe(false);
		const queued = (messages: unknown[]) =>
			entryOf("client_input_queued", {
				payload: {
					...PAYLOADS.client_input_queued,
					queuedInput: { delivery: "steer", message: "", images: [], messages },
				},
			});
		expect(Check(LogEntrySchema, queued([notice]))).toBe(true);
		expect(Check(LogEntrySchema, queued([]))).toBe(false);
		const quiet = (wake: unknown) =>
			entryOf("client_input_queued", {
				payload: {
					...PAYLOADS.client_input_queued,
					queuedInput: { delivery: "steer", message: "", images: [], messages: [notice], wake },
				},
			});
		expect(Check(LogEntrySchema, quiet(false))).toBe(true);
		expect(Check(LogEntrySchema, quiet(true))).toBe(false);
		expect(Check(LogEntrySchema, queued([{ role: "compactionSummary", summary: "x", timestamp: 1 }]))).toBe(false);
	});

	it("digests client input from canonical material", () => {
		const image = { data: "aW1n", mimeType: "image/png", type: "image" as const };
		expect(
			clientInputDigestMaterial("prompt", { message: "hi", images: [image], streamingBehavior: "followUp" }),
		).toBe(
			'{"command":"prompt","message":"hi","images":[{"type":"image","mimeType":"image/png","data":"aW1n"}],"streamingBehavior":"followUp"}',
		);
		expect(clientInputDigestMaterial("steer", { message: "", images: [] })).toBe(
			'{"command":"steer","message":"","images":[]}',
		);
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
		expect(Check(LogEntrySchema, entryOf("forked_from", { payload: { sessionId: "source", entryId: null } }))).toBe(
			true,
		);
		expect(Check(LogEntrySchema, entryOf("forked_from", { payload: { sessionId: "source", entryId: "" } }))).toBe(
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

describe("work entries", () => {
	const withPayload = (type: "work_started" | "work_checkpoint" | "work_finished", changes: Record<string, unknown>) =>
		entryOf(type, { payload: { ...PAYLOADS[type], ...changes } });

	it("accepts built-in and extension kinds only", () => {
		for (const kind of [
			"job",
			"subagent",
			"review",
			"host_action",
			"ext:swarm-review/run",
			"ext:a/b_c-1",
			"ext:volt-x/run",
		]) {
			expect(Check(WorkKindSchema, kind), kind).toBe(true);
		}
		for (const kind of [
			"",
			"jobs",
			"ext:",
			"ext:Swarm/run",
			"ext:swarm-review",
			"ext:-x/run",
			"ext:a/b/c",
			"ext:volt/run",
		]) {
			expect(Check(WorkKindSchema, kind), kind).toBe(false);
		}
	});

	it("validates lifecycle vocabularies and rendered text", () => {
		expect(Check(LogEntrySchema, withPayload("work_started", { state: "awaiting_approval" }))).toBe(true);
		expect(Check(LogEntrySchema, withPayload("work_started", { state: "cancelling" }))).toBe(false);
		expect(Check(LogEntrySchema, withPayload("work_started", { delivery: "notify" }))).toBe(false);
		expect(Check(LogEntrySchema, withPayload("work_started", { title: "" }))).toBe(false);
		expect(Check(LogEntrySchema, withPayload("work_started", { title: "x".repeat(201) }))).toBe(false);
		expect(Check(LogEntrySchema, withPayload("work_started", { title: "two\nlines" }))).toBe(false);
		expect(Check(LogEntrySchema, withPayload("work_started", { title: "\u001b[31mred" }))).toBe(false);
		expect(Check(LogEntrySchema, withPayload("work_checkpoint", { state: "awaiting_approval" }))).toBe(false);
		expect(Check(LogEntrySchema, withPayload("work_checkpoint", { progress: { value: -1 } }))).toBe(false);
		expect(Check(LogEntrySchema, entryOf("work_checkpoint", { payload: { workId: "sa_1" } }))).toBe(true);
		for (const outcome of ["completed", "failed", "cancelled", "interrupted"]) {
			expect(Check(LogEntrySchema, withPayload("work_finished", { outcome })), outcome).toBe(true);
		}
		expect(Check(LogEntrySchema, withPayload("work_finished", { outcome: "aborted" }))).toBe(false);
		expect(Check(LogEntrySchema, withPayload("work_finished", { error: "line\n\u001b[0m" }))).toBe(false);
		expect(Check(LogEntrySchema, withPayload("work_finished", { error: "x".repeat(2_001) }))).toBe(false);
		expect(Check(LogEntrySchema, withPayload("work_finished", { result: { extra: 1 } }))).toBe(false);
	});

	it("checks byte bounds the schema cannot express", () => {
		const started = PAYLOADS.work_started as never;
		expect(workPayloadBoundsError({ type: "work_started", payload: started })).toBeUndefined();
		const big = "x".repeat(WORK_INPUT_MAX_SERIALIZED_BYTES);
		expect(
			workPayloadBoundsError({ type: "work_started", payload: { ...PAYLOADS.work_started, input: big } as never }),
		).toMatch(/input exceeds/);
		expect(
			workPayloadBoundsError({
				type: "work_checkpoint",
				payload: { workId: "w", progress: { text: "é".repeat(WORK_CHECKPOINT_MAX_SERIALIZED_BYTES / 2) } },
			}),
		).toMatch(/checkpoint exceeds/);
		const output = (text: string) =>
			workPayloadBoundsError({
				type: "work_finished",
				payload: { workId: "w", outcome: "completed", result: { output: { text, truncated: false } } },
			});
		expect(output("x".repeat(WORK_OUTPUT_MAX_UTF8_BYTES))).toBeUndefined();
		expect(output("é".repeat(WORK_OUTPUT_MAX_UTF8_BYTES / 2 + 1))).toMatch(/output exceeds/);
		expect(
			workPayloadBoundsError({
				type: "work_finished",
				payload: { workId: "w", outcome: "failed", result: { data: "x".repeat(WORK_DATA_MAX_SERIALIZED_BYTES) } },
			}),
		).toMatch(/data exceeds/);
	});

	it("describes a delivered result by metadata only", () => {
		const details = {
			workId: "job-1",
			kind: "job",
			title: "npm test",
			outcome: "failed",
			error: "exit 1",
			output: { truncated: true },
		};
		expect(Check(WorkNoticeDetailsSchema, details)).toBe(true);
		expect(Check(WorkNoticeDetailsSchema, { ...details, outcome: "cancelled" })).toBe(false);
		expect(Check(WorkNoticeDetailsSchema, { ...details, output: { text: "x", truncated: false } })).toBe(false);
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
