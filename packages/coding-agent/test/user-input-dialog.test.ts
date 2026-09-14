import { CURSOR_MARKER, getKeybindings, setKeybindings, type TUI, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type KeybindingsConfig, KeybindingsManager } from "../src/core/keybindings.ts";
import { initTheme, theme } from "../src/core/theme/runtime.ts";
import type { UserInputRequest, UserInputResponse } from "../src/core/user-input.ts";
import { UserInputDialog } from "../src/modes/interactive/components/user-input-dialog.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const previousBindings = getKeybindings();
beforeEach(() => initTheme("dark"));
afterEach(() => setKeybindings(previousBindings));

const request: UserInputRequest = {
	questions: [
		{
			id: "storage",
			header: "Storage",
			question: "Where should the search index live?",
			options: [
				{ label: "SQLite (Recommended)", description: "Fast offline search; adds a local file." },
				{ label: "Memory", description: "No files; rebuilds on startup." },
				{ label: "Hosted", description: "Shared across devices; requires credentials." },
			],
		},
		{
			id: "scope",
			header: "Scope",
			question: "Which files should be searchable?",
			options: [
				{ label: "Project", description: "Focused results; respects ignore rules." },
				{ label: "Workspace", description: "Broad results; slower indexing." },
			],
		},
	],
};

function setup(
	options: { multi?: boolean; bindings?: KeybindingsConfig; rows?: number; input?: UserInputRequest } = {},
) {
	const keybindings = new KeybindingsManager(options.bindings);
	setKeybindings(keybindings);
	const done = vi.fn<(response: UserInputResponse) => void>();
	const requestRender = vi.fn();
	const terminal = { rows: options.rows ?? 36 };
	const tui = { terminal, requestRender } as unknown as TUI;
	const dialog = new UserInputDialog(
		tui,
		theme,
		keybindings,
		options.input ?? { questions: options.multi ? request.questions : request.questions.slice(0, 1) },
		done,
	);
	dialog.focused = true;
	const input = (...keys: string[]) => {
		for (const key of keys) dialog.handleInput(key);
	};
	const text = (width = 80) => {
		const frame = dialog.render(width);
		for (const line of frame.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		return frame.lines.map(stripAnsi).join("\n");
	};
	return { dialog, done, input, text, terminal, requestRender };
}

const down = "\x1b[B";
const up = "\x1b[A";
const back = "\x1b[Z";
const enter = "\r";
const skip = "\x13";
const notes = "\x0e";

describe("UserInputDialog", () => {
	it("shows question progress, tradeoffs, custom answer, and an uncommitted highlight", () => {
		const { text, done, input, requestRender } = setup();
		expect(text()).toContain("Storage · 1 of 1");
		expect(text()).toContain("› SQLite (Recommended)");
		expect(text()).toContain("Fast offline search; adds a local file.");
		expect(text()).toContain("Write your own answer");
		expect(done).not.toHaveBeenCalled();
		input(down, enter);
		expect(done).toHaveBeenCalledExactlyOnceWith({
			status: "answered",
			answers: { storage: { answers: ["Memory"] } },
		});
		expect(requestRender).toHaveBeenCalled();
	});

	it("typing starts a custom answer without losing the first character", () => {
		const { text, input, done } = setup();
		input("使", "用既存のデータ");
		expect(text()).toContain("使用既存のデータ");
		input(enter);
		expect(done).toHaveBeenCalledWith({
			status: "answered",
			answers: { storage: { answers: ["使用既存のデータ"] } },
		});
	});

	it("accepts Kitty printable input as the first custom character", () => {
		const { input, done } = setup();
		input("\x1b[120u", "yz", enter);
		expect(done).toHaveBeenCalledWith({ status: "answered", answers: { storage: { answers: ["xyz"] } } });
	});

	it("preserves the first custom character from xterm modifyOtherKeys input", () => {
		const { input, done } = setup();
		input("\x1b[27;2;69~", "xample", enter);
		expect(done).toHaveBeenCalledExactlyOnceWith({
			status: "answered",
			answers: { storage: { answers: ["Example"] } },
		});
	});

	it.each(["\x1b[27;5;101~", "\x1b[27;3;101~"])("does not start a custom answer for modified shortcut %j", (key) => {
		const { input, done } = setup();
		input(key, enter);
		expect(done).toHaveBeenCalledExactlyOnceWith({
			status: "answered",
			answers: { storage: { answers: ["SQLite (Recommended)"] } },
		});
	});

	it("preserves bracketed multiline paste, including expanded large pastes", () => {
		const { input, done } = setup();
		const pasted = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
		input("\x1b[200~", pasted, "\x1b[201~", enter);
		expect(done).toHaveBeenCalledWith({ status: "answered", answers: { storage: { answers: [pasted] } } });
	});

	it("does not interpret fragmented paste payloads as submit or skip actions", () => {
		const { input, done } = setup();
		input("\x1b[200~", "first", enter, "second", skip, "\x1b[201~");
		expect(done).not.toHaveBeenCalled();
		input(enter);
		expect(done).toHaveBeenCalledWith(expect.objectContaining({ status: "answered" }));
		expect(done.mock.calls[0][0].answers.storage.answers[0]).toContain("first\nsecond");
	});

	it("ignores fragmented paste actions on the review screen", () => {
		const { input, text, done } = setup({ multi: true });
		input(enter, enter);
		expect(text()).toContain("Review answers");
		input("\x1b[200~", enter, skip, "\x1b", "\x1b[201~");
		expect(done).not.toHaveBeenCalled();
		input(enter);
		expect(done).toHaveBeenCalledWith(expect.objectContaining({ status: "answered" }));
	});

	it("supports normal multiline editing and keeps blank custom answers pending", () => {
		const { input, done, text } = setup({ bindings: { "tui.input.newLine": "ctrl+j" } });
		input(down, down, down, enter, enter);
		expect(done).not.toHaveBeenCalled();
		expect(text()).toContain("Write an answer, choose an option, or skip.");
		input("first", "\n", "second", enter);
		expect(done).toHaveBeenCalledWith({ status: "answered", answers: { storage: { answers: ["first\nsecond"] } } });
	});

	describe.each(["custom", "notes"] as const)("backslash newline in %s answers", (mode) => {
		it.each([
			{ key: enter, bindings: {} },
			{ key: "\x1b[13u", bindings: {} },
			{ key: "\x14", bindings: { "tui.input.submit": "ctrl+t" } },
		] satisfies { key: string; bindings: KeybindingsConfig }[])(
			"keeps editing after backslash + $key and submits the completed answer",
			({ key, bindings }) => {
				const { input, done } = setup({ bindings });
				if (mode === "notes") input(notes);
				input("first", "\\", key);
				expect(done).not.toHaveBeenCalled();
				input("second", key);
				expect(done).toHaveBeenCalledExactlyOnceWith({
					status: "answered",
					answers: {
						storage: {
							answers: mode === "notes" ? ["SQLite (Recommended)", "first\nsecond"] : ["first\nsecond"],
						},
					},
				});
			},
		);

		it("removes only the backslash before a mid-line cursor", () => {
			const { input, done } = setup();
			if (mode === "notes") input(notes);
			input("first\\\\tail", "\x1b[D", "\x1b[D", "\x1b[D", "\x1b[D", enter);
			expect(done).not.toHaveBeenCalled();
			input("second ", enter);
			expect(done).toHaveBeenCalledExactlyOnceWith({
				status: "answered",
				answers: {
					storage: {
						answers:
							mode === "notes" ? ["SQLite (Recommended)", "first\\\nsecond tail"] : ["first\\\nsecond tail"],
					},
				},
			});
		});

		it("commits normally when the backslash is not before the cursor", () => {
			const { input, done } = setup();
			if (mode === "notes") input(notes);
			input("first\\tail", enter);
			expect(done).toHaveBeenCalledExactlyOnceWith({
				status: "answered",
				answers: {
					storage: { answers: mode === "notes" ? ["SQLite (Recommended)", "first\\tail"] : ["first\\tail"] },
				},
			});
		});

		it("leaves the backslash literal for an explicit newline binding", () => {
			const { input, done } = setup();
			if (mode === "notes") input(notes);
			input("first\\", "\n");
			expect(done).not.toHaveBeenCalled();
			input("second", enter);
			expect(done).toHaveBeenCalledExactlyOnceWith({
				status: "answered",
				answers: {
					storage: {
						answers: mode === "notes" ? ["SQLite (Recommended)", "first\\\nsecond"] : ["first\\\nsecond"],
					},
				},
			});
		});
	});

	it("keeps the current question and preserves paste expansions and cursor when revisiting a multiline draft", () => {
		const { input, done, text } = setup({ multi: true });
		const pasted = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
		input("\x1b[200~", pasted, "\x1b[201~", "\\", enter);
		expect(text()).toContain("Storage · 1 of 2");
		expect(done).not.toHaveBeenCalled();
		input("second", back, enter, " revised", enter);
		expect(text()).toContain("Scope · 2 of 2");
		input(back, enter, " again", enter, enter);
		expect(text()).toContain("Review answers");
		expect(done).not.toHaveBeenCalled();
		input(enter);
		expect(done).toHaveBeenCalledExactlyOnceWith({
			status: "answered",
			answers: { storage: { answers: [`${pasted}\nsecond revised again`] }, scope: { answers: ["Project"] } },
		});
	});

	it("preserves custom drafts when returning to choices or previous questions", () => {
		const { input, text, done } = setup({ multi: true });
		input("custom draft", back);
		expect(text()).toContain("Draft saved");
		input(up, up, up, enter, back, down, down, down, enter);
		expect(text()).toContain("custom draft");
		input(" revised", enter, enter);
		expect(done).not.toHaveBeenCalled();
		expect(text()).toContain("Review answers");
		expect(text()).toContain("custom draft revised");
		input(enter);
		expect(done).toHaveBeenCalledWith({
			status: "answered",
			answers: { storage: { answers: ["custom draft revised"] }, scope: { answers: ["Project"] } },
		});
	});

	it("requires review for multiple questions and allows editing a reviewed answer", () => {
		const { input, text, done } = setup({ multi: true });
		input(enter, down, enter);
		expect(text()).toContain("Review answers");
		expect(text()).toContain("Workspace");
		expect(done).not.toHaveBeenCalled();
		input(up, up, enter, down, enter);
		expect(text()).toContain("Review answers");
		expect(text()).toContain("Memory");
		input(enter);
		expect(done).toHaveBeenCalledWith({
			status: "answered",
			answers: { storage: { answers: ["Memory"] }, scope: { answers: ["Workspace"] } },
		});
	});

	it("retains notes per option without attaching them to another choice", () => {
		const { input, text, done } = setup();
		input(notes, "Use the cache directory", back, down, notes);
		expect(text()).not.toContain("Use the cache directory");
		input(back, up, notes);
		expect(text()).toContain("Use the cache directory");
		input(enter);
		expect(done).toHaveBeenCalledWith({
			status: "answered",
			answers: { storage: { answers: ["SQLite (Recommended)", "Use the cache directory"] } },
		});
	});

	it.each([
		[skip, "skipped"],
		["\x1b", "cancelled"],
		["\x03", "cancelled"],
	])("%j returns %s with no assumed or partial answers", (key, status) => {
		const { input, done } = setup({ multi: true });
		input(enter, "unfinished", key, enter, skip);
		expect(done).toHaveBeenCalledExactlyOnceWith({ status, answers: {} });
	});

	it("honors custom navigation, confirm, back, notes, skip, cancel, and input actions", () => {
		const { input, text, done } = setup({
			bindings: {
				"tui.select.down": "ctrl+d",
				"tui.select.up": "ctrl+u",
				"tui.select.confirm": "ctrl+f",
				"app.questions.back": "ctrl+b",
				"app.questions.notes": "ctrl+o",
				"app.questions.skip": "ctrl+k",
				"tui.select.cancel": "ctrl+x",
				"tui.input.submit": "ctrl+t",
			},
		});
		input(down);
		expect(text()).toContain("› SQLite");
		input("\x04", "\x15", "\x0f", "note", "\x02");
		expect(text()).toContain("notes saved");
		expect(text()).toContain("ctrl+k skip all");
		input("\x04", "\x06");
		expect(done).toHaveBeenCalledWith({ status: "answered", answers: { storage: { answers: ["Memory"] } } });
		const custom = setup({ bindings: { "tui.input.submit": "ctrl+t" } });
		custom.input("draft", enter);
		expect(custom.done).not.toHaveBeenCalled();
		custom.input("\x14");
		expect(custom.done).toHaveBeenCalled();
		const skipped = setup({ bindings: { "app.questions.skip": "ctrl+k" } });
		skipped.input(skip);
		expect(skipped.done).not.toHaveBeenCalled();
		skipped.input("\x0b");
		expect(skipped.done).toHaveBeenCalledWith({ status: "skipped", answers: {} });
		const cancelled = setup({ bindings: { "tui.select.cancel": "ctrl+x" } });
		cancelled.input("\x1b");
		expect(cancelled.done).not.toHaveBeenCalled();
		cancelled.input("\x18");
		expect(cancelled.done).toHaveBeenCalledWith({ status: "cancelled", answers: {} });
	});

	it.each([
		[80, 24],
		[120, 36],
		[160, 45],
		[30, 24],
		[1, 24],
	])("fits %ix%i with ANSI and wide Unicode glyphs", (width, rows) => {
		const long = structuredClone(request);
		long.questions[0].question = "資料 👩🏽‍💻 ".repeat(35);
		long.questions[0].options[0].description = "\x1b[31mTradeoffs 界\x1b[0m ".repeat(25);
		const { text, dialog, input } = setup({ rows, input: long });
		text(width);
		if (width >= 30) expect(dialog.render(width).lines.length).toBeLessThanOrEqual(rows - 6);
		input(down, down, down, enter, "回答 🧑‍💻");
		text(width);
		if (width >= 30) expect(dialog.render(width).lines.length).toBeLessThanOrEqual(rows - 6);
	});

	it("lets readers scroll long question text without committing a selection", () => {
		const long = structuredClone(request);
		long.questions[0].question = Array.from({ length: 20 }, (_, i) => `Question line ${i}`).join("\n");
		const { text, input, done } = setup({ rows: 24, input: long });
		text();
		input("\x1b[5~", "\x1b[5~", "\x1b[5~");
		expect(text()).toContain("Question line 0");
		expect(done).not.toHaveBeenCalled();
	});

	it("propagates focus to the active editor and preserves the IME cursor after resizing", () => {
		const { input, dialog } = setup({ rows: 24 });
		expect(dialog.render(80).lines.join("\n")).not.toContain(CURSOR_MARKER);
		input("日本語");
		expect(dialog.render(80).lines.join("\n")).toContain(CURSOR_MARKER);
		dialog.focused = false;
		expect(dialog.render(80).lines.join("\n")).not.toContain(CURSOR_MARKER);
		dialog.focused = true;
		expect(dialog.render(40).lines.join("\n")).toContain(CURSOR_MARKER);
		input(back);
		expect(dialog.render(80).lines.join("\n")).not.toContain(CURSOR_MARKER);
	});
});
