import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()!.cleanupAsync();
});

async function setup(): Promise<Harness> {
	const harness = await createHarness({
		models: [
			{ id: "large", contextWindow: 1_000_000 },
			{ id: "other", contextWindow: 1_000_000 },
		],
		settings: { compaction: { keepRecentTokens: 1 }, retry: { enabled: false } },
		tools: [
			{
				name: "probe",
				label: "Probe",
				description: "Return a local test result",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "probe completed" }], details: {} }),
			},
		],
	});
	harnesses.push(harness);
	harness.session.setSessionName("threshold test");
	const model = harness.getModel();
	harness.settingsManager.setCompactionThresholdTokens(`${model.provider}/${model.id}`, 350_000);
	// The faux provider reports prompt/cache usage for this large saved history.
	harness.sessionManager.appendMessage({ role: "user", content: "older history ".repeat(65_000), timestamp: 1 });
	return harness;
}

describe("model-specific automatic compaction", () => {
	it("compacts after a final response and does not recompact stale retained usage on the next prompt", async () => {
		const harness = await setup();
		harness.setResponses([fauxAssistantMessage("Finished the task"), fauxAssistantMessage("Checkpoint")]);
		await harness.session.prompt("Finish");
		expect(harness.eventsOfType("compaction_start")).toEqual([{ type: "compaction_start", reason: "threshold" }]);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
			aborted: false,
			willRetry: false,
			result: { summary: "Checkpoint" },
		});
		expect(harness.eventsOfType("compaction_end")[0].result!.tokensBefore).toBeGreaterThanOrEqual(350_000);
		expect(harness.session.model?.contextWindow).toBe(1_000_000);
		harness.setResponses([fauxAssistantMessage("Next reply")]);
		await harness.session.prompt("Next task");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.session.getLastAssistantText()).toBe("Next reply");
	});

	it("finishes tool execution before compacting and resumes with the checkpoint", async () => {
		const harness = await setup();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", {})], { stopReason: "toolUse" }),
			(context) => {
				expect(harness.eventsOfType("tool_execution_end")).toHaveLength(1);
				expect(JSON.stringify(context.messages)).toContain("probe completed");
				return fauxAssistantMessage("Tool checkpoint");
			},
			(context) => {
				expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
				expect(getMessageText(context.messages[0])).toContain("Tool checkpoint");
				return fauxAssistantMessage("Continued successfully");
			},
		]);
		await harness.session.prompt("Run probe and finish");
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({ aborted: false, willRetry: true });
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.session.getLastAssistantText()).toBe("Continued successfully");
	});

	it("uses the selected model's threshold when switching models before the next prompt", async () => {
		const harness = await setup();
		await harness.session.setModel(harness.getModel("other")!);
		harness.setResponses([fauxAssistantMessage("Other model reply")]);
		await harness.session.prompt("Finish on the other model");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		await harness.session.setModel(harness.getModel("large")!);
		harness.setResponses([
			fauxAssistantMessage("Model switch checkpoint"),
			fauxAssistantMessage("Large model reply"),
		]);
		await harness.session.prompt("Continue with the configured model");
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0].result?.summary).toBe("Model switch checkpoint");
		expect(harness.session.getLastAssistantText()).toBe("Large model reply");
	});
});
