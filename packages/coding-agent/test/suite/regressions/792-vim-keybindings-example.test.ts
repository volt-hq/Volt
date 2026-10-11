import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { createTuiHarness, renderedScreen, type TuiHarness, waitForScreen } from "../tui-harness.ts";

type KeybindingsExample = Record<string, string | string[]>;

/** The JSON of the keybindings doc's Vim Example, as a user copies it into keybindings.json. */
function vimExample(): KeybindingsExample {
	const doc = readFileSync(new URL("../../../docs/keybindings.md", import.meta.url), "utf-8");
	const block = /### Vim Example\n\n```json\n([\s\S]*?)\n```/.exec(doc);
	if (!block?.[1]) throw new Error("keybindings.md has no Vim Example");
	return JSON.parse(block[1]) as KeybindingsExample;
}

/** The legacy terminal input for the `alt+<letter>` key the example binds to `action`. */
function altLetterInput(example: KeybindingsExample, action: string): string {
	const key = [example[action] ?? []].flat().find((candidate) => /^alt\+[a-z]$/.test(candidate));
	if (!key) throw new Error(`The Vim Example binds no alt+<letter> key to ${action}`);
	return `\x1b${key.slice("alt+".length)}`;
}

/**
 * The keybindings doc's Vim Example works as written: each alt+<letter> key it
 * binds to cursor movement reaches the editor, including alt+j, which the work
 * inspector claims by default, and the work inspector opens on the key the
 * example moves it to.
 */
describe("regression #792: the keybindings doc's Vim Example", () => {
	let harness: TuiHarness | undefined;

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	it("moves the editor cursor on every key it binds and opens the work inspector on its own key", async () => {
		const example = vimExample();
		harness = await createTuiHarness({
			globalSettings: { theme: "dark", quietStartup: true, lsp: { enabled: false }, retry: { enabled: false } },
		});
		writeFileSync(join(harness.tempDir, "keybindings.json"), `${JSON.stringify(example, null, 2)}\n`, "utf-8");
		const tui = await harness.startMode({ columns: 100, rows: 30 });
		const editor = (tui.mode as unknown as { defaultEditor: CustomEditor }).defaultEditor;

		editor.setText("abc def\nghi jkl");
		expect(editor.getCursor()).toEqual({ line: 1, col: 7 });
		const moves: Array<[action: string, cursor: { line: number; col: number }]> = [
			["tui.editor.cursorUp", { line: 0, col: 7 }],
			["tui.editor.cursorDown", { line: 1, col: 7 }],
			["tui.editor.cursorLeft", { line: 1, col: 6 }],
			["tui.editor.cursorRight", { line: 1, col: 7 }],
			["tui.editor.cursorWordLeft", { line: 1, col: 4 }],
			["tui.editor.cursorWordRight", { line: 1, col: 7 }],
		];
		for (const [action, cursor] of moves) {
			tui.terminal.sendInput(altLetterInput(example, action));
			await vi.waitFor(() => expect(editor.getCursor(), action).toEqual(cursor));
			expect(await renderedScreen(tui), action).not.toContain("─ Work ");
		}

		tui.terminal.sendInput(altLetterInput(example, "app.work.open"));
		await waitForScreen(tui, "─ Work ");
	});
});
