import assert from "node:assert";
import { describe, it } from "node:test";
import { ActionBar } from "../src/components/action-bar.ts";
import { PLAIN_SEMANTIC_THEME } from "../src/styled-text.ts";
import { visibleWidth } from "../src/utils.ts";
import { KEYS, showTags, tagTheme } from "./semantic-test-theme.ts";

const actions = [
	{ id: "approve", label: "Approve", token: "success" as const },
	{ id: "skip", label: "Skip", disabled: true },
	{ id: "reject", label: "Reject", token: "error" as const },
];

describe("ActionBar", () => {
	it("lays actions out on one line and wraps them at narrow widths", () => {
		const bar = new ActionBar(PLAIN_SEMANTIC_THEME, { actions });
		assert.deepStrictEqual(bar.render(40).lines, ["[ Approve ] [ Skip ] [ Reject ]"]);

		const narrow = bar.render(12).lines;
		assert.deepStrictEqual(narrow, ["[ Approve ]", "[ Skip ]", "[ Reject ]"]);
		const tiny = bar.render(6).lines;
		for (const line of [...narrow, ...tiny]) assert.ok(visibleWidth(line) <= 12);
		for (const line of tiny) assert.ok(visibleWidth(line) <= 6, line);
	});

	it("moves over enabled actions and activates the selection", () => {
		const bar = new ActionBar(PLAIN_SEMANTIC_THEME, { actions });
		const activated: string[] = [];
		let cancelled = 0;
		bar.onAction = (id) => activated.push(id);
		bar.onCancel = () => cancelled++;

		assert.strictEqual(bar.getSelectedId(), "approve");
		bar.handleInput(KEYS.right);
		assert.strictEqual(bar.getSelectedId(), "reject");
		bar.handleInput(KEYS.right);
		assert.strictEqual(bar.getSelectedId(), "approve");
		bar.handleInput(KEYS.left);
		bar.handleInput(KEYS.enter);
		bar.handleInput(KEYS.escape);

		assert.deepStrictEqual(activated, ["reject"]);
		assert.strictEqual(cancelled, 1);
	});

	it("styles labels by token and highlights the selection only while focused", () => {
		const bar = new ActionBar(tagTheme, { actions });
		assert.strictEqual(
			showTags(bar.render(40).lines[0]!),
			"<success>[ Approve ]</success> <muted>[ Skip ]</muted> <error>[ Reject ]</error>",
		);
		bar.focused = true;
		assert.ok(showTags(bar.render(40).lines[0]!).startsWith("<b><u><accent>[ Approve ]</accent></u></b>"));
	});

	it("keeps the selection across updates unless the selected prop changes", () => {
		const bar = new ActionBar(PLAIN_SEMANTIC_THEME, { actions });
		bar.handleInput(KEYS.right);
		bar.setProps({ actions: [...actions, { id: "later", label: "Later" }] });
		assert.strictEqual(bar.getSelectedId(), "reject");

		bar.setProps({ actions, selectedId: "approve" });
		assert.strictEqual(bar.getSelectedId(), "approve");

		bar.setProps({ actions: actions.filter((action) => action.id !== "approve"), selectedId: "approve" });
		assert.strictEqual(bar.getSelectedId(), "reject");
		assert.strictEqual(bar.hasEnabledActions(), true);
		bar.setProps({ actions: [{ id: "off", label: "Off", disabled: true }] });
		assert.strictEqual(bar.getSelectedId(), undefined);
		assert.strictEqual(bar.hasEnabledActions(), false);
	});
});
