import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// A local client paces the agent loop to its socket drain, so a provider can outrun the loop for a whole response.
describe("regression #1067: a long response to a slow consumer", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("completes when every loop event waits a macrotask", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		// About 40,000 characters: more than 1024 faux deltas, all produced on microtasks.
		const text = Array.from({ length: 2000 }, (_, line) => `${String(line).padStart(5, "0")} slow consumer\n`).join(
			"",
		);
		harness.setResponses([fauxAssistantMessage(text)]);
		const deltas: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				deltas.push(event.assistantMessageEvent.delta);
			}
		});
		harness.session.paceRuntimeEvents(() => new Promise((resolve) => setImmediate(resolve)));

		await harness.session.prompt("write a long reply");

		const assistant = harness.session.messages.findLast((message) => message.role === "assistant");
		if (assistant?.role !== "assistant") throw new Error("Expected an assistant message");
		expect(assistant.error).toBeUndefined();
		expect((assistant.diagnostics ?? []).map((diagnostic) => diagnostic.type)).not.toContain(
			"assistant_stream_queue_limit",
		);
		expect(assistant.stopReason).toBe("stop");
		expect(assistant.content).toEqual([{ type: "text", text }]);
		expect(deltas.join("")).toBe(text);
	});
});
