import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../../../src/core/mcp/config.ts";
import { McpManager } from "../../../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../../../src/core/mcp/metadata-cache.ts";
import { McpOutputStore } from "../../../src/core/mcp/output-store.ts";
import type { McpClientConnection } from "../../../src/core/mcp/types.ts";

const MAX_ENTRY_BYTES = 4_096;

const fixtures: Array<{ manager: McpManager; directory: string }> = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.manager.dispose();
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

function connection(tools: SdkTool[]): McpClientConnection {
	return {
		getServerVersion: () => ({ name: "fake", version: "1" }),
		listTools: async () => ({ tools }),
		listResources: async () => ({ resources: [] }),
		listPrompts: async () => ({ prompts: [] }),
		readResource: async () => ({ contents: [] }),
		getPrompt: async () => ({ messages: [] }),
		callTool: async () => ({ content: [] }),
		close: async () => undefined,
	};
}

const smallTools: SdkTool[] = [{ name: "read_note", description: "Read a note", inputSchema: { type: "object" } }];
// Larger than MAX_ENTRY_BYTES once persisted, like a server with hundreds of tools and large schemas.
const largeTools: SdkTool[] = Array.from({ length: 40 }, (_, index) => ({
	name: `analyze_${index}`,
	description: `Analyze target ${index} ${"x".repeat(100)}`,
	inputSchema: { type: "object" },
}));

function createManager(directory: string): McpManager {
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			servers: {
				small: { command: "unused-small-server", lifecycle: "lazy" },
				large: { command: "unused-large-server", lifecycle: "lazy" },
			},
		},
		sourceForMcpConfigPath(join(directory, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		}),
	);
	return new McpManager({
		config: finalizeMcpConfig(merged),
		clientFactory: {
			connect: async (server) => connection(server.id === "large" ? largeTools : smallTools),
		},
		metadataCache: new McpMetadataCache({ agentDir: directory, maxEntryBytes: MAX_ENTRY_BYTES }),
		outputStore: new McpOutputStore({ agentDir: directory, maxOutputBytes: 8192 }),
	});
}

function createFixture(): { manager: McpManager; directory: string } {
	const directory = mkdtempSync(join(tmpdir(), "volt-1053-"));
	const fixture = { manager: createManager(directory), directory };
	fixtures.push(fixture);
	return fixture;
}

function callableServers(manager: McpManager): string[] {
	return [...new Set(manager.getCallableTools().map((tool) => tool.server))].sort();
}

describe("#1053 MCP metadata too large to persist", () => {
	it("keeps every server's metadata usable after refreshing a server too large to persist", async () => {
		const { manager } = createFixture();

		await manager.connectServer("small");
		await manager.connectServer("large");

		expect(callableServers(manager)).toEqual(["large", "small"]);
		expect(manager.getCallableTools().filter((tool) => tool.server === "large")).toHaveLength(largeTools.length);
		expect(manager.search("note").coverage).toMatchObject({ missingServers: [], staleServers: [] });
		expect(manager.getServer("large").toolCounts.cached).toBe(largeTools.length);

		// Refreshing the oversized server again must not evict the others either.
		await manager.listTools("large");
		expect(callableServers(manager)).toEqual(["large", "small"]);
	});

	it("persists the servers that fit, so a new session finds them without connecting", async () => {
		const { manager, directory } = createFixture();
		await manager.connectServer("small");
		await manager.connectServer("large");

		const restarted = createManager(directory);
		fixtures.push({ manager: restarted, directory });

		expect(callableServers(restarted)).toEqual(["small"]);
		expect(restarted.search("note").coverage).toMatchObject({
			searchedServers: ["small"],
			missingServers: ["large"],
		});
	});
});
