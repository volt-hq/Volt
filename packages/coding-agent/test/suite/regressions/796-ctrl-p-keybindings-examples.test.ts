import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { createTuiHarness, renderedScreen, type TuiHarness, waitForScreen } from "../tui-harness.ts";

type KeybindingsExample = Record<string, string | string[]>;

/** The JSON of the first example under `heading` in the keybindings doc, as a user copies it into keybindings.json. */
function docExample(heading: string): KeybindingsExample {
	const doc = readFileSync(new URL("../../../docs/keybindings.md", import.meta.url), "utf-8");
	const block = new RegExp(`\\n${heading}\\n[\\s\\S]*?\`\`\`json\\n([\\s\\S]*?)\\n\`\`\``).exec(doc);
	if (!block?.[1]) throw new Error(`keybindings.md has no example under ${heading}`);
	return JSON.parse(block[1]) as KeybindingsExample;
}

/** The legacy terminal input for the `ctrl+<letter>` or `alt+<letter>` key the example binds to `action`. */
function letterKeyInput(example: KeybindingsExample, action: string): string {
	const key = [example[action] ?? []].flat().find((candidate) => /^(ctrl|alt)\+[a-z]$/.test(candidate));
	if (!key) throw new Error(`The example binds no ctrl+<letter> or alt+<letter> key to ${action}`);
	const letter = key.slice(-1);
	return key.startsWith("ctrl+") ? String.fromCharCode(letter.charCodeAt(0) - 96) : `\x1b${letter}`;
}

/** Each cursor action an example may bind, and where it moves the cursor from the end of "abc def\nghi jkl". */
const CURSOR_MOVES: Array<[action: string, cursor: { line: number; col: number }]> = [
	["tui.editor.cursorUp", { line: 0, col: 7 }],
	["tui.editor.cursorDown", { line: 1, col: 7 }],
	["tui.editor.cursorLeft", { line: 1, col: 6 }],
	["tui.editor.cursorRight", { line: 1, col: 7 }],
	["tui.editor.cursorWordLeft", { line: 1, col: 4 }],
	["tui.editor.cursorWordRight", { line: 1, col: 7 }],
];

/**
 * The keybindings doc's Custom Configuration and Emacs examples work as
 * written: ctrl+p, which model cycling claims by default, and every other
 * letter key they bind to cursor movement reach the editor, and models cycle
 * on the key the examples move model cycling to.
 */
describe("regression #796: the keybindings doc's ctrl+p examples", () => {
	let harness: TuiHarness | undefined;

	afterEach(async () => {
		await harness?.cleanup();
		harness = undefined;
	});

	it.each(["## Custom Configuration", "### Emacs Example"])(
		"%s moves the editor cursor on every key it binds and cycles models on its own key",
		async (heading) => {
			const example = docExample(heading);
			harness = await createTuiHarness({
				globalSettings: { theme: "dark", quietStartup: true, lsp: { enabled: false }, retry: { enabled: false } },
				models: [
					{ id: "faux-1", reasoning: false },
					{ id: "faux-2", reasoning: false },
				],
			});
			writeFileSync(join(harness.tempDir, "keybindings.json"), `${JSON.stringify(example, null, 2)}\n`, "utf-8");
			const tui = await harness.startMode({ columns: 100, rows: 30 });
			const editor = (tui.mode as unknown as { defaultEditor: CustomEditor }).defaultEditor;

			editor.setText("abc def\nghi jkl");
			expect(editor.getCursor()).toEqual({ line: 1, col: 7 });
			const moves = CURSOR_MOVES.filter(([action]) => action in example);
			expect(moves.map(([action]) => action)).toContain("tui.editor.cursorUp");
			for (const [action, cursor] of moves) {
				tui.terminal.sendInput(letterKeyInput(example, action));
				await vi.waitFor(() => expect(editor.getCursor(), action).toEqual(cursor));
			}
			expect(tui.store.state.model?.modelId).toBe("faux-1");
			expect(await renderedScreen(tui)).not.toContain("Switched to");

			tui.terminal.sendInput(letterKeyInput(example, "app.model.cycleForward"));
			await vi.waitFor(() => expect(tui.store.state.model?.modelId).toBe("faux-2"));
			await waitForScreen(tui, "Switched to faux-2");
		},
	);
});
