import type { Message } from "@earendil-works/volt-ai";
import { describe, expect, it } from "vitest";
import {
	CONVERSATION_MAX_CHARS,
	getConversationCharBudget,
	getSummarizationOutputTokenBudget,
	serializeConversation,
} from "../src/core/compaction/utils.ts";

function userMessage(text: string): Message {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

describe("getConversationCharBudget", () => {
	it("derives a conservative input budget from the selected model", () => {
		expect(getConversationCharBudget(10_000, 2_000, 500)).toBe(6_476);
		expect(getConversationCharBudget(200_000, 8_192, 1_000)).toBe(189_784);
		expect(getConversationCharBudget(300_000, 8_192, 1_000)).toBe(CONVERSATION_MAX_CHARS);
		expect(getConversationCharBudget(2_000, 2_000, 500)).toBe(0);
		expect(getConversationCharBudget(0, 2_000, 500)).toBe(CONVERSATION_MAX_CHARS);
		expect(getSummarizationOutputTokenBudget(8_192, 8_192, 3_000)).toBe(4_168);
		expect(getSummarizationOutputTokenBudget(2_000, 2_000, 1_000)).toBe(0);
	});
});

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toMatch(/\[\.\.\. \d+ more characters truncated\]/);
		expect(result.length).toBeLessThanOrEqual(2000 + "[Tool result]: ".length);
		expect(result).toContain("x".repeat(1900));
		expect(result).not.toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: ${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});

	it("should cap the aggregate serialized conversation", () => {
		const messages: Message[] = [userMessage(`GOAL ${"g".repeat(500)}`)];
		for (let i = 0; i < 300; i++) {
			messages.push(userMessage(`part-${i} ${"m".repeat(1900)}`));
		}
		messages.push(userMessage(`NEWEST ${"n".repeat(500)}`));

		const result = serializeConversation(messages);

		expect(result.length).toBeLessThanOrEqual(CONVERSATION_MAX_CHARS);
		// Keeps the opening goal and the newest parts, omitting the middle.
		expect(result).toContain("GOAL");
		expect(result).toContain("NEWEST");
		expect(result).toMatch(
			/\[\.\.\. \d+ earlier conversation parts omitted to fit the summarization budget \.\.\.\]/,
		);
		expect(result).not.toContain("part-0 ");
		// The kept tail is contiguous with the end of the conversation.
		expect(result).toContain("part-299 ");
	});

	it("should honor a custom aggregate budget", () => {
		const messages: Message[] = [
			userMessage(`GOAL ${"g".repeat(100)}`),
			userMessage(`middle ${"m".repeat(400)}`),
			userMessage(`NEWEST ${"n".repeat(100)}`),
		];

		const result = serializeConversation(messages, { maxChars: 400 });

		expect(result.length).toBeLessThanOrEqual(400);
		expect(result).toContain("GOAL");
		expect(result).toContain("NEWEST");
		expect(result).toContain("1 earlier conversation part omitted");
		expect(result).not.toContain("middle ");
	});

	it("should truncate and retain an oversized newest conversation part", () => {
		const messages: Message[] = [
			userMessage(`GOAL ${"g".repeat(100)}`),
			userMessage(`middle ${"m".repeat(100)}`),
			{
				role: "assistant",
				content: [{ type: "text", text: `NEWEST ${"n".repeat(1000)}` }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages, { maxChars: 400 });

		expect(result.length).toBeLessThanOrEqual(400);
		expect(result).toContain("GOAL");
		expect(result).toContain("1 earlier conversation part omitted");
		expect(result).toContain("[Assistant]: NEWEST");
		expect(result).toMatch(/\[\.\.\. \d+ more characters truncated\]/);
		expect(result).not.toContain("middle ");
	});

	it.each([0, 1, 50, 100])("should honor a small aggregate budget of %i characters", (maxChars) => {
		const messages = [userMessage("g".repeat(500)), userMessage("n".repeat(500))];

		const result = serializeConversation(messages, { maxChars });

		expect(result.length).toBeLessThanOrEqual(maxChars);
	});

	it("should not add an omission marker when under budget", () => {
		const result = serializeConversation([userMessage("short one"), userMessage("short two")]);
		expect(result).toBe("[User]: short one\n\n[User]: short two");
	});
});
