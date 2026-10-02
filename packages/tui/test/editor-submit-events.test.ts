import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/index.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("editor submission change metadata", () => {
	for (const input of ["  command  ", `  ${"large paste ".repeat(100)}  `]) {
		it(`identifies normalized submission before onSubmit (${input.length} input characters)`, () => {
			const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
			editor.handleInput(`\x1b[200~${input}\x1b[201~`);
			const events: unknown[] = [];
			editor.onChange = (text, change) => {
				assert.equal(editor.getText(), "");
				events.push({ text, change });
			};
			editor.onSubmit = (text) => events.push({ submitted: text });
			editor.handleInput("\r");
			assert.deepEqual(events, [{ text: "", change: { submittedText: input.trim() } }, { submitted: input.trim() }]);
		});
	}

	it("does not label ordinary deletion as submission", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal(80, 24)), defaultEditorTheme);
		editor.setText("command");
		const events: unknown[] = [];
		editor.onChange = (text, change) => events.push({ text, change });
		editor.onSubmit = () => assert.fail("Deletion must not submit");
		editor.handleInput("\x15");
		assert.deepEqual(events, [{ text: "", change: undefined }]);
	});
});
