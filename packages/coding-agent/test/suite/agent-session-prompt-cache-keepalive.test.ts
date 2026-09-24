import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import {
	type FauxPromptCacheRefresh,
	fauxAssistantMessage,
	fauxToolCall,
	type PromptCacheMetadata,
	type Usage,
} from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../src/core/agent-session.ts";
import { PROMPT_CACHE_AUDIT_DIRECTORY } from "../../src/core/prompt-cache-audit.ts";
import { PROMPT_CACHE_REFRESH_ENTRY_TYPE } from "../../src/core/prompt-cache-keepalive.ts";
import type { PromptCacheStatus } from "../../src/core/prompt-cache-status.ts";
import type { Settings } from "../../src/core/settings-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const MINUTE = 60_000;
/** Opus 5.5 rates: a 24-refresh budget per request on the 5-minute tier. */
const priced = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
const renewing: PromptCacheMetadata = {
	modes: ["explicit"],
	retention: { short: { ttlSeconds: 300 } },
	refreshesOnHit: true,
};
const noUsage: Usage = {
	availability: "complete",
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
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
		unpriced?: boolean;
		tokensPerSecond?: number;
		extensionFactories?: HarnessOptions["extensionFactories"];
	}): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "cached", promptCache: renewing, ...(options.unpriced ? {} : { cost: priced }) }],
			...(options.refresh === undefined ? {} : { refreshPromptCache: options.refresh }),
			...(options.settings === undefined ? {} : { settings: options.settings }),
			...(options.tools === undefined ? {} : { tools: options.tools }),
			...(options.agentDir === undefined ? {} : { agentDir: options.agentDir }),
			...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
			...(options.extensionFactories === undefined ? {} : { extensionFactories: options.extensionFactories }),
		});
		harnesses.push(harness);
		return harness;
	}

	function retained(harness: Harness): Extract<PromptCacheStatus, { kind: "retained" }> {
		const status = harness.session.getPromptCacheStatus();
		if (status?.kind !== "retained") throw new Error(`Expected a retained prompt cache, got ${status?.kind}`);
		return status;
	}

	function nextEvent<T extends AgentSessionEvent["type"]>(
		harness: Harness,
		type: T,
		matches: (event: Extract<AgentSessionEvent, { type: T }>) => boolean = () => true,
	): Promise<Extract<AgentSessionEvent, { type: T }>> {
		return new Promise((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== type) return;
				const typed = event as Extract<AgentSessionEvent, { type: T }>;
				if (!matches(typed)) return;
				unsubscribe();
				resolve(typed);
			});
		});
	}

	/** Settle a first request, then return its start time. */
	async function settleFirstRequest(harness: Harness): Promise<number> {
		const prompt = harness.session.prompt("hi");
		await vi.advanceTimersByTimeAsync(5_000);
		await prompt;
		await harness.session.waitForIdle();
		return retained(harness).lastRequestAt;
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
		const costBefore = harness.session.getSessionStats().cost;

		await vi.advanceTimersByTimeAsync(4 * MINUTE + 1000);
		expect(harness.faux.state.refreshCount).toBe(1);
		const renewed = harness.session.getPromptCacheStatus();
		expect(renewed?.kind === "retained" && renewed.expiresAt! > firstExpiry).toBe(true);
		expect(refreshEntries(harness)).toEqual([expect.objectContaining({ reason: "idle" })]);
		expect(harness.session.getSessionStats().cost - costBefore).toBeCloseTo(0.25, 10);
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
		expect(records[0]).toMatchObject({ keepAlive: { refreshBudget: 24 } });
	});

	it("does not refresh when the model has no prices to bound refresh spend", async () => {
		const harness = await create({ refresh: refreshed, unpriced: true });
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		await harness.session.waitForIdle();

		await vi.advanceTimersByTimeAsync(10 * MINUTE);

		expect(harness.faux.state.refreshCount).toBe(0);
		expect(harness.session.getPromptCacheStatus()).not.toHaveProperty("keepAliveUntil");
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

	it.each([
		{ promptRead: false, renewedBy: "refresh" },
		{ promptRead: true, renewedBy: "request" },
	] as const)(
		"keeps the latest renewal when a request overlapping a refresh ends (prompt read: $promptRead)",
		async ({ promptRead, renewedBy }) => {
			let releaseRefresh!: () => void;
			const refreshHeld = new Promise<void>((resolve) => {
				releaseRefresh = resolve;
			});
			let refreshStartedAt = 0;
			const harness = await create({
				refresh: async (context, options, state, model) => {
					if (state.refreshCount === 1) {
						refreshStartedAt = Date.now();
						await refreshHeld;
					}
					return refreshed(context, options, state, model);
				},
				settings: { promptCache: { keepAliveIdleMinutes: 30 }, retry: { enabled: false } },
				tokensPerSecond: 1,
			});
			harness.setResponses([
				() => fauxAssistantMessage("hello"),
				// An error before the provider reports usage: no evidence it read the prompt.
				() =>
					promptRead
						? fauxAssistantMessage("partial")
						: fauxAssistantMessage("partial", {
								stopReason: "error",
								errorMessage: "stream failed",
								usage: noUsage,
							}),
			]);
			const firstRequestAt = await settleFirstRequest(harness);

			// The idle refresh falls due a minute before expiry and stays in flight.
			await vi.advanceTimersByTimeAsync(firstRequestAt + 4 * MINUTE + 1_000 - Date.now());
			expect(harness.faux.state.refreshCount).toBe(1);

			// A request starts meanwhile, and the refresh completes before the request ends.
			const requestStarted = nextEvent(harness, "message_start", (event) => event.message.role === "assistant");
			const request = harness.session.prompt("again");
			const requestAt = (await requestStarted).message.timestamp;
			const refreshApplied = nextEvent(harness, "prompt_cache_changed");
			releaseRefresh();
			await refreshApplied;
			await vi.advanceTimersByTimeAsync(10_000);
			await request;
			await harness.session.waitForIdle();

			const renewedAt = renewedBy === "refresh" ? refreshStartedAt : requestAt;
			expect(refreshStartedAt).toBeLessThan(requestAt);
			expect(retained(harness)).toMatchObject({ lastRequestAt: renewedAt, expiresAt: renewedAt + 5 * MINUTE });

			// Keepalive follows the renewed expiry: nothing early, then the next refresh on schedule.
			await vi.advanceTimersByTimeAsync(renewedAt + 4 * MINUTE - 1_000 - Date.now());
			expect(harness.faux.state.refreshCount).toBe(1);
			await vi.advanceTimersByTimeAsync(2_000);
			expect(harness.faux.state.refreshCount).toBe(2);
			expect(refreshEntries(harness)).toEqual([
				expect.objectContaining({ reason: "idle" }),
				expect.objectContaining({ reason: "idle" }),
			]);
		},
	);

	it("keeps an idle cache warm after an extension command that ran a turn", async () => {
		const harness = await create({
			refresh: refreshed,
			settings: { promptCache: { keepAliveIdleMinutes: 10 } },
			extensionFactories: [
				(volt) => {
					volt.registerCommand("custom-turn", {
						description: "Run a turn and wait for it",
						handler: async (_args, ctx) => {
							volt.sendMessage(
								{ customType: "command", content: "custom turn", display: true },
								{ triggerTurn: true },
							);
							// The turn settles while this handler is still running.
							await ctx.waitForIdle();
						},
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("custom turn response")]);

		await harness.session.prompt("/custom-turn");
		const commandEndedAt = Date.now();

		expect(harness.session.isBusy).toBe(false);
		expect(retained(harness).keepAliveUntil).toBe(commandEndedAt + 10 * MINUTE);
		await vi.advanceTimersByTimeAsync(4 * MINUTE + 1_000);
		expect(refreshEntries(harness)).toEqual([expect.objectContaining({ reason: "idle" })]);
	});

	it("refreshes while an extension command waits on the user, then starts the idle window when it returns", async () => {
		let answer!: () => void;
		const harness = await create({
			refresh: refreshed,
			settings: { promptCache: { keepAliveIdleMinutes: 10 } },
			extensionFactories: [
				(volt) => {
					volt.registerCommand("ask", {
						description: "Wait for an answer",
						handler: async () => {
							await new Promise<void>((resolve) => {
								answer = resolve;
							});
						},
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("hello")]);
		const firstRequestAt = await settleFirstRequest(harness);

		await vi.advanceTimersByTimeAsync(MINUTE);
		const command = harness.session.prompt("/ask");
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.session.isBusy).toBe(true);
		expect(retained(harness)).not.toHaveProperty("keepAliveUntil");

		// Outlast the idle window measured from before the command.
		await vi.advanceTimersByTimeAsync(firstRequestAt + 11 * MINUTE - Date.now());
		expect(refreshEntries(harness)).toEqual([
			expect.objectContaining({ reason: "in_flight" }),
			expect.objectContaining({ reason: "in_flight" }),
		]);

		const answeredAt = Date.now();
		answer();
		await command;
		expect(retained(harness).keepAliveUntil).toBe(answeredAt + 10 * MINUTE);
		await vi.advanceTimersByTimeAsync(firstRequestAt + 12 * MINUTE + 1_000 - Date.now());
		expect(refreshEntries(harness).at(-1)).toMatchObject({ reason: "idle" });
		expect(harness.faux.state.refreshCount).toBe(3);
	});

	it("treats auto-retry backoff as work, then starts the idle window when the prompt settles", async () => {
		const harness = await create({
			refresh: refreshed,
			settings: {
				promptCache: { keepAliveIdleMinutes: 10 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 6 * MINUTE },
			},
		});
		harness.setResponses([
			() => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			() => fauxAssistantMessage("recovered"),
		]);
		let settledAt = 0;
		harness.session.subscribe((event) => {
			if (event.type === "agent_settled") settledAt = Date.now();
		});
		const retryStarted = nextEvent(harness, "auto_retry_start");
		const prompt = harness.session.prompt("hi");
		await retryStarted;
		const failedAt = retained(harness).lastRequestAt;

		// The backoff releases the Harness lease, yet the prompt is still running.
		await vi.advanceTimersByTimeAsync(failedAt + 4 * MINUTE + 1_000 - Date.now());
		expect(harness.session.isBusy).toBe(true);
		expect(retained(harness)).not.toHaveProperty("keepAliveUntil");
		expect(refreshEntries(harness)).toEqual([expect.objectContaining({ reason: "in_flight" })]);

		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		await prompt;
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(retained(harness).keepAliveUntil).toBe(settledAt + 10 * MINUTE);
	});

	it("keeps an idle cache warm after a compaction that fails", async () => {
		const harness = await create({ refresh: refreshed, settings: { promptCache: { keepAliveIdleMinutes: 10 } } });
		harness.setResponses([fauxAssistantMessage("hello")]);
		await settleFirstRequest(harness);

		// No summary response is queued. compaction_end fires while the Harness still holds the compaction lease.
		await expect(harness.session.compact()).rejects.toThrow(/Summarization failed/);
		const compactionEndedAt = Date.now();

		expect(retained(harness).keepAliveUntil).toBe(compactionEndedAt + 10 * MINUTE);
		await vi.advanceTimersByTimeAsync(4 * MINUTE);
		expect(refreshEntries(harness)).toEqual([expect.objectContaining({ reason: "idle" })]);
	});

	it("measures the idle window from the end of a tree navigation", async () => {
		const harness = await create({ refresh: refreshed, settings: { promptCache: { keepAliveIdleMinutes: 10 } } });
		harness.setResponses([fauxAssistantMessage("hello")]);
		await settleFirstRequest(harness);
		const settledUntil = retained(harness).keepAliveUntil!;

		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		// Tree navigation holds a Harness lease but emits no agent or compaction events.
		await harness.session.navigateTree(harness.sessionManager.getLeafId()!);
		const navigatedAt = Date.now();

		expect(retained(harness).keepAliveUntil).toBe(navigatedAt + 10 * MINUTE);
		expect(navigatedAt + 10 * MINUTE).toBeGreaterThan(settledUntil);
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
