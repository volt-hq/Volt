import type { AssistantMessage } from "@hansjm10/volt-ai";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { buildRpcSessionState } from "../../src/core/rpc/session-state.ts";
import { createHarness, type Harness } from "./harness.ts";

function lastAssistant(harness: Harness): AssistantMessage {
	const message = harness.session.messages.findLast(
		(candidate): candidate is AssistantMessage => candidate.role === "assistant",
	);
	if (!message) throw new Error("expected an assistant message");
	return message;
}

describe("AgentSession prompt cache status", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("publishes the latest request after a turn settles and exposes it in RPC state", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		expect(harness.session.getPromptCacheStatus()).toBeUndefined();

		harness.setResponses([fauxAssistantMessage("hello")]);
		await harness.session.prompt("hi");
		await harness.session.waitForIdle();

		// The faux provider caches implicitly without a published retention window.
		const expected = { kind: "retained", lastRequestAt: lastAssistant(harness).timestamp };
		expect(harness.session.getPromptCacheStatus()).toEqual(expected);
		expect(harness.eventsOfType("prompt_cache_changed").map((event) => event.promptCache)).toEqual([expected]);
		expect(buildRpcSessionState(harness.session).promptCache).toEqual(expected);
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
