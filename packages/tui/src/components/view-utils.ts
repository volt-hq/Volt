import type { SemanticTheme } from "../styled-text.ts";
import { truncateToWidth, visibleWidth } from "../utils.ts";

/** Truncate a rendered line to `width` and pad it with spaces to exactly `width` columns. */
export function fitLine(line: string, width: number): string {
	const safeWidth = Math.max(0, width);
	const fitted = visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth, "") : line;
	return fitted + " ".repeat(Math.max(0, safeWidth - visibleWidth(fitted)));
}

/** Two-column selection marker shown before the current row of a list-like component. */
export function selectionMarker(theme: SemanticTheme, current: boolean): string {
	return current ? theme.accent("› ") : "  ";
}

/** Range of rows to show so the selected row stays visible, centered when possible. */
export function visibleRange(selected: number, total: number, maxVisible: number): { start: number; end: number } {
	const visible = Math.max(1, maxVisible);
	const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), total - visible));
	return { start, end: Math.min(total, start + visible) };
}
