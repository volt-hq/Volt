import type { AssistantMessage, Model, ToolResultMessage, Usage } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import { createSyntheticSourceInfo } from "../../../src/core/source-info.ts";
import type { SubagentDefinition, SubagentHandle } from "../../../src/core/subagents/index.ts";
import { createSubagentTool, type SubagentToolManager } from "../../../src/core/tools/subagent.ts";
import { createHarness } from "../harness.ts";

function createUsage(input: number): Usage {
	const cost = input / 1_000;
	return {
		input,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input,
		cost: {
			input: cost,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: cost,
		},
	};
}

function createAssistantMessage(
	model: Model<string>,
	text: string,
	input: number,
	timestamp: number,
	toolCallIds: string[],
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text },
			...toolCallIds.map((id) => ({ type: "toolCall" as const, id, name: "read", arguments: {} })),
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(input),
		stopReason: toolCallIds.length > 0 ? "toolUse" : "stop",
		timestamp,
	};
}

function createToolResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "result" }],
		isError: false,
		timestamp,
	};
}

describe("issue #24", () => {
	it("keeps completed subagent lifetime usage after child compaction", async () => {
		// A live session refuses direct compaction writes; it compacts itself, keeping its second prompt.
		let keptUserId: string | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", () => ({
						compaction: { summary: "summary", firstKeptEntryId: keptUserId!, tokensBefore: 300 },
					}));
				},
			],
		});
		try {
			const first = createAssistantMessage(harness.getModel(), "first", 100, 2, ["read-1", "read-2"]);
			const second = createAssistantMessage(harness.getModel(), "second", 200, 6, ["read-3"]);
			const third = createAssistantMessage(harness.getModel(), "third", 50, 10, ["read-4"]);
			const final = createAssistantMessage(harness.getModel(), "final", 0, 12, []);

			await harness.session.sessionWriter.appendMessage({ role: "user", content: "first", timestamp: 1 });
			await harness.session.sessionWriter.appendMessage(first);
			await harness.session.sessionWriter.appendMessage(createToolResult("read-1", 3));
			await harness.session.sessionWriter.appendMessage(createToolResult("read-2", 4));
			keptUserId = await harness.session.sessionWriter.appendMessage({
				role: "user",
				content: "second",
				timestamp: 5,
			});
			await harness.session.sessionWriter.appendMessage(second);
			await harness.session.sessionWriter.appendMessage(createToolResult("read-3", 7));
			await harness.session.compact();
			expect(harness.sessionManager.getLeafEntry()).toMatchObject({
				type: "compaction",
				summary: "summary",
				firstKeptEntryId: keptUserId,
			});
			await harness.session.sessionWriter.appendMessage({ role: "user", content: "third", timestamp: 9 });
			await harness.session.sessionWriter.appendMessage(third);
			await harness.session.sessionWriter.appendMessage(createToolResult("read-4", 11));
			await harness.session.sessionWriter.appendMessage(final);

			const definition: SubagentDefinition = {
				name: "researcher",
				description: "Researcher",
				systemPrompt: "Research the task.",
				source: "user",
				sourceInfo: createSyntheticSourceInfo(`${harness.tempDir}/researcher.md`, {
					source: "local",
					scope: "user",
				}),
				filePath: `${harness.tempDir}/researcher.md`,
			};
			const handle: SubagentHandle = {
				id: "sa_issue_24",
				sessionId: harness.session.sessionId,
				conversation: {} as HostedConversation,
				prompt: async () => undefined,
				abort: async () => undefined,
				getState: async () => {
					throw new Error("not used");
				},
				getTranscript: async () => {
					throw new Error("not used");
				},
				getSessionStats: async () => harness.session.getSessionStats(),
				waitForEnd: async () => ({
					id: "sa_issue_24",
					sessionId: harness.session.sessionId,
					event: { type: "agent_end", messages: [final], willRetry: false },
					status: "completed",
				}),
				dispose: async () => undefined,
				onEvent: () => () => undefined,
			};
			const manager: SubagentToolManager = {
				getDefinition: () => definition,
				startByName: async () => handle,
			};
			const tool = createSubagentTool(harness.tempDir, { manager });

			const result = await tool.execute("subagent-24", { agent: "researcher", task: "investigate" });

			expect(result.details).toMatchObject({
				status: "completed",
				toolCalls: 4,
				tokens: 350,
				usage: {
					turns: 4,
					messages: {
						user: 3,
						assistant: 4,
						toolCalls: 4,
						toolResults: 4,
						total: 11,
					},
					tokens: { input: 350, total: 350 },
				},
			});
			expect(result.details.usage?.cost).toBeCloseTo(0.35);
		} finally {
			harness.cleanup();
		}
	});
});
