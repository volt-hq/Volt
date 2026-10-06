import type { JsonValue } from "@hansjm10/volt-ai";
import type { ProjectedEntry } from "@hansjm10/volt-protocol";
import { Container } from "@hansjm10/volt-tui";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type CompactionEndEvent = Extract<AgentSessionEvent, { type: "compaction_end" }>;
type CompactionEntry = Extract<ProjectedEntry, { type: "compaction" }>;

function createCompactionContext() {
	initTheme("dark");
	const chatContainer = new Container();
	vi.spyOn(chatContainer, "clear");
	return {
		footer: { invalidate: vi.fn() },
		autoCompactionEscapeHandler: undefined as (() => void) | undefined,
		autoCompactionLoader: undefined,
		defaultEditor: {},
		statusContainer: { clear: vi.fn() },
		chatContainer,
		toolOutputExpanded: false,
		getMarkdownThemeWithSettings: () => undefined,
		showError: vi.fn(),
		showStatus: vi.fn(),
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
	};
}

const handleStatusEvent = Reflect.get(InteractiveMode.prototype, "handleStatusEvent") as (
	this: ReturnType<typeof createCompactionContext>,
	event: CompactionEndEvent,
) => Promise<void>;

const showCompacted = Reflect.get(InteractiveMode.prototype, "showCompacted") as (
	this: ReturnType<typeof createCompactionContext>,
	entry: CompactionEntry,
) => void;

function compactionEntry(details?: JsonValue): CompactionEntry {
	return {
		ordinal: 7,
		id: "compaction-1",
		parentId: "kept",
		type: "compaction",
		timestamp: new Date(0).toISOString(),
		payload: {
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 123,
			...(details === undefined ? {} : { details }),
		},
	};
}

/** The chat's lines below the compaction summary: the request usage lines. */
function usageLines(chat: Container): string[] {
	const lines = chat.render(160).lines.map((line) => stripAnsi(line).trim());
	return lines.slice(lines.findIndex((line) => line.includes("compaction request")));
}

describe("InteractiveMode extension shutdown", () => {
	test("shuts down at once when idle, else once the session settles", () => {
		const session = { isBusy: true };
		const fakeThis = { session, shutdownRequested: false, shutdown: vi.fn(async () => undefined) };
		const onShutdownRequested = Reflect.get(InteractiveMode.prototype, "onShutdownRequested") as (
			this: typeof fakeThis,
		) => void;

		onShutdownRequested.call(fakeThis);
		expect(fakeThis.shutdownRequested).toBe(true);
		expect(fakeThis.shutdown).not.toHaveBeenCalled();
		session.isBusy = false;
		onShutdownRequested.call(fakeThis);
		expect(fakeThis.shutdown).toHaveBeenCalledOnce();
	});
});

describe("InteractiveMode compaction", () => {
	test("leaves the chat to the compaction's entry at compaction_end", async () => {
		const fakeThis = createCompactionContext();

		await handleStatusEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: { firstKeptEntryId: "kept", tokensBefore: 123, summary: "summary" },
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).not.toHaveBeenCalled();
		expect(fakeThis.chatContainer.render(120).lines).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("appends the compaction's summary, then every request it made", () => {
		const fakeThis = createCompactionContext();
		const request = { provider: "test-provider", model: "test-model" };
		showCompacted.call(
			fakeThis,
			compactionEntry({
				requests: [
					{ ...request, strategy: "native", attempt: 1 },
					{
						...request,
						strategy: "native",
						attempt: 2,
						stopReason: "error",
						usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 },
					},
					{
						...request,
						strategy: "chunked",
						attempt: 3,
						stopReason: "stop",
						usage: { input: 100, cacheRead: 800, cacheWrite: 100, output: 100, totalTokens: 1100 },
					},
					{
						...request,
						strategy: "chunked",
						attempt: 4,
						stopReason: "stop",
						usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 100, totalTokens: 200 },
					},
				],
			}),
		);

		const lines = fakeThis.chatContainer.render(160).lines.map((line) => stripAnsi(line).trim());
		expect(lines.join("\n")).toContain("[compaction]");
		expect(usageLines(fakeThis.chatContainer)).toEqual([
			"Native compaction request 1 (no terminal response): cache usage unavailable",
			"Native compaction request 2 (error): cache usage unavailable",
			`Chunked compaction request 3 (stop): 800 cached / ${(1000).toLocaleString()} prompt tokens — 80.0% hit`,
			"Chunked compaction request 4 (stop): 0 cached / 100 prompt tokens — 0.0% hit",
		]);
		expect(fakeThis.footer.invalidate).toHaveBeenCalledOnce();
	});

	test("shows unavailable cache data and ignores malformed records without losing later requests", () => {
		const fakeThis = createCompactionContext();
		const request = { strategy: "native", provider: "test-provider", model: "test-model", stopReason: "stop" };
		showCompacted.call(
			fakeThis,
			compactionEntry({
				requests: [
					null,
					{ strategy: "unsupported", attempt: 1 },
					{ ...request, attempt: 2 },
					{ ...request, attempt: 3, usage: { input: "100", cacheRead: 100, cacheWrite: 0 } },
					{
						...request,
						attempt: 4,
						usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100, totalTokens: 100 },
					},
				],
			}),
		);

		expect(usageLines(fakeThis.chatContainer)).toEqual([
			"Native compaction request 2 (stop): cache usage unavailable",
			"Native compaction request 3 (stop): cache usage unavailable",
			"Native compaction request 4 (stop): cache usage unavailable",
		]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("defers requested shutdown from agent_end until the session settles", async () => {
		const fakeThis = {
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
			loadingAnimation: undefined,
			statusContainer: { clear: vi.fn() },
			stopWorkingElapsedTicker: vi.fn(),
			scheduleTurnDoneAlert: vi.fn(),
			scheduleWorkSummary: vi.fn(),
			updateEditorBorderColor: vi.fn(),
			checkShutdownRequested: vi.fn(async () => undefined),
			session: { planningState: { mode: "build", plan: null } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleStatusEvent") as (
			this: typeof fakeThis,
			event: { type: "agent_end"; messages: []; willRetry: false } | { type: "agent_settled" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "agent_end", messages: [], willRetry: false });
		expect(fakeThis.checkShutdownRequested).not.toHaveBeenCalled();

		await handleEvent.call(fakeThis, { type: "agent_settled" });
		expect(fakeThis.checkShutdownRequested).toHaveBeenCalledOnce();
	});
});
