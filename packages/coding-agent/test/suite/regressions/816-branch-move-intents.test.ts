import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { IntentAvailability } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { feedLiveState, type LiveFeed } from "../../../src/core/host/live-feed.ts";
import { liveIntentAvailability } from "../../../src/core/protocol/intents/state.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
const feeds: LiveFeed[] = [];
afterEach(async () => {
	while (feeds.length > 0) feeds.pop()?.close();
	while (harnesses.length > 0) await harnesses.pop()?.cleanupAsync();
});

function publishedThreshold(harness: Harness): IntentAvailability | undefined {
	const value = harness.session.liveState.get("intents");
	if (value?.kind !== "intents") return undefined;
	return value.availability.find((intent) => intent.name === "set_compaction_threshold");
}

describe("regression #816: a branch move refreshes the live intents value", () => {
	it("follows the model of the branch tree navigation moves to, without a thinking, Fast mode, or plan change", async () => {
		const harness = await createHarness({
			models: [
				{ id: "first", contextWindow: 1_000_000 },
				{ id: "second", contextWindow: 1_000_000 },
			],
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		feeds.push(feedLiveState(harness.session));
		const first = harness.getModel("first");
		const second = harness.getModel("second");
		if (!first || !second) throw new Error("Expected both faux models");
		harness.settingsManager.setCompactionThresholdTokens(`${first.provider}/${first.id}`, 350_000);

		harness.setResponses([fauxAssistantMessage("on first")]);
		await harness.session.prompt("first branch");
		await harness.session.waitForIdle();
		const firstLeafId = harness.sessionManager.getLeafId();
		if (!firstLeafId) throw new Error("Expected a leaf on the first branch");
		expect(publishedThreshold(harness)?.state?.value).toBe(350_000);

		await harness.session.setModel(second);
		harness.setResponses([fauxAssistantMessage("on second")]);
		await harness.session.prompt("second branch");
		await harness.session.waitForIdle();
		expect(harness.session.model?.id).toBe("second");
		expect(publishedThreshold(harness)?.state?.value).toBe(0);

		const eventCount = harness.events.length;
		await harness.session.navigateTree(firstLeafId, { summarize: false });

		expect(harness.session.model?.id).toBe("first");
		const navigationEvents = harness.events.slice(eventCount).map((event) => event.type);
		expect(navigationEvents).not.toContain("thinking_level_changed");
		expect(navigationEvents).not.toContain("fast_mode_changed");
		expect(navigationEvents).not.toContain("planning_state_changed");
		expect(publishedThreshold(harness)?.state?.value).toBe(350_000);
		expect(harness.session.liveState.get("intents")).toEqual({
			kind: "intents",
			availability: liveIntentAvailability(harness.session),
		});
	});
});
