/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const displayPart = process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

/** The first key bound to `keybinding`, for hint rows with no room to name every alternative. */
export function primaryKeyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding).slice(0, 1));
}

export function editorTopBorderLabel(mode: "ask" | "steer" | "shell"): string {
	if (mode === "shell") return "SHELL";
	if (mode === "ask") return "ASK VOLT";
	return `STEER · ${keyDisplayText("tui.input.submit")} now · ${keyDisplayText("app.message.followUp")} later · ${keyDisplayText("app.interrupt")} stop`;
}

/** The composer's label in Plan mode; its border takes the theme's `planMode` color. */
export const PLAN_MODE_EDITOR_LABEL = "PLAN · READ-ONLY";

export function editorTopBorderLabelForState(state: {
	bashMode: boolean;
	streaming: boolean;
	hasText: boolean;
	agentMode: "build" | "plan";
	planReady: boolean;
	/** The ready-plan chooser (plan pane or Plan Details) holds focus; typing there still reaches the composer. */
	planChooserFocused?: boolean;
}): string {
	if (state.bashMode) return editorTopBorderLabel("shell");
	// A ready plan blocks on the user in either mode, so its cue outranks the mode label.
	if (state.planReady && !state.streaming) {
		if (state.planChooserFocused) return "PLAN READY · Type to send feedback";
		return `PLAN READY · ${keyDisplayText("app.plan.togglePane")} choose next step · ${keyDisplayText("tui.input.submit")} send feedback`;
	}
	if (state.agentMode === "plan") return PLAN_MODE_EDITOR_LABEL;
	if (state.streaming && state.hasText) return editorTopBorderLabel("steer");
	return "ASK VOLT · BUILD";
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);
}
