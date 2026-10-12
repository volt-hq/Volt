import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Keybinding, KeybindingsManager } from "../../../src/core/keybindings.ts";

type DocumentedDefault = [id: string, keys: string[] | undefined];

/** Backticked keys in a Default cell; `*(none)*` has none. */
function cellKeys(cell: string): string[] {
	return [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}

/** The keys a Default cell lists for this platform, e.g. "`ctrl+v` (`alt+v` on Windows)". */
function platformKeys(cell: string): string[] {
	const windowsNote = /^(.*?)\s*\((.*) on Windows\)$/.exec(cell);
	if (!windowsNote) return cellKeys(cell);
	return cellKeys(process.platform === "win32" ? windowsNote[2]! : windowsNote[1]!);
}

/** Every keybinding id and default the keybindings doc's All Actions tables list, in document order. */
function documentedDefaults(): DocumentedDefault[] {
	const doc = readFileSync(new URL("../../../docs/keybindings.md", import.meta.url), "utf-8");
	const section = /\n## All Actions\n([\s\S]*?)\n## /.exec(doc)?.[1];
	if (!section) throw new Error("keybindings.md has no All Actions section");

	const rows: DocumentedDefault[] = [];
	for (const line of section.split("\n")) {
		if (!/^\| `(app|tui)\./.test(line)) continue;
		const [idCell = "", defaultCell = ""] = line.split(" | ").map((cell) => cell.replace(/^\| /, ""));
		// Paired rows such as "`app.questions.pageUp` / `app.questions.pageDown` | `ctrl+pageUp` / `ctrl+pageDown`".
		const ids = idCell.split(" / ").map((cell) => cellKeys(cell)[0] ?? cell);
		const defaults = ids.length > 1 ? defaultCell.split(" / ") : [defaultCell];
		ids.forEach((id, index) => {
			rows.push([id, platformKeys(defaults[index] ?? "")]);
		});
	}
	return rows;
}

/**
 * The keybindings doc's All Actions tables list each action's actual default
 * keys, so a user reading them knows which keys an action already claims.
 */
describe("regression #797: the keybindings doc's action tables", () => {
	it("list the default keys of every action they document", () => {
		const keybindings = new KeybindingsManager();
		const documented = documentedDefaults();
		expect(documented.length).toBeGreaterThan(0);

		const actual = documented.map(
			([id]): DocumentedDefault => [
				id,
				keybindings.hasDefinition(id) ? keybindings.getKeys(id as Keybinding) : undefined,
			],
		);
		expect(documented).toEqual(actual);
	});
});
