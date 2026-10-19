import { describe, expect, test } from "vitest";
import { formatCompactionUsage } from "../src/modes/interactive/compaction-usage.ts";

const n = (value: number): string => value.toLocaleString();

const request = {
	strategy: "native",
	purpose: "native",
	attempt: 1,
	provider: "test-provider",
	model: "test-model",
	startedAt: 1_000,
	durationMs: 48_200,
	targetChars: 9_830,
	maxChars: 16_384,
	textChars: 9_000,
	stopReason: "stop",
	usage: { input: 1000, output: 30000, cacheRead: 68000, cacheWrite: 1000, totalTokens: 100000 },
};

/** One request line of a single-record report. */
function requestLine(record: unknown): string | undefined {
	return formatCompactionUsage({ requests: [record] }, 0)?.requests[0];
}

describe("formatCompactionUsage", () => {
	test("summarizes a chunked compaction and lists oversized candidates and their retries", () => {
		const usage = (input: number, cacheRead: number, output: number) => ({
			input,
			output,
			cacheRead,
			cacheWrite: 0,
			totalTokens: input + cacheRead + output,
		});
		const records = [
			{ purpose: "history", durationMs: 42_587, maxChars: 12_288, textChars: 9_723, usage: usage(14_494, 0, 2075) },
			{ purpose: "history", durationMs: 50_843, maxChars: 12_288, textChars: 12_296, rejected: "oversized" },
			{
				purpose: "history",
				durationMs: 30_925,
				maxChars: 12_288,
				textChars: 7_838,
				usage: usage(189, 17_792, 1577),
			},
			{ purpose: "history", durationMs: 42_697, maxChars: 12_288, textChars: 11_638, usage: usage(16_034, 0, 2373) },
			{ purpose: "history", durationMs: 47_256, maxChars: 12_288, textChars: 12_289, rejected: "oversized" },
			{
				purpose: "history",
				durationMs: 35_595,
				maxChars: 12_288,
				textChars: 7_333,
				usage: usage(218, 17_536, 1615),
			},
			{ purpose: "history", durationMs: 46_762, maxChars: 12_288, textChars: 11_094, usage: usage(10_714, 0, 2425) },
			{
				purpose: "turn_prefix",
				durationMs: 18_829,
				maxChars: 4_096,
				textChars: 3_929,
				usage: usage(11_589, 0, 870),
			},
		];
		let startedAt = 1_000;
		const requests = records.map((record, index) => {
			const dispatched = {
				strategy: "chunked",
				attempt: index + 1,
				provider: "openai-codex",
				model: "gpt-6-astra",
				startedAt,
				...(record.rejected ? {} : { stopReason: "stop" }),
				...record,
			};
			startedAt += record.durationMs;
			return dispatched;
		});

		expect(formatCompactionUsage({ requests, strategyReason: "preflight_overflow" }, 19_242)).toEqual({
			summary: `Chunked compaction (too large for one request) · 8 requests (2 oversized) · 5m 15s · ${n(88_566)} prompt tokens, 39.9% cached, 2 requests without usage · checkpoint ${n(19_242)} chars`,
			requests: [
				`1. history · ${n(9_723)} chars · 42.5s · ${n(14_494)} prompt tokens`,
				`2. history · oversized (${n(12_296)} of ${n(12_288)} chars) · 50.8s · usage unavailable`,
				`3. history retry · ${n(7_838)} chars · 30.9s · ${n(17_981)} prompt tokens, 98.9% cached`,
				`4. history · ${n(11_638)} chars · 42.6s · ${n(16_034)} prompt tokens`,
				`5. history · oversized (${n(12_289)} of ${n(12_288)} chars) · 47.2s · usage unavailable`,
				`6. history retry · ${n(7_333)} chars · 35.5s · ${n(17_754)} prompt tokens, 98.8% cached`,
				`7. history · ${n(11_094)} chars · 46.7s · ${n(10_714)} prompt tokens`,
				`8. turn prefix · ${n(3_929)} chars · 18.8s · ${n(11_589)} prompt tokens`,
			],
		});
	});

	test("shows the cached share of a native request, counting cache writes and not output", () => {
		expect(formatCompactionUsage({ requests: [request], strategyReason: "native" }, 12_000)).toEqual({
			summary: `Native compaction · 1 request · 48.2s · ${n(70_000)} prompt tokens, 97.1% cached · checkpoint ${n(12_000)} chars`,
			requests: [`1. native · ${n(9_000)} chars · 48.2s · ${n(70_000)} prompt tokens, 97.1% cached`],
		});
	});

	test("names a provider overflow and does not count the chunked fallback as a retry", () => {
		const report = formatCompactionUsage(
			{
				strategyReason: "provider_overflow",
				requests: [
					{ ...request, stopReason: "error", textChars: undefined, usage: undefined },
					{ ...request, strategy: "chunked", purpose: "history", attempt: 2, startedAt: 60_000 },
				],
			},
			0,
		);
		expect(report).toEqual({
			summary: `Chunked compaction (provider rejected one request as too large) · 2 requests (1 failed) · 1m 47s · ${n(70_000)} prompt tokens, 97.1% cached, 1 request without usage`,
			requests: [
				"1. native · error · 48.2s · usage unavailable",
				`2. history · ${n(9_000)} chars · 48.2s · ${n(70_000)} prompt tokens`,
			],
		});
	});

	test("labels a request after a failed one for the same checkpoint as a retry", () => {
		const report = formatCompactionUsage(
			{
				requests: [
					{ ...request, stopReason: "error", usage: undefined },
					{ ...request, attempt: 2 },
				],
			},
			0,
		);
		expect(report?.requests[1]).toBe(
			`2. native retry · ${n(9_000)} chars · 48.2s · ${n(70_000)} prompt tokens, 97.1% cached`,
		);
	});

	test("takes the strategy from the last request when no valid reason is recorded", () => {
		for (const strategyReason of [undefined, "other", 1, "toString"]) {
			const report = formatCompactionUsage(
				{ strategyReason, requests: [{ ...request, strategy: "chunked", purpose: "history" }] },
				0,
			);
			expect(report?.summary).toBe(
				`Chunked compaction · 1 request · 48.2s · ${n(70_000)} prompt tokens, 97.1% cached`,
			);
		}
	});

	test.each([
		[undefined, "no response"],
		["length", "output limit"],
		["toolUse", "tool call"],
		["error", "error"],
		["aborted", "aborted"],
	])("describes a %s terminal reason without a candidate as %s", (stopReason, outcome) => {
		expect(requestLine({ ...request, stopReason, usage: undefined })).toBe(
			`1. native · ${outcome} · 48.2s · usage unavailable`,
		);
	});

	test("omits unusable optional fields instead of reporting fabricated values", () => {
		const report = formatCompactionUsage(
			{
				requests: [
					{
						...request,
						purpose: "unknown",
						durationMs: -1,
						textChars: "9000",
						rejected: "maybe",
					},
				],
			},
			0,
		);
		expect(report).toEqual({
			summary: `Native compaction · 1 request · ${n(70_000)} prompt tokens, 97.1% cached`,
			requests: [`1. native · completed · ${n(70_000)} prompt tokens, 97.1% cached`],
		});
		expect(requestLine({ ...request, rejected: "oversized", maxChars: undefined, usage: undefined })).toBe(
			"1. native · oversized · 48.2s · usage unavailable",
		);
	});

	test.each([0, 100])("treats zero prompt tokens as unavailable even with %i output tokens", (output) => {
		const report = formatCompactionUsage(
			{ requests: [{ ...request, usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output } }] },
			0,
		);
		expect(report).toEqual({
			summary: "Native compaction · 1 request · 48.2s · usage unavailable",
			requests: [`1. native · ${n(9_000)} chars · 48.2s · usage unavailable`],
		});
	});

	test.each([undefined, null, false, 42, "details", [], {}, { requests: null }, { requests: {} }, { requests: [] }])(
		"reports nothing for absent or malformed request collections: %j",
		(details) => {
			expect(formatCompactionUsage(details, 100)).toBeUndefined();
		},
	);

	test.each([
		null,
		false,
		"request",
		[],
		{},
		{ ...request, strategy: "unknown" },
		{ ...request, attempt: 0 },
		{ ...request, attempt: -1 },
		{ ...request, attempt: 1.5 },
		{ ...request, attempt: "1" },
		{ ...request, attempt: Number.MAX_SAFE_INTEGER + 1 },
		{ ...request, provider: null },
		{ ...request, provider: " " },
		{ ...request, model: undefined },
		{ ...request, model: "" },
		{ ...request, stopReason: null },
		{ ...request, stopReason: "\u001b[31mstop\nforged statistics" },
	])("ignores malformed request identities without dropping later valid records: %j", (malformed) => {
		expect(formatCompactionUsage({ requests: [malformed, request] }, 0)).toEqual(
			formatCompactionUsage({ requests: [request] }, 0),
		);
	});

	test.each([undefined, null, "usage", [], {}, { input: 10, cacheRead: 10, cacheWrite: 0 }])(
		"marks missing or malformed usage as unavailable: %j",
		(usage) => {
			expect(requestLine({ ...request, usage })).toBe(`1. native · ${n(9_000)} chars · 48.2s · usage unavailable`);
		},
	);

	test.each(["input", "output", "cacheRead", "cacheWrite", "totalTokens"])(
		"rejects invalid %s counts rather than calculating fabricated statistics",
		(field) => {
			for (const value of [undefined, null, "1000", -1, -0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
				expect(requestLine({ ...request, usage: { ...request.usage, [field]: value } })).toBe(
					`1. native · ${n(9_000)} chars · 48.2s · usage unavailable`,
				);
			}
		},
	);

	test("does not calculate rates or totals from unsafe token sums", () => {
		const unsafe = { ...request, usage: { ...request.usage, cacheRead: Number.MAX_SAFE_INTEGER } };
		expect(requestLine(unsafe)).toBe(`1. native · ${n(9_000)} chars · 48.2s · usage unavailable`);
		const half = Math.floor(Number.MAX_SAFE_INTEGER / 2) + 1;
		const large = { ...request, usage: { ...request.usage, input: half, cacheRead: 0, cacheWrite: 0 } };
		expect(formatCompactionUsage({ requests: [large, { ...large, attempt: 2 }] }, 0)?.summary).toBe(
			"Native compaction · 2 requests · 48.2s · usage unavailable",
		);
	});
});
