import type { AssistantMessage, Usage } from "@hansjm10/volt-ai";
import { emptyLiveFold, type ProjectedEntry, type ToolPresentation } from "@hansjm10/volt-protocol";
import { Container, getKeybindings, setKeybindings, type TUI } from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { getMarkdownTheme, initTheme } from "../src/core/theme/runtime.ts";
import { TranscriptView } from "../src/modes/interactive/client/transcript-view.ts";
import type { TuiStore } from "../src/modes/interactive/client/tui-store.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let ordinal = 0;

function assistantEntry(id: string, calls: readonly string[]): ProjectedEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall" as const, id: call, name: "probe", arguments: {} })),
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return {
		ordinal: ++ordinal,
		id,
		parentId: null,
		type: "message",
		timestamp: "1970-01-01T00:00:00.000Z",
		payload: { message },
	};
}

/** A call's result, presented with a body (`more`) or as its summary only. */
function resultEntry(call: string, more: boolean): ProjectedEntry {
	const presentation: ToolPresentation = {
		title: `probe ${call}`,
		summary: [{ type: "text", key: "out", text: `${call} summary` }],
		...(more ? { body: [{ type: "text" as const, key: "out", text: `${call} body` }] } : {}),
	};
	return {
		ordinal: ++ordinal,
		id: `result-${call}`,
		parentId: null,
		type: "message",
		timestamp: "1970-01-01T00:00:00.000Z",
		payload: {
			message: {
				role: "toolResult",
				toolCallId: call,
				toolName: "probe",
				content: [{ type: "text", text: call }],
				isError: false,
				timestamp: Date.now(),
			},
		},
		view: {
			role: "tool",
			text: `probe ${call} (completed)`,
			truncated: false,
			toolCallId: call,
			toolName: "probe",
			status: "completed",
			presentation,
		},
	};
}

function createView(transcript: ProjectedEntry[]) {
	const state = { transcript };
	const store = {
		transcript: () => state.transcript,
		live: emptyLiveFold(0),
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
	const lines = () => container.render(100).lines.map((line) => stripAnsi(line).trimEnd());
	return { state, view, lines };
}

/** The calls whose rows say how to expand them, in order. */
function hintedCalls(lines: readonly string[]): string[] {
	const calls: string[] = [];
	let current: string | undefined;
	for (const line of lines) {
		const title = /probe (\S+)$/.exec(line);
		if (title) current = title[1];
		else if (line.includes("to expand") && current !== undefined) calls.push(current);
	}
	return calls;
}

describe("the transcript's expand hint", () => {
	const previousBindings = getKeybindings();

	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => {
		setKeybindings(previousBindings);
	});

	it("shows only under the newest call that expanding shows more of", () => {
		const { state, view, lines } = createView([
			assistantEntry("a1", ["c1", "c2", "c3"]),
			resultEntry("c1", true),
			resultEntry("c2", true),
			resultEntry("c3", false),
		]);
		view.show();
		expect(hintedCalls(lines())).toEqual(["c2"]);
		expect(lines().join("\n")).toContain("c1 summary");

		// A newer call with more to show takes the hint.
		state.transcript = [...state.transcript, assistantEntry("a2", ["c4"]), resultEntry("c4", true)];
		view.sync();
		expect(hintedCalls(lines())).toEqual(["c4"]);
	});
});
