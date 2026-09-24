/**
 * Run from the repository root:
 * node --experimental-strip-types --conditions volt-source packages/coding-agent/benchmarks/mcp-discovery.ts
 * Optional: --sizes 50,500,5000 --budgets 4096,8192,16384 --repetitions 5
 * No provider, subprocess MCP server, credentials, or network are used.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	hashMcpServerConfig,
	mergeMcpConfigFile,
	serverMatchesToolFilters,
	serverTrustsToolRead,
	sourceForMcpConfigPath,
} from "../src/core/mcp/config.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../src/core/mcp/metadata-cache.ts";
import { McpOutputStore } from "../src/core/mcp/output-store.ts";
import { classifyMcpToolRisk, isMcpToolTrustedReadCandidate } from "../src/core/mcp/safety.ts";
import { McpSearchIndex, searchMcpMetadata } from "../src/core/mcp/search.ts";
import type { McpClientConnection, McpGatewayInput, McpSearchMatch } from "../src/core/mcp/types.ts";
import { createDiscoveryCatalog, type DiscoveryCatalog, type DiscoveryQuery } from "./mcp-discovery-fixtures.ts";

export type DiscoveryCacheState = "cold" | "warm" | "stale";
type RankingOptions = Parameters<typeof searchMcpMetadata>[0];
const HARD_OUTPUT_BYTES = 51_200;

/** Frozen ranking/output construction from search.ts at 6e4d14862, before the discovery follow-up. */
export function rankLegacySubstring(options: RankingOptions): McpSearchMatch[] {
	const tokens = options.query
		.toLowerCase()
		.split(/[^a-z0-9_]+/)
		.filter(Boolean);
	if (tokens.length === 0) return [];
	const matches: McpSearchMatch[] = [];
	for (const metadata of options.metadata) {
		// Apply the same caller scope to both rankers; this is not a historical gateway API comparison.
		if (options.server !== undefined && options.server !== metadata.server) continue;
		const server = options.servers[metadata.server];
		if (!server?.enabled) continue;
		for (const tool of metadata.tools) {
			if (!serverMatchesToolFilters(server, tool.name)) continue;
			const title = tool.title ?? tool.name;
			let score = 0;
			for (const token of tokens) {
				if (tool.name.toLowerCase() === token) score += 20;
				if (tool.name.toLowerCase().includes(token)) score += 8;
				if (title.toLowerCase().includes(token)) score += 5;
				if ((tool.description ?? "").toLowerCase().includes(token)) score += 2;
			}
			if (score <= 0) continue;
			const summary = (tool.description ?? "").replace(/\s+/g, " ").trim();
			matches.push({
				server: metadata.server,
				tool: tool.name,
				title,
				summary: !summary ? "No description." : summary.length <= 180 ? summary : `${summary.slice(0, 177)}...`,
				risk: classifyMcpToolRisk(tool),
				trustedRead: serverTrustsToolRead(server, tool.name) && isMcpToolTrustedReadCandidate(tool),
				metadataHash: metadata.metadataHash,
				call: `mcp({"action":"call","server":"${metadata.server}","tool":"${tool.name}","arguments":{...}})`,
				describe: `mcp({"action":"describe","server":"${metadata.server}","tool":"${tool.name}"})`,
				score,
			});
		}
	}
	const limit =
		options.limit === undefined || !Number.isFinite(options.limit)
			? 8
			: Math.max(1, Math.min(20, Math.floor(options.limit)));
	return matches
		.sort((a, b) => b.score - a.score || a.server.localeCompare(b.server) || a.tool.localeCompare(b.tool))
		.slice(0, limit);
}

/** Macro recall uses all labeled relevant tools as the denominator, not min(k, relevant). */
export function recallAt(relevant: readonly string[], ranked: readonly string[], k: number): number | undefined {
	const expected = new Set(relevant);
	if (expected.size === 0) return undefined;
	const found = new Set(ranked.slice(0, k).filter((id) => expected.has(id)));
	return found.size / expected.size;
}

export function evaluateDiscoveryRanking(
	queries: readonly DiscoveryQuery[],
	rank: (query: DiscoveryQuery) => readonly string[],
) {
	const cases = queries.map((query) => {
		const ranked = [...rank(query)];
		return {
			id: query.id,
			query: query.query,
			relevant: query.relevant,
			ranked,
			recallAt1: recallAt(query.relevant, ranked, 1),
			recallAt5: recallAt(query.relevant, ranked, 5),
			recallAt8: recallAt(query.relevant, ranked, 8),
		};
	});
	const relevantCases = cases.filter((entry) => entry.relevant.length > 0);
	const absentCases = cases.filter((entry) => entry.relevant.length === 0);
	return {
		recallAt1: relevantCases.reduce((sum, entry) => sum + (entry.recallAt1 ?? 0), 0) / relevantCases.length,
		recallAt5: relevantCases.reduce((sum, entry) => sum + (entry.recallAt5 ?? 0), 0) / relevantCases.length,
		recallAt8: relevantCases.reduce((sum, entry) => sum + (entry.recallAt8 ?? 0), 0) / relevantCases.length,
		absentCapabilityAccuracy: absentCases.length
			? absentCases.filter((entry) => entry.ranked.length === 0).length / absentCases.length
			: undefined,
		cases,
	};
}

export interface DiscoveryStep {
	action: McpGatewayInput["action"];
	bytes: number;
	heuristicTokens: number;
	durationMs: number;
	truncated: boolean;
}

export function summarizeDiscoverySteps(steps: readonly DiscoveryStep[]) {
	return {
		calls: steps.length,
		finalOutputBytes: steps.reduce((total, step) => total + step.bytes, 0),
		heuristicTokens: steps.reduce((total, step) => total + step.heuristicTokens, 0),
		durationMs: steps.reduce((total, step) => total + step.durationMs, 0),
		truncatedResponses: steps.filter((step) => step.truncated).length,
		cacheContinuations: steps.filter((step) => step.action === "read_cache").length,
		steps,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createDiscoveryBenchmarkFixture(catalog: DiscoveryCatalog, state: DiscoveryCacheState = "warm") {
	const directory = mkdtempSync(join(tmpdir(), "volt-mcp-discovery-"));
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			settings: { maxOutputBytes: HARD_OUTPUT_BYTES, maxOutputLines: 2000 },
			servers: Object.fromEntries(
				catalog.servers.map((server) => [server.id, { command: "unused-synthetic-mcp", lifecycle: "keep-alive" }]),
			),
		},
		sourceForMcpConfigPath(join(directory, "mcp.json"), {
			scope: "user",
			label: "benchmark",
			precedence: 1,
			shared: false,
		}),
	);
	const config = finalizeMcpConfig(merged);
	let cacheTime = Date.now() - (state === "stale" ? 2 * 24 * 60 * 60 * 1000 : 0);
	const cache = new McpMetadataCache({ agentDir: directory, maxBytes: 64 * 1024 * 1024, now: () => cacheTime });
	if (state !== "cold") {
		for (const server of catalog.servers) {
			cache.set(
				server.id,
				{
					server: server.id,
					serverVersion: `${server.id}@1`,
					configHash: hashMcpServerConfig(config.servers[server.id]),
					tools: server.tools,
					resources: [],
					prompts: [],
				},
				["tools", "resources", "prompts"],
			);
		}
	}
	cacheTime = Date.now();
	const transport = { connects: 0, toolPages: 0 };
	const manager = new McpManager({
		config,
		metadataCache: cache,
		outputStore: new McpOutputStore({
			agentDir: directory,
			sessionId: "discovery-benchmark",
			workspaceId: "synthetic",
			maxOutputBytes: HARD_OUTPUT_BYTES,
			maxOutputLines: 2000,
		}),
		clientFactory: {
			connect: async (server) => {
				transport.connects++;
				const tools = catalog.servers.find((entry) => entry.id === server.id)!.tools;
				const connection: McpClientConnection = {
					getServerVersion: () => ({ name: server.id, version: "1" }),
					listTools: async (params) => {
						transport.toolPages++;
						const start = Number(params?.cursor ?? 0);
						const end = Math.min(tools.length, start + 100);
						return { tools: tools.slice(start, end), ...(end < tools.length ? { nextCursor: String(end) } : {}) };
					},
					listResources: async () => ({ resources: [] }),
					listPrompts: async () => ({ prompts: [] }),
					readResource: async () => {
						throw new Error("Benchmark does not read resources");
					},
					getPrompt: async () => {
						throw new Error("Benchmark does not read prompts");
					},
					callTool: async () => {
						throw new Error("Benchmark does not invoke external tools");
					},
					close: async () => undefined,
				};
				return connection;
			},
		},
	});
	const execute = async (input: McpGatewayInput) => {
		const started = performance.now();
		// These are exactly the success-path operations used by the model gateway.
		const result = await manager.handleGatewayInput(input, { mode: "unknown", caller: "model" });
		const formatted = manager.formatGatewayResult(input.action, result);
		const durationMs = performance.now() - started;
		const bytes = Buffer.byteLength(formatted.text);
		if (bytes > HARD_OUTPUT_BYTES) throw new Error(`Gateway exceeded hard output budget: ${bytes}`);
		const data: unknown = JSON.parse(formatted.text);
		if (!isRecord(data)) throw new Error("Expected an MCP gateway object");
		if (data.isError === true) throw new Error(`Gateway action failed: ${formatted.text}`);
		const step: DiscoveryStep = {
			action: input.action,
			bytes,
			heuristicTokens: Math.ceil(bytes / 4),
			durationMs,
			truncated: isRecord(data.truncation) && data.truncation.truncated === true,
		};
		return { data, text: formatted.text, step };
	};
	const executeComplete = async (input: McpGatewayInput) => {
		const response = await execute(input);
		const steps = [response.step];
		if (!response.step.truncated) return { data: response.data, steps };
		const reference = response.data.cache;
		if (!isRecord(reference) || typeof reference.id !== "string")
			throw new Error("Truncated benchmark output was not cached");
		let cursor: string | undefined;
		let restored = "";
		const seen = new Set<string>();
		do {
			const page = await execute({ action: "read_cache", cacheId: reference.id, cursor });
			steps.push(page.step);
			if (typeof page.data.content !== "string") throw new Error("Expected cache text");
			restored += page.data.content;
			cursor = typeof page.data.nextCursor === "string" ? page.data.nextCursor : undefined;
			if (cursor && seen.has(cursor)) throw new Error("Cache cursor did not advance");
			if (cursor) seen.add(cursor);
		} while (cursor);
		const data: unknown = JSON.parse(restored);
		if (!isRecord(data)) throw new Error("Expected restored gateway JSON");
		return { data, steps };
	};
	return {
		manager,
		cache,
		config,
		transport,
		execute,
		executeComplete,
		async cleanup() {
			await manager.dispose();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

async function measureDiscoveryWorkflows(catalog: DiscoveryCatalog, state: DiscoveryCacheState, budget: number) {
	const fixture = createDiscoveryBenchmarkFixture(catalog, state);
	const query = catalog.queries.find((entry) => entry.id === "repository-task")!;
	try {
		const input: McpGatewayInput = { action: "search", query: query.query, limit: 8, maxBytes: budget };
		const first = await fixture.executeComplete(input);
		const preparation: DiscoveryStep[] = [];
		if (state !== "warm") {
			preparation.push(...first.steps);
			for (const server of catalog.servers) {
				const connected = await fixture.executeComplete({ action: "connect", server: server.id });
				preparation.push(...connected.steps);
			}
		}
		const search = state === "warm" ? first : await fixture.executeComplete(input);
		const top = Array.isArray(search.data.matches) ? search.data.matches[0] : undefined;
		if (!isRecord(top) || typeof top.server !== "string" || typeof top.tool !== "string")
			throw new Error("Benchmark query returned no tool");
		const correct = query.relevant.includes(`${top.server}/${top.tool}`);
		const described = await fixture.executeComplete({ action: "describe", server: top.server, tool: top.tool });
		const withSchema = await fixture.executeComplete({ ...input, includeSchema: true });
		const selected = withSchema.data.selectedTool;
		const needsDescribe = !isRecord(selected);
		if (
			isRecord(selected) &&
			(selected.server !== top.server || selected.tool !== top.tool || !isRecord(selected.inputSchema))
		) {
			throw new Error("Search returned a different or incomplete selected-tool schema");
		}
		const searchDescribe = summarizeDiscoverySteps([...preparation, ...search.steps, ...described.steps]);
		const searchWithSchema = summarizeDiscoverySteps([
			...preparation,
			...withSchema.steps,
			...(needsDescribe ? described.steps : []),
		]);
		return {
			state,
			budget,
			query: query.query,
			correct,
			initialCoverage: first.data.coverage,
			initialMatches: Array.isArray(first.data.matches) ? first.data.matches.length : 0,
			searchDescribe,
			searchWithSchema: { ...searchWithSchema, schemaIncluded: !needsDescribe },
			transport: fixture.transport,
		};
	} finally {
		await fixture.cleanup();
	}
}

async function measureCompleteListing(catalog: DiscoveryCatalog, state: DiscoveryCacheState, budget: number) {
	const fixture = createDiscoveryBenchmarkFixture(catalog, state);
	try {
		const steps: DiscoveryStep[] = [];
		const tools = new Set<string>();
		for (const server of catalog.servers) {
			let cursor: string | undefined;
			const seen = new Set<string>();
			do {
				const page = await fixture.executeComplete({
					action: "list_tools",
					server: server.id,
					limit: 100,
					maxBytes: budget,
					cursor,
				});
				steps.push(...page.steps);
				if (!Array.isArray(page.data.tools)) throw new Error("Expected structured tool listing");
				for (const tool of page.data.tools) {
					if (!isRecord(tool) || typeof tool.name !== "string") throw new Error("Expected tool name");
					const id = `${server.id}/${tool.name}`;
					if (tools.has(id)) throw new Error(`Duplicate listed tool: ${id}`);
					tools.add(id);
				}
				cursor = typeof page.data.nextCursor === "string" ? page.data.nextCursor : undefined;
				if (cursor && seen.has(cursor)) throw new Error("Listing cursor did not advance");
				if (cursor) seen.add(cursor);
			} while (cursor);
		}
		const expected = catalog.servers.reduce((count, server) => count + server.tools.length, 0);
		if (tools.size !== expected) throw new Error(`Listing returned ${tools.size}/${expected} tools`);
		const described = await fixture.executeComplete({
			action: "describe",
			server: "github",
			tool: "list_pull_requests",
		});
		steps.push(...described.steps);
		return { ...summarizeDiscoverySteps(steps), listedTools: tools.size, transport: fixture.transport };
	} finally {
		await fixture.cleanup();
	}
}

function measureRepeated(operation: () => unknown, repetitions: number) {
	const samples: number[] = [];
	for (let index = 0; index < repetitions; index++) {
		const started = performance.now();
		operation();
		samples.push(performance.now() - started);
	}
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		medianMs: sorted[Math.floor(sorted.length / 2)],
		minMs: sorted[0],
		maxMs: sorted[sorted.length - 1],
		samples,
	};
}

export async function runDiscoveryBenchmark(options: { sizes: number[]; budgets: number[]; repetitions: number }) {
	if (!Number.isInteger(options.repetitions) || options.repetitions < 1)
		throw new Error("Repetitions must be a positive integer");
	if (options.budgets.some((budget) => !Number.isInteger(budget) || budget < 1024 || budget > HARD_OUTPUT_BYTES))
		throw new Error("Budgets must be integers between 1024 and 51200");
	const catalogs = [];
	for (const size of options.sizes) {
		const catalog = createDiscoveryCatalog(size);
		const fixture = createDiscoveryBenchmarkFixture(catalog);
		let ranking;
		try {
			const metadata = fixture.cache.getAll();
			const rankOptions = (query: DiscoveryQuery): RankingOptions => ({
				query: query.query,
				limit: 8,
				server: query.server,
				servers: fixture.config.servers,
				metadata,
			});
			const prepared = new McpSearchIndex();
			prepared.search(rankOptions(catalog.queries[0]));
			ranking = {
				legacySubstring: evaluateDiscoveryRanking(catalog.queries, (query) =>
					rankLegacySubstring(rankOptions(query)).map((match) => `${match.server}/${match.tool}`),
				),
				current: evaluateDiscoveryRanking(catalog.queries, (query) =>
					fixture.manager
						.search(query.query, 8, query.server)
						.matches.map((match) => `${match.server}/${match.tool}`),
				),
				latency: {
					legacyRankAllQueries: measureRepeated(
						() => catalog.queries.forEach((query) => rankLegacySubstring(rankOptions(query))),
						options.repetitions,
					),
					uncachedCurrentRankAllQueries: measureRepeated(
						() => catalog.queries.forEach((query) => searchMcpMetadata(rankOptions(query))),
						options.repetitions,
					),
					coldIndexFirstQuery: measureRepeated(
						() => new McpSearchIndex().search(rankOptions(catalog.queries[0])),
						options.repetitions,
					),
					warmIndexAllQueries: measureRepeated(
						() => catalog.queries.forEach((query) => prepared.search(rankOptions(query))),
						options.repetitions,
					),
					fullMetadataCacheClone: measureRepeated(() => fixture.cache.getAll(), options.repetitions),
					discoveryProjectionClone: measureRepeated(
						() => catalog.servers.map((server) => fixture.cache.getDiscovery(server.id)),
						options.repetitions,
					),
					warmManagerSearchAllQueries: measureRepeated(
						() => catalog.queries.forEach((query) => fixture.manager.search(query.query, 8, query.server)),
						options.repetitions,
					),
				},
				metadataSerializedBytes: Buffer.byteLength(JSON.stringify(metadata)),
				discoveryProjectionSerializedBytes: Buffer.byteLength(
					JSON.stringify(catalog.servers.map((server) => fixture.cache.getDiscovery(server.id))),
				),
			};
		} finally {
			await fixture.cleanup();
		}
		const scenarios = [];
		for (const budget of options.budgets) {
			for (const state of ["cold", "warm", "stale"] as const) {
				const search = await measureDiscoveryWorkflows(catalog, state, budget);
				const completeListDescribe = await measureCompleteListing(catalog, state, budget);
				scenarios.push({ ...search, completeListDescribe });
			}
		}
		catalogs.push({ size, ranking, scenarios });
	}
	return {
		benchmark: "mcp-discovery",
		node: process.version,
		platform: process.platform,
		options,
		notes: [
			"Synthetic hand-labeled diagnostic catalogs, including identifier and Unicode tokenizer cases; recall is retrieval recall, not representative model task completion or argument accuracy.",
			"Legacy substring ranking is frozen from 6e4d14862. Both ranking variants use the same optional server scope and exclude cache cloning from their rank-only timings.",
			"Current retrieval recall uses manager.search. Cold-index timing includes preparation plus one query; warm-index timing covers all queries after preparation. Warm-manager timing also includes projection retrieval, freshness and config checks.",
			"Workflows execute the actual current manager and final gateway formatter with an in-memory, paginated MCP transport. No model inference or network is measured.",
			"finalOutputBytes sums every response envelope, including connect notices, repeated search, describe, and any cache continuations; it is not total API request or conversation tokens.",
			"heuristicTokens is the sum of ceil(UTF-8 response bytes / 4), not tokenizer counts or billed tokens.",
			"Cold has no metadata; stale metadata is two days old. Search does not connect automatically: simulated workflows explicitly connect all catalog servers after the initial notice.",
			"Soft budgets apply to discovery responses; the independent hard output bound remains 51200 bytes. Complete listing requests up to 100 items per page to exercise byte budgets, reads every server, then describes the search target once.",
			"Metadata persistence capacity is explicitly 64 MiB so catalog eviction cannot invalidate the size comparison. All timings are local samples, not pass/fail thresholds.",
			"Provider-native loading and programmatic calling require a separate model-backed evaluation; no effectiveness or token savings are fabricated here.",
		],
		catalogs,
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const { values } = parseArgs({
		options: {
			sizes: { type: "string", default: "50,500,5000" },
			budgets: { type: "string", default: "4096,8192,16384" },
			repetitions: { type: "string", default: "5" },
		},
	});
	const report = await runDiscoveryBenchmark({
		sizes: values.sizes.split(",").map(Number),
		budgets: values.budgets.split(",").map(Number),
		repetitions: Number(values.repetitions),
	});
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
