import assert from "node:assert";
import { describe, it } from "node:test";
import { Card } from "../src/components/card.ts";
import { Text } from "../src/components/text.ts";
import { createRenderFrame, type RenderFrame } from "../src/render-frame.ts";
import { PLAIN_SEMANTIC_THEME } from "../src/styled-text.ts";
import type { Component } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";
import { KEYS, showTags, tagTheme } from "./semantic-test-theme.ts";

class Field implements Component {
	focused = false;
	readonly inputs: string[] = [];

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): RenderFrame {
		return createRenderFrame([this.focused ? "> field" : "  field"]);
	}

	invalidate(): void {}
}

describe("Card", () => {
	it("renders a bordered card with title, badges, sections, and actions", () => {
		const card = new Card(PLAIN_SEMANTIC_THEME, {
			title: "Deploy",
			badges: [{ label: "running", token: "warning" }],
			sections: [
				{ title: "Target", children: [new Text("production", 0, 0)] },
				{ children: [new Text("3 services", 0, 0)] },
			],
			actions: [
				{ id: "approve", label: "Approve" },
				{ id: "cancel", label: "Cancel" },
			],
		});
		const lines = card.render(32).lines;
		assert.deepStrictEqual(lines, [
			"╭─ Deploy ────────── [running] ╮",
			"│ Target                       │",
			"│ production                   │",
			"├──────────────────────────────┤",
			"│ 3 services                   │",
			"├──────────────────────────────┤",
			"│ [ Approve ] [ Cancel ]       │",
			"╰──────────────────────────────╯",
		]);
		for (const width of [32, 14]) {
			for (const line of card.render(width).lines) assert.strictEqual(visibleWidth(line), width, line);
		}
		for (const line of card.render(6).lines) assert.ok(visibleWidth(line) <= 6, line);
		assert.strictEqual(card.render(6).lines[0], "Deploy");
		assert.strictEqual(card.render(5).lines[0]?.replace(/\x1b\[[0-9;]*m/g, ""), "Depl…");
	});

	it("styles the title, badges, and borders with semantic tokens", () => {
		const card = new Card(tagTheme, {
			title: "Job",
			titleToken: "error",
			badges: [{ label: "failed", token: "error" }],
		});
		const header = showTags(card.render(30).lines[0]!);
		assert.ok(header.startsWith("<muted>╭─ </muted><b><error>Job</error></b>"), header);
		assert.ok(header.includes("<error>[failed]</error>"), header);
	});

	it("moves focus between focusable section children and the actions", () => {
		const field = new Field();
		const card = new Card(PLAIN_SEMANTIC_THEME, {
			title: "Review",
			sections: [{ children: [new Text("summary", 0, 0), field] }],
			actions: [
				{ id: "accept", label: "Accept" },
				{ id: "reject", label: "Reject" },
			],
		});
		const activated: string[] = [];
		card.onAction = (id) => activated.push(id);
		card.focused = true;

		assert.strictEqual(field.focused, true);
		card.handleInput("x");
		card.handleInput(KEYS.tab);
		assert.strictEqual(field.focused, false);
		card.handleInput(KEYS.right);
		card.handleInput(KEYS.enter);
		card.handleInput(KEYS.tab);
		assert.strictEqual(card.getFocusedChild(), field);

		assert.deepStrictEqual(field.inputs, ["x"]);
		assert.deepStrictEqual(activated, ["reject"]);
		assert.strictEqual(card.enterFocus(-1), true);
		assert.notStrictEqual(card.getFocusedChild(), field);
		assert.strictEqual(card.moveFocus(1), false);
	});

	it("keeps focus on a retained child when sections change and cancels without focusable parts", () => {
		const field = new Field();
		const card = new Card(PLAIN_SEMANTIC_THEME, { title: "A", sections: [{ children: [field] }] });
		card.focused = true;
		card.setProps({ title: "B", sections: [{ title: "More", children: [new Text("x", 0, 0), field] }] });
		assert.strictEqual(card.getFocusedChild(), field);
		assert.strictEqual(field.focused, true);

		let cancelled = 0;
		const passive = new Card(PLAIN_SEMANTIC_THEME, {
			title: "Info",
			sections: [{ children: [new Text("x", 0, 0)] }],
		});
		passive.onCancel = () => cancelled++;
		passive.handleInput(KEYS.escape);
		assert.strictEqual(cancelled, 1);
		assert.strictEqual(passive.enterFocus(1), false);
	});
});
