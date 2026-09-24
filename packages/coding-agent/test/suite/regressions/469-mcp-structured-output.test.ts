import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const fixtures: Array<{ manager: McpManager; harness: Harness; directory: string }> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const fixture of fixtures.splice(0)) {
		await fixture.manager.dispose();
		await fixture.harness.cleanupAsync();
		rmSync(fixture.directory, { recursive: true, force: true });
	}
});

async function createFixture(options: { bytes?: number; cacheBytes?: number } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "volt-469-structured-"));
	const bytes = options.bytes ?? 1024;
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			settings: { maxOutputBytes: bytes },
			servers: { fake: { command: "unused-fake-server", lifecycle: "keep-alive" } },
		},
		sourceForMcpConfigPath(join(directory, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		}),
	);
	const connection: McpClientConnection = {
		getServerVersion: () => ({ name: "fake", version: "1" }),
		listTools: async () => ({ tools: [{ name: "read_rows", inputSchema: { type: "object" } }] }),
		listResources: async () => ({ resources: [] }),
		listPrompts: async () => ({ prompts: [] }),
		readResource: async () => ({ contents: [] }),
		getPrompt: async () => ({ messages: [] }),
		callTool: async () => ({ content: [] }),
		close: async () => undefined,
	};
	const store = new McpOutputStore({
		agentDir: directory,
		maxOutputBytes: bytes,
		maxCacheEntryBytes: options.cacheBytes,
		sessionId: "469-structured",
		workspaceId: "fixture",
	});
	const manager = new McpManager({
		config: finalizeMcpConfig(merged),
		clientFactory: { connect: async () => connection },
		metadataCache: new McpMetadataCache({ agentDir: directory }),
		outputStore: store,
	});
	const harness = await createHarness({
		tools: [createMcpTool({ manager })],
		settings: { compaction: { enabled: false } },
	});
	fixtures.push({ manager, harness, directory });
	return { store, connection, harness, directory };
}

describe("#469 targeted MCP structured output", () => {
	it("retains structured data alongside exact original text even when the text fits", async () => {
		const { store, directory } = await createFixture();
		const text = "Rows available.\n漢字𝄞\n";
		const structured = { rows: [{ id: 1 }, { id: 2 }] };
		const shaped = store.shapeOutput(text, structured);
		expect(shaped.truncation).toBeUndefined();
		expect(shaped.cache).toBeDefined();
		expect(store.read(shaped.cache!.id).content).toBe(text);
		expect(store.readStructured(shaped.cache!.id).value).toEqual(structured);
		expect(readdirSync(join(directory, "mcp", "output"))).toHaveLength(1);
	});

	it("selects escaped keys, array indexes, null, and empty keys without treating missing values as null", async () => {
		const { store } = await createFixture();
		const id = store.write("text", { "a/b": { "~key": [false, null, 0, ""] }, "": "empty key" })!;
		expect(store.readStructured(id, { pointer: "/a~1b/~0key/1" }).value).toBeNull();
		expect(store.readStructured(id, { pointer: "/a~1b/~0key/0" }).value).toBe(false);
		expect(store.readStructured(id, { pointer: "/a~1b/~0key/2" }).value).toBe(0);
		expect(store.readStructured(id, { pointer: "/a~1b/~0key/3" }).value).toBe("");
		expect(store.readStructured(id, { pointer: "/" }).value).toBe("empty key");
		expect(() => store.readStructured(id, { pointer: "/missing" })).toThrow("does not identify");
	});

	it.each(["rows", "#/rows", "/bad~", "/bad~2"])("rejects malformed JSON Pointer %s", async (pointer) => {
		const { store } = await createFixture();
		const id = store.write("text", { rows: [] })!;
		expect(() => store.readStructured(id, { pointer })).toThrow("Invalid MCP JSON Pointer");
	});

	it.each(["/rows/00", "/rows/-", "/rows/length", "/rows/1", "/toString", "/__proto__"])(
		"rejects absent or non-JSON traversal %s",
		async (pointer) => {
			const { store } = await createFixture();
			const id = store.write("text", { rows: [1] })!;
			expect(() => store.readStructured(id, { pointer })).toThrow("does not identify");
		},
	);

	it("pages complete rows by the final escaped-byte budget and advances by delivered rows", async () => {
		const { store, directory } = await createFixture();
		const rows = Array.from({ length: 12 }, (_, id) => ({ id, text: '"\\漢字𝄞'.repeat(20) }));
		const id = store.write("original text", { rows })!;
		const restored: unknown[] = [];
		let offset = 0;
		do {
			const page = store.readStructured(id, { pointer: "/rows", offset, limit: 100 });
			expect(Buffer.byteLength(JSON.stringify({ action: "read_cache", ...page }))).toBeLessThanOrEqual(1024);
			expect(page.selectionRequired).toBeUndefined();
			expect(page.startOffset).toBe(offset);
			expect(Array.isArray(page.value)).toBe(true);
			const values = page.value as unknown[];
			expect(values.length).toBeGreaterThan(0);
			restored.push(...values);
			if (page.nextOffset === undefined) break;
			expect(page.nextOffset).toBe(offset + values.length);
			offset = page.nextOffset;
		} while (offset < rows.length);
		expect(restored).toEqual(rows);
		expect(readdirSync(join(directory, "mcp", "output"))).toHaveLength(1);
	});

	it("applies default and maximum row counts and returns an empty terminal page", async () => {
		const { store } = await createFixture({ bytes: 51200 });
		const rows = Array.from({ length: 120 }, (_, id) => id);
		const id = store.write("text", { rows })!;
		expect(store.readStructured(id, { pointer: "/rows" })).toMatchObject({
			value: rows.slice(0, 20),
			nextOffset: 20,
		});
		expect(store.readStructured(id, { pointer: "/rows", limit: 1000 })).toMatchObject({
			value: rows.slice(0, 100),
			nextOffset: 100,
		});
		expect(store.readStructured(id, { pointer: "/rows", offset: 120 })).toEqual({
			cacheId: id,
			pointer: "/rows",
			startOffset: 120,
			totalItems: 120,
			value: [],
		});
	});

	it("keeps oversized rows and objects addressable without partial records or nonadvancing cursors", async () => {
		const { store, directory } = await createFixture();
		const id = store.write("original text", { rows: [{ id: 42, huge: "x".repeat(4000) }] })!;
		for (const pointer of ["", "/rows", "/rows/0", "/rows/0/huge"]) {
			const selected = store.readStructured(id, { pointer });
			expect(selected.selectionRequired).toBe(true);
			expect(selected.value).toBeUndefined();
			expect(selected.nextOffset).toBeUndefined();
			expect(Buffer.byteLength(JSON.stringify({ action: "read_cache", ...selected }))).toBeLessThanOrEqual(1024);
		}
		expect(store.readStructured(id, { pointer: "/rows/0/id" }).value).toBe(42);
		expect(store.read(id).content).toBe("original text");
		expect(readdirSync(join(directory, "mcp", "output"))).toHaveLength(1);
	});

	it("rejects invalid row controls and row controls for nonarray selections", async () => {
		const { store } = await createFixture();
		const id = store.write("text", { rows: [1], status: "ok" })!;
		for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => store.readStructured(id, { pointer: "/rows", limit })).toThrow("positive safe integer");
		}
		for (const offset of [-1, 2, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => store.readStructured(id, { pointer: "/rows", offset })).toThrow("safe integer within");
		}
		expect(() => store.readStructured(id, { pointer: "/status", offset: 0 })).toThrow("require an array");
		expect(() => store.readStructured(id, { pointer: "/status", limit: 1 })).toThrow("require an array");
	});

	it("reports unavailable structured storage and preserves the byte bound without manufacturing a text-only cache", async () => {
		const { store } = await createFixture({ cacheBytes: 256 });
		const shaped = store.shapeOutput("small text", { rows: ["x".repeat(4000)] });
		expect(shaped).toEqual({ content: "small text", cacheUnavailable: true });
		const formatted = store.formatResult("call", { ...shaped, content: "x".repeat(4000) });
		expect(Buffer.byteLength(formatted.text)).toBeLessThanOrEqual(1024);
		expect(formatted.result).toMatchObject({ cacheUnavailable: true });
		expect(formatted.result).not.toHaveProperty("cache");
	});

	it("enforces identical ownership, expiration, and structured-presence checks for targeted reads", async () => {
		const { store, directory } = await createFixture();
		const id = store.write("text", { value: 1 })!;
		const otherSession = new McpOutputStore({ agentDir: directory, sessionId: "other", workspaceId: "fixture" });
		const otherWorkspace = new McpOutputStore({
			agentDir: directory,
			sessionId: "469-structured",
			workspaceId: "other",
		});
		const expired = new McpOutputStore({
			agentDir: directory,
			sessionId: "469-structured",
			workspaceId: "fixture",
			now: () => Date.now() + 8 * 24 * 60 * 60 * 1000,
		});
		expect(() => otherSession.readStructured(id)).toThrow("not available in this session");
		expect(() => otherWorkspace.readStructured(id)).toThrow("not available in this workspace");
		expect(() => expired.readStructured(id)).toThrow("expired");
		expect(() => store.readStructured(store.write("plain text")!)).toThrow("no structured content");
	});

	it("delivers selected whole rows to the provider through the existing gateway", async () => {
		const { connection, harness } = await createFixture();
		const rows = Array.from({ length: 100 }, (_, id) => ({ id, title: `Row ${id}` }));
		vi.spyOn(connection, "callTool").mockResolvedValue({
			content: [{ type: "text", text: "Rows available." }],
			structuredContent: { rows },
		});
		let checked = false;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp", { action: "call", server: "fake", tool: "read_rows" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const message = context.messages.filter((entry) => entry.role === "toolResult").at(-1);
				const text = getMessageText(message);
				expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
				const result = JSON.parse(text) as { cache: { id: string } };
				expect(result.cache.id).toBeDefined();
				return fauxAssistantMessage(
					[fauxToolCall("mcp", { action: "read_cache", cacheId: result.cache.id, pointer: "/rows", limit: 2 })],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const message = context.messages.filter((entry) => entry.role === "toolResult").at(-1);
				const text = getMessageText(message);
				expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024);
				expect(JSON.parse(text)).toMatchObject({ value: rows.slice(0, 2), nextOffset: 2, totalItems: 100 });
				checked = true;
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("Read the first two rows");
		expect(checked).toBe(true);
	});
});
