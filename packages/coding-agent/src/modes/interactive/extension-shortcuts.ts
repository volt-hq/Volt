/**
 * Extension shortcuts in the TUI (RFC §8.3): data mapping a key to one of the
 * extension's intents or commands. Each intent a shortcut invokes becomes an
 * entry of the runtime keybinding table, named after the intent, with the
 * shortcuts' keys as its default keys: users rebind it in keybindings.json as
 * any other action. Pressing a key of an entry invokes its intent with no
 * input. The runner keeps an extension's keys off reserved built-in actions.
 */

import type { KeyId } from "@hansjm10/volt-tui";
import type { ExtensionRunner } from "../../core/extensions/index.ts";
import type { KeybindingsManager } from "../../core/keybindings.ts";

/** One entry of the table: the intent it invokes, its keys now, and what it does. */
export interface ExtensionShortcutEntry {
	readonly intent: string;
	readonly keys: KeyId[];
	readonly description: string;
}

/** The keybinding-table entries of the shortcuts of one runner. */
export class ExtensionShortcutBindings {
	private readonly keybindings: KeybindingsManager;
	/** The table entries of the bound shortcuts, by intent. */
	private descriptions = new Map<string, string>();

	constructor(keybindings: KeybindingsManager) {
		this.keybindings = keybindings;
	}

	/** Replace the table's extension entries with those of `runner`'s shortcuts. */
	bind(runner: ExtensionRunner): void {
		this.clear();
		// Read without the previous entries: the runner checks the shortcuts against the built-in keys alone.
		const shortcuts = runner.getShortcuts(this.keybindings.getEffectiveConfig());
		const keys = new Map<string, KeyId[]>();
		for (const [key, shortcut] of shortcuts) {
			keys.set(shortcut.intent, [...(keys.get(shortcut.intent) ?? []), key]);
			if (!this.descriptions.has(shortcut.intent)) {
				this.descriptions.set(shortcut.intent, shortcut.description ?? shortcut.intent);
			}
		}
		if (keys.size === 0) return;
		this.keybindings.setDefinitions(
			Object.fromEntries(
				[...keys].map(([intent, defaultKeys]) => [
					intent,
					{ defaultKeys, description: this.descriptions.get(intent) ?? intent },
				]),
			),
		);
	}

	/** Remove the table's extension entries. */
	clear(): void {
		if (this.descriptions.size === 0) return;
		this.keybindings.removeDefinitions([...this.descriptions.keys()]);
		this.descriptions = new Map();
	}

	/** The intent `data` invokes, when it is a key of an extension entry. */
	intentFor(data: string): string | undefined {
		return this.keybindings.findKeybindings(data).find((id) => this.descriptions.has(id));
	}

	/** The extension entries with their keys now, for the hotkeys view. */
	entries(): ExtensionShortcutEntry[] {
		const resolved = this.keybindings.getEffectiveConfig();
		return [...this.descriptions].map(([intent, description]) => {
			const keys = resolved[intent];
			return { intent, keys: keys === undefined ? [] : Array.isArray(keys) ? keys : [keys], description };
		});
	}
}
