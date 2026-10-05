/**
 * ANSI to semantic tokens (RFC §8.3). `UiNode` text never carries terminal
 * control sequences: the host converts the styling of extension and tool
 * text to styled spans and strips everything else.
 *
 * SGR foreground colors map to tokens: red to `error`, green to `success`,
 * yellow to `warning`, blue and cyan to `info`, magenta to `accent`, and
 * bright black to `muted`; dim text without one of those colors is `muted`.
 * Bold, italic, and underline map to emphasis. Every other attribute (black
 * and white, 256-color and RGB colors, backgrounds), every other escape
 * sequence, the C0 and C1 controls other than tab and line feed (carriage
 * returns included), and the bidirectional embedding, override, and isolate
 * controls are stripped.
 */

import type { UiNodeStyledText, UiNodeToken, UiTerminalNode } from "@hansjm10/volt-protocol";

type StyledSpan = Exclude<UiNodeStyledText, string>[number];
/** One terminal output line, plain or styled. */
export type UiStyledLine = UiTerminalNode["lines"][number];

interface SgrState {
	color: UiNodeToken | undefined;
	dim: boolean;
	bold: boolean;
	italic: boolean;
	underline: boolean;
}

/** Controls that remain after escape sequences are removed: C0 but tab and line feed, DEL, and bidi controls. */
const STRIPPED_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g;

const COLOR_TOKENS: ReadonlyMap<number, UiNodeToken> = new Map([
	[31, "error"],
	[91, "error"],
	[32, "success"],
	[92, "success"],
	[33, "warning"],
	[93, "warning"],
	[34, "info"],
	[36, "info"],
	[94, "info"],
	[96, "info"],
	[35, "accent"],
	[95, "accent"],
	[90, "muted"],
]);

function isStringIntroducer(code: number): boolean {
	// OSC, DCS, SOS, PM, APC after ESC.
	return code === 0x5d || code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f;
}

function isC1StringIntroducer(code: number): boolean {
	return code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f;
}

/** The end of a control string starting at `index`: after BEL or ST, or the end of the text. */
function skipControlString(text: string, index: number): number {
	for (let at = index; at < text.length; at++) {
		const code = text.charCodeAt(at);
		if (code === 0x07 || code === 0x9c) return at + 1;
		if (code === 0x1b && text.charCodeAt(at + 1) === 0x5c) return at + 2;
	}
	return text.length;
}

/** The end of a CSI sequence whose parameters start at `index`; reports SGR parameters. */
function skipCsi(text: string, index: number, onSgr: (params: string) => void): number {
	let at = index;
	while (at < text.length && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x3f) at++;
	const paramsEnd = at;
	while (at < text.length && text.charCodeAt(at) >= 0x20 && text.charCodeAt(at) <= 0x2f) at++;
	if (at >= text.length) return at;
	const final = text.charCodeAt(at);
	if (final < 0x40 || final > 0x7e) return at;
	const params = text.slice(index, paramsEnd);
	if (final === 0x6d && paramsEnd === at && /^[\d;:]*$/.test(params)) onSgr(params);
	return at + 1;
}

/** The end of the escape sequence or C1 control at `index`. */
function skipSequence(text: string, index: number, onSgr: (params: string) => void): number {
	const code = text.charCodeAt(index);
	if (code !== 0x1b) {
		if (code === 0x9b) return skipCsi(text, index + 1, onSgr);
		if (isC1StringIntroducer(code)) return skipControlString(text, index + 1);
		return index + 1;
	}
	if (index + 1 >= text.length) return index + 1;
	const second = text.charCodeAt(index + 1);
	if (second === 0x5b) return skipCsi(text, index + 2, onSgr);
	if (isStringIntroducer(second)) return skipControlString(text, index + 2);
	let at = index + 1;
	while (at < text.length && text.charCodeAt(at) >= 0x20 && text.charCodeAt(at) <= 0x2f) at++;
	if (at < text.length && text.charCodeAt(at) >= 0x30 && text.charCodeAt(at) <= 0x7e) return at + 1;
	return at === index + 1 ? index + 1 : at;
}

/** Walk `text`: visible chunks (controls not yet removed) and the SGR parameters between them, in order. */
function scan(text: string, onText: (chunk: string) => void, onSgr: (params: string) => void): void {
	let start = 0;
	let index = 0;
	while (index < text.length) {
		const code = text.charCodeAt(index);
		if (code !== 0x1b && (code < 0x80 || code > 0x9f)) {
			index++;
			continue;
		}
		if (index > start) onText(text.slice(start, index));
		index = skipSequence(text, index, onSgr);
		start = index;
	}
	if (index > start) onText(text.slice(start, index));
}

/** Skip the color arguments of an extended color (38, 48, 58) given in `;` form; returns the fields consumed. */
function extendedColorFields(fields: readonly string[], index: number, colonForm: boolean): number {
	if (colonForm) return 0;
	const mode = fields[index + 1];
	if (mode === "5") return 2;
	if (mode === "2") return 4;
	return 0;
}

function applySgr(state: SgrState, params: string): void {
	const fields = params === "" ? ["0"] : params.split(";");
	for (let index = 0; index < fields.length; index++) {
		const [head = "", ...sub] = fields[index]!.split(":");
		const code = head === "" ? 0 : Number(head);
		if (code === 0) {
			state.color = undefined;
			state.dim = false;
			state.bold = false;
			state.italic = false;
			state.underline = false;
		} else if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 3) state.italic = true;
		else if (code === 4) state.underline = sub[0] !== "0";
		else if (code === 22) {
			state.bold = false;
			state.dim = false;
		} else if (code === 23) state.italic = false;
		else if (code === 24) state.underline = false;
		else if ((code >= 30 && code <= 39) || (code >= 90 && code <= 97)) {
			state.color = COLOR_TOKENS.get(code);
			if (code === 38) index += extendedColorFields(fields, index, sub.length > 0);
		} else if (code === 48 || code === 58) {
			index += extendedColorFields(fields, index, sub.length > 0);
		}
	}
}

function spanOf(text: string, state: SgrState): StyledSpan {
	const token = state.color ?? (state.dim ? "muted" : undefined);
	return {
		text,
		...(token === undefined ? {} : { token }),
		...(state.bold ? { bold: true } : {}),
		...(state.italic ? { italic: true } : {}),
		...(state.underline ? { underline: true } : {}),
	};
}

function sameStyle(left: StyledSpan, right: StyledSpan): boolean {
	return (
		left.token === right.token &&
		left.bold === right.bold &&
		left.italic === right.italic &&
		left.underline === right.underline &&
		left.code === right.code
	);
}

function isUnstyled(span: StyledSpan): boolean {
	return span.token === undefined && !span.bold && !span.italic && !span.underline && !span.code;
}

/** Append a span, merging it into the previous one when both share a style. */
function pushSpan(spans: StyledSpan[], span: StyledSpan): void {
	if (span.text.length === 0) return;
	const last = spans[spans.length - 1];
	if (last && sameStyle(last, span)) spans[spans.length - 1] = { ...last, text: last.text + span.text };
	else spans.push(span);
}

/** Spans as styled text: plain text when none is styled. */
function collapse(spans: readonly StyledSpan[]): UiNodeStyledText {
	if (spans.every(isUnstyled)) return spans.map((span) => span.text).join("");
	return [...spans];
}

function styledSpans(text: string): StyledSpan[] {
	const spans: StyledSpan[] = [];
	const state: SgrState = { color: undefined, dim: false, bold: false, italic: false, underline: false };
	scan(
		text,
		(chunk) => pushSpan(spans, spanOf(chunk.replace(STRIPPED_CHARACTERS, ""), state)),
		(params) => applySgr(state, params),
	);
	return spans;
}

/** Text with terminal styling converted to semantic tokens and every other control stripped. */
export function ansiToStyledText(text: string): UiNodeStyledText {
	return collapse(styledSpans(text));
}

/** Output text as lines (split at line feeds) with its styling as tokens; styling carries across lines. */
export function ansiToStyledLines(text: string): UiStyledLine[] {
	const lines: StyledSpan[][] = [[]];
	for (const span of styledSpans(text)) {
		const [first = "", ...rest] = span.text.split("\n");
		pushSpan(lines[lines.length - 1]!, { ...span, text: first });
		for (const part of rest) {
			const line: StyledSpan[] = [];
			pushSpan(line, { ...span, text: part });
			lines.push(line);
		}
	}
	return lines.map(collapse);
}

/** Text with every escape sequence and control other than tab and line feed removed. */
export function stripTerminalControls(text: string): string {
	let result = "";
	scan(
		text,
		(chunk) => {
			result += chunk;
		},
		() => {},
	);
	return result.replace(STRIPPED_CHARACTERS, "");
}
