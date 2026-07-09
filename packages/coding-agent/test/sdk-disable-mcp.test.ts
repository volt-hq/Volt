import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/volt-ai";
import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../src/core/mcp/config.ts";
import { McpManager } from "../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../src/core/mcp/metadata-cache.ts";
import { McpOutputStore } from "../src/core/mcp/output-store.ts";
import type { McpClientConnection, McpClientFactory, McpResolvedConfig } from "../src/core/mcp/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function makeConfig(tempDir: string): McpResolvedConfig {
	const source = sourceForMcpConfigPath(join(tempDir, "mcp.json"), {
		scope: "user",
		label: "test",
		precedence: 1,
		shared: false,
	});
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			settings: { maxOutputBytes: 1024, maxOutputLines: 10 },
			servers: { fake: { command: "fake-mcp", lifecycle: "keep-alive" } },
		},
		source,
	);
	return finalizeMcpConfig(merged);
}

/** A client factory whose connection never spawns a real process. */
function fakeFactory(): McpClientFactory {
	const tool: SdkTool = { name: "read_note", description: "Read a note", inputSchema: { type: "object" } };
	return {
		connect: async () =>
			({
				getServerVersion: () => ({ name: "fake", version: "1.0.0" }),
				listTools: async () => ({ tools: [tool] }),
				listResources: async () => ({ resources: [] }),
				readResource: async () => ({ contents: [] }),
				listPrompts: async () => ({ prompts: [] }),
				getPrompt: async () => ({ messages: [] }),
				callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
				close: async () => undefined,
			}) as McpClientConnection,
	};
}

describe("createAgentSession disableMcp", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-disable-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function buildManager(): McpManager {
		return new McpManager({
			config: makeConfig(tempDir),
			clientFactory: fakeFactory(),
			metadataCache: new McpMetadataCache({ agentDir }),
			outputStore: new McpOutputStore({ agentDir, maxOutputBytes: 1024, maxOutputLines: 10 }),
		});
	}

	async function createSession(disableMcp: boolean, mcpManager: McpManager) {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		return createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
			mcpManager,
			disableMcp,
		});
	}

	it("exposes the MCP gateway tool when a manager is provided", async () => {
		const manager = buildManager();
		const { session } = await createSession(false, manager);
		expect(session.getAllTools().map((tool) => tool.name)).toContain("mcp");
		session.dispose();
	});

	it("suppresses the MCP gateway tool and ignores the manager when disabled", async () => {
		const manager = buildManager();
		const { session } = await createSession(true, manager);
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("mcp");
		session.dispose();
		// disableMcp ignores the passed manager, so the session must not have taken
		// ownership of it; dispose it here to release resources.
		await manager.dispose();
	});
});
