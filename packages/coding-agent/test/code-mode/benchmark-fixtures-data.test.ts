import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { BenchmarkFixture } from "../../benchmarks/code-mode-fixture-utils.ts";
import { createDataRoutingFixtures } from "../../benchmarks/code-mode-fixtures-data.ts";

type RecordedCall = { name: string; args: Record<string, unknown>; result: Record<string, unknown> };
type Transform = (call: RecordedCall) => Record<string, unknown> | Promise<Record<string, unknown>>;
type EventPage = { records: Array<{ id: string; amountCents: number }>; nextCursor: string | null };
type LedgerPage = { records: Array<{ id: string; group: string; amountCents: number }>; nextOffset: number | null };

const baseline: Record<string, Record<string, unknown>> = {
	"cursor-dedup": {
		eventIds: ["EVT-01", "EVT-02", "EVT-03", "EVT-04", "EVT-05", "EVT-06", "EVT-07", "EVT-08", "EVT-09"],
		uniqueCount: 9,
		totalCents: 1900,
	},
	"grouped-top-k": {
		topGroups: [
			{ group: "beta", totalCents: 1400 },
			{ group: "alpha", totalCents: 1000 },
			{ group: "delta", totalCents: 1000 },
		],
		groupCount: 6,
	},
	"temporal-asof": {
		selections: [
			{ entityId: "alpha", recordId: "a-cutoff", valueCents: 1500 },
			{ entityId: "bravo", recordId: "b-a", valueCents: 600 },
			{ entityId: "delta", recordId: "d-zero", valueCents: 0 },
			{ entityId: "echo", recordId: "e-new", valueCents: -75 },
		],
		totalCents: 2025,
	},
	reconciliation: {
		missingIds: ["PKG-02", "PKG-05"],
		unexpectedIds: ["PKG-07"],
		duplicateIds: ["PKG-01", "PKG-03", "PKG-07"],
		matchedCount: 3,
	},
	"sparse-summary": { recordCount: 10, missingCount: 2, nullCount: 2, zeroCount: 3, numericCount: 6, total: 19 },
	"three-way-join": {
		orderIds: ["O-01", "O-02", "O-03", "O-08"],
		customerCount: 2,
		grossCents: 3800,
		refundCents: 850,
		netCents: 2950,
	},
	"independent-fanout": {
		enabledIds: ["east-1", "east-2", "north-1", "west-1", "west-2"],
		enabledCount: 5,
		availableUnits: 205,
	},
	"empty-result": { candidateIds: [], matchedCount: 0 },
};
const fixtureIds = Object.keys(baseline);

function getFixture(id: string): BenchmarkFixture {
	const fixture = createDataRoutingFixtures().find((entry) => entry.id === id);
	if (!fixture) throw new Error(`Missing fixture: ${id}`);
	return fixture;
}

async function executeReference(
	fixture: BenchmarkFixture,
	transform?: Transform,
): Promise<{ answer: unknown; calls: RecordedCall[] }> {
	const calls: RecordedCall[] = [];
	const bindings = Object.fromEntries(
		fixture.tools.map((tool) => [
			tool.name,
			async (args: Record<string, unknown>) => {
				if (calls.length >= 6) throw new Error("Reference exceeded six data calls");
				const call = { name: tool.name, args, result: fixture.call(tool.name, args) };
				calls.push(call);
				return { text: "", images: [], structured: transform ? await transform(call) : call.result };
			},
		]),
	);
	// Run the actual authored JavaScript with synthetic bindings, not an implementation of its answer.
	const answer: unknown = await runInNewContext(
		`(async () => {\n${fixture.referenceCode}\n})()`,
		{ tools: { mcp: { fixture: bindings } } },
		{ timeout: 1000 },
	);
	return { answer, calls };
}

const differentials: Array<{ id: string; transform: Transform; expected: Record<string, unknown> }> = [
	{
		id: "cursor-dedup",
		transform: ({ result }) => ({
			...result,
			records: (result as EventPage).records.map((record) =>
				record.id === "EVT-01" ? { ...record, amountCents: 225 } : record,
			),
		}),
		expected: { ...baseline["cursor-dedup"], totalCents: 2000 },
	},
	{
		id: "grouped-top-k",
		transform: ({ result }) => ({
			...result,
			records: (result as LedgerPage).records.map((record) =>
				record.id === "LINE-4" ? { ...record, amountCents: record.amountCents + 1 } : record,
			),
		}),
		expected: {
			topGroups: [
				{ group: "beta", totalCents: 1400 },
				{ group: "delta", totalCents: 1001 },
				{ group: "alpha", totalCents: 1000 },
			],
			groupCount: 6,
		},
	},
	{
		id: "temporal-asof",
		transform: ({ result }) => ({
			versions: (result.versions as Array<Record<string, unknown>>).map((record) =>
				record.id === "a-future" ? { ...record, effectiveAt: "2026-06-30T12:00:00Z", valueCents: 2100 } : record,
			),
		}),
		expected: {
			selections: [
				{ entityId: "alpha", recordId: "a-future", valueCents: 2100 },
				{ entityId: "bravo", recordId: "b-a", valueCents: 600 },
				{ entityId: "delta", recordId: "d-zero", valueCents: 0 },
				{ entityId: "echo", recordId: "e-new", valueCents: -75 },
			],
			totalCents: 2625,
		},
	},
	{
		id: "reconciliation",
		transform: ({ name, result }) =>
			name !== "list_scans"
				? result
				: {
						scans: (result.scans as Array<Record<string, unknown>>).map((scan) =>
							scan.itemId === "PKG-07" ? { ...scan, itemId: "PKG-02" } : scan,
						),
					},
		expected: {
			missingIds: ["PKG-05"],
			unexpectedIds: [],
			duplicateIds: ["PKG-01", "PKG-02", "PKG-03"],
			matchedCount: 4,
		},
	},
	{
		id: "sparse-summary",
		transform: ({ result }) => ({
			readings: (result.readings as Array<Record<string, unknown>>).map((record) =>
				record.id === "S-07" ? { ...record, reading: 0 } : record,
			),
		}),
		expected: { recordCount: 10, missingCount: 1, nullCount: 2, zeroCount: 4, numericCount: 7, total: 19 },
	},
	{
		id: "three-way-join",
		transform: ({ name, result }) =>
			name !== "list_refunds"
				? result
				: {
						refunds: (result.refunds as Array<Record<string, unknown>>).map((refund) =>
							refund.id === "R-04" ? { ...refund, status: "completed" } : refund,
						),
					},
		expected: { ...baseline["three-way-join"], refundCents: 1849, netCents: 1951 },
	},
	{
		id: "independent-fanout",
		transform: ({ result }) => (result.id === "north-2" ? { ...result, enabled: true } : result),
		expected: {
			enabledIds: ["east-1", "east-2", "north-1", "north-2", "west-1", "west-2"],
			enabledCount: 6,
			availableUnits: 240,
		},
	},
	{
		id: "empty-result",
		transform: ({ result }) => ({
			candidates: (result.candidates as Array<Record<string, unknown>>).map((record) =>
				record.id === "CAN-01" ? { ...record, score: 90 } : record,
			),
		}),
		expected: { candidateIds: ["CAN-01"], matchedCount: 1 },
	},
];

describe("data routing benchmark fixtures", () => {
	it("exposes exactly eight independent shapes with closed-world read-only schemas", () => {
		const fixtures = createDataRoutingFixtures();
		expect(fixtures.map((fixture) => fixture.id)).toEqual(fixtureIds);
		for (const fixture of fixtures) {
			for (const tool of fixture.tools) {
				expect(tool.annotations).toEqual({
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				});
				expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
				expect(tool.outputSchema).toMatchObject({ type: "object", additionalProperties: false });
			}
		}
	});

	it.each(fixtureIds)("executes %s reference JS within six calls and 100 KB of deterministic data", async (id) => {
		const fixture = getFixture(id);
		const fresh = getFixture(id);
		const result = await executeReference(fixture);
		expect(fixture.expected).toEqual(baseline[id]);
		expect(result.answer).toEqual(baseline[id]);
		expect(fixture.grade(JSON.stringify(result.answer))).toEqual({ correct: true });
		expect(result.calls.length).toBeGreaterThan(0);
		expect(result.calls.length).toBeLessThanOrEqual(6);
		expect(
			result.calls.reduce((bytes, call) => bytes + Buffer.byteLength(JSON.stringify(call.result)), 0),
		).toBeLessThan(100_000);
		expect(new Set(result.calls.map((call) => call.name))).toEqual(new Set(fixture.tools.map((tool) => tool.name)));
		for (const call of result.calls) {
			expect(fixture.call(call.name, call.args)).toEqual(call.result);
			expect(fresh.call(call.name, call.args)).toEqual(call.result);
			expect(JSON.parse(JSON.stringify(call.result))).toEqual(call.result);
			expect(() => fixture.call(call.name, { ...call.args, unknown: true })).toThrow(/Unknown argument/);
		}
		expect(await executeReference(fresh)).toEqual(result);
	});

	it.each(fixtureIds)("strictly rejects wrong values, missing fields, and malformed answers for %s", (id) => {
		const fixture = getFixture(id);
		const answer = baseline[id];
		expect(fixture.grade(JSON.stringify(answer)).correct).toBe(true);
		expect(fixture.grade(`\n\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`\n`).correct).toBe(true);
		expect(fixture.grade(JSON.stringify(Object.fromEntries(Object.entries(answer).reverse()))).correct).toBe(true);
		for (const wrong of [
			"{}",
			"null",
			"[]",
			"not json",
			`Answer: ${JSON.stringify(answer)}`,
			`${JSON.stringify(answer)}\n{}`,
		]) {
			expect(fixture.grade(wrong).correct).toBe(false);
		}
		expect(fixture.grade(JSON.stringify({ ...answer, extra: true })).correct).toBe(false);
		for (const [field, value] of Object.entries(answer)) {
			const missing = { ...answer };
			delete missing[field];
			expect(fixture.grade(JSON.stringify(missing)).correct).toBe(false);
			const wrongValue = typeof value === "number" ? value + 1 : ["not-a-matching-record"];
			expect(fixture.grade(JSON.stringify({ ...answer, [field]: wrongValue })).correct).toBe(false);
			expect(fixture.grade(JSON.stringify({ ...answer, [field]: null })).correct).toBe(false);
			if (typeof value === "number")
				expect(fixture.grade(JSON.stringify({ ...answer, [field]: String(value) })).correct).toBe(false);
			if (Array.isArray(value) && value.length > 1) {
				expect(fixture.grade(JSON.stringify({ ...answer, [field]: [...value].reverse() })).correct).toBe(false);
				expect(fixture.grade(JSON.stringify({ ...answer, [field]: [...value, value[0]] })).correct).toBe(false);
			}
		}
	});

	it.each(fixtureIds)("rejects unknown tools and malformed argument containers for %s", (id) => {
		const fixture = getFixture(id);
		for (const name of ["missing", "constructor", "toString", "__proto__"])
			expect(() => fixture.call(name, {})).toThrow(/Unknown tool/);
		for (const tool of fixture.tools) {
			for (const args of [null, undefined, [], "id", 1, true]) {
				expect(() => fixture.call(tool.name, args as unknown as Record<string, unknown>)).toThrow(
					/Arguments must be an object/,
				);
			}
		}
	});

	it.each(fixtureIds)("detaches %s tool data, metadata, and grading state across runs", async (id) => {
		const first = getFixture(id);
		const second = getFixture(id);
		const { calls } = await executeReference(first);
		for (const call of calls) {
			const changed = first.call(call.name, call.args);
			for (const key of Object.keys(changed)) {
				if (Array.isArray(changed[key])) changed[key].length = 0;
				else changed[key] = null;
			}
			expect(first.call(call.name, call.args)).toEqual(call.result);
			expect(second.call(call.name, call.args)).toEqual(call.result);
		}
		first.expected[Object.keys(first.expected)[0]] = null;
		first.tools[0].inputSchema.changed = true;
		expect(second.expected).toEqual(baseline[id]);
		expect(second.tools[0].inputSchema).not.toHaveProperty("changed");
		expect(first.grade(JSON.stringify(baseline[id])).correct).toBe(true);
		expect(first.grade(JSON.stringify(first.expected)).correct).toBe(false);
	});

	it.each(differentials)(
		"derives $id from changed tool output instead of a memorized answer",
		async ({ id, transform, expected }) => {
			const fixture = getFixture(id);
			const changed = await executeReference(fixture, transform);
			expect(changed.answer).toEqual(expected);
			expect(changed.answer).not.toEqual(baseline[id]);
			expect(fixture.grade(JSON.stringify(changed.answer)).correct).toBe(false);
			expect((await executeReference(fixture)).answer).toEqual(baseline[id]);
		},
	);

	it("follows opaque cursors through four overlapping pages and rejects invented cursors", async () => {
		const fixture = getFixture("cursor-dedup");
		const input = fixture.tools[0].inputSchema.properties as Record<string, unknown>;
		const output = fixture.tools[0].outputSchema?.properties as Record<string, unknown>;
		expect(input.cursor).not.toHaveProperty("enum");
		expect(output.nextCursor).not.toHaveProperty("enum");
		const { calls } = await executeReference(fixture);
		expect(calls).toHaveLength(4);
		expect(calls[0].args).toEqual({ cursor: null });
		for (let index = 1; index < calls.length; index++)
			expect(calls[index].args.cursor).toBe(calls[index - 1].result.nextCursor);
		expect(calls[3].result.nextCursor).toBeNull();
		const records = calls.flatMap((call) => (call.result as EventPage).records);
		expect(records).toHaveLength(13);
		expect(new Set(records.map((record) => record.id)).size).toBe(9);
		expect(
			fixture.grade(
				JSON.stringify({
					...baseline["cursor-dedup"],
					totalCents: records.reduce((sum, record) => sum + record.amountCents, 0),
				}),
			).correct,
		).toBe(false);
		expect(fixture.call("list_events", {})).toEqual(calls[0].result);
		for (const cursor of [undefined, 0, 1, "", "0", "evt:unknown", false, {}, []]) {
			expect(() => fixture.call("list_events", { cursor })).toThrow(/cursor must be/);
		}
	});

	it("ranks tied groups across the top-three boundary and preserves zero-total groups", async () => {
		const fixture = getFixture("grouped-top-k");
		const { calls } = await executeReference(fixture);
		expect(calls).toHaveLength(2);
		expect(calls[1].args.offset).toBe(calls[0].result.nextOffset);
		expect(calls[1].result.nextOffset).toBeNull();
		expect(calls.flatMap((call) => (call.result as LedgerPage).records)).toHaveLength(24);
		for (const wrong of [
			{
				topGroups: [
					{ group: "beta", totalCents: 1400 },
					{ group: "gamma", totalCents: 1000 },
					{ group: "delta", totalCents: 1000 },
				],
				groupCount: 6,
			},
			{ ...baseline["grouped-top-k"], groupCount: 5 },
		])
			expect(fixture.grade(JSON.stringify(wrong)).correct).toBe(false);
		for (const limit of [undefined, null, 0, -1, 21, 0.5, "20", Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => fixture.call("list_ledger", { limit })).toThrow(/limit must be an integer/);
		}
		for (const offset of [undefined, null, -1, 25, 0.5, "0", Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => fixture.call("list_ledger", { offset })).toThrow(/offset must be an integer/);
		}
		expect(fixture.call("list_ledger", { offset: 24 })).toEqual({ records: [], nextOffset: null });
		expect(fixture.call("list_ledger", {})).toEqual(fixture.call("list_ledger", { offset: 0, limit: 20 }));
	});

	it("uses inclusive temporal boundaries, revision precedence, lexical ties, and no future-only entities", async () => {
		const fixture = getFixture("temporal-asof");
		const selections = baseline["temporal-asof"].selections as Array<{
			entityId: string;
			recordId: string;
			valueCents: number;
		}>;
		for (const [entityId, recordId, valueCents] of [
			["alpha", "a-future", 99999],
			["bravo", "b-z", 900],
			["bravo", "b-low", 999],
			["echo", "e-old", 500],
		] as const) {
			const wrong = selections.map((record) =>
				record.entityId === entityId ? { entityId, recordId, valueCents } : record,
			);
			expect(
				fixture.grade(
					JSON.stringify({
						selections: wrong,
						totalCents: wrong.reduce((sum, record) => sum + record.valueCents, 0),
					}),
				).correct,
			).toBe(false);
		}
		const changed = await executeReference(fixture, ({ result }) => ({
			versions: (result.versions as Array<Record<string, unknown>>).map((record) =>
				record.id === "b-z" ? { ...record, revision: 4 } : record,
			),
		}));
		expect(changed.answer).toEqual({
			selections: selections.map((record) =>
				record.entityId === "bravo" ? { ...record, recordId: "b-z", valueCents: 900 } : record,
			),
			totalCents: 2325,
		});
	});

	it("counts distinct reconciliation matches and duplicates including unexpected item ids", () => {
		const fixture = getFixture("reconciliation");
		for (const wrong of [
			{ ...baseline.reconciliation, duplicateIds: ["PKG-01", "PKG-03"] },
			{ ...baseline.reconciliation, duplicateIds: ["PKG-01", "PKG-03", "PKG-03", "PKG-07"] },
			{ ...baseline.reconciliation, matchedCount: 6 },
			{ ...baseline.reconciliation, missingIds: ["PKG-02", "PKG-05", "PKG-07"] },
		])
			expect(fixture.grade(JSON.stringify(wrong)).correct).toBe(false);
	});

	it("keeps absent and null readings distinct from zeros in actual structured responses", async () => {
		const fixture = getFixture("sparse-summary");
		const records = fixture.call("list_readings", {}).readings as Array<{ id: string; reading?: number | null }>;
		expect(Object.hasOwn(records[0], "reading")).toBe(false);
		expect(records[1].reading).toBe(0);
		expect(records[2].reading).toBeNull();
		const changed = await executeReference(fixture, ({ result }) => ({
			readings: (result.readings as typeof records).map((record) =>
				record.reading === null ? { ...record, reading: 0 } : record,
			),
		}));
		expect(changed.answer).toEqual({
			recordCount: 10,
			missingCount: 2,
			nullCount: 0,
			zeroCount: 5,
			numericCount: 8,
			total: 19,
		});
		expect(
			fixture.grade(
				JSON.stringify({
					recordCount: 10,
					missingCount: 2,
					nullCount: 2,
					zeroCount: 0,
					numericCount: 3,
					total: 19,
				}),
			).correct,
		).toBe(false);
	});

	it("avoids join fanout and depends on both customer eligibility and order amounts", async () => {
		const fixture = getFixture("three-way-join");
		const customerChange = await executeReference(fixture, ({ name, result }) =>
			name !== "list_customers"
				? result
				: {
						customers: (result.customers as Array<Record<string, unknown>>).map((customer) =>
							customer.id === "C-01" ? { ...customer, active: false } : customer,
						),
					},
		);
		expect(customerChange.answer).toEqual({
			orderIds: ["O-03", "O-08"],
			customerCount: 1,
			grossCents: 800,
			refundCents: 500,
			netCents: 300,
		});
		const orderChange = await executeReference(fixture, ({ name, result }) =>
			name !== "list_orders"
				? result
				: {
						orders: (result.orders as Array<Record<string, unknown>>).map((order) =>
							order.id === "O-08" ? { ...order, amountCents: 400 } : order,
						),
					},
		);
		expect(orderChange.answer).toEqual({ ...baseline["three-way-join"], grossCents: 3900, netCents: 3050 });
		for (const wrong of [
			{ ...baseline["three-way-join"], grossCents: 4800, netCents: 3950 },
			{ ...baseline["three-way-join"], refundCents: 950, netCents: 2850 },
			{ ...baseline["three-way-join"], orderIds: ["O-01", "O-02", "O-03"], grossCents: 3500, netCents: 2650 },
		])
			expect(fixture.grade(JSON.stringify(wrong)).correct).toBe(false);
	});

	it("starts six independent lookups and aggregates zero-availability resources without excluding them", async () => {
		const fixture = getFixture("independent-fanout");
		let active = 0;
		let peak = 0;
		const { calls } = await executeReference(fixture, async ({ result }) => {
			active++;
			peak = Math.max(peak, active);
			await Promise.resolve();
			active--;
			return result;
		});
		expect(calls).toHaveLength(6);
		expect(peak).toBe(6);
		expect(calls.map((call) => call.args.id).sort()).toEqual([
			"east-1",
			"east-2",
			"north-1",
			"north-2",
			"west-1",
			"west-2",
		]);
		for (const args of [
			{},
			{ id: undefined },
			{ id: null },
			{ id: "" },
			{ id: "unknown" },
			{ id: 1 },
			{ id: ["east-1"] },
		]) {
			expect(() => fixture.call("get_resource", args)).toThrow();
		}
		expect(
			fixture.grade(
				JSON.stringify({
					...baseline["independent-fanout"],
					enabledIds: ["east-1", "north-1", "west-2"],
					enabledCount: 3,
				}),
			).correct,
		).toBe(false);
	});

	it("returns a legitimate empty match set despite populated data and rejects each near miss", () => {
		const fixture = getFixture("empty-result");
		const records = fixture.call("list_candidates", {}).candidates as Array<{
			id: string;
			status: string;
			region: string;
			score: number;
		}>;
		expect(records).toHaveLength(7);
		expect(records.some((record) => record.status === "ready" && record.region === "north")).toBe(true);
		expect(records.some((record) => record.score >= 90)).toBe(true);
		for (const record of records)
			expect(fixture.grade(JSON.stringify({ candidateIds: [record.id], matchedCount: 1 })).correct).toBe(false);
		expect(fixture.grade(JSON.stringify({ candidateIds: [], matchedCount: 0 })).correct).toBe(true);
	});
});
