/**
 * What the built-in tools' presenters share (RFC §8.3, Q9): reading a call's
 * arguments defensively (they may be incomplete or of the wrong type while
 * they stream), titles, text and code nodes, and output as terminal lines.
 * Every helper is pure, so presenters built from them stay pure functions of
 * the call.
 */

import type { ToolPresentation, UiNode, UiNodeStyledText, UiNodeToken } from "@hansjm10/volt-protocol";
import { getLanguageFromPath } from "../theme/runtime.ts";
import type { UiStyledLine } from "../ui/ansi-tokens.ts";
import { outputLines, resultText, type ToolPresentInput } from "../ui/presentation.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

export type Args = Record<string, unknown>;

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first of `keys` the arguments hold as a string. */
export function stringArg(args: Args, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

/** A finite number argument. */
export function numberArg(args: Args, key: string): number | undefined {
	const value = args[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Longest one-line text a title shows whole. */
export const TITLE_TEXT_MAX_CHARS = 120;

/** Text as one line, whitespace collapsed, cut to `max` characters. */
export function oneLine(text: string, max = TITLE_TEXT_MAX_CHARS): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/** Styled text or an output line as plain text. */
export function plainText(text: UiStyledLine | UiNodeStyledText): string {
	return typeof text === "string" ? text : text.map((span) => span.text).join("");
}

/** A tool's name and target as a title: the name bold, the target accented, then `suffix`. */
export function titleOf(name: string, target: string | undefined, suffix?: UiNodeStyledText): UiNodeStyledText {
	const spans: Exclude<UiNodeStyledText, string> = [{ text: name, bold: true }];
	spans.push(target === undefined ? { text: " …", token: "muted" } : { text: ` ${target}`, token: "accent" });
	if (suffix !== undefined) spans.push(...(typeof suffix === "string" ? [{ text: suffix }] : suffix));
	return spans;
}

export function textNode(key: string, text: UiNodeStyledText, token?: UiNodeToken): UiNode {
	return { type: "text", key, text, ...(token === undefined ? {} : { token }) };
}

/** The error a failed call reported, as one node. */
export function errorNode(input: ToolPresentInput): UiNode[] {
	const text = resultText(input.result).trim();
	return text ? [textNode("error", text, "error")] : [];
}

/** What a tool is doing: generating its arguments, waiting to run, or running; nothing once done. */
export function activityOf(input: ToolPresentInput, generating: string, running: string): string | undefined {
	if (input.state === "running") return running;
	if (input.state === "pending") return input.argsComplete ? "Waiting to run" : generating;
	return undefined;
}

/** The call ended with an error. */
export function isFailed(input: ToolPresentInput): boolean {
	return input.state === "done" && input.result?.isError === true;
}

/** Text as code lines: tabs as spaces, carriage returns dropped, no trailing blank lines. */
export function codeLines(text: string): string[] {
	const lines = text.replace(/\r/g, "").replace(/\t/g, "   ").split("\n");
	while (lines.length > 0 && lines.at(-1) === "") lines.pop();
	return lines;
}

/** Lines as a code node, highlighted by the language of `path` when it has one. */
export function codeNode(key: string, lines: readonly string[], path?: string): UiNode {
	const language = path === undefined ? undefined : getLanguageFromPath(path);
	return { type: "code", key, ...(language === undefined ? {} : { language }), code: lines.join("\n") };
}

/** "… N more lines" under collapsed output. */
export function moreLines(shown: number, total: number, suffix = ""): UiNode[] {
	return total > shown ? [textNode("more", `… ${total - shown} more lines${suffix}`, "muted")] : [];
}

/** One warning line, such as how a tool truncated its output. */
export function warningNode(text: string, key = "warning"): UiNode {
	return textNode(key, text, "warning");
}

/** What a call's output shows collapsed and expanded. */
export interface PresentedOutput {
	readonly summary: UiNode[];
	/** Empty when the summary shows the output whole. */
	readonly body: UiNode[];
}

/**
 * Output text as terminal lines: collapsed, its first `collapsedLines` and
 * how many more there are; expanded, every line. ANSI styling becomes
 * semantic tokens. Output the summary shows whole has no body.
 */
export function headOutput(text: string, collapsedLines: number, key = "output"): PresentedOutput {
	const lines = outputLines(text.trim());
	if (lines.length === 0) return { summary: [], body: [] };
	const shown = lines.slice(0, collapsedLines);
	return {
		summary: [{ type: "terminal", key, lines: shown }, ...moreLines(shown.length, lines.length)],
		body: lines.length <= collapsedLines ? [] : [{ type: "terminal", key, lines }],
	};
}

/** The text of the call's result, without trailing whitespace. */
export function outputText(input: ToolPresentInput): string {
	return resultText(input.result).trimEnd();
}

/** Styled text as spans. */
export type StyledSpans = Exclude<UiNodeStyledText, string>;

/**
 * A string argument as one styled span: `[invalid arg]` for a value of
 * another type, and `fallback` (or `…` while it streams) when it is absent.
 */
export function argSpan(
	args: Args,
	key: string,
	token: UiNodeToken = "accent",
	fallback?: string,
): StyledSpans[number] {
	const value = args[key];
	if (typeof value === "string") return { text: oneLine(value || fallback || ""), token };
	if (value === undefined || value === null) {
		return fallback === undefined ? { text: "…", token: "muted" } : { text: fallback, token };
	}
	return { text: "[invalid arg]", token: "error" };
}

/** A title: the tool's name in bold, then `spans`, each after a space. */
export function titleSpans(name: string, ...spans: StyledSpans): StyledSpans {
	const result: StyledSpans = [{ text: name, bold: true }];
	for (const span of spans) result.push({ ...span, text: ` ${span.text}` });
	return result;
}

/**
 * Output lines: collapsed, the first `collapsedLines` and how many more
 * there are; expanded, every line; `before` and `after` around them both.
 * Output the summary shows whole has no body.
 */
export function linesOutput(
	lines: UiStyledLine[],
	collapsedLines: number,
	before: UiNode[] = [],
	after: UiNode[] = [],
	key = "output",
): PresentedOutput {
	if (lines.length === 0) return { summary: [...before, ...after], body: [] };
	const shown = lines.slice(0, collapsedLines);
	return {
		summary: [...before, { type: "terminal", key, lines: shown }, ...moreLines(shown.length, lines.length), ...after],
		body: lines.length <= collapsedLines ? [] : [...before, { type: "terminal", key, lines }, ...after],
	};
}

/** A failed call's output as error-styled terminal lines: collapsed, the first `collapsedLines`. */
export function failureOutput(input: ToolPresentInput, collapsedLines: number): PresentedOutput {
	const lines = outputLines(resultText(input.result).trim()).map((line): UiStyledLine => {
		const text = plainText(line);
		return text === "" ? "" : [{ text, token: "error" }];
	});
	return linesOutput(lines, collapsedLines, [], [], "error");
}

/** The truncation a result's details report, when its output was truncated. */
export function truncationOf(details: unknown): Record<string, unknown> | undefined {
	const truncation = isRecord(details) ? details.truncation : undefined;
	return isRecord(truncation) && truncation.truncated === true ? truncation : undefined;
}

/** The byte limit a truncation hit, as its tool names it. */
export function byteLimitText(truncation: Record<string, unknown>): string {
	return formatSize(typeof truncation.maxBytes === "number" ? truncation.maxBytes : DEFAULT_MAX_BYTES);
}

/** `[Truncated: a, b]`, or nothing without reasons. */
export function truncatedWarning(reasons: readonly string[]): UiNode[] {
	return reasons.length === 0 ? [] : [warningNode(`[Truncated: ${reasons.join(", ")}]`)];
}

/** A presentation from its parts, empty trees left out. */
export function presentationOf(
	title: UiNodeStyledText,
	parts: { activity?: string; summary?: UiNode[]; body?: UiNode[]; showsDuration?: boolean } = {},
): ToolPresentation {
	return {
		title,
		...(parts.activity === undefined ? {} : { activity: parts.activity }),
		...(parts.summary === undefined || parts.summary.length === 0 ? {} : { summary: parts.summary }),
		...(parts.body === undefined || parts.body.length === 0 ? {} : { body: parts.body }),
		...(parts.showsDuration === true ? { showsDuration: true } : {}),
	};
}
