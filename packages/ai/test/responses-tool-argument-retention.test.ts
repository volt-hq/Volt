import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import type { AssistantMessageEvent } from "../src/types.ts";

describe("completed Responses tool argument retention (#350)", () => {
	it.each([
		"output_item.added",
		"output_item.done",
		"incomplete output_item.done",
		"function_call_arguments.delta",
		"function_call_arguments.done",
	])("ignores late %s before retaining arguments or changing call identity", async (lateEvent) => {
		const normalizer = new AssistantStreamNormalizer({ toolArgumentLimits: { maxBytes: 16, maxTotalBytes: 32 } });
		normalizer.push({
			type: "start",
			init: { api: "openai-responses", provider: "openai", model: "gpt-4o", timestamp: 0 },
		});
		const item = { type: "function_call", call_id: "call_edit", name: "edit", arguments: "{}", status: "completed" };
		const oversized = JSON.stringify({ newText: "private".repeat(16_384) });
		async function* frames(): AsyncGenerator<ResponseStreamEvent> {
			yield {
				type: "response.output_item.added",
				output_index: 0,
				item: { ...item, arguments: "", status: "in_progress" },
			} as ResponseStreamEvent;
			yield { type: "response.output_item.done", output_index: 0, item } as ResponseStreamEvent;
			if (lateEvent.includes("output_item")) {
				yield {
					type: lateEvent === "output_item.added" ? "response.output_item.added" : "response.output_item.done",
					output_index: 0,
					item: {
						...item,
						id: "fc_changed",
						call_id: "call_changed",
						name: "changed",
						arguments: oversized,
						status: lateEvent.startsWith("incomplete") ? "incomplete" : "completed",
					},
				} as ResponseStreamEvent;
			} else {
				yield {
					type:
						lateEvent === "function_call_arguments.delta"
							? "response.function_call_arguments.delta"
							: "response.function_call_arguments.done",
					sequence_number: 2,
					output_index: 0,
					item_id: "fc_changed",
					name: "changed",
					arguments: oversized,
					delta: oversized,
				} as ResponseStreamEvent;
			}
			// A different call must still start normally after the first one completed.
			yield {
				type: "response.output_item.added",
				output_index: 1,
				item: { ...item, id: "fc_second", call_id: "call_second", arguments: "", status: "in_progress" },
			} as ResponseStreamEvent;
			yield {
				type: "response.output_item.done",
				output_index: 1,
				item: { ...item, id: "fc_second", call_id: "call_second" },
			} as ResponseStreamEvent;
			yield { type: "response.completed", response: { id: "response", status: "completed" } } as ResponseStreamEvent;
		}
		const response = await processResponsesStream(frames(), normalizer, getModel("openai", "gpt-4o"));
		normalizer.push({ type: "done", reason: "toolUse" });
		const events: AssistantMessageEvent[] = [];
		for await (const event of normalizer.stream) events.push(event);
		const message = await normalizer.stream.result();
		expect(message).toMatchObject({
			stopReason: "toolUse",
			content: [
				{ type: "toolCall", id: "call_edit", name: "edit", arguments: {} },
				{ type: "toolCall", id: "call_second|fc_second", name: "edit", arguments: {} },
			],
		});
		expect(message.diagnostics).toBeUndefined();
		expect(normalizer.signal.aborted).toBe(false);
		expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
		expect(response.responseItems).toEqual([
			{ type: "function_call", call_id: "call_edit", name: "edit", arguments: "{}" },
			{ type: "function_call", id: "fc_second", call_id: "call_second", name: "edit", arguments: "{}" },
		]);
		expect(JSON.stringify({ message, response })).not.toContain("private");
	});
});
