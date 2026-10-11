import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createHarness, type Harness } from "../harness.ts";

function createProgressTool(): AgentTool {
	return {
		name: "progress",
		label: "Progress",
		description: "Reports one partial result, then completes",
		parameters: Type.Object({ step: Type.String() }),
		execute: async (_toolCallId, _params, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "partial" }], details: { step: "partial" } });
			return { content: [{ type: "text", text: "complete" }], details: { step: "final" } };
		},
	};
}

function resultText(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("regression #750: extension loop events no extension handles", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		harness?.session.dispose();
		if (harness) await harness.session.waitForClosed();
		harness?.cleanup();
		harness = undefined;
	});

	it("delivers handled events in isolation and publishes unhandled ones to session listeners", async () => {
		const handled = { message_update: 0, tool_execution_update: 0, tool_execution_end: 0 };
		harness = await createHarness({
			tools: [createProgressTool()],
			extensionFactories: [
				(volt) => {
					// message_start and tool_execution_start stay unhandled.
					volt.on("message_update", (event) => {
						handled.message_update++;
						if (event.message.role === "assistant") event.message.content.splice(0);
					});
					volt.on("tool_execution_update", (event) => {
						handled.tool_execution_update++;
						event.partialResult.content.splice(0);
					});
					volt.on("tool_execution_end", (event) => {
						handled.tool_execution_end++;
						event.result.content.splice(0);
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("progress", { step: "one" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the progress tool");

		const updates = harness.eventsOfType("message_update");
		const toolUpdates = harness.eventsOfType("tool_execution_update");
		const toolEnds = harness.eventsOfType("tool_execution_end");
		expect(updates.length).toBeGreaterThan(0);
		expect(handled).toEqual({
			message_update: updates.length,
			tool_execution_update: toolUpdates.length,
			tool_execution_end: toolEnds.length,
		});

		// Handler mutations stay in the handler's copy.
		for (const update of updates) {
			expect(update.message.role === "assistant" && update.message.content.length > 0).toBe(true);
		}
		expect(toolUpdates.map((event) => resultText(event.partialResult))).toEqual(["partial"]);
		expect(toolEnds.map((event) => resultText(event.result))).toEqual(["complete"]);

		// Unhandled events still reach session listeners in full.
		const assistantStarts = harness
			.eventsOfType("message_start")
			.filter((event: Extract<AgentSessionEvent, { type: "message_start" }>) => event.message.role === "assistant");
		expect(assistantStarts).toHaveLength(2);
		expect(harness.eventsOfType("tool_execution_start")).toEqual([
			{ type: "tool_execution_start", toolCallId: "call-1", toolName: "progress", args: { step: "one" } },
		]);
		expect(harness.session.state.streamingMessage).toBeUndefined();
		expect(harness.session.state.pendingToolExecutions.size).toBe(0);
	});
});
