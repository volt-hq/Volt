import { runInNewContext } from "node:vm";
import { createFauxProvider, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import type { BenchmarkFixture } from "../../benchmarks/code-mode-fixtures.ts";
import { createRealisticRoutingFixtures } from "../../benchmarks/code-mode-fixtures-realistic.ts";
import { runRoutingCase } from "../../benchmarks/code-mode-routing.ts";

const fixtureIds = ["trace-scan", "handoff-chain", "message-triage", "byte-marker-scan", "loop-interpretation"];

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

function traceOf(fixture: BenchmarkFixture, id: string): string[] {
	return String(fixture.call("read_job_trace", { id }).trace).split("\n");
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
			expect(fixture.grade(" \n")).toEqual({ correct: false, reason: "The final reply was empty." });
			expect(fixture.grade("The answer is 4.").reason).toBe(
				"Answer must be JSON, optionally inside one JSON code fence.",
			);
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
		// Recorded MCP results had a median near 6 KB. Job traces stay in that range.
		for (const id of ["trace-scan", "handoff-chain", "message-triage", "loop-interpretation"]) {
			expect(sizes[id].largest).toBeGreaterThan(3_000);
			expect(sizes[id].largest).toBeLessThan(12_000);
		}
		expect(sizes["trace-scan"]).toMatchObject({ calls: 13 });
		expect(sizes["trace-scan"].total).toBeGreaterThan(40_000);
		expect(sizes["handoff-chain"]).toMatchObject({ calls: 7 });
		expect(sizes["byte-marker-scan"]).toMatchObject({ calls: 8 });
		expect(sizes["byte-marker-scan"].total).toBeGreaterThan(8_000);
		expect(sizes["loop-interpretation"]).toMatchObject({ calls: 1 });
	});

	it("plants near misses that a substring count would get wrong in trace-scan", () => {
		const fixture = getFixture("trace-scan");
		const jobs = fixture.call("list_jobs", {}).jobs as Array<{ id: string }>;
		const lines = jobs.flatMap((entry) => traceOf(fixture, entry.id));
		const mentions = lines.filter((text) => text.includes("checksum_update")).length;
		const exact = lines.filter((text) => /^\S+\s+invoke\s+checksum_update$/.test(text)).length;
		expect(exact).toBe(fixture.expected.invokeCount);
		expect(mentions).toBe(exact + 3);
		expect(lines.some((text) => /\sinvoke\s+checksum_final$/.test(text))).toBe(true);
		expect(() => fixture.call("read_job_trace", { id: "job-1" })).toThrow("Unknown job");
		expect(() => fixture.call("read_job_trace", { id: "job-4000", extra: 1 })).toThrow("Unknown argument");
	});

	it("separates final handoffs from invokes and mid-trace handoffs in handoff-chain", () => {
		const fixture = getFixture("handoff-chain");
		const path = fixture.expected.path as string[];
		expect(path).toHaveLength(7);
		expect(new Set(path).size).toBe(path.length);
		for (const [index, id] of path.entries()) {
			const lines = traceOf(fixture, id);
			const handoffs = lines.filter((text) => /^\S+\s+handoff\s/.test(text));
			const last = lines[lines.length - 1];
			if (index === path.length - 1) expect(last).toMatch(/\sdone$/);
			else expect(last).toMatch(new RegExp(`\\shandoff\\s+${path[index + 1]}$`));
			// Following the first handoff in a trace instead of the final step leaves the path.
			expect(handoffs.length).toBeGreaterThan(index === path.length - 1 ? 0 : 1);
			expect(handoffs[0]).not.toBe(last);
			expect(lines.some((text) => /\sinvoke\s+job-\d+$/.test(text))).toBe(true);
		}
	});

	it("makes the deciding job distinguishable only by what it compares in message-triage", () => {
		const fixture = getFixture("message-triage");
		const refs = fixture.call("find_message_refs", { text: "quota check failed" }).refs as Array<{
			job: string;
			step: string;
		}>;
		expect(refs).toHaveLength(5);
		expect(new Set(refs.map((ref) => ref.job)).size).toBe(fixture.expected.referencingCount);
		expect(fixture.call("find_message_refs", { text: "quota" }).refs).toEqual([]);
		const compareThenJump = (id: string) => {
			const lines = traceOf(fixture, id);
			return lines.filter(
				(text, index) => /\sskip_if\s/.test(text) && /\scheck\s+v\d, v\d$/.test(lines[index - 1] ?? ""),
			);
		};
		// Two referencing jobs compare two values and jump; only one loads the stored quota limit first.
		const candidates = [...new Set(refs.map((ref) => ref.job))].filter((id) => compareThenJump(id).length);
		expect(candidates).toHaveLength(2);
		expect(candidates).toContain(fixture.expected.decider);
		const decider = traceOf(fixture, String(fixture.expected.decider));
		const jump = decider.findIndex((text) => text.startsWith(`${fixture.expected.failureJumpStep}  skip_if`));
		expect(decider[jump - 2]).toMatch(/\sload\s+v1, stored\.quota_limit$/);
		// A job that writes the stored limit does not reference the message at all.
		expect(traceOf(fixture, "job-8300").some((text) => /\ssave\s+v0, stored\.quota_limit$/.test(text))).toBe(true);
		expect(refs.some((ref) => ref.job === "job-8300")).toBe(false);
	});

	it("needs boundary-spanning, byte-aligned matching in byte-marker-scan", () => {
		const fixture = getFixture("byte-marker-scan");
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

	it("has exactly one backward jump and no stray invokes inside the loop of loop-interpretation", () => {
		const fixture = getFixture("loop-interpretation");
		const lines = traceOf(fixture, "job-9000").map((text) => text.split(/\s+/));
		const backward = lines.filter(([at, action, operand]) => action.endsWith("_if") && operand < at);
		expect(backward).toHaveLength(1);
		expect(backward[0][2]).toBe(fixture.expected.loopStart);
		expect(lines.filter(([, action]) => action === "invoke").length).toBeGreaterThan(4);
		expect(lines.filter(([, action]) => action === "check").length).toBeGreaterThan(4);
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
		// Only the script's return value reaches the model, not the traces it read.
		expect(result.requests[1].toolResultBytes).toBeLessThan(2_000);
	});

	it("delivers a whole large trace to the model on the direct route", async () => {
		const fixture = getFixture("loop-interpretation");
		const faux = createFauxProvider();
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("mcp", {
						action: "call",
						server: "fixture",
						tool: "read_job_trace",
						arguments: { id: "job-9000" },
					}),
				],
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				const text = result?.content.map((part) => (part.type === "text" ? part.text : "")).join("\n") ?? "";
				expect(text).toContain("s220  done");
				expect(text).not.toContain("truncated");
				return fauxAssistantMessage(JSON.stringify(fixture.expected));
			},
		]);
		const result = await runRoutingCase(fixture, "direct", { model: faux.getModel(), streamFn: faux.streamSimple });
		expect(result.correct, result.failure ?? result.gradeReason).toBe(true);
		expect(result.requests[1].toolResultBytes).toBeGreaterThan(4_000);
	});
});
