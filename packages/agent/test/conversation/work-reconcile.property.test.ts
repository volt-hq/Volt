import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ConversationState, fold, restore, snapshot } from "../../src/conversation/fold.ts";
import { InMemoryConversationLog } from "../../src/conversation/in-memory-log.ts";
import type { ConversationLogEntry } from "../../src/conversation/log.ts";
import { workReconciliation } from "../../src/conversation/work.ts";
import { openConversation, readLog } from "./conversation-test-utils.ts";
import { workLogArbitrary } from "./work-log.ts";

const PROPERTY_SEED = 6_040_202;
const RUNS = { seed: PROPERTY_SEED, numRuns: 200 };

/** The open work a restart interrupts, as a fixpoint: no resume, or an in-log parent that ended or is interrupted. */
function referenceInterrupt(state: ConversationState): Set<string> {
	const interrupt = new Set<string>();
	for (let changed = true; changed; ) {
		changed = false;
		for (const workId of state.openWork) {
			if (interrupt.has(workId)) continue;
			const record = state.work.get(workId);
			const parent = record?.parentWorkId === undefined ? undefined : state.work.get(record.parentWorkId);
			if (!record?.resume || (parent && (parent.outcome !== undefined || interrupt.has(parent.workId)))) {
				interrupt.add(workId);
				changed = true;
			}
		}
	}
	return interrupt;
}

/** The batch a reconciliation appends, folded onto `state`. */
function interruptAll(state: ConversationState, workIds: readonly string[]): ConversationState {
	const entries = workIds.map(
		(workId, index): ConversationLogEntry => ({
			ordinal: state.ordinal + index + 1,
			id: `interrupt-${workId}`,
			parentId: state.leafId,
			timestamp: "2026-06-01T00:00:00.000Z",
			visibility: "host",
			type: "work_finished",
			payload: { workId, outcome: "interrupted" },
		}),
	);
	return fold(entries, state);
}

async function logOf(entries: readonly ConversationLogEntry[]): Promise<InMemoryConversationLog> {
	const log = new InMemoryConversationLog("reconcile");
	if (entries.length > 0) {
		const drafts = entries.map(({ ordinal: _ordinal, ...draft }) => draft);
		await log.append({ expectedOrdinal: 0, commitId: "seed", entries: drafts });
	}
	return log;
}

describe("work reconciliation properties", () => {
	it("interrupts exactly the reference set, in start order, and suspends the rest", () => {
		fc.assert(
			fc.property(workLogArbitrary, ({ entries }) => {
				const state = fold(entries);
				const reconciliation = workReconciliation(state);
				const expected = referenceInterrupt(state);
				expect(reconciliation.interrupt).toEqual(state.openWork.filter((workId) => expected.has(workId)));
				expect(reconciliation.suspended).toEqual(state.openWork.filter((workId) => !expected.has(workId)));
				// Finished work is untouched: only open work is interrupted.
				for (const workId of reconciliation.interrupt) expect(state.work.get(workId)?.outcome).toBeUndefined();
			}),
			RUNS,
		);
	});

	it("leaves no open non-resumable work and no suspended child of a closed in-log parent, and is idempotent", () => {
		fc.assert(
			fc.property(workLogArbitrary, ({ entries }) => {
				const state = fold(entries);
				const reconciliation = workReconciliation(state);
				const after = interruptAll(state, reconciliation.interrupt);
				for (const workId of after.openWork) {
					const record = after.work.get(workId);
					expect(record?.resume).toBe(true);
					const parent = record?.parentWorkId === undefined ? undefined : after.work.get(record.parentWorkId);
					if (parent) expect(parent.outcome).toBeUndefined();
				}
				for (const workId of reconciliation.interrupt) {
					expect(after.work.get(workId)).toMatchObject({ outcome: "interrupted" });
				}
				for (const [workId, record] of state.work) {
					if (record.outcome !== undefined) expect(after.work.get(workId)).toBe(record);
				}
				const again = workReconciliation(after);
				expect(again.interrupt).toEqual([]);
				expect(again.suspended).toEqual(reconciliation.suspended);
			}),
			RUNS,
		);
	});

	it("commutes with snapshot and restore", () => {
		fc.assert(
			fc.property(workLogArbitrary, fc.nat(), ({ entries }, cut) => {
				const split = cut % (entries.length + 1);
				const restored = restore(JSON.parse(JSON.stringify(snapshot(fold(entries.slice(0, split))))));
				const resumed = fold(entries.slice(split), restored);
				expect(workReconciliation(resumed)).toEqual(workReconciliation(fold(entries)));
			}),
			RUNS,
		);
	});

	it("reconciles a reopened log once, in one batch, before any work starts", async () => {
		await fc.assert(
			fc.asyncProperty(workLogArbitrary, async ({ entries }) => {
				const expected = workReconciliation(fold(entries));
				const { conversation, log, events } = await openConversation({
					log: await logOf(entries),
					withModel: false,
				});
				await expect(
					conversation.work.start({
						kind: "job",
						title: "too early",
						input: null,
						cancellable: true,
						delivery: "none",
						resume: false,
					}),
				).rejects.toMatchObject({ code: "invalid_state" });

				const reconciliation = await conversation.work.reconcile();
				expect(reconciliation).toEqual(expected);
				const batches = events.flatMap((event) => (event.type === "committed" ? [event.entries] : []));
				expect(batches).toHaveLength(expected.interrupt.length === 0 ? 0 : 1);
				expect(batches[0]?.map((entry) => entry.payload) ?? []).toEqual(
					expected.interrupt.map((workId) => ({ workId, outcome: "interrupted" })),
				);
				expect(await conversation.work.reconcile()).toEqual(reconciliation);
				expect(events.filter((event) => event.type === "committed")).toHaveLength(batches.length);

				const started = await conversation.work.start({
					workId: "after-reconcile",
					kind: "job",
					title: "now",
					input: null,
					cancellable: true,
					delivery: "none",
					resume: false,
				});
				expect(started.state).toBe("running");
				expect(conversation.state).toEqual(fold(await readLog(log)));
				await conversation.close();
			}),
			{ seed: PROPERTY_SEED, numRuns: 50 },
		);
	});
});
