import { CORE_LOG_ENTRY_TYPES } from "@hansjm10/volt-protocol/entries";
import * as fc from "fast-check";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	apply,
	ConversationFoldError,
	type ConversationState,
	clientInputRecovery,
	fold,
	restore,
	snapshot,
} from "../../src/conversation/fold.ts";
import { type ConversationLogEntry, isCoreLogEntry } from "../../src/conversation/log.ts";
import { buildLog, deepFreeze, type LogOp, logArbitrary } from "./log-generators.ts";

const PROPERTY_SEED = 5_850_102;
const RUNS = { seed: PROPERTY_SEED, numRuns: 200 };

function roundTrip(state: ConversationState): ConversationState {
	return restore(JSON.parse(JSON.stringify(snapshot(state))));
}

function assertStateFrozen(state: ConversationState): void {
	expect(Object.isFrozen(state)).toBe(true);
	expect(Object.isFrozen(state.tree)).toBe(true);
	expect(Object.isFrozen(state.branch)).toBe(true);
	expect(Object.isFrozen(state.context)).toBe(true);
	expect(Object.isFrozen(state.context.messages)).toBe(true);
	expect(Object.isFrozen(state.clientInputs)).toBe(true);
	expect(Object.isFrozen(state.clientInputs.queued)).toBe(true);
	expect(Object.isFrozen(state.clientInputs.started)).toBe(true);
	for (const children of state.tree.children.values()) expect(Object.isFrozen(children)).toBe(true);
}

describe("conversation fold properties", () => {
	it("generates schema-valid core entries", () => {
		fc.assert(
			fc.property(logArbitrary, (entries) => {
				for (const entry of entries) {
					if (!isCoreLogEntry(entry)) continue;
					const definition = CORE_LOG_ENTRY_TYPES[entry.type];
					expect(Value.Check(definition.schema, entry), `${entry.type} ${JSON.stringify(entry)}`).toBe(true);
				}
			}),
			RUNS,
		);
	});

	it("fold is deterministic and does not mutate its inputs", () => {
		fc.assert(
			fc.property(logArbitrary, fc.nat(), (entries, cut) => {
				const split = cut % (entries.length + 1);
				const expected = structuredClone(entries);
				const head = deepFreeze(structuredClone(entries.slice(0, split)));
				const tail = deepFreeze(structuredClone(entries.slice(split)));
				const basis = fold(head);
				const basisCopy = structuredClone(basis);
				const state = fold(tail, basis);
				expect(basis).toEqual(basisCopy);
				expect(fold(entries)).toEqual(fold(expected));
				expect(state).toEqual(fold(expected));
				expect([...head, ...tail]).toEqual(expected);
				assertStateFrozen(state);
			}),
			RUNS,
		);
	});

	it("incremental apply equals batch fold", () => {
		fc.assert(
			fc.property(logArbitrary, (entries) => {
				let state = fold([]);
				for (const entry of entries) {
					const previous = state;
					const previousCopy = structuredClone(previous);
					state = apply(previous, entry);
					expect(previous).toEqual(previousCopy);
				}
				expect(state).toEqual(fold(entries));
			}),
			RUNS,
		);
	});

	it("restore(snapshot(fold(entries[0..N]))) folded with entries[N..] equals fold(entries) for every N", () => {
		fc.assert(
			fc.property(logArbitrary, (entries) => {
				const expected = fold(entries);
				for (let split = 0; split <= entries.length; split++) {
					const restored = roundTrip(fold(entries.slice(0, split)));
					expect(restored).toEqual(fold(entries.slice(0, split)));
					expect(fold(entries.slice(split), restored)).toEqual(expected);
				}
			}),
			{ seed: PROPERTY_SEED, numRuns: 100 },
		);
	});

	it("branchSwitchOrdinal is the newest leaf move or append off the current leaf", () => {
		fc.assert(
			fc.property(logArbitrary, (entries) => {
				let state = fold([]);
				let leafId: string | null = null;
				let expected = 0;
				for (const entry of entries) {
					if (entry.type === "leaf") {
						const { targetId } = entry.payload as { targetId: string | null };
						if (targetId !== leafId) expected = entry.ordinal;
						leafId = targetId;
					} else if (entry.visibility === "public") {
						if (entry.parentId !== leafId) expected = entry.ordinal;
						leafId = entry.id;
					}
					state = apply(state, entry);
					expect(state.branchSwitchOrdinal).toBe(expected);
				}
			}),
			RUNS,
		);
	});
});

describe("conversation fold", () => {
	const ops = (...values: LogOp[]): ConversationLogEntry[] => buildLog(values);

	it("indexes product entries without folding them", () => {
		const entries = ops(
			{ kind: "user", text: "hi", array: false },
			{ kind: "product", visibility: "host" },
			{ kind: "product", visibility: "public" },
		);
		const state = fold(entries);
		expect([...state.tree.byId.keys()]).toEqual(["e1", "e2", "e3"]);
		expect(state.tree.children.get("e1")).toEqual(["e3"]);
		expect(state.leafId).toBe("e3");
		expect(state.branch).toEqual(["e1", "e3"]);
		expect(state.branchOrdinal).toBe(3);
		expect(state.contextOrdinal).toBe(1);
		expect(state.context.messages).toHaveLength(1);
	});

	it("moves the leaf with leaf entries and rebuilds the branch context", () => {
		const entries = ops(
			{ kind: "user", text: "one", array: false },
			{ kind: "thinking", level: "high" },
			{ kind: "user", text: "two", array: false },
			{ kind: "navigate", pick: 1, summary: "left two behind" },
		);
		const state = fold(entries);
		expect(state.leafId).toBe("e5");
		expect(state.branch).toEqual(["e1", "e5"]);
		expect(state.context.thinkingLevel).toBe("off");
		expect(state.context.messages.map((message) => message.role)).toEqual(["user", "branchSummary"]);
		expect(state.tree.children.get("e1")).toEqual(["e2", "e5"]);
		expect(fold(entries.slice(0, 4)).leafId).toBe("e1");
		expect(fold(entries.slice(0, 4)).contextOrdinal).toBe(4);
	});

	it("records labels and the trimmed name", () => {
		const entries = ops(
			{ kind: "user", text: "one", array: false },
			{ kind: "label", pick: 0, label: "start" },
			{ kind: "name", name: " Named " },
			{ kind: "label", pick: 0, label: null },
			{ kind: "label", pick: 1, label: "label" },
		);
		const state = fold(entries);
		expect([...state.labels]).toEqual([["e2", { label: "label", timestamp: entries[4]?.timestamp }]]);
		expect(state.name).toBe("Named");
	});

	it("tracks the durable queue and its recovery", () => {
		const entries = ops(
			{ kind: "receipt", command: "follow_up", behavior: null, text: "later", origin: null },
			{ kind: "receipt", command: "steer", behavior: null, text: "now", origin: null },
			{ kind: "queue", pick: 1, messages: false },
			{ kind: "queue", pick: 0, messages: false },
		);
		let state = fold(entries);
		expect(state.clientInputs.queued).toEqual(["client-2", "client-1"]);
		expect(clientInputRecovery(state)).toMatchObject({ kind: "replay" });
		expect(clientInputRecovery(state).records.map((record) => record.clientMessageId)).toEqual([
			"client-2",
			"client-1",
		]);

		const started = {
			...entries[0]!,
			ordinal: 5,
			id: "e5",
			type: "client_input_state",
			visibility: "host",
			payload: { receiptId: "e1", clientMessageId: "client-1", state: "started" },
		} as ConversationLogEntry;
		state = apply(state, started);
		const recovery = clientInputRecovery(state);
		expect(recovery.kind).toBe("blocked");
		expect(recovery.kind === "blocked" && recovery.blocker.clientMessageId).toBe("client-1");
		expect(state.clientInputs.queued).toEqual(["client-2"]);

		const withdrawn = {
			...started,
			ordinal: 6,
			id: "e6",
			payload: { receiptId: "e2", clientMessageId: "client-2", state: "withdrawn" },
		} as ConversationLogEntry;
		state = apply(state, withdrawn);
		expect(state.clientInputs.queued).toEqual([]);
		expect(state.clientInputs.inputs.get("client-2")?.state).toBe("withdrawn");
	});

	it("advances branchSwitchOrdinal only when the branch switches", () => {
		const entries = ops(
			{ kind: "user", text: "one", array: false },
			{ kind: "assistant", text: "two", toolCalls: 0, stopReason: "stop", model: 0, invalidArguments: false },
			{ kind: "navigate", pick: 1, summary: "left two behind" },
			{ kind: "user", text: "three", array: false },
			{ kind: "fork", pick: 2, text: "off the branch" },
		);
		expect(entries.map((entry) => fold(entries.slice(0, entry.ordinal)).branchSwitchOrdinal)).toEqual([
			0, 0, 3, 3, 3, 6,
		]);
	});

	it("records input origins and accepts queued messages only from host input", () => {
		const entries = ops(
			{ kind: "receipt", command: "steer", behavior: null, text: "host", origin: "host" },
			{ kind: "queue", pick: 0, messages: true },
			{ kind: "receipt", command: "steer", behavior: null, text: "client", origin: null },
		);
		const state = fold(entries);
		expect(state.clientInputs.inputs.get("client-1")).toMatchObject({
			origin: "host",
			queuedInput: { messages: [{ role: "custom", content: "host" }] },
		});
		expect(state.clientInputs.inputs.get("client-2")?.origin).toBeUndefined();
		expect(() =>
			apply(state, {
				...entries[1]!,
				ordinal: 4,
				id: "e4",
				payload: {
					receiptId: "e3",
					clientMessageId: "client-2",
					queuedInput: { delivery: "steer", message: "", images: [], messages: [] },
				},
			} as ConversationLogEntry),
		).toThrow(/only a host input queues messages/);
	});

	it("rejects entries that break the log's invariants", () => {
		const entries = ops(
			{ kind: "user", text: "one", array: false },
			{ kind: "receipt", command: "prompt", behavior: null, text: "x", origin: null },
		);
		const state = fold(entries);
		const base = entries[0]!;
		const reject = (entry: object, message: RegExp) => {
			expect(() => apply(state, { ...base, ordinal: 3, id: "e3", ...entry } as ConversationLogEntry)).toThrow(
				message,
			);
			expect(() => apply(state, { ...base, ordinal: 3, id: "e3", ...entry } as ConversationLogEntry)).toThrow(
				ConversationFoldError,
			);
		};
		reject({ ordinal: 4 }, /expected ordinal 3/);
		reject({ id: "e1" }, /duplicate entry id/);
		reject({ parentId: "missing" }, /unknown parent/);
		reject({ parentId: "e2" }, /parent must be a public entry/);
		reject({ type: "leaf", visibility: "host", payload: { targetId: "e2" } }, /not a conversation entry/);
		reject({ type: "label", payload: { targetId: "missing", label: "x" } }, /not a conversation entry/);
		reject(
			{ type: "compaction", parentId: null, payload: { summary: "", firstKeptEntryId: "e1", tokensBefore: 0 } },
			/not an ancestor/,
		);
		reject(
			{ type: "branch_summary", parentId: "e1", payload: { fromId: "root", summary: "x" } },
			/must be its parent/,
		);
		reject(
			{
				type: "client_input_state",
				visibility: "host",
				payload: { receiptId: "e2", clientMessageId: "client-1", state: "accepted" },
			},
			/cannot move from accepted to accepted/,
		);
		reject(
			{
				type: "client_input_state",
				visibility: "host",
				payload: { receiptId: "e1", clientMessageId: "client-1", state: "started" },
			},
			/no matching client input receipt/,
		);
		reject(
			{
				type: "client_input_queued",
				visibility: "host",
				payload: {
					receiptId: "e2",
					clientMessageId: "client-1",
					queuedInput: { delivery: "steer", message: "x", images: [] },
				},
			},
			/conflicts with the input's command/,
		);
		reject({ clientMessageId: "client-1" }, /requires a started client input/);
		expect(state).toEqual(fold(entries));
	});
});
