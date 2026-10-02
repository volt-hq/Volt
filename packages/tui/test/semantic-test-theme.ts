import type { SemanticTheme } from "../src/styled-text.ts";

const tag =
	(name: string) =>
	(text: string): string =>
		`\x1b_${name}\x07${text}\x1b_/${name}\x07`;

/**
 * Marks every token and emphasis except `text` with zero-width APC tags, so layout matches a real ANSI theme
 * while tests can assert semantic styling through {@link showTags}.
 */
export const tagTheme: SemanticTheme = {
	text: (text) => text,
	muted: tag("muted"),
	accent: tag("accent"),
	success: tag("success"),
	warning: tag("warning"),
	error: tag("error"),
	info: tag("info"),
	bold: tag("b"),
	italic: tag("i"),
	underline: tag("u"),
	code: tag("code"),
};

/** Replace tag markers with readable `<tag>` markup and drop SGR resets added by truncation. */
export function showTags(line: string): string {
	return line.replace(/\x1b_(\/?[a-z]+)\x07/g, "<$1>").replace(/\x1b\[0m/g, "");
}

export const KEYS = {
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	left: "\x1b[D",
	enter: "\r",
	escape: "\x1b",
	space: " ",
	tab: "\t",
	shiftTab: "\x1b[Z",
	pageDown: "\x1b[6~",
	backspace: "\x7f",
} as const;
