/**
 * The TUI theme as semantic tokens (RFC §8.3, §10): `UiNode` data names a
 * token and emphasis, and the active TUI theme decides the terminal styling.
 * Each function reads the theme when it styles, so a theme change applies on
 * the next render.
 */

import type { SemanticTheme } from "@hansjm10/volt-tui";
import { highlightShellCommand, theme } from "../../../core/theme/runtime.ts";

export const TUI_SEMANTIC_THEME: SemanticTheme = {
	text: (text) => theme.fg("text", text),
	muted: (text) => theme.fg("muted", text),
	accent: (text) => theme.fg("accent", text),
	success: (text) => theme.fg("success", text),
	warning: (text) => theme.fg("warning", text),
	error: (text) => theme.fg("error", text),
	info: (text) => theme.fg("info", text),
	bold: (text) => theme.bold(text),
	italic: (text) => theme.italic(text),
	underline: (text) => theme.underline(text),
	code: (text) => theme.fg("mdCode", text),
};

/**
 * A tool call's content: unstyled text in the theme's tool output color, and
 * muted text one step dimmer, so the call's output stands apart from the
 * assistant's text and keeps its own emphasis.
 */
export const TOOL_OUTPUT_SEMANTIC_THEME: SemanticTheme = {
	...TUI_SEMANTIC_THEME,
	text: (text) => theme.fg("toolOutput", text),
	muted: (text) => theme.fg("dim", text),
};

/**
 * A tool call's title: unstyled text in the theme's tool title color, and
 * accented text (what the call acts on: a path, a pattern) in the theme's tool
 * target color, so the accent color stays for focus and selection.
 */
export const TOOL_TITLE_SEMANTIC_THEME: SemanticTheme = {
	...TUI_SEMANTIC_THEME,
	text: (text) => theme.fg("toolTitle", text),
	accent: (text) => theme.fg("toolTarget", text),
};

/** A shell tool call's title: as any tool's, with its code (the command) highlighted as Bash. */
export const SHELL_TOOL_TITLE_SEMANTIC_THEME: SemanticTheme = {
	...TOOL_TITLE_SEMANTIC_THEME,
	code: (text) => highlightShellCommand(text).join(" "),
};
