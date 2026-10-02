/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

interface NormalizedCharacterRange {
	start: number;
	end: number;
}

interface FuzzyNormalizedText {
	text: string;
	ranges: NormalizedCharacterRange[];
}

function normalizeFuzzySegment(segment: string): string {
	return (
		segment
			.normalize("NFKC")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

function getCodePointEnd(text: string, index: number): number {
	const codePoint = text.codePointAt(index);
	return index + (codePoint !== undefined && codePoint > 0xffff ? 2 : 1);
}

function isCombiningMark(segment: string): boolean {
	return /^\p{Mark}$/u.test(segment);
}

function getFuzzySegmentEnd(text: string, index: number): number {
	let end = getCodePointEnd(text, index);
	while (end < text.length) {
		const nextEnd = getCodePointEnd(text, end);
		if (!isCombiningMark(text.slice(end, nextEnd))) {
			break;
		}
		end = nextEnd;
	}
	return end;
}

function pushNormalizedCharacter(
	characters: string[],
	ranges: NormalizedCharacterRange[],
	character: string,
	range: NormalizedCharacterRange,
): void {
	characters.push(character);
	for (let index = 0; index < character.length; index++) {
		ranges.push(range);
	}
}

function pushNormalizedSegment(
	characters: string[],
	ranges: NormalizedCharacterRange[],
	segment: string,
	start: number,
	end: number,
): void {
	for (const character of Array.from(normalizeFuzzySegment(segment))) {
		pushNormalizedCharacter(characters, ranges, character, { start, end });
	}
}

function isTrailingFuzzyWhitespace(character: string | undefined): boolean {
	return character !== undefined && character.trimEnd() === "";
}

function trimTrailingFuzzyWhitespace(
	characters: string[],
	ranges: NormalizedCharacterRange[],
	lineStart: number,
): void {
	while (characters.length > lineStart && isTrailingFuzzyWhitespace(characters.at(-1))) {
		const removed = characters.pop()!;
		ranges.splice(ranges.length - removed.length, removed.length);
	}
}

function normalizeForFuzzyMatchWithMap(text: string): FuzzyNormalizedText {
	const characters: string[] = [];
	const ranges: NormalizedCharacterRange[] = [];
	let lineStart = 0;
	let index = 0;

	while (index < text.length) {
		if (text[index] === "\n") {
			trimTrailingFuzzyWhitespace(characters, ranges, lineStart);
			pushNormalizedCharacter(characters, ranges, "\n", { start: index, end: index + 1 });
			index++;
			lineStart = characters.length;
			continue;
		}

		const end = getFuzzySegmentEnd(text, index);
		pushNormalizedSegment(characters, ranges, text.slice(index, end), index, end);
		index = end;
	}

	trimTrailingFuzzyWhitespace(characters, ranges, lineStart);
	return { text: characters.join(""), ranges };
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
export function normalizeForFuzzyMatch(text: string): string {
	return normalizeForFuzzyMatchWithMap(text).text;
}

export interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/** Find all non-overlapping occurrences of needle in haystack. */
function findOccurrences(haystack: string, needle: string): number[] {
	const indices: number[] = [];
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		indices.push(index);
		index = haystack.indexOf(needle, index + needle.length);
	}
	return indices;
}

/** Convert character indices into 1-based line numbers. */
function lineNumbersFor(content: string, indices: number[]): number[] {
	const sorted = [...indices].sort((a, b) => a - b);
	const lines: number[] = [];
	let line = 1;
	let pos = 0;
	for (const index of sorted) {
		for (; pos < index && pos < content.length; pos++) {
			if (content.charCodeAt(pos) === 10) line++;
		}
		lines.push(line);
	}
	return lines;
}

function formatOccurrenceLines(lines: number[], max = 6): string {
	const unique = [...new Set(lines)];
	const shown = unique.slice(0, max).join(", ");
	const suffix = unique.length > max ? ", …" : "";
	const label = unique.length === 1 ? "line" : "lines";
	return `${label} ${shown}${suffix}`;
}

const CLOSEST_MATCH_MIN_SCORE = 0.5;
const CLOSEST_MATCH_MAX_TOKENS = 500_000;
const CLOSEST_MATCH_MAX_SNIPPET_LINES = 20;

/** Split text into whitespace-delimited tokens, recording each token's 1-based line. */
function tokenizeWithLines(text: string): { tokens: string[]; lines: number[] } {
	const tokens: string[] = [];
	const lines: number[] = [];
	let line = 1;
	let current = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\n" || ch === " " || ch === "\t" || ch === "\r") {
			if (current) {
				tokens.push(current);
				lines.push(line);
				current = "";
			}
			if (ch === "\n") line++;
		} else {
			current += ch;
		}
	}
	if (current) {
		tokens.push(current);
		lines.push(line);
	}
	return { tokens, lines };
}

interface ClosestMatch {
	startLine: number;
	snippet: string;
}

/**
 * Find the region of content that most closely resembles oldText, so a failed
 * edit can report what the file actually contains. Uses a sliding token-bag
 * window with Dice similarity, which tolerates re-indentation and line wrapping
 * (e.g. a formatter splitting one line across several).
 */
export function findClosestMatch(content: string, oldText: string): ClosestMatch | undefined {
	const target = tokenizeWithLines(normalizeForFuzzyMatch(oldText)).tokens;
	if (target.length === 0) {
		return undefined;
	}
	// Line numbers are stable across fuzzy normalization: it never adds or removes newlines.
	const { tokens, lines } = tokenizeWithLines(normalizeForFuzzyMatch(content));
	if (tokens.length === 0 || tokens.length > CLOSEST_MATCH_MAX_TOKENS) {
		return undefined;
	}

	const targetCounts = new Map<string, number>();
	for (const token of target) {
		targetCounts.set(token, (targetCounts.get(token) ?? 0) + 1);
	}

	// Slide a fixed-size token window across the content, tracking the multiset
	// overlap with the target incrementally so the scan is O(tokens).
	const windowSize = Math.min(target.length, tokens.length);
	const windowCounts = new Map<string, number>();
	let overlap = 0;
	const add = (token: string): void => {
		const count = (windowCounts.get(token) ?? 0) + 1;
		windowCounts.set(token, count);
		if (count <= (targetCounts.get(token) ?? 0)) overlap++;
	};
	const remove = (token: string): void => {
		const count = (windowCounts.get(token) ?? 0) - 1;
		windowCounts.set(token, count);
		if (count < (targetCounts.get(token) ?? 0)) overlap--;
	};

	for (let i = 0; i < windowSize; i++) {
		add(tokens[i]);
	}
	let bestOverlap = overlap;
	let bestStart = 0;
	for (let start = 1; start + windowSize <= tokens.length; start++) {
		remove(tokens[start - 1]);
		add(tokens[start + windowSize - 1]);
		if (overlap > bestOverlap) {
			bestOverlap = overlap;
			bestStart = start;
		}
	}

	const score = (2 * bestOverlap) / (target.length + windowSize);
	if (score < CLOSEST_MATCH_MIN_SCORE) {
		return undefined;
	}

	// Include one line of context on each side so wrapped constructs are shown whole.
	const contentLines = content.split("\n");
	const startLine = Math.max(1, lines[bestStart] - 1);
	const endLine = Math.min(
		Math.min(lines[bestStart + windowSize - 1] + 1, contentLines.length),
		startLine + CLOSEST_MATCH_MAX_SNIPPET_LINES - 1,
	);
	return { startLine, snippet: contentLines.slice(startLine - 1, endLine).join("\n") };
}

const RE_READ_HINT =
	"If the file has changed since you last read it (e.g. it was reformatted), re-read it and base oldText on the current content.";

function getNotFoundError(path: string, editIndex: number, totalEdits: number, closest?: ClosestMatch): Error {
	const base =
		totalEdits === 1
			? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
			: `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`;
	if (!closest) {
		return new Error(`${base} ${RE_READ_HINT}`);
	}
	return new Error(
		`${base}\n\nThe closest match in the file starts at line ${closest.startLine} and differs from your oldText:\n${closest.snippet}\n\n${RE_READ_HINT}`,
	);
}

function getDuplicateError(
	path: string,
	editIndex: number,
	totalEdits: number,
	occurrences: number,
	lines: number[],
): Error {
	const location = lines.length > 0 ? ` (${formatOccurrenceLines(lines)})` : "";
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}${location}. The text must be unique. Add more surrounding lines to oldText to disambiguate which occurrence to replace.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}${location}. Each oldText must be unique. Add more surrounding lines to oldText to disambiguate which occurrence to replace.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. Fuzzy matching may
 * tolerate small whitespace/Unicode differences in the targeted text, but only
 * the matched original ranges are replaced.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const baseContent = normalizedContent;
	let fuzzyContent: FuzzyNormalizedText | undefined;
	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];

		// Exact matching first: a unique exact match always wins, even when fuzzy
		// normalization would make additional regions look identical.
		const exactIndices = findOccurrences(baseContent, edit.oldText);
		if (exactIndices.length > 1) {
			throw getDuplicateError(
				path,
				i,
				normalizedEdits.length,
				exactIndices.length,
				lineNumbersFor(baseContent, exactIndices),
			);
		}
		if (exactIndices.length === 1) {
			matchedEdits.push({
				editIndex: i,
				matchIndex: exactIndices[0],
				matchLength: edit.oldText.length,
				newText: edit.newText,
			});
			continue;
		}

		// No exact match: fall back to fuzzy matching in normalized space.
		fuzzyContent ??= normalizeForFuzzyMatchWithMap(baseContent);
		const fuzzyOldText = normalizeForFuzzyMatch(edit.oldText);
		const fuzzyIndices = fuzzyOldText.length === 0 ? [] : findOccurrences(fuzzyContent.text, fuzzyOldText);
		if (fuzzyIndices.length === 0) {
			throw getNotFoundError(path, i, normalizedEdits.length, findClosestMatch(baseContent, edit.oldText));
		}
		if (fuzzyIndices.length > 1) {
			const originalIndices = fuzzyIndices
				.map((index) => fuzzyContent!.ranges[index]?.start)
				.filter((start): start is number => start !== undefined);
			throw getDuplicateError(
				path,
				i,
				normalizedEdits.length,
				fuzzyIndices.length,
				lineNumbersFor(baseContent, originalIndices),
			);
		}

		const fuzzyIndex = fuzzyIndices[0];
		const start = fuzzyContent.ranges[fuzzyIndex];
		const end = fuzzyContent.ranges[fuzzyIndex + fuzzyOldText.length - 1];
		if (!start || !end) {
			throw getNotFoundError(path, i, normalizedEdits.length, findClosestMatch(baseContent, edit.oldText));
		}
		matchedEdits.push({
			editIndex: i,
			matchIndex: start.start,
			matchLength: end.end - start.start,
			newText: edit.newText,
		});
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
}

/** Generate a standard unified patch. */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * Generate a display-oriented diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
