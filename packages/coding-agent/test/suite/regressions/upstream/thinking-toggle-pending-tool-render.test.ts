// Upstream Pi regression: https://github.com/earendil-works/pi/issues/4167

import type { AssistantMessage, Usage } from "@hansjm10/volt-ai";
import {
	emptyLiveFold,
	foldLiveItems,
	type LiveFoldState,
	type ProjectedEntry,
	type ToolPresentation,
} from "@hansjm10/volt-protocol";
import { Container, type TUI } from "@hansjm10/volt-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { getMarkdownTheme, initTheme } from "../../../../src/core/theme/runtime.ts";
import { TranscriptView } from "../../../../src/modes/interactive/client/transcript-view.ts";
import type { TuiStore } from "../../../../src/modes/interactive/client/tui-store.ts";
import { stripAnsi } from "../../../../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantEntry(): ProjectedEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: TOOL_CALL_ID, name: TOOL_NAME, arguments: { delayMs: 10_000 } }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return {
		ordinal: 1,
		id: "assistant",
		parentId: null,
		type: "message",
		timestamp: "1970-01-01T00:00:00.000Z",
		payload: { message },
	};
}

function toolResultEntry(text: string): ProjectedEntry {
	const presentation: ToolPresentation = { title: TOOL_NAME, summary: [{ type: "text", key: "out", text }] };
	return {
		ordinal: 2,
		id: "result",
		parentId: "assistant",
		type: "message",
		timestamp: "1970-01-01T00:00:00.000Z",
		payload: {
			message: {
				role: "toolResult",
				toolCallId: TOOL_CALL_ID,
				toolName: TOOL_NAME,
				content: [{ type: "text", text }],
				isError: false,
				timestamp: Date.now(),
			},
		},
		view: {
			role: "tool",
			text: `${TOOL_NAME} (completed)`,
			truncated: false,
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			status: "completed",
			presentation,
		},
	};
}

/** A transcript view over a store the test sets: its transcript and live state. */
function createView(transcript: ProjectedEntry[], live: LiveFoldState) {
	const state = { transcript, live };
	const store = {
		transcript: () => state.transcript,
		get live() {
			return state.live;
		},
		phase: undefined,
	} as unknown as TuiStore;
	const container = new Container();
	const view = new TranscriptView(store, container, {
		ui: { requestRender: vi.fn() } as unknown as TUI,
		markdownTheme: () => getMarkdownTheme(),
		hideThinkingBlock: () => false,
		toolsExpanded: () => false,
		showImages: () => false,
		imageWidthCells: () => 60,
		toolCallWork: () => [],
		pendingShellRows: new Container(),
		workNoticeShown: () => {},
	});
	const text = () => stripAnsi(container.render(120).lines.join("\n"));
	return { state, view, text };
}

describe("the transcript drawn afresh while a call runs", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps an unresolved call's row following it, and shows its result once it commits", () => {
		const running = foldLiveItems(emptyLiveFold(1), [
			{
				type: "tool",
				op: "start",
				toolCallId: TOOL_CALL_ID,
				toolName: TOOL_NAME,
				presentation: { title: TOOL_NAME, activity: "waiting" },
			},
		]);
		const { state, view, text } = createView([assistantEntry()], running);
		view.show();
		// Toggling the thinking blocks draws the transcript afresh while the call runs.
		view.rebuild();
		expect(text()).toContain("[running]");

		state.transcript = [assistantEntry(), toolResultEntry("FINAL_RESULT")];
		state.live = emptyLiveFold(2);
		view.sync();

		const shown = text();
		expect(shown).toContain("FINAL_RESULT");
		expect(shown).toContain("[success]");
		expect(shown).not.toContain("[running]");
		expect(shown.split(TOOL_NAME).length - 1).toBe(1);
	});

	test("draws a completed historical call as done", () => {
		const { view, text } = createView([assistantEntry(), toolResultEntry("HISTORICAL_RESULT")], emptyLiveFold(2));
		view.show();

		expect(text()).toContain("HISTORICAL_RESULT");
		expect(text()).toContain("[success]");
	});
});
