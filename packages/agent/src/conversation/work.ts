/**
 * Work in the fold (RFC §7.1): the record each `work_*` entry produces, the
 * lifecycle the fold enforces, and the reconciliation a new runtime runs over
 * the open work a previous runtime left behind.
 *
 * Lifecycle: a work id starts once and is never named as a parent before it
 * starts; a parent is an earlier item of the same log, except that a
 * subagent's parent may live in its parent conversation's log. A checkpoint
 * or finish names open work. Checkpoints move the state forward only:
 * `awaiting_approval` to `running` or `cancelling`, `running` to `cancelling`,
 * never back. A finished record never changes.
 */

import type { JsonValue } from "@hansjm10/volt-ai";
import type { LogEntry, WorkCheckpointEntryPayload, WorkChild, WorkResult } from "@hansjm10/volt-protocol/entries";
import type { RemoteCapability } from "@hansjm10/volt-protocol/remote-access";
import type { WorkDelivery, WorkKind, WorkOutcome, WorkProgress, WorkState } from "@hansjm10/volt-protocol/work";
import type { ConversationState } from "./fold.ts";

/** One work item as its entries describe it. */
export interface WorkRecord {
	readonly workId: string;
	readonly kind: WorkKind;
	readonly title: string;
	readonly parentWorkId?: string;
	readonly input: JsonValue;
	readonly cancellable: boolean;
	readonly delivery: WorkDelivery;
	readonly resume: boolean;
	readonly toolCallId?: string;
	/** The conversation the work runs in: the one it started with, or the latest checkpoint's (a review's pass). */
	readonly child?: WorkChild;
	/** Remote capabilities a client needs to act on the work, as its kind declared when it started. */
	readonly requires?: readonly RemoteCapability[];
	/** Whether a paired remote device may cancel or resume the work, as its kind declared when it started. */
	readonly remote?: { readonly cancel: boolean; readonly resume: boolean };
	/** The latest open state; kept when the work finishes. */
	readonly state: WorkState;
	/** Present once the work finished. */
	readonly outcome?: WorkOutcome;
	/** The latest checkpoint's progress and detail. */
	readonly progress?: WorkProgress;
	readonly detail?: NonNullable<WorkCheckpointEntryPayload["detail"]>;
	readonly result?: WorkResult;
	readonly error?: string;
	readonly startedOrdinal: number;
	/** The newest entry that changed the record. */
	readonly updatedOrdinal: number;
	readonly finishedOrdinal?: number;
	/** How many checkpoints the item recorded: a host bounds them over the item's lifetime. */
	readonly checkpoints: number;
}

export type WorkLogEntry = Extract<LogEntry, { type: "work_started" | "work_checkpoint" | "work_finished" }>;

export function isWorkLogEntry(entry: LogEntry): entry is WorkLogEntry {
	return entry.type === "work_started" || entry.type === "work_checkpoint" || entry.type === "work_finished";
}

/** The states a checkpoint may set from each open state. */
const CHECKPOINT_STATES: Readonly<Record<WorkState, readonly WorkState[]>> = {
	awaiting_approval: ["running", "cancelling"],
	running: ["running", "cancelling"],
	cancelling: ["cancelling"],
};

/**
 * The record `entry` produces over `records`, checked against the lifecycle.
 * `parents` returns every parent id the records name. `fail` reports a
 * violation and throws.
 */
export function reduceWork(
	records: ReadonlyMap<string, WorkRecord>,
	parents: () => ReadonlySet<string>,
	entry: WorkLogEntry,
	fail: (message: string) => never,
): WorkRecord {
	if (entry.type === "work_started") {
		const payload = entry.payload;
		if (records.has(payload.workId)) fail(`duplicate work id ${JSON.stringify(payload.workId)}`);
		if (parents().has(payload.workId)) fail("work started after it was named as a parent");
		const parentWorkId = payload.parentWorkId;
		if (parentWorkId === payload.workId) fail("work cannot be its own parent");
		if (parentWorkId !== undefined && !records.has(parentWorkId) && payload.kind !== "subagent") {
			fail(`unknown parent work ${JSON.stringify(parentWorkId)}`);
		}
		return Object.freeze({
			workId: payload.workId,
			kind: payload.kind,
			title: payload.title,
			...(parentWorkId === undefined ? {} : { parentWorkId }),
			input: payload.input,
			cancellable: payload.cancellable,
			delivery: payload.delivery,
			resume: payload.resume,
			...(payload.toolCallId === undefined ? {} : { toolCallId: payload.toolCallId }),
			...(payload.child === undefined ? {} : { child: payload.child }),
			...(payload.requires === undefined ? {} : { requires: payload.requires }),
			...(payload.remote === undefined ? {} : { remote: payload.remote }),
			state: payload.state,
			startedOrdinal: entry.ordinal,
			updatedOrdinal: entry.ordinal,
			checkpoints: 0,
		});
	}
	const record = records.get(entry.payload.workId);
	if (!record) return fail(`unknown work ${JSON.stringify(entry.payload.workId)}`);
	if (record.outcome !== undefined) fail(`work ${JSON.stringify(record.workId)} already finished`);
	if (entry.type === "work_checkpoint") {
		const { state, progress, detail, child } = entry.payload;
		if (state !== undefined && !CHECKPOINT_STATES[record.state].includes(state)) {
			fail(`work cannot move from ${record.state} to ${state}`);
		}
		return Object.freeze({
			...record,
			...(state === undefined ? {} : { state }),
			...(progress === undefined ? {} : { progress }),
			...(detail === undefined ? {} : { detail }),
			...(child === undefined ? {} : { child }),
			updatedOrdinal: entry.ordinal,
			checkpoints: record.checkpoints + 1,
		});
	}
	const { outcome, result, error } = entry.payload;
	return Object.freeze({
		...record,
		outcome,
		...(result === undefined ? {} : { result }),
		...(error === undefined ? {} : { error }),
		updatedOrdinal: entry.ordinal,
		finishedOrdinal: entry.ordinal,
	});
}

/** What a new runtime does with the open work in its log. */
export interface WorkReconciliation {
	/**
	 * Open work to finish as `interrupted`, in start order: every item of a
	 * kind that does not resume, and resumable items whose in-log parent is
	 * finished or interrupted with them.
	 */
	readonly interrupt: readonly string[];
	/** Resumable open work that stays open without an executor until it is resumed or cancelled. */
	readonly suspended: readonly string[];
}

/** The reconciliation of `state`'s open work. Pure; it finishes nothing itself. */
export function workReconciliation(state: Pick<ConversationState, "work" | "openWork">): WorkReconciliation {
	const interrupt: string[] = [];
	const interrupted = new Set<string>();
	const suspended: string[] = [];
	// In-log parents start earlier, so each parent is decided before its children.
	for (const workId of state.openWork) {
		const record = state.work.get(workId);
		if (!record) continue;
		const parent = record.parentWorkId === undefined ? undefined : state.work.get(record.parentWorkId);
		const parentEnds = parent !== undefined && (parent.outcome !== undefined || interrupted.has(parent.workId));
		if (!record.resume || parentEnds) {
			interrupt.push(workId);
			interrupted.add(workId);
		} else {
			suspended.push(workId);
		}
	}
	return Object.freeze({ interrupt: Object.freeze(interrupt), suspended: Object.freeze(suspended) });
}
