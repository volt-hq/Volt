import type { Usage } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import type { RoutingRequest } from "../../benchmarks/code-mode-routing.ts";
import {
	compareRoutingRuns,
	parseRoutingRun,
	type RoutingObservation,
	type RoutingRun,
	summarizeRoutingRuns,
} from "../../benchmarks/code-mode-routing-report.ts";

function usage(input = 100, cacheRead = 20): Usage {
	return {
		availability: "complete",
		input,
		output: 10,
		cacheRead,
		cacheWrite: 0,
		totalTokens: input + cacheRead + 10,
		cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0, total: 0.031 },
	};
}

function request(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
	return {
		index: 1,
		reasoning: "xhigh",
		contextBytes: 100,
		toolSchemaBytes: 20,
		systemPromptBytes: 30,
		toolResultBytes: 10,
		elapsedMs: 50,
		stopReason: "stop",
		usage: usage(),
		...overrides,
	};
}

function observation(overrides: Partial<RoutingObservation> = {}): RoutingObservation {
	return {
		model: "model/a",
		fixture: "lookup",
		mode: "hybrid",
		trial: 1,
		order: 0,
		status: "completed",
		correct: true,
		answer: "{}",
		elapsedMs: 200,
		requests: [request()],
		calls: [],
		dataCalls: [],
		repeatedDataCalls: 0,
		scriptFailures: 0,
		toolFailures: 0,
		transcript: [],
		...overrides,
	};
}

function run(cases: RoutingObservation[], overrides: Partial<RoutingRun> = {}): RoutingRun {
	return {
		format: 2,
		runId: "run-1",
		experimentId: "experiment-1",
		mode: "live",
		thinking: "xhigh",
		plannedCases: cases.length,
		status: cases.every((item) => item.correct) ? "completed" : "failed-or-incomplete",
		cases,
		...overrides,
	};
}

function pairedRow(report: string, section: "model" | "task", label: string, mode = "code-only"): string {
	const table = report.split(`### Paired deltas by ${section} versus hybrid\n`)[1].split("\n## ")[0];
	return table.split("\n").find((line) => line.startsWith(`| ${label} | ${mode} |`)) ?? "";
}

describe("routing report parser", () => {
	it("accepts format 2, optional metadata, missing usage, and completed-but-incorrect answers", () => {
		const source = {
			...run([observation({ correct: false, requests: [request({ usage: undefined })] })]),
			metadata: { seed: 4 },
		};
		const parsed = parseRoutingRun(JSON.parse(JSON.stringify(source)));
		expect(parsed).toMatchObject({ status: "failed-or-incomplete", metadata: { seed: 4 } });
		expect(parsed.cases[0].requests[0].usage).toBeUndefined();
		expect(parseRoutingRun(run([], { plannedCases: 3, status: "failed-or-incomplete" })).cases).toEqual([]);
	});

	const invalid: Array<[string, (source: RoutingRun) => unknown]> = [
		["unsupported format", (source) => ({ ...source, format: 1 })],
		["blank runId", (source) => ({ ...source, runId: " " })],
		["missing experimentId", (source) => ({ ...source, experimentId: undefined })],
		["invalid execution mode", (source) => ({ ...source, mode: "dry-run" })],
		["invalid thinking", (source) => ({ ...source, thinking: "high" })],
		["invalid run status", (source) => ({ ...source, status: "aborted" })],
		["negative plannedCases", (source) => ({ ...source, plannedCases: -1 })],
		["cases not an array", (source) => ({ ...source, cases: {} })],
		["null case", (source) => ({ ...source, cases: [null] })],
		["missing metric", (source) => ({ ...source, cases: [{ ...source.cases[0], elapsedMs: undefined }] })],
		["nonfinite metric", (source) => ({ ...source, cases: [{ ...source.cases[0], elapsedMs: Infinity }] })],
		["NaN metric", (source) => ({ ...source, cases: [{ ...source.cases[0], elapsedMs: NaN }] })],
		["negative metric", (source) => ({ ...source, cases: [{ ...source.cases[0], repeatedDataCalls: -1 }] })],
		["unknown routing mode", (source) => ({ ...source, cases: [{ ...source.cases[0], mode: "script" }] })],
		["unknown case status", (source) => ({ ...source, cases: [{ ...source.cases[0], status: "skipped" }] })],
		["failed but correct", (source) => ({ ...source, cases: [{ ...source.cases[0], status: "failed" }] })],
		["completed with failure", (source) => ({ ...source, cases: [{ ...source.cases[0], failure: "timeout" }] })],
		["nonboolean correct", (source) => ({ ...source, cases: [{ ...source.cases[0], correct: "yes" }] })],
		["zero trial", (source) => ({ ...source, cases: [{ ...source.cases[0], trial: 0 }] })],
		["fractional trial", (source) => ({ ...source, cases: [{ ...source.cases[0], trial: 1.5 }] })],
		["negative order", (source) => ({ ...source, cases: [{ ...source.cases[0], order: -1 }] })],
		["out of range order", (source) => ({ ...source, cases: [{ ...source.cases[0], order: 4 }] })],
		[
			"blank gateway action",
			(source) => ({
				...source,
				cases: [{ ...source.cases[0], calls: [{ tool: "mcp", route: "direct", blocked: false, action: "" }] }],
			}),
		],
		["fractional order", (source) => ({ ...source, cases: [{ ...source.cases[0], order: 0.5 }] })],
		[
			"duplicate observation",
			(source) => ({ ...source, plannedCases: 2, cases: [...source.cases, ...source.cases] }),
		],
		["too many observations", (source) => ({ ...source, plannedCases: 0 })],
		["completed with missing cases", (source) => ({ ...source, plannedCases: 2 })],
		["completed with incorrect case", (source) => ({ ...source, cases: [{ ...source.cases[0], correct: false }] })],
	];
	it.each(invalid)("rejects %s", (_label, modify) => {
		expect(() => parseRoutingRun(modify(run([observation()])))).toThrow("Invalid routing run");
	});

	it.each([
		{ usage: { ...usage(), input: -1 } },
		{ usage: { ...usage(), output: "10" } },
		{ usage: { ...usage(), cacheRead: Infinity } },
		{ usage: { ...usage(), cacheWrite: NaN } },
		{ usage: { ...usage(), totalTokens: undefined } },
		{ usage: { ...usage(), availability: "known" } },
		{ usage: { ...usage(), availability: ["complete"] } },
		{ usage: { ...usage(), cost: { ...usage().cost, total: -0.01 } } },
		{ usage: { ...usage(), cost: { ...usage().cost, total: Infinity } } },
		{ usage: null },
		{ elapsedMs: -1 },
		{ contextBytes: Infinity },
		{ index: 0 },
		{ stopReason: ["stop"] },
		{ reasoning: "high" },
	])("rejects malformed request data %j", (override) => {
		const source = run([observation()]);
		const malformed = { ...source, cases: [{ ...source.cases[0], requests: [{ ...request(), ...override }] }] };
		expect(() => parseRoutingRun(malformed)).toThrow("requests[0]");
	});
});

describe("routing run summaries", () => {
	it("reports median and interpolated IQR, counts, and complete-usage totals by model and task", () => {
		const cases = [100, 200, 300, 400].map((elapsedMs, i) =>
			observation({
				trial: i + 1,
				elapsedMs,
				calls: [{ tool: "run_code", route: "direct", blocked: false }],
				scriptFailures: 1,
				toolFailures: 2,
				dataCalls: [{ tool: "read", arguments: {}, resultBytes: 10, failed: false }],
				repeatedDataCalls: 1,
			}),
		);
		const report = summarizeRoutingRuns([run(cases)]);
		for (const label of ["model/a", "lookup"]) {
			expect(report).toContain(
				`| ${label} | hybrid | 4/4 | 4 | 250.0 | 150.0 | 4/4; unknown requests 0; no-request cases 0 | 480 | 40 | 80 | 0 | 0.1240 | 4 | 4 | 8 | 4 |`,
			);
		}
		expect(report).toContain("Medians and IQRs are descriptive");
		expect(report).toContain("Cached tokens and order effects");
	});

	it("reports paired percent units and takes the median of pairwise deltas, not aggregate ratios", () => {
		const report = summarizeRoutingRuns([
			run([
				observation({ elapsedMs: 100, requests: [request({ usage: usage(100, 0) })] }),
				observation({ mode: "code-only", order: 1, elapsedMs: 50, requests: [request({ usage: usage(50, 0) })] }),
				observation({ trial: 2, elapsedMs: 1000, requests: [request({ usage: usage(1000, 0) })] }),
				observation({
					trial: 2,
					mode: "code-only",
					order: 2,
					elapsedMs: 1500,
					requests: [request({ usage: usage(1500, 0) })],
				}),
			]),
		]);
		for (const [section, label] of [
			["model", "model/a"],
			["task", "lookup"],
		] as const)
			expect(pairedRow(report, section, label)).toBe(`| ${label} | code-only | 2/2 | 0.0% | 2 | 0.0% | 2 |`);
		const half = summarizeRoutingRuns([
			run([
				observation(),
				observation({ mode: "code-first", order: 1, elapsedMs: 100, requests: [request({ usage: usage(40) })] }),
			]),
		]);
		expect(pairedRow(half, "model", "model/a", "code-first")).toBe(
			"| model/a | code-first | 1/1 | -50.0% | 1 | -50.0% | 1 |",
		);
	});

	it("never pairs across run, model, fixture, or trial boundaries", () => {
		const report = summarizeRoutingRuns([
			run([
				observation(),
				observation({ mode: "code-only", trial: 2 }),
				observation({ mode: "code-only", fixture: "join" }),
				observation({ mode: "code-only", model: "model/b" }),
			]),
			run([observation({ mode: "code-only" })], { runId: "run-2" }),
		]);
		expect(pairedRow(report, "model", "model/a")).toBe("| model/a | code-only | 0/3 | unknown | 0 | unknown | 0 |");
		expect(pairedRow(report, "model", "model/b")).toBe("| model/b | code-only | 0/1 | unknown | 0 | unknown | 0 |");
	});

	it("retains incomplete runs, failures, and wrong answers in success accounting but not paired efficiency", () => {
		const report = summarizeRoutingRuns([
			run(
				[
					observation(),
					observation({ mode: "code-only", status: "failed", correct: false, failure: "timeout", elapsedMs: 1 }),
					observation({ trial: 2, correct: false }),
					observation({ trial: 2, mode: "code-only" }),
				],
				{ plannedCases: 6 },
			),
		]);
		expect(report).toContain("Success/all planned: 2/6; recorded: 4; missing: 2; failed-or-incomplete runs: 1");
		expect(report).toContain("| model/a | code-only | 1/2 | 2 |");
		expect(report).toContain("| run-1 | model/a | lookup | 1 | code-only | failed | timeout |");
		expect(pairedRow(report, "model", "model/a")).toContain("| 0/2 | unknown | 0 | unknown | 0 |");
		expect(report).toContain("Missing, failed, and incorrect cases are excluded from paired efficiency");
	});

	it("separates latency pair counts from complete-usage input pair counts", () => {
		const report = summarizeRoutingRuns([
			run([
				observation(),
				observation({ mode: "code-only", elapsedMs: 100 }),
				observation({ trial: 2 }),
				observation({ trial: 2, mode: "code-only", elapsedMs: 100, requests: [request({ usage: undefined })] }),
			]),
		]);
		expect(pairedRow(report, "model", "model/a")).toContain("| 2/2 | -50.0% | 2 | 0.0% | 1 |");
		expect(report).toContain("1/2; unknown requests 1; no-request cases 0 | 120 | 10 | 20 | 0 | 0.0310 |");
	});

	it.each([undefined, "partial", "unavailable"] as const)(
		"treats %s usage availability as unknown, not zero",
		(availability) => {
			const report = summarizeRoutingRuns([
				run([observation({ requests: [request({ usage: { ...usage(), availability } })] })]),
			]);
			expect(report).toContain(
				"0/1; unknown requests 1; no-request cases 0 | unknown | unknown | unknown | unknown | unknown |",
			);
		},
	);

	it("does not treat absent requests or zero hybrid denominators as measured improvements", () => {
		const report = summarizeRoutingRuns([
			run([
				observation({ elapsedMs: 0, requests: [request({ usage: usage(0, 0) })] }),
				observation({ mode: "code-only", requests: [] }),
			]),
		]);
		expect(pairedRow(report, "model", "model/a")).toContain("| 1/1 | unknown | 0 | unknown | 0 |");
		expect(report).toContain("0/0; unknown requests 0; no-request cases 1 | unknown | unknown");
	});

	it("uses equal task weights and deterministic task-block intervals rather than counting repeats as new tasks", () => {
		const cases: RoutingObservation[] = [];
		for (let task = 0; task < 10; task++) {
			for (let trial = 1; trial <= (task === 9 ? 51 : 1); trial++) {
				cases.push(observation({ fixture: `task-${task}`, trial, elapsedMs: 100 }));
				cases.push(
					observation({
						fixture: `task-${task}`,
						trial,
						mode: "code-only",
						order: 1,
						elapsedMs: task === 9 ? 150 : 50,
					}),
				);
			}
		}
		const report = summarizeRoutingRuns([run(cases)]);
		expect(report).toContain("| model/a | code-only | latency | -50.0% | [-50.0%, -50.0%] | 10 | 60 |");
		expect(summarizeRoutingRuns([run(cases)])).toBe(report);
		const oneTask = summarizeRoutingRuns([run(cases.filter((item) => item.fixture === "task-9"))]);
		expect(oneTask).toContain("| model/a | code-only | latency | 50.0% | insufficient tasks (<10) | 1 | 51 |");
	});

	it("does not create task interval input evidence from unknown usage or failed pairs", () => {
		const report = summarizeRoutingRuns([
			run([
				observation(),
				observation({ mode: "code-only", requests: [request({ usage: undefined })] }),
				observation({ fixture: "failed", correct: false }),
				observation({ fixture: "failed", mode: "code-only" }),
			]),
		]);
		expect(report).toContain("| model/a | code-only | input | unknown | unknown | 0 | 0 |");
		expect(report).toContain("| model/a | code-only | latency | 0.0% | insufficient tasks (<10) | 1 | 1 |");
	});

	it("counts gateway actions, scripted calls, and peak context, and marks older artifacts unknown", () => {
		const report = summarizeRoutingRuns([
			run([
				observation({
					requests: [request(), request({ index: 2, contextBytes: 900 })],
					calls: [
						{ tool: "mcp", route: "direct", blocked: false, action: "list_servers" },
						{ tool: "mcp", route: "direct", blocked: false, action: "search" },
						{ tool: "mcp", route: "direct", blocked: false, action: "call" },
						{ tool: "run_code", route: "direct", blocked: false },
						{ tool: "mcp", route: "programmatic", blocked: false, action: "call" },
					],
				}),
				observation({ mode: "code-only", order: 3, calls: [{ tool: "mcp", route: "direct", blocked: false }] }),
			]),
		]);
		expect(report).toContain("| lookup | hybrid | 1 | 2.0 | 2 | 1 | 1 | 1 | 1 | 900 |");
		expect(report).toContain("| lookup | code-only | 1 | 1.0 | unknown | unknown | unknown | 0 | 0 | 100 |");
		expect(report).not.toContain("versus the direct baseline");
		expect(report).not.toContain("| model/a | direct |");
	});

	it("pairs code mode routes with the direct baseline of the same run, task, and trial", () => {
		// 100 + 120 + 140 input tokens against the route's single 120-token request.
		const three = [request({ usage: usage(80) }), request({ index: 2 }), request({ index: 3, usage: usage(120) })];
		const report = summarizeRoutingRuns([
			run([
				observation({ mode: "direct", elapsedMs: 200, requests: three }),
				observation({ mode: "hybrid", order: 1, elapsedMs: 100 }),
				observation({ mode: "direct", trial: 2, correct: false, requests: three }),
				observation({ mode: "hybrid", trial: 2, order: 1 }),
			]),
		]);
		expect(report).toContain(
			"| model/a | lookup | hybrid | 2/2 | 1/2 | 1 | 3.0 → 1.0 | -66.7% | -50.0% | 100 → 120 | 140 → 120 |",
		);
		expect(report).toContain("| model/a | all tasks | hybrid | | | 1 | | -66.7% | -50.0% | | |");
	});

	it("compares two experiments on matching cases and keeps behavior for every recorded case", () => {
		const three = [request(), request({ index: 2 }), request({ index: 3 })];
		const baseline = run(
			[
				observation({
					elapsedMs: 300,
					requests: three,
					calls: [{ tool: "mcp", route: "direct", blocked: false, action: "search" }],
				}),
				observation({ trial: 2, requests: three }),
			],
			{ runId: "old-run", experimentId: "old" },
		);
		const candidate = run(
			[
				observation({
					elapsedMs: 150,
					calls: [
						{ tool: "mcp", route: "direct", blocked: false, action: "list_servers" },
						{ tool: "mcp", route: "direct", blocked: false, action: "search" },
						{ tool: "run_code", route: "direct", blocked: false },
					],
				}),
				observation({ trial: 3 }),
			],
			{ runId: "new-run", experimentId: "new" },
		);
		const report = compareRoutingRuns([baseline], [candidate]);
		expect(report).toContain("Baseline: old; 1 runs; correct/recorded 2/2.");
		expect(report).toContain(
			"| model/a | lookup | hybrid | 2/2 → 2/2 | 1 | 3.0 → 1.0 | -66.7% | -50.0% | 0 → 1 | 1 → 2 | 0 → 1 |",
		);
		expect(report).toContain("| model/a | hybrid | 1 | 3 → 1 | -66.7% | 360 → 120 | -66.7% | -50.0% |");
		expect(() => compareRoutingRuns([baseline], [{ ...candidate, runId: "old-run" }])).toThrow("both sides");
		expect(() => compareRoutingRuns([baseline], [candidate, { ...candidate, runId: "again" }])).toThrow("repeats");
		expect(() => compareRoutingRuns([baseline], [{ ...candidate, mode: "self-test" }])).toThrow("live/self-test");
		expect(() => compareRoutingRuns([], [candidate])).toThrow("no runs");
	});

	it("rejects duplicate identities and incompatible experiments instead of double counting", () => {
		const source = run([observation()]);
		expect(() => summarizeRoutingRuns([source, structuredClone(source)])).toThrow("duplicate runId");
		expect(() => summarizeRoutingRuns([source, { ...source, runId: "other", experimentId: "different" }])).toThrow(
			"experimentId",
		);
		expect(() => summarizeRoutingRuns([source, { ...source, runId: "other", mode: "self-test" }])).toThrow(
			"live/self-test",
		);
		const invalidThinking = { ...source, runId: "other", thinking: "high" } as unknown as RoutingRun;
		expect(() => summarizeRoutingRuns([source, invalidThinking])).toThrow("thinking");
		expect(() => summarizeRoutingRuns([])).toThrow("no runs");
	});
});
