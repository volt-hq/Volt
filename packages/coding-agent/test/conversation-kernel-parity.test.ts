import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildContext,
	type ConversationLogEntryDraft,
	type ConversationState,
	clientInputRecovery,
	fold,
} from "@hansjm10/volt-agent-core";
import { type AssistantMessage, applyReplayPolicy, type StopReason } from "@hansjm10/volt-ai";
import type { ClientInputPayload, ClientInputQueuedPayload, ClientInputState } from "@hansjm10/volt-protocol/entries";
import * as fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { toLogEntry } from "../src/core/conversation-log/entry-codec.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { decodeStoredSessionEntry } from "../src/core/session-entry-codec.ts";
import {
	type ClientInputCommand,
	createClientInputSemanticDigest,
	SessionManager,
} from "../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore, type SQLiteSessionStoreLease } from "../src/core/session-store/index.ts";
import { seedSession } from "./utilities/seed-log.ts";
import { loadPersistedSessionSnapshot } from "./utilities.ts";

// The fold of every log SessionManager writes, re-read from the log, must equal
// the manager's incrementally advanced view and its replayed provider context,
// and the SQLite store's derived projections (client inputs, leaf, name) must
// equal the fold of the entries the store holds.

const PROPERTY_SEED = 5_850_201;

async function foldSession(session: SessionManager): Promise<ConversationState> {
	const page = await session.readEntries(0, 1_000);
	expect(page.lastOrdinal).toBe(page.entries.length);
	return fold(page.entries.map(toLogEntry));
}

/** The store's derived state for a persisted session equals the fold of the entries it stores. */
async function expectStoreParity(session: SessionManager, state: ConversationState): Promise<void> {
	const snapshot = await loadPersistedSessionSnapshot(session);
	const stored = fold(snapshot.entries.map((entry) => toLogEntry(decodeStoredSessionEntry(entry))));
	expect(stored.ordinal).toBe(state.ordinal);
	expect(stored.leafId).toBe(state.leafId);
	expect(stored.clientInputs).toEqual(state.clientInputs);
	expect(snapshot.session.leafId).toBe(stored.leafId);
	expect(snapshot.session.name).toBe(stored.name);
	const folded = [...stored.clientInputs.inputs.values()]
		.sort((left, right) => (left.clientMessageId < right.clientMessageId ? -1 : 1))
		.map((record) => ({
			clientMessageId: record.clientMessageId,
			receiptEntryId: record.receiptId,
			command: record.command,
			origin: record.origin ?? null,
			semanticDigest: record.semanticDigest,
			input: record.input,
			queuedEntryId: record.queuedEntryId ?? null,
			queuedInput: record.queuedInput ?? null,
			state: record.state,
			error: record.error ?? null,
			canonicalEntryId: record.canonicalEntryId ?? null,
		}));
	expect(snapshot.clientInputs).toEqual(folded);
}

async function expectParity(session: SessionManager): Promise<ConversationState> {
	const state = await foldSession(session);
	const view = session.getConversationState();
	const expected = view.context;

	expect(state.leafId).toBe(session.getLeafId());
	expect(state.branch).toEqual(session.getBranch().map((entry) => entry.id));
	expect(state.context.messages).toEqual(expected.messages);
	expect(state.context.model).toEqual(expected.model);
	expect(state.context.thinkingLevel).toBe(expected.thinkingLevel);
	expect(state.context.fastMode).toBe(expected.fastMode);
	expect(state.planning).toEqual(view.planning);
	expect(await buildContext(state, { convertToLlm })).toEqual(applyReplayPolicy(convertToLlm([...expected.messages])));

	expect(state.name ?? undefined).toBe(session.getSessionName());
	for (const entry of session.getEntries()) {
		expect(state.labels.get(entry.id)?.label).toBe(session.getLabel(entry.id));
		expect(state.tree.children.get(entry.id) ?? []).toEqual(session.getChildren(entry.id).map((child) => child.id));
	}
	for (const clientMessageId of state.clientInputs.inputs.keys()) {
		expect(state.clientInputs.inputs.get(clientMessageId)).toEqual(session.getClientInput(clientMessageId));
	}
	expect(clientInputRecovery(state)).toEqual(clientInputRecovery(session.getConversationState()));
	if (session.isPersisted()) await expectStoreParity(session, state);
	return state;
}

type HostEntryBody =
	| {
			type: "client_input_receipt";
			payload: {
				clientMessageId: string;
				command: ClientInputCommand;
				semanticDigest: string;
				input: ClientInputPayload;
			};
	  }
	| {
			type: "client_input_queued";
			payload: { receiptId: string; clientMessageId: string; queuedInput: ClientInputQueuedPayload };
	  }
	| {
			type: "client_input_state";
			payload: { receiptId: string; clientMessageId: string; state: ClientInputState; error?: string };
	  };

/**
 * Commit one client-input entry off the current leaf, for the shapes
 * `LogSeed.clientInput` does not build one step at a time: a prompt's
 * streaming behavior, a queued intent after its receipt, a return to `accepted`.
 */
async function appendClientInputEntry(session: SessionManager, body: HostEntryBody): Promise<void> {
	const id = `client-entry-${session.getOrdinal() + 1}`;
	const parentId = session.getLeafId();
	await seedSession(session, (seed) => {
		seed.drafts.push({
			...body,
			id,
			parentId,
			timestamp: new Date().toISOString(),
			visibility: "host",
		} as ConversationLogEntryDraft);
	});
}

async function reserveClientInput(
	session: SessionManager,
	clientMessageId: string,
	command: ClientInputCommand,
	input: { message: string; streamingBehavior?: "steer" | "followUp" },
): Promise<void> {
	const payload: ClientInputPayload = { ...input, images: [] };
	await appendClientInputEntry(session, {
		type: "client_input_receipt",
		payload: {
			clientMessageId,
			command,
			semanticDigest: createClientInputSemanticDigest(command, payload),
			input: payload,
		},
	});
}

function receiptId(session: SessionManager, clientMessageId: string): string {
	const record = session.getClientInput(clientMessageId);
	if (!record) throw new Error(`No client input ${clientMessageId}`);
	return record.receiptId;
}

async function queueClientInput(
	session: SessionManager,
	clientMessageId: string,
	delivery: "steer" | "follow_up",
	message: string,
): Promise<void> {
	await appendClientInputEntry(session, {
		type: "client_input_queued",
		payload: {
			receiptId: receiptId(session, clientMessageId),
			clientMessageId,
			queuedInput: { delivery, message, images: [] },
		},
	});
}

async function setClientInputState(
	session: SessionManager,
	clientMessageId: string,
	state: ClientInputState,
	error?: string,
): Promise<void> {
	await appendClientInputEntry(session, {
		type: "client_input_state",
		payload: {
			receiptId: receiptId(session, clientMessageId),
			clientMessageId,
			state,
			...(error === undefined ? {} : { error }),
		},
	});
}

let root: string;
let storeLease: SQLiteSessionStoreLease;
const sessions: SessionManager[] = [];

// One store for every test keeps its worker up; each test or generated case creates a fresh session.
beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "volt-kernel-parity-"));
	storeLease = await acquireSharedSQLiteSessionStore(join(root, "sessions"));
});

afterEach(async () => {
	while (sessions.length > 0) await sessions.pop()!.closePersistence();
});

afterAll(async () => {
	await storeLease.release();
	rmSync(root, { recursive: true, force: true });
});

/** A persisted session, so parity also covers the store's derived projections. */
async function createSession(): Promise<SessionManager> {
	const session = await SessionManager.create(mkdtempSync(join(root, "workspace-")), join(root, "sessions"));
	sessions.push(session);
	return session;
}

let assistantTimestamp = 1_700_000_000_000;

function assistant(
	text: string,
	options: {
		toolCallIds?: readonly string[];
		stopReason?: StopReason;
		provider?: string;
		model?: string;
		invalidArguments?: boolean;
	} = {},
): AssistantMessage {
	const toolCallIds = options.toolCallIds ?? [];
	const stopReason = options.stopReason ?? (toolCallIds.length > 0 ? "toolUse" : "stop");
	const timestamp = assistantTimestamp++;
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCallIds.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: id } })),
		],
		api: "anthropic-messages",
		provider: options.provider ?? "anthropic",
		model: options.model ?? "claude-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
		...(options.invalidArguments && stopReason === "error"
			? {
					diagnostics: [
						{
							type: "invalid_tool_arguments",
							timestamp,
							details: { contentIndex: 1, code: "missing_completion" },
						},
					],
				}
			: {}),
	};
}

async function user(session: SessionManager, text: string): Promise<string> {
	return session.logWriter.appendMessage({ role: "user", content: text, timestamp: assistantTimestamp++ });
}

async function toolResult(session: SessionManager, toolCallId: string, isError = false): Promise<string> {
	return session.logWriter.appendMessage({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: `result of ${toolCallId}` }],
		isError,
		timestamp: assistantTimestamp++,
	});
}

function llmRoles(messages: readonly { role: string }[]): string[] {
	return messages.map((message) => message.role);
}

describe("conversation kernel parity with coding-agent context building", () => {
	it("model, thinking, fast mode, and planning changes", async () => {
		const session = await createSession();
		await expectParity(session);
		await session.logWriter.appendModelChange("openai", "gpt-test");
		await session.logWriter.appendThinkingLevelChange("high");
		await user(session, "hello");
		await session.logWriter.appendFastModeChange(true);
		await session.logWriter.appendMessage(assistant("hi", { provider: "google", model: "gemini-test" }));
		await session.logWriter.appendPlanningState({ mode: "plan", plan: null });
		await session.logWriter.appendThinkingLevelChange("low");
		const state = await expectParity(session);
		expect(state.context.model).toEqual({ provider: "google", modelId: "gemini-test" });
		expect(state.context.thinkingLevel).toBe("low");
		expect(state.context.fastMode).toBe(true);
		expect(state.planning).toEqual({ mode: "plan", plan: null });
	});

	it("compaction keeps the entries from firstKeptEntryId", async () => {
		const session = await createSession();
		await user(session, "one");
		await session.logWriter.appendMessage(assistant("reply one"));
		const kept = await user(session, "two");
		await session.logWriter.appendMessage(assistant("reply two", { toolCallIds: ["call-a"] }));
		await toolResult(session, "call-a");
		await session.logWriter.appendCompaction("summary of one", kept, 1234);
		await user(session, "three");
		await session.logWriter.appendCompaction(
			"summary of everything",
			session.getLeafId()!,
			4321,
			{ structured: true },
			true,
		);
		await user(session, "four");
		const state = await expectParity(session);
		expect(llmRoles(state.context.messages)).toEqual(["compactionSummary", "user", "user"]);
	});

	it("branch summaries, navigation via leaf entries, and resets", async () => {
		const session = await createSession();
		const first = await user(session, "first");
		await session.logWriter.appendMessage(assistant("first reply"));
		await user(session, "abandoned");
		await session.logWriter.appendMessage(assistant("abandoned reply"));
		await session.logWriter.branchWithSummary(first, "tried something else");
		await expectParity(session);
		await session.logWriter.appendMessage(assistant("after summary"));
		await session.logWriter.branch(first);
		await expectParity(session);
		await session.logWriter.resetLeaf();
		await expectParity(session);
		await session.logWriter.branchWithSummary(null, "root summary");
		await user(session, "fresh start");
		await session.logWriter.branchWithSummary(session.getLeafId(), "");
		const state = await expectParity(session);
		expect(llmRoles(state.context.messages)).toEqual(["branchSummary", "user"]);
	});

	it("custom messages, custom entries, labels, names, and host product entries", async () => {
		const session = await createSession();
		expect(await session.logWriter.recordStartingGitContext(null)).toBe(true);
		const greeting = await user(session, "hello");
		await session.logWriter.appendCustomMessageEntry("note", "plain note", true, { source: "test" });
		await session.logWriter.appendCustomMessageEntry("hidden", [{ type: "text", text: "hidden note" }], false);
		await session.logWriter.appendMessage({
			role: "custom",
			customType: "inline",
			content: "custom role message",
			display: true,
			timestamp: assistantTimestamp++,
		});
		await session.logWriter.appendCustomEntry("state", { count: 1 });
		await session.logWriter.appendLabelChange(greeting, "start");
		await session.logWriter.appendSessionInfo("  Parity  ");
		await session.logWriter.appendMessage({
			role: "bashExecution",
			command: "ls",
			output: "file",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: assistantTimestamp++,
		});
		await session.logWriter.appendMessage({
			role: "bashExecution",
			command: "secret",
			output: "hidden",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			timestamp: assistantTimestamp++,
			excludeFromContext: true,
		});
		await session.logWriter.appendLabelChange(greeting, undefined);
		await session.logWriter.appendSubagentSpawn({
			toolCallId: "call-x",
			subagentId: "sub-1",
			agent: "worker",
			childSessionId: "child-1",
			requestKey: "request-1",
		});
		const state = await expectParity(session);
		expect(state.name).toBe("Parity");
		expect(state.labels.size).toBe(0);
		const llm = await buildContext(state, { convertToLlm });
		expect(llmRoles(llm)).toEqual(["user", "user", "user", "user", "user"]);
	});

	it("errored and aborted turns, missing tool results, and rejected tool calls", async () => {
		const session = await createSession();
		await user(session, "do it");
		await session.logWriter.appendMessage(assistant("partial", { toolCallIds: ["call-1"], stopReason: "aborted" }));
		await toolResult(session, "call-1", true);
		await user(session, "retry");
		await session.logWriter.appendMessage(
			assistant("bad args", { toolCallIds: ["call-2"], stopReason: "error", invalidArguments: true }),
		);
		await session.logWriter.appendMessage(assistant("calling", { toolCallIds: ["call-3", "call-4"] }));
		await toolResult(session, "call-3");
		await user(session, "interrupt");
		await session.logWriter.appendMessage(assistant("failed", { stopReason: "error" }));
		const state = await expectParity(session);
		const llm = await buildContext(state, { convertToLlm });
		expect(llmRoles(llm)).toEqual(["user", "user", "user", "assistant", "toolResult", "toolResult", "user"]);
		expect(llm[5]).toMatchObject({ toolCallId: "call-4", isError: true });
	});

	it("client input lifecycles and the durable queue", async () => {
		const session = await createSession();
		await seedSession(session, (seed) =>
			seed.clientInput("client-prompt", "prompt", { message: "typed" }, { states: ["started"] }),
		);
		await expectParity(session);
		await session.logWriter.appendMessage({
			role: "user",
			content: "typed",
			timestamp: assistantTimestamp++,
			clientMessageId: "client-prompt",
		});
		await seedSession(session, (seed) =>
			seed
				.clientInput("client-steer", "steer", { message: "steer" }, { queued: "steer" })
				.clientInput("client-follow", "follow_up", { message: "follow" }, { queued: "follow_up" })
				.clientInput("client-failed", "prompt", { message: "nope" }, { states: ["failed"], error: "rejected" }),
		);
		let state = await expectParity(session);
		expect(state.clientInputs.inputs.get("client-prompt")).toMatchObject({ state: "completed" });
		expect(clientInputRecovery(state).kind).toBe("replay");
		await setClientInputState(session, "client-follow", "started");
		state = await expectParity(session);
		expect(clientInputRecovery(state).kind).toBe("blocked");
		// A started input returned to `accepted` is queued again in its admission order.
		await setClientInputState(session, "client-follow", "accepted");
		state = await expectParity(session);
		expect(state.clientInputs.queued).toEqual(["client-steer", "client-follow"]);
	});
});

type SessionOp =
	| { kind: "user"; text: string }
	| { kind: "assistant"; toolCalls: number; stopReason: StopReason; model: number; invalidArguments: boolean }
	| { kind: "tool_result"; pick: number; isError: boolean }
	| { kind: "bash"; exclude: boolean }
	| { kind: "custom_role"; display: boolean }
	| { kind: "custom_message"; display: boolean; array: boolean }
	| { kind: "custom" }
	| { kind: "label"; pick: number; label: string | null }
	| { kind: "name"; name: string }
	| { kind: "model"; pick: number }
	| { kind: "thinking"; level: "off" | "low" | "high" }
	| { kind: "fast"; enabled: boolean }
	| { kind: "planning"; mode: "build" | "plan" }
	| { kind: "compaction"; pick: number }
	| { kind: "branch"; pick: number }
	| { kind: "reset" }
	| { kind: "branch_summary"; pick: number; summary: string }
	| { kind: "receipt"; command: ClientInputCommand; behavior: "steer" | "followUp" | null }
	| { kind: "queue"; pick: number }
	| { kind: "transition"; pick: number; choice: number }
	| { kind: "complete"; pick: number }
	| { kind: "spawn" };

const pick = fc.nat({ max: 1_000 });
const sessionOpArbitrary: fc.Arbitrary<SessionOp> = fc.oneof(
	{ weight: 5, arbitrary: fc.record({ kind: fc.constant("user" as const), text: fc.string({ maxLength: 8 }) }) },
	{
		weight: 5,
		arbitrary: fc.record({
			kind: fc.constant("assistant" as const),
			toolCalls: fc.nat({ max: 2 }),
			stopReason: fc.constantFrom<StopReason>("stop", "toolUse", "error", "aborted"),
			model: pick,
			invalidArguments: fc.boolean(),
		}),
	},
	{ weight: 3, arbitrary: fc.record({ kind: fc.constant("tool_result" as const), pick, isError: fc.boolean() }) },
	fc.record({ kind: fc.constant("bash" as const), exclude: fc.boolean() }),
	fc.record({ kind: fc.constant("custom_role" as const), display: fc.boolean() }),
	fc.record({ kind: fc.constant("custom_message" as const), display: fc.boolean(), array: fc.boolean() }),
	fc.constant({ kind: "custom" as const }),
	fc.record({ kind: fc.constant("label" as const), pick, label: fc.constantFrom("mark", "", null) }),
	fc.record({ kind: fc.constant("name" as const), name: fc.constantFrom("", " Name ", "Other") }),
	fc.record({ kind: fc.constant("model" as const), pick }),
	fc.record({
		kind: fc.constant("thinking" as const),
		level: fc.constantFrom("off" as const, "low" as const, "high" as const),
	}),
	fc.record({ kind: fc.constant("fast" as const), enabled: fc.boolean() }),
	fc.record({ kind: fc.constant("planning" as const), mode: fc.constantFrom("build" as const, "plan" as const) }),
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("compaction" as const), pick }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("branch" as const), pick }) },
	fc.constant({ kind: "reset" as const }),
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("branch_summary" as const),
			pick,
			summary: fc.constantFrom("", "summary"),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("receipt" as const),
			command: fc.constantFrom<ClientInputCommand>("prompt", "steer", "follow_up"),
			behavior: fc.constantFrom("steer" as const, "followUp" as const, null),
		}),
	},
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("queue" as const), pick }) },
	{ weight: 3, arbitrary: fc.record({ kind: fc.constant("transition" as const), pick, choice: pick }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("complete" as const), pick }) },
	fc.constant({ kind: "spawn" as const }),
);

const MODELS = [
	["anthropic", "claude-a"],
	["openai", "gpt-b"],
] as const;

function choose<T>(values: readonly T[], index: number): T | undefined {
	return values.length === 0 ? undefined : values[index % values.length];
}

function queuedDelivery(command: ClientInputCommand, behavior: "steer" | "followUp" | null) {
	if (command !== "prompt") return command;
	if (behavior === "steer") return "steer" as const;
	if (behavior === "followUp") return "follow_up" as const;
	return undefined;
}

async function runOp(session: SessionManager, op: SessionOp, toolCalls: string[], inputs: string[]): Promise<void> {
	const publicIds = session.getEntries().map((entry) => entry.id);
	switch (op.kind) {
		case "user":
			await user(session, op.text);
			return;
		case "assistant": {
			const [provider, model] = MODELS[op.model % MODELS.length] ?? MODELS[0];
			const ids = Array.from({ length: op.toolCalls }, (_, index) => `call-${toolCalls.length + index + 1}`);
			toolCalls.push(...ids);
			await session.logWriter.appendMessage(
				assistant("text", {
					toolCallIds: ids,
					stopReason: op.stopReason,
					provider,
					model,
					invalidArguments: op.invalidArguments,
				}),
			);
			return;
		}
		case "tool_result":
			await toolResult(session, choose(toolCalls, op.pick) ?? "call-unknown", op.isError);
			return;
		case "bash":
			await session.logWriter.appendMessage({
				role: "bashExecution",
				command: "echo",
				output: "out",
				cancelled: false,
				truncated: false,
				timestamp: assistantTimestamp++,
				...(op.exclude ? { excludeFromContext: true } : {}),
			});
			return;
		case "custom_role":
			await session.logWriter.appendMessage({
				role: "custom",
				customType: "inline",
				content: "inline",
				display: op.display,
				timestamp: assistantTimestamp++,
			});
			return;
		case "custom_message":
			await session.logWriter.appendCustomMessageEntry(
				"note",
				op.array ? [{ type: "text", text: "note" }] : "note",
				op.display,
				op.display ? { shown: true } : undefined,
			);
			return;
		case "custom":
			await session.logWriter.appendCustomEntry("state", { at: publicIds.length });
			return;
		case "label": {
			const targetId = choose(publicIds, op.pick);
			if (targetId !== undefined) await session.logWriter.appendLabelChange(targetId, op.label ?? undefined);
			return;
		}
		case "name":
			await session.logWriter.appendSessionInfo(op.name);
			return;
		case "model": {
			const [provider, model] = MODELS[op.pick % MODELS.length] ?? MODELS[0];
			await session.logWriter.appendModelChange(provider, model);
			return;
		}
		case "thinking":
			await session.logWriter.appendThinkingLevelChange(op.level);
			return;
		case "fast":
			await session.logWriter.appendFastModeChange(op.enabled);
			return;
		case "planning":
			await session.logWriter.appendPlanningState({ mode: op.mode, plan: null });
			return;
		case "compaction": {
			const firstKept = choose(
				session.getBranch().map((entry) => entry.id),
				op.pick,
			);
			if (firstKept !== undefined)
				await session.logWriter.appendCompaction(`summary at ${publicIds.length}`, firstKept, 100);
			return;
		}
		case "branch": {
			const targetId = choose(publicIds, op.pick);
			if (targetId !== undefined) await session.logWriter.branch(targetId);
			return;
		}
		case "reset":
			await session.logWriter.resetLeaf();
			return;
		case "branch_summary":
			await session.logWriter.branchWithSummary(choose([null, ...publicIds], op.pick) ?? null, op.summary);
			return;
		case "receipt": {
			const id = `client-${inputs.length + 1}`;
			const behavior = op.command === "prompt" ? op.behavior : null;
			await reserveClientInput(session, id, op.command, {
				message: id,
				...(behavior === null ? {} : { streamingBehavior: behavior }),
			});
			inputs.push(id);
			return;
		}
		case "queue": {
			const candidates = inputs.filter((id) => {
				const record = session.getClientInput(id);
				return (
					record !== undefined &&
					(record.state === "accepted" || record.state === "started") &&
					record.queuedInput === undefined &&
					queuedDelivery(record.command, record.input.streamingBehavior ?? null) !== undefined
				);
			});
			const id = choose(candidates, op.pick);
			const record = id === undefined ? undefined : session.getClientInput(id);
			const delivery = record && queuedDelivery(record.command, record.input.streamingBehavior ?? null);
			if (id !== undefined && delivery) await queueClientInput(session, id, delivery, id);
			return;
		}
		case "transition": {
			const candidates = inputs.filter((id) => {
				const state = session.getClientInput(id)?.state;
				return state === "accepted" || state === "started";
			});
			const id = choose(candidates, op.pick);
			if (id === undefined) return;
			const state = session.getClientInput(id)?.state;
			const next = choose(
				state === "accepted"
					? (["started", "completed", "failed"] as const)
					: (["accepted", "completed", "failed"] as const),
				op.choice,
			);
			if (next === "failed") await setClientInputState(session, id, "failed", "failed");
			else if (next !== undefined) await setClientInputState(session, id, next);
			return;
		}
		case "complete": {
			const id = choose(
				inputs.filter((candidate) => session.getClientInput(candidate)?.state === "started"),
				op.pick,
			);
			if (id !== undefined) {
				await session.logWriter.appendMessage({
					role: "user",
					content: id,
					timestamp: assistantTimestamp++,
					clientMessageId: id,
				});
			}
			return;
		}
		case "spawn":
			await session.logWriter.appendSubagentSpawn({
				toolCallId: `call-${toolCalls.length}`,
				subagentId: `sub-${publicIds.length}`,
				agent: "worker",
				childSessionId: `child-${publicIds.length}`,
				requestKey: `request-${publicIds.length}`,
			});
			return;
	}
}

describe("conversation kernel parity properties", () => {
	it("the fold reproduces SessionManager's context, labels, name, tree, and client inputs, and the store's projections, after every operation", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(sessionOpArbitrary, { maxLength: 40, size: "medium" }), async (ops) => {
				const session = await createSession();
				try {
					const toolCalls: string[] = [];
					const inputs: string[] = [];
					for (const op of ops) {
						await runOp(session, op, toolCalls, inputs);
						await expectParity(session);
					}
				} finally {
					await session.closePersistence();
				}
			}),
			{ seed: PROPERTY_SEED, numRuns: 60 },
		);
	}, 120_000);
});
