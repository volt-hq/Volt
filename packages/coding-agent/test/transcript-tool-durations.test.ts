import type { AssistantMessage, Usage } from "@hansjm10/volt-ai";
import {
	emptyLiveFold,
	foldLiveItems,
	type LiveFoldState,
	type LiveItem,
	type ProjectedEntry,
	type ToolPresentation,
} from "@hansjm10/volt-protocol";
import { Container, type TUI } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getMarkdownTheme, initTheme } from "../src/core/theme/runtime.ts";
import { type TranscriptSource, TranscriptView } from "../src/modes/interactive/client/transcript-view.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** The host's clock and the TUI's: they share the machine. */
const NOW = 1_000_000;

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let ordinal = 0;

function presentation(call: string): ToolPresentation {
	return { title: `probe ${call}`, showsDuration: true };
}

function assistantEntry(id: string, calls: readonly string[]): ProjectedEntry {
	const message: AssistantMessage = {
		role: "assistant",
		content: calls.map((call) => ({ type: "toolCall" as const, id: call, name: "probe", arguments: {} })),
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: NOW,
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

/** A call's committed result, with the duration the host timed, if any. */
function resultEntry(call: string, durationMs?: number): ProjectedEntry {
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
				timestamp: NOW,
				...(durationMs === undefined ? {} : { durationMs }),
			},
		},
		view: {
			role: "tool",
			text: `probe ${call} (completed)`,
			truncated: false,
			toolCallId: call,
			toolName: "probe",
			status: "completed",
			...(durationMs === undefined ? {} : { durationMs }),
			presentation: presentation(call),
		},
	};
}

function start(call: string, startedAt?: number): LiveItem {
	return {
		type: "tool",
		op: "start",
		toolCallId: call,
		toolName: "probe",
		presentation: presentation(call),
		...(startedAt === undefined ? {} : { startedAt }),
	};
}

function end(call: string, endedAt: number): LiveItem {
	return { type: "tool", op: "end", toolCallId: call, toolName: "probe", isError: false, endedAt };
}

/** A transcript view over a store the test sets: its transcript and live state. */
function createView(transcript: ProjectedEntry[], live: LiveFoldState = emptyLiveFold(0)) {
	const state = { transcript, live };
	const store: TranscriptSource = {
		transcript: () => state.transcript,
		get live() {
			return state.live;
		},
		phase: undefined,
	};
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
	/** The row header of `call`: its state glyph, title, and the duration it shows. */
	const header = (call: string): string => {
		const lines = container.render(100).lines.map((line) => stripAnsi(line).trim());
		const line = lines.find((candidate) => candidate.includes(`probe ${call}`));
		if (line === undefined) throw new Error(`No row for ${call}`);
		return line;
	};
	return { state, view, header };
}

describe("tool call durations in the transcript", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows a committed call's duration from its result, and none for a result the host did not time", () => {
		const { view, header } = createView([
			assistantEntry("a1", ["c1", "c2"]),
			resultEntry("c1", 6_000),
			resultEntry("c2"),
		]);
		view.show();
		expect(header("c1")).toBe("✓ probe c1 (6.0s)");
		expect(header("c2")).toBe("✓ probe c2");
		expect(vi.getTimerCount()).toBe(0);
		view.dispose();
	});

	it("counts a running call from when the host started it, and an ended one to when the host ended it", () => {
		const live = foldLiveItems(emptyLiveFold(1), [
			start("c1", NOW - 3_000),
			start("c2", NOW - 5_000),
			end("c2", NOW - 1_500),
			start("c3"),
		]);
		const { state, view, header } = createView([assistantEntry("a1", ["c1", "c2", "c3"])], live);
		view.show();
		// The TUI saw the call only now: it still counts from the host's start.
		expect(header("c1")).toBe("● probe c1 (3.0s)");
		expect(header("c2")).toBe("✓ probe c2 (3.5s)");
		// Without the host's start a call shows no time.
		expect(header("c3")).toBe("● probe c3");
		expect(vi.getTimerCount()).toBe(1);

		vi.advanceTimersByTime(1_000);
		expect(header("c1")).toBe("● probe c1 (4.0s)");
		expect(header("c2")).toBe("✓ probe c2 (3.5s)");

		state.live = foldLiveItems(state.live, [end("c1", NOW + 1_200), end("c3", NOW + 1_200)]);
		view.sync();
		vi.advanceTimersByTime(5_000);
		expect(header("c1")).toBe("✓ probe c1 (4.2s)");
		expect(header("c3")).toBe("✓ probe c3");
		expect(vi.getTimerCount()).toBe(0);
		view.dispose();
	});

	it("keeps the host's durations when the transcript draws afresh or refreshes", () => {
		const live = foldLiveItems(emptyLiveFold(3), [start("c2", NOW - 3_000)]);
		const { state, view, header } = createView(
			[assistantEntry("a1", ["c1"]), resultEntry("c1", 6_000), assistantEntry("a2", ["c2"])],
			live,
		);
		view.show();
		vi.advanceTimersByTime(2_000);
		expect(header("c1")).toBe("✓ probe c1 (6.0s)");
		expect(header("c2")).toBe("● probe c2 (5.0s)");

		// Toggling the thinking blocks or reloading draws every row afresh.
		view.rebuild();
		expect(header("c1")).toBe("✓ probe c1 (6.0s)");
		expect(header("c2")).toBe("● probe c2 (5.0s)");
		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(1_000);
		expect(header("c2")).toBe("● probe c2 (6.0s)");

		// A snapshot of the same conversation presents the drawn entries again.
		state.transcript = [assistantEntry("a1", ["c1"]), resultEntry("c1", 6_000), assistantEntry("a2", ["c2"])];
		view.refresh();
		expect(header("c1")).toBe("✓ probe c1 (6.0s)");
		expect(header("c2")).toBe("● probe c2 (6.0s)");
		view.dispose();
	});
});
