import { describe, expect, it } from "vitest";
import { applyReplayPolicy } from "../src/replay-policy.ts";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "../src/types.ts";
import type { JsonObject } from "../src/utils/json-value.ts";

function user(text: string, timestamp = 0): UserMessage {
	return { role: "user", content: text, timestamp };
}

function assistant(stopReason: AssistantMessage["stopReason"], ids: string[], timestamp = 10): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: `turn ${stopReason}` },
			...ids.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: id } })),
		],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp,
	};
}

function result(toolCallId: string, timestamp = 20): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: `result ${toolCallId}` }],
		isError: false,
		timestamp,
	};
}

function synthetic(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "No result provided" }],
		isError: true,
		timestamp,
	};
}

function rejected(details: JsonObject): AssistantMessage {
	const message = assistant("error", ["call_rejected"], 30);
	message.diagnostics = [{ type: "invalid_tool_arguments", timestamp: 0, details }];
	return message;
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

/** A history exercising every rule: dropped turns, rejection feedback, and missing results. */
function history(): Message[] {
	return [
		user("start"),
		assistant("toolUse", ["a", "b"], 10),
		result("a"),
		user("interrupt", 21),
		assistant("aborted", ["c"], 22),
		result("c"),
		rejected({ code: "invalid_json", contentIndex: 1 }),
		result("call_rejected"),
		user("continue", 40),
		assistant("toolUse", ["d"], 50),
	];
}

describe("applyReplayPolicy", () => {
	it("is pure: equal output for equal input, and the input is not mutated", () => {
		const messages = deepFreeze(history());
		const first = applyReplayPolicy(messages);
		const second = applyReplayPolicy(structuredClone(history()));
		expect(second).toEqual(first);
		expect(messages).toEqual(history());
		expect(first).not.toBe(messages);
	});

	it("returns retained messages by reference", () => {
		const messages = history();
		const replay = applyReplayPolicy(messages);
		expect(replay[0]).toBe(messages[0]);
		expect(replay[1]).toBe(messages[1]);
		expect(replay[2]).toBe(messages[2]);
	});

	it("applies every rule to a mixed history", () => {
		const messages = history();
		expect(applyReplayPolicy(messages)).toEqual([
			messages[0],
			messages[1],
			messages[2],
			synthetic("b", 10),
			messages[3],
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Your previous response was discarded and none of its tool calls were executed. The arguments for the `read` tool call were not a complete, valid JSON object.",
					},
				],
				timestamp: 30,
			},
			messages[8],
			messages[9],
			synthetic("d", 50),
		]);
	});

	it("is idempotent", () => {
		const replay = applyReplayPolicy(history());
		expect(applyReplayPolicy(replay)).toEqual(replay);
	});

	it.each(["error", "aborted"] as const)("drops a %s turn and the results of its tool calls", (stopReason) => {
		const messages = [user("go"), assistant(stopReason, ["x"]), result("x"), user("again", 30)];
		expect(applyReplayPolicy(messages)).toEqual([messages[0], messages[3]]);
	});

	it("drops a trailing failed turn without synthesizing results for it", () => {
		const messages = [user("go"), assistant("aborted", ["x"])];
		expect(applyReplayPolicy(messages)).toEqual([messages[0]]);
	});

	it("keeps a later completed call that reuses an interrupted call's ID", () => {
		const messages = [
			user("go"),
			assistant("error", ["x"]),
			user("retry", 15),
			assistant("toolUse", ["x"], 20),
			result("x"),
		];
		expect(applyReplayPolicy(messages)).toEqual([messages[0], messages[2], messages[3], messages[4]]);
	});

	it("injects feedback in place of a turn whose tool call arguments were rejected", () => {
		const failure = rejected({ code: "length_limit" });
		const replay = applyReplayPolicy([user("go"), failure, result("call_rejected"), user("next", 40)]);
		expect(replay).toEqual([
			user("go"),
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "Your previous response was discarded and none of its tool calls were executed. It reached the output length limit before its tool calls were complete.",
					},
				],
				timestamp: failure.timestamp,
			},
			user("next", 40),
		]);
	});

	it("does not explain an aborted turn", () => {
		const failure = { ...rejected({ code: "invalid_json" }), stopReason: "aborted" as const };
		expect(applyReplayPolicy([user("go"), failure])).toEqual([user("go")]);
	});

	it("synthesizes a missing result before the next user message", () => {
		const messages = [user("go"), assistant("toolUse", ["x", "y"], 7), result("y"), user("next", 30)];
		expect(applyReplayPolicy(messages)).toEqual([
			messages[0],
			messages[1],
			messages[2],
			synthetic("x", 7),
			messages[3],
		]);
	});

	it("synthesizes a missing result before the next assistant message", () => {
		const messages = [user("go"), assistant("toolUse", ["x"], 7), assistant("stop", [], 8)];
		expect(applyReplayPolicy(messages)).toEqual([messages[0], messages[1], synthetic("x", 7), messages[2]]);
	});

	it("synthesizes missing results at the end", () => {
		const messages = [user("go"), assistant("toolUse", ["x"], 7)];
		expect(applyReplayPolicy(messages)).toEqual([messages[0], messages[1], synthetic("x", 7)]);
	});

	it("leaves a complete history unchanged", () => {
		const messages = [user("go"), assistant("toolUse", ["x"]), result("x"), assistant("stop", [], 30)];
		expect(applyReplayPolicy(messages)).toEqual(messages);
	});
});
