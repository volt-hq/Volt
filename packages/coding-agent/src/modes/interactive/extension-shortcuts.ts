/**
 * Extension shortcuts in the TUI (RFC §8.3): data mapping a key to one of the
 * extension's intents or commands, as the conversation's `intents` catalog
 * lists them. Each intent a shortcut invokes becomes an entry of the runtime
 * keybinding table, named after the intent, with the shortcuts' keys as its
 * default keys: users rebind it in keybindings.json as any other action.
 * Pressing a key of an entry invokes its intent with no input. The TUI keeps
 * the extensions' keys off its reserved actions; a key another built-in
 * action binds goes to the extension, with a warning.
 */

import type { IntentShortcut } from "@hansjm10/volt-protocol";
import type { KeyId } from "@hansjm10/volt-tui";
import type { KeybindingsConfig, KeybindingsManager } from "../../core/keybindings.ts";

/**
 * The TUI's actions whose keys no extension shortcut takes: the main view's
 * global keys. Picker-specific keys are not reserved.
 */
const RESERVED_ACTIONS: ReadonlySet<string> = new Set([
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.plan.togglePane",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
]);

/** One entry of the table: the intent it invokes, its keys now, and what it does. */
export interface ExtensionShortcutEntry {
	readonly intent: string;
	readonly keys: KeyId[];
	readonly description: string;
}

/** A shortcut the TUI skipped or let take a built-in action's key. */
export interface ShortcutDiagnostic {
	readonly type: "warning";
	readonly message: string;
}

/**
 * The built-in action each key of `config` triggers, by lowercase key: a
 * reserved action wins a key several actions bind.
 */
function builtInKeys(config: KeybindingsConfig): Map<string, { readonly action: string; readonly reserved: boolean }> {
	const keys = new Map<string, { readonly action: string; readonly reserved: boolean }>();
	for (const [action, bound] of Object.entries(config)) {
		if (bound === undefined) continue;
		const reserved = RESERVED_ACTIONS.has(action);
		for (const key of Array.isArray(bound) ? bound : [bound]) {
			const normalized = key.toLowerCase();
			if (keys.get(normalized)?.reserved === true && !reserved) continue;
			keys.set(normalized, { action, reserved });
		}
	}
	return keys;
}

/** The keybinding-table entries of the conversation's extension shortcuts. */
export class ExtensionShortcutBindings {
	private readonly keybindings: KeybindingsManager;
	/** The table entries of the bound shortcuts, by intent. */
	private descriptions = new Map<string, string>();

	constructor(keybindings: KeybindingsManager) {
		this.keybindings = keybindings;
	}

	/**
	 * Replace the table's extension entries with those of `shortcuts`: a key a
	 * reserved action binds is skipped, and a key another built-in action binds
	 * goes to the shortcut. Says what it skipped or overrode.
	 */
	bind(shortcuts: readonly IntentShortcut[]): ShortcutDiagnostic[] {
		this.clear();
		// Read without the previous entries: the shortcuts compete with the built-in keys alone.
		const builtIn = builtInKeys(this.keybindings.getEffectiveConfig());
		const diagnostics: ShortcutDiagnostic[] = [];
		const keys = new Map<string, KeyId[]>();
		for (const shortcut of shortcuts) {
			const taken = builtIn.get(shortcut.key.toLowerCase());
			if (taken?.reserved === true) {
				diagnostics.push({
					type: "warning",
					message: `Extension shortcut '${shortcut.key}' for ${shortcut.intent} conflicts with built-in shortcut. Skipping.`,
				});
				continue;
			}
			if (taken !== undefined) {
				diagnostics.push({
					type: "warning",
					message: `Extension shortcut conflict: '${shortcut.key}' is built-in shortcut for ${taken.action} and ${shortcut.intent}. Using ${shortcut.intent}.`,
				});
			}
			// The catalog's keys are the ones extensions registered, which the editor matches as key ids.
			keys.set(shortcut.intent, [...(keys.get(shortcut.intent) ?? []), shortcut.key as KeyId]);
			if (!this.descriptions.has(shortcut.intent)) {
				this.descriptions.set(shortcut.intent, shortcut.description ?? shortcut.intent);
			}
		}
		if (keys.size === 0) return diagnostics;
		this.keybindings.setDefinitions(
			Object.fromEntries(
				[...keys].map(([intent, defaultKeys]) => [
					intent,
					{ defaultKeys, description: this.descriptions.get(intent) ?? intent },
				]),
			),
		);
		return diagnostics;
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
