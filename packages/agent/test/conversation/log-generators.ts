import type { AssistantMessage, StopReason, ToolCall } from "@hansjm10/volt-ai";
import type { ClientInputCommand, ClientInputState, LogEntry } from "@hansjm10/volt-protocol/entries";
import * as fc from "fast-check";
import type { ConversationLogEntry } from "../../src/conversation/log.ts";
import type { ThinkingLevel } from "../../src/types.ts";

/** One abstract step of a generated log. Picks select targets modulo the eligible choices. */
export type LogOp =
	| { kind: "user"; text: string; array: boolean }
	| {
			kind: "assistant";
			text: string;
			toolCalls: number;
			stopReason: StopReason;
			model: number;
			invalidArguments: boolean;
	  }
	| { kind: "tool_result"; pick: number; isError: boolean }
	| { kind: "bash"; command: string; exclude: boolean }
	| { kind: "custom_message"; text: string; display: boolean; array: boolean }
	| { kind: "custom"; customType: string }
	| { kind: "label"; pick: number; label: string | null }
	| { kind: "name"; name: string }
	| { kind: "model"; pick: number }
	| { kind: "thinking"; level: ThinkingLevel }
	| { kind: "fast"; enabled: boolean }
	| { kind: "planning"; mode: "build" | "plan" }
	| { kind: "compaction"; pick: number; summary: string }
	| { kind: "navigate"; pick: number; summary: string | null }
	| { kind: "product"; visibility: "public" | "host" }
	| { kind: "receipt"; command: ClientInputCommand; behavior: "steer" | "followUp" | null; text: string }
	| { kind: "queue"; pick: number }
	| { kind: "transition"; pick: number; choice: number; error: string | null }
	| { kind: "complete"; pick: number }
	| { kind: "spawn" };

const text = fc.string({ maxLength: 12 });
const pick = fc.nat({ max: 1_000 });

export const logOpArbitrary: fc.Arbitrary<LogOp> = fc.oneof(
	{ weight: 6, arbitrary: fc.record({ kind: fc.constant("user" as const), text, array: fc.boolean() }) },
	{
		weight: 6,
		arbitrary: fc.record({
			kind: fc.constant("assistant" as const),
			text,
			toolCalls: fc.nat({ max: 2 }),
			stopReason: fc.constantFrom<StopReason>("stop", "toolUse", "error", "aborted"),
			model: fc.nat({ max: 2 }),
			invalidArguments: fc.boolean(),
		}),
	},
	{
		weight: 4,
		arbitrary: fc.record({ kind: fc.constant("tool_result" as const), pick, isError: fc.boolean() }),
	},
	fc.record({ kind: fc.constant("bash" as const), command: text, exclude: fc.boolean() }),
	fc.record({ kind: fc.constant("custom_message" as const), text, display: fc.boolean(), array: fc.boolean() }),
	fc.record({ kind: fc.constant("custom" as const), customType: fc.constantFrom("ext-a", "ext-b") }),
	fc.record({ kind: fc.constant("label" as const), pick, label: fc.option(text, { nil: null }) }),
	fc.record({ kind: fc.constant("name" as const), name: fc.constantFrom("", "  ", "Plan", " Named ") }),
	fc.record({ kind: fc.constant("model" as const), pick }),
	fc.record({
		kind: fc.constant("thinking" as const),
		level: fc.constantFrom<ThinkingLevel>("off", "minimal", "low", "medium", "high", "xhigh", "max"),
	}),
	fc.record({ kind: fc.constant("fast" as const), enabled: fc.boolean() }),
	fc.record({ kind: fc.constant("planning" as const), mode: fc.constantFrom("build" as const, "plan" as const) }),
	{
		weight: 2,
		arbitrary: fc.record({ kind: fc.constant("compaction" as const), pick, summary: text }),
	},
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant("navigate" as const),
			pick,
			summary: fc.option(fc.constantFrom("", "summary of the branch"), { nil: null }),
		}),
	},
	fc.record({
		kind: fc.constant("product" as const),
		visibility: fc.constantFrom("public" as const, "host" as const),
	}),
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
	{
		weight: 4,
		arbitrary: fc.record({
			kind: fc.constant("transition" as const),
			pick,
			choice: pick,
			error: fc.option(fc.constant("dispatch failed"), { nil: null }),
		}),
	},
	{ weight: 3, arbitrary: fc.record({ kind: fc.constant("complete" as const), pick }) },
	fc.record({ kind: fc.constant("spawn" as const) }),
);

/** Generated operations; build their log with {@link buildLog}. */
export const logOpsArbitrary = fc.array(logOpArbitrary, { maxLength: 60, size: "medium" });

const MODELS = [
	{ provider: "anthropic", modelId: "claude-a" },
	{ provider: "openai", modelId: "gpt-b" },
	{ provider: "google", modelId: "gemini-c" },
] as const;

const NEXT_CLIENT_INPUT_STATES: Record<ClientInputState, readonly ClientInputState[]> = {
	accepted: ["started", "completed", "failed", "withdrawn"],
	started: ["accepted", "completed", "failed"],
	completed: [],
	failed: [],
	withdrawn: [],
};

interface ModelInput {
	readonly clientMessageId: string;
	readonly receiptId: string;
	readonly command: ClientInputCommand;
	readonly behavior: "steer" | "followUp" | null;
	readonly text: string;
	state: ClientInputState;
	queued: boolean;
}

type Draft = ConversationLogEntry extends infer T ? (T extends unknown ? Omit<T, "ordinal" | "id"> : never) : never;

function choose<T>(values: readonly T[], index: number): T | undefined {
	return values.length === 0 ? undefined : values[index % values.length];
}

function queuedDelivery(input: ModelInput): "steer" | "follow_up" | undefined {
	if (input.command !== "prompt") return input.command;
	if (input.behavior === "steer") return "steer";
	if (input.behavior === "followUp") return "follow_up";
	return undefined;
}

function assistantMessage(op: Extract<LogOp, { kind: "assistant" }>, ordinal: number, toolCallIds: string[]) {
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
		timestamp: ordinal,
		...(op.stopReason === "error" && op.invalidArguments && toolCalls.length > 0
			? {
					diagnostics: [
						{
							type: "invalid_tool_arguments",
							timestamp: ordinal,
							details: { contentIndex: 1, code: "length_limit" },
						},
					],
				}
			: {}),
	};
	return message;
}

/** Interprets operations into a well-formed log, skipping operations with no eligible target. */
export function buildLog(ops: readonly LogOp[]): ConversationLogEntry[] {
	const entries: ConversationLogEntry[] = [];
	const publicIds: string[] = [];
	const parents = new Map<string, string | null>();
	const inputs: ModelInput[] = [];
	const toolCalls: string[] = [];
	let leafId: string | null = null;

	const append = (draft: Draft): string => {
		const ordinal = entries.length + 1;
		const id = `e${ordinal}`;
		const entry = { ordinal, id, ...draft } as ConversationLogEntry;
		entries.push(entry);
		parents.set(id, entry.parentId);
		if (entry.type === "leaf") leafId = (entry as Extract<LogEntry, { type: "leaf" }>).payload.targetId;
		else if (entry.visibility === "public") {
			publicIds.push(id);
			leafId = id;
		}
		return id;
	};
	const base = () => ({
		parentId: leafId,
		timestamp: new Date(Date.UTC(2026, 0, 1) + (entries.length + 1) * 1000).toISOString(),
	});
	const branchPath = (): string[] => {
		const path: string[] = [];
		for (let id = leafId; id !== null; id = parents.get(id) ?? null) path.push(id);
		return path;
	};

	for (const op of ops) {
		const ordinal = entries.length + 1;
		switch (op.kind) {
			case "user":
				append({
					...base(),
					type: "message",
					visibility: "public",
					payload: {
						message: {
							role: "user",
							content: op.array ? [{ type: "text", text: op.text }] : op.text,
							timestamp: ordinal,
						},
					},
				});
				break;
			case "assistant": {
				const ids = Array.from({ length: op.toolCalls }, (_, index) => `call-${toolCalls.length + index + 1}`);
				toolCalls.push(...ids);
				append({
					...base(),
					type: "message",
					visibility: "public",
					payload: { message: assistantMessage(op, ordinal, ids) },
				});
				break;
			}
			case "tool_result":
				append({
					...base(),
					type: "message",
					visibility: "public",
					payload: {
						message: {
							role: "toolResult",
							toolCallId: choose(toolCalls, op.pick) ?? "call-unknown",
							toolName: "read",
							content: [{ type: "text", text: "contents" }],
							isError: op.isError,
							timestamp: ordinal,
						},
					},
				});
				break;
			case "bash":
				append({
					...base(),
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
							timestamp: ordinal,
							...(op.exclude ? { excludeFromContext: true } : {}),
						},
					},
				});
				break;
			case "custom_message":
				append({
					...base(),
					type: "custom_message",
					visibility: "public",
					payload: {
						customType: "ext-note",
						content: op.array ? [{ type: "text", text: op.text }] : op.text,
						display: op.display,
						details: { ordinal },
					},
				});
				break;
			case "custom":
				append({ ...base(), type: "custom", visibility: "public", payload: { customType: op.customType } });
				break;
			case "label": {
				const targetId = choose(publicIds, op.pick);
				if (targetId === undefined) break;
				append({
					...base(),
					type: "label",
					visibility: "public",
					payload: { targetId, ...(op.label === null ? {} : { label: op.label }) },
				});
				break;
			}
			case "name":
				append({ ...base(), type: "session_info", visibility: "public", payload: { name: op.name } });
				break;
			case "model": {
				const model = MODELS[op.pick % MODELS.length] ?? MODELS[0];
				append({
					...base(),
					type: "model_change",
					visibility: "public",
					payload: { provider: model.provider, modelId: model.modelId },
				});
				break;
			}
			case "thinking":
				append({
					...base(),
					type: "thinking_level_change",
					visibility: "public",
					payload: { thinkingLevel: op.level },
				});
				break;
			case "fast":
				append({ ...base(), type: "fast_mode_change", visibility: "public", payload: { enabled: op.enabled } });
				break;
			case "planning":
				append({
					...base(),
					type: "planning_state_change",
					visibility: "public",
					payload: { planning: { mode: op.mode, plan: null } },
				});
				break;
			case "compaction": {
				const firstKeptEntryId = choose(branchPath(), op.pick);
				if (firstKeptEntryId === undefined) break;
				append({
					...base(),
					type: "compaction",
					visibility: "public",
					payload: { summary: op.summary, firstKeptEntryId, tokensBefore: 100 * ordinal },
				});
				break;
			}
			case "navigate": {
				const targetId = choose([null, ...publicIds], op.pick) ?? null;
				if (targetId !== leafId) {
					append({ ...base(), type: "leaf", visibility: "host", payload: { targetId } });
				}
				if (op.summary !== null) {
					append({
						...base(),
						type: "branch_summary",
						visibility: "public",
						payload: { fromId: targetId ?? "root", summary: op.summary },
					});
				}
				break;
			}
			case "product":
				append({ ...base(), type: "test_product", visibility: op.visibility, payload: { ordinal } });
				break;
			case "receipt": {
				const clientMessageId = `client-${inputs.length + 1}`;
				const behavior = op.command === "prompt" ? op.behavior : null;
				const receiptId = append({
					...base(),
					type: "client_input_receipt",
					visibility: "host",
					payload: {
						clientMessageId,
						command: op.command,
						semanticDigest: "0".repeat(64),
						input: {
							message: op.text,
							images: [],
							...(behavior === null ? {} : { streamingBehavior: behavior }),
						},
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
					...base(),
					type: "client_input_queued",
					visibility: "host",
					payload: {
						receiptId: input.receiptId,
						clientMessageId: input.clientMessageId,
						queuedInput: { delivery, message: input.text, images: [] },
					},
				});
				input.queued = true;
				input.state = "accepted";
				break;
			}
			case "transition": {
				const input = choose(
					inputs.filter((candidate) => NEXT_CLIENT_INPUT_STATES[candidate.state].length > 0),
					op.pick,
				);
				const state = input && choose(NEXT_CLIENT_INPUT_STATES[input.state], op.choice);
				if (!input || !state) break;
				append({
					...base(),
					type: "client_input_state",
					visibility: "host",
					payload: {
						receiptId: input.receiptId,
						clientMessageId: input.clientMessageId,
						state,
						...(state === "failed" && op.error !== null ? { error: op.error } : {}),
					},
				});
				input.state = state;
				break;
			}
			case "complete": {
				const input = choose(
					inputs.filter((candidate) => candidate.state === "started"),
					op.pick,
				);
				if (!input) break;
				append({
					...base(),
					type: "message",
					visibility: "public",
					clientMessageId: input.clientMessageId,
					payload: { message: { role: "user", content: input.text, timestamp: ordinal } },
				});
				input.state = "completed";
				break;
			}
			case "spawn":
				append({
					...base(),
					type: "subagent_spawn",
					visibility: "host",
					payload: {
						toolCallId: `call-${ordinal}`,
						subagentId: `sub-${ordinal}`,
						agent: "worker",
						childSessionId: `child-${ordinal}`,
						requestKey: `request-${ordinal}`,
					},
				});
				break;
		}
	}
	return entries;
}

/** Generated well-formed logs. */
export const logArbitrary: fc.Arbitrary<ConversationLogEntry[]> = logOpsArbitrary.map(buildLog);

/** Deep-freeze a value so any mutation throws. */
export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}
