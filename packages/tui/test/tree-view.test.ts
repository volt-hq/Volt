import assert from "node:assert";
import { describe, it } from "node:test";
import { TreeView } from "../src/components/tree-view.ts";
import { PLAIN_SEMANTIC_THEME } from "../src/styled-text.ts";
import { visibleWidth } from "../src/utils.ts";
import { KEYS } from "./semantic-test-theme.ts";

const items = [
	{
		id: "src",
		label: "src",
		description: "sources",
		children: [
			{ id: "src/index.ts", label: "index.ts" },
			{ id: "src/components", label: "components", children: [{ id: "src/components/card.ts", label: "card.ts" }] },
		],
	},
	{ id: "README.md", label: "README.md" },
];

describe("TreeView", () => {
	it("renders expanded items with indentation and markers within the width", () => {
		const tree = new TreeView(PLAIN_SEMANTIC_THEME, { items, expanded: ["src"] });
		assert.deepStrictEqual(tree.render(40).lines, [
			"› ▾ src  sources",
			"      index.ts",
			"    ▸ components",
			"    README.md",
		]);
		const narrow = tree.render(10).lines;
		for (const line of narrow) assert.ok(visibleWidth(line) <= 10, line);
		assert.strictEqual(narrow[0], "› ▾ src");
	});

	it("expands, enters, collapses, and selects with the keyboard", () => {
		const tree = new TreeView(PLAIN_SEMANTIC_THEME, { items });
		const toggles: string[] = [];
		const selected: string[] = [];
		tree.onToggle = (id, expanded) => toggles.push(`${id}:${expanded}`);
		tree.onSelect = (id) => selected.push(id);

		tree.handleInput(KEYS.right);
		tree.handleInput(KEYS.right);
		assert.strictEqual(tree.getSelectedId(), "src/index.ts");
		tree.handleInput(KEYS.down);
		tree.handleInput(KEYS.space);
		tree.handleInput(KEYS.down);
		assert.strictEqual(tree.getSelectedId(), "src/components/card.ts");
		tree.handleInput(KEYS.left);
		assert.strictEqual(tree.getSelectedId(), "src/components");
		tree.handleInput(KEYS.left);
		tree.handleInput(KEYS.left);
		tree.handleInput(KEYS.enter);
		tree.handleInput(KEYS.left);
		tree.handleInput(KEYS.up);

		assert.deepStrictEqual(toggles, ["src:true", "src/components:true", "src/components:false", "src:false"]);
		assert.deepStrictEqual(selected, ["src"]);
		assert.strictEqual(tree.getSelectedId(), "README.md");
	});

	it("applies expanded and selected prop changes and keeps user state otherwise", () => {
		const expanded = ["src"];
		const tree = new TreeView(PLAIN_SEMANTIC_THEME, { items, expanded });
		tree.handleInput(KEYS.down);
		tree.setProps({ items, expanded });
		assert.strictEqual(tree.getSelectedId(), "src/index.ts");

		tree.setProps({ items, expanded: [], selectedId: "README.md" });
		assert.strictEqual(tree.isExpanded("src"), false);
		assert.strictEqual(tree.getSelectedId(), "README.md");

		tree.setProps({ items: [{ id: "only", label: "only" }], expanded: [] });
		assert.strictEqual(tree.getSelectedId(), "only");
	});
});
