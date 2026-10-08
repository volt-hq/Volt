import type { AssistantMessage } from "@hansjm10/volt-ai";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { feedLiveState } from "../../src/core/host/live-feed.ts";
import { createHarness, type Harness } from "./harness.ts";

function lastAssistant(harness: Harness): AssistantMessage {
	const message = harness.session.messages.findLast(
		(candidate): candidate is AssistantMessage => candidate.role === "assistant",
	);
	if (!message) throw new Error("expected an assistant message");
	return message;
}

/** Reload rebuilds the model registry, which unregisters the harness's faux provider; register it again. */
async function reload(harness: Harness): Promise<void> {
	await harness.session.reload();
	harness.session.modelRegistry.client.registerProvider(harness.faux);
}

describe("AgentSession prompt cache status", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("publishes the latest request after a turn settles and serves it as the live prompt cache value", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		feedLiveState(harness.session);
		expect(harness.session.getPromptCacheStatus()).toBeUndefined();
		expect(harness.session.liveState.get("prompt_cache")).toEqual({ kind: "prompt_cache", promptCache: null });

		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		await harness.session.waitForIdle();

		// The faux provider caches implicitly without a published retention window.
		const expected = { kind: "retained", lastRequestAt: lastAssistant(harness).timestamp };
		expect(harness.session.getPromptCacheStatus()).toEqual(expected);
		expect(harness.eventsOfType("prompt_cache_changed").map((event) => event.promptCache)).toEqual([expected]);
		expect(harness.session.liveState.get("prompt_cache")).toEqual({ kind: "prompt_cache", promptCache: expected });
	});

	const retentionModels = [
		{
			id: "cached",
			promptCache: {
				modes: ["explicit" as const],
				retention: { short: { ttlSeconds: 300 }, long: { ttlSeconds: 3600 } },
			},
		},
	];

	it("keeps each request's documented window when promptCache.retention changes on reload", async () => {
		const harness = await createHarness({ models: retentionModels });
		harnesses.push(harness);
		harness.setResponses([
			() => fauxAssistantMessage("one"),
			() => fauxAssistantMessage("two"),
			() => fauxAssistantMessage("three"),
		]);
		await harness.session.prompt("a");
		await harness.session.waitForIdle();
		const shortRequestAt = lastAssistant(harness).timestamp;
		const shortRetained = {
			kind: "retained",
			lastRequestAt: shortRequestAt,
			expiresAt: shortRequestAt + 300_000,
		};
		expect(harness.session.getPromptCacheStatus()).toEqual(shortRetained);

		// The request already sent asked the provider for the short window; a longer setting cannot extend it.
		harness.settingsManager.applyOverrides({ promptCache: { retention: "long" } });
		await reload(harness);
		expect(harness.session.getPromptCacheStatus()).toEqual(shortRetained);

		await harness.session.prompt("b");
		await harness.session.waitForIdle();
		const longRequestAt = lastAssistant(harness).timestamp;
		const longRetained = {
			kind: "retained",
			lastRequestAt: longRequestAt,
			expiresAt: longRequestAt + 3_600_000,
		};
		expect(harness.session.getPromptCacheStatus()).toEqual(longRetained);
		expect(harness.eventsOfType("prompt_cache_changed").at(-1)?.promptCache).toEqual(longRetained);

		// The request already sent asked for the long window and keeps it after a shorter setting.
		harness.settingsManager.applyOverrides({ promptCache: { retention: "short" } });
		await reload(harness);
		expect(harness.session.getPromptCacheStatus()).toEqual(longRetained);

		await harness.session.prompt("c");
		await harness.session.waitForIdle();
		const renewedAt = lastAssistant(harness).timestamp;
		expect(harness.session.getPromptCacheStatus()).toEqual({
			kind: "retained",
			lastRequestAt: renewedAt,
			expiresAt: renewedAt + 300_000,
		});
	});

	it("applies the current promptCache.retention to requests from before the session opened", async () => {
		const requestAt = Date.now() - 10_000;
		const harness = await createHarness({
			models: retentionModels,
			seed: (seed) => seed.user("hi").assistant("hello", { timestamp: requestAt, usage: { input: 1000 } }),
		});
		harnesses.push(harness);
		expect(harness.session.getPromptCacheStatus()).toEqual({
			kind: "retained",
			lastRequestAt: requestAt,
			expiresAt: requestAt + 300_000,
		});

		harness.settingsManager.applyOverrides({ promptCache: { retention: "long" } });
		await reload(harness);

		const longRetained = { kind: "retained", lastRequestAt: requestAt, expiresAt: requestAt + 3_600_000 };
		expect(harness.session.getPromptCacheStatus()).toEqual(longRetained);
		expect(harness.eventsOfType("prompt_cache_changed").at(-1)?.promptCache).toEqual(longRetained);
	});

	it("reports a cold cache after switching to a model without prior requests", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-a", name: "Faux A" },
				{ id: "faux-b", name: "Faux B" },
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		await harness.session.waitForIdle();

		await harness.session.setModel(harness.getModel("faux-b")!);

		expect(harness.session.getPromptCacheStatus()).toEqual({ kind: "model_changed" });
		expect(harness.eventsOfType("prompt_cache_changed").at(-1)?.promptCache).toEqual({ kind: "model_changed" });
	});
});
