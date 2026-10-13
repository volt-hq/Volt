import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionError } from "../../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

const LOOP_EVENT_TYPES = [
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
] as const;

type LoopEventType = (typeof LOOP_EVENT_TYPES)[number];

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

/** Registers `handler` for every loop event. */
function onLoopEvents(volt: ExtensionAPI, handler: (type: LoopEventType, event: object) => void): void {
	volt.on("agent_start", (event) => handler("agent_start", event));
	volt.on("agent_end", (event) => handler("agent_end", event));
	volt.on("turn_start", (event) => handler("turn_start", event));
	volt.on("turn_end", (event) => handler("turn_end", event));
	volt.on("message_start", (event) => handler("message_start", event));
	volt.on("message_update", (event) => handler("message_update", event));
	volt.on("tool_execution_start", (event) => handler("tool_execution_start", event));
	volt.on("tool_execution_update", (event) => handler("tool_execution_update", event));
	volt.on("tool_execution_end", (event) => handler("tool_execution_end", event));
}

describe("regression #773: extension loop event handlers get their own copy", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		harness?.session.dispose();
		if (harness) await harness.session.waitForClosed();
		harness?.cleanup();
		harness = undefined;
	});

	it("keeps a turn_end handler's change from later handlers, session listeners, and session state", async () => {
		const seenByB: { text: string; error: unknown; toolResults: number; agentEndRoles?: string[] }[] = [];
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("turn_end", (event) => {
						if (event.message.role !== "assistant") return;
						const part = event.message.content[0];
						if (part?.type === "text") part.text = "rewritten";
						event.message.error = { kind: "unknown", retryable: false, message: "injected" };
						event.toolResults.push({
							role: "toolResult",
							toolCallId: "injected",
							toolName: "injected",
							content: [],
							isError: false,
							timestamp: 0,
						});
					});
					volt.on("agent_end", (event) => {
						event.messages.splice(0);
					});
				},
				(volt) => {
					volt.on("turn_end", (event) => {
						seenByB.push({
							text: getMessageText(event.message),
							error: event.message.role === "assistant" ? event.message.error : undefined,
							toolResults: event.toolResults.length,
						});
					});
					volt.on("agent_end", (event) => {
						const last = seenByB.at(-1);
						if (last) last.agentEndRoles = event.messages.map((message) => message.role);
					});
				},
			],
		});
		const extensionErrors: ExtensionError[] = [];
		harness.session.extensionRunner.onError((error) => extensionErrors.push(error));
		harness.setResponses([fauxAssistantMessage("original")]);

		await harness.session.prompt("hi");

		expect(extensionErrors).toEqual([]);
		expect(seenByB).toEqual([
			{ text: "original", error: undefined, toolResults: 0, agentEndRoles: ["user", "assistant"] },
		]);
		const [turnEnd] = harness.eventsOfType("turn_end");
		expect(getMessageText(turnEnd?.message)).toBe("original");
		expect(turnEnd?.message.role === "assistant" && turnEnd.message.error).toBeFalsy();
		expect(turnEnd?.toolResults).toEqual([]);
		const [agentEnd] = harness.eventsOfType("agent_end");
		expect(agentEnd?.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(harness.session.state.errorMessage).toBeUndefined();
		expect(getMessageText(harness.session.messages.at(-1))).toBe("original");
	});

	it("gives every handler of every loop event its own copy", async () => {
		const marked: LoopEventType[] = [];
		const seen = new Set<LoopEventType>();
		harness = await createHarness({
			tools: [createProgressTool()],
			extensionFactories: [
				(volt) => {
					// Two handlers in one extension: the second must not see the first's mark either.
					onLoopEvents(volt, (_type, event) => {
						Object.assign(event, { marker: "first" });
					});
					onLoopEvents(volt, (type, event) => {
						if ("marker" in event) marked.push(type);
					});
				},
				(volt) => {
					onLoopEvents(volt, (type, event) => {
						seen.add(type);
						if ("marker" in event) marked.push(type);
						Object.assign(event, { marker: "second" });
					});
				},
			],
		});
		const extensionErrors: ExtensionError[] = [];
		harness.session.extensionRunner.onError((error) => extensionErrors.push(error));
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("progress", { step: "one" }, { id: "call-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the progress tool");

		expect(extensionErrors).toEqual([]);
		expect([...seen].sort()).toEqual([...LOOP_EVENT_TYPES].sort());
		expect(marked).toEqual([]);
		for (const event of harness.events) {
			expect(event).not.toHaveProperty("marker");
		}
	});
});
