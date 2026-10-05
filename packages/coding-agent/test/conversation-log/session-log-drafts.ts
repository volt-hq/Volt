import type { ConversationLogEntryDraft } from "@hansjm10/volt-agent-core";
import type { AssistantMessage, StopReason, ToolCall } from "@hansjm10/volt-ai";
import * as fc from "fast-check";
import { digestClientInputPayload } from "../../src/core/session-entry-codec.ts";
import type { ClientInputCommand, ClientInputState } from "../../src/core/session-manager.ts";

/** One abstract step of a generated session log. Picks select targets modulo the eligible choices. */
export type DraftOp =
	| { kind: "user"; text: string; array: boolean }
	| { kind: "assistant"; text: string; toolCalls: number; stopReason: StopReason; model: number }
	| { kind: "tool_result"; pick: number; isError: boolean }
	| { kind: "bash"; command: string; exclude: boolean }
	| { kind: "custom_message"; text: string; display: boolean; array: boolean }
	| { kind: "custom"; customType: string; data: boolean }
	| { kind: "label"; pick: number; label: string | null }
	| { kind: "name"; name: string }
	| { kind: "model"; pick: number }
	| { kind: "thinking"; level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
	| { kind: "fast"; enabled: boolean }
	| { kind: "planning"; mode: "build" | "plan" }
	| { kind: "compaction"; pick: number; summary: string }
	| { kind: "navigate"; pick: number; summary: string | null }
	| { kind: "receipt"; command: ClientInputCommand; behavior: "steer" | "followUp" | null; text: string }
	| { kind: "host_queue"; delivery: "steer" | "follow_up"; text: string }
	| { kind: "queue"; pick: number }
	| { kind: "transition"; pick: number; choice: number; error: string | null }
	| { kind: "complete"; pick: number }
	| { kind: "spawn" }
	| { kind: "git_context" };

const text = fc.string({ maxLength: 12 });
const pick = fc.nat({ max: 1_000 });

export const draftOpArbitrary: fc.Arbitrary<DraftOp> = fc.oneof(
	{ weight: 5, arbitrary: fc.record({ kind: fc.constant("user" as const), text, array: fc.boolean() }) },
	{
		weight: 5,
		arbitrary: fc.record({
			kind: fc.constant("assistant" as const),
			text,
			toolCalls: fc.nat({ max: 2 }),
			stopReason: fc.constantFrom<StopReason>("stop", "toolUse", "error", "aborted"),
			model: fc.nat({ max: 2 }),
		}),
	},
	{ weight: 3, arbitrary: fc.record({ kind: fc.constant("tool_result" as const), pick, isError: fc.boolean() }) },
	fc.record({ kind: fc.constant("bash" as const), command: text, exclude: fc.boolean() }),
	fc.record({ kind: fc.constant("custom_message" as const), text, display: fc.boolean(), array: fc.boolean() }),
	fc.record({
		kind: fc.constant("custom" as const),
		customType: fc.constantFrom("ext-a", "ext-b"),
		data: fc.boolean(),
	}),
	fc.record({ kind: fc.constant("label" as const), pick, label: fc.option(text, { nil: null }) }),
	fc.record({ kind: fc.constant("name" as const), name: fc.constantFrom("", "  ", "Plan", " Named ") }),
	fc.record({ kind: fc.constant("model" as const), pick }),
	fc.record({
		kind: fc.constant("thinking" as const),
		level: fc.constantFrom("off" as const, "minimal" as const, "low" as const, "high" as const, "max" as const),
	}),
	fc.record({ kind: fc.constant("fast" as const), enabled: fc.boolean() }),
	fc.record({ kind: fc.constant("planning" as const), mode: fc.constantFrom("build" as const, "plan" as const) }),
	fc.record({ kind: fc.constant("compaction" as const), pick, summary: text }),
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("navigate" as const),
			pick,
			summary: fc.option(fc.constantFrom("", "summary of the branch"), { nil: null }),
		}),
	},
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant("receipt" as const),
			command: fc.constantFrom<ClientInputCommand>("prompt", "steer", "follow_up"),
			behavior: fc.constantFrom("steer" as const, "followUp" as const, null),
			text,
		}),
	},
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("queue" as const), pick }) },
	fc.record({
		kind: fc.constant("host_queue" as const),
		delivery: fc.constantFrom("steer" as const, "follow_up" as const),
		text,
	}),
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant("transition" as const),
			pick,
			choice: pick,
			error: fc.option(fc.constant("dispatch failed"), { nil: null }),
		}),
	},
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("complete" as const), pick }) },
	fc.record({ kind: fc.constant("spawn" as const) }),
	fc.record({ kind: fc.constant("git_context" as const) }),
);

/** One append's worth of operations. */
export const draftBatchArbitrary = fc.array(draftOpArbitrary, { minLength: 1, maxLength: 4 });

const MODELS = [
	{ provider: "anthropic", modelId: "claude-a" },
	{ provider: "openai", modelId: "gpt-b" },
	{ provider: "google", modelId: "gemini-c" },
] as const;

/** Client input transitions the store and the kernel fold accept. */
const NEXT_CLIENT_INPUT_STATES: Record<ClientInputState, readonly ClientInputState[]> = {
	accepted: ["started", "completed", "failed", "withdrawn"],
	started: ["accepted", "completed", "failed"],
	completed: [],
	failed: [],
	withdrawn: [],
};

interface ClientInputModel {
	readonly clientMessageId: string;
	readonly receiptId: string;
	readonly command: ClientInputCommand;
	readonly behavior: "steer" | "followUp" | null;
	readonly text: string;
	readonly state: ClientInputState;
	readonly queued: boolean;
}

/** What the generator knows about the committed log, so new entries stay valid for the store. */
export interface DraftLogState {
	readonly entries: number;
	readonly ids: readonly string[];
	readonly publicIds: readonly string[];
	readonly parents: ReadonlyMap<string, string | null>;
	readonly leafId: string | null;
	readonly inputs: readonly ClientInputModel[];
	readonly toolCalls: readonly string[];
	readonly gitContext: boolean;
}

export const EMPTY_DRAFT_LOG: DraftLogState = {
	entries: 0,
	ids: [],
	publicIds: [],
	parents: new Map(),
	leafId: null,
	inputs: [],
	toolCalls: [],
	gitContext: false,
};

type Draft = ConversationLogEntryDraft extends infer T
	? T extends unknown
		? Omit<T, "id" | "parentId" | "timestamp">
		: never
	: never;

function choose<T>(values: readonly T[], index: number): T | undefined {
	return values.length === 0 ? undefined : values[index % values.length];
}

function queuedDelivery(input: ClientInputModel): "steer" | "follow_up" | undefined {
	if (input.command !== "prompt") return input.command;
	if (input.behavior === "steer") return "steer";
	if (input.behavior === "followUp") return "follow_up";
	return undefined;
}

function assistantMessage(op: Extract<DraftOp, { kind: "assistant" }>, at: number, toolCallIds: string[]) {
	const model = MODELS[op.model % MODELS.length] ?? MODELS[0];
	const toolCalls: ToolCall[] = toolCallIds.map((id) => ({
		type: "toolCall",
		id,
		name: "read",
		arguments: { path: `${id}.txt` },
	}));
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: op.text }, ...toolCalls],
		api: "anthropic-messages",
		provider: model.provider,
		model: model.modelId,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: op.stopReason,
		timestamp: at,
	};
	return message;
}

/**
 * Interpret operations into drafts that extend `state` validly, skipping
 * operations with no eligible target, and return the state after them. Ids
 * are `<prefix>-<n>`, unique per prefix across the log.
 */
export function buildDrafts(
	state: DraftLogState,
	ops: readonly DraftOp[],
	prefix = "e",
): { readonly drafts: ConversationLogEntryDraft[]; readonly state: DraftLogState } {
	const drafts: ConversationLogEntryDraft[] = [];
	const ids = [...state.ids];
	const publicIds = [...state.publicIds];
	const parents = new Map(state.parents);
	const inputs = [...state.inputs];
	const toolCalls = [...state.toolCalls];
	let leafId = state.leafId;
	let gitContext = state.gitContext;

	const ordinal = (): number => state.entries + drafts.length + 1;
	const at = (): number => Date.UTC(2026, 0, 1) + ordinal() * 1000;
	const append = (draft: Draft): string => {
		const id = `${prefix}-${ids.length + 1}`;
		const entry = { ...draft, id, parentId: leafId, timestamp: new Date(at()).toISOString() };
		drafts.push(entry as ConversationLogEntryDraft);
		ids.push(id);
		parents.set(id, leafId);
		if (draft.type === "leaf") leafId = (draft.payload as { targetId: string | null }).targetId;
		else if (draft.visibility === "public") {
			publicIds.push(id);
			leafId = id;
		}
		return id;
	};
	const branchPath = (): string[] => {
		const path: string[] = [];
		for (let id = leafId; id !== null; id = parents.get(id) ?? null) path.push(id);
		return path;
	};
	const updateInput = (clientMessageId: string, update: Partial<ClientInputModel>): void => {
		const index = inputs.findIndex((input) => input.clientMessageId === clientMessageId);
		const current = inputs[index];
		if (current) inputs[index] = { ...current, ...update };
	};

	for (const op of ops) {
		switch (op.kind) {
			case "user":
				append({
					type: "message",
					visibility: "public",
					payload: {
						message: {
							role: "user",
							content: op.array ? [{ type: "text", text: op.text }] : op.text,
							timestamp: at(),
						},
					},
				});
				break;
			case "assistant": {
				const callIds = Array.from({ length: op.toolCalls }, (_, index) => `call-${toolCalls.length + index + 1}`);
				const message = assistantMessage(op, at(), callIds);
				toolCalls.push(...callIds);
				append({ type: "message", visibility: "public", payload: { message } });
				break;
			}
			case "tool_result":
				append({
					type: "message",
					visibility: "public",
					payload: {
						message: {
							role: "toolResult",
							toolCallId: choose(toolCalls, op.pick) ?? "call-unknown",
							toolName: "read",
							content: [{ type: "text", text: "contents" }],
							isError: op.isError,
							timestamp: at(),
						},
					},
				});
				break;
			case "bash":
				append({
					type: "message",
					visibility: "public",
					payload: {
						message: {
							role: "bashExecution",
							command: op.command,
							output: "ok",
							exitCode: 0,
							cancelled: false,
							truncated: false,
							timestamp: at(),
							...(op.exclude ? { excludeFromContext: true } : {}),
						},
					},
				});
				break;
			case "custom_message":
				append({
					type: "custom_message",
					visibility: "public",
					payload: {
						customType: "ext-note",
						content: op.array ? [{ type: "text", text: op.text }] : op.text,
						display: op.display,
						details: { ordinal: ordinal() },
					},
				});
				break;
			case "custom":
				append({
					type: "custom",
					visibility: "public",
					payload: { customType: op.customType, ...(op.data ? { data: { ordinal: ordinal() } } : {}) },
				});
				break;
			case "label": {
				const targetId = choose(publicIds, op.pick);
				if (targetId === undefined) break;
				append({
					type: "label",
					visibility: "public",
					payload: { targetId, ...(op.label === null ? {} : { label: op.label }) },
				});
				break;
			}
			case "name":
				append({ type: "session_info", visibility: "public", payload: { name: op.name } });
				break;
			case "model": {
				const model = MODELS[op.pick % MODELS.length] ?? MODELS[0];
				append({
					type: "model_change",
					visibility: "public",
					payload: { provider: model.provider, modelId: model.modelId },
				});
				break;
			}
			case "thinking":
				append({ type: "thinking_level_change", visibility: "public", payload: { thinkingLevel: op.level } });
				break;
			case "fast":
				append({ type: "fast_mode_change", visibility: "public", payload: { enabled: op.enabled } });
				break;
			case "planning":
				append({
					type: "planning_state_change",
					visibility: "public",
					payload: { planning: { mode: op.mode, plan: null } },
				});
				break;
			case "compaction": {
				const firstKeptEntryId = choose(branchPath(), op.pick);
				if (firstKeptEntryId === undefined) break;
				append({
					type: "compaction",
					visibility: "public",
					payload: { summary: op.summary, firstKeptEntryId, tokensBefore: 100 * ordinal() },
				});
				break;
			}
			case "navigate": {
				const targetId = choose([null, ...publicIds], op.pick) ?? null;
				if (targetId !== leafId) append({ type: "leaf", visibility: "host", payload: { targetId } });
				if (op.summary !== null) {
					append({
						type: "branch_summary",
						visibility: "public",
						payload: { fromId: targetId ?? "root", summary: op.summary },
					});
				}
				break;
			}
			case "receipt": {
				const clientMessageId = `client-${inputs.length + 1}`;
				const behavior = op.command === "prompt" ? op.behavior : null;
				const input = {
					message: op.text,
					images: [],
					...(behavior === null ? {} : { streamingBehavior: behavior }),
				};
				const receiptId = append({
					type: "client_input_receipt",
					visibility: "host",
					payload: {
						clientMessageId,
						command: op.command,
						semanticDigest: digestClientInputPayload(op.command, input),
						input,
					},
				});
				inputs.push({
					clientMessageId,
					receiptId,
					command: op.command,
					behavior,
					text: op.text,
					state: "accepted",
					queued: false,
				});
				break;
			}
			case "host_queue": {
				// A host input queues the messages it delivers; its receipt input is empty.
				const clientMessageId = `client-${inputs.length + 1}`;
				const input = { message: "", images: [] };
				const receiptId = append({
					type: "client_input_receipt",
					visibility: "host",
					payload: {
						clientMessageId,
						command: op.delivery,
						semanticDigest: digestClientInputPayload(op.delivery, input),
						input,
						origin: "host",
					},
				});
				append({
					type: "client_input_queued",
					visibility: "host",
					payload: {
						receiptId,
						clientMessageId,
						queuedInput: {
							delivery: op.delivery,
							message: "",
							images: [],
							messages: [
								{ role: "custom", customType: "ext-note", content: op.text, display: true, timestamp: at() },
							],
						},
					},
				});
				inputs.push({
					clientMessageId,
					receiptId,
					command: op.delivery,
					behavior: null,
					text: "",
					state: "accepted",
					queued: true,
				});
				break;
			}
			case "queue": {
				const input = choose(
					inputs.filter(
						(candidate) =>
							(candidate.state === "accepted" || candidate.state === "started") &&
							!candidate.queued &&
							queuedDelivery(candidate) !== undefined,
					),
					op.pick,
				);
				const delivery = input && queuedDelivery(input);
				if (!input || !delivery) break;
				append({
					type: "client_input_queued",
					visibility: "host",
					payload: {
						receiptId: input.receiptId,
						clientMessageId: input.clientMessageId,
						queuedInput: { delivery, message: input.text, images: [] },
					},
				});
				updateInput(input.clientMessageId, { queued: true, state: "accepted" });
				break;
			}
			case "transition": {
				const input = choose(
					inputs.filter((candidate) => NEXT_CLIENT_INPUT_STATES[candidate.state].length > 0),
					op.pick,
				);
				const next = input && choose(NEXT_CLIENT_INPUT_STATES[input.state], op.choice);
				if (!input || !next) break;
				append({
					type: "client_input_state",
					visibility: "host",
					payload: {
						receiptId: input.receiptId,
						clientMessageId: input.clientMessageId,
						state: next,
						...(next === "failed" && op.error !== null ? { error: op.error } : {}),
					},
				});
				updateInput(input.clientMessageId, { state: next });
				break;
			}
			case "complete": {
				const input = choose(
					inputs.filter((candidate) => candidate.state === "started"),
					op.pick,
				);
				if (!input) break;
				append({
					type: "message",
					visibility: "public",
					clientMessageId: input.clientMessageId,
					payload: { message: { role: "user", content: input.text, timestamp: at() } },
				});
				updateInput(input.clientMessageId, { state: "completed" });
				break;
			}
			case "spawn":
				// A subagent started: host work that never moves the leaf.
				append({
					type: "work_started",
					visibility: "host",
					payload: {
						workId: `sa-${ordinal()}`,
						kind: "subagent",
						title: "worker",
						input: { agent: "worker" },
						cancellable: true,
						delivery: "none",
						resume: true,
						state: "running",
						toolCallId: `call-${ordinal()}`,
						child: { conversation: `child-${ordinal()}` },
					},
				});
				break;
			case "git_context":
				if (gitContext) break;
				append({ type: "session_start_git_context", visibility: "host", payload: { gitContext: null } });
				gitContext = true;
				break;
		}
	}
	if (drafts.length === 0) append({ type: "custom", visibility: "public", payload: { customType: "filler" } });
	return {
		drafts,
		state: {
			entries: state.entries + drafts.length,
			ids,
			publicIds,
			parents,
			leafId,
			inputs,
			toolCalls,
			gitContext,
		},
	};
}
