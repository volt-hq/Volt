import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import type { BenchmarkFixture } from "../../benchmarks/code-mode-fixture-utils.ts";
import { createWorkflowRoutingFixtures } from "../../benchmarks/code-mode-fixtures-workflows.ts";

type Call = { name: string; args: Record<string, unknown>; result: Record<string, unknown> };

async function reference(fixture: BenchmarkFixture, change?: (call: Call) => Record<string, unknown>) {
	const calls: Call[] = [];
	const bindings = Object.fromEntries(
		fixture.tools.map((tool) => [
			tool.name,
			async (args: Record<string, unknown>) => {
				if (calls.length >= 200) throw new Error("Unbounded reference");
				const call = { name: tool.name, args, result: fixture.call(tool.name, args) };
				calls.push(call);
				return { structured: change ? change(call) : call.result };
			},
		]),
	);
	const answer: unknown = await runInNewContext(
		`(async()=>{${fixture.referenceCode}})()`,
		{ tools: { mcp: { fixture: bindings } } },
		{ timeout: 1000 },
	);
	return { answer, calls };
}

function getFixture(id: string) {
	return createWorkflowRoutingFixtures().find((fixture) => fixture.id === id)!;
}

describe("broadened workflow fixtures", () => {
	it.each(createWorkflowRoutingFixtures().map((fixture) => fixture.id))(
		"derives %s through bounded actual reference calls",
		async (id) => {
			const fixture = getFixture(id);
			const result = await reference(fixture);
			expect(result.answer).toEqual(fixture.expected);
			expect(fixture.grade(JSON.stringify(result.answer))).toEqual({ correct: true });
			expect(result.calls.length).toBeGreaterThan(0);
			expect(result.calls.length).toBeLessThanOrEqual(6);
			for (const call of result.calls) {
				expect(getFixture(id).call(call.name, call.args)).toEqual(call.result);
				expect(() => fixture.call(call.name, { ...call.args, extra: true })).toThrow("Unknown argument");
			}
		},
	);

	it("preserves false, zero, and escaped text, while following changed overrides", async () => {
		const fixture = getFixture("nested-projection");
		expect(fixture.expected).toEqual({ enabled: false, retries: 0, label: 'Review "A"\\B\nnext' });
		const changed = await reference(fixture, (call) => ({
			...call.result,
			environments: { production: { label: "Changed" } },
		}));
		expect(changed.answer).toEqual({ enabled: true, retries: 4, label: "Changed" });
		expect(fixture.grade(JSON.stringify(changed.answer)).correct).toBe(false);
		for (const args of [{}, { id: 3 }, { id: "missing" }])
			expect(() => fixture.call("get_release_config", args)).toThrow();
	});

	it("deduplicates shared departments and follows changed child links", async () => {
		const fixture = getFixture("hierarchy-rollup");
		const result = await reference(fixture);
		expect(result.answer).toEqual({ nodeCount: 5, activeBudget: 190, leafIds: ["shared", "web"] });
		expect(result.calls.filter((call) => call.args.id === "shared")).toHaveLength(1);
		const changed = await reference(fixture, (call) =>
			call.args.id === "company" ? { ...call.result, children: ["ops"] } : call.result,
		);
		expect(changed.answer).toEqual({ nodeCount: 3, activeBudget: 160, leafIds: ["shared"] });
		expect(fixture.grade(JSON.stringify({ ...fixture.expected, activeBudget: 230 })).correct).toBe(false);
	});

	it("clips and unions intervals without counting cancelled or boundary-only records", async () => {
		const fixture = getFixture("interval-overlap");
		expect(fixture.expected).toEqual({ reservationIds: ["r2", "r3", "r4"], coveredMinutes: 60 });
		expect(fixture.grade(JSON.stringify({ ...fixture.expected, coveredMinutes: 75 })).correct).toBe(false);
		const changed = await reference(fixture, (call) => ({
			reservations: (call.result.reservations as Record<string, unknown>[]).map((row) => ({
				...row,
				cancelled: true,
			})),
		}));
		expect(changed.answer).toEqual({ reservationIds: [], coveredMinutes: 0 });
	});

	it("parses log columns, not message text, across all pages", async () => {
		const fixture = getFixture("text-log-extraction");
		expect(fixture.expected).toEqual({
			errorCount: 5,
			counts: [
				{ code: "E_AUTH", count: 2 },
				{ code: "E_RATE", count: 1 },
				{ code: "E_TIMEOUT", count: 2 },
			],
		});
		const changed = await reference(fixture, (call) => ({
			...call.result,
			text: (call.result.text as string).replaceAll("ERROR|api|", "WARN|api|"),
		}));
		expect(changed.answer).toEqual({ errorCount: 0, counts: [] });
		for (const page of [-1, 3, 0.5, "0", null, undefined])
			expect(() => fixture.call("read_log_page", { page })).toThrow();
	});

	it("applies specificity before priority and deny tie-breaking before rule id", async () => {
		const fixture = getFixture("policy-precedence");
		expect(fixture.expected).toEqual({
			decisions: [
				{ resourceId: "billing", effect: "deny", ruleId: "global" },
				{ resourceId: "cache", effect: "deny", ruleId: "cache-deny" },
				{ resourceId: "reports", effect: "allow", ruleId: "platform" },
			],
		});
		const changed = await reference(fixture, (call) =>
			call.name !== "list_access_rules"
				? call.result
				: {
						rules: (call.result.rules as Record<string, unknown>[]).filter((rule) => rule.id !== "cache-deny"),
					},
		);
		expect(changed.answer).toMatchObject({
			decisions: [
				{ resourceId: "billing", effect: "deny" },
				{ resourceId: "cache", effect: "allow", ruleId: "cache-allow" },
				{ resourceId: "reports", effect: "allow" },
			],
		});
	});

	it("finds a changed monotone boundary rather than embedding its answer", async () => {
		const fixture = getFixture("bounded-search");
		expect(fixture.expected).toEqual({ firstFailed: 37, lastPassing: 36 });
		const changed = await reference(fixture, (call) => ({ ...call.result, passed: Number(call.args.index) < 17 }));
		expect(changed.answer).toEqual({ firstFailed: 17, lastPassing: 16 });
		expect(changed.calls.length).toBeLessThanOrEqual(6);
		for (const index of [-1, 64, 1.5, "0", null, undefined])
			expect(() => fixture.call("get_build_status", { index })).toThrow();
	});

	it("distinguishes unknown partitions from available zero counts", async () => {
		const fixture = getFixture("partition-availability");
		expect(fixture.expected).toEqual({ knownCount: 15, knownCents: 600, unavailableIds: ["west"], complete: false });
		const changed = await reference(fixture, (call) =>
			call.args.id === "west" ? { ...call.result, status: "available", count: 0, amountCents: 0 } : call.result,
		);
		expect(changed.answer).toEqual({ knownCount: 15, knownCents: 600, unavailableIds: [], complete: true });
		expect(fixture.grade(JSON.stringify(changed.answer)).correct).toBe(false);
	});

	it("compares content hashes rather than byte lengths and treats renames as remove/add", async () => {
		const fixture = getFixture("snapshot-diff");
		expect(fixture.expected).toEqual({
			added: ["extra.ts", "new.txt"],
			removed: ["old.txt"],
			modified: ["app.ts", "notes/a|b.md"],
			unchangedCount: 2,
		});
		const changed = await reference(fixture, () => fixture.call("get_snapshot", { version: "before" }));
		expect(changed.answer).toEqual({ added: [], removed: [], modified: [], unchangedCount: 5 });
		for (const version of ["missing", 1, null, undefined])
			expect(() => fixture.call("get_snapshot", { version })).toThrow();
	});
});
