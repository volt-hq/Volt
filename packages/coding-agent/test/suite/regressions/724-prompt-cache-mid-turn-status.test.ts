import type { AgentTool } from "@hansjm10/volt-agent-core";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type PromptCacheMetadata } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { feedLiveState } from "../../../src/core/host/live-feed.ts";
import type * as Messages from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

const conversion = vi.hoisted(() => ({ fails: false }));

// Passes through until a test makes the conversion fail, which ends the turn before any provider request.
vi.mock("../../../src/core/messages.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof Messages>();
	return {
		...actual,
		convertToLlm: (messages: Parameters<typeof actual.convertToLlm>[0]) => {
			if (conversion.fails) throw new Error("conversion failed");
			return actual.convertToLlm(messages);
		},
	};
});

const MINUTE = 60_000;
const SECOND = 1_000;
const shortRetention: PromptCacheMetadata = {
	modes: ["explicit"],
	retention: { short: { ttlSeconds: 300 } },
	refreshesOnHit: true,
};

describe("issue #724: prompt cache status while a turn runs", () => {
	const harnesses: Harness[] = [];

	beforeEach(() => {
		vi.useFakeTimers({
			shouldAdvanceTime: true,
			toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
		});
	});

	afterEach(async () => {
		conversion.fails = false;
		for (const harness of harnesses.splice(0)) await harness.cleanupAsync();
		vi.useRealTimers();
	});

	async function create(options: { tools?: AgentTool[]; tokensPerSecond?: number } = {}): Promise<Harness> {
		const harness = await createHarness({
			models: [{ id: "cached", promptCache: shortRetention }],
			...(options.tools === undefined ? {} : { tools: options.tools }),
			...(options.tokensPerSecond === undefined ? {} : { tokensPerSecond: options.tokensPerSecond }),
		});
		harnesses.push(harness);
		feedLiveState(harness.session);
		return harness;
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

	function liveRetained(lastRequestAt: number) {
		return {
			kind: "prompt_cache",
			promptCache: { kind: "retained", lastRequestAt, expiresAt: lastRequestAt + 5 * MINUTE },
		};
	}

	it("keeps the live value current as each request of a turn renews the cache", async () => {
		const pause: AgentTool = {
			name: "pause",
			label: "Pause",
			description: "Wait three minutes",
			parameters: Type.Object({}),
			execute: async () => {
				await new Promise<void>((resolve) => setTimeout(resolve, 3 * MINUTE));
				return { content: [{ type: "text", text: "resumed" }], details: {} };
			},
		};
		const harness = await create({ tools: [pause] });
		const pauseCall = () => fauxAssistantMessage([fauxToolCall("pause", {})], { stopReason: "toolUse" });
		// Factories stamp each response when its request starts.
		harness.setResponses([pauseCall, pauseCall, pauseCall, () => fauxAssistantMessage("done")]);
		const requestTimes: number[] = [];
		const observed: Array<{ now: number; live: unknown }> = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant") {
				requestTimes.push(event.message.timestamp);
			} else if (event.type === "tool_execution_start") {
				observed.push({ now: Date.now(), live: harness.session.liveState.get("prompt_cache") });
			}
		});

		let toolStarted = nextEvent(harness, "tool_execution_start");
		const prompt = harness.session.prompt("go");
		for (let call = 0; call < 3; call++) {
			await toolStarted;
			if (call < 2) toolStarted = nextEvent(harness, "tool_execution_start");
			await vi.advanceTimersByTimeAsync(3 * MINUTE);
		}
		await prompt;
		await harness.session.waitForIdle();

		// The turn outlasted the retention window, yet every request renewed it, so each tool call saw a
		// live value derived from the request that precedes it.
		expect(requestTimes).toHaveLength(4);
		expect(observed.map((sample) => sample.live)).toEqual(
			requestTimes.slice(0, 3).map((requestAt) => liveRetained(requestAt)),
		);
		expect(observed[2]!.now - requestTimes[0]!).toBeGreaterThan(5 * MINUTE);
		expect(observed[2]!.now).toBeLessThan(requestTimes[2]! + 5 * MINUTE);
	});

	it("renews the live value when a request starts, before the provider answers", async () => {
		const harness = await create({ tokensPerSecond: 1 });
		harness.setResponses([() => fauxAssistantMessage("hello"), () => fauxAssistantMessage("word ".repeat(100))]);
		const firstStarted = nextEvent(harness, "message_start", (event) => event.message.role === "assistant");
		const first = harness.session.prompt("hi");
		const firstRequestAt = (await firstStarted).message.timestamp;
		await vi.advanceTimersByTimeAsync(10 * SECOND);
		await first;
		await harness.session.waitForIdle();

		// The second request starts just inside the first one's window and streams past its end.
		await vi.advanceTimersByTimeAsync(firstRequestAt + 4 * MINUTE + 50 * SECOND - Date.now());
		const secondStarted = nextEvent(harness, "message_start", (event) => event.message.role === "assistant");
		const second = harness.session.prompt("again");
		const secondRequestAt = (await secondStarted).message.timestamp;
		await vi.advanceTimersByTimeAsync(20 * SECOND);

		expect(Date.now()).toBeGreaterThan(firstRequestAt + 5 * MINUTE);
		expect(harness.session.liveState.get("prompt_cache")).toEqual(liveRetained(secondRequestAt));

		await vi.advanceTimersByTimeAsync(2 * MINUTE);
		await second;
		await harness.session.waitForIdle();
	});

	it("publishes nothing for the abort marker that ends an aborted turn", async () => {
		let release: () => void = () => {};
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		const hold: AgentTool = {
			name: "hold",
			label: "Hold",
			description: "Wait until released",
			parameters: Type.Object({}),
			execute: async () => {
				await released;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await create({ tools: [hold] });
		harness.setResponses([
			() => fauxAssistantMessage("hello"),
			() => fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
		]);
		await harness.session.prompt("hi");
		await harness.session.waitForIdle();

		const toolStarted = nextEvent(harness, "tool_execution_start");
		const prompt = harness.session.prompt("again");
		await toolStarted;
		const liveBefore = harness.session.liveState.get("prompt_cache");
		const started: AssistantMessage[] = [];
		const changes: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "prompt_cache_changed") changes.push(event.promptCache);
			else if (event.type === "message_start" && event.message.role === "assistant") started.push(event.message);
		});

		// The loop ends the aborted turn with a zero-usage marker stamped later than the last request. No
		// provider request was sent for it, so it must not move the status, even briefly.
		await vi.advanceTimersByTimeAsync(MINUTE);
		const abort = harness.session.abort();
		release();
		await Promise.all([prompt, abort]);
		await harness.session.waitForIdle();

		expect(started.map((message) => message.stopReason)).toEqual(["aborted"]);
		expect(changes).toEqual([]);
		expect(harness.session.liveState.get("prompt_cache")).toEqual(liveBefore);
	});

	it("publishes nothing for the failure marker of a turn that never reached the provider", async () => {
		const harness = await create();
		harness.setResponses([() => fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		await harness.session.waitForIdle();
		await vi.advanceTimersByTimeAsync(MINUTE);

		const liveBefore = harness.session.liveState.get("prompt_cache");
		const started: AssistantMessage[] = [];
		const changes: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "prompt_cache_changed") changes.push(event.promptCache);
			else if (event.type === "message_start" && event.message.role === "assistant") started.push(event.message);
		});

		// The turn fails converting its context, so the conversation ends it with a zero-usage error marker
		// stamped later than the last request. No provider request was sent, so it must not move the status.
		conversion.fails = true;
		await harness.session.prompt("again").catch(() => undefined);
		await harness.session.waitForIdle();

		expect(started.map((message) => message.stopReason)).toEqual(["error"]);
		expect(changes).toEqual([]);
		expect(harness.session.liveState.get("prompt_cache")).toEqual(liveBefore);
	});

	it("announces the cache ending to a live reader of a resumed session that was handed a retained status", async () => {
		const lastRequestAt = Date.now() - MINUTE;
		const harness = await createHarness({
			models: [{ id: "cached", promptCache: shortRetention }, { id: "plain" }],
			seed: (seed) =>
				seed.user("hi").assistant("hello", { usage: { input: 100, totalTokens: 100 }, timestamp: lastRequestAt }),
		});
		harnesses.push(harness);
		feedLiveState(harness.session);
		expect(harness.session.liveState.get("prompt_cache")).toEqual(liveRetained(lastRequestAt));
		const changes: unknown[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "prompt_cache_changed") changes.push(event.promptCache);
		});

		// Nothing has published yet, and a model without a prompt cache has no status to show.
		const { promptCache: _cache, ...uncached } = harness.getModel("plain")!;
		await harness.session.setModel(uncached);

		expect(harness.session.getPromptCacheStatus()).toBeUndefined();
		expect(changes).toEqual([null]);
		expect(harness.session.liveState.get("prompt_cache")).toEqual({ kind: "prompt_cache", promptCache: null });
	});
});
