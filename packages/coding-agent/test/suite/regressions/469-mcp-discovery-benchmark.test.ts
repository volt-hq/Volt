import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import {
	createDiscoveryBenchmarkFixture,
	evaluateDiscoveryRanking,
	rankLegacySubstring,
	recallAt,
	runDiscoveryBenchmark,
	summarizeDiscoverySteps,
} from "../../../benchmarks/mcp-discovery.ts";
import { createDiscoveryCatalog } from "../../../benchmarks/mcp-discovery-fixtures.ts";
import { createMcpTool } from "../../../src/core/mcp/gateway-tool.ts";
import { createHarness, getMessageText } from "../harness.ts";

describe("#469 MCP discovery benchmark", () => {
	it("keeps catalog sizes, labels, and distractors deterministic", () => {
		for (const size of [50, 500, 5000]) {
			const catalog = createDiscoveryCatalog(size);
			const names = catalog.servers.flatMap((server) => server.tools.map((tool) => `${server.id}/${tool.name}`));
			expect(names).toHaveLength(size);
			expect(new Set(names).size).toBe(size);
			expect(createDiscoveryCatalog(size)).toEqual(catalog);
			for (const query of catalog.queries) {
				for (const id of query.relevant) expect(names).toContain(id);
			}
		}
		expect(() => createDiscoveryCatalog(1)).toThrow("at least");
	});

	it("calculates recall without counting duplicates or absent capabilities as successes", () => {
		expect(recallAt(["a", "b"], ["a", "a", "b"], 1)).toBe(0.5);
		expect(recallAt(["a", "b"], ["a", "a", "b"], 2)).toBe(0.5);
		expect(recallAt(["a", "b"], ["a", "a", "b"], 5)).toBe(1);
		expect(recallAt([], [], 1)).toBeUndefined();
		const result = evaluateDiscoveryRanking(
			[
				{ id: "multi", query: "multi", relevant: ["a", "b"] },
				{ id: "single", query: "single", relevant: ["c"] },
				{ id: "absent", query: "absent", relevant: [] },
			],
			(query) => (query.id === "multi" ? ["a", "b"] : query.id === "single" ? ["c"] : ["wrong"]),
		);
		expect(result.recallAt1).toBe(0.75);
		expect(result.recallAt5).toBe(1);
		expect(result.recallAt8).toBe(1);
		expect(result.absentCapabilityAccuracy).toBe(0);
	});

	it("pins the pre-change substring scorer independently of current ranking", async () => {
		const fixture = createDiscoveryBenchmarkFixture(createDiscoveryCatalog(50));
		try {
			const options = {
				query: "run_simulator_tests",
				servers: fixture.config.servers,
				metadata: fixture.cache.getAll(),
			};
			const matches = rankLegacySubstring(options);
			expect(matches[0]).toMatchObject({ server: "xcode", tool: "run_simulator_tests", score: 28 });
			expect(rankLegacySubstring({ ...options, query: "quasar ephemeris" })).toEqual([]);
			expect(rankLegacySubstring({ ...options, query: "read", limit: 1 })).toHaveLength(1);
		} finally {
			await fixture.cleanup();
		}
	});

	it("accounts for each final response, including cache reads and per-response heuristic rounding", () => {
		const steps = [
			{ action: "search" as const, bytes: 9, heuristicTokens: 3, durationMs: 2, truncated: true },
			{ action: "read_cache" as const, bytes: 10, heuristicTokens: 3, durationMs: 3, truncated: false },
		];
		expect(summarizeDiscoverySteps(steps)).toEqual({
			calls: 2,
			finalOutputBytes: 19,
			heuristicTokens: 6,
			durationMs: 5,
			truncatedResponses: 1,
			cacheContinuations: 1,
			steps,
		});
	});

	it("runs cold, warm, and stale workflows through actual bounded discovery output", async () => {
		const report = await runDiscoveryBenchmark({ sizes: [50], budgets: [4096, 8192], repetitions: 1 });
		expect(report.catalogs).toHaveLength(1);
		const catalog = report.catalogs[0];
		expect(catalog.ranking.current.cases).toHaveLength(16);
		expect(catalog.ranking.current.recallAt8).toBeGreaterThanOrEqual(0);
		expect(catalog.ranking.current.recallAt8).toBeLessThanOrEqual(1);
		expect(catalog.scenarios).toHaveLength(6);
		for (const scenario of catalog.scenarios) {
			expect(scenario.correct).toBe(true);
			expect(scenario.completeListDescribe.listedTools).toBe(50);
			expect(scenario.searchWithSchema.schemaIncluded).toBe(scenario.budget >= 8192);
			if (scenario.state === "warm") {
				expect(scenario.initialMatches).toBeGreaterThan(0);
				expect(scenario.transport.connects).toBe(0);
				expect(scenario.initialCoverage).toMatchObject({ missingServers: [], staleServers: [] });
			} else {
				expect(scenario.initialMatches).toBe(0);
				expect(scenario.transport.connects).toBe(3);
				expect(scenario.initialCoverage).toMatchObject({
					searchedServers: [],
					[scenario.state === "cold" ? "missingServers" : "staleServers"]: expect.arrayContaining([
						"xcode",
						"github",
						"grafana",
					]),
				});
			}
			for (const workflow of [scenario.searchDescribe, scenario.searchWithSchema, scenario.completeListDescribe]) {
				expect(workflow.finalOutputBytes).toBe(workflow.steps.reduce((sum, step) => sum + step.bytes, 0));
				expect(workflow.heuristicTokens).toBe(
					workflow.steps.reduce((sum, step) => sum + Math.ceil(step.bytes / 4), 0),
				);
				for (const step of workflow.steps) {
					expect(step.bytes).toBeLessThanOrEqual(51200);
					if (step.action === "list_tools" || step.action === "search")
						expect(step.bytes).toBeLessThanOrEqual(scenario.budget);
				}
			}
		}
	});

	it("includes real cache continuations when a selected schema exceeds the hard budget", async () => {
		const catalog = createDiscoveryCatalog(50);
		const tool = catalog.servers[0].tools[0];
		tool.inputSchema = {
			type: "object",
			properties: { payload: { type: "string", description: '"\\漢字𝄞'.repeat(10000) } },
		};
		const fixture = createDiscoveryBenchmarkFixture(catalog);
		try {
			const response = await fixture.executeComplete({ action: "describe", server: "xcode", tool: tool.name });
			expect(response.data.inputSchema).toEqual(tool.inputSchema);
			expect(response.steps[0].truncated).toBe(true);
			expect(response.steps.some((step) => step.action === "read_cache")).toBe(true);
			for (const step of response.steps) expect(step.bytes).toBeLessThanOrEqual(51200);
		} finally {
			await fixture.cleanup();
		}
	});

	it("measures the same final text that the faux provider receives", async () => {
		const fixture = createDiscoveryBenchmarkFixture(createDiscoveryCatalog(50));
		const harness = await createHarness({
			tools: [createMcpTool({ manager: fixture.manager })],
			settings: { compaction: { enabled: false } },
		});
		try {
			const input = { action: "search" as const, query: "run simulator tests", maxBytes: 4096, includeSchema: true };
			const measured = await fixture.execute(input);
			let checked = false;
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("mcp", input)], { stopReason: "toolUse" }),
				(context) => {
					const output = context.messages.find((message) => message.role === "toolResult");
					expect(getMessageText(output)).toBe(measured.text);
					expect(Buffer.byteLength(getMessageText(output))).toBe(measured.step.bytes);
					checked = true;
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("Find the simulator test tool.");
			expect(checked).toBe(true);
		} finally {
			await harness.cleanupAsync();
			await fixture.cleanup();
		}
	});
});
