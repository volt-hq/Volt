import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAssistantMessageEventStream,
	createFauxProvider,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
} from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import { createCodeModeFixtures } from "../../benchmarks/code-mode-fixtures.ts";
import { createRealisticRoutingFixtures } from "../../benchmarks/code-mode-fixtures-realistic.ts";
import {
	ALL_ROUTING_MODES,
	ROUTING_MODES,
	type RoutingMode,
	runRoutingCase,
} from "../../benchmarks/code-mode-routing.ts";
import {
	createRoutingOutput,
	parseRoutingArgs,
	routingFixtureOrder,
	routingOrder,
	runRoutingCli,
	selectRoutingFixtures,
	subscriptionKey,
} from "../../benchmarks/code-mode-routing-cli.ts";
import { parseRoutingRun } from "../../benchmarks/code-mode-routing-report.ts";

function singleLookup() {
	return createCodeModeFixtures().find((fixture) => fixture.id === "single-lookup")!;
}

const directLookup = fauxAssistantMessage(
	[fauxToolCall("mcp", { action: "call", server: "fixture", tool: "get_service", arguments: { id: "build-cache" } })],
	{ stopReason: "toolUse" },
);

async function run(mode: RoutingMode, steps: FauxResponseStep[], limits = {}) {
	const faux = createFauxProvider();
	faux.setResponses(steps);
	return runRoutingCase(singleLookup(), mode, { model: faux.getModel(), streamFn: faux.streamSimple, limits });
}

// The model-free checks run the authored reference scripts through Volt's actual QuickJS and MCP paths.
describe("code-mode routing benchmark", () => {
	it.each(ROUTING_MODES)("executes every reference task through the real runtime in %s", async (mode) => {
		for (const fixture of createCodeModeFixtures()) {
			const faux = createFauxProvider();
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("run_code", { code: fixture.referenceCode })], {
					stopReason: "toolUse",
				}),
				(context) => {
					const result = context.messages.findLast((message) => message.role === "toolResult");
					expect(result?.isError).toBe(false);
					const text =
						result?.content
							.filter((part) => part.type === "text")
							.map((part) => part.text)
							.join("\n") ?? "";
					const marker = "Return value: ";
					expect(text).toContain(marker);
					return fauxAssistantMessage(text.slice(text.indexOf(marker) + marker.length).trim());
				},
			]);
			const result = await runRoutingCase(fixture, mode, { model: faux.getModel(), streamFn: faux.streamSimple });
			expect(result.status).toBe("completed");
			expect(result.correct, result.failure).toBe(true);
			expect(result.requests).toHaveLength(2);
			expect(result.requests.every((request) => request.reasoning === "xhigh")).toBe(true);
			expect(result.dataCalls.length).toBeGreaterThan(0);
			expect(result.dataCalls.every((call) => !call.failed)).toBe(true);
			expect(result.calls.some((call) => call.route === "programmatic" && call.tool === "mcp")).toBe(true);
			expect(result.calls.every((call) => !call.blocked)).toBe(true);
			expect(result.scriptFailures).toBe(0);
		}
	});

	it.each(ROUTING_MODES)("shows the intended schema and enforces direct invocation in %s", async (mode) => {
		let inspected = false;
		const result = await run(mode, [
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual(["mcp", "run_code"]);
				const mcp = context.tools?.find((tool) => tool.name === "mcp");
				const schema: { properties: { action: { anyOf: Array<{ const: string }> } } } = JSON.parse(
					JSON.stringify(mcp?.parameters),
				);
				const actions = schema.properties.action.anyOf.map((item) => item.const);
				expect(actions.includes("call")).toBe(mode !== "code-only");
				expect(actions).toContain("search");
				expect(actions).toContain("describe");
				expect(actions).toContain("read_cache");
				if (mode === "code-first") expect(context.systemPrompt).toContain("For the fixture's data-retrieval stage");
				inspected = true;
				return directLookup;
			},
			fauxAssistantMessage(JSON.stringify(singleLookup().expected)),
		]);
		expect(inspected).toBe(true);
		expect(result.calls[0]).toMatchObject({ tool: "mcp", route: "direct", blocked: mode === "code-only" });
		expect(result.dataCalls).toHaveLength(mode === "code-only" ? 0 : 1);
		expect(result.toolFailures).toBe(mode === "code-only" ? 1 : 0);
	});

	it("keeps discovery direct and its script binding usable in code-only mode", async () => {
		const fixture = singleLookup();
		const result = await run("code-only", [
			fauxAssistantMessage([fauxToolCall("mcp", { action: "describe", server: "fixture", tool: "get_service" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const message = context.messages.findLast((item) => item.role === "toolResult");
				expect(JSON.stringify(message?.content)).toContain("tools.mcp.fixture.get_service(args)");
				return fauxAssistantMessage([fauxToolCall("run_code", { code: fixture.referenceCode })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(JSON.stringify(fixture.expected)),
		]);
		expect(result.correct).toBe(true);
		expect(result.calls[0]).toEqual({ tool: "mcp", route: "direct", blocked: false, action: "describe" });
		expect(result.dataCalls).toHaveLength(1);
	});

	it("offers only the mcp tool, without code mode guidance, in the direct route", async () => {
		let inspected = false;
		const result = await run("direct", [
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual(["mcp"]);
				expect(context.systemPrompt).not.toContain("run_code");
				inspected = true;
				return directLookup;
			},
			fauxAssistantMessage(JSON.stringify(singleLookup().expected)),
		]);
		expect(inspected).toBe(true);
		expect(result.correct).toBe(true);
		expect(result.calls).toEqual([{ tool: "mcp", route: "direct", blocked: false, action: "call" }]);
	});

	it("stops admission before exceeding its request limit", async () => {
		const result = await run("hybrid", [directLookup, directLookup, fauxAssistantMessage("{}")], { requests: 1 });
		expect(result.requests).toHaveLength(1);
		expect(result.failure).toBe("request-limit");
		expect(result.status).toBe("failed");
	});

	it("blocks additional tool calls and counts repeated reads", async () => {
		const result = await run("hybrid", [directLookup, directLookup, directLookup, fauxAssistantMessage("{}")], {
			toolCalls: 2,
		});
		expect(result.dataCalls).toHaveLength(2);
		expect(result.repeatedDataCalls).toBe(1);
		expect(result.calls[2].blocked).toBe(true);
	});

	it("counts equivalent page requests despite omitted defaults and argument ordering", async () => {
		const faux = createFauxProvider();
		const fixture = createCodeModeFixtures().find((item) => item.id === "paginated-aggregate")!;
		const requests: Array<Record<string, number>> = [{}, { offset: 0, limit: 20 }, { limit: 20, offset: 0 }];
		faux.setResponses([
			...requests.map((args) =>
				fauxAssistantMessage(
					[fauxToolCall("mcp", { action: "call", server: "fixture", tool: "list_invoices", arguments: args })],
					{ stopReason: "toolUse" },
				),
			),
			fauxAssistantMessage("{}"),
		]);
		const result = await runRoutingCase(fixture, "hybrid", { model: faux.getModel(), streamFn: faux.streamSimple });
		expect(result.dataCalls).toHaveLength(3);
		expect(result.repeatedDataCalls).toBe(2);
	});

	it("does not hang if the provider ignores cancellation before returning its stream", async () => {
		const faux = createFauxProvider();
		const result = await runRoutingCase(singleLookup(), "hybrid", {
			model: faux.getModel(),
			streamFn: () => new Promise(() => {}),
			limits: { timeoutMs: 25 },
		});
		expect(result.failure).toBe("timeout");
		expect(result.status).toBe("failed");
	});

	it("redacts thrown provider diagnostics and records a request failure", async () => {
		const faux = createFauxProvider();
		const result = await runRoutingCase(singleLookup(), "hybrid", {
			model: faux.getModel(),
			streamFn: () => {
				throw new Error("synthetic-private-token");
			},
		});
		expect(result.failure).toBe("request-failed");
		expect(JSON.stringify(result)).not.toContain("synthetic-private-token");
	});

	it("does not report a wrong final answer as successful", async () => {
		const result = await run("hybrid", [fauxAssistantMessage("{}")]);
		expect(result.status).toBe("completed");
		expect(result.correct).toBe(false);
	});
});

describe("routing pilot admission", () => {
	it("defaults to a no-network plan and bounds live selections", () => {
		expect(parseRoutingArgs([])).toMatchObject({ mode: "dry-run", trials: 1 });
		expect(parseRoutingArgs(["--live", "--trials", "2"])).toMatchObject({ mode: "live", trials: 2 });
		for (const args of [
			["--live", "--self-test"],
			["--trials", "0"],
			["--trials", "51"],
			["--trials", "NaN"],
			["--trial-start", "0"],
			["--trial-start", "51"],
			["--trial-start", "50", "--trials", "2"],
			["--max-requests", "0"],
			["--max-tokens", "20000001"],
			["--minutes", "61"],
			["--seed", "4294967296"],
			["--report", "run", "--live"],
			["--report", "run", "--trials", "2"],
			["--model", "openai/gpt-6-astra"],
			["--model", "openai-codex/gpt-6-astra,anthropic/claude-opus-5-5"],
			["--task", "missing"],
			["--task", "single-lookup,missing"],
			["--task", "single-lookup,single-lookup"],
			["--suite", "real"],
			["--suite", "realistic", "--task", "single-lookup"],
			["--routes", "script"],
			["--routes", "hybrid,hybrid"],
			["--self-test", "--routes", "direct,hybrid"],
			["--baseline", "run"],
			["--live", "--report", "run", "--baseline", "other"],
			["--out"],
			["--live", "--live"],
		])
			expect(() => parseRoutingArgs(args)).toThrow();
	});

	it("accepts repeatable bounded batches and no-network report inputs", () => {
		expect(
			parseRoutingArgs([
				"--live",
				"--trials",
				"6",
				"--seed",
				"42",
				"--max-requests",
				"600",
				"--max-tokens",
				"2000000",
				"--minutes",
				"45",
			]),
		).toMatchObject({
			mode: "live",
			trials: 6,
			seed: 42,
			limits: { requests: 600, reportedTokens: 2_000_000, timeoutMs: 45 * 60_000 },
		});
		const report = parseRoutingArgs(["--report", "run-a", "--report", "run-b"]);
		expect(report.mode).toBe("report");
		expect(report.reports).toHaveLength(2);
		expect(parseRoutingArgs(["--help"]).mode).toBe("help");
		const compared = parseRoutingArgs(["--report", "new", "--baseline", "old-a", "--baseline", "old-b"]);
		expect(compared).toMatchObject({ mode: "report" });
		expect(compared.baselines).toHaveLength(2);
	});

	it("selects one model, a canonical route subset, and fixtures by suite or id", () => {
		const defaults = parseRoutingArgs([]);
		expect(defaults).toMatchObject({
			models: ["openai-codex/gpt-6-astra"],
			routes: [...ROUTING_MODES],
			suite: "core",
		});
		expect(selectRoutingFixtures(defaults).map((fixture) => fixture.id)).toEqual(
			createCodeModeFixtures().map((fixture) => fixture.id),
		);
		const selected = parseRoutingArgs([
			"--live",
			"--model",
			"anthropic/claude-opus-5-5",
			"--routes",
			"hybrid,direct",
		]);
		expect(selected).toMatchObject({ models: ["anthropic/claude-opus-5-5"], routes: ["direct", "hybrid"] });
		const realistic = createRealisticRoutingFixtures().map((fixture) => fixture.id);
		expect(selectRoutingFixtures(parseRoutingArgs(["--suite", "realistic"])).map((fixture) => fixture.id)).toEqual(
			realistic,
		);
		expect(selectRoutingFixtures(parseRoutingArgs(["--suite", "all"]))).toHaveLength(20 + realistic.length);
		expect(
			selectRoutingFixtures(parseRoutingArgs(["--task", "trace-scan,single-lookup"])).map((fixture) => fixture.id),
		).toEqual(["single-lookup", "trace-scan"]);
	});

	it("balances a route pair over two trials and all four routes over twenty-four", () => {
		const pair: RoutingMode[] = ["direct", "hybrid"];
		const orders = [1, 2, 3].map((trial) => routingOrder(trial, "trace-scan", 7, pair).join(","));
		expect(new Set(orders.slice(0, 2))).toEqual(new Set(["direct,hybrid", "hybrid,direct"]));
		expect(orders[2]).toBe(orders[0]);
		const all = Array.from({ length: 24 }, (_, index) => routingOrder(index + 1, "trace-scan", 7, ALL_ROUTING_MODES));
		expect(new Set(all.map((order) => order.join(","))).size).toBe(24);
		for (const mode of ALL_ROUTING_MODES)
			for (let position = 0; position < 4; position++)
				expect(all.filter((order) => order[position] === mode)).toHaveLength(6);
		expect(routingOrder(1, "trace-scan", 7, ["hybrid"])).toEqual(["hybrid"]);
	});

	it("continues past a case that exhausts its own request limit", async () => {
		const root = await mkdtemp(join(tmpdir(), "routing-continue-test-"));
		let admitted = 0;
		try {
			const out = join(root, "run");
			const result = await runRoutingCli(
				parseRoutingArgs(["--self-test", "--task", "single-lookup", "--out", out]),
				(fixture, mode, options) =>
					runRoutingCase(fixture, mode, { ...options, ...(admitted++ === 0 ? { limits: { requests: 1 } } : {}) }),
			);
			expect(result.failed).toBe(true);
			const saved = parseRoutingRun(JSON.parse(await readFile(join(out, "results.json"), "utf8")));
			expect(saved.cases.map((item) => item.failure)).toEqual(["request-limit", undefined, undefined]);
			expect(saved).not.toHaveProperty("stopReason");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("deterministically varies task order without losing or repeating tasks", () => {
		const ids = createCodeModeFixtures().map((fixture) => fixture.id);
		const order = routingFixtureOrder(ids, 1, 1);
		expect(order).toEqual(routingFixtureOrder(ids, 1, 1));
		expect([...order].sort()).toEqual([...ids].sort());
		expect(order).not.toEqual(routingFixtureOrder(ids, 2, 1));
		expect(order).not.toEqual(routingFixtureOrder(ids, 1, 2));
	});

	it("retains the complete schedule when six trials are split across bounded batches", () => {
		const batches = [1, 3, 5].map((start) =>
			parseRoutingArgs(["--dry-run", "--trials", "2", "--trial-start", String(start)]),
		);
		for (const fixture of createCodeModeFixtures()) {
			const split = batches.flatMap((batch) =>
				Array.from({ length: batch.trials }, (_, i) => routingOrder(batch.trialStart + i, fixture.id, batch.seed)),
			);
			expect(split).toEqual(Array.from({ length: 6 }, (_, i) => routingOrder(i + 1, fixture.id, 1)));
		}
	});

	it("balances all route positions and pairwise order over every six trials", () => {
		for (const fixture of createCodeModeFixtures()) {
			const orders = Array.from({ length: 6 }, (_, index) => routingOrder(index + 1, fixture.id, 42));
			expect(new Set(orders.map((order) => order.join(","))).size).toBe(6);
			for (const mode of ROUTING_MODES) {
				for (let position = 0; position < 3; position++)
					expect(orders.filter((order) => order[position] === mode)).toHaveLength(2);
				for (const other of ROUTING_MODES.filter((item) => item !== mode)) {
					expect(orders.filter((order) => order.indexOf(mode) < order.indexOf(other))).toHaveLength(3);
				}
			}
			expect(routingOrder(1, fixture.id, 42)).toEqual(routingOrder(7, fixture.id, 42));
			expect(routingOrder(1, fixture.id, 42)).toEqual(orders[0]);
		}
	});

	it("persists trial/order/run identities and enforces a whole-batch request cap", async () => {
		const root = await mkdtemp(join(tmpdir(), "routing-batch-test-"));
		try {
			const out = join(root, "run");
			const result = await runRoutingCli(
				parseRoutingArgs([
					"--self-test",
					"--task",
					"single-lookup",
					"--trials",
					"6",
					"--trial-start",
					"3",
					"--max-requests",
					"4",
					"--out",
					out,
				]),
			);
			expect(result.failed).toBe(true);
			const payload: unknown = JSON.parse(await readFile(join(out, "results.json"), "utf8"));
			expect(payload).toMatchObject({
				format: 2,
				status: "failed-or-incomplete",
				stopReason: "run-budget",
				requests: 4,
				plannedCases: 18,
				trialStart: 3,
			});
			const saved = parseRoutingRun(payload);
			expect(saved.runId).toEqual(expect.any(String));
			expect(saved.experimentId).toMatch(/^[a-f0-9]{64}$/);
			expect(saved.cases).toHaveLength(2);
			expect(saved.cases.map((item: { trial: number; order: number }) => [item.trial, item.order])).toEqual([
				[3, 0],
				[3, 1],
			]);
			const report = await runRoutingCli(parseRoutingArgs(["--report", out]));
			expect(report.failed).toBe(false);
			await expect(runRoutingCli(parseRoutingArgs(["--report", out, "--report", out]))).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not accept API keys or expired subscription credentials", () => {
		expect(() => subscriptionKey({ get: () => undefined }, "openai-codex")).toThrow("auth-unavailable");
		expect(() => subscriptionKey({ get: () => ({ type: "api_key", key: "synthetic" }) }, "anthropic")).toThrow(
			"auth-unavailable",
		);
		expect(() =>
			subscriptionKey(
				{ get: () => ({ type: "oauth", access: "synthetic", refresh: "synthetic", expires: 0 }) },
				"anthropic",
			),
		).toThrow("auth-expired");
	});

	it("stops the whole pilot after an oversized provider stream that ignores cancellation", async () => {
		const root = await mkdtemp(join(tmpdir(), "routing-stop-test-"));
		let admittedCases = 0;
		try {
			const result = await runRoutingCli(
				parseRoutingArgs(["--self-test", "--out", join(root, "run")]),
				async (fixture, mode, options) => {
					admittedCases++;
					return runRoutingCase(fixture, mode, {
						...options,
						limits: { responseChars: 1 },
						streamFn: () => {
							const stream = createAssistantMessageEventStream();
							stream.push({
								type: "text_delta",
								seq: 1,
								contentIndex: 0,
								delta: "too long",
								snapshot: fauxAssistantMessage("too long"),
								toolState: [],
							});
							return stream; // Never settles, and deliberately ignores the caller's signal.
						},
					});
				},
			);
			expect(result.failed).toBe(true);
			expect(admittedCases).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("never writes artifacts in the repository or overwrites an existing run", async () => {
		const root = await mkdtemp(join(tmpdir(), "routing-output-test-"));
		try {
			const repo = join(root, "repo");
			await mkdir(repo);
			await expect(createRoutingOutput(join(repo, "run"), repo)).rejects.toThrow("outside");
			await createRoutingOutput(join(root, "run"), repo);
			await expect(createRoutingOutput(join(root, "run"), repo)).rejects.toThrow();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
