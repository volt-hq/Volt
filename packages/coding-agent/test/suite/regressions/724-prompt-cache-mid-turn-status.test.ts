import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall, type PromptCacheMetadata } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { feedLiveState } from "../../../src/core/host/live-feed.ts";
import { createHarness, type Harness } from "../harness.ts";

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
});
