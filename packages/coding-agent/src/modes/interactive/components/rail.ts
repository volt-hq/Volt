import { theme } from "../../../core/theme/runtime.ts";
import { bgAnsi } from "../../../core/theme/tokens.ts";
import type { ThemeColor } from "../../../core/theme/types.ts";

/**
 * Two-column prefix for a transcript block's left rail. The rail is a background-colored space rather
 * than a box-drawing glyph, so text copied from terminal scrollback does not pick up rail characters.
 * A color that resolves to the terminal default cannot paint a background, so it keeps the `│` glyph.
 */
export function railPrefix(color: ThemeColor): string {
	const value = theme.resolvedColors[color];
	if (value === undefined || value === "") return `${theme.fg(color, "│")} `;
	return `${bgAnsi(value, theme.getColorMode())} \x1b[49m `;
}
