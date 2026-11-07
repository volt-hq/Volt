import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { computeCodeModeBindings } from "../../src/core/code-mode/bindings.ts";
import { codeModeDispatchHostOf, createCodeModeCallHandler } from "../../src/core/code-mode/dispatch.ts";
import { CodeModeImageStore } from "../../src/core/code-mode/images.ts";
import { McpAuditLogger } from "../../src/core/mcp/audit.ts";
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
import type { SessionTurnPolicy } from "../../src/core/session/turn-policy.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { testExtension } from "../utilities.ts";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

interface SeenEvent {
	type: "tool_call" | "tool_result";
	toolName: string;
	toolCallId: string;
	input: unknown;
	origin: unknown;
}

type SessionInternals = {
	_tools: SessionToolRuntime;
	_turnPolicy: SessionTurnPolicy;
	_planning: { hasResearch(): boolean };
};

describe("code mode MCP dispatch in a session", () => {
	let tempDir: string;
	let agentDir: string;
	const sessions: AgentSession[] = [];
	let seen: SeenEvent[];
	let serverCalls: Array<{ name: string; arguments: unknown }>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `volt-code-mode-mcp-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		seen = [];
		serverCalls = [];
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			session.dispose();
			await session.waitForClosed();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * An MCP manager, with an audit log, connected to the server `fake`. `read_note` is a trusted read promoted to a
	 * direct tool and returns text, an image, and structured content; `write_note` is not a read.
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
					fake: { command: "fake-mcp", trustedReads: { tools: ["read_note"] }, directTools: ["read_note"] },
				},
			},
			source,
		);
		const tool = (name: string, readOnly: boolean) => ({
			name,
			description: name,
			inputSchema: { type: "object", properties: { id: { type: "number" } } },
			annotations: { readOnlyHint: readOnly },
		});
		const manager = new McpManager({
			config: finalizeMcpConfig(merged),
			clientFactory: {
				connect: async () =>
					({
						getServerVersion: () => ({ name: "fake", version: "1.0.0" }),
						listTools: async () => ({ tools: [tool("read_note", true), tool("write_note", false)] }),
						listResources: async () => ({ resources: [] }),
						readResource: async () => ({ contents: [] }),
						listPrompts: async () => ({ prompts: [] }),
						getPrompt: async () => ({ messages: [] }),
						callTool: async (params) => {
							serverCalls.push({ name: params.name, arguments: params.arguments });
							return {
								content: [
									{ type: "text", text: "note body" },
									{ type: "image", data: PNG_1X1, mimeType: "image/png" },
								],
								structuredContent: { id: 1, title: "Note" },
							};
						},
						close: async () => undefined,
					}) as McpClientConnection,
			},
			metadataCache: new McpMetadataCache({ agentDir }),
			outputStore: new McpOutputStore({ agentDir, maxOutputBytes: 4096, maxOutputLines: 100 }),
			auditLogger: new McpAuditLogger(agentDir),
		});
		await manager.connectServer("fake");
		return manager;
	}

	/** A session with an extension that records the tool hooks it sees. */
	async function createSession(options: { agentMode: AgentMode; excludeTools?: string[] }): Promise<AgentSession> {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-api-key");
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				testExtension("recorder", (volt) => {
					volt.on("tool_call", (event) => {
						seen.push({
							type: "tool_call",
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							input: event.input,
							origin: event.origin,
						});
						return undefined;
					});
					volt.on("tool_result", (event) => {
						seen.push({
							type: "tool_result",
							toolName: event.toolName,
							toolCallId: event.toolCallId,
							input: event.input,
							origin: event.origin,
						});
						return undefined;
					});
				}),
			],
		});
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
		});
		sessions.push(session);
		return session;
	}

	/** Calls a binding, by path, the way a script running in `session` would, from the code-mode call `run-1`. */
	function scriptCalls(session: AgentSession) {
		const internals = session as unknown as SessionInternals;
		const handle = createCodeModeCallHandler({
			host: codeModeDispatchHostOf(internals._tools, internals._turnPolicy, tempDir),
			bindings: computeCodeModeBindings(internals._tools.codeModeBindingSources()),
			parentToolCallId: "run-1",
		});
		let seq = 0;
		return (path: string[], args: Record<string, unknown>) =>
			handle({
				seq: ++seq,
				binding: JSON.stringify(path),
				args,
				signal: new AbortController().signal,
				images: new CodeModeImageStore().stage(),
				maxValueBytes: 1024 * 1024,
			});
	}

	function auditEntries(): Array<Record<string, unknown>> {
		return readFileSync(join(agentDir, "mcp", "audit.jsonl"), "utf-8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	function outputStoreFiles(): string[] {
		const dir = join(agentDir, "mcp", "output");
		return existsSync(dir) ? readdirSync(dir) : [];
	}

	const origin = { kind: "code_mode", parentToolCallId: "run-1", seq: 1 };

	it("calls an MCP tool through the gateway's hooks and the manager, and gives the script the whole result", async () => {
		const call = scriptCalls(await createSession({ agentMode: "build" }));
		const value = await call(["mcp", "fake", "read_note"], { id: 1 });
		expect(value).toMatchObject({
			text: "note body",
			structured: { id: 1, title: "Note" },
			images: [{ type: "image", ref: expect.any(String), mimeType: "image/png", width: 1, height: 1 }],
		});
		const input = { action: "call", server: "fake", tool: "read_note", arguments: { id: 1 } };
		expect(seen).toStrictEqual([
			{ type: "tool_call", toolName: "mcp", toolCallId: "run-1:cm:1", input, origin },
			{ type: "tool_result", toolName: "mcp", toolCallId: "run-1:cm:1", input, origin },
		]);
		expect(serverCalls).toStrictEqual([{ name: "read_note", arguments: { id: 1 } }]);
		expect(auditEntries()).toEqual([
			expect.objectContaining({
				callerSurface: "model",
				server: "fake",
				item: "read_note",
				kind: "tool",
				risk: "read",
				status: "completed",
			}),
		]);
		// The result never enters the output store, whose entries the model's own calls read back.
		expect(outputStoreFiles()).toStrictEqual([]);
	});

	it("calls a promoted MCP tool through its direct tool's hooks when the gateway is excluded", async () => {
		const call = scriptCalls(await createSession({ agentMode: "build", excludeTools: ["mcp"] }));
		expect(await call(["mcp", "fake", "read_note"], { id: 1 })).toMatchObject({ text: "note body" });
		const toolName = "mcp__fake__read_note";
		expect(seen).toStrictEqual([
			{ type: "tool_call", toolName, toolCallId: "run-1:cm:1", input: { id: 1 }, origin },
			{ type: "tool_result", toolName, toolCallId: "run-1:cm:1", input: { id: 1 }, origin },
		]);
		expect(serverCalls).toStrictEqual([{ name: "read_note", arguments: { id: 1 } }]);
	});

	it("authorizes a trusted-read MCP call through the gateway in Plan mode and counts it as research", async () => {
		const session = await createSession({ agentMode: "plan" });
		const internals = session as unknown as SessionInternals;
		const call = scriptCalls(session);
		expect(internals._planning.hasResearch()).toBe(false);
		expect(await call(["mcp", "fake", "read_note"], { id: 1 })).toMatchObject({
			text: "note body",
			structured: { id: 1, title: "Note" },
		});
		expect(seen.map((event) => [event.type, event.toolName])).toStrictEqual([
			["tool_call", "mcp"],
			["tool_result", "mcp"],
		]);
		expect(internals._planning.hasResearch()).toBe(true);
	});
});
