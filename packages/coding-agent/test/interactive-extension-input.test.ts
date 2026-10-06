/**
 * Extension input in the TUI: shortcuts are runtime keybinding-table entries
 * named after the intents they invoke, which users rebind like any action;
 * completion providers answer the editor through the `editor_completions`
 * query for the tokens their triggers start.
 */

import type { IntentShortcut } from "@hansjm10/volt-protocol";
import type { AutocompleteItem, AutocompleteProvider, KeyId } from "@hansjm10/volt-tui";
import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { withEditorCompletions } from "../src/modes/interactive/editor-completions.ts";
import { ExtensionShortcutBindings } from "../src/modes/interactive/extension-shortcuts.ts";

const shortcut = (key: string, intent: string, description?: string): IntentShortcut => ({
	key,
	intent,
	...(description === undefined ? {} : { description }),
});

const NOOP = "extension.intent.presets.noop";

/** Bind `key` to an extension intent over the TUI's keybindings with `userBindings`; what the bindings say and bind. */
function bindOne(key: string, userBindings: Record<string, KeyId | KeyId[]> = {}) {
	const bindings = new ExtensionShortcutBindings(new KeybindingsManager(userBindings));
	const diagnostics = bindings.bind([shortcut(key, NOOP)]);
	return { diagnostics, bound: bindings.entries().some((entry) => entry.keys.includes(key as KeyId)) };
}

describe("extension shortcuts in the TUI", () => {
	it("binds each intent's keys as a keybinding-table entry that users rebind", () => {
		const cycle = "extension.intent.presets.cycle";
		const keybindings = new KeybindingsManager({ [cycle]: "ctrl+alt+p" });
		const bindings = new ExtensionShortcutBindings(keybindings);
		bindings.bind([
			shortcut("ctrl+shift+u", cycle, "Cycle presets"),
			shortcut("ctrl+shift+y", "extension.command.presets.preset"),
		]);
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
		bindings.bind([shortcut("ctrl+shift+u", "extension.intent.presets.other")]);
		expect(keybindings.hasDefinition(cycle)).toBe(false);
		expect(bindings.intentFor("\x1b[117;6u")).toBe("extension.intent.presets.other");
		bindings.clear();
		expect(bindings.entries()).toEqual([]);
		expect(bindings.intentFor("\x1b[117;6u")).toBeUndefined();
	});

	it("skips a key a reserved action binds, as the user bound it", () => {
		expect(bindOne("ctrl+c")).toEqual({
			bound: false,
			diagnostics: [
				{
					type: "warning",
					message: `Extension shortcut 'ctrl+c' for ${NOOP} conflicts with built-in shortcut. Skipping.`,
				},
			],
		});
		// The plan-pane key, by default and remapped.
		expect(bindOne("alt+p").bound).toBe(false);
		expect(bindOne("ctrl+shift+x", { "app.plan.togglePane": "ctrl+shift+x" }).bound).toBe(false);
		// A reserved action rebound to another key, or to several, reserves those.
		expect(bindOne("ctrl+x", { "app.interrupt": "ctrl+x" }).bound).toBe(false);
		expect(bindOne("ctrl+y", { "app.clear": ["ctrl+x", "ctrl+y"] }).bound).toBe(false);
		// A key a reserved action shares with another action stays reserved.
		expect(bindOne("ctrl+p").bound).toBe(false);
	});

	it("takes a key a reserved action no longer binds", () => {
		const freed = bindOne("ctrl+p", { "app.model.cycleForward": "ctrl+n" });
		expect(freed.bound).toBe(true);
		// The model picker's provider toggle, which is not reserved, keeps it there.
		expect(freed.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			`Extension shortcut conflict: 'ctrl+p' is built-in shortcut for app.models.toggleProvider and ${NOOP}. Using ${NOOP}.`,
		]);
	});

	it("takes the key of an action that is not reserved, with a warning", () => {
		const paste = new KeybindingsManager().getKeys("app.clipboard.pasteImage")[0];
		if (paste === undefined) throw new Error("Pasting an image has no default key");
		const taken = bindOne(paste);
		expect(taken.bound).toBe(true);
		expect(taken.diagnostics).toEqual([
			{
				type: "warning",
				message: `Extension shortcut conflict: '${paste}' is built-in shortcut for app.clipboard.pasteImage and ${NOOP}. Using ${NOOP}.`,
			},
		]);
		expect(bindOne("ctrl+y", { "app.clipboard.pasteImage": ["ctrl+x", "ctrl+y"] }).bound).toBe(true);
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
