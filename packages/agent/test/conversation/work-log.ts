import type { LogEntry } from "@hansjm10/volt-protocol/entries";
import type { WorkDelivery, WorkKind, WorkOutcome, WorkState } from "@hansjm10/volt-protocol/work";
import * as fc from "fast-check";
import type { ConversationLogEntry } from "../../src/conversation/log.ts";
import type { WorkRecord } from "../../src/conversation/work.ts";
import { buildLog, logOpsArbitrary } from "./log-generators.ts";

/** One abstract work step. Picks select targets modulo the eligible choices. */
export type WorkOp =
	| {
			op: "start";
			/** A fresh id, an id already started, or an id named as a parent before it started. */
			id: "fresh" | "duplicate" | "named";
			/** No parent, an earlier item, an id no item of this log has, or the item itself. */
			parent: "none" | "in_log" | "cross_log" | "self";
			kind: number;
			resume: boolean;
			delivery: number;
			awaiting: boolean;
			pick: number;
			parentPick: number;
	  }
	| {
			op: "checkpoint";
			target: "open" | "finished" | "unknown";
			pick: number;
			state: "running" | "cancelling" | null;
			progress: boolean;
	  }
	| { op: "finish"; target: "open" | "finished" | "unknown"; pick: number; outcome: number; result: boolean }
	/** The next entry of the generated base log. */
	| { op: "base" };

const KINDS: readonly WorkKind[] = ["job", "subagent", "subagent", "review", "host_action", "ext:swarm-review/run"];
const DELIVERIES: readonly WorkDelivery[] = ["none", "message", "wake"];
const OUTCOMES: readonly WorkOutcome[] = ["completed", "failed", "cancelled", "interrupted"];
const pick = fc.nat({ max: 1_000 });

const workOpArbitrary: fc.Arbitrary<WorkOp> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record({
			op: fc.constant("start" as const),
			id: fc.constantFrom("fresh", "fresh", "fresh", "fresh", "fresh", "fresh", "fresh", "duplicate", "named"),
			parent: fc.constantFrom("none", "none", "none", "in_log", "in_log", "in_log", "cross_log", "self"),
			kind: fc.nat({ max: KINDS.length - 1 }),
			resume: fc.boolean(),
			delivery: fc.nat({ max: DELIVERIES.length - 1 }),
			awaiting: fc.boolean(),
			pick,
			parentPick: pick,
		}),
	},
	{
		weight: 3,
		arbitrary: fc.record({
			op: fc.constant("checkpoint" as const),
			target: fc.constantFrom("open", "open", "open", "open", "finished", "unknown"),
			pick,
			state: fc.constantFrom("running" as const, "cancelling" as const, null),
			progress: fc.boolean(),
		}),
	},
	{
		weight: 4,
		arbitrary: fc.record({
			op: fc.constant("finish" as const),
			target: fc.constantFrom("open", "open", "open", "open", "open", "finished", "unknown"),
			pick,
			outcome: fc.nat({ max: OUTCOMES.length - 1 }),
			result: fc.boolean(),
		}),
	},
	{ weight: 4, arbitrary: fc.constant({ op: "base" as const }) },
);

/** One step of a generated log: an entry and whether the work lifecycle allows it. */
export interface WorkLogCandidate {
	readonly entry: ConversationLogEntry;
	readonly legal: boolean;
}

export interface WorkLogCase {
	/** Every candidate in order; an illegal one carries the ordinal it would take. */
	readonly candidates: readonly WorkLogCandidate[];
	/** The legal candidates: a well-formed log. */
	readonly entries: readonly ConversationLogEntry[];
	/** The reference machine after the legal entries. */
	readonly model: WorkModel;
}

const NEXT_STATES: Readonly<Record<WorkState, readonly WorkState[]>> = {
	awaiting_approval: ["running", "cancelling"],
	running: ["running", "cancelling"],
	cancelling: ["cancelling"],
};

type WorkEntry = Extract<LogEntry, { type: "work_started" | "work_checkpoint" | "work_finished" }>;

/** The reference state machine of RFC §7.1: legality and the record each legal entry leaves. */
export class WorkModel {
	readonly records = new Map<string, WorkRecord>();
	/** Every id named as a parent so far. */
	readonly parents = new Set<string>();

	get open(): string[] {
		return [...this.records.values()].filter((record) => record.outcome === undefined).map((record) => record.workId);
	}

	get finished(): string[] {
		return [...this.records.values()].filter((record) => record.outcome !== undefined).map((record) => record.workId);
	}

	legal(entry: WorkEntry): boolean {
		if (entry.type === "work_started") {
			const { workId, parentWorkId, kind } = entry.payload;
			return (
				!this.records.has(workId) &&
				!this.parents.has(workId) &&
				parentWorkId !== workId &&
				(parentWorkId === undefined || this.records.has(parentWorkId) || kind === "subagent")
			);
		}
		const record = this.records.get(entry.payload.workId);
		if (record === undefined || record.outcome !== undefined) return false;
		const state = entry.type === "work_checkpoint" ? entry.payload.state : undefined;
		return state === undefined || NEXT_STATES[record.state].includes(state);
	}

	apply(entry: WorkEntry): void {
		const ordinal = entry.ordinal;
		if (entry.type === "work_started") {
			const { state, ...payload } = entry.payload;
			this.records.set(payload.workId, {
				...payload,
				state,
				startedOrdinal: ordinal,
				updatedOrdinal: ordinal,
				checkpoints: 0,
			});
			if (payload.parentWorkId !== undefined) this.parents.add(payload.parentWorkId);
			return;
		}
		const record = this.records.get(entry.payload.workId);
		if (!record) throw new Error("apply needs a legal entry");
		if (entry.type === "work_checkpoint") {
			const { workId: _workId, ...changes } = entry.payload;
			this.records.set(record.workId, {
				...record,
				...changes,
				updatedOrdinal: ordinal,
				checkpoints: record.checkpoints + 1,
			});
			return;
		}
		const { workId: _workId, ...finish } = entry.payload;
		this.records.set(record.workId, { ...record, ...finish, updatedOrdinal: ordinal, finishedOrdinal: ordinal });
	}
}

function choose<T>(values: readonly T[], index: number): T | undefined {
	return values.length === 0 ? undefined : values[index % values.length];
}

/** Interleave work steps with a base log; work entries hang off the current leaf. */
export function buildWorkLog(base: readonly ConversationLogEntry[], ops: readonly WorkOp[]): WorkLogCase {
	const model = new WorkModel();
	const candidates: WorkLogCandidate[] = [];
	const entries: ConversationLogEntry[] = [];
	let baseIndex = 0;
	let leafId: string | null = null;
	let counter = 0;
	const timestamp = (ordinal: number) => new Date(Date.UTC(2026, 0, 1) + ordinal * 1000).toISOString();
	const add = (entry: ConversationLogEntry, legal: boolean) => {
		candidates.push({ entry, legal });
		if (!legal) return;
		entries.push(entry);
		if (entry.type === "leaf") leafId = (entry.payload as { targetId: string | null }).targetId;
		else if (entry.visibility === "public") leafId = entry.id;
	};
	const addWork = (body: Pick<WorkEntry, "type" | "payload">) => {
		const ordinal = entries.length + 1;
		const entry = {
			ordinal,
			id: `work-${++counter}`,
			parentId: leafId,
			timestamp: timestamp(ordinal),
			visibility: "host",
			...body,
		} as WorkEntry;
		const legal = model.legal(entry);
		if (legal) model.apply(entry);
		add(entry, legal);
	};

	for (const op of ops) {
		switch (op.op) {
			case "base": {
				const next = base[baseIndex++];
				if (next) add({ ...next, ordinal: entries.length + 1 } as ConversationLogEntry, true);
				break;
			}
			case "start": {
				const n = ++counter;
				const workId =
					op.id === "fresh"
						? `w${n}`
						: op.id === "duplicate"
							? choose([...model.records.keys()], op.pick)
							: choose(
									[...model.parents].filter((id) => !model.records.has(id)),
									op.pick,
								);
				if (workId === undefined) break;
				const parentWorkId =
					op.parent === "in_log"
						? choose([...model.records.keys()], op.parentPick)
						: op.parent === "cross_log"
							? `x${n}`
							: op.parent === "self"
								? workId
								: undefined;
				const kind = KINDS[op.kind] ?? "job";
				addWork({
					type: "work_started",
					payload: {
						workId,
						kind,
						title: `Work ${n}`,
						...(parentWorkId === undefined ? {} : { parentWorkId }),
						input: { n, args: [kind] },
						cancellable: n % 2 === 0,
						delivery: DELIVERIES[op.delivery] ?? "none",
						resume: op.resume,
						state: op.awaiting ? "awaiting_approval" : "running",
						...(n % 3 === 0 ? { toolCallId: `call-${n}` } : {}),
						...(kind === "subagent" ? { child: { conversation: `child-${n}` } } : {}),
					},
				});
				break;
			}
			case "checkpoint":
			case "finish": {
				const workId =
					op.target === "open"
						? choose(model.open, op.pick)
						: op.target === "finished"
							? choose(model.finished, op.pick)
							: `missing-${++counter}`;
				if (workId === undefined) break;
				if (op.op === "checkpoint") {
					addWork({
						type: "work_checkpoint",
						payload: {
							workId,
							...(op.state === null ? {} : { state: op.state }),
							...(op.progress
								? {
										progress: { text: "step", value: counter % 3, max: 3 },
										detail: { type: "text", text: `detail ${counter}` },
									}
								: {}),
						},
					});
					break;
				}
				const outcome = OUTCOMES[op.outcome] ?? "completed";
				addWork({
					type: "work_finished",
					payload: {
						workId,
						outcome,
						...(op.result ? { result: { summary: "done", output: { text: "tail", truncated: true } } } : {}),
						...(outcome === "failed" ? { error: "exit 1" } : {}),
					},
				});
				break;
			}
		}
	}
	return { candidates, entries, model };
}

/** Generated work logs: work steps, legal and not, interleaved with a well-formed base log. */
export const workLogArbitrary: fc.Arbitrary<WorkLogCase> = fc
	.tuple(logOpsArbitrary, fc.array(workOpArbitrary, { maxLength: 80, size: "medium" }))
	.map(([baseOps, ops]) => buildWorkLog(buildLog(baseOps), ops));
