import type { AssistantMessage } from "@hansjm10/volt-ai";
import { emptyLiveFold, foldLiveItems, type LiveFoldState, type ProjectedEntry } from "@hansjm10/volt-protocol";
import { Container, type TUI } from "@hansjm10/volt-tui";
import { describe, expect, test, vi } from "vitest";
import { getMarkdownTheme, initTheme } from "../../../src/core/theme/runtime.ts";
import { TranscriptView } from "../../../src/modes/interactive/client/transcript-view.ts";
import type { TuiStore } from "../../../src/modes/interactive/client/tui-store.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

function createAbortedAssistantMessage(): AssistantMessage {
	const toolCall = { type: "toolCall" as const, id: "tool-105", name: "slow_tool", arguments: {} };
	const message: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		error: { kind: "aborted", retryable: false, message: "Request was aborted" },
		timestamp: 0,
	};
	Object.freeze(toolCall.arguments);
	Object.freeze(toolCall);
	Object.freeze(message.content);
	Object.freeze(message.usage.cost);
	Object.freeze(message.usage);
	return Object.freeze(message);
}

describe("InteractiveMode aborted stream snapshots (#105)", () => {
	test("renders a retry message without mutating the frozen committed message", () => {
		initTheme("dark");
		const message = createAbortedAssistantMessage();
		const entry = Object.freeze({
			ordinal: 2,
			id: "assistant-105",
			parentId: null,
			type: "message",
			timestamp: new Date(0).toISOString(),
			payload: Object.freeze({ message }),
		}) as ProjectedEntry;
		// The run retried twice before it was aborted; the message streamed before it committed.
		let live: LiveFoldState = foldLiveItems(emptyLiveFold(1), [
			{
				type: "set",
				key: "phase",
				value: { kind: "phase", busy: true, operation: "turn", retry: { attempt: 2, maxAttempts: 3 } },
			},
			{ type: "assistant_start", message: { ...message, content: [], stopReason: "stop" } },
		]);
		let transcript: ProjectedEntry[] = [];
		const store = {
			transcript: () => transcript,
			get live() {
				return live;
			},
			get phase() {
				const phase = live.values.get("phase");
				return phase?.kind === "phase" ? phase : undefined;
			},
		} as unknown as TuiStore;
		const container = new Container();
		const view = new TranscriptView(store, container, {
			ui: { requestRender: vi.fn() } as unknown as TUI,
			markdownTheme: () => getMarkdownTheme(),
			hideThinkingBlock: () => false,
			toolsExpanded: () => false,
			showImages: () => true,
			imageWidthCells: () => 60,
			toolCallWork: () => [],
			pendingShellRows: new Container(),
			workNoticeShown: () => {},
		});
		view.sync([]);

		// The aborted message commits: the stream ends, and its call never ran.
		transcript = [entry];
		live = { ...live, assistant: undefined };
		expect(() => view.sync([])).not.toThrow();

		const text = container
			.render(100)
			.lines.map((line) => stripAnsi(line))
			.join("\n");
		expect(text).toContain("slow_tool");
		expect(text).toContain("[failure]");
		expect(text).toContain("Aborted after 2 retry attempts");
		expect(message.error?.message).toBe("Request was aborted");
	});
});
