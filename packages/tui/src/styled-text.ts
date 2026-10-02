import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "./utils.ts";

/** Semantic color tokens. Data names a token; an injected {@link SemanticTheme} decides the terminal styling. */
export type SemanticToken = "text" | "muted" | "accent" | "success" | "warning" | "error" | "info";

/** Semantic emphasis applied on top of a token. */
export type SemanticEmphasis = "bold" | "italic" | "underline" | "code";

/** Resolves semantic tokens and emphasis to styled terminal text. */
export type SemanticTheme = Readonly<Record<SemanticToken | SemanticEmphasis, (text: string) => string>>;

/** A run of text with one semantic token and optional emphasis. Text never carries ANSI. */
export interface StyledSpan {
	text: string;
	token?: SemanticToken;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	code?: boolean;
}

/** Plain text, or a sequence of styled spans. */
export type StyledText = string | readonly StyledSpan[];

const unstyled = (text: string): string => text;

/** A theme that renders every token and emphasis as plain text. */
export const PLAIN_SEMANTIC_THEME: SemanticTheme = {
	text: unstyled,
	muted: unstyled,
	accent: unstyled,
	success: unstyled,
	warning: unstyled,
	error: unstyled,
	info: unstyled,
	bold: unstyled,
	italic: unstyled,
	underline: unstyled,
	code: unstyled,
};

/** Remove terminal escape sequences and control characters from data text; tabs become three spaces. */
export function sanitizeText(text: string): string {
	return stripTerminalSequences(text)
		.replace(/\t/g, "   ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

function spansOf(text: StyledText): readonly StyledSpan[] {
	return typeof text === "string" ? [{ text }] : text;
}

/** The visible text of styled text, sanitized and without styling. */
export function styledTextToPlain(text: StyledText): string {
	return spansOf(text)
		.map((span) => sanitizeText(span.text))
		.join("");
}

/** Terminal width of styled text rendered on one line. */
export function styledTextWidth(text: StyledText): number {
	return visibleWidth(styledTextToPlain(text).replace(/\n/g, " "));
}

function styleSpanLine(text: string, span: StyledSpan, theme: SemanticTheme, baseToken: SemanticToken): string {
	if (text.length === 0) return "";
	let styled = span.code ? theme.code(text) : text;
	styled = theme[span.token ?? baseToken](styled);
	if (span.bold) styled = theme.bold(styled);
	if (span.italic) styled = theme.italic(styled);
	if (span.underline) styled = theme.underline(styled);
	return styled;
}

/**
 * Resolve styled text through a theme. Unstyled spans use `baseToken`. Newlines are kept and each line is
 * styled separately so no style leaks across a line break.
 */
export function renderStyledText(text: StyledText, theme: SemanticTheme, baseToken: SemanticToken = "text"): string {
	return spansOf(text)
		.map((span) =>
			sanitizeText(span.text)
				.split("\n")
				.map((line) => styleSpanLine(line, span, theme, baseToken))
				.join("\n"),
		)
		.join("");
}

/** Render and word-wrap styled text to lines no wider than `width`. */
export function wrapStyledText(
	text: StyledText,
	width: number,
	theme: SemanticTheme,
	baseToken: SemanticToken = "text",
): string[] {
	return wrapTextWithAnsi(renderStyledText(text, theme, baseToken), Math.max(1, width));
}

/** Render styled text on one line (newlines become spaces), truncated with an ellipsis to `width`. */
export function truncateStyledText(
	text: StyledText,
	width: number,
	theme: SemanticTheme,
	baseToken: SemanticToken = "text",
	ellipsis = "…",
): string {
	const singleLine = spansOf(text).map((span) => ({ ...span, text: span.text.replace(/\r?\n/g, " ") }));
	return truncateToWidth(renderStyledText(singleLine, theme, baseToken), width, ellipsis);
}
