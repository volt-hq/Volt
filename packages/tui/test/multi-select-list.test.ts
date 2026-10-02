import assert from "node:assert";
import { describe, it } from "node:test";
import { MultiSelectList } from "../src/components/multi-select-list.ts";
import { PLAIN_SEMANTIC_THEME } from "../src/styled-text.ts";
import { visibleWidth } from "../src/utils.ts";
import { KEYS, showTags, tagTheme } from "./semantic-test-theme.ts";

const items = [
	{ value: "lint", label: "Lint", description: "Run biome over the workspace" },
	{ value: "types", label: "Typecheck", description: "Run tsc --noEmit" },
	{ value: "e2e", label: "End-to-end", disabled: true },
	{ value: "unit", label: "Unit tests" },
];

describe("MultiSelectList", () => {
	it("renders checkboxes and descriptions within the width", () => {
		const list = new MultiSelectList(PLAIN_SEMANTIC_THEME, { items, selected: ["types"] });
		assert.deepStrictEqual(list.render(60).lines, [
			"› [ ] Lint        Run biome over the workspace",
			"  [x] Typecheck   Run tsc --noEmit",
			"  [ ] End-to-end",
			"  [ ] Unit tests",
		]);
		const narrow = list.render(20).lines;
		assert.deepStrictEqual(narrow[0], "› [ ] Lint");
		for (const line of narrow) assert.ok(visibleWidth(line) <= 20, line);
	});

	it("toggles items, skips disabled ones, and submits checked values in item order", () => {
		const list = new MultiSelectList(PLAIN_SEMANTIC_THEME, { items });
		const changes: string[][] = [];
		const submitted: string[][] = [];
		let cancelled = 0;
		list.onChange = (values) => changes.push(values);
		list.onSubmit = (values) => submitted.push(values);
		list.onCancel = () => cancelled++;

		list.handleInput(KEYS.up);
		list.handleInput(KEYS.space);
		list.handleInput(KEYS.up);
		list.handleInput(KEYS.space);
		list.handleInput(KEYS.down);
		list.handleInput(KEYS.down);
		list.handleInput(KEYS.space);
		list.handleInput(KEYS.enter);
		list.handleInput(KEYS.escape);

		assert.deepStrictEqual(changes, [["unit"], ["lint", "unit"]]);
		assert.deepStrictEqual(submitted, [["lint", "unit"]]);
		assert.strictEqual(cancelled, 1);
	});

	it("scrolls long lists and reports the position", () => {
		const many = Array.from({ length: 10 }, (_, index) => ({ value: `v${index}`, label: `Item ${index}` }));
		const list = new MultiSelectList(tagTheme, { items: many, maxVisible: 3 });
		list.handleInput(KEYS.pageDown);
		const lines = list.render(30).lines.map(showTags);
		assert.strictEqual(lines.length, 4);
		assert.ok(lines[1]!.startsWith("<accent>› </accent><accent>[ ] </accent><accent>Item 2</accent>"), lines[1]);
		assert.strictEqual(lines[3], "<muted>  (3/10)</muted>");
	});

	it("keeps user checks and the cursor across updates unless the selected prop changes", () => {
		const selected = ["lint"];
		const list = new MultiSelectList(PLAIN_SEMANTIC_THEME, { items, selected });
		list.handleInput(KEYS.down);
		list.handleInput(KEYS.space);
		list.setProps({ items: [{ value: "new", label: "New" }, ...items], selected });
		assert.deepStrictEqual(list.getSelectedValues(), ["lint", "types"]);
		assert.ok(list.render(40).lines[2]!.startsWith("› [x] Typecheck"));

		list.setProps({ items, selected: ["unit"] });
		assert.deepStrictEqual(list.getSelectedValues(), ["unit"]);
	});
});
