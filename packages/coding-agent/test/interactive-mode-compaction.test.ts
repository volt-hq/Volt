import type { JsonValue } from "@hansjm10/volt-ai";
import type { ProjectedEntry } from "@hansjm10/volt-protocol";
import { Container } from "@hansjm10/volt-tui";
import { describe, expect, test, vi } from "vitest";
import { initTheme } from "../src/core/theme/runtime.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type CompactionEntry = Extract<ProjectedEntry, { type: "compaction" }>;

function createCompactionContext() {
	initTheme("dark");
	const chatContainer = new Container();
	vi.spyOn(chatContainer, "clear");
	return {
		chatContainer,
		toolOutputExpanded: false,
		getMarkdownThemeWithSettings: () => undefined,
		showError: vi.fn(),
		showStatus: vi.fn(),
		settingsManager: { getShowTerminalProgress: () => false },
		ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
	};
}

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
	const lines = chat.render(240).lines.map((line) => stripAnsi(line).trim());
	const start = lines.findIndex((line) => /^(Native|Chunked) compaction/.test(line));
	return start < 0 ? [] : lines.slice(start);
}

function setExpanded(chat: Container, expanded: boolean): void {
	for (const child of chat.children) {
		if ("setExpanded" in child && typeof child.setExpanded === "function") child.setExpanded(expanded);
	}
}

describe("InteractiveMode extension shutdown", () => {
	test("shuts down at once when idle, else once the conversation settles", () => {
		// The store's run phase: busy while an operation holds the conversation.
		const phase = { busy: true };
		const fakeThis = { store: { phase }, shutdownRequested: false, shutdown: vi.fn(async () => undefined) };
		const onShutdownRequested = Reflect.get(InteractiveMode.prototype, "onShutdownRequested") as (
			this: typeof fakeThis,
		) => void;

		onShutdownRequested.call(fakeThis);
		expect(fakeThis.shutdownRequested).toBe(true);
		expect(fakeThis.shutdown).not.toHaveBeenCalled();
		phase.busy = false;
		onShutdownRequested.call(fakeThis);
		expect(fakeThis.shutdown).toHaveBeenCalledOnce();
	});
});

describe("InteractiveMode compaction", () => {
	test("appends the compaction's summary and usage line, listing every request when expanded", () => {
		const fakeThis = createCompactionContext();
		const request = { provider: "test-provider", model: "test-model" };
		showCompacted.call(
			fakeThis,
			compactionEntry({
				strategyReason: "provider_overflow",
				requests: [
					{ ...request, strategy: "native", purpose: "native", attempt: 1 },
					{
						...request,
						strategy: "native",
						purpose: "native",
						attempt: 2,
						stopReason: "error",
						usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, totalTokens: 0 },
					},
					{
						...request,
						strategy: "chunked",
						purpose: "history",
						attempt: 3,
						stopReason: "stop",
						textChars: 4000,
						usage: { input: 100, cacheRead: 800, cacheWrite: 100, output: 100, totalTokens: 1100 },
					},
					{
						...request,
						strategy: "chunked",
						purpose: "history",
						attempt: 4,
						stopReason: "stop",
						textChars: 3000,
						usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 100, totalTokens: 200 },
					},
				],
			}),
		);

		const lines = fakeThis.chatContainer.render(160).lines.map((line) => stripAnsi(line).trim());
		expect(lines.join("\n")).toContain("[compaction]");
		const summary = `Chunked compaction (provider rejected one request as too large) · 4 requests (2 failed) · ${(1100).toLocaleString()} prompt tokens, 72.7% cached, 2 requests without usage · checkpoint 7 chars`;
		expect(usageLines(fakeThis.chatContainer)).toEqual([summary]);

		setExpanded(fakeThis.chatContainer, true);
		expect(usageLines(fakeThis.chatContainer)).toEqual([
			summary,
			"1. native · no response · usage unavailable",
			"2. native retry · error · usage unavailable",
			`3. history · ${(4000).toLocaleString()} chars · ${(1000).toLocaleString()} prompt tokens`,
			`4. history · ${(3000).toLocaleString()} chars · 100 prompt tokens`,
		]);
		setExpanded(fakeThis.chatContainer, false);
		expect(usageLines(fakeThis.chatContainer)).toEqual([summary]);
	});

	test("starts expanded when tool output is expanded", () => {
		const fakeThis = { ...createCompactionContext(), toolOutputExpanded: true };
		const request = { strategy: "native", attempt: 1, provider: "test-provider", model: "test-model" };
		showCompacted.call(fakeThis, compactionEntry({ requests: [{ ...request, stopReason: "stop" }] }));
		expect(usageLines(fakeThis.chatContainer)).toEqual([
			"Native compaction · 1 request · usage unavailable · checkpoint 7 chars",
			"1. native · completed · usage unavailable",
		]);
	});

	test("shows nothing for a compaction without request records", () => {
		const fakeThis = createCompactionContext();
		showCompacted.call(fakeThis, compactionEntry({ readFiles: [], modifiedFiles: [] }));
		expect(usageLines(fakeThis.chatContainer)).toEqual([]);
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

		setExpanded(fakeThis.chatContainer, true);
		expect(usageLines(fakeThis.chatContainer)).toEqual([
			"Native compaction · 3 requests · usage unavailable · checkpoint 7 chars",
			"2. native · completed · usage unavailable",
			"3. native · completed · usage unavailable",
			"4. native · completed · usage unavailable",
		]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
