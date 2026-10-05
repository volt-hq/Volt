/**
 * The TUI theme as semantic tokens (RFC §8.3, §10): `UiNode` data names a
 * token and emphasis, and the active TUI theme decides the terminal styling.
 * Each function reads the theme when it styles, so a theme change applies on
 * the next render.
 */

import type { SemanticTheme } from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";

export const TUI_SEMANTIC_THEME: SemanticTheme = {
	text: (text) => theme.fg("text", text),
	muted: (text) => theme.fg("muted", text),
	accent: (text) => theme.fg("accent", text),
	success: (text) => theme.fg("success", text),
	warning: (text) => theme.fg("warning", text),
	error: (text) => theme.fg("error", text),
	info: (text) => theme.fg("accent", text),
	bold: (text) => theme.bold(text),
	italic: (text) => theme.italic(text),
	underline: (text) => theme.underline(text),
	code: (text) => theme.fg("mdCode", text),
};
