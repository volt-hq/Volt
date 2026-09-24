import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../../../src/core/mcp/config.ts";
import { createMcpDirectToolDefinitions } from "../../../src/core/mcp/direct-tools.ts";
import {
	createMcpTool,
	createMcpToolDefinition,
	type McpGatewayToolInput,
} from "../../../src/core/mcp/gateway-tool.ts";
import { McpManager } from "../../../src/core/mcp/manager.ts";
import { McpMetadataCache } from "../../../src/core/mcp/metadata-cache.ts";
import { McpOutputStore } from "../../../src/core/mcp/output-store.ts";
import type { McpClientConnection } from "../../../src/core/mcp/types.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

interface Output {
	content: string;
	cache?: { id: string; read: string };
	cacheId?: string;
	cacheUnavailable?: boolean;
	startByte?: number;
	nextCursor?: string;
	truncation?: { truncated: boolean; returnedBytes: number; totalBytes: number };
	tools?: Array<{ name: string; description: string; risk: string; trustedRead: boolean }>;
}

const fixtures: Array<{ manager: McpManager; harness: Harness; directory: string }> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const fixture of fixtures.splice(0)) {
		await fixture.manager.dispose();
		await fixture.harness.cleanupAsync();
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

async function createFixture(
	options: {
		tools?: Tool[];
		bytes?: number;
		cacheBytes?: number;
		lines?: number;
		output?: string;
		trustedTools?: string[];
	} = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "volt-469-"));
	const bytes = options.bytes ?? 4096;
	const tools = options.tools ?? [
		{ name: "read_note", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
	];
	const output = options.output ?? "note";
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			settings: { maxOutputBytes: bytes, maxOutputLines: options.lines ?? 2000, prompts: "model" },
			servers: {
				fake: {
					command: "unused-fake-server",
					lifecycle: "keep-alive",
					directTools: true,
					trustedReads: { tools: options.trustedTools ?? ["read_note"] },
				},
			},
		},
		sourceForMcpConfigPath(join(directory, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		}),
	);
	const config = finalizeMcpConfig(merged);
	const connection: McpClientConnection = {
		getServerVersion: () => ({ name: "fake", version: "1" }),
		listTools: async () => ({ tools }),
		listResources: async () => ({ resources: [{ uri: "file:///note", name: "note" }] }),
		listPrompts: async () => ({ prompts: [{ name: "note" }] }),
		readResource: async () => ({ contents: [{ uri: "file:///note", text: output }] }),
		getPrompt: async () => ({ messages: [{ role: "user", content: { type: "text", text: output } }] }),
		callTool: async () => ({ content: [{ type: "text", text: output }] }),
		close: async () => undefined,
	};
	const store = new McpOutputStore({
		agentDir: directory,
		maxOutputBytes: bytes,
		maxOutputLines: options.lines ?? 2000,
		maxCacheEntryBytes: options.cacheBytes,
		sessionId: "469",
		workspaceId: "fixture",
	});
	const manager = new McpManager({
		config,
		clientFactory: { connect: async () => connection },
		metadataCache: new McpMetadataCache({ agentDir: directory }),
		outputStore: store,
	});
	const gateway = createMcpToolDefinition({ manager });
	const harness = await createHarness({
		tools: [createMcpTool({ manager })],
		settings: { compaction: { enabled: false } },
	});
	fixtures.push({ manager, harness, directory });
	const execute = async (input: McpGatewayToolInput) => {
		const result = await gateway.execute("469", input, undefined, undefined, undefined as never);
		const text = getMessageText(result);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(bytes);
		expect(text.split("\n").length).toBeLessThanOrEqual(options.lines ?? 2000);
		expect(JSON.parse(text)).toEqual(result.details.result);
		return { result, data: JSON.parse(text) as Output, text };
	};
	const readAll = async (id: string) => {
		let cursor: string | undefined;
		let restored = "";
		let pages = 0;
		do {
			const { data, result } = await execute({ action: "read_cache", cacheId: id, cursor });
			expect(result.isError).not.toBe(true);
			expect(data.cacheId).toBe(id);
			expect(data.startByte).toBe(Buffer.byteLength(restored));
			expect(data.content).not.toContain("\uFFFD");
			restored += data.content;
			if (data.nextCursor) expect(Number(data.nextCursor)).toBeGreaterThan(Number(cursor ?? 0));
			cursor = data.nextCursor;
			expect(++pages).toBeLessThan(1000);
		} while (cursor);
		return restored;
	};
	return { manager, gateway, connection, harness, store, directory, execute, readAll };
}

describe("#469 bounded MCP model output", () => {
	it("keeps a megabyte catalog out of the provider context while retaining management schemas", async () => {
		const properties = Object.fromEntries(
			Array.from({ length: 20 }, (_, index) => [
				`field_${index}`,
				{ type: "string", description: "SCHEMA_ONLY_MARKER ".repeat(20) },
			]),
		);
		const tools: Tool[] = Array.from({ length: 200 }, (_, index) => ({
			name: `read_${index}`,
			description: "Read a note",
			inputSchema: { type: "object", properties },
			outputSchema: { type: "object", properties },
			annotations: { readOnlyHint: true },
		}));
		const { manager, harness } = await createFixture({ tools, bytes: 51200 });
		const management = await manager.listTools("fake");
		expect(Buffer.byteLength(JSON.stringify(management))).toBeGreaterThan(1_000_000);
		expect(management.tools[0].inputSchema).toEqual(tools[0].inputSchema);
		expect(management.tools[0].outputSchema).toEqual(tools[0].outputSchema);
		let checked = false;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp", { action: "list_tools", server: "fake" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				expect(result).toBeDefined();
				const text = getMessageText(result);
				expect(Buffer.byteLength(text)).toBeLessThanOrEqual(51200);
				expect(text).not.toContain("SCHEMA_ONLY_MARKER");
				expect(text).not.toContain("inputSchema");
				expect(text).not.toContain("outputSchema");
				expect((JSON.parse(text) as Output).tools).toHaveLength(200);
				checked = true;
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("List the fake server's tools");
		expect(checked).toBe(true);
	});

	it("caches large summary lists and reconstructs escaped Unicode pages without duplicating cache entries", async () => {
		const tools: Tool[] = Array.from({ length: 200 }, (_, index) => ({
			name: `read_${index}`,
			description: '"\\\n漢字𝄞 '.repeat(100),
			inputSchema: { type: "object" },
		}));
		const { execute, readAll, directory } = await createFixture({ tools, bytes: 1024, lines: 1 });
		const { data, text } = await execute({ action: "list_tools", server: "fake" });
		expect(data.truncation?.truncated).toBe(true);
		expect(data.content.length).toBeGreaterThan(0);
		expect(text).not.toContain("inputSchema");
		expect(data.cache).toBeDefined();
		const restored = JSON.parse(await readAll(data.cache!.id)) as Output;
		expect(restored.tools).toHaveLength(200);
		expect(restored.tools?.at(-1)?.name).toBe("read_199");
		for (const tool of restored.tools ?? []) expect(tool.description.length).toBeLessThanOrEqual(180);
		expect(readdirSync(join(directory, "mcp", "output"))).toHaveLength(1);
	});

	it("retrieves complete selected input and output schemas", async () => {
		const inputSchema = {
			type: "object" as const,
			properties: { text: { type: "string", description: '"𝄞\\\n'.repeat(6000) } },
			required: ["text"],
		};
		const outputSchema = {
			type: "object" as const,
			properties: { result: { enum: ["first", "last"] } },
			required: ["result"],
		};
		const { execute, readAll } = await createFixture({ tools: [{ name: "read_note", inputSchema, outputSchema }] });
		const { data } = await execute({ action: "describe", server: "fake", tool: "read_note" });
		expect(data.cache).toBeDefined();
		expect(JSON.parse(await readAll(data.cache!.id))).toMatchObject({ inputSchema, outputSchema });
	});

	it.each([
		"status",
		"list_servers",
		"search",
		"connect",
		"disconnect",
		"set_enabled",
		"list_resources",
		"list_prompts",
	] as const)("bounds %s metadata even when one field is oversized", async (action) => {
		const { manager, execute, readAll } = await createFixture({ bytes: 1024 });
		const metadata = { action, metadata: '"\\\n漢字'.repeat(1000) };
		vi.spyOn(manager, "handleGatewayInput").mockResolvedValueOnce(metadata);
		const { data } = await execute({ action });
		expect(data.cache).toBeDefined();
		expect(JSON.parse(await readAll(data.cache!.id))).toEqual(metadata);
	});

	it.each(["call", "read_resource", "get_prompt"] as const)(
		"preserves the original %s cache and marks failed calls",
		async (action) => {
			const output = '"\\漢字𝄞\n'.repeat(2000);
			const { connection, execute, readAll, directory } = await createFixture({ bytes: 1024, output });
			if (action === "call")
				vi.spyOn(connection, "callTool").mockResolvedValue({
					content: [{ type: "text", text: output }],
					isError: true,
				});
			const { data, result } = await execute({
				action,
				server: "fake",
				tool: "read_note",
				resourceUri: "file:///note",
				prompt: "note",
			});
			expect(result.isError === true).toBe(action === "call");
			expect(data.cache).toBeDefined();
			expect(data.truncation?.returnedBytes).toBe(Buffer.byteLength(data.content));
			const restored = await readAll(data.cache!.id);
			expect(restored).toContain(output.trim());
			expect(readdirSync(join(directory, "mcp", "output"))).toHaveLength(1);
		},
	);

	it("includes bounded cache instructions in direct MCP tool results", async () => {
		const { manager, readAll, directory } = await createFixture({ bytes: 1024, output: "a".repeat(8000) });
		await manager.listTools("fake");
		const [tool] = createMcpDirectToolDefinitions(manager);
		const result = await tool.execute("469-direct", {}, undefined, undefined, undefined as never);
		const text = getMessageText(result);
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
		const parsed = JSON.parse(text) as Output;
		expect(parsed.cache?.read).toContain("read_cache");
		expect(await readAll(parsed.cache!.id)).toBe("a".repeat(8000));
		expect(readdirSync(join(directory, "mcp", "output"))).toHaveLength(1);
	});

	it("bounds tool errors and explicitly reports unavailable cache storage", async () => {
		const { connection, execute } = await createFixture({ bytes: 1024, cacheBytes: 128 });
		vi.spyOn(connection, "callTool").mockRejectedValue(new Error("large failure ".repeat(2000)));
		const { data, result } = await execute({ action: "call", server: "fake", tool: "read_note" });
		expect(result.isError).toBe(true);
		expect(data.truncation?.truncated).toBe(true);
		expect(data.cacheUnavailable).toBe(true);
		expect(data.cache).toBeUndefined();
	});

	it("retains risk and failure status when escaped identifiers exceed the envelope budget", async () => {
		const { manager, execute } = await createFixture({ bytes: 1024 });
		vi.spyOn(manager, "handleGatewayInput").mockResolvedValueOnce({
			action: "call",
			server: "\u0001".repeat(400),
			tool: "\u0001".repeat(400),
			risk: "destructive",
			status: "failed",
			isError: true,
			content: "failure details".repeat(200),
		});
		const { result } = await execute({ action: "call", server: "fake", tool: "read_note" });
		expect(result.isError).toBe(true);
		expect(result.details.result).toMatchObject({ risk: "destructive", status: "failed", isError: true });
	});

	it("reports capacity rejection even when the already-truncated call envelope fits", async () => {
		const { execute } = await createFixture({ bytes: 1024, cacheBytes: 128, output: "x".repeat(5000) });
		const { data, result } = await execute({ action: "call", server: "fake", tool: "read_note" });
		expect(result.isError).not.toBe(true);
		expect(data.truncation?.totalBytes).toBe(5000);
		expect(data.cacheUnavailable).toBe(true);
		expect(data.cache).toBeUndefined();
	});

	it("keeps long identifiers retrievable and handles an unavailable cache without exposing the full list", async () => {
		const name = `read_${"漢字".repeat(2000)}`;
		const { execute, readAll, store } = await createFixture({
			tools: [{ name, inputSchema: { type: "object" } }],
			bytes: 1024,
		});
		const { data } = await execute({ action: "list_tools", server: "fake" });
		expect((JSON.parse(await readAll(data.cache!.id)) as Output).tools?.[0].name).toBe(name);
		vi.spyOn(store, "write").mockImplementation(() => {
			throw new Error("cache unavailable");
		});
		const uncached = await execute({ action: "list_tools", server: "fake" });
		expect(uncached.data.cacheUnavailable).toBe(true);
		expect(uncached.data.cache).toBeUndefined();
	});

	it("retains stale-state reporting and treats cancellation as cancellation", async () => {
		const { manager, gateway, connection, execute } = await createFixture();
		await manager.listTools("fake");
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
		vi.spyOn(connection, "listTools").mockRejectedValue(new Error("offline"));
		const { result } = await execute({ action: "list_tools", server: "fake" });
		expect(result.details.result).toMatchObject({ stale: true, tools: [{ name: "read_note" }] });
		await expect(
			gateway.execute(
				"469-aborted",
				{ action: "list_tools", server: "fake" },
				AbortSignal.abort(),
				undefined,
				undefined as never,
			),
		).rejects.toThrow("Operation aborted");
	});

	it("rejects invalid cache limits and UTF-8 cursors instead of repeating an empty page", async () => {
		const { store, execute } = await createFixture();
		const id = store.write("𝄞漢字");
		for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1]) {
			const { result } = await execute({ action: "read_cache", cacheId: id, limit });
			expect(result.isError).toBe(true);
		}
		const { result } = await execute({ action: "read_cache", cacheId: id, cursor: "1" });
		expect(result.isError).toBe(true);
		const { data } = await execute({ action: "read_cache", cacheId: id, limit: 4 });
		expect(data.content).toBe("𝄞");
		expect(data.nextCursor).toBe("4");
	});

	it("preserves empty catalogs and restricted discovery authorization", async () => {
		const { manager, execute } = await createFixture({ tools: [] });
		expect((await execute({ action: "list_tools", server: "fake" })).data.tools).toEqual([]);
		const restricted = createMcpToolDefinition({ manager, isRestrictedTrustedRead: () => true });
		const result = await restricted.execute(
			"469-restricted",
			{ action: "list_tools", server: "fake" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.isError).not.toBe(true);
		expect((JSON.parse(getMessageText(result)) as Output).tools).toEqual([]);
		const denied = await createFixture({ trustedTools: [] });
		const deniedGateway = createMcpToolDefinition({ manager: denied.manager, isRestrictedTrustedRead: () => true });
		const deniedResult = await deniedGateway.execute(
			"469-denied",
			{ action: "list_tools", server: "fake" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(deniedResult.isError).toBe(true);
		expect(getMessageText(deniedResult)).toContain("no configured trusted tool reads");
	});
});
