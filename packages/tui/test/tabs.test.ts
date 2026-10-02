import assert from "node:assert";
import { describe, it } from "node:test";
import { Tabs } from "../src/components/tabs.ts";
import { Text } from "../src/components/text.ts";
import { FocusGroup } from "../src/focus.ts";
import { createRenderFrame, type RenderFrame } from "../src/render-frame.ts";
import { PLAIN_SEMANTIC_THEME } from "../src/styled-text.ts";
import type { Component } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { KEYS, showTags, tagTheme } from "./semantic-test-theme.ts";

class Field implements Component {
	focused = false;
	readonly inputs: string[] = [];
	readonly name: string;

	constructor(name: string) {
		this.name = name;
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): RenderFrame {
		return createRenderFrame([`${this.focused ? ">" : " "} ${this.name}`]);
	}

	invalidate(): void {}
}

function createTabs(theme = PLAIN_SEMANTIC_THEME) {
	const settings = new Field("settings field");
	const tabs = new Tabs(theme, {
		tabs: [
			{ id: "general", label: "General", content: settings },
			{ id: "logs", label: "Logs", content: new Text("log output", 0, 0) },
			{ id: "about", label: "About", content: new Text("about", 0, 0) },
		],
	});
	return { tabs, settings };
}

describe("Tabs", () => {
	it("renders the strip, a rule, and the active content within the width", () => {
		const { tabs } = createTabs();
		assert.deepStrictEqual(tabs.render(30).lines, ["General │ Logs │ About", "─".repeat(30), "  settings field"]);

		tabs.handleInput(KEYS.right);
		tabs.handleInput(KEYS.right);
		const narrow = tabs.render(12).lines;
		assert.strictEqual(narrow[0], "… About");
		for (const line of narrow) assert.ok(visibleWidth(line) <= 12, line);
	});

	it("switches tabs with left and right and reports changes", () => {
		const { tabs } = createTabs(tagTheme);
		const changes: string[] = [];
		tabs.onChange = (id) => changes.push(id);
		tabs.focused = true;
		assert.ok(showTags(tabs.render(30).lines[0]!).startsWith("<u><b><accent>General</accent></b></u>"));

		tabs.handleInput(KEYS.left);
		tabs.handleInput(KEYS.right);
		assert.deepStrictEqual(changes, ["about", "general"]);
		assert.strictEqual(tabs.selectTab("missing"), false);
	});

	it("moves focus into focusable content and forwards input there", () => {
		const { tabs, settings } = createTabs();
		tabs.focused = true;
		tabs.handleInput(KEYS.tab);
		assert.strictEqual(settings.focused, true);
		tabs.handleInput(KEYS.right);
		assert.deepStrictEqual(settings.inputs, [KEYS.right]);

		tabs.handleInput(KEYS.shiftTab);
		assert.strictEqual(settings.focused, false);
		tabs.handleInput(KEYS.right);
		assert.strictEqual(tabs.getActiveId(), "logs");
		tabs.handleInput(KEYS.tab);
		tabs.handleInput(KEYS.right);
		assert.strictEqual(tabs.getActiveId(), "about");
	});

	it("is traversed as a scope inside a focus group", () => {
		const { tabs, settings } = createTabs();
		const after = new Field("after");
		const group = new FocusGroup([tabs, after]);
		group.focused = true;

		group.handleInput(KEYS.tab);
		assert.strictEqual(settings.focused, true);
		group.handleInput(KEYS.tab);
		assert.strictEqual(after.focused, true);
		group.handleInput(KEYS.shiftTab);
		assert.strictEqual(settings.focused, true);
	});

	it("follows activeId prop changes and keeps the active tab otherwise", () => {
		const { tabs } = createTabs();
		tabs.handleInput(KEYS.right);
		const props = {
			tabs: [
				{ id: "logs", label: "Logs", content: new Text("new logs", 0, 0) },
				{ id: "about", label: "About", content: new Text("about", 0, 0) },
			],
		};
		tabs.setProps(props);
		assert.strictEqual(tabs.getActiveId(), "logs");
		assert.strictEqual(tabs.render(30).lines[2]?.trimEnd(), "new logs");
		tabs.setProps({ ...props, activeId: "about" });
		assert.strictEqual(tabs.getActiveId(), "about");
	});
});
