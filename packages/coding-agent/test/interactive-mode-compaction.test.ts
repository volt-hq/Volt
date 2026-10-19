import type { JsonValue } from "@hansjm10/volt-ai";
import type { ProjectedEntry } from "@hansjm10/volt-protocol";
import { Container, getKeybindings, setKeybindings } from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
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

function compactionEntry(details?: JsonValue, fromHook?: boolean): CompactionEntry {
	return {
		ordinal: 7,
		id: "compaction-1",
		parentId: "kept",
		type: "compaction",
		timestamp: new Date(0).toISOString(),
		payload: {
			summary: "summary text",
			firstKeptEntryId: "kept",
			tokensBefore: 265_707,
			...(details === undefined ? {} : { details }),
			...(fromHook === undefined ? {} : { fromHook }),
		},
	};
}

/** The compaction box's text lines, without its label and padding. */
function compactionLines(chat: Container): string[] {
	return chat
		.render(200)
		.lines.map((line) => stripAnsi(line).trim())
		.filter((line) => line.length > 0 && line !== "[compaction]");
}

/** Details of the incident compaction: eight requests over 5m 15s, two of them discarded as oversized. */
const chunkedDetails = {
	readFiles: [],
	modifiedFiles: [],
	tokensAfter: 41_230,
	strategyReason: "preflight_overflow",
	requests: [42_587, 50_843, 30_925, 42_697, 47_256, 35_595, 46_762, 18_829].map((durationMs, index, all) => ({
		strategy: "chunked",
		attempt: index + 1,
		startedAt: 1_000 + all.slice(0, index).reduce((sum, value) => sum + value, 0),
		durationMs,
		...(index === 1 || index === 4 ? { rejected: "oversized" } : { stopReason: "stop" }),
	})),
};

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
	const previousKeybindings = getKeybindings();
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});
	afterEach(() => {
		setKeybindings(previousKeybindings);
	});

	const headline = `Compacted from ${(265_707).toLocaleString()} to ~${(41_230).toLocaleString()} tokens in 5m 15s`;
	const note = "The conversation was too long to summarize at once, so it was summarized in 6 parts.";

	test("says how much smaller the context got, how long it took, and why it took the longer route", () => {
		const fakeThis = createCompactionContext();
		showCompacted.call(fakeThis, compactionEntry(chunkedDetails));
		expect(compactionLines(fakeThis.chatContainer)).toEqual([`${headline} (ctrl+o to expand)`, note]);
	});

	test("puts the same outcome above the expanded summary", () => {
		const fakeThis = { ...createCompactionContext(), toolOutputExpanded: true };
		showCompacted.call(fakeThis, compactionEntry(chunkedDetails));
		expect(compactionLines(fakeThis.chatContainer)).toEqual([headline, note, "summary text"]);
	});

	test("shows only the size before for compactions without built-in details", () => {
		for (const entry of [
			compactionEntry(),
			compactionEntry({ custom: true }),
			compactionEntry(chunkedDetails, true),
		]) {
			const fakeThis = createCompactionContext();
			showCompacted.call(fakeThis, entry);
			expect(compactionLines(fakeThis.chatContainer)).toEqual([
				`Compacted from ${(265_707).toLocaleString()} tokens (ctrl+o to expand)`,
			]);
			expect(fakeThis.showError).not.toHaveBeenCalled();
		}
	});
});
