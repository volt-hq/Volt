import type { AssistantMessage, StopReason } from "@hansjm10/volt-ai";
import * as fc from "fast-check";
import type { Static } from "typebox";
import {
	CLIENT_WORK_FINISHED_MAX,
	type ClientBranchValues,
	type ClientLabel,
	type ClientQueuedInput,
	type ClientWorkItem,
	DEFAULT_CLIENT_BRANCH_VALUES,
} from "../src/client-fold.ts";
import type { ClientInputCommand, ClientInputState, ForkedFromEntryPayload } from "../src/entries.ts";
import type { RpcThinkingLevelSchema } from "../src/primitives.ts";
import { isPublicProjectedEntryType, type ProjectedEntry } from "../src/projected.ts";
import type { WorkDelivery, WorkKind, WorkOutcome } from "../src/work.ts";

type ThinkingLevel = Static<typeof RpcThinkingLevelSchema>;

/** One abstract step of a generated projected log. Picks select targets modulo the eligible choices. */
export type ProjectedLogOp =
	| { kind: "user"; text: string; array: boolean }
	| { kind: "assistant"; text: string; model: number; stopReason: StopReason; toolCall: boolean }
	| { kind: "tool_result"; pick: number; isError: boolean }
	| { kind: "custom_message"; text: string; display: boolean }
	| { kind: "custom" }
	| { kind: "label"; pick: number; label: string | null }
	| { kind: "name"; name: string }
	| { kind: "model"; pick: number }
	| { kind: "thinking"; level: ThinkingLevel }
	| { kind: "fast"; enabled: boolean }
	| { kind: "planning"; mode: "build" | "plan" }
	| { kind: "compaction"; pick: number }
	| { kind: "navigate"; pick: number; summary: boolean }
	| { kind: "fork"; pick: number; text: string }
	| {
			kind: "receipt";
			command: ClientInputCommand;
			behavior: "steer" | "followUp" | null;
			text: string;
			origin: boolean;
			images: number;
	  }
	| { kind: "queue"; pick: number }
	| { kind: "transition"; pick: number; choice: number }
	| { kind: "complete"; pick: number }
	| {
			kind: "work_start";
			workKind: number;
			delivery: number;
			resume: boolean;
			awaiting: boolean;
			parent: number | null;
	  }
	| { kind: "work_checkpoint"; pick: number; cancelling: boolean; progress: boolean }
	| { kind: "work_finish"; pick: number; outcome: number; result: boolean };

const text = fc.string({ maxLength: 8 });
const pick = fc.nat({ max: 1_000 });

const opArbitrary: fc.Arbitrary<ProjectedLogOp> = fc.oneof(
	{ weight: 5, arbitrary: fc.record({ kind: fc.constant("user" as const), text, array: fc.boolean() }) },
	{
		weight: 5,
		arbitrary: fc.record({
			kind: fc.constant("assistant" as const),
			text,
			model: fc.nat({ max: 2 }),
			stopReason: fc.constantFrom<StopReason>("stop", "toolUse", "error", "aborted"),
			toolCall: fc.boolean(),
		}),
	},
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("tool_result" as const), pick, isError: fc.boolean() }) },
	fc.record({ kind: fc.constant("custom_message" as const), text, display: fc.boolean() }),
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("custom" as const) }) },
	fc.record({ kind: fc.constant("label" as const), pick, label: fc.option(text, { nil: null }) }),
	fc.record({ kind: fc.constant("name" as const), name: fc.constantFrom("", "  ", "Plan", " Named ") }),
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("model" as const), pick }) },
	fc.record({
		kind: fc.constant("thinking" as const),
		level: fc.constantFrom<ThinkingLevel>("off", "minimal", "low", "medium", "high", "xhigh", "max"),
	}),
	fc.record({ kind: fc.constant("fast" as const), enabled: fc.boolean() }),
	fc.record({ kind: fc.constant("planning" as const), mode: fc.constantFrom("build" as const, "plan" as const) }),
	fc.record({ kind: fc.constant("compaction" as const), pick }),
	{ weight: 3, arbitrary: fc.record({ kind: fc.constant("navigate" as const), pick, summary: fc.boolean() }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("fork" as const), pick, text }) },
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant("receipt" as const),
			command: fc.constantFrom<ClientInputCommand>("prompt", "steer", "follow_up"),
			behavior: fc.constantFrom("steer" as const, "followUp" as const, null),
			text,
			origin: fc.boolean(),
			images: fc.nat({ max: 2 }),
		}),
	},
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("queue" as const), pick }) },
	{ weight: 3, arbitrary: fc.record({ kind: fc.constant("transition" as const), pick, choice: pick }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("complete" as const), pick }) },
	{
		weight: 3,
		arbitrary: fc.record({
			kind: fc.constant("work_start" as const),
			workKind: fc.nat({ max: 3 }),
			delivery: fc.nat({ max: 2 }),
			resume: fc.boolean(),
			awaiting: fc.boolean(),
			parent: fc.option(pick, { nil: null }),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("work_checkpoint" as const),
			pick,
			cancelling: fc.boolean(),
			progress: fc.boolean(),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("work_finish" as const),
			pick,
			outcome: fc.nat({ max: 3 }),
			result: fc.boolean(),
		}),
	},
);

const WORK_KINDS: readonly WorkKind[] = ["job", "subagent", "review", "ext:swarm-review/run"];
const WORK_DELIVERIES: readonly WorkDelivery[] = ["none", "message", "wake"];
const WORK_OUTCOMES: readonly WorkOutcome[] = ["completed", "failed", "cancelled", "interrupted"];

const MODELS = [
	{ provider: "anthropic", modelId: "claude-a" },
	{ provider: "openai", modelId: "gpt-b" },
	{ provider: "google", modelId: "gemini-c" },
] as const;

const NEXT_STATES: Record<ClientInputState, readonly ClientInputState[]> = {
	accepted: ["started", "completed", "failed", "withdrawn"],
	started: ["accepted", "completed", "failed"],
	completed: [],
	failed: [],
	withdrawn: [],
};

const IMAGE = { type: "image" as const, mimeType: "image/png", data: "aGk=" };

/** What a client must know after folding the whole log, tracked independently of the fold. */
export interface ExpectedClientState {
	readonly leafId: string | null;
	readonly values: ClientBranchValues;
	readonly name: string | null;
	readonly labels: readonly ClientLabel[];
	readonly queue: readonly ClientQueuedInput[];
	readonly forkedFrom: ForkedFromEntryPayload | null;
	/** Open work and the newest finished work, by start ordinal. */
	readonly work: readonly ClientWorkItem[];
}

export interface ProjectedLog {
	readonly entries: readonly ProjectedEntry[];
	readonly expected: ExpectedClientState;
}

interface ModelInput {
	readonly clientMessageId: string;
	readonly receiptId: string;
	readonly command: ClientInputCommand;
	readonly behavior: "steer" | "followUp" | null;
	readonly text: string;
	readonly origin: boolean;
	readonly images: number;
	state: ClientInputState;
	admission: number;
	delivery: "steer" | "follow_up" | undefined;
}

type Draft = ProjectedEntry extends infer T
	? T extends unknown
		? Omit<T, "ordinal" | "id" | "timestamp">
		: never
	: never;

function choose<T>(values: readonly T[], index: number): T | undefined {
	return values.length === 0 ? undefined : values[index % values.length];
}

function queuedDelivery(input: ModelInput): "steer" | "follow_up" | undefined {
	if (input.command !== "prompt") return input.command;
	if (input.behavior === "steer") return "steer";
	if (input.behavior === "followUp") return "follow_up";
	return undefined;
}

/** The branch values at a node: its parent's, changed by the node's own entry. */
function nodeValues(parent: ClientBranchValues, entry: ProjectedEntry): ClientBranchValues {
	switch (entry.type) {
		case "model_change":
			return entry.payload ? { ...parent, model: { ...entry.payload } } : parent;
		case "thinking_level_change":
			return entry.payload ? { ...parent, thinkingLevel: entry.payload.thinkingLevel } : parent;
		case "fast_mode_change":
			return entry.payload ? { ...parent, fastMode: entry.payload.enabled } : parent;
		case "planning_state_change":
			return entry.payload ? { ...parent, planning: entry.payload.planning } : parent;
		case "message": {
			const message = entry.payload?.message;
			return message?.role === "assistant"
				? { ...parent, model: { provider: message.provider, modelId: message.model } }
				: parent;
		}
		default:
			return parent;
	}
}

function assistantMessage(op: Extract<ProjectedLogOp, { kind: "assistant" }>, ordinal: number, toolCallId?: string) {
	const model = MODELS[op.model % MODELS.length] ?? MODELS[0];
	const message: AssistantMessage = {
		role: "assistant",
		content: [
			{ type: "text", text: op.text },
			...(toolCallId === undefined
				? []
				: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: { path: "a.txt" } }]),
		],
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
	};
	return message;
}

/** Interprets operations into a well-formed local-profile projected log, skipping operations with no target. */
export function buildProjectedLog(ops: readonly ProjectedLogOp[], forked: boolean): ProjectedLog {
	const entries: ProjectedEntry[] = [];
	const publicIds: string[] = [];
	const parents = new Map<string, string | null>();
	const values = new Map<string, ClientBranchValues>();
	const labels = new Map<string, { label: string; timestamp: string }>();
	const inputs: ModelInput[] = [];
	const toolCalls: string[] = [];
	let leafId: string | null = null;
	let name: string | null = null;
	let forkedFrom: ForkedFromEntryPayload | null = null;
	const work = new Map<string, ClientWorkItem>();
	const openWork = () => [...work.values()].filter((item) => item.outcome === undefined);

	const append = (draft: Draft): ProjectedEntry => {
		const ordinal = entries.length + 1;
		const entry = {
			ordinal,
			id: `e${ordinal}`,
			timestamp: new Date(Date.UTC(2026, 0, 1) + ordinal * 1000).toISOString(),
			...draft,
		} as ProjectedEntry;
		entries.push(entry);
		parents.set(entry.id, entry.parentId);
		if (entry.type === "leaf") {
			leafId = entry.payload?.targetId ?? null;
		} else if (isPublicProjectedEntryType(entry.type)) {
			const parent = entry.parentId === null ? undefined : values.get(entry.parentId);
			values.set(entry.id, nodeValues(parent ?? DEFAULT_CLIENT_BRANCH_VALUES, entry));
			publicIds.push(entry.id);
			leafId = entry.id;
		}
		return entry;
	};
	const branchPath = (): string[] => {
		const path: string[] = [];
		for (let id = leafId; id !== null; id = parents.get(id) ?? null) path.push(id);
		return path;
	};

	if (forked) {
		forkedFrom = { sessionId: "parent-session", entryId: "p7" };
		append({ parentId: null, type: "forked_from", payload: forkedFrom });
	}

	for (const op of ops) {
		const ordinal = entries.length + 1;
		switch (op.kind) {
			case "user":
				append({
					parentId: leafId,
					type: "message",
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
				const toolCallId = op.toolCall ? `call-${ordinal}` : undefined;
				if (toolCallId !== undefined) toolCalls.push(toolCallId);
				append({
					parentId: leafId,
					type: "message",
					payload: { message: assistantMessage(op, ordinal, toolCallId) },
				});
				break;
			}
			case "tool_result":
				append({
					parentId: leafId,
					type: "message",
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
			case "custom_message":
				append({
					parentId: leafId,
					type: "custom_message",
					payload: { customType: "ext-note", content: op.text, display: op.display },
				});
				break;
			case "custom":
				append({ parentId: leafId, type: "custom", payload: { customType: "ext-a" } });
				break;
			case "label": {
				const targetId = choose(publicIds, op.pick);
				if (targetId === undefined) break;
				const entry = append({
					parentId: leafId,
					type: "label",
					payload: { targetId, ...(op.label === null ? {} : { label: op.label }) },
				});
				if (op.label) labels.set(targetId, { label: op.label, timestamp: entry.timestamp });
				else labels.delete(targetId);
				break;
			}
			case "name":
				append({ parentId: leafId, type: "session_info", payload: { name: op.name } });
				name = op.name.trim() || null;
				break;
			case "model": {
				const model = MODELS[op.pick % MODELS.length] ?? MODELS[0];
				append({ parentId: leafId, type: "model_change", payload: { ...model } });
				break;
			}
			case "thinking":
				append({ parentId: leafId, type: "thinking_level_change", payload: { thinkingLevel: op.level } });
				break;
			case "fast":
				append({ parentId: leafId, type: "fast_mode_change", payload: { enabled: op.enabled } });
				break;
			case "planning":
				append({
					parentId: leafId,
					type: "planning_state_change",
					payload: { planning: { mode: op.mode, plan: null } },
				});
				break;
			case "compaction": {
				const firstKeptEntryId = choose(branchPath(), op.pick);
				if (firstKeptEntryId === undefined) break;
				append({
					parentId: leafId,
					type: "compaction",
					payload: { summary: "summary", firstKeptEntryId, tokensBefore: 100 * ordinal },
				});
				break;
			}
			case "navigate": {
				const targetId = choose([null, ...publicIds], op.pick) ?? null;
				if (targetId !== leafId) append({ parentId: leafId, type: "leaf", payload: { targetId } });
				if (op.summary) {
					append({
						parentId: leafId,
						type: "branch_summary",
						payload: { fromId: targetId ?? "root", summary: "branch" },
					});
				}
				break;
			}
			case "fork":
				append({
					parentId: choose([null, ...publicIds], op.pick) ?? null,
					type: "message",
					payload: { message: { role: "user", content: op.text, timestamp: ordinal } },
				});
				break;
			case "receipt": {
				const clientMessageId = `client-${inputs.length + 1}`;
				const behavior = op.command === "prompt" ? op.behavior : null;
				const images = Array.from({ length: op.images }, () => IMAGE);
				const receipt = append({
					parentId: leafId,
					type: "client_input_receipt",
					payload: {
						clientMessageId,
						command: op.command,
						semanticDigest: "0".repeat(64),
						input: { message: op.text, images, ...(behavior === null ? {} : { streamingBehavior: behavior }) },
						...(op.origin ? { origin: "host" as const } : {}),
					},
				});
				inputs.push({
					clientMessageId,
					receiptId: receipt.id,
					command: op.command,
					behavior,
					text: op.text,
					origin: op.origin,
					images: op.images,
					state: "accepted",
					admission: receipt.ordinal,
					delivery: undefined,
				});
				break;
			}
			case "queue": {
				const input = choose(
					inputs.filter(
						(candidate) =>
							(candidate.state === "accepted" || candidate.state === "started") &&
							candidate.delivery === undefined &&
							queuedDelivery(candidate) !== undefined,
					),
					op.pick,
				);
				const delivery = input && queuedDelivery(input);
				if (!input || !delivery) break;
				const queued = append({
					parentId: leafId,
					type: "client_input_queued",
					payload: {
						receiptId: input.receiptId,
						clientMessageId: input.clientMessageId,
						queuedInput: {
							delivery,
							message: input.text,
							images: Array.from({ length: input.images }, () => IMAGE),
						},
					},
				});
				input.state = "accepted";
				input.delivery = delivery;
				input.admission = queued.ordinal;
				break;
			}
			case "transition": {
				const input = choose(
					inputs.filter((candidate) => NEXT_STATES[candidate.state].length > 0),
					op.pick,
				);
				const state = input && choose(NEXT_STATES[input.state], op.choice);
				if (!input || !state) break;
				append({
					parentId: leafId,
					type: "client_input_state",
					payload: { receiptId: input.receiptId, clientMessageId: input.clientMessageId, state },
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
					parentId: leafId,
					type: "message",
					payload: {
						message: { role: "user", content: input.text, timestamp: ordinal },
						clientMessageId: input.clientMessageId,
					},
				});
				input.state = "completed";
				break;
			}
			case "work_start": {
				const workId = `w${ordinal}`;
				const parentWorkId = op.parent === null ? undefined : choose([...work.keys()], op.parent);
				const kind = WORK_KINDS[op.workKind] ?? "job";
				const payload = {
					workId,
					kind,
					title: `Work ${ordinal}`,
					...(parentWorkId === undefined ? {} : { parentWorkId }),
					input: { ordinal },
					cancellable: op.resume,
					delivery: WORK_DELIVERIES[op.delivery] ?? "none",
					resume: op.resume,
					state: op.awaiting ? ("awaiting_approval" as const) : ("running" as const),
					...(kind === "subagent" ? { child: { conversation: `child-${ordinal}` } } : {}),
				};
				append({ parentId: leafId, type: "work_started", payload });
				const { input: _input, ...item } = payload;
				work.set(workId, { ...item, startedOrdinal: ordinal, updatedOrdinal: ordinal });
				break;
			}
			case "work_checkpoint": {
				const item = choose(openWork(), op.pick);
				if (!item) break;
				const state = op.cancelling ? ("cancelling" as const) : item.state === "cancelling" ? undefined : "running";
				const progress = op.progress ? { text: `step ${ordinal}`, value: 1, max: 2 } : undefined;
				append({
					parentId: leafId,
					type: "work_checkpoint",
					payload: {
						workId: item.workId,
						...(state === undefined ? {} : { state }),
						...(progress === undefined ? {} : { progress }),
					},
				});
				work.set(item.workId, {
					...item,
					...(state === undefined ? {} : { state }),
					...(progress === undefined ? {} : { progress }),
					updatedOrdinal: ordinal,
				});
				break;
			}
			case "work_finish": {
				const item = choose(openWork(), op.pick);
				if (!item) break;
				const outcome = WORK_OUTCOMES[op.outcome] ?? "completed";
				append({
					parentId: leafId,
					type: "work_finished",
					payload: {
						workId: item.workId,
						outcome,
						...(op.result
							? {
									result: {
										summary: "done",
										output: { text: "tail", truncated: true },
										data: { findings: 1 },
									},
								}
							: {}),
					},
				});
				work.set(item.workId, {
					...item,
					outcome,
					...(op.result ? { result: { summary: "done", output: { truncated: true } } } : {}),
					updatedOrdinal: ordinal,
					finishedOrdinal: ordinal,
				});
				const finished = [...work.values()]
					.filter((candidate) => candidate.finishedOrdinal !== undefined)
					.sort((left, right) => (left.finishedOrdinal ?? 0) - (right.finishedOrdinal ?? 0));
				for (const evicted of finished.slice(0, Math.max(0, finished.length - CLIENT_WORK_FINISHED_MAX))) {
					work.delete(evicted.workId);
				}
				break;
			}
		}
	}

	const queue = inputs
		.filter((input) => input.state === "accepted" || input.state === "started")
		.sort((left, right) => left.admission - right.admission)
		.map(
			(input): ClientQueuedInput => ({
				clientMessageId: input.clientMessageId,
				state: input.state === "started" ? "started" : "accepted",
				ordinal: input.admission,
				command: input.command,
				...(input.delivery === undefined ? {} : { delivery: input.delivery }),
				...(input.origin ? { origin: "host" as const } : {}),
				message: input.text,
				imageCount: input.images,
			}),
		);
	return {
		entries,
		expected: {
			leafId,
			values: (leafId === null ? undefined : values.get(leafId)) ?? DEFAULT_CLIENT_BRANCH_VALUES,
			name,
			labels: [...labels].map(([targetId, value]) => ({ targetId, ...value })),
			queue,
			forkedFrom,
			work: [...work.values()],
		},
	};
}

/** Generated well-formed projected logs. */
export const projectedLogArbitrary: fc.Arbitrary<ProjectedLog> = fc
	.tuple(fc.array(opArbitrary, { maxLength: 60, size: "medium" }), fc.boolean())
	.map(([ops, forked]) => buildProjectedLog(ops, forked));

/** One frame of a subscription's entry stream. */
export type StreamFrame = { readonly entry: ProjectedEntry } | { readonly head: number };

/**
 * The stream a profile that hides `custom` entries
 * (and labels on hidden entries) sends: hidden entries become `head` frames,
 * and parents and leaf targets name the nearest visible ancestor.
 */
export function hidingStream(log: ProjectedLog): {
	frames: StreamFrame[];
	leafId: string | null;
	labels: ClientLabel[];
} {
	const hidden = new Set<string>();
	const parents = new Map<string, string | null>();
	const visibleAncestor = (id: string | null): string | null => {
		let current = id;
		while (current !== null && hidden.has(current)) current = parents.get(current) ?? null;
		return current;
	};
	const frames: StreamFrame[] = [];
	for (const entry of log.entries) {
		parents.set(entry.id, entry.parentId);
		const hide =
			entry.type === "custom" ||
			(entry.type === "label" && entry.payload !== undefined && hidden.has(entry.payload.targetId));
		if (hide) {
			hidden.add(entry.id);
			frames.push({ head: entry.ordinal });
			continue;
		}
		const parentId = visibleAncestor(entry.parentId);
		const projected =
			entry.type === "leaf" && entry.payload
				? { ...entry, parentId, payload: { targetId: visibleAncestor(entry.payload.targetId) } }
				: { ...entry, parentId };
		frames.push({ entry: projected });
	}
	return {
		frames,
		leafId: visibleAncestor(log.expected.leafId),
		labels: log.expected.labels.filter((label) => !hidden.has(label.targetId)),
	};
}

/** Deep-freeze a value so any mutation throws. */
export function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}
