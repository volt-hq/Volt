import { describe, expect, test } from "vitest";
import {
	compactionHeadline,
	compactionNote,
	readCompactionOutcome,
} from "../src/modes/interactive/compaction-outcome.ts";

const n = (value: number): string => value.toLocaleString();

/** A request record with the fields the outcome reads. */
function request(startedAt: number, durationMs: number, extra: Record<string, unknown> = {}) {
	return { strategy: "chunked", stopReason: "stop", startedAt, durationMs, ...extra };
}

describe("compaction outcome", () => {
	test("reports the size after, the time taken, and the parts of a long conversation", () => {
		const durations = [42_587, 50_843, 30_925, 42_697, 47_256, 35_595, 46_762, 18_829];
		let startedAt = 1_000;
		const requests = durations.map((durationMs, index) => {
			const record = request(startedAt, durationMs, index === 1 || index === 4 ? { rejected: "oversized" } : {});
			startedAt += durationMs;
			return record;
		});
		const outcome = readCompactionOutcome({ tokensAfter: 41_230, strategyReason: "preflight_overflow", requests });

		expect(outcome).toEqual({ tokensAfter: 41_230, durationMs: 315_494, parts: 6 });
		expect(compactionHeadline(265_707, outcome)).toBe(
			`Compacted from ${n(265_707)} to ~${n(41_230)} tokens in 5m 15s`,
		);
		expect(compactionNote(outcome)).toBe(
			"The conversation was too long to summarize at once, so it was summarized in 6 parts.",
		);
	});

	test("does not explain a compaction that summarized in one pass", () => {
		const native = readCompactionOutcome({
			tokensAfter: 30_000,
			strategyReason: "native",
			requests: [request(0, 48_200, { strategy: "native" })],
		});
		expect(compactionHeadline(250_000, native)).toBe(`Compacted from ${n(250_000)} to ~${n(30_000)} tokens in 48s`);
		expect(compactionNote(native)).toBeUndefined();
		// A fallback that needed only one part took no longer route worth explaining.
		const single = readCompactionOutcome({ strategyReason: "provider_overflow", requests: [request(0, 2_000)] });
		expect(compactionNote(single)).toBeUndefined();
	});

	test("counts only accepted fallback summaries as parts", () => {
		const outcome = readCompactionOutcome({
			strategyReason: "provider_overflow",
			requests: [
				request(0, 1_000, { strategy: "native", stopReason: "error" }),
				request(1_000, 1_000),
				request(2_000, 1_000, { stopReason: undefined, rejected: "oversized" }),
				request(3_000, 1_000, { stopReason: "stop", rejected: "oversized" }),
				request(4_000, 1_000),
			],
		});
		expect(outcome.parts).toBe(2);
	});

	test("falls back to the size before when details record nothing usable", () => {
		for (const details of [undefined, null, "details", [], {}, { requests: "x" }]) {
			expect(compactionHeadline(1_234, readCompactionOutcome(details))).toBe(`Compacted from ${n(1_234)} tokens`);
		}
		expect(
			readCompactionOutcome({
				tokensAfter: -1,
				strategyReason: "toString",
				requests: [request(0, 5_000), request(5_000, 5_000)],
			}),
		).toEqual({ durationMs: 10_000 });
		expect(readCompactionOutcome({ tokensAfter: 1.5 })).toEqual({});
		expect(readCompactionOutcome({ tokensAfter: Number.MAX_SAFE_INTEGER + 1 })).toEqual({});
	});

	test("states no time unless every request was timed and it took at least a second", () => {
		expect(readCompactionOutcome({ requests: [request(0, 5_000), request(5_000, -1)] })).toEqual({});
		expect(readCompactionOutcome({ requests: [request(0, 5_000), null] })).toEqual({});
		expect(readCompactionOutcome({ requests: [request(0, 999)] })).toEqual({});
		expect(readCompactionOutcome({ requests: [request(Number.MAX_SAFE_INTEGER, 5_000)] })).toEqual({});
	});
});
