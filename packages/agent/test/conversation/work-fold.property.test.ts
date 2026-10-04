import { CORE_LOG_ENTRY_TYPES } from "@hansjm10/volt-protocol/entries";
import * as fc from "fast-check";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	apply,
	ConversationFoldError,
	type ConversationState,
	fold,
	restore,
	snapshot,
} from "../../src/conversation/fold.ts";
import { isCoreLogEntry } from "../../src/conversation/log.ts";
import { deepFreeze } from "./log-generators.ts";
import { workLogArbitrary } from "./work-log.ts";

const PROPERTY_SEED = 6_040_201;
const RUNS = { seed: PROPERTY_SEED, numRuns: 200 };

function roundTrip(state: ConversationState): ConversationState {
	return restore(JSON.parse(JSON.stringify(snapshot(state))));
}

describe("work fold properties", () => {
	it("accepts a work entry iff the lifecycle allows it and keeps the reference machine's records", () => {
		fc.assert(
			fc.property(workLogArbitrary, ({ candidates, model }) => {
				let state = fold([]);
				for (const { entry, legal } of candidates) {
					if (isCoreLogEntry(entry)) {
						expect(Check(CORE_LOG_ENTRY_TYPES[entry.type].schema, entry), JSON.stringify(entry)).toBe(true);
					}
					if (legal) {
						state = apply(state, entry);
					} else {
						expect(() => apply(state, entry), JSON.stringify(entry)).toThrow(ConversationFoldError);
					}
				}
				expect([...state.work.values()]).toEqual([...model.records.values()]);
				expect(state.openWork).toEqual(model.open);
				expect(Object.isFrozen(state.openWork)).toBe(true);
				for (const record of state.work.values()) expect(Object.isFrozen(record)).toBe(true);
			}),
			RUNS,
		);
	});

	it("is deterministic, and batch, incremental, and restore(snapshot(N)) plus the tail agree", () => {
		fc.assert(
			fc.property(workLogArbitrary, ({ entries }) => {
				const frozen = deepFreeze(structuredClone([...entries]));
				const batch = fold(frozen);
				expect(fold(frozen)).toEqual(batch);
				let incremental = fold([]);
				for (const entry of frozen) incremental = apply(incremental, entry);
				expect(incremental).toEqual(batch);
				for (let split = 0; split <= frozen.length; split++) {
					const head = fold(frozen.slice(0, split));
					const restored = roundTrip(head);
					expect(restored.work).toEqual(head.work);
					expect(restored.openWork).toEqual(head.openWork);
					expect(fold(frozen.slice(split), restored)).toEqual(batch);
				}
			}),
			{ seed: PROPERTY_SEED, numRuns: 100 },
		);
	});

	it("never changes a finished record", () => {
		fc.assert(
			fc.property(workLogArbitrary, ({ entries }) => {
				const finished = new Map<string, unknown>();
				let state = fold([]);
				for (const entry of entries) {
					state = apply(state, entry);
					for (const [workId, record] of finished) expect(state.work.get(workId)).toBe(record);
					for (const record of state.work.values()) {
						if (record.outcome !== undefined && !finished.has(record.workId)) finished.set(record.workId, record);
					}
				}
			}),
			RUNS,
		);
	});
});
