import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	hashMcpServerConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../../../src/core/mcp/config.ts";
import {
	McpMetadataCache,
	type McpMetadataCacheOptions,
	toMcpDiscoveryMetadata,
} from "../../../src/core/mcp/metadata-cache.ts";
import { McpSearchIndex, searchMcpMetadata } from "../../../src/core/mcp/search.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
});

async function createFixture(
	toolsByServer: Record<string, Tool[]>,
	options: Omit<McpMetadataCacheOptions, "agentDir"> = {},
) {
	const harness = await createHarness();
	harnesses.push(harness);
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			servers: Object.fromEntries(
				Object.keys(toolsByServer).map((server) => [
					server,
					{
						command: "unused-fake-server",
						trustedReads: { tools: toolsByServer[server].map((tool) => tool.name) },
					},
				]),
			),
		},
		sourceForMcpConfigPath(join(harness.tempDir, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		}),
	);
	const config = finalizeMcpConfig(merged);
	const cache = new McpMetadataCache({ agentDir: harness.tempDir, ...options });
	for (const [server, tools] of Object.entries(toolsByServer)) {
		cache.set(
			server,
			{
				server,
				serverVersion: "fixture@1",
				configHash: hashMcpServerConfig(config.servers[server]),
				tools,
				resources: [],
				prompts: [],
			},
			["tools", "resources", "prompts"],
		);
	}
	const search = (query: string, server?: string, limit?: number) =>
		searchMcpMetadata({
			query,
			server,
			limit,
			servers: config.servers,
			metadata: Object.keys(toolsByServer).flatMap((id) => {
				const entry = cache.getDiscovery(id);
				return entry ? [entry] : [];
			}),
		});
	return { harness, config, cache, search };
}

function tool(name: string, description?: string): Tool {
	return { name, description, inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
}

describe("#469 MCP discovery search", () => {
	it("matches identifier components, Unicode, and normalized accents", async () => {
		const { search } = await createFixture({
			fake: [tool("getHTTPResponse"), tool("read_project-note"), tool("lire_Événement"), tool("查找_筆記")],
		});
		expect(search("http response")[0]?.tool).toBe("getHTTPResponse");
		expect(search("project note")[0]?.tool).toBe("read_project-note");
		expect(search("e\u0301ve\u0301nement")[0]?.tool).toBe("lire_Événement");
		expect(search("筆記")[0]?.tool).toBe("查找_筆記");
		expect(search("projec")[0]?.tool).toBe("read_project-note");
	});

	it("ranks exact names first and complete query coverage above partial name matches", async () => {
		const { search } = await createFixture({
			fake: [
				tool("simulator", "Inspect simulator information"),
				tool("lookup", "Inspect simulator crash logs"),
				tool("get_simulator", "Read simulator crash logs"),
				tool("getSimulator", "Read simulator crash logs"),
			],
		});
		expect(search("get_simulator")[0]?.tool).toBe("get_simulator");
		expect(search("getSimulator")[0]?.tool).toBe("getSimulator");
		expect(search("simulator crash logs").findIndex((match) => match.tool === "lookup")).toBeLessThan(
			search("simulator crash logs").findIndex((match) => match.tool === "simulator"),
		);
	});

	it("ignores repeated query terms and conversational glue without matching inside unrelated words", async () => {
		const { search } = await createFixture({ fake: [tool("read_note"), tool("target"), tool("get")] });
		expect(search("please can you read the note for me")).toEqual(search("read note"));
		expect(search("read read note note")).toEqual(search("read note"));
		expect(search("get").map((match) => match.tool)).toEqual(["get"]);
		expect(search("!!!")).toEqual([]);
	});

	it("scopes servers and preserves enablement, tool filters, and bounded result counts", async () => {
		const { config, search } = await createFixture({
			alpha: Array.from({ length: 30 }, (_, index) => tool(`read_note_${index}`)),
			beta: [tool("read_note"), tool("read_secret")],
		});
		config.servers.beta.excludeTools = ["read_secret"];
		expect(search("read", " BETA ").map((match) => match.tool)).toEqual(["read_note"]);
		expect(search("read", "missing")).toEqual([]);
		expect(search("read")).toHaveLength(8);
		expect(search("read", undefined, 100)).toHaveLength(20);
		expect(search("read", undefined, 1)).toHaveLength(1);
		config.servers.beta.enabled = false;
		expect(search("read", "beta")).toEqual([]);
	});

	it("retains full searchable descriptions and trust decisions without cloning schemas or unrelated annotations", async () => {
		const description = `${"Informational documentation. ".repeat(100)} Archive old notes.`;
		const { cache, config, search } = await createFixture({
			fake: [
				{
					...tool("read_note", description),
					inputSchema: { type: "object", properties: { secret: { description: "SCHEMA_ONLY".repeat(10_000) } } },
					outputSchema: { type: "object" },
					annotations: { readOnlyHint: true, title: "ANNOTATION_ONLY".repeat(10_000) },
					_meta: { opaque: "EXTENSION_ONLY" },
				},
			],
		});
		const projection = cache.getDiscovery("fake");
		expect(projection?.tools[0].description).toBe(description);
		expect(projection?.tools[0].annotations).toEqual({ readOnlyHint: true });
		expect(JSON.stringify(projection)).not.toMatch(
			/SCHEMA_ONLY|ANNOTATION_ONLY|EXTENSION_ONLY|inputSchema|outputSchema/,
		);
		const matches = search("archive");
		expect(matches[0]).toMatchObject({ tool: "read_note", risk: "destructive", trustedRead: false });
		expect(matches[0].summary.length).toBeLessThanOrEqual(180);
		expect(matches).toEqual(
			searchMcpMetadata({ query: "archive", servers: config.servers, metadata: cache.getAll() }),
		);
	});

	it("isolates returned projections and invalidates updates while preserving category freshness", async () => {
		let now = 1_000;
		const { cache, search } = await createFixture({ fake: [tool("read_note")] }, { now: () => now });
		const original = cache.get("fake")!;
		const projection = cache.getDiscovery("fake")!;
		projection.tools[0].name = "mutated";
		projection.tools[0].annotations!.readOnlyHint = false;
		expect(search("read note")[0]).toMatchObject({ tool: "read_note", trustedRead: true });
		now += 1_000;
		cache.set("fake", { ...original, resources: [{ name: "new", uri: "file:///new" }] }, ["resources"]);
		const refreshed = cache.getDiscovery("fake")!;
		expect(refreshed.toolsLastSeenAt).toBe(original.toolsLastSeenAt);
		expect(refreshed.resourcesLastSeenAt).not.toBe(original.resourcesLastSeenAt);
		expect(refreshed.metadataHash).not.toBe(original.metadataHash);
		cache.set("fake", { ...original, configHash: "changed", tools: [tool("read_other")] }, ["tools"]);
		expect(cache.getDiscovery("fake")).toMatchObject({
			configHash: "changed",
			resourcesLastSeenAt: new Date(0).toISOString(),
			tools: [{ name: "read_other" }],
		});
		expect(search("read other")[0]?.tool).toBe("read_other");
		cache.delete("fake");
		expect(cache.getDiscovery("fake")).toBeUndefined();
	});

	it("returns isolated complete schemas for only the selected cached tool", async () => {
		const selected: Tool = {
			...tool("read_note"),
			inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
			outputSchema: { type: "object", properties: { text: { type: "string" } } },
		};
		const { cache } = await createFixture({ fake: [selected, tool("read_other")] });
		const retrieved = cache.getTool("fake", "read_note")!;
		expect(retrieved).toEqual(selected);
		retrieved.inputSchema.required?.push("extra");
		retrieved.outputSchema!.properties = {};
		expect(cache.getTool("fake", "read_note")).toEqual(selected);
		expect(cache.getTool("fake", "missing")).toBeUndefined();
		expect(cache.getTool("missing", "read_note")).toBeUndefined();
	});

	it("rebuilds projections on reload and discards evicted catalogs", async () => {
		const { harness, cache } = await createFixture({ fake: [tool("read_note")] }, { maxServers: 1 });
		const projected = cache.getDiscovery("fake");
		const reloaded = new McpMetadataCache({ agentDir: harness.tempDir });
		expect(reloaded.getDiscovery("fake")).toEqual(projected);
		cache.set("other", { server: "other", tools: [], resources: [], prompts: [] }, ["tools"]);
		expect(cache.getDiscovery("fake")).toBeUndefined();
		expect(cache.getDiscovery("other")?.tools).toEqual([]);
	});

	it("can project an unretained catalog without losing selected-tool metadata", async () => {
		const { cache } = await createFixture({ fake: [] }, { maxBytes: 240 });
		const metadata = cache.set(
			"fake",
			{ server: "fake", tools: [tool("read_note", "Read a note")], resources: [], prompts: [] },
			["tools"],
		);
		expect(cache.getDiscovery("fake")).toBeUndefined();
		expect(toMcpDiscoveryMetadata(metadata).tools).toEqual([
			{ name: "read_note", description: "Read a note", annotations: { readOnlyHint: true } },
		]);
	});

	it("reuses prepared text features while applying current filters, trust, and changed catalogs", async () => {
		const { cache, config } = await createFixture({
			fake: [tool("getHTTPResponse", "Read HTTP response details"), tool("read_note", "Read project notes")],
		});
		const metadata = cache.getDiscovery("fake")!;
		let descriptionReads = 0;
		Object.defineProperty(metadata.tools[0], "description", {
			get: () => {
				descriptionReads++;
				return "Read HTTP response details";
			},
		});
		const index = new McpSearchIndex();
		const options = { query: "http response", servers: config.servers, metadata: [metadata] };
		const expected = searchMcpMetadata(options);
		expect(index.search(options)).toEqual(expected);
		const preparedReads = descriptionReads;
		expect(index.search(options)).toEqual(expected);
		expect(descriptionReads).toBe(preparedReads);
		config.servers.fake.trustedReads.tools = [];
		expect(index.search(options)[0]?.trustedRead).toBe(false);
		config.servers.fake.excludeTools = ["getHTTPResponse"];
		expect(index.search(options)).toEqual([]);
		expect(descriptionReads).toBe(preparedReads);
		cache.set("fake", { ...cache.get("fake")!, tools: [tool("read_note", "Read HTTP response notes")] }, ["tools"]);
		const changed = { ...options, metadata: [cache.getDiscovery("fake")!] };
		expect(index.search(changed)).toEqual(searchMcpMetadata(changed));
		expect(index.search(changed).map((match) => match.tool)).toEqual(["read_note"]);
	});

	it("drops prepared catalogs when callers omit stale metadata or disable a server", async () => {
		const { cache, config } = await createFixture({ fake: [tool("read_note", "Read a note")] });
		const metadata = cache.getDiscovery("fake")!;
		let descriptionReads = 0;
		Object.defineProperty(metadata.tools[0], "description", {
			get: () => {
				descriptionReads++;
				return "Read a note";
			},
		});
		const index = new McpSearchIndex();
		const options = { query: "note", servers: config.servers, metadata: [metadata] };
		expect(index.search(options)).toHaveLength(1);
		const initialReads = descriptionReads;
		expect(index.search({ ...options, server: "another-server", metadata: [] })).toEqual([]);
		expect(index.search(options)).toHaveLength(1);
		expect(descriptionReads).toBe(initialReads);
		expect(index.search({ ...options, metadata: [] })).toEqual([]);
		expect(index.search(options)).toHaveLength(1);
		expect(descriptionReads).toBeGreaterThan(initialReads);
		const refreshedReads = descriptionReads;
		config.servers.fake.enabled = false;
		expect(index.search(options)).toEqual([]);
		config.servers.fake.enabled = true;
		expect(index.search(options)).toHaveLength(1);
		expect(descriptionReads).toBeGreaterThan(refreshedReads);
	});

	it("bounds prepared catalogs to 64 and keeps recently used catalog features", async () => {
		const { cache, config } = await createFixture({ fake: [tool("read_note", "Read a note")] });
		const base = cache.getDiscovery("fake")!;
		let oldestReads = 0;
		const metadata = Array.from({ length: 65 }, (_, number) => ({
			...base,
			server: `server-${number}`,
			metadataHash: `fixture-${number}`,
			tools: [{ ...base.tools[0] }],
		}));
		Object.defineProperty(metadata[0].tools[0], "description", {
			get: () => {
				oldestReads++;
				return "Read a note";
			},
		});
		const servers = Object.fromEntries(
			metadata.map((entry) => [entry.server, { ...config.servers.fake, id: entry.server }]),
		);
		const index = new McpSearchIndex();
		const options = { query: "note", servers, metadata };
		index.search(options);
		const initialReads = oldestReads;
		expect(index.search({ ...options, server: "server-64" })).toHaveLength(1);
		expect(oldestReads).toBe(initialReads);
		expect(index.search({ ...options, server: "server-0" })).toHaveLength(1);
		expect(oldestReads).toBeGreaterThan(initialReads);
	});
});
