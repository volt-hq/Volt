import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../../../src/core/mcp/config.ts";
import { createMcpTool } from "../../../src/core/mcp/gateway-tool.ts";
import { McpManager } from "../../../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../../../src/core/mcp/metadata-cache.ts";
import { McpOutputStore } from "../../../src/core/mcp/output-store.ts";
import type { McpClientConnection } from "../../../src/core/mcp/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const fixtures: Array<{ manager: McpManager; harness?: Harness; directory: string }> = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		await fixture.manager.dispose();
		await fixture.harness?.cleanupAsync();
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

const connection: McpClientConnection = {
	getServerVersion: () => ({ name: "fake", version: "1" }),
	listTools: async () => ({ tools: [{ name: "read_note", inputSchema: { type: "object" } }] }),
	listResources: async () => ({ resources: [{ uri: "file:///note", name: "note" }] }),
	listPrompts: async () => ({ prompts: [{ name: "summarize" }, { name: "explain" }] }),
	readResource: async () => ({ contents: [] }),
	getPrompt: async () => ({ messages: [] }),
	callTool: async () => ({ content: [] }),
	close: async () => undefined,
};

function createManager(directory: string): McpManager {
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{ servers: { fake: { command: "unused-fake-server", lifecycle: "keep-alive" } } },
		sourceForMcpConfigPath(join(directory, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		}),
	);
	return new McpManager({
		config: finalizeMcpConfig(merged),
		clientFactory: { connect: async () => connection },
		metadataCache: new McpMetadataCache({ agentDir: directory }),
		outputStore: new McpOutputStore({ agentDir: directory, maxOutputBytes: 8192 }),
	});
}

function createManagerFixture(): McpManager {
	const directory = mkdtempSync(join(tmpdir(), "volt-683-"));
	const manager = createManager(directory);
	fixtures.push({ manager, directory });
	return manager;
}

async function createSessionFixture(): Promise<Harness> {
	const directory = mkdtempSync(join(tmpdir(), "volt-683-"));
	const manager = createManager(directory);
	// A persisted session, so tool result details pass through the session store's JSON admission.
	const harness = await createHarness({
		tools: [createMcpTool({ manager })],
		settings: { compaction: { enabled: false } },
		log: "sqlite",
	});
	fixtures.push({ manager, harness, directory });
	return harness;
}

describe("#683 MCP server summary for a server with no cached metadata", () => {
	it("omits the resource and prompt counts until metadata is cached, then reports them", async () => {
		const manager = createManagerFixture();

		const unconnected = manager.getServer("fake");
		expect(unconnected.status).not.toBe("ready");
		expect(Object.keys(unconnected)).not.toContain("resourceCount");
		expect(Object.keys(unconnected)).not.toContain("promptCount");

		const connected = await manager.connectServer("fake");
		expect(connected.server).toMatchObject({ resourceCount: 1, promptCount: 2 });
	});

	it.each<[string, Record<string, string>]>([
		["status", { action: "status" }],
		["list_servers", { action: "list_servers" }],
		["disconnect", { action: "disconnect", server: "fake" }],
	])("persists the %s result for an unconnected server", async (_action, input) => {
		const harness = await createSessionFixture();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp", input)], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Report the MCP servers");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toMatchObject({ toolName: "mcp", isError: false });
		const details = toolResult?.details as { result: { servers?: unknown[]; server?: unknown } };
		const summary = (details.result.servers?.[0] ?? details.result.server) as Record<string, unknown>;
		expect(summary).toMatchObject({ id: "fake" });
		expect(Object.keys(summary)).not.toContain("resourceCount");
		expect(Object.keys(summary)).not.toContain("promptCount");

		const persisted = harness.sessionManager
			.getBranch()
			.some((entry) => entry.type === "message" && entry.message.role === "toolResult");
		expect(persisted).toBe(true);
	});
});
