import type { AgentTool } from "@hansjm10/volt-agent-core";
import { type DeepReadonly, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

const LOOP_EVENT_TYPES: ReadonlySet<string> = new Set([
	"agent_start",
	"agent_end",
	"delivery_start",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

function isDeeplyFrozen(value: unknown): boolean {
	if (value === null || typeof value !== "object") return true;
	return Object.isFrozen(value) && Object.values(value).every(isDeeplyFrozen);
}

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

function toolTurn() {
	return [
		fauxAssistantMessage([fauxToolCall("progress", { step: "one" }, { id: "call-1" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	];
}

describe("regression #772: session events are copied once, not once per listener", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		harness?.session.dispose();
		if (harness) await harness.session.waitForClosed();
		harness?.cleanup();
		harness = undefined;
	});

	it("gives every listener the same deeply frozen event, which no listener can change", async () => {
		harness = await createHarness({ tools: [createProgressTool()] });
		harness.setResponses(toolTurn());
		const first: DeepReadonly<AgentSessionEvent>[] = [];
		const second: DeepReadonly<AgentSessionEvent>[] = [];
		const writeErrors: unknown[] = [];
		harness.session.subscribe((event) => {
			first.push(event);
			if (event.type !== "message_end" || event.message.role !== "user") return;
			try {
				// @ts-expect-error A listener's event is read-only, and frozen at runtime.
				event.message.content = "changed by a listener";
			} catch (error) {
				writeErrors.push(error);
			}
		});
		harness.session.subscribe((event) => {
			second.push(event);
		});

		await harness.session.prompt("run the progress tool");

		const types = new Set(first.map((event) => event.type));
		expect(types).toContain("message_update");
		expect(types).toContain("tool_execution_update");
		expect(second).toHaveLength(first.length);
		for (const [index, event] of first.entries()) {
			expect(second[index]).toBe(event);
			expect(isDeeplyFrozen(event)).toBe(true);
		}

		expect(writeErrors).toHaveLength(1);
		expect(writeErrors[0]).toBeInstanceOf(TypeError);
		const userEnd = second.find((event) => event.type === "message_end" && event.message.role === "user");
		expect(userEnd?.type === "message_end" && getMessageText(userEnd.message)).toBe("run the progress tool");
		expect(getUserTexts(harness)).toEqual(["run the progress tool"]);
	});

	it("awaits each pace between loop events without handing it an event", async () => {
		harness = await createHarness({ tools: [createProgressTool()] });
		harness.setResponses(toolTurn());
		const log: string[] = [];
		const paceArguments: number[] = [];
		harness.session.subscribe((event) => {
			if (LOOP_EVENT_TYPES.has(event.type)) log.push(event.type);
		});
		const unpace = harness.session.paceRuntimeEvents(async (...args: unknown[]) => {
			paceArguments.push(args.length);
			log.push("pace");
			// A pace the loop did not await would let the next loop event in before it returns.
			await new Promise((resolve) => setTimeout(resolve, 1));
			log.push("paced");
		});
		harness.session.paceRuntimeEvents(() => {
			throw new Error("a failing pace");
		});

		await harness.session.prompt("run the progress tool");

		const events = log.filter((entry) => entry !== "pace" && entry !== "paced");
		expect(events).toContain("message_update");
		expect(events).toContain("tool_execution_end");
		expect(log).toEqual(events.flatMap((type) => [type, "pace", "paced"]));
		expect(paceArguments.every((count) => count === 0)).toBe(true);
		expect(harness.session.state.errorMessage).toBeUndefined();

		unpace();
		const paced = paceArguments.length;
		harness.setResponses([fauxAssistantMessage("again")]);
		await harness.session.prompt("once more");
		expect(paceArguments).toHaveLength(paced);
	});
});
