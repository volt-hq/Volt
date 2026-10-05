/**
 * Extension input in the TUI: shortcuts are runtime keybinding-table entries
 * named after the intents they invoke, which users rebind like any action;
 * completion providers answer the editor through the `editor_completions`
 * query for the tokens their triggers start.
 */

import type { AutocompleteItem, AutocompleteProvider, KeyId } from "@hansjm10/volt-tui";
import { describe, expect, it } from "vitest";
import type { ExtensionRunner, ExtensionShortcut } from "../src/core/extensions/index.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { withEditorCompletions } from "../src/modes/interactive/editor-completions.ts";
import { ExtensionShortcutBindings } from "../src/modes/interactive/extension-shortcuts.ts";

function runnerWith(shortcuts: ExtensionShortcut[]): ExtensionRunner {
	return {
		getShortcuts: () => new Map(shortcuts.map((shortcut) => [shortcut.shortcut, shortcut])),
	} as unknown as ExtensionRunner;
}

const shortcut = (key: KeyId, intent: string, description?: string): ExtensionShortcut => ({
	shortcut: key,
	intent,
	extensionId: "presets",
	...(description === undefined ? {} : { description }),
});

describe("extension shortcuts in the TUI", () => {
	it("binds each intent's keys as a keybinding-table entry that users rebind", () => {
		const cycle = "extension.intent.presets.cycle";
		const keybindings = new KeybindingsManager({ [cycle]: "ctrl+alt+p" });
		const bindings = new ExtensionShortcutBindings(keybindings);
		bindings.bind(
			runnerWith([
				shortcut("ctrl+shift+u", cycle, "Cycle presets"),
				shortcut("ctrl+shift+y", "extension.command.presets.preset"),
			]),
		);
		// The user's keys replace the extension's default for the cycle intent.
		expect(bindings.intentFor("\x1b[112;7u")).toBe(cycle);
		expect(bindings.intentFor("\x1b[117;6u")).toBeUndefined();
		expect(bindings.intentFor("\x1b[121;6u")).toBe("extension.command.presets.preset");
		expect(bindings.entries()).toEqual([
			{ intent: cycle, keys: ["ctrl+alt+p"], description: "Cycle presets" },
			{
				intent: "extension.command.presets.preset",
				keys: ["ctrl+shift+y"],
				description: "extension.command.presets.preset",
			},
		]);

		// Rebinding drops the previous entries; the user's override stays stored for when the intent returns.
		bindings.bind(runnerWith([shortcut("ctrl+shift+u", "extension.intent.presets.other")]));
		expect(keybindings.hasDefinition(cycle)).toBe(false);
		expect(bindings.intentFor("\x1b[117;6u")).toBe("extension.intent.presets.other");
		bindings.clear();
		expect(bindings.entries()).toEqual([]);
		expect(bindings.intentFor("\x1b[117;6u")).toBeUndefined();
	});
});

describe("extension completions in the TUI editor", () => {
	const base: AutocompleteProvider = {
		triggerCharacters: ["@"],
		getSuggestions: async () => ({ items: [{ value: "@file", label: "@file" }], prefix: "@" }),
		applyCompletion: (lines) => ({ lines: [...lines, "base"], cursorLine: 0, cursorCol: 0 }),
	};

	it("asks the host for tokens a trigger starts and replaces the token with the chosen item", async () => {
		const asked: Array<[string, number]> = [];
		const provider = withEditorCompletions(base, {
			triggers: ["#"],
			complete: async (text, cursor) => {
				asked.push([text, cursor]);
				return { prefix: "#4", items: [{ value: "#42", description: "Fix crash" }] };
			},
		});
		expect(provider.triggerCharacters).toEqual(["@", "#"]);
		const signal = new AbortController().signal;
		const suggestions = await provider.getSuggestions(["first", "fix #4 now"], 1, 6, { signal });
		expect(asked).toEqual([["first\nfix #4 now", 12]]);
		expect(suggestions).toEqual({ prefix: "#4", items: [{ value: "#42", label: "#42", description: "Fix crash" }] });
		const item = suggestions?.items[0] as AutocompleteItem;
		expect(provider.applyCompletion(["first", "fix #4 now"], 1, 6, item, "#4")).toEqual({
			lines: ["first", "fix #42 now"],
			cursorLine: 1,
			cursorCol: 7,
		});
		// Other tokens, and items the base offered, complete as the base completes them.
		await expect(provider.getSuggestions(["see @"], 0, 5, { signal })).resolves.toMatchObject({ prefix: "@" });
		expect(provider.applyCompletion(["x"], 0, 1, { value: "@file", label: "@file" }, "@").lines).toEqual([
			"x",
			"base",
		]);
		expect(asked).toHaveLength(1);
	});

	it("falls back to the base when the host has nothing or fails", async () => {
		const signal = new AbortController().signal;
		const empty = withEditorCompletions(base, {
			triggers: ["#"],
			complete: async () => ({ prefix: "#", items: [] }),
		});
		await expect(empty.getSuggestions(["#"], 0, 1, { signal })).resolves.toMatchObject({ prefix: "@" });
		const failing = withEditorCompletions(base, {
			triggers: ["#"],
			complete: () => Promise.reject(new Error("unavailable")),
		});
		await expect(failing.getSuggestions(["#"], 0, 1, { signal })).resolves.toMatchObject({ prefix: "@" });
		expect(withEditorCompletions(base, { triggers: [], complete: async () => ({ prefix: "", items: [] }) })).toBe(
			base,
		);
	});
});
