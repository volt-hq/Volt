import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { DefaultMcpClientFactory } from "../../../src/core/mcp/client-factory.ts";
import { getMcpDirectToolName } from "../../../src/core/mcp/config.ts";
import type { McpClientConnection } from "../../../src/core/mcp/types.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import type { SubagentToolManager } from "../../../src/core/tools/subagent.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const SERVER_PREFIX = "issue498-";
const TOOL: SdkTool = { name: "read_note", description: "Read a note", inputSchema: { type: "object" } };
const DIRECT_TOOL = getMcpDirectToolName("issue498-eager", TOOL.name);

function fakeConnection(): McpClientConnection {
	return {
		getServerVersion: () => ({ name: "fake", version: "1.0.0" }),
		listTools: async () => ({ tools: [TOOL] }),
		listResources: async () => ({ resources: [] }),
		readResource: async () => ({ contents: [] }),
		listPrompts: async () => ({ prompts: [] }),
		getPrompt: async () => ({ messages: [] }),
		callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
		close: async () => undefined,
	};
}

/** Minimal manager that marks the session as a subagent runtime and never delegates. */
const subagentRuntimeManager: SubagentToolManager = {
	isSubagentRuntime: () => true,
	listAvailableDefinitions: () => [],
	getDefinition: (agentName) => {
		throw new Error(`Unexpected subagent definition lookup: ${agentName}`);
	},
	startByName: async () => {
		throw new Error("Unexpected subagent start");
	},
};

describe("Regression #498: subagents skip eager MCP startup", () => {
	let harness: Harness;
	let cwd: string;
	let agentDir: string;
	let connections: string[];
	const sessions: AgentSession[] = [];

	// The user-level shared MCP config under the real home directory is also loaded,
	// so assertions only consider this test's servers.
	const issueConnections = () => connections.filter((id) => id.startsWith(SERVER_PREFIX));

	beforeEach(async () => {
		harness = await createHarness();
		cwd = join(harness.tempDir, "workspace");
		agentDir = join(harness.tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			`${JSON.stringify({
				servers: {
					"issue498-eager": { command: "issue498-unused", lifecycle: "eager", directTools: true },
					"issue498-keepalive": { command: "issue498-unused", lifecycle: "keep-alive" },
					"issue498-lazy": { command: "issue498-unused", lifecycle: "lazy" },
				},
			})}\n`,
		);
		connections = [];
		vi.spyOn(DefaultMcpClientFactory.prototype, "connect").mockImplementation(async (server) => {
			connections.push(server.id);
			return fakeConnection();
		});
	});

	afterEach(async () => {
		for (const session of sessions.splice(0).reverse()) {
			session.dispose();
			await session.waitForClosed();
		}
		vi.restoreAllMocks();
		harness.cleanup();
	});

	async function createSession(options: { subagent: boolean }): Promise<AgentSession> {
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			model: harness.getModel(),
			settingsManager: SettingsManager.inMemory({ lsp: { enabled: false } }),
			resourceLoader: createTestResourceLoader(),
			sessionManager: SessionManager.inMemory(),
			projectTrusted: false,
			...(options.subagent ? { subagentToolManager: subagentRuntimeManager } : {}),
		});
		sessions.push(session);
		return session;
	}

	it("starts eager and keep-alive servers once for a root session", async () => {
		const root = await createSession({ subagent: false });

		expect(issueConnections().sort()).toEqual(["issue498-eager", "issue498-keepalive"]);
		expect(root.getActiveToolNames()).toEqual(expect.arrayContaining(["mcp", DIRECT_TOOL]));
	});

	it("connects nothing for a subagent at creation or reload and connects on first use", async () => {
		await createSession({ subagent: false });
		const startedByRoot = issueConnections().length;

		const child = await createSession({ subagent: true });
		expect(issueConnections()).toHaveLength(startedByRoot);
		expect(child.getActiveToolNames()).toEqual(expect.arrayContaining(["mcp", DIRECT_TOOL]));
		const childServers = () =>
			child
				.getMcpManager()
				?.listServers()
				.filter((server) => server.id.startsWith(SERVER_PREFIX))
				.map((server) => [server.id, server.status])
				.sort();
		expect(childServers()).toEqual([
			["issue498-eager", "cold"],
			["issue498-keepalive", "cold"],
			["issue498-lazy", "cold"],
		]);

		await child.reload();
		expect(issueConnections()).toHaveLength(startedByRoot);
		expect(childServers()).toEqual([
			["issue498-eager", "cold"],
			["issue498-keepalive", "cold"],
			["issue498-lazy", "cold"],
		]);

		const manager = child.getMcpManager();
		if (!manager) throw new Error("Expected the subagent session to keep an MCP manager");
		await manager.connectServer("issue498-eager");
		expect(issueConnections().slice(startedByRoot)).toEqual(["issue498-eager"]);
	});
});
