import { runInNewContext } from "node:vm";
import { createFauxProvider, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import type { BenchmarkFixture } from "../../benchmarks/code-mode-fixtures.ts";
import { createRealisticRoutingFixtures } from "../../benchmarks/code-mode-fixtures-realistic.ts";
import { runRoutingCase } from "../../benchmarks/code-mode-routing.ts";

const fixtureIds = ["listing-scan", "tail-call-chain", "xref-triage", "byte-signature-scan", "loop-interpretation"];

type Call = { name: string; args: Record<string, unknown>; bytes: number };

function getFixture(id: string): BenchmarkFixture {
	const fixture = createRealisticRoutingFixtures().find((entry) => entry.id === id);
	if (!fixture) throw new Error(`Missing fixture: ${id}`);
	return fixture;
}

/** Runs the authored reference script against the fixture's own handlers. No provider, MCP transport, or host I/O. */
async function executeReference(fixture: BenchmarkFixture): Promise<{ answer: unknown; calls: Call[] }> {
	const calls: Call[] = [];
	const bindings = Object.fromEntries(
		fixture.tools.map((tool) => [
			tool.name,
			async (args: Record<string, unknown>) => {
				const structured = fixture.call(tool.name, args);
				calls.push({ name: tool.name, args, bytes: Buffer.byteLength(JSON.stringify(structured)) });
				return { text: "", images: [], structured };
			},
		]),
	);
	const answer: unknown = await runInNewContext(
		`(async () => {\n${fixture.referenceCode}\n})()`,
		{ tools: { mcp: { fixture: bindings } } },
		{ timeout: 1000 },
	);
	return { answer, calls };
}

function listingOf(fixture: BenchmarkFixture, address: string): string[] {
	return String(fixture.call("read_procedure", { address }).listing).split("\n");
}

describe("realistic code mode benchmark fixtures", () => {
	it("creates five read-only tasks whose prompts name every answer field", () => {
		const fixtures = createRealisticRoutingFixtures();
		expect(fixtures.map((fixture) => fixture.id)).toEqual(fixtureIds);
		for (const fixture of fixtures) {
			expect(fixture.prompt).toContain("JSON only");
			for (const field of Object.keys(fixture.expected)) expect(fixture.prompt).toContain(field);
			for (const tool of fixture.tools) {
				expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
				expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
				expect(tool.outputSchema).toMatchObject({ type: "object" });
			}
		}
	});

	it.each(fixtureIds)(
		"derives the expected answer for %s through its reference script and grades strictly",
		async (id) => {
			const fixture = getFixture(id);
			const { answer, calls } = await executeReference(fixture);
			expect(answer).toEqual(fixture.expected);
			expect(calls.length).toBeLessThanOrEqual(20);
			const expectedJson = JSON.stringify(fixture.expected);
			expect(fixture.grade(expectedJson)).toEqual({ correct: true });
			expect(fixture.grade(`\`\`\`json\n${expectedJson}\n\`\`\``)).toEqual({ correct: true });
			for (const wrong of ["{}", "not json", `Result: ${expectedJson}`])
				expect(fixture.grade(wrong)).toMatchObject({ correct: false });
			expect(fixture.grade(JSON.stringify({ ...fixture.expected, extra: 1 })).correct).toBe(false);
		},
	);

	it("returns multi-kilobyte results, unlike the small core fixtures", async () => {
		const sizes: Record<string, { total: number; largest: number; calls: number }> = {};
		for (const fixture of createRealisticRoutingFixtures()) {
			const { calls } = await executeReference(fixture);
			sizes[fixture.id] = {
				total: calls.reduce((sum, call) => sum + call.bytes, 0),
				largest: Math.max(...calls.map((call) => call.bytes)),
				calls: calls.length,
			};
		}
		// Recorded MCP results had a median near 6 KB. Procedure listings stay in that range.
		for (const id of ["listing-scan", "tail-call-chain", "xref-triage", "loop-interpretation"]) {
			expect(sizes[id].largest).toBeGreaterThan(3_000);
			expect(sizes[id].largest).toBeLessThan(12_000);
		}
		expect(sizes["listing-scan"]).toMatchObject({ calls: 13 });
		expect(sizes["listing-scan"].total).toBeGreaterThan(40_000);
		expect(sizes["tail-call-chain"]).toMatchObject({ calls: 7 });
		expect(sizes["byte-signature-scan"]).toMatchObject({ calls: 8 });
		expect(sizes["byte-signature-scan"].total).toBeGreaterThan(8_000);
		expect(sizes["loop-interpretation"]).toMatchObject({ calls: 1 });
	});

	it("plants near misses that a substring count would get wrong in listing-scan", () => {
		const fixture = getFixture("listing-scan");
		const procedures = fixture.call("list_procedures", {}).procedures as Array<{ address: string }>;
		const lines = procedures.flatMap((entry) => listingOf(fixture, entry.address));
		const mentions = lines.filter((text) => text.includes("crc32_update")).length;
		const exact = lines.filter((text) => /^\S+\s+call\s+crc32_update$/.test(text)).length;
		expect(exact).toBe(fixture.expected.callCount);
		expect(mentions).toBe(exact + 3);
		expect(lines.some((text) => /\scall\s+crc32_final$/.test(text))).toBe(true);
		expect(() => fixture.call("read_procedure", { address: "0x1" })).toThrow("Unknown procedure");
		expect(() => fixture.call("read_procedure", { address: "0x4000", extra: 1 })).toThrow("Unknown argument");
	});

	it("separates tail jumps from calls and mid-listing jumps in tail-call-chain", () => {
		const fixture = getFixture("tail-call-chain");
		const path = fixture.expected.path as string[];
		expect(path).toHaveLength(7);
		expect(new Set(path).size).toBe(path.length);
		for (const [index, address] of path.entries()) {
			const lines = listingOf(fixture, address);
			const jumps = lines.filter((text) => /^\S+\s+jmp\s/.test(text));
			const last = lines[lines.length - 1];
			if (index === path.length - 1) expect(last).toMatch(/\sret$/);
			else expect(last).toMatch(new RegExp(`\\sjmp\\s+${path[index + 1]}$`));
			// Following the first jmp in a listing instead of the final instruction leaves the path.
			expect(jumps.length).toBeGreaterThan(index === path.length - 1 ? 0 : 1);
			expect(jumps[0]).not.toBe(last);
			expect(lines.some((text) => /\scall\s+0x[0-9a-f]+$/.test(text))).toBe(true);
		}
	});

	it("makes the deciding procedure distinguishable only by what it compares in xref-triage", () => {
		const fixture = getFixture("xref-triage");
		const refs = fixture.call("find_string_refs", { text: "license check failed" }).refs as Array<{
			procedure: string;
			line: string;
		}>;
		expect(refs).toHaveLength(5);
		expect(new Set(refs.map((ref) => ref.procedure)).size).toBe(fixture.expected.referencingCount);
		expect(fixture.call("find_string_refs", { text: "license" }).refs).toEqual([]);
		const compareThenBranch = (address: string) => {
			const lines = listingOf(fixture, address);
			return lines.filter(
				(text, index) => /\sb\.ne\s/.test(text) && /\scmp\s+r\d, r\d$/.test(lines[index - 1] ?? ""),
			);
		};
		// Two referencing procedures compare two registers and branch; only one loads the stored checksum first.
		const candidates = [...new Set(refs.map((ref) => ref.procedure))].filter(
			(address) => compareThenBranch(address).length,
		);
		expect(candidates).toHaveLength(2);
		expect(candidates).toContain(fixture.expected.validator);
		const validator = listingOf(fixture, String(fixture.expected.validator));
		const branch = validator.findIndex((text) => text.startsWith(`${fixture.expected.failureBranchLine}  b.ne`));
		expect(validator[branch - 2]).toMatch(/\sldr\s+r1, \[stored_checksum\]$/);
		// A procedure that writes the stored checksum does not reference the message at all.
		expect(listingOf(fixture, "0x8c00").some((text) => text.includes("str   r0, [stored_checksum]"))).toBe(true);
		expect(refs.some((ref) => ref.procedure === "0x8c00")).toBe(false);
	});

	it("needs boundary-spanning, byte-aligned matching in byte-signature-scan", () => {
		const fixture = getFixture("byte-signature-scan");
		let image = "";
		const pages: string[] = [];
		for (let offset: number | null = 0; offset !== null; ) {
			const chunk = fixture.call("read_bytes", { offset }) as { hex: string; nextOffset: number | null };
			pages.push(chunk.hex);
			image += chunk.hex;
			offset = chunk.nextOffset;
		}
		expect(pages).toHaveLength(8);
		expect(image).toHaveLength(8192);
		const perPage = pages.reduce((count, hex) => count + hex.split("c0de7a11").length - 1, 0);
		const anyAlignment = image.split("c0de7a11").length - 1;
		expect(anyAlignment).toBe((fixture.expected.count as number) + 1);
		expect(perPage).toBe(anyAlignment - 1);
		expect(fixture.call("read_bytes", { offset: 4000, length: 512 })).toMatchObject({ length: 96, nextOffset: null });
		for (const args of [{ length: 513 }, { offset: -1 }, { offset: 1.5 }, { size: 1 }])
			expect(() => fixture.call("read_bytes", args)).toThrow();
	});

	it("has exactly one backward branch and no stray calls inside the loop of loop-interpretation", () => {
		const fixture = getFixture("loop-interpretation");
		const lines = listingOf(fixture, "0xa000").map((text) => text.split(/\s+/));
		const backward = lines.filter(
			([address, mnemonic, operand]) =>
				mnemonic.startsWith("b.") && Number.parseInt(operand.slice(4), 16) < Number.parseInt(address, 16),
		);
		expect(backward).toHaveLength(1);
		expect(`0x${backward[0][2].slice(4)}`).toBe(fixture.expected.loopStart);
		expect(lines.filter(([, mnemonic]) => mnemonic === "call").length).toBeGreaterThan(4);
		expect(lines.filter(([, mnemonic]) => mnemonic === "cmp").length).toBeGreaterThan(4);
	});

	it.each(fixtureIds)("runs the %s reference through the real session, MCP manager, and sandbox", async (id) => {
		const fixture = getFixture(id);
		const faux = createFauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("run_code", { code: fixture.referenceCode })], { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				const text = result?.content.map((part) => (part.type === "text" ? part.text : "")).join("\n") ?? "";
				return fauxAssistantMessage(text.slice(text.indexOf("Return value: ") + "Return value: ".length).trim());
			},
		]);
		const result = await runRoutingCase(fixture, "hybrid", { model: faux.getModel(), streamFn: faux.streamSimple });
		expect(result.correct, result.failure ?? result.gradeReason).toBe(true);
		expect(result.scriptFailures).toBe(0);
		expect(result.calls.filter((call) => call.route === "programmatic")).toHaveLength(result.dataCalls.length);
		// Only the script's return value reaches the model, not the listings it read.
		expect(result.requests[1].toolResultBytes).toBeLessThan(2_000);
	});

	it("delivers a whole large listing to the model on the direct route", async () => {
		const fixture = getFixture("loop-interpretation");
		const faux = createFauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("mcp", {
						action: "call",
						server: "fixture",
						tool: "read_procedure",
						arguments: { address: "0xa000" },
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				const text = result?.content.map((part) => (part.type === "text" ? part.text : "")).join("\n") ?? "";
				expect(text).toContain("0xa36c  ret");
				expect(text).not.toContain("truncated");
				return fauxAssistantMessage(JSON.stringify(fixture.expected));
			},
		]);
		const result = await runRoutingCase(fixture, "direct", { model: faux.getModel(), streamFn: faux.streamSimple });
		expect(result.correct, result.failure ?? result.gradeReason).toBe(true);
		expect(result.requests[1].toolResultBytes).toBeGreaterThan(5_000);
	});
});
