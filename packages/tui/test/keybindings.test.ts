import assert from "node:assert";
import { describe, it } from "node:test";
import { type Keybinding, KeybindingsManager, TUI_KEYBINDINGS } from "../src/keybindings.ts";

describe("KeybindingsManager", () => {
	it("does not evict selector confirm when input submit is rebound", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": ["enter", "ctrl+enter"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.input.submit"), ["enter", "ctrl+enter"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.select.confirm"), ["enter"]);
	});

	it("does not evict cursor bindings when another action reuses the same key", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.select.up": ["up", "ctrl+p"],
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.select.up"), ["up", "ctrl+p"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorUp"), ["up"]);
	});

	it("still reports direct user binding conflicts without evicting defaults", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.input.submit": "ctrl+x",
			"tui.select.confirm": "ctrl+x",
		});

		assert.deepStrictEqual(keybindings.getConflicts(), [
			{
				key: "ctrl+x",
				keybindings: ["tui.input.submit", "tui.select.confirm"],
			},
		]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.cursorLeft"), ["left", "ctrl+b"]);
	});

	it("configures alternate-screen navigation without removing Ctrl-modified editor navigation", () => {
		const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
			"tui.altScreen.pageUp": "alt+u",
			"tui.altScreen.halfPageDown": "ctrl+d",
			"tui.altScreen.search": "ctrl+f",
		});

		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.pageUp"), ["alt+u"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.halfPageDown"), ["ctrl+d"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.altScreen.search"), ["ctrl+f"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.pageUp"), ["pageUp", "ctrl+pageUp"]);
		assert.deepStrictEqual(keybindings.getKeys("tui.editor.pageDown"), ["pageDown", "ctrl+pageDown"]);
	});

	describe("runtime updates", () => {
		it("adds definitions after construction and applies stored user overrides to them", () => {
			const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "ext.open": "ctrl+o" });
			assert.strictEqual(keybindings.hasDefinition("ext.open"), false);
			assert.deepStrictEqual(keybindings.findKeybindings("\x0f"), []);

			keybindings.setDefinitions({ "ext.open": { defaultKeys: "ctrl+x", description: "Open" } });

			assert.strictEqual(keybindings.hasDefinition("ext.open"), true);
			assert.deepStrictEqual(keybindings.getKeys("ext.open" as Keybinding), ["ctrl+o"]);
			assert.deepStrictEqual(keybindings.findKeybindings("\x0f"), ["ext.open"]);
			assert.deepStrictEqual(keybindings.getDefinition("ext.open" as Keybinding), {
				defaultKeys: "ctrl+x",
				description: "Open",
			});
		});

		it("replaces and removes definitions while keeping user overrides for a later redefinition", () => {
			const keybindings = new KeybindingsManager({ "ext.run": { defaultKeys: "ctrl+r" } });
			keybindings.setDefinitions({ "ext.run": { defaultKeys: ["ctrl+e", "f5"] } });
			assert.deepStrictEqual(keybindings.getKeys("ext.run" as Keybinding), ["ctrl+e", "f5"]);

			keybindings.setUserBinding("ext.run", "ctrl+t");
			keybindings.removeDefinitions(["ext.run"]);
			assert.strictEqual(keybindings.hasDefinition("ext.run"), false);
			assert.deepStrictEqual(keybindings.getKeys("ext.run" as Keybinding), []);
			assert.strictEqual(keybindings.getDefinition("ext.run" as Keybinding), undefined);
			assert.deepStrictEqual(keybindings.getResolvedBindings(), {});

			keybindings.setDefinitions({ "ext.run": { defaultKeys: "ctrl+r" } });
			assert.deepStrictEqual(keybindings.getKeys("ext.run" as Keybinding), ["ctrl+t"]);
		});

		it("sets and resets a single user override", () => {
			const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
			keybindings.setUserBinding("tui.focus.next", ["ctrl+n", "tab"]);
			assert.deepStrictEqual(keybindings.getKeys("tui.focus.next"), ["ctrl+n", "tab"]);
			assert.deepStrictEqual(keybindings.getUserBindings(), { "tui.focus.next": ["ctrl+n", "tab"] });

			keybindings.setUserBinding("tui.focus.next", undefined);
			assert.deepStrictEqual(keybindings.getKeys("tui.focus.next"), ["tab"]);
			assert.deepStrictEqual(keybindings.getUserBindings(), {});
		});

		it("notifies listeners once per change until unsubscribed", () => {
			const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
			const seen: string[][] = [];
			const unsubscribe = keybindings.onChange(() => seen.push(keybindings.getKeys("tui.select.up")));

			keybindings.setUserBindings({ "tui.select.up": "ctrl+p" });
			keybindings.setDefinitions({ "ext.a": { defaultKeys: "f1" }, "ext.b": { defaultKeys: "f2" } });
			keybindings.removeDefinitions(["ext.a", "ext.b", "ext.missing"]);
			keybindings.removeDefinitions(["ext.missing"]);
			unsubscribe();
			keybindings.setUserBinding("tui.select.up", undefined);

			assert.deepStrictEqual(seen, [["ctrl+p"], ["ctrl+p"], ["ctrl+p"]]);
			assert.deepStrictEqual(keybindings.getKeys("tui.select.up"), ["up"]);
		});

		it("recomputes conflicts after runtime changes", () => {
			const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
				"ext.save": "ctrl+x",
				"tui.input.submit": "ctrl+x",
			});
			assert.deepStrictEqual(keybindings.getConflicts(), []);

			keybindings.setDefinitions({ "ext.save": { defaultKeys: "ctrl+s" } });
			assert.deepStrictEqual(keybindings.getConflicts(), [
				{ key: "ctrl+x", keybindings: ["ext.save", "tui.input.submit"] },
			]);

			keybindings.setUserBinding("ext.save", "ctrl+y");
			assert.deepStrictEqual(keybindings.getConflicts(), []);
		});

		it("does not mutate the definition and override objects it was constructed with", () => {
			const userBindings = { "tui.select.up": "ctrl+p" } as const;
			const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, userBindings);
			keybindings.setDefinitions({ "ext.extra": { defaultKeys: "f9" } });
			keybindings.removeDefinitions(["tui.select.down"]);
			keybindings.setUserBinding("tui.select.cancel", "escape");

			assert.strictEqual(Object.hasOwn(TUI_KEYBINDINGS, "ext.extra"), false);
			assert.strictEqual(Object.hasOwn(TUI_KEYBINDINGS, "tui.select.down"), true);
			assert.deepStrictEqual(userBindings, { "tui.select.up": "ctrl+p" });
		});

		it("defines focus traversal actions on Tab and Shift+Tab", () => {
			const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
			assert.strictEqual(keybindings.matches("\t", "tui.focus.next"), true);
			assert.strictEqual(keybindings.matches("\x1b[Z", "tui.focus.previous"), true);
		});
	});
});
