import type { AgentMessage } from "@earendil-works/volt-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/volt-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact, generateSummary } from "../src/core/compaction/index.ts";

const { completeSimpleMock } = vi.hoisted(() => ({
	completeSimpleMock: vi.fn(),
}));

vi.mock("@earendil-works/volt-ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/volt-ai")>();
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

function createModel(reasoning: boolean, maxTokens = 8192, contextWindow = 200000): Model<"anthropic-messages"> {
	return {
		id: reasoning ? "reasoning-model" : "non-reasoning-model",
		name: reasoning ? "Reasoning Model" : "Non-reasoning Model",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

const mockSummaryResponse: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "## Goal\nTest summary" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet-4-5",
	usage: {
		input: 10,
		output: 10,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const messages: AgentMessage[] = [{ role: "user", content: "Summarize this.", timestamp: Date.now() }];

describe("generateSummary reasoning options", () => {
	beforeEach(() => {
		completeSimpleMock.mockReset();
		completeSimpleMock.mockResolvedValue(mockSummaryResponse);
	});

	it("uses the provided thinking level for reasoning-capable models", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			reasoning: "medium",
			apiKey: "test-key",
		});
	});

	it("does not set reasoning when thinking is off", async () => {
		await generateSummary(
			messages,
			createModel(true),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"off",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("does not set reasoning for non-reasoning models", async () => {
		await generateSummary(
			messages,
			createModel(false),
			2000,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({
			apiKey: "test-key",
		});
		expect(completeSimpleMock.mock.calls[0][2]).not.toHaveProperty("reasoning");
	});

	it("bounds serialized summary input to the selected model context", async () => {
		const contextWindow = 16_000;
		const maxOutputTokens = 2_000;
		await generateSummary(
			[{ role: "user", content: "x".repeat(200_000), timestamp: Date.now() }],
			createModel(false, maxOutputTokens, contextWindow),
			2_500,
			"test-key",
		);

		const requestContext = completeSimpleMock.mock.calls[0][1];
		const userContent = requestContext.messages[0].content[0].text as string;
		expect(userContent).toContain("characters truncated");
		expect(requestContext.systemPrompt.length + userContent.length).toBeLessThanOrEqual(
			contextWindow - maxOutputTokens - 1024,
		);
	});

	it("preserves source conversation and clamps output on 8k models", async () => {
		await generateSummary(
			[{ role: "user", content: "SOURCE ".repeat(10_000), timestamp: Date.now() }],
			createModel(false, 8_192, 8_192),
			16_384,
			"test-key",
		);

		const requestContext = completeSimpleMock.mock.calls[0][1];
		const userContent = requestContext.messages[0].content[0].text as string;
		expect(userContent).toContain("[User]: SOURCE");
		expect(completeSimpleMock.mock.calls[0][2]?.maxTokens).toBeLessThan(8_192);
	});

	it("reduces text output to preserve constrained reasoning", async () => {
		await generateSummary(
			messages,
			createModel(true, 16_384, 16_384),
			16_384,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
		);

		expect(completeSimpleMock.mock.calls[0][2]).toMatchObject({ reasoning: "medium" });
		expect(completeSimpleMock.mock.calls[0][2]?.maxTokens).toBeLessThan(8_192);
	});

	it("clamps compaction summary maxTokens to the model output cap", async () => {
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "entry-keep",
			messagesToSummarize: messages,
			turnPrefixMessages: messages,
			isSplitTurn: true,
			tokensBefore: 600000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 500000, keepRecentTokens: 20000 },
		};

		await compact(preparation, createModel(false, 128000), "test-key");

		expect(completeSimpleMock.mock.calls.map((call) => call[2]?.maxTokens)).toEqual([128000, 128000]);
	});
});
