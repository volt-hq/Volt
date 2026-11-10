import type { AgentTool } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

// A model can end its turn with no content right after a tool result that already holds the answer.
describe("regression #1060: an empty reply after a tool result", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	const lookupTool: AgentTool = {
		name: "lookup",
		label: "Lookup",
		description: "Look a value up",
		parameters: Type.Object({ key: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: '{"answer":42}' }], details: {} }),
	};

	async function start(maxRetries: number): Promise<{ harness: Harness; retryEvents: string[] }> {
		const harness = await createHarness({
			tools: [lookupTool],
			settings: { retry: { enabled: true, maxRetries, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		const retryEvents: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") retryEvents.push(`start:${event.attempt}:${event.errorMessage}`);
			if (event.type === "auto_retry_end") retryEvents.push(`end:${event.success}`);
		});
		return { harness, retryEvents };
	}

	const toolCall = () => fauxAssistantMessage([fauxToolCall("lookup", { key: "answer" })], { stopReason: "toolUse" });

	it("asks again and delivers the reply", async () => {
		const { harness, retryEvents } = await start(3);
		const retriedTail: string[] = [];
		harness.setResponses([
			toolCall(),
			fauxAssistantMessage([]),
			(context) => {
				retriedTail.push(...context.messages.slice(-2).map((message) => message.role));
				return fauxAssistantMessage("The answer is 42.");
			},
		]);

		await harness.session.prompt("what is the answer?");

		expect(harness.faux.state.callCount).toBe(3);
		expect(retryEvents).toEqual([
			"start:1:The model ended its turn without replying after a tool result.",
			"end:true",
		]);
		expect(getAssistantTexts(harness).at(-1)).toBe("The answer is 42.");
		// The retried request replaces the empty reply with a note that asks for the missing one.
		expect(retriedTail).toEqual(["toolResult", "user"]);
	});

	it("treats a reply of only blank text the same way", async () => {
		const { harness, retryEvents } = await start(3);
		harness.setResponses([toolCall(), fauxAssistantMessage(" \n"), fauxAssistantMessage("42")]);

		await harness.session.prompt("what is the answer?");

		expect(retryEvents.at(-1)).toBe("end:true");
		expect(getAssistantTexts(harness).at(-1)).toBe("42");
	});

	it("reports an error when every retry is empty", async () => {
		const { harness, retryEvents } = await start(1);
		harness.setResponses([toolCall(), fauxAssistantMessage([]), fauxAssistantMessage([])]);

		await harness.session.prompt("what is the answer?");

		expect(harness.faux.state.callCount).toBe(3);
		expect(retryEvents.at(-1)).toBe("end:false");
		const last = harness.session.messages.at(-1);
		expect(last).toMatchObject({
			role: "assistant",
			stopReason: "error",
			error: { kind: "server", retryable: true, providerCode: "empty_response" },
		});
	});

	it("leaves an empty reply to a user message alone", async () => {
		const { harness, retryEvents } = await start(3);
		harness.setResponses([fauxAssistantMessage([])]);

		await harness.session.prompt("say nothing");

		expect(harness.faux.state.callCount).toBe(1);
		expect(retryEvents).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});
});
