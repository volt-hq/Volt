import type { ResponseStreamEvent } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { processResponsesStream } from "../src/providers/openai-responses-shared.ts";
import type { AssistantStreamFragment } from "../src/stream/fragments.ts";
import { AssistantStreamNormalizer } from "../src/stream/normalizer.ts";
import { parseStreamingJson } from "../src/utils/json-parse.ts";

const init = { api: "test", provider: "test", model: "test", timestamp: 0 };

async function normalize(fragments: AssistantStreamFragment[]) {
	const normalizer = new AssistantStreamNormalizer();
	normalizer.push({ type: "start", init });
	normalizer.push({ type: "toolcall_start", contentIndex: 0, id: "call-1", name: "edit" });
	for (const fragment of fragments) normalizer.push(fragment);
	normalizer.end();
	const events = [];
	for await (const event of normalizer.stream) events.push(event);
	return { events, result: await normalizer.stream.result() };
}

describe("strict tool argument completion", () => {
	it.each([
		'{"text":"unfinished',
		'{"text":"done"',
		'{"text":"a\\q"}',
		'{"text":"raw\ttab"}',
		'{"text":1,}',
		"[]",
		"null",
		'"text"',
		"true",
		"",
	])("rejects the final payload %j without promoting its preview", async (raw) => {
		const { events, result } = await normalize([
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: raw },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse" },
		]);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "invalid_tool_arguments",
				details: { code: "invalid_json", contentIndex: 0 },
			}),
		);
		expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
		expect(events.at(-1)?.type).toBe("error");
		expect(events.find((event) => event.type === "toolcall_delta")?.snapshot.content[0]).toMatchObject({
			arguments: parseStreamingJson(raw),
		});
	});

	it("rejects a valid JSON preview without explicit completion", async () => {
		const { result } = await normalize([
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"done"}' },
			{ type: "done", reason: "toolUse" },
		]);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics?.[0]?.details?.code).toBe("missing_completion");
	});

	it.each([false, true])("preserves provider failures after tool completion=%s", async (completed) => {
		const diagnostic = {
			type: "provider_transport_failure",
			timestamp: 1,
			error: { name: "Error", message: "WebSocket error" },
		};
		const { events, result } = await normalize([
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: completed ? '{"text":"done"}' : '{"text":"partial' },
			...(completed ? [{ type: "toolcall_end" as const, contentIndex: 0 }] : []),
			{ type: "error", reason: "error", errorMessage: "WebSocket error", diagnostics: [diagnostic] },
		]);
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "WebSocket error",
			diagnostics: [diagnostic],
		});
		expect(events.at(-1)?.type).toBe("error");
		expect(events.some((event) => event.type === "done")).toBe(false);
	});

	it("keeps invalid completed arguments authoritative over a later transport failure", async () => {
		const { result } = await normalize([
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"unfinished' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "error", reason: "error", errorMessage: "WebSocket error" },
		]);
		expect(result).toMatchObject({
			stopReason: "error",
			errorMessage: "Tool arguments must be a complete, valid JSON object. No tools were executed.",
		});
		expect(result.diagnostics).toContainEqual(
			expect.objectContaining({
				type: "invalid_tool_arguments",
				details: { code: "invalid_json", contentIndex: 0 },
			}),
		);
	});

	it("rejects a length-limited response even if an earlier call completed", async () => {
		const { result } = await normalize([
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"done"}' },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "length" },
		]);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics?.[0]?.details?.code).toBe("length_limit");
	});

	it("uses the complete raw final payload instead of a schema-valid preview", async () => {
		const { result } = await normalize([
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: '{"text":"preview"}' },
			{ type: "toolcall_end", contentIndex: 0, argumentsText: '{"text":"truncated' },
			{ type: "done", reason: "toolUse" },
		]);
		expect(result.stopReason).toBe("error");
		expect(JSON.stringify(result.diagnostics)).not.toContain("truncated");
	});

	it("preserves escaped code strings and immutable snapshots for a completed fragmented call", async () => {
		const args = { text: 'const path = "C:\\notes";\nconsole.log("done");' };
		const raw = JSON.stringify(args);
		const { events, result } = await normalize([
			...Array.from(
				raw,
				(argsTextDelta): AssistantStreamFragment => ({ type: "toolcall_delta", contentIndex: 0, argsTextDelta }),
			),
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse" },
		]);
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({ arguments: args });
		expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
		for (const event of events) {
			expect(Object.isFrozen(event)).toBe(true);
			if ("snapshot" in event) expect(Object.isFrozen(event.snapshot)).toBe(true);
		}
	});

	it("retains JSON object keys without treating __proto__ as a setter", async () => {
		const raw = '{"__proto__":{"text":"literal key"},"constructor":"also literal"}';
		const { result } = await normalize([
			{ type: "toolcall_delta", contentIndex: 0, argsTextDelta: raw },
			{ type: "toolcall_end", contentIndex: 0 },
			{ type: "done", reason: "toolUse" },
		]);
		expect(result.stopReason).toBe("toolUse");
		const block = result.content[0];
		if (block.type !== "toolCall") throw new Error("Expected tool call");
		expect(JSON.stringify(block.arguments)).toBe(raw);
		expect(Object.getPrototypeOf(block.arguments)).toBe(Object.prototype);
	});
});

async function responses(
	argumentsText: string,
	completion:
		| "item"
		| "arguments"
		| "incomplete"
		| "missing"
		| "incomplete_item"
		| "incomplete_without_status"
		| "queued",
) {
	const normalizer = new AssistantStreamNormalizer();
	normalizer.push({ type: "start", init });
	const item = { type: "function_call", id: "fc_1", call_id: "call-1", name: "edit", arguments: "" };
	const events: unknown[] = [
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.function_call_arguments.delta", output_index: 0, delta: '{"text":"preview"}' },
	];
	if (completion === "item" || completion === "incomplete_item") {
		if (completion === "incomplete_item")
			events.push({ type: "response.function_call_arguments.done", output_index: 0, arguments: argumentsText });
		events.push({
			type: "response.output_item.done",
			output_index: 0,
			item: {
				...item,
				arguments: argumentsText,
				status: completion === "incomplete_item" ? "incomplete" : "completed",
			},
		});
	} else if (completion !== "missing") {
		events.push({ type: "response.function_call_arguments.done", output_index: 0, arguments: argumentsText });
	}
	if (completion !== "missing") {
		const incomplete = completion === "incomplete" || completion === "incomplete_without_status";
		events.push({
			type: incomplete ? "response.incomplete" : "response.completed",
			response: {
				status:
					completion === "incomplete_without_status"
						? undefined
						: completion === "queued"
							? "queued"
							: incomplete
								? "incomplete"
								: "completed",
			},
		});
	}
	try {
		const result = await processResponsesStream(
			(async function* () {
				for (const event of events) yield event as ResponseStreamEvent;
			})(),
			normalizer,
			getModel("openai", "gpt-4o"),
		);
		if (result.stopReason === "stop" || result.stopReason === "length" || result.stopReason === "toolUse") {
			normalizer.push({ type: "done", reason: result.stopReason });
		} else {
			normalizer.push({ type: "error", reason: "error", errorMessage: "Provider response failed" });
		}
	} catch (error) {
		normalizer.push({ type: "error", reason: "error", errorMessage: String(error) });
	}
	normalizer.end();
	return normalizer.stream.result();
}

describe("Responses authoritative tool arguments", () => {
	it.each(["item", "arguments"] as const)("strictly validates %s completion payloads", async (completion) => {
		const result = await responses('{"text":"unfinished', completion);
		expect(result.stopReason).toBe("error");
		expect(result.diagnostics?.[0]?.type).toBe("invalid_tool_arguments");
	});

	it("does not turn empty final arguments into an empty object", async () => {
		expect((await responses("", "item")).stopReason).toBe("error");
	});

	it.each(["incomplete", "missing", "incomplete_item", "incomplete_without_status", "queued"] as const)(
		"rejects %s responses",
		async (completion) => {
			expect((await responses('{"text":"done"}', completion)).stopReason).toBe("error");
		},
	);

	it("admits the valid authoritative object exactly", async () => {
		const result = await responses('{"text":"final"}', "item");
		expect(result.stopReason).toBe("toolUse");
		expect(result.content[0]).toMatchObject({ id: "call-1|fc_1", arguments: { text: "final" } });
	});
});
