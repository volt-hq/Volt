import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { type BenchmarkFixture, createCodeModeFixtures } from "../../benchmarks/code-mode-fixtures.ts";

const fixtureIds = [
	"single-lookup",
	"paginated-aggregate",
	"join-filter",
	"adaptive-troubleshooting",
	"cursor-dedup",
	"grouped-top-k",
	"temporal-asof",
	"reconciliation",
	"sparse-summary",
	"three-way-join",
	"independent-fanout",
	"empty-result",
	"nested-projection",
	"hierarchy-rollup",
	"interval-overlap",
	"text-log-extraction",
	"policy-precedence",
	"bounded-search",
	"partition-availability",
	"snapshot-diff",
];

type RecordedCall = { name: string; args: Record<string, unknown>; result: Record<string, unknown> };
type Invoice = { id: string; region: string; status: string; amountCents: number; note: string };
type InvoicePage = { records: Invoice[]; nextOffset: number | null };

function getFixture(id: string): BenchmarkFixture {
	const fixture = createCodeModeFixtures().find((entry) => entry.id === id);
	if (!fixture) throw new Error(`Missing fixture: ${id}`);
	return fixture;
}

async function executeReference(
	fixture: BenchmarkFixture,
	transform?: (call: RecordedCall) => Record<string, unknown>,
): Promise<{ answer: unknown; calls: RecordedCall[] }> {
	const calls: RecordedCall[] = [];
	const bindings = Object.fromEntries(
		fixture.tools.map((tool) => [
			tool.name,
			async (args: Record<string, unknown>) => {
				if (calls.length >= 200) throw new Error("Reference exceeded the tool-call budget");
				const call = { name: tool.name, args, result: fixture.call(tool.name, args) };
				calls.push(call);
				return { text: "", images: [], structured: transform ? transform(call) : call.result };
			},
		]),
	);
	// Execute the authored JavaScript, not a reimplementation. No provider, MCP transport, or host I/O.
	const answer: unknown = await runInNewContext(
		`(async () => {\n${fixture.referenceCode}\n})()`,
		{ tools: { mcp: { fixture: bindings } } },
		{ timeout: 1000 },
	);
	return { answer, calls };
}

function invoiceSummary(records: Invoice[]): Record<string, unknown> {
	const selected = records.filter((invoice) => invoice.region === "north" && invoice.status === "paid");
	return {
		scannedCount: records.length,
		matchedCount: selected.length,
		totalCents: selected.reduce((sum, invoice) => sum + invoice.amountCents, 0),
	};
}

describe("code mode benchmark fixtures", () => {
	it("creates twenty independent task shapes with read-only, closed-world metadata", () => {
		const fixtures = createCodeModeFixtures();
		expect(fixtures.map((fixture) => fixture.id)).toEqual(fixtureIds);
		for (const fixture of fixtures) {
			expect(fixture.prompt).toContain("JSON only");
			for (const field of Object.keys(fixture.expected)) expect(fixture.prompt).toContain(field);
			for (const tool of fixture.tools) {
				expect(tool.annotations).toEqual({
					readOnlyHint: true,
					destructiveHint: false,
					idempotentHint: true,
					openWorldHint: false,
				});
				expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
				expect(tool.outputSchema).toMatchObject({ type: "object" });
			}
		}
	});

	it.each(fixtureIds)("strictly grades expected and seeded wrong answers for %s", (id) => {
		const fixture = getFixture(id);
		const expectedJson = JSON.stringify(fixture.expected);
		expect(fixture.grade(expectedJson)).toEqual({ correct: true });
		expect(fixture.grade(` \n\`\`\`json\n${expectedJson}\n\`\`\`\n `)).toEqual({ correct: true });
		expect(fixture.grade(`\`\`\`\n${expectedJson}\n\`\`\``)).toEqual({ correct: true });
		const reordered = Object.fromEntries(Object.entries(fixture.expected).reverse());
		expect(fixture.grade(JSON.stringify(reordered))).toEqual({ correct: true });
		for (const wrong of ["{}", "null", "[]", "42", "not json", `Result: ${expectedJson}`]) {
			expect(fixture.grade(wrong)).toMatchObject({ correct: false, reason: expect.any(String) });
		}
		expect(fixture.grade(`${expectedJson}\n${expectedJson}`).correct).toBe(false);
		expect(fixture.grade(`\`\`\`json\n${expectedJson}\n\`\`\`\nExtra commentary`).correct).toBe(false);
		expect(fixture.grade(`\`\`\`json\n${expectedJson}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``).correct).toBe(false);
		expect(fixture.grade(JSON.stringify({ ...fixture.expected, unexpected: true })).correct).toBe(false);
		for (const [field, value] of Object.entries(fixture.expected)) {
			const missing = { ...fixture.expected };
			delete missing[field];
			expect(fixture.grade(JSON.stringify(missing)).correct).toBe(false);
			const wrongValue =
				typeof value === "number"
					? value + 1
					: typeof value === "string"
						? `${value}-wrong`
						: typeof value === "boolean"
							? !value
							: Array.isArray(value)
								? [...value, "unexpected"]
								: "invalid";
			expect(fixture.grade(JSON.stringify({ ...fixture.expected, [field]: wrongValue })).correct).toBe(false);
			expect(fixture.grade(JSON.stringify({ ...fixture.expected, [field]: null })).correct).toBe(false);
			if (typeof value === "number") {
				expect(fixture.grade(JSON.stringify({ ...fixture.expected, [field]: String(value) })).correct).toBe(false);
			}
		}
	});

	it.each(fixtureIds)("runs %s reference code against fresh deterministic tool bindings", async (id) => {
		const first = getFixture(id);
		const second = getFixture(id);
		const result = await executeReference(first);
		expect(result.answer).toEqual(first.expected);
		expect(first.grade(JSON.stringify(result.answer))).toEqual({ correct: true });
		expect(result.calls.length).toBeGreaterThan(0);
		for (const call of result.calls) {
			expect(first.call(call.name, call.args)).toEqual(call.result);
			expect(second.call(call.name, call.args)).toEqual(call.result);
			expect(JSON.parse(JSON.stringify(call.result))).toEqual(call.result);
			expect(() => first.call(call.name, { ...call.args, unknown: true })).toThrow(/Unknown argument/);
		}
		const repeated = await executeReference(second);
		expect(repeated.answer).toEqual(result.answer);
		expect(repeated.calls).toEqual(result.calls);
		expect(first.tools).toEqual(second.tools);
		expect(first.tools).not.toBe(second.tools);
		expect(first.expected).not.toBe(second.expected);
	});

	it.each(fixtureIds)("rejects unknown tools and invalid argument containers for %s", (id) => {
		const fixture = getFixture(id);
		for (const name of ["missing_tool", "constructor", "toString", "__proto__"]) {
			expect(() => fixture.call(name, {})).toThrow(/Unknown tool/);
		}
		for (const tool of fixture.tools) {
			for (const value of [null, [], "id"]) {
				expect(() => fixture.call(tool.name, value as unknown as Record<string, unknown>)).toThrow(
					/Arguments must be an object/,
				);
			}
		}
	});

	it("does not share tool records, metadata, or oracle state between runs", () => {
		const first = getFixture("single-lookup");
		const second = getFixture("single-lookup");
		const original = JSON.stringify(second.expected);
		const response = first.call("get_service", { id: "build-cache" });
		response.owner = "modified";
		first.expected.owner = "modified";
		first.tools[0].inputSchema.extra = "modified";
		expect(second.expected.owner).toBe("developer-platform");
		expect(second.tools[0].inputSchema).not.toHaveProperty("extra");
		expect(first.call("get_service", { id: "build-cache" }).owner).toBe("developer-platform");
		expect(first.grade(original).correct).toBe(true);
		expect(first.grade(JSON.stringify(first.expected)).correct).toBe(false);
		const paginated = getFixture("paginated-aggregate");
		const page = paginated.call("list_invoices", {}) as InvoicePage;
		page.records[0].amountCents = -1;
		page.records.length = 1;
		expect((paginated.call("list_invoices", {}) as InvoicePage).records).toHaveLength(20);
		expect((paginated.call("list_invoices", {}) as InvoicePage).records[0].amountCents).toBe(1000);
	});

	it("uses one lookup for the control and derives its answer from the returned record", async () => {
		const fixture = getFixture("single-lookup");
		const result = await executeReference(fixture, (call) => ({ ...call.result, owner: "changed-team" }));
		expect(result.calls).toHaveLength(1);
		expect(result.answer).toEqual({ ...fixture.expected, owner: "changed-team" });
		for (const args of [{}, { id: 4 }, { id: "" }, { id: "missing" }]) {
			expect(() => fixture.call("get_service", args)).toThrow();
		}
	});

	it.each([1, 7, 20])("paginates all 120 noisy records with limit %i without gaps or repeats", (limit) => {
		const fixture = getFixture("paginated-aggregate");
		const records: Invoice[] = [];
		let offset: number | null = 0;
		let pages = 0;
		do {
			const page = fixture.call("list_invoices", { offset, limit }) as InvoicePage;
			expect(page.records.length).toBeGreaterThan(0);
			expect(page.records.length).toBeLessThanOrEqual(limit);
			records.push(...page.records);
			offset = page.nextOffset;
			if (++pages > 120) throw new Error("Pagination failed to terminate");
		} while (offset !== null);
		expect(pages).toBe(Math.ceil(120 / limit));
		expect(records).toHaveLength(120);
		expect(new Set(records.map((invoice) => invoice.id)).size).toBe(120);
		expect(records[0].id).toBe("INV-001");
		expect(records[119].id).toBe("INV-120");
		expect(records.every((invoice) => invoice.note.length > 400)).toBe(true);
		expect(invoiceSummary(records)).toEqual(fixture.expected);
		expect(fixture.call("list_invoices", { offset: 120, limit })).toEqual({ records: [], nextOffset: null });
	});

	it("rejects unbounded, malformed, or out-of-range pagination", () => {
		const fixture = getFixture("paginated-aggregate");
		for (const limit of [0, -1, 21, 1.5, "20", null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => fixture.call("list_invoices", { limit })).toThrow(/limit must be an integer/);
		}
		for (const offset of [-1, 121, 0.5, "0", null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => fixture.call("list_invoices", { offset })).toThrow(/offset must be an integer/);
		}
		expect(fixture.call("list_invoices", {})).toEqual(fixture.call("list_invoices", { offset: 0, limit: 20 }));
	});

	it("fails a plausible missed-last-page answer and a one-cent aggregate error", async () => {
		const fixture = getFixture("paginated-aggregate");
		const result = await executeReference(fixture);
		expect(result.calls).toHaveLength(6);
		const records = result.calls.flatMap((call) => (call.result as InvoicePage).records);
		const incomplete = invoiceSummary(records.slice(0, 100));
		expect(fixture.grade(JSON.stringify(incomplete)).correct).toBe(false);
		expect(fixture.grade(JSON.stringify({ ...incomplete, scannedCount: 120 })).correct).toBe(false);
		expect(
			fixture.grade(JSON.stringify({ ...fixture.expected, totalCents: Number(fixture.expected.totalCents) + 1 }))
				.correct,
		).toBe(false);
		const changed = await executeReference(fixture, (call) => ({
			...call.result,
			records: (call.result as InvoicePage).records.map((invoice) => ({ ...invoice, amountCents: 0 })),
		}));
		expect(changed.answer).toEqual({ ...fixture.expected, totalCents: 0 });
	});

	it("joins 80 source records from two tools and enforces sorted exact ticket ids", async () => {
		const fixture = getFixture("join-filter");
		const result = await executeReference(fixture);
		expect(result.calls).toHaveLength(2);
		expect(fixture.call("list_accounts", {}).accounts).toHaveLength(20);
		expect(fixture.call("list_tickets", {}).tickets).toHaveLength(60);
		expect(result.answer).toEqual({
			ticketIds: ["TKT-007", "TKT-019", "TKT-043", "TKT-055"],
			accountCount: 4,
			totalMinutes: 210,
		});
		const ids = fixture.expected.ticketIds as string[];
		for (const ticketIds of [ids.slice(1), [...ids].reverse(), [...ids, ids[0]], [...ids, "TKT-031"]]) {
			expect(fixture.grade(JSON.stringify({ ...fixture.expected, ticketIds })).correct).toBe(false);
		}
		const changed = await executeReference(fixture, (call) => {
			if (call.name !== "list_accounts") return call.result;
			const accounts = call.result.accounts as Array<Record<string, unknown>>;
			return { accounts: accounts.map((account) => ({ ...account, active: false })) };
		});
		expect(changed.answer).toEqual({ ticketIds: [], accountCount: 0, totalMinutes: 0 });
	});

	it("follows current textual evidence and chooses only the matching diagnostic branch", async () => {
		const fixture = getFixture("adaptive-troubleshooting");
		const result = await executeReference(fixture);
		expect(result.calls.map(({ name, args }) => [name, args])).toEqual([
			["get_incident", { id: "INC-204" }],
			["read_note", { id: "log-rollout-62" }],
			["read_note", { id: "tls-guide" }],
			["read_note", { id: "renew-proxy-certificate" }],
		]);
		expect(
			fixture.grade(
				JSON.stringify({
					...fixture.expected,
					causeCode: "DNS_LOOKUP_FAILED",
					actionCode: "repair_dns",
					ownerTeam: "networking",
				}),
			).correct,
		).toBe(false);
		for (const name of ["get_incident", "read_note"]) {
			for (const args of [{}, { id: null }, { id: "missing" }]) expect(() => fixture.call(name, args)).toThrow();
		}
		const changed = await executeReference(fixture, (call) => {
			if (call.name === "read_note" && call.args.id === "log-rollout-62") {
				return { ...call.result, text: "Current failure: DNS_LOOKUP_FAILED. Consult runbook: tls-guide." };
			}
			return call.result;
		});
		expect(changed.calls[3].args).toEqual({ id: "repair-proxy-dns" });
		expect(changed.answer).toEqual({
			...fixture.expected,
			causeCode: "DNS_LOOKUP_FAILED",
			actionCode: "repair_dns",
			ownerTeam: "networking",
		});
	});
});
