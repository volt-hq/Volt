import { type Context, type ContextMessage, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import { buildContext, withThinkingLevels } from "../../src/conversation/context.ts";
import { fold, restore, snapshot } from "../../src/conversation/fold.ts";
import { convertToLlm } from "../../src/conversation/messages.ts";
import { openConversation, promptAndSettle, registerFauxProvider } from "./conversation-test-utils.ts";
import { buildLog, type LogOp } from "./log-generators.ts";

const toolTurn: LogOp = {
	kind: "assistant",
	text: "working",
	toolCalls: 1,
	stopReason: "toolUse",
	model: 0,
	invalidArguments: false,
};

function levels(messages: ContextMessage[]) {
	return messages.flatMap((message) => (message.role === "user" ? [message.thinkingLevel] : []));
}

describe("request-only thinking history", () => {
	it("reconstructs history if a context hook switches to Anthropic at admission", async () => {
		const other = registerFauxProvider();
		const anthropic = registerFauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-fable-5-2", reasoning: true }],
		});
		let switched = false;
		const { conversation } = await openConversation({
			faux: other,
			resolveModel: (provider, modelId) =>
				provider === "anthropic" ? anthropic.getModel(modelId) : other.getModel(modelId),
			policy: {
				transformContext: async (messages) => {
					if (!switched) {
						switched = true;
						await conversation.setModel(anthropic.getModel());
						await conversation.setThinkingLevel("low");
					}
					return messages;
				},
			},
		});
		await conversation.setThinkingLevel("high");
		let captured: Context | undefined;
		anthropic.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("done");
			},
		]);
		await promptAndSettle(conversation, "first");
		expect(captured && levels(captured.messages)).toEqual(["high"]);
	});

	it("snapshots input, not a setting changed during streaming or tool execution", async () => {
		const state = fold(
			buildLog([
				{ kind: "thinking", level: "high" },
				{ kind: "user", text: "first", array: false },
				{ kind: "thinking", level: "low" },
				toolTurn,
				{ kind: "tool_result", pick: 0, isError: false },
				{ kind: "user", text: "second", array: true },
				{ kind: "thinking", level: "max" },
			]),
		);
		const original = structuredClone(state);
		const request = await buildContext(state, { convertToLlm, thinkingLevels: true });
		expect(levels(request)).toEqual(["high", "low"]);
		expect(state).toEqual(original);
		expect(
			await buildContext(restore(JSON.parse(JSON.stringify(snapshot(state)))), {
				convertToLlm,
				thinkingLevels: true,
			}),
		).toEqual(request);
	});

	it("seeds a split-turn compaction with the removed input's level", () => {
		const state = fold(
			buildLog([
				{ kind: "thinking", level: "high" },
				{ kind: "user", text: "long task", array: false },
				{ kind: "thinking", level: "low" },
				toolTurn,
				{ kind: "tool_result", pick: 0, isError: false },
				// branchPath is newest first: keep the assistant and its result.
				{ kind: "compaction", pick: 1, summary: "checkpoint" },
			]),
		);
		expect(levels(convertToLlm(withThinkingLevels(state)))).toEqual(["high"]);
		expect(state.context.thinkingLevel).toBe("low");
	});

	it("keeps retained inputs' levels through repeated compaction and model switches", () => {
		const state = fold(
			buildLog([
				{ kind: "thinking", level: "high" },
				{ kind: "user", text: "first", array: false },
				{ kind: "model", pick: 1 },
				{ kind: "thinking", level: "low" },
				{ kind: "user", text: "second", array: false },
				{ kind: "compaction", pick: 0, summary: "first checkpoint" },
				{ kind: "model", pick: 0 },
				{ kind: "thinking", level: "max" },
				{ kind: "user", text: "third", array: false },
				{ kind: "compaction", pick: 4, summary: "second checkpoint" },
			]),
		);
		expect(levels(convertToLlm(withThinkingLevels(state)))).toEqual(["low", "low", "max"]);
	});

	it("keeps provenance when hooks clone, reorder, redact, or filter input", async () => {
		const state = fold(
			buildLog([
				{ kind: "thinking", level: "high" },
				{ kind: "user", text: "secret", array: false },
				{ kind: "thinking", level: "low" },
				{ kind: "bash", command: "hidden", exclude: true },
				{ kind: "custom_message", text: "context", display: false, array: false },
			]),
		);
		const request = await buildContext(state, {
			convertToLlm,
			thinkingLevels: true,
			transformContext: (messages) =>
				structuredClone(messages)
					.reverse()
					.map((message) => (message.role === "user" ? { ...message, content: "redacted" } : message)),
		});
		expect(levels(request)).toEqual([undefined, "high"]);
		expect(request[1]).toMatchObject({ content: "redacted" });
	});

	it.each([
		{ kind: "custom_message", text: "reminder", display: false, array: false },
		{ kind: "bash", command: "visible", exclude: false },
		{ kind: "bash", command: "hidden", exclude: true },
		// The current leaf is the third public entry: append a summary without changing branches.
		{ kind: "navigate", pick: 3, summary: "branch context" },
	] satisfies LogOp[])("does not activate pending thinking on synthetic input %j", (synthetic) => {
		const ops: LogOp[] = [
			{ kind: "thinking", level: "high" },
			{ kind: "user", text: "task", array: false },
			{ kind: "thinking", level: "low" },
			synthetic,
			toolTurn,
			{ kind: "tool_result", pick: 0, isError: false },
		];
		const state = fold(buildLog(ops));
		const annotated = withThinkingLevels(state);
		expect(annotated[0]).toMatchObject({ role: "user", thinkingLevel: "high" });
		for (const message of annotated.slice(1)) expect(message).not.toHaveProperty("thinkingLevel");
		expect(state.context.thinkingLevel).toBe("low");
		expect(convertToLlm(withThinkingLevels(restore(JSON.parse(JSON.stringify(snapshot(state))))))).toEqual(
			convertToLlm(annotated),
		);
		const compacted = fold(
			buildLog([
				...ops,
				{ kind: "compaction", pick: 1, summary: "checkpoint" },
				{ kind: "user", text: "next task", array: false },
			]),
		);
		expect(levels(convertToLlm(withThinkingLevels(compacted)))).toEqual(["high", "low"]);
	});

	it("leaves contexts with only synthetic input unannotated", () => {
		const state = fold(
			buildLog([
				{ kind: "thinking", level: "high" },
				{ kind: "custom_message", text: "notice", display: true, array: false },
				{ kind: "bash", command: "visible", exclude: false },
			]),
		);
		expect(levels(convertToLlm(withThinkingLevels(state)))).toEqual([undefined, undefined]);
	});

	it("uses only the selected branch's thinking changes", () => {
		const state = fold(
			buildLog([
				{ kind: "thinking", level: "high" },
				{ kind: "user", text: "first", array: false },
				{ kind: "thinking", level: "low" },
				{ kind: "user", text: "abandoned", array: false },
				{ kind: "navigate", pick: 2, summary: null },
				{ kind: "thinking", level: "medium" },
				{ kind: "user", text: "branch", array: false },
			]),
		);
		expect(levels(convertToLlm(withThinkingLevels(state)))).toEqual(["high", "medium"]);
	});
});
