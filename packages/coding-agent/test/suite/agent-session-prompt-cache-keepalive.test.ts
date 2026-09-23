import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import {
	type FauxPromptCacheRefresh,
	fauxAssistantMessage,
	fauxToolCall,
	type PromptCacheMetadata,
} from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROMPT_CACHE_AUDIT_DIRECTORY } from "../../src/core/prompt-cache-audit.ts";
import { PROMPT_CACHE_REFRESH_ENTRY_TYPE } from "../../src/core/prompt-cache-keepalive.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const MINUTE = 60_000;
const renewing: PromptCacheMetadata = {
	modes: ["explicit"],
	retention: { short: { ttlSeconds: 300 } },
	refreshesOnHit: true,
};
const refreshed: FauxPromptCacheRefresh = () => ({
	status: "refreshed",
	usage: {
		availability: "complete",
		input: 2,
		output: 0,
		cacheRead: 1000,
		cacheWrite: 0,
		totalTokens: 1002,
		cost: { input: 0, output: 0, cacheRead: 0.25, cacheWrite: 0, total: 0.25 },
	},
});

describe("AgentSession prompt-cache keepalive", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];

	beforeEach(() => {
		vi.useFakeTimers({
			shouldAdvanceTime: true,
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
		});
	});

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
		vi.useRealTimers();
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	async function create(options: {
		refresh?: FauxPromptCacheRefresh;
		settings?: Partial<Settings>;
		tools?: AgentTool[];
		agentDir?: string;
	}): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "cached", promptCache: renewing }],
			...(options.refresh === undefined ? {} : { refreshPromptCache: options.refresh }),
			...(options.settings === undefined ? {} : { settings: options.settings }),
			...(options.tools === undefined ? {} : { tools: options.tools }),
			...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
		});
		harnesses.push(harness);
		return harness;
	}

	function refreshEntries(harness: Harness) {
		return harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === PROMPT_CACHE_REFRESH_ENTRY_TYPE
					? [entry.data as { reason: string }]
					: [],
			);
	}

	it("keeps an idle cache warm for the idle window and records refresh cost and audit", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-keepalive-"));
		directories.push(agentDir);
		const harness = await create({
			refresh: refreshed,
			settings: { promptCache: { keepAliveIdleMinutes: 10 } },
			agentDir,
		});
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		await harness.session.waitForIdle();

		const settled = harness.session.getPromptCacheStatus();
		expect(settled).toMatchObject({ kind: "retained", keepAliveUntil: expect.any(Number) });
		const firstExpiry = settled?.kind === "retained" ? settled.expiresAt! : 0;

		await vi.advanceTimersByTimeAsync(4 * MINUTE + 1000);
		expect(harness.faux.state.refreshCount).toBe(1);
		const renewed = harness.session.getPromptCacheStatus();
		expect(renewed?.kind === "retained" && renewed.expiresAt! > firstExpiry).toBe(true);
		expect(refreshEntries(harness)).toEqual([expect.objectContaining({ reason: "idle" })]);
		expect(harness.session.getSessionStats().cost).toBeCloseTo(0.25, 10);
		expect(harness.eventsOfType("prompt_cache_changed").at(-1)?.promptCache).toMatchObject({ kind: "retained" });

		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		expect(harness.faux.state.refreshCount).toBe(2);
		expect(harness.session.getPromptCacheStatus()).not.toHaveProperty("keepAliveUntil");

		harnesses.splice(harnesses.indexOf(harness), 1);
		await harness.cleanupAsync();
		const auditDirectory = join(agentDir, PROMPT_CACHE_AUDIT_DIRECTORY);
		const records = readdirSync(auditDirectory).flatMap((name) =>
			readFileSync(join(auditDirectory, name), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { kind: string; reason?: string; outcome?: string }),
		);
		expect(records.map((record) => record.kind)).toEqual(["request", "refresh", "refresh", "keepalive_stop"]);
		expect(records.at(-1)).toMatchObject({ reason: "idle_window_elapsed" });
	});

	it("refreshes while a long tool call runs", async () => {
		let release: (() => void) | undefined;
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await create({ refresh: refreshed, tools: [waitTool] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const prompt = harness.session.prompt("start");
		await toolStarted;
		await vi.advanceTimersByTimeAsync(9 * MINUTE);
		expect(harness.faux.state.refreshCount).toBe(2);

		release?.();
		await prompt;
		await harness.session.waitForIdle();

		expect(refreshEntries(harness)).toEqual([
			expect.objectContaining({ reason: "in_flight" }),
			expect.objectContaining({ reason: "in_flight" }),
		]);
	});

	it("does not refresh when keepalive is off", async () => {
		const harness = await create({ refresh: refreshed, settings: { promptCache: { keepAlive: false } } });
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		await harness.session.waitForIdle();

		await vi.advanceTimersByTimeAsync(10 * MINUTE);

		expect(harness.faux.state.refreshCount).toBe(0);
		expect(harness.session.getPromptCacheStatus()).not.toHaveProperty("keepAliveUntil");
	});

	it("does not refresh when the provider cannot refresh", async () => {
		const harness = await create({});
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		await harness.session.waitForIdle();

		await vi.advanceTimersByTimeAsync(10 * MINUTE);

		expect(harness.faux.state.refreshCount).toBe(0);
		expect(harness.session.getPromptCacheStatus()).not.toHaveProperty("keepAliveUntil");
		expect(refreshEntries(harness)).toEqual([]);
	});
});
