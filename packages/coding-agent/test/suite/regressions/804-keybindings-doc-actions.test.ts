import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { KEYBINDINGS, type Keybinding, KeybindingsManager } from "../../../src/core/keybindings.ts";

/** Backticked values in a table cell; `*(none)*` has none. */
function cellValues(cell: string): string[] {
	return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

/** The default keys the keybindings doc's All Actions tables list for each keybinding id they document. */
function documentedDefaults(): Map<string, string[]> {
	const doc = readFileSync(new URL("../../../docs/keybindings.md", import.meta.url), "utf-8");
	const section = /\n## All Actions\n([\s\S]*?)\n## /.exec(doc)?.[1];
	if (!section) throw new Error("keybindings.md has no All Actions section");

	const documented = new Map<string, string[]>();
	for (const line of section.split("\n")) {
		if (!/^\| `(app|tui)\./.test(line)) continue;
		const [idCell = "", defaultCell = ""] = line.split(" | ").map((cell) => cell.replace(/^\| /, ""));
		// Paired rows such as "`app.questions.pageUp` / `app.questions.pageDown` | `ctrl+pageUp` / `ctrl+pageDown`".
		const ids = idCell.split(" / ");
		const defaults = ids.length > 1 ? defaultCell.split(" / ") : [defaultCell];
		ids.forEach((id, index) => {
			documented.set(cellValues(id)[0] ?? id, cellValues(defaults[index] ?? ""));
		});
	}
	return documented;
}

/**
 * The keybindings doc's All Actions tables list every configurable action, so
 * a user can find each id to rebind it and see which keys it claims.
 */
describe("regression #804: the keybindings doc's action tables", () => {
	it("list every configurable action", () => {
		const documented = documentedDefaults();
		const undocumented = Object.keys(KEYBINDINGS).filter((id) => !documented.has(id));
		expect(undocumented).toEqual([]);
	});

	it("list the default keys of the actions they omitted", () => {
		const keybindings = new KeybindingsManager();
		const documented = documentedDefaults();
		const ids: Keybinding[] = [
			"tui.editor.historyPrevious",
			"tui.editor.historyNext",
			"tui.select.left",
			"tui.select.right",
			"tui.select.toggle",
			"tui.focus.next",
			"tui.focus.previous",
			"app.reviewTools.toggle",
		];
		expect(ids.map((id) => [id, documented.get(id)])).toEqual(ids.map((id) => [id, keybindings.getKeys(id)]));
	});
});
