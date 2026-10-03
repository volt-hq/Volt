import {
	buildContext,
	type ConversationLogEntry,
	type ConversationState,
	clientInputRecovery,
	fold,
} from "@hansjm10/volt-agent-core";
import { type AssistantMessage, applyReplayPolicy, type StopReason } from "@hansjm10/volt-ai";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSessionManagerHarnessSession } from "../src/core/harness-session-adapter.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { DEFAULT_PLANNING_STATE } from "../src/core/planning.ts";
import { SESSION_ENTRY_TYPES } from "../src/core/session-entry-types.ts";
import { type ClientInputCommand, type CommittedSessionEntry, SessionManager } from "../src/core/session-manager.ts";

// The kernel fold and context builder must reproduce today's coding-agent
// buildSessionContext + replay (and the harness projection AgentSession turns
// read) for every log SessionManager writes.

const PROPERTY_SEED = 5_850_201;

/** A stored session entry in the protocol envelope: payload fields nested, visibility from its type. */
function toLogEntry(entry: CommittedSessionEntry): ConversationLogEntry {
	const definition = SESSION_ENTRY_TYPES[entry.type];
	const payloadKeys = new Set(Object.keys(definition.payload.properties));
	const envelope: Record<string, unknown> = { visibility: definition.visibility };
	const payload: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (payloadKeys.has(key)) payload[key] = value;
		else envelope[key] = value;
	}
	return { ...envelope, payload } as unknown as ConversationLogEntry;
}

async function foldSession(session: SessionManager): Promise<ConversationState> {
	const page = await session.readEntries(0, 1_000);
	expect(page.lastOrdinal).toBe(page.entries.length);
	return fold(page.entries.map(toLogEntry));
}

async function expectParity(session: SessionManager): Promise<ConversationState> {
	const state = await foldSession(session);
	const expected = session.buildSessionContext();

	expect(state.leafId).toBe(session.getLeafId());
	expect(state.branch).toEqual(session.getBranch().map((entry) => entry.id));
	expect(state.context.messages).toEqual(expected.messages);
	expect(state.context.model).toEqual(expected.model);
	expect(state.context.thinkingLevel).toBe(expected.thinkingLevel);
	expect(state.context.fastMode).toBe(expected.fastMode.enabled);
	expect(state.planning ?? DEFAULT_PLANNING_STATE).toEqual(expected.planning);
	expect(await buildContext(state, { convertToLlm })).toEqual(applyReplayPolicy(convertToLlm(expected.messages)));

	const harness = await createSessionManagerHarnessSession(session).buildContext();
	expect(state.context.messages).toEqual(harness.messages);
	expect(state.context.model).toEqual(harness.model);
	expect(state.context.thinkingLevel).toBe(harness.thinkingLevel);

	expect(state.name ?? undefined).toBe(session.getSessionName());
	for (const entry of session.getEntries()) {
		expect(state.labels.get(entry.id)?.label).toBe(session.getLabel(entry.id));
		expect(state.tree.children.get(entry.id) ?? []).toEqual(session.getChildren(entry.id).map((child) => child.id));
	}
	for (const clientMessageId of state.clientInputs.inputs.keys()) {
		expect(state.clientInputs.inputs.get(clientMessageId)).toEqual(session.getClientInput(clientMessageId));
	}
	expect(clientInputRecovery(state)).toEqual(session.getClientInputRecoveryPlan());
	return state;
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
	return session.appendMessage({ role: "user", content: text, timestamp: assistantTimestamp++ });
}

async function toolResult(session: SessionManager, toolCallId: string, isError = false): Promise<string> {
	return session.appendMessage({
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
		const session = SessionManager.inMemory();
		await expectParity(session);
		await session.appendModelChange("openai", "gpt-test");
		await session.appendThinkingLevelChange("high");
		await user(session, "hello");
		await session.appendFastModeChange(true);
		await session.appendMessage(assistant("hi", { provider: "google", model: "gemini-test" }));
		await session.appendPlanningState({ mode: "plan", plan: null });
		await session.appendThinkingLevelChange("low");
		const state = await expectParity(session);
		expect(state.context.model).toEqual({ provider: "google", modelId: "gemini-test" });
		expect(state.context.thinkingLevel).toBe("low");
		expect(state.context.fastMode).toBe(true);
		expect(state.planning).toEqual({ mode: "plan", plan: null });
	});

	it("compaction keeps the entries from firstKeptEntryId", async () => {
		const session = SessionManager.inMemory();
		await user(session, "one");
		await session.appendMessage(assistant("reply one"));
		const kept = await user(session, "two");
		await session.appendMessage(assistant("reply two", { toolCallIds: ["call-a"] }));
		await toolResult(session, "call-a");
		await session.appendCompaction("summary of one", kept, 1234);
		await user(session, "three");
		await session.appendCompaction("summary of everything", session.getLeafId()!, 4321, { structured: true }, true);
		await user(session, "four");
		const state = await expectParity(session);
		expect(llmRoles(state.context.messages)).toEqual(["compactionSummary", "user", "user"]);
	});

	it("branch summaries, navigation via leaf entries, and resets", async () => {
		const session = SessionManager.inMemory();
		const first = await user(session, "first");
		await session.appendMessage(assistant("first reply"));
		await user(session, "abandoned");
		await session.appendMessage(assistant("abandoned reply"));
		await session.branchWithSummary(first, "tried something else");
		await expectParity(session);
		await session.appendMessage(assistant("after summary"));
		await session.branch(first);
		await expectParity(session);
		await session.resetLeaf();
		await expectParity(session);
		await session.branchWithSummary(null, "root summary");
		await user(session, "fresh start");
		await session.branchWithSummary(session.getLeafId(), "");
		const state = await expectParity(session);
		expect(llmRoles(state.context.messages)).toEqual(["branchSummary", "user"]);
	});

	it("custom messages, custom entries, labels, names, and host product entries", async () => {
		const session = SessionManager.inMemory();
		expect(await session.recordStartingGitContext(session.getSessionId(), null)).toBe(true);
		const greeting = await user(session, "hello");
		await session.appendCustomMessageEntry("note", "plain note", true, { source: "test" });
		await session.appendCustomMessageEntry("hidden", [{ type: "text", text: "hidden note" }], false);
		await session.appendMessage({
			role: "custom",
			customType: "inline",
			content: "custom role message",
			display: true,
			timestamp: assistantTimestamp++,
		});
		await session.appendCustomEntry("state", { count: 1 });
		await session.appendLabelChange(greeting, "start");
		await session.appendSessionInfo("  Parity  ");
		await session.appendMessage({
			role: "bashExecution",
			command: "ls",
			output: "file",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: assistantTimestamp++,
		});
		await session.appendMessage({
			role: "bashExecution",
			command: "secret",
			output: "hidden",
			exitCode: 1,
			cancelled: false,
			truncated: false,
			timestamp: assistantTimestamp++,
			excludeFromContext: true,
		});
		await session.appendLabelChange(greeting, undefined);
		await session.appendSubagentSpawn({
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
		const session = SessionManager.inMemory();
		await user(session, "do it");
		await session.appendMessage(assistant("partial", { toolCallIds: ["call-1"], stopReason: "aborted" }));
		await toolResult(session, "call-1", true);
		await user(session, "retry");
		await session.appendMessage(
			assistant("bad args", { toolCallIds: ["call-2"], stopReason: "error", invalidArguments: true }),
		);
		await session.appendMessage(assistant("calling", { toolCallIds: ["call-3", "call-4"] }));
		await toolResult(session, "call-3");
		await user(session, "interrupt");
		await session.appendMessage(assistant("failed", { stopReason: "error" }));
		const state = await expectParity(session);
		const llm = await buildContext(state, { convertToLlm });
		expect(llmRoles(llm)).toEqual(["user", "user", "user", "assistant", "toolResult", "toolResult", "user"]);
		expect(llm[5]).toMatchObject({ toolCallId: "call-4", isError: true });
	});

	it("client input lifecycles and the durable queue", async () => {
		const session = SessionManager.inMemory();
		await session.reserveClientInput("client-prompt", "prompt", { message: "typed" });
		await session.transitionClientInput("client-prompt", "started");
		await expectParity(session);
		await session.appendMessage({
			role: "user",
			content: "typed",
			timestamp: assistantTimestamp++,
			clientMessageId: "client-prompt",
		});
		await session.reserveClientInput("client-steer", "steer", { message: "steer" });
		await session.markClientInputQueued("client-steer", { delivery: "steer", message: "steer" });
		await session.reserveClientInput("client-follow", "follow_up", { message: "follow" });
		await session.markClientInputQueued("client-follow", { delivery: "follow_up", message: "follow" });
		await session.reserveClientInput("client-failed", "prompt", { message: "nope" });
		await session.transitionClientInput("client-failed", "failed", "rejected");
		let state = await expectParity(session);
		expect(clientInputRecovery(state).kind).toBe("replay");
		await session.transitionClientInput("client-follow", "started");
		state = await expectParity(session);
		expect(clientInputRecovery(state).kind).toBe("blocked");
		await session.rollbackClientInput("client-follow");
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
			await session.appendMessage(
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
			await session.appendMessage({
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
			await session.appendMessage({
				role: "custom",
				customType: "inline",
				content: "inline",
				display: op.display,
				timestamp: assistantTimestamp++,
			});
			return;
		case "custom_message":
			await session.appendCustomMessageEntry(
				"note",
				op.array ? [{ type: "text", text: "note" }] : "note",
				op.display,
				op.display ? { shown: true } : undefined,
			);
			return;
		case "custom":
			await session.appendCustomEntry("state", { at: publicIds.length });
			return;
		case "label": {
			const targetId = choose(publicIds, op.pick);
			if (targetId !== undefined) await session.appendLabelChange(targetId, op.label ?? undefined);
			return;
		}
		case "name":
			await session.appendSessionInfo(op.name);
			return;
		case "model": {
			const [provider, model] = MODELS[op.pick % MODELS.length] ?? MODELS[0];
			await session.appendModelChange(provider, model);
			return;
		}
		case "thinking":
			await session.appendThinkingLevelChange(op.level);
			return;
		case "fast":
			await session.appendFastModeChange(op.enabled);
			return;
		case "planning":
			await session.appendPlanningState({ mode: op.mode, plan: null });
			return;
		case "compaction": {
			const firstKept = choose(
				session.getBranch().map((entry) => entry.id),
				op.pick,
			);
			if (firstKept !== undefined) await session.appendCompaction(`summary at ${publicIds.length}`, firstKept, 100);
			return;
		}
		case "branch": {
			const targetId = choose(publicIds, op.pick);
			if (targetId !== undefined) await session.branch(targetId);
			return;
		}
		case "reset":
			await session.resetLeaf();
			return;
		case "branch_summary":
			await session.branchWithSummary(choose([null, ...publicIds], op.pick) ?? null, op.summary);
			return;
		case "receipt": {
			const id = `client-${inputs.length + 1}`;
			const behavior = op.command === "prompt" ? op.behavior : null;
			await session.reserveClientInput(id, op.command, {
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
			if (id !== undefined && delivery) await session.markClientInputQueued(id, { delivery, message: id });
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
					: (["rollback", "completed", "failed"] as const),
				op.choice,
			);
			if (next === "rollback") await session.rollbackClientInput(id);
			else if (next === "failed") await session.transitionClientInput(id, "failed", "failed");
			else if (next !== undefined) await session.transitionClientInput(id, next);
			return;
		}
		case "complete": {
			const id = choose(
				inputs.filter((candidate) => session.getClientInput(candidate)?.state === "started"),
				op.pick,
			);
			if (id !== undefined) {
				await session.appendMessage({
					role: "user",
					content: id,
					timestamp: assistantTimestamp++,
					clientMessageId: id,
				});
			}
			return;
		}
		case "spawn":
			await session.appendSubagentSpawn({
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
	it("the fold reproduces SessionManager's context, labels, name, tree, and client inputs after every operation", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(sessionOpArbitrary, { maxLength: 40, size: "medium" }), async (ops) => {
				const session = SessionManager.inMemory();
				const toolCalls: string[] = [];
				const inputs: string[] = [];
				for (const op of ops) {
					await runOp(session, op, toolCalls, inputs);
					await expectParity(session);
				}
			}),
			{ seed: PROPERTY_SEED, numRuns: 60 },
		);
	});
});
