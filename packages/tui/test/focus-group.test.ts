import assert from "node:assert";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { type FocusDirection, FocusGroup, type FocusScope } from "../src/focus.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import { createRenderFrame, type RenderFrame } from "../src/render-frame.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";

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

/** A scope with internal positions that is not a FocusGroup. */
class Stepper implements Component, FocusScope {
	position = -1;
	readonly size: number;

	constructor(size: number) {
		this.size = size;
	}

	moveFocus(direction: FocusDirection): boolean {
		const next = this.position + direction;
		if (next < 0 || next >= this.size) return false;
		this.position = next;
		return true;
	}

	enterFocus(direction: FocusDirection): boolean {
		if (this.size === 0) return false;
		this.position = direction === 1 ? 0 : this.size - 1;
		return true;
	}

	handleInput(): void {}

	render(): RenderFrame {
		return createRenderFrame([`stepper ${this.position}`]);
	}

	invalidate(): void {}
}

function focusedName(group: FocusGroup): string | undefined {
	const child = group.getFocusedChild();
	if (child instanceof Field) return child.name;
	if (child instanceof FocusGroup) return `group:${focusedName(child)}`;
	if (child instanceof Stepper) return `stepper:${child.position}`;
	return undefined;
}

describe("FocusGroup", () => {
	it("moves between focusable children with Tab and Shift+Tab and wraps at the root", () => {
		const a = new Field("a");
		const b = new Field("b");
		const group = new FocusGroup([new Text("title", 0, 0), a, b]);
		group.focused = true;

		assert.strictEqual(focusedName(group), "a");
		assert.strictEqual(a.focused, true);
		group.handleInput(TAB);
		assert.strictEqual(focusedName(group), "b");
		assert.deepStrictEqual([a.focused, b.focused], [false, true]);
		group.handleInput(TAB);
		assert.strictEqual(focusedName(group), "a");
		group.handleInput(SHIFT_TAB);
		assert.strictEqual(focusedName(group), "b");
		assert.deepStrictEqual(a.inputs, []);
	});

	it("routes other input to the focused child only and renders children vertically", () => {
		const a = new Field("a");
		const b = new Field("b");
		const group = new FocusGroup([a, b]);
		group.focused = true;
		group.handleInput("x");
		group.handleInput(TAB);
		group.handleInput("y");

		assert.deepStrictEqual(a.inputs, ["x"]);
		assert.deepStrictEqual(b.inputs, ["y"]);
		assert.deepStrictEqual(group.render(20).lines, ["  a", "> b"]);
	});

	it("only flags the active child while the group itself is focused", () => {
		const a = new Field("a");
		const group = new FocusGroup([a]);
		assert.strictEqual(a.focused, false);
		group.focused = true;
		assert.strictEqual(a.focused, true);
		group.focused = false;
		assert.strictEqual(a.focused, false);
	});

	it("traverses nested scopes before moving to the next sibling", () => {
		const inner = new FocusGroup([new Field("b1"), new Field("b2")]);
		const stepper = new Stepper(2);
		const group = new FocusGroup([new Field("a"), inner, stepper, new FocusGroup([]), new Field("c")]);
		group.focused = true;

		const forward: Array<string | undefined> = [];
		for (let step = 0; step < 6; step++) {
			forward.push(focusedName(group));
			group.handleInput(TAB);
		}
		assert.deepStrictEqual(forward, ["a", "group:b1", "group:b2", "stepper:0", "stepper:1", "c"]);
		assert.strictEqual(focusedName(group), "a");

		const backward: Array<string | undefined> = [];
		for (let step = 0; step < 6; step++) {
			group.handleInput(SHIFT_TAB);
			backward.push(focusedName(group));
		}
		assert.deepStrictEqual(backward, ["c", "stepper:1", "stepper:0", "group:b2", "group:b1", "a"]);
	});

	it("propagates the focused flag into nested groups", () => {
		const inner = new Field("inner");
		const nested = new FocusGroup([inner]);
		const group = new FocusGroup([new Field("a"), nested]);
		group.focused = true;
		group.handleInput(TAB);
		assert.strictEqual(nested.focused, true);
		assert.strictEqual(inner.focused, true);
		group.handleInput(TAB);
		assert.strictEqual(inner.focused, false);
	});

	it("stays at the edges without wrap", () => {
		const group = new FocusGroup([new Field("a"), new Field("b")], { wrap: false });
		group.handleInput(TAB);
		group.handleInput(TAB);
		assert.strictEqual(focusedName(group), "b");
		group.handleInput(SHIFT_TAB);
		group.handleInput(SHIFT_TAB);
		assert.strictEqual(focusedName(group), "a");
	});

	it("moves focus to the nearest focusable child when the active child goes away", () => {
		const a = new Field("a");
		const b = new Field("b");
		const c = new Field("c");
		const group = new FocusGroup([a, b, c]);
		group.focused = true;
		group.focus(b);

		group.setChildren([c, b, new Field("d")]);
		assert.strictEqual(focusedName(group), "b");

		group.removeChild(b);
		assert.strictEqual(focusedName(group), "d");
		assert.strictEqual(b.focused, false);

		group.setChildFocusable(group.getFocusedChild()!, false);
		assert.strictEqual(focusedName(group), "c");
		group.handleInput(TAB);
		assert.strictEqual(focusedName(group), "c");

		group.clear();
		assert.strictEqual(group.getFocusedChild(), undefined);
		group.handleInput(TAB);
		group.addChild(a, { focusable: false });
		assert.strictEqual(group.getFocusedChild(), undefined);
		group.addChild(b);
		assert.strictEqual(focusedName(group), "b");
	});

	it("focuses a component inside a nested group", () => {
		const target = new Field("target");
		const nested = new FocusGroup([new Field("other"), target]);
		const group = new FocusGroup([new Field("a"), nested]);
		const changes: Array<Component | undefined> = [];
		group.onFocusChange = (component) => changes.push(component);

		assert.strictEqual(group.focus(target), true);
		assert.strictEqual(focusedName(group), "group:target");
		assert.deepStrictEqual(changes, [nested]);
		assert.strictEqual(group.focus(new Field("missing")), false);
	});

	it("follows runtime keybinding changes", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
		setKeybindings(keybindings);
		try {
			const group = new FocusGroup([new Field("a"), new Field("b")]);
			keybindings.setUserBinding("tui.focus.next", "ctrl+n");
			group.handleInput(TAB);
			assert.strictEqual(focusedName(group), "a");
			group.handleInput("\x0e");
			assert.strictEqual(focusedName(group), "b");
			assert.strictEqual(getKeybindings(), keybindings);
		} finally {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		}
	});

	it("receives input when focused through the TUI", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui = new TuiMainScreen(terminal);
		const a = new Field("a");
		const b = new Field("b");
		const group = new FocusGroup([a, b]);
		tui.addChild(group);
		tui.setFocus(group);
		tui.start();
		terminal.sendInput(TAB);
		terminal.sendInput("z");
		await terminal.waitForRender();

		assert.deepStrictEqual(b.inputs, ["z"]);
		assert.deepStrictEqual(
			terminal
				.getViewport()
				.slice(0, 2)
				.map((line) => line.trimEnd()),
			["  a", "> b"],
		);
		tui.stop();
	});
});
