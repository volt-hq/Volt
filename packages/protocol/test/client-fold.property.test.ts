import * as fc from "fast-check";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	CLIENT_WORK_FINISHED_MAX,
	ClientFoldError,
	ClientSnapshotSchema,
	type ClientState,
	clientActiveBranch,
	clientAdvance,
	clientFold,
	clientRestore,
	clientSnapshot,
	emptyClientState,
} from "../src/client-fold.ts";
import { type ProjectedEntry, ProjectedEntrySchema } from "../src/projected.ts";
import {
	deepFreeze,
	type ExpectedClientState,
	hidingStream,
	type ProjectedLog,
	projectedLogArbitrary,
	type StreamFrame,
} from "./projected-log.ts";

const PROPERTY_SEED = 6_031_004;
const RUNS = { seed: PROPERTY_SEED, numRuns: 200 };

/** A snapshot as it crosses the wire. */
function wireSnapshot(state: ClientState) {
	return JSON.parse(JSON.stringify(clientSnapshot(state)));
}

function foldFrames(frames: readonly StreamFrame[], initial: ClientState = emptyClientState()): ClientState {
	let state = initial;
	for (const frame of frames) {
		state = "entry" in frame ? clientFold([frame.entry], state) : clientAdvance(state, frame.head);
	}
	return state;
}

function expectMatches(state: ClientState, expected: ExpectedClientState): void {
	expect(state.leafId).toBe(expected.leafId);
	expect({
		model: state.model,
		thinkingLevel: state.thinkingLevel,
		fastMode: state.fastMode,
		planning: state.planning,
	}).toEqual(expected.values);
	expect(state.name).toBe(expected.name);
	expect(clientSnapshot(state).labels).toEqual(expected.labels);
	expect(state.queue).toEqual(expected.queue);
	expect(state.forkedFrom).toEqual(expected.forkedFrom);
	expect([...state.work.values()]).toEqual(expected.work);
}

/** A log and a cut point inside it. */
const logWithCut = projectedLogArbitrary.chain((log) =>
	fc.record({ log: fc.constant(log), cut: fc.nat({ max: log.entries.length }) }),
);

describe("clientFold", () => {
	it("folds a projected log into the leaf, branch values, name, labels, queue, and lineage", () => {
		fc.assert(
			fc.property(projectedLogArbitrary, (log) => {
				for (const entry of log.entries) expect(Check(ProjectedEntrySchema, entry), entry.type).toBe(true);
				const state = clientFold(log.entries);
				expect(state.ordinal).toBe(log.entries.length);
				expect(state.entries).toEqual(log.entries);
				expectMatches(state, log.expected);
				const branch = clientActiveBranch(state);
				expect(branch.at(-1)?.id ?? null).toBe(log.expected.leafId);
			}),
			RUNS,
		);
	});

	it("is deterministic, pure, and independent of how entries are batched", () => {
		fc.assert(
			fc.property(
				projectedLogArbitrary,
				fc.array(fc.nat({ max: 60 }), { maxLength: 8 }),
				(log: ProjectedLog, cuts: number[]) => {
					const entries = deepFreeze(structuredClone(log.entries) as ProjectedEntry[]);
					const once = clientFold(entries);
					expect(clientFold(entries)).toEqual(once);
					const bounds = [...new Set(cuts.map((cut) => cut % (entries.length + 1)))].sort((a, b) => a - b);
					let state = emptyClientState();
					let start = 0;
					for (const bound of [...bounds, entries.length]) {
						const before = structuredClone(clientSnapshot(state));
						const next = clientFold(entries.slice(start, bound), state);
						expect(clientSnapshot(state)).toEqual(before);
						state = next;
						start = bound;
					}
					expect(state).toEqual(once);
				},
			),
			RUNS,
		);
	});

	it("round-trips a snapshot through the wire", () => {
		fc.assert(
			fc.property(logWithCut, ({ log, cut }) => {
				const state = clientFold(log.entries.slice(0, cut));
				const snapshot = wireSnapshot(state);
				expect(Check(ClientSnapshotSchema, snapshot)).toBe(true);
				expect(clientRestore(state.ordinal, snapshot)).toEqual(state);
			}),
			RUNS,
		);
	});

	it("restores a snapshot at N and folds the entries after N into the fold of every entry", () => {
		fc.assert(
			fc.property(logWithCut, ({ log, cut }) => {
				const head = clientFold(log.entries.slice(0, cut));
				const resumed = clientFold(log.entries.slice(cut), clientRestore(head.ordinal, wireSnapshot(head)));
				expect(resumed).toEqual(clientFold(log.entries));
			}),
			RUNS,
		);
	});

	it("tracks the position over hidden entries, and resuming anywhere equals an uninterrupted stream", () => {
		fc.assert(
			fc.property(
				projectedLogArbitrary.chain((log) => {
					const stream = hidingStream(log);
					return fc.record({
						log: fc.constant(log),
						stream: fc.constant(stream),
						cut: fc.nat({ max: stream.frames.length }),
					});
				}),
				({ log, stream, cut }) => {
					const uninterrupted = foldFrames(stream.frames);
					expect(uninterrupted.ordinal).toBe(log.entries.length);
					expectMatches(uninterrupted, { ...log.expected, leafId: stream.leafId, labels: stream.labels });

					// Disconnect after `cut` frames, then resume after the position P from a snapshot.
					const before = foldFrames(stream.frames.slice(0, cut));
					const position = before.ordinal;
					const after = stream.frames.filter((frame) =>
						"entry" in frame ? frame.entry.ordinal > position : frame.head > position,
					);
					expect(foldFrames(after, clientRestore(position, wireSnapshot(before)))).toEqual(uninterrupted);
					expect(foldFrames(after, before)).toEqual(uninterrupted);
				},
			),
			RUNS,
		);
	});
});

describe("clientFold work", () => {
	const at = (ordinal: number) => new Date(Date.UTC(2026, 0, 1) + ordinal * 1000).toISOString();
	const started = (ordinal: number, workId: string): ProjectedEntry => ({
		ordinal,
		id: `e${ordinal}`,
		parentId: null,
		type: "work_started",
		timestamp: at(ordinal),
		payload: {
			workId,
			kind: "job",
			title: workId,
			input: { command: "true" },
			cancellable: true,
			delivery: "wake",
			resume: false,
			state: "running",
		},
	});
	const finished = (ordinal: number, workId: string): ProjectedEntry => ({
		ordinal,
		id: `e${ordinal}`,
		parentId: null,
		type: "work_finished",
		timestamp: at(ordinal),
		payload: { workId, outcome: "completed", result: { output: { text: "x".repeat(1_000), truncated: false } } },
	});

	it("keeps open work and the newest finished items, and restores them from a snapshot", () => {
		const entries: ProjectedEntry[] = [started(1, "open")];
		const count = CLIENT_WORK_FINISHED_MAX + 6;
		for (let index = 0; index < count; index++) entries.push(started(entries.length + 1, `job-${index}`));
		// Finish in reverse start order: the oldest finished are the newest started.
		for (let index = count - 1; index >= 0; index--) entries.push(finished(entries.length + 1, `job-${index}`));
		const state = clientFold(entries);
		const kept = [...state.work.keys()];
		expect(kept).toHaveLength(CLIENT_WORK_FINISHED_MAX + 1);
		expect(kept[0]).toBe("open");
		expect(kept.slice(1)).toEqual(Array.from({ length: CLIENT_WORK_FINISHED_MAX }, (_, index) => `job-${index}`));
		expect(state.work.get("job-0")).toMatchObject({ outcome: "completed", result: { output: { truncated: false } } });
		const snapshot = wireSnapshot(state);
		expect(Check(ClientSnapshotSchema, snapshot)).toBe(true);
		expect(clientRestore(state.ordinal, snapshot)).toEqual(state);
	});

	it("ignores work it never saw, payloads a profile hid, and changes to finished work", () => {
		const base = clientFold([started(1, "a"), finished(2, "a")]);
		const next = clientFold(
			[
				started(3, "a"),
				{
					ordinal: 4,
					id: "e4",
					parentId: null,
					type: "work_checkpoint",
					timestamp: at(4),
					payload: { workId: "a" },
				},
				{
					ordinal: 5,
					id: "e5",
					parentId: null,
					type: "work_checkpoint",
					timestamp: at(5),
					payload: { workId: "zz" },
				},
				finished(6, "zz"),
				{ ordinal: 7, id: "e7", parentId: null, type: "work_started", timestamp: at(7) },
			],
			base,
		);
		expect(next.work).toBe(base.work);
		expect(clientSnapshot(clientFold([])).work).toBeUndefined();
	});
});

describe("clientFold edge cases", () => {
	const entry = (ordinal: number, id: string, parentId: string | null): ProjectedEntry => ({
		ordinal,
		id,
		parentId,
		type: "session_info",
		timestamp: "2026-01-01T00:00:00.000Z",
		payload: { name: id },
	});

	it("rejects ordinals that do not increase, duplicate ids, and positions that move back", () => {
		const state = clientFold([entry(2, "a", null)]);
		expect(() => clientFold([entry(2, "b", "a")], state)).toThrow(ClientFoldError);
		expect(() => clientFold([entry(3, "a", null)], state)).toThrow(ClientFoldError);
		expect(() => clientAdvance(state, 1)).toThrow(ClientFoldError);
		expect(clientAdvance(state, 2)).toBe(state);
		expect(clientAdvance(state, 5).ordinal).toBe(5);
		expect(() => clientRestore(1, clientSnapshot(state))).toThrow(ClientFoldError);
	});

	it("keeps a bounded snapshot's values for the history it stands in for", () => {
		const model = { provider: "anthropic", modelId: "claude-a" };
		const tail: ProjectedEntry = {
			ordinal: 40,
			id: "e40",
			parentId: "e39",
			type: "message",
			timestamp: "2026-01-01T00:00:40.000Z",
			view: { role: "user", text: "hi", truncated: false },
		};
		const restored = clientRestore(41, {
			leafId: "e40",
			entries: [tail],
			earlier: true,
			model,
			thinkingLevel: "high",
			fastMode: true,
			planning: null,
			name: "Named",
			labels: [],
			queue: [],
		});
		// Moving back to the leaf the client holds re-derives from the snapshot's values.
		const moved = clientFold(
			[
				{
					ordinal: 42,
					id: "e42",
					parentId: "e40",
					type: "leaf",
					timestamp: "2026-01-01T00:00:42.000Z",
					payload: { targetId: null },
				},
				{
					ordinal: 43,
					id: "e43",
					parentId: "e40",
					type: "leaf",
					timestamp: "2026-01-01T00:00:43.000Z",
					payload: { targetId: "e40" },
				},
			],
			restored,
		);
		expect(moved.leafId).toBe("e40");
		expect({ model: moved.model, thinkingLevel: moved.thinkingLevel, fastMode: moved.fastMode }).toEqual({
			model,
			thinkingLevel: "high",
			fastMode: true,
		});
		expect(clientSnapshot(moved).earlier).toBe(true);
	});
});
