import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createEmptyMcpMergedConfig,
	finalizeMcpConfig,
	mergeMcpConfigFile,
	sourceForMcpConfigPath,
} from "../src/core/mcp/config.ts";
import { McpMetadataCache } from "../src/core/mcp/metadata-cache.ts";
import { McpServerSupervisor } from "../src/core/mcp/server-supervisor.ts";
import type { McpClientConnection, McpLifecycle, McpRequestOptions } from "../src/core/mcp/types.ts";

function createFixture(lifecycle: McpLifecycle = "lazy") {
	vi.useFakeTimers();
	const directory = mkdtempSync(join(tmpdir(), "volt-mcp-idle-"));
	const merged = createEmptyMcpMergedConfig();
	mergeMcpConfigFile(
		merged,
		{
			settings: { metadataTimeoutMs: 20_000 },
			servers: { fake: { command: "unused", lifecycle, idleTimeoutMs: 1_000, callTimeoutMs: 60_000 } },
		},
		sourceForMcpConfigPath(join(directory, "mcp.json"), {
			scope: "user",
			label: "test",
			precedence: 1,
			shared: false,
		}),
	);
	const config = finalizeMcpConfig(merged);
	const started = Promise.withResolvers<McpRequestOptions>();
	const pending = Promise.withResolvers<void>();
	const wait = async (options: McpRequestOptions) => {
		started.resolve(options);
		await pending.promise;
	};
	const close = vi.fn<McpClientConnection["close"]>(async () => undefined);
	const connection: McpClientConnection = {
		getServerVersion: () => ({ name: "fake", version: "1" }),
		listTools: async (_params, options) => {
			await wait(options);
			return { tools: [] };
		},
		listResources: async (_params, options) => {
			await wait(options);
			return { resources: [] };
		},
		readResource: async (_params, options) => {
			await wait(options);
			return { contents: [] };
		},
		listPrompts: async (_params, options) => {
			await wait(options);
			return { prompts: [] };
		},
		getPrompt: async (_params, options) => {
			await wait(options);
			return { messages: [] };
		},
		callTool: async (_params, options) => {
			await wait(options);
			return { content: [] };
		},
		close,
	};
	const supervisor = new McpServerSupervisor({
		server: config.servers.fake,
		settings: config.settings,
		clientFactory: { connect: async () => connection },
		metadataCache: new McpMetadataCache({ agentDir: directory }),
	});
	return { directory, supervisor, connection, close, started, pending };
}

const fixtures: ReturnType<typeof createFixture>[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		fixture.pending.resolve();
		await fixture.supervisor.disconnect();
		rmSync(fixture.directory, { recursive: true, force: true });
	}
	vi.useRealTimers();
});

const operations: Array<{
	name: string;
	timeout: number;
	run: (supervisor: McpServerSupervisor) => Promise<unknown>;
}> = [
	{ name: "tool call", timeout: 60_000, run: (supervisor) => supervisor.callTool("read_note", {}) },
	{ name: "resource read", timeout: 60_000, run: (supervisor) => supervisor.readResource("file:///note") },
	{ name: "prompt read", timeout: 60_000, run: (supervisor) => supervisor.getPrompt("note", undefined) },
	{ name: "resource listing", timeout: 20_000, run: (supervisor) => supervisor.listResources(undefined) },
	{ name: "prompt listing", timeout: 20_000, run: (supervisor) => supervisor.listPrompts(undefined) },
	{ name: "metadata refresh", timeout: 20_000, run: (supervisor) => supervisor.refreshMetadata() },
];

describe("MCP idle disconnects", () => {
	it.each(operations)("waits for an active $name before starting the idle window", async ({ run, timeout }) => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const request = run(fixture.supervisor);
		const options = await fixture.started.promise;
		expect(options).toMatchObject({ timeout, resetTimeoutOnProgress: true });

		await vi.advanceTimersByTimeAsync(2_000);
		expect(fixture.close).not.toHaveBeenCalled();
		expect(fixture.supervisor.isConnected).toBe(true);

		fixture.pending.resolve();
		await request;
		await vi.advanceTimersByTimeAsync(999);
		expect(fixture.close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.close).toHaveBeenCalledTimes(1);
		expect(fixture.supervisor.isConnected).toBe(false);
	});

	it("keeps overlapping requests alive when one finishes and another sends progress", async () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const progress = vi.fn();
		const request = fixture.supervisor.callTool("read_note", {}, undefined, progress);
		const options = await fixture.started.promise;
		fixture.connection.listResources = async () => ({ resources: [] });
		await fixture.supervisor.listResources(undefined);
		options.onProgress?.({ progress: 1, total: 2 });
		expect(progress).toHaveBeenCalledWith({ progress: 1, total: 2 });

		await vi.advanceTimersByTimeAsync(2_000);
		expect(fixture.close).not.toHaveBeenCalled();
		fixture.pending.resolve();
		await request;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(fixture.close).toHaveBeenCalledTimes(1);
	});

	it.each(["failed", "aborted"] as const)("restarts the idle window after a request is %s", async (outcome) => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const controller = new AbortController();
		const request = fixture.supervisor.callTool("read_note", {}, controller.signal);
		const options = await fixture.started.promise;
		expect(options.signal).toBe(controller.signal);
		await vi.advanceTimersByTimeAsync(500);
		const rejected = expect(request).rejects.toThrow(outcome);
		const error = new Error(outcome);
		if (outcome === "aborted") {
			error.name = "AbortError";
			controller.abort(error);
		}
		fixture.pending.reject(error);
		await rejected;

		await vi.advanceTimersByTimeAsync(999);
		expect(fixture.close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.close).toHaveBeenCalledTimes(1);
	});

	it("still allows explicit disconnect during an active request", async () => {
		const fixture = createFixture();
		fixtures.push(fixture);
		const request = fixture.supervisor.callTool("read_note", {});
		await fixture.started.promise;
		await fixture.supervisor.disconnect();
		expect(fixture.close).toHaveBeenCalledTimes(1);
		fixture.pending.resolve();
		await request;
		expect(vi.getTimerCount()).toBe(0);
		expect(fixture.supervisor.isConnected).toBe(false);
	});

	it("does not schedule idle disconnects for keep-alive servers", async () => {
		const fixture = createFixture("keep-alive");
		fixtures.push(fixture);
		const request = fixture.supervisor.callTool("read_note", {});
		await fixture.started.promise;
		fixture.pending.resolve();
		await request;
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fixture.close).not.toHaveBeenCalled();
	});
});
