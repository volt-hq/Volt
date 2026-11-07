import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { type CodeModeBindingSpec, computeCodeModeBindings } from "../../src/core/code-mode/bindings.ts";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../../src/core/mcp/config.ts";
import { McpManager } from "../../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../../src/core/mcp/metadata-cache.ts";
import { McpOutputStore } from "../../src/core/mcp/output-store.ts";
import type { McpClientConnection } from "../../src/core/mcp/types.ts";
import type { AgentMode } from "../../src/core/planning.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import type { SessionToolRuntime } from "../../src/core/session/tool-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

describe("code mode bindings of a session", () => {
	let tempDir: string;
	let agentDir: string;
	const sessions: AgentSession[] = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-code-mode-bindings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			session.dispose();
			await session.waitForClosed();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * An MCP manager with a connected server, `fake`, and a lazy one, `lazy`, whose tools were never listed.
	 * `read_note` is a trusted read promoted to a direct tool; `hidden_note` is filtered out.
	 */
	async function createManager(): Promise<McpManager> {
		const source = sourceForMcpConfigPath(join(agentDir, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		});
		const merged = createEmptyMcpMergedConfig();
		mergeMcpConfigFile(
			merged,
			{
				servers: {
					fake: {
						command: "fake-mcp",
						trustedReads: { tools: ["read_note"] },
						directTools: ["read_note"],
						excludeTools: ["hidden_note"],
					},
					lazy: { command: "lazy-mcp" },
				},
			},
			source,
		);
		const tool = (name: string, readOnly: boolean) => ({
			name,
			description: name,
			inputSchema: { type: "object" },
			annotations: { readOnlyHint: readOnly },
		});
		const manager = new McpManager({
			config: finalizeMcpConfig(merged),
			clientFactory: {
				connect: async (server: { id: string }) =>
					({
						getServerVersion: () => ({ name: server.id, version: "1.0.0" }),
						listTools: async () => ({
							tools:
								server.id === "fake"
									? [tool("read_note", true), tool("write_note", false), tool("hidden_note", true)]
									: [tool("lazy_tool", true)],
						}),
						listResources: async () => ({ resources: [] }),
						readResource: async () => ({ contents: [] }),
						listPrompts: async () => ({ prompts: [] }),
						getPrompt: async () => ({ messages: [] }),
						callTool: async () => ({ content: [] }),
						close: async () => undefined,
					}) as McpClientConnection,
			},
			metadataCache: new McpMetadataCache({ agentDir }),
			outputStore: new McpOutputStore({ agentDir, maxOutputBytes: 4096, maxOutputLines: 100 }),
		});
		await manager.connectServer("fake");
		return manager;
	}

	async function createSession(options: { agentMode: AgentMode; excludeTools?: string[] }): Promise<AgentSession> {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-api-key");
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			authStorage,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
			agentMode: options.agentMode,
			mcpManager: await createManager(),
			...(options.excludeTools ? { excludeTools: options.excludeTools } : {}),
			customTools: [
				{
					name: "deploy",
					label: "Deploy",
					description: "Test extension tool",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text" as const, text: "deployed" }], details: {} }),
				},
			],
		});
		sessions.push(session);
		return session;
	}

	function bindings(session: AgentSession): CodeModeBindingSpec[] {
		const runtime = (session as unknown as { _tools: SessionToolRuntime })._tools;
		return computeCodeModeBindings(runtime.codeModeBindingSources());
	}

	function bindingPaths(session: AgentSession): string[] {
		return bindings(session).map((binding) => binding.path.join("."));
	}

	/** The tool the calls of the MCP binding at `path` go through. */
	function mcpRoute(session: AgentSession, path: string): string | undefined {
		const target = bindings(session).find((binding) => binding.path.join(".") === path)?.target;
		return target?.kind === "mcp" ? target.toolName : undefined;
	}

	it("binds active built-in, extension, and listed MCP tools in Build mode", async () => {
		const session = await createSession({ agentMode: "build" });
		const paths = bindingPaths(session);
		expect(paths).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "deploy", "mcp.fake.write_note"]));
		// The promoted tool is bound once, at its MCP path, and its calls go through the gateway.
		expect(paths.filter((path) => path === "mcp.fake.read_note")).toHaveLength(1);
		expect(mcpRoute(session, "mcp.fake.read_note")).toBe("mcp");
		expect(mcpRoute(session, "mcp.fake.write_note")).toBe("mcp");
		for (const absent of [
			"jobs",
			"request_user_input",
			"mcp",
			"mcp__fake__read_note",
			"mcp.fake.hidden_note",
			"mcp.lazy.lazy_tool",
		]) {
			expect(paths, absent).not.toContain(absent);
		}
	});

	it("keeps a promoted MCP tool bound through its direct tool when the gateway is excluded", async () => {
		const session = await createSession({ agentMode: "build", excludeTools: ["mcp"] });
		const paths = bindingPaths(session);
		expect(paths).toContain("mcp.fake.read_note");
		expect(mcpRoute(session, "mcp.fake.read_note")).toBe("mcp__fake__read_note");
		expect(paths).not.toContain("mcp.fake.write_note");
	});

	it("binds only tools the research profile authorizes in Plan mode", async () => {
		const session = await createSession({ agentMode: "plan" });
		const paths = bindingPaths(session);
		expect(paths).toEqual(expect.arrayContaining(["read", "mcp.fake.read_note"]));
		expect(mcpRoute(session, "mcp.fake.read_note")).toBe("mcp");
		for (const absent of ["bash", "edit", "write", "deploy", "mcp.fake.write_note"]) {
			expect(paths, absent).not.toContain(absent);
		}
	});
});
