import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@hansjm10/volt-ai";
import { resizeImage } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeType } from "../../utils/mime.ts";
import { formatDuration } from "../tools/render-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../tools/truncate.ts";
import { encodeBridgeValue, encodedStringBytes } from "./codec.ts";
import type { CodeModeImageRef, CodeModeStoredImage } from "./images.ts";
import {
	type CodeModeScriptLimits,
	DEFAULT_CODE_MODE_POOL_OPTIONS,
	DEFAULT_CODE_MODE_SCRIPT_LIMITS,
	MAX_SCRIPT_ERROR_CHARS,
	MAX_SCRIPT_ERROR_SUMMARY_CHARS,
} from "./limits.ts";
import type {
	CodeModeCallRecord,
	CodeModeCallStatus,
	CodeModeFailure,
	CodeModeOutputItem,
	CodeModeScriptResult,
} from "./runtime.ts";

/**
 * The model-facing result of a code mode script (sections 5.10 and 5.11 of docs/code-mode-design.md): a status
 * line, the script's output stream with multi-line items fenced, the return value, and for a failure an error
 * block and a summary of the nested calls that may have changed state.
 */

/** A nested call as the result renders it: the runtime's record, the tool it called, and whether it only reads. */
export interface CodeModeRenderCall extends CodeModeCallRecord {
	/** The tool's name as the model knows it, such as `read` or `mcp__github__create_issue`. */
	tool: string;
	/** The call's arguments, for previews; absent when they are unknown. */
	args?: Record<string, unknown>;
	/** Whether the call's trusted operation resolution holds only read capabilities (section 5.11). */
	readOnly: boolean;
}

/** An image the script received, and where it came from, such as `read b.png` or `MCP browser.screenshot`. */
export interface CodeModeRenderImage {
	stored: CodeModeStoredImage;
	source: string;
}

export interface CodeModeRenderInput {
	result: CodeModeScriptResult;
	/** The script's nested calls in `seq` order: the records of `result.calls`, with what rendering needs. */
	calls: readonly CodeModeRenderCall[];
	/** Every image the script received in call results. */
	images: readonly CodeModeRenderImage[];
	/** The limits the script ran with, which failure messages name. Defaults to the default limits. */
	limits?: Partial<CodeModeScriptLimits>;
	/** The VM memory limit, which the out-of-memory hint names. Defaults to the pool's default. */
	memoryLimitBytes?: number;
	/**
	 * Whether shown images are resized to fit providers' inline limits before they reach the model, as `read` resizes
	 * the images it reads (the image auto-resize setting). Defaults to true.
	 */
	autoResizeImages?: boolean;
}

export interface CodeModeRenderedResult {
	/** What the model reads: text blocks, split around the images the script showed. */
	content: Array<TextContent | ImageContent>;
	isError: boolean;
	/** Whether anything was left out to fit the output limit. */
	truncated: boolean;
	/** The full rendering, written when anything was left out and the file could be written. */
	fullOutputPath?: string;
	/** Images that reached the model, once each, with the file each was saved to. */
	shownImages: CodeModeImageRef[];
	/** Images the script received but never passed to `image()`. */
	unshownImages: CodeModeImageRef[];
}

/** One line of the rendering. An image caption carries the image block that follows it. */
interface Line {
	text: string;
	image?: { block: ImageContent; ref: CodeModeImageRef };
}

/**
 * Lines of the rendering kept as one text, such as an output item and its fence, so that an item of many lines is
 * measured without being split. Only the lines a layout keeps are split out (`lineWindow`). A caption is a block of
 * one line that carries its image.
 */
interface Block {
	/** The lines, joined with `\n`. */
	text: string;
	size: Size;
	image?: Line["image"];
}

function blockOf(text: string, image?: Line["image"]): Block {
	let lines = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines++;
	const size = { bytes: Buffer.byteLength(text) + 1, lines };
	return image === undefined ? { text, size } : { text, size, image };
}

function blocksSize(blocks: readonly Block[]): Size {
	let bytes = 0;
	let lines = 0;
	for (const block of blocks) {
		bytes += block.size.bytes;
		lines += block.size.lines;
	}
	return { bytes, lines };
}

/** The first `count` lines of a block, or all of them. */
function headLines(block: Block, count: number): Line[] {
	if (block.image) return [{ text: block.text, image: block.image }];
	const lines: Line[] = [];
	let start = 0;
	while (lines.length < count) {
		const end = block.text.indexOf("\n", start);
		lines.push({ text: block.text.slice(start, end === -1 ? undefined : end) });
		if (end === -1) break;
		start = end + 1;
	}
	return lines;
}

/** The last `count` lines of a block, or all of them. */
function tailLines(block: Block, count: number): Line[] {
	if (block.image) return [{ text: block.text, image: block.image }];
	const lines: Line[] = [];
	let end = block.text.length;
	while (lines.length < count) {
		const start = end === 0 ? -1 : block.text.lastIndexOf("\n", end - 1);
		lines.push({ text: block.text.slice(start + 1, end) });
		if (start === -1) break;
		end = start;
	}
	return lines.reverse();
}

/** All lines of blocks small enough to split, such as a rendering or a part that fits the output limit. */
function linesOf(blocks: readonly Block[]): Line[] {
	return blocks.flatMap((block) => headLines(block, Number.POSITIVE_INFINITY));
}

/**
 * The lines of `blocks` a truncation can keep: the first and last `OUTPUT_BUDGET.lines` lines, or all lines when
 * there are at most twice that many. Lines between them are counted without being split.
 */
interface LineWindow {
	head: Line[];
	/** Lines left out between the head and the tail; 0 when the head holds every line and the tail is empty. */
	gap: number;
	tail: Line[];
}

function lineWindow(blocks: readonly Block[]): LineWindow {
	const max = OUTPUT_BUDGET.lines;
	const total = blocksSize(blocks).lines;
	if (total <= 2 * max) return { head: linesOf(blocks), gap: 0, tail: [] };
	const head: Line[] = [];
	for (let index = 0; index < blocks.length && head.length < max; index++) {
		for (const line of headLines(blocks[index], max - head.length)) head.push(line);
	}
	const tailParts: Line[][] = [];
	let tailCount = 0;
	for (let index = blocks.length - 1; index >= 0 && tailCount < max; index--) {
		const lines = tailLines(blocks[index], max - tailCount);
		tailParts.push(lines);
		tailCount += lines.length;
	}
	const tail = tailParts.reverse().flat();
	return { head, gap: total - head.length - tail.length, tail };
}

/** Images a script shows: at most 10 references (section 5.9). Unshown images are listed up to the same number. */
const MAX_LISTED_UNSHOWN_IMAGES = 10;
/** Characters of an image's source in the list of unshown images. */
const MAX_IMAGE_SOURCE_CHARS = 80;
/** Characters of an image's MIME type in its caption. */
const MAX_MIME_TYPE_CHARS = 100;

/** The parts of a rendering, in the order they appear. */
interface Sections {
	status: Line;
	/** One block for each item. */
	stream: Block[];
	/** The return value of a successful script that returned one. */
	returned: { value: unknown; block: Block } | undefined;
	/** `(no output)`, for a successful script that printed and returned nothing. */
	noOutput: Line[];
	unshown: Line[];
	/** The error block and the nested-call summary of a failed script, each after a blank line. */
	failure: Line[];
}

function textLines(text: string): Line[] {
	return text.split("\n").map((part): Line => ({ text: part }));
}

/**
 * Renders a script's result for the model. The text stays within Volt's standard tool output limit, 50 KB and
 * 2000 lines (section 5.10). When the full rendering does not fit, parts are left out by priority and the full
 * rendering is written to a temp file that the result names.
 */
export async function renderCodeModeResult(input: CodeModeRenderInput): Promise<CodeModeRenderedResult> {
	const { result } = input;
	const images = await showImages(result.output, input.images, input.autoResizeImages ?? true);
	const stream = streamBlocks(result.output, images.captions);
	let returned: Sections["returned"];
	if (result.ok && result.hasValue) {
		// Normalized once, so a truncated string return value is cut from the text its block holds.
		const value = typeof result.value === "string" ? normalizeLineBreaks(result.value) : result.value;
		returned = { value, block: returnBlock(value) };
	}
	const sections: Sections = {
		status: { text: statusLine(result, input.calls.length) },
		stream,
		returned,
		noOutput: result.ok && stream.length === 0 && returned === undefined ? [{ text: "(no output)" }] : [],
		unshown: images.unshownLine ? [images.unshownLine] : [],
		failure: result.ok
			? []
			: [
					{ text: "" },
					...textLines(errorBlock(input, result.failure, result.started)),
					{ text: "" },
					...callSummary(input.calls).map((text): Line => ({ text })),
				],
	};
	// The whole rendering, as the spill file holds it.
	const full: Block[] = [
		blockOf(sections.status.text),
		...stream,
		...(returned === undefined ? [] : [returned.block]),
		...[...sections.noOutput, ...sections.unshown, ...sections.failure].map((line) => blockOf(line.text)),
	];
	const fullSize = blocksSize(full);
	const truncated = !fits(fullSize, OUTPUT_BUDGET);
	let lines: Line[];
	let fullOutputPath: string | undefined;
	if (truncated) {
		fullOutputPath = await writeTempFile("log", full.map((block) => block.text).join("\n"));
		const marker = omissionMarker(fullSize, fullOutputPath);
		const laidOut = result.ok ? layOutSuccess(sections, marker) : layOutFailure(sections, marker);
		lines = withinBudget(laidOut, marker);
	} else lines = linesOf(full);
	return {
		content: assemble(lines),
		isError: !result.ok,
		truncated,
		...(fullOutputPath === undefined ? {} : { fullOutputPath }),
		shownImages: shownImagesOf(lines),
		unshownImages: images.unshown,
	};
}

/**
 * Sizes in what the output limit counts: each line's UTF-8 bytes plus the line break after it, and lines. The text
 * has no break after its last line, so it fits in `DEFAULT_MAX_BYTES` when the bytes are at most one more.
 */
interface Size {
	bytes: number;
	lines: number;
}

const OUTPUT_BUDGET: Size = { bytes: DEFAULT_MAX_BYTES + 1, lines: DEFAULT_MAX_LINES };

function lineCost(text: string): number {
	return Buffer.byteLength(text) + 1;
}

function sizeOf(lines: readonly Line[]): Size {
	let bytes = 0;
	for (const line of lines) bytes += lineCost(line.text);
	return { bytes, lines: lines.length };
}

function fits(size: Size, budget: Size): boolean {
	return size.bytes <= budget.bytes && size.lines <= budget.lines;
}

function minus(a: Size, b: Size): Size {
	return { bytes: a.bytes - b.bytes, lines: a.lines - b.lines };
}

/**
 * What one part may use when it shares `total` with another: up to half, or more when the other leaves room, never
 * more than it needs.
 */
function share(total: Size, own: Size, other: Size): Size {
	const part = (t: number, o: number, rest: number) => Math.min(o, Math.max(Math.floor(t / 2), t - rest));
	return { bytes: part(total.bytes, own.bytes, other.bytes), lines: part(total.lines, own.lines, other.lines) };
}

/** Builds the text of the markers that say what was left out and where the full rendering is. */
interface OmissionMarker {
	/** The marker in a truncated output stream. `omitted` counts the lines left out entirely. */
	stream(omitted: number): string;
	/** The line after a truncated return value, when the stream left nothing out and the full rendering was saved. */
	notice: Line | undefined;
	/** The marker that ends a rendering whose fixed parts did not fit by themselves. */
	end: Line;
}

function omissionMarker(fullSize: Size, path: string | undefined): OmissionMarker {
	const totals = `(${fullSize.lines} lines, ${formatSize(fullSize.bytes - 1)} total)`;
	const where = path === undefined ? "" : `. Full output: ${oneLine(path)} (read with offset/limit)`;
	return {
		stream: (omitted) =>
			`[... ${omitted > 0 ? `${plural(omitted, "line")} omitted` : "long lines shortened"} ${totals}${where}]`,
		notice: path === undefined ? undefined : { text: `[Return value truncated to fit the output limit${where}]` },
		end: { text: `[... output truncated ${totals}${where}]` },
	};
}

/**
 * Lays out a successful script's result within the budget. The status line and the list of unshown images are kept.
 * The return value may use up to half of the rest, or more when the stream leaves room; the stream uses what the
 * return value leaves. When only the return value is cut, the notice after it names the full output, and room is
 * made for it; if the stream then no longer fits, its marker names the full output instead and takes that room.
 */
function layOutSuccess(sections: Sections, marker: OmissionMarker): Line[] {
	const plain = layOutSuccessWith(sections, marker, []);
	if (marker.notice === undefined || !plain.returnCut || !plain.streamFits) return plain.lines;
	return layOutSuccessWith(sections, marker, [marker.notice]).lines;
}

/**
 * A successful script's layout with room for `notice`, which follows a cut return value when the stream fits. A cut
 * stream takes the notice's room instead.
 */
function layOutSuccessWith(
	sections: Sections,
	marker: OmissionMarker,
	notice: Line[],
): { lines: Line[]; returnCut: boolean; streamFits: boolean } {
	const room = minus(OUTPUT_BUDGET, sizeOf([sections.status, ...sections.noOutput, ...sections.unshown]));
	const available = minus(room, sizeOf(notice));
	const streamSize = blocksSize(sections.stream);
	const returnSize = sections.returned?.block.size ?? { bytes: 0, lines: 0 };
	const returnBudget = share(available, returnSize, streamSize);
	const returnCut = sections.returned !== undefined && !fits(returnSize, returnBudget);
	const returned =
		sections.returned === undefined
			? []
			: returnCut
				? truncateReturnValue(sections.returned.value, returnBudget)
				: linesOf([sections.returned.block]);
	const streamFits = fits(streamSize, minus(available, sizeOf(returned)));
	// The stream's marker names the full output in place of the notice. It reserves at least the notice's room, one
	// line and more bytes, so the stream is still cut and the marker printed.
	const stream = streamFits
		? linesOf(sections.stream)
		: truncateLines(lineWindow(sections.stream), minus(room, sizeOf(returned)), marker.stream);
	const lines = [
		sections.status,
		...stream,
		...returned,
		...(returnCut && streamFits ? notice : []),
		...sections.noOutput,
		...sections.unshown,
	];
	return { lines, returnCut, streamFits };
}

/**
 * Lays out a failed script's result within the budget: the status line, the error block, and the nested-call
 * summary are kept, and the output stream uses what they leave.
 */
function layOutFailure(sections: Sections, marker: OmissionMarker): Line[] {
	const after = [...sections.unshown, ...sections.failure];
	const streamBudget = minus(OUTPUT_BUDGET, sizeOf([sections.status, ...after]));
	const stream = fits(blocksSize(sections.stream), streamBudget)
		? linesOf(sections.stream)
		: truncateLines(lineWindow(sections.stream), streamBudget, marker.stream);
	return [sections.status, ...stream, ...after];
}

/**
 * Keeps a layout within the budget when its kept parts do not fit by themselves, such as an error block of many
 * short lines: lines are kept from the start, and the end marker follows them.
 */
function withinBudget(lines: Line[], marker: OmissionMarker): Line[] {
	if (fits(sizeOf(lines), OUTPUT_BUDGET)) return lines;
	const budget = minus(OUTPUT_BUDGET, sizeOf([marker.end]));
	const kept: Line[] = [];
	let bytes = 0;
	for (const line of lines) {
		const cost = lineCost(line.text);
		if (bytes + cost > budget.bytes || kept.length + 1 > budget.lines) break;
		kept.push(line);
		bytes += cost;
	}
	return [...kept, marker.end];
}

/**
 * Writes `data` to a new temp file only the user can read, `volt-run-code-<random>.<extension>`, and returns its
 * path, or undefined when the file could not be written. The full rendering of a truncated result and shown images
 * without a file go here. Temp files are left for the OS to clean up, as bash's are.
 */
async function writeTempFile(extension: string, data: string | Buffer): Promise<string | undefined> {
	const path = join(tmpdir(), `volt-run-code-${randomBytes(8).toString("hex")}.${extension}`);
	try {
		await writeFile(path, data, { mode: 0o600, flag: "wx" });
		return path;
	} catch {
		return undefined;
	}
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-8 bytes of the code point at `index`, and the UTF-16 units it spans. A lone surrogate becomes U+FFFD. */
function utf8CodePoint(text: string, index: number): { bytes: number; units: number } {
	const code = text.charCodeAt(index);
	if (code < 0x80) return { bytes: 1, units: 1 };
	if (code < 0x800) return { bytes: 2, units: 1 };
	if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1))) return { bytes: 4, units: 2 };
	return { bytes: 3, units: 1 };
}

/** The longest prefix of `text`, cut between code points, of at most `maxBytes` UTF-8 bytes. */
function utf8Prefix(text: string, maxBytes: number): string {
	let bytes = 0;
	let end = 0;
	while (end < text.length) {
		const point = utf8CodePoint(text, end);
		if (bytes + point.bytes > maxBytes) break;
		bytes += point.bytes;
		end += point.units;
	}
	return text.slice(0, end);
}

/** The longest suffix of `text`, cut between code points, of at most `maxBytes` UTF-8 bytes. */
function utf8Suffix(text: string, maxBytes: number): string {
	let bytes = 0;
	let start = text.length;
	while (start > 0) {
		const pair =
			start > 1 && isLowSurrogate(text.charCodeAt(start - 1)) && isHighSurrogate(text.charCodeAt(start - 2));
		const pointStart = pair ? start - 2 : start - 1;
		const point = utf8CodePoint(text, pointStart);
		if (bytes + point.bytes > maxBytes) break;
		bytes += point.bytes;
		start = pointStart;
	}
	return text.slice(start);
}

/** Keeps the head and tail of `text` around a marker that counts what was left out, in at most `maxBytes`. */
function cutMiddle(text: string, maxBytes: number): string {
	const keep = Math.max(0, maxBytes - Buffer.byteLength(`[... ${text.length} chars omitted]`));
	const head = utf8Prefix(text, Math.ceil(keep / 2));
	const tail = utf8Suffix(text.slice(head.length), keep - Buffer.byteLength(head));
	return `${head}[... ${text.length - head.length - tail.length} chars omitted]${tail}`;
}

/**
 * Keeps the head and tail of a window's lines around one marker, within `budget`. The head and the tail each get
 * half of the room the marker leaves, and either uses what the other leaves. A line longer than half that room is
 * first cut in the middle, so neither end is empty because of one long line; a lone line may use all of it. An image
 * whose caption is left out is dropped with it. The budget holds fewer lines than either side of a window's gap, so
 * the head and the tail never reach it.
 */
function truncateLines(window: LineWindow, budget: Size, marker: (omitted: number) => string): Line[] {
	const lines = [...window.head, ...window.tail];
	const total = lines.length + window.gap;
	// Sized for any count of omitted lines up to all of them, or for no line omitted.
	const reserved = Math.max(lineCost(marker(total)), lineCost(marker(0)));
	const room = { bytes: budget.bytes - reserved, lines: budget.lines - 1 };
	if (room.bytes <= 0 || room.lines <= 0) return [{ text: marker(total) }];
	// A lone line needs no room for another one.
	const maxLineBytes = (total === 1 ? room.bytes : Math.floor(room.bytes / 2)) - 1;
	let shortened = false;
	const candidates = lines.map((line): Line => {
		if (Buffer.byteLength(line.text) <= maxLineBytes) return line;
		shortened = true;
		return { ...line, text: cutMiddle(line.text, maxLineBytes) };
	});
	const costs = candidates.map((line) => lineCost(line.text));
	const half: Size = { bytes: Math.floor(room.bytes / 2), lines: Math.floor(room.lines / 2) };
	// With a gap, the head stays in the window's head and the tail in its tail.
	const headLimit = window.gap > 0 ? window.head.length : lines.length;
	const tailLimit = window.gap > 0 ? window.head.length : 0;
	let headEnd = 0;
	let head: Size = { bytes: 0, lines: 0 };
	const extendHead = (limit: Size) => {
		while (
			headEnd < Math.min(tailStart, headLimit) &&
			head.bytes + costs[headEnd] <= limit.bytes &&
			head.lines + 1 <= limit.lines
		) {
			head = { bytes: head.bytes + costs[headEnd], lines: head.lines + 1 };
			headEnd++;
		}
	};
	let tailStart = candidates.length;
	extendHead(half);
	const tailRoom = minus(room, head);
	let tail: Size = { bytes: 0, lines: 0 };
	while (
		tailStart > Math.max(headEnd, tailLimit) &&
		tail.bytes + costs[tailStart - 1] <= tailRoom.bytes &&
		tail.lines + 1 <= tailRoom.lines
	) {
		tail = { bytes: tail.bytes + costs[tailStart - 1], lines: tail.lines + 1 };
		tailStart--;
	}
	extendHead(minus(room, tail));
	const omitted = tailStart - headEnd + window.gap;
	if (omitted === 0) return shortened ? [...candidates, { text: marker(0) }] : candidates;
	return [...candidates.slice(0, headEnd), { text: marker(omitted) }, ...candidates.slice(tailStart)];
}

/** Strings keep at least this many characters when a return value is truncated structurally (section 5.10). */
const MIN_STRING_CAP = 64;
const RETURN_VALUE_LABEL = "Return value: ";

/**
 * A truncated return value within `budget`. A string keeps its head and tail; a multi-line string keeps its first
 * and last lines inside its fence. Any other value is truncated structurally, so it remains valid JSON when it can.
 */
function truncateReturnValue(value: unknown, budget: Size): Line[] {
	if (typeof value !== "string") {
		return [{ text: `${RETURN_VALUE_LABEL}${truncateJson(value, budget.bytes - lineCost(RETURN_VALUE_LABEL))}` }];
	}
	const text = withoutTrailingNewline(value);
	if (!text.includes("\n")) {
		return [{ text: `${RETURN_VALUE_LABEL}${cutMiddle(text, budget.bytes - lineCost(RETURN_VALUE_LABEL))}` }];
	}
	const body = blockOf(text);
	const header: Line = { text: fenceHeader("return value", body.size.lines) };
	const footer: Line = { text: FENCE_END };
	const inner = minus(budget, sizeOf([header, footer]));
	const marker = (omitted: number) =>
		`[... ${omitted > 0 ? `${plural(omitted, "line")} omitted` : "long lines shortened"}]`;
	return [header, ...truncateLines(lineWindow([body]), inner, marker), footer];
}

/** A capped copy of a value, and the UTF-8 bytes of its compact JSON as the codec writes it. */
interface Capped {
	value: unknown;
	bytes: number;
}

/**
 * A copy of `value` with strings longer than `stringCap` and arrays longer than `arrayCap` cut, with markers, and its
 * size. A marker replaces what it stands for only when that makes the JSON shorter, so the JSON of a value never gets
 * shorter as either cap grows: each element or character a larger cap keeps takes at least one byte, more than the
 * marker's count can lose by having one digit fewer. The items an array leaves out are capped only until they take
 * more bytes than its marker, which settles that the marker replaces them, so a cap costs what it keeps, not the whole
 * array.
 */
function capValue(value: unknown, stringCap: number, arrayCap: number): Capped {
	if (typeof value === "string") {
		const whole: Capped = { value, bytes: encodedStringBytes(value) + 2 };
		if (value.length <= stringCap) return whole;
		const end = isHighSurrogate(value.charCodeAt(stringCap - 1)) ? stringCap - 1 : stringCap;
		const capped = `${value.slice(0, end)}... [${value.length - end} more chars]`;
		const bytes = encodedStringBytes(capped) + 2;
		return bytes < whole.bytes ? { value: capped, bytes } : whole;
	}
	if (Array.isArray(value)) {
		const kept = Math.min(value.length, arrayCap);
		const items: Capped[] = [];
		// The brackets, and each kept item with the comma before the next item or the marker.
		let keptBytes = 2;
		for (let index = 0; index < kept; index++) {
			const item = capValue(value[index], stringCap, arrayCap);
			items.push(item);
			keptBytes += item.bytes + 1;
		}
		if (value.length > kept) {
			const marker = `[${value.length - kept} more items]`;
			const markerBytes = encodedStringBytes(marker) + 2;
			// The items left out, each with a comma. The marker shortens the JSON once they take more than it and its
			// comma, the whole array having one comma too many; later items only add to them.
			let restBytes = 0;
			for (let index = kept; index < value.length; index++) {
				const item = capValue(value[index], stringCap, arrayCap);
				items.push(item);
				restBytes += item.bytes + 1;
				if (restBytes > markerBytes + 1) {
					const shown = items.slice(0, kept).map((entry) => entry.value);
					shown.push(marker);
					return { value: shown, bytes: keptBytes + markerBytes };
				}
			}
			return { value: items.map((item) => item.value), bytes: keptBytes + restBytes - 1 };
		}
		// One comma too many unless the array is empty.
		return { value: items.map((item) => item.value), bytes: items.length > 0 ? keptBytes - 1 : keptBytes };
	}
	if (value !== null && typeof value === "object") {
		const entries: Array<[string, unknown]> = [];
		// The braces, and each property with a comma, one comma too many unless there is none.
		let bytes = 2;
		let written = 0;
		for (const [key, item] of Object.entries(value)) {
			const capped = capValue(item, stringCap, arrayCap);
			entries.push([key, capped.value]);
			// The codec leaves out properties holding undefined.
			if (item === undefined) continue;
			bytes += encodedStringBytes(key) + 2 + 1 + capped.bytes + 1;
			written++;
		}
		if (written > 0) bytes--;
		return { value: Object.fromEntries(entries), bytes };
	}
	const text =
		typeof value === "number"
			? numberText(value)
			: typeof value === "bigint" || typeof value === "boolean"
				? String(value)
				: "null";
	return { value, bytes: text.length };
}

/** The length of the longest string and the longest array in `value`. */
function longest(value: unknown): { string: number; array: number } {
	const found = { string: 0, array: 0 };
	const visit = (item: unknown): void => {
		if (typeof item === "string") found.string = Math.max(found.string, item.length);
		else if (Array.isArray(item)) {
			found.array = Math.max(found.array, item.length);
			for (const element of item) visit(element);
		} else if (item !== null && typeof item === "object") for (const entry of Object.values(item)) visit(entry);
	};
	visit(value);
	return found;
}

/**
 * The largest cap in `[low, high]` for which `attempt` returns text, and that text, assuming larger caps never
 * produce shorter text, which `capValue` ensures. Undefined when even `low` does not fit, and so no cap does.
 */
function largestFitting(low: number, high: number, attempt: (cap: number) => string | undefined): string | undefined {
	let best = attempt(low);
	if (best === undefined) return undefined;
	let fitting = low;
	let failing = high + 1;
	while (failing - fitting > 1) {
		const cap = fitting + Math.floor((failing - fitting) / 2);
		const text = attempt(cap);
		if (text === undefined) failing = cap;
		else {
			best = text;
			fitting = cap;
		}
	}
	return best;
}

/**
 * Compact JSON of `value` in at most `maxBytes` (section 5.10). Strings are capped to one length, the largest that
 * fits but at least 64 characters, with `... [N more chars]` markers. If that is not enough, strings stay at 64 and
 * arrays are capped to one length, with a `"[N more items]"` element. Either way the text is valid JSON. Only when
 * neither fits, such as an object with too many keys, is the text cut, which leaves it incomplete.
 */
function truncateJson(value: unknown, maxBytes: number): string {
	const attempt = (stringCap: number, arrayCap: number) => {
		const capped = capValue(value, stringCap, arrayCap);
		if (capped.bytes > maxBytes) return undefined;
		const text = returnValueJson(capped.value);
		return Buffer.byteLength(text) <= maxBytes ? text : undefined;
	};
	const sizes = longest(value);
	const byStrings = largestFitting(MIN_STRING_CAP, Math.max(MIN_STRING_CAP, Math.min(sizes.string, maxBytes)), (cap) =>
		attempt(cap, Number.POSITIVE_INFINITY),
	);
	if (byStrings !== undefined) return byStrings;
	const byArrays = largestFitting(0, Math.min(sizes.array, maxBytes), (cap) => attempt(MIN_STRING_CAP, cap));
	if (byArrays !== undefined) return byArrays;
	const text = returnValueJson(capValue(value, MIN_STRING_CAP, Number.POSITIVE_INFINITY).value);
	const head = utf8Prefix(text, maxBytes - Buffer.byteLength(`... [${text.length} more chars]`));
	return `${head}... [${text.length - head.length} more chars]`;
}

const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/g;

/** Writes line breaks as `\n`, so text from a tool, a server, or a script cannot start lines of its own. */
function oneLine(text: string): string {
	return text.replace(LINE_BREAKS, "\\n");
}

/** Keeps `text` within `maxChars`, the `...` marker included, without splitting a surrogate pair. */
function capChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	let end = Math.max(0, maxChars - 3);
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return `${text.slice(0, end)}...`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A limit as a duration: whole seconds when it is a whole number of seconds (`30s`, `1m`), tenths otherwise. */
function formatLimit(ms: number): string {
	return formatDuration(ms, { wholeSeconds: ms % 1000 === 0 });
}

/** Characters of an error's name in a status line, as the runtime bounds it. */
const MAX_STATUS_ERROR_NAME_CHARS = 128;

/** How a failed script's status line ends, naming the kind of failure (section 5.11). */
function failureEnding(failure: CodeModeFailure): string {
	switch (failure.kind) {
		case "script_error":
			if (failure.stalled) return "stalled";
			if (failure.phase === "evaluate" && failure.error.name === "SyntaxError") return "syntax error";
			return `uncaught ${capChars(oneLine(failure.error.name), MAX_STATUS_ERROR_NAME_CHARS)}`;
		case "compute_budget":
			return `compute budget of ${formatLimit(failure.budgetMs)} exhausted`;
		case "call_budget":
			return `call budget of ${failure.budget} exhausted`;
		case "timeout":
			return `timed out after ${formatLimit(failure.timeoutMs)}`;
		case "aborted":
			return "aborted";
		case "output_limit":
			return "output limit exceeded";
		case "sandbox":
			return "sandbox failure";
	}
}

const MIB = 1024 * 1024;

function formatMemory(bytes: number): string {
	return bytes % MIB === 0 ? `${bytes / MIB} MiB` : formatSize(bytes);
}

/** A count as `16 Mi` when it is a whole number of mebi, and with thousands separators otherwise. */
function formatCount(count: number): string {
	return count % MIB === 0 ? `${count / MIB} Mi` : String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A host-supplied reason on one bounded line, without a final period, for a sentence to end. */
function reasonText(reason: string): string {
	return capChars(oneLine(reason), MAX_SCRIPT_ERROR_SUMMARY_CHARS).replace(/\.$/, "");
}

/**
 * The error block of a failed script (section 5.11): a script error with its stack, or one sentence naming the
 * limit that ended the script and what to do next. A script that never started says so; it consumed no budget.
 */
function errorBlock(input: CodeModeRenderInput, failure: CodeModeFailure, started: boolean): string {
	const limits = { ...DEFAULT_CODE_MODE_SCRIPT_LIMITS, ...input.limits };
	switch (failure.kind) {
		case "script_error": {
			let text = normalizeLineBreaks(failure.error.text);
			if (failure.error.outOfMemory) {
				const memory = formatMemory(input.memoryLimitBytes ?? DEFAULT_CODE_MODE_POOL_OPTIONS.memoryLimitBytes);
				const hint = `The script exceeded its memory limit (${memory}). Filter or aggregate data instead of accumulating it.`;
				text = `${capChars(text, MAX_SCRIPT_ERROR_CHARS - hint.length - 1)}\n${hint}`;
			}
			return started ? text : `The script did not start.\n${text}`;
		}
		case "compute_budget":
			return `The script computed for more than ${formatLimit(failure.budgetMs)} without waiting on a tool. Process less data per script, or move heavy work into tools.`;
		case "call_budget":
			return `Call ${failure.budget + 1} was not made. The script may loop without end; check loop termination, or split the work into several scripts.`;
		case "timeout":
			return started
				? `The script's timeoutMs of ${failure.timeoutMs} passed. Nested calls in flight were cancelled.`
				: `The script did not start. Its timeoutMs of ${failure.timeoutMs} passed while it waited for the sandbox.`;
		case "aborted":
			return started
				? "The script was aborted. Nested calls in flight were cancelled."
				: "The script did not start. It was aborted while it waited for the sandbox.";
		case "output_limit":
			return outputLimitSentence(failure.cause, limits);
		case "sandbox": {
			const reason = reasonText(failure.reason);
			if (!started) return `The script did not start. The sandbox could not run it: ${reason}.`;
			const calls = input.calls.length > 0 ? " Calls listed below may have taken effect." : "";
			return `The sandbox failed: ${reason}.${calls}`;
		}
	}
}

/** The error block of an output-limit failure, naming the limit the script exceeded. */
function outputLimitSentence(
	cause: Extract<CodeModeFailure, { kind: "output_limit" }>["cause"],
	limits: CodeModeScriptLimits,
): string {
	switch (cause) {
		case "retained_output":
			return `The script printed more than ${formatCount(limits.maxRetainedOutputChars)} characters or ${formatCount(limits.maxOutputItems)} items. Print summaries and return selected fields instead of whole results.`;
		case "output_item":
			return `An output item was larger than the ${formatMemory(limits.maxFrameBytes)} message limit. Print summaries and return selected fields instead of whole results.`;
		case "return_value":
			return `The return value was larger than the ${formatMemory(limits.maxFrameBytes)} message limit. Return selected fields instead of whole results.`;
	}
}

/** State-changing calls a failure summary lists; the totals stay exact (section 5.11). */
const MAX_SUMMARY_ENTRIES = 20;
/** Read-only tools a failure summary names. */
const MAX_SUMMARY_READ_ONLY_TOOLS = 20;
const MAX_SUMMARY_ARGS_CHARS = 120;
const MAX_SUMMARY_ERROR_CHARS = 120;
const MAX_SUMMARY_TOOL_CHARS = 80;

function toolLabel(tool: string): string {
	return capChars(oneLine(tool), MAX_SUMMARY_TOOL_CHARS);
}

/** What became of a state-changing call, as a failure summary lists it. */
function callOutcome(call: CodeModeRenderCall): string {
	switch (call.status) {
		case "completed":
			return "completed";
		case "unsettled":
			return "still running when stopped; may have applied";
		case "cancelled":
			return call.error?.reason === "not_started"
				? "cancelled before it ran"
				: "cancelled while running; may have applied";
		case "failed": {
			const kind = call.error?.kind;
			const label = kind === "blocked" ? "blocked" : kind === "invalid_arguments" ? "invalid arguments" : "failed";
			return `${label}: ${capChars(oneLine(call.error?.message ?? "unknown error"), MAX_SUMMARY_ERROR_CHARS)}`;
		}
	}
}

/**
 * The nested-call summary of a failed script (section 5.11): exact totals, read-only calls collapsed per tool, and
 * every other call listed with an argument preview and what became of it, since it may have changed state.
 */
function callSummary(calls: readonly CodeModeRenderCall[]): string[] {
	if (calls.length === 0) return ["No tool calls were made."];
	const totals: Record<CodeModeCallStatus, number> = { completed: 0, failed: 0, cancelled: 0, unsettled: 0 };
	for (const call of calls) totals[call.status]++;
	const counts = [
		totals.completed > 0 ? `${totals.completed} completed` : "",
		totals.failed > 0 ? `${totals.failed} failed` : "",
		totals.cancelled > 0 ? `${totals.cancelled} cancelled` : "",
		totals.unsettled > 0 ? `${totals.unsettled} may have applied` : "",
	].filter((count) => count !== "");
	const undone = totals.completed > 0 ? " Completed calls were not undone." : "";
	const lines = [`Nested tool calls: ${calls.length} (${counts.join(", ")}).${undone}`];

	const readOnly = new Map<string, Record<CodeModeCallStatus, number>>();
	for (const call of calls) {
		if (!call.readOnly) continue;
		// Grouped by name, not by label: distinct long names can share a shortened label.
		let group = readOnly.get(call.tool);
		if (!group) {
			group = { completed: 0, failed: 0, cancelled: 0, unsettled: 0 };
			readOnly.set(call.tool, group);
		}
		group[call.status]++;
	}
	if (readOnly.size > 0) {
		const groups = [...readOnly].slice(0, MAX_SUMMARY_READ_ONLY_TOOLS).map(([tool, group]) => {
			const count = group.completed + group.failed + group.cancelled + group.unsettled;
			const notes = [
				group.failed > 0 ? `${group.failed} failed` : "",
				group.cancelled > 0 ? `${group.cancelled} cancelled` : "",
				group.unsettled > 0 ? `${group.unsettled} still running` : "",
			].filter((note) => note !== "");
			return `${toolLabel(tool)} \u00d7${count}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
		});
		const more = readOnly.size - groups.length;
		lines.push(`Read-only: ${groups.join(", ")}${more > 0 ? `, and ${plural(more, "more tool")}` : ""}`);
	}

	const changing = calls.filter((call) => !call.readOnly);
	if (changing.length > 0) {
		lines.push("May have changed state:");
		for (const call of changing.slice(0, MAX_SUMMARY_ENTRIES)) {
			const preview = call.args === undefined ? "" : previewCodeModeArgs(call.args, MAX_SUMMARY_ARGS_CHARS);
			lines.push(`- ${toolLabel(call.tool)}${preview === "" ? "" : ` ${preview}`}: ${callOutcome(call)}`);
		}
		if (changing.length > MAX_SUMMARY_ENTRIES)
			lines.push(`(${changing.length - MAX_SUMMARY_ENTRIES} more not shown)`);
	}
	return lines;
}

function statusLine(result: CodeModeScriptResult, calls: number): string {
	const duration = formatDuration(result.durationMs);
	const counts = plural(calls, "tool call");
	return result.ok
		? `Script completed in ${duration} (${counts})`
		: `Script failed after ${duration} (${counts}): ${failureEnding(result.failure)}`;
}

/** Strings an argument preview shows in full; longer strings show only their length (section 5.11). */
const MAX_PREVIEW_STRING_CHARS = 60;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const JSON_LINE_SEPARATORS = /[\u2028\u2029]/g;

/** JSON text of a string. `JSON.stringify` escapes `\n` and `\r` but not U+2028 and U+2029, which this escapes too. */
function jsonString(text: string): string {
	return JSON.stringify(text).replace(JSON_LINE_SEPARATORS, (separator) =>
		separator === "\u2028" ? "\\u2028" : "\\u2029",
	);
}

function numberText(value: number): string {
	if (Object.is(value, -0)) return "-0";
	if (Number.isInteger(value) && Math.abs(value) >= 2 ** 53) return BigInt(value).toString();
	return Number.isFinite(value) ? String(value) : "null";
}

/** Compact JSON of `value`, which stops growing once it is longer than `limit`. */
function boundedJson(value: unknown, limit: number): string {
	let text = "";
	const write = (item: unknown): void => {
		if (text.length > limit) return;
		if (typeof item === "string") text += jsonString(item.length > limit ? item.slice(0, limit + 1) : item);
		else if (typeof item === "number") text += numberText(item);
		else if (typeof item === "bigint") text += item.toString();
		else if (typeof item === "boolean") text += String(item);
		else if (Array.isArray(item)) {
			text += "[";
			for (let index = 0; index < item.length && text.length <= limit; index++) {
				if (index > 0) text += ",";
				write(item[index]);
			}
			text += "]";
		} else if (item !== null && typeof item === "object") {
			text += "{";
			let first = true;
			for (const [key, entry] of Object.entries(item)) {
				if (text.length > limit) break;
				if (entry === undefined) continue;
				text += `${first ? "" : ","}${jsonString(key)}:`;
				first = false;
				write(entry);
			}
			text += "}";
		} else text += "null";
	};
	write(value);
	return text;
}

/**
 * A one-line preview of a nested call's arguments, at most `maxChars` long (section 5.11): `key=value` pairs, with
 * strings of up to 60 characters in full, longer strings as `<1470 chars>`, and other values as compact JSON.
 */
export function previewCodeModeArgs(args: Record<string, unknown>, maxChars: number): string {
	let text = "";
	for (const [key, value] of Object.entries(args)) {
		if (text.length > maxChars) break;
		if (value === undefined) continue;
		const name = IDENTIFIER.test(key) ? key : jsonString(key.length > maxChars ? key.slice(0, maxChars + 1) : key);
		const shown =
			typeof value === "string"
				? value.length <= MAX_PREVIEW_STRING_CHARS
					? jsonString(value)
					: `<${value.length} chars>`
				: boundedJson(value, maxChars);
		text += `${text === "" ? "" : " "}${name}=${shown}`;
	}
	return capChars(text, maxChars);
}

const OTHER_LINE_BREAKS = /\r\n?|[\u2028\u2029]/g;

/**
 * Writes `\r\n`, a lone `\r`, U+2028, and U+2029 as `\n`, the only line break the rendering splits lines on, so text
 * from Windows tools, progress output, or a script is counted and fenced by the lines it shows and leaves no other
 * line breaks behind.
 */
function normalizeLineBreaks(text: string): string {
	return text.replace(OTHER_LINE_BREAKS, "\n");
}

/** Drops one trailing line break, which `console.log` habits and command output often end with. */
function withoutTrailingNewline(text: string): string {
	return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/**
 * The block of one item: the item itself when it is one line, or its lines fenced with a header that counts them,
 * so the end of the item is unambiguous even when it contains the closing fence.
 */
function itemBlock(text: string, label: string): Block {
	const block = blockOf(text);
	if (block.size.lines === 1) return block;
	return blockOf(`${fenceHeader(label, block.size.lines)}\n${text}\n${FENCE_END}`);
}

function fenceHeader(label: string, lines: number): string {
	return `<<< ${label}, ${lines} lines`;
}

const FENCE_END = ">>>";

interface ShownImages {
	/** The caption of each image the script showed, carrying its image block. */
	captions: ReadonlyMap<string, Block>;
	unshown: CodeModeImageRef[];
	unshownLine: Line | undefined;
}

/**
 * Extensions of saved images by MIME type. Only the first four formats can reach the model; the others name the file
 * of an image declared as one of them, which is saved but not shown. Any other type is saved as `.bin`.
 */
const IMAGE_EXTENSIONS = new Map([
	["image/png", "png"],
	["image/jpeg", "jpg"],
	["image/gif", "gif"],
	["image/webp", "webp"],
	["image/svg+xml", "svg"],
	["image/bmp", "bmp"],
	["image/tiff", "tiff"],
	["image/avif", "avif"],
	["image/heic", "heic"],
	["image/x-icon", "ico"],
	["image/vnd.microsoft.icon", "ico"],
]);

function dimensions(width: number | undefined, height: number | undefined): string {
	return width !== undefined && height !== undefined ? ` ${width}x${height}` : "";
}

/**
 * What reaches the model for a shown image: an image block and the size it is shown at, or why it is not shown. Only
 * PNG, JPEG, GIF, and WebP reach the model, as with `read`, and only within the inline limits that `resizeImage`
 * keeps images to, unless resizing is off.
 */
type ModelImage = { block: ImageContent; size: string } | { notShown: string };

async function modelImage(
	stored: CodeModeStoredImage,
	bytes: Buffer,
	format: string | null,
	autoResizeImages: boolean,
): Promise<ModelImage> {
	if (format === null) return { notShown: "not a PNG, JPEG, GIF, or WebP image" };
	if (!autoResizeImages) {
		return {
			block: { type: "image", data: stored.data, mimeType: format },
			size: dimensions(stored.ref.width, stored.ref.height),
		};
	}
	const resized = await resizeImage(bytes, format);
	if (!resized) {
		return {
			notShown:
				format === "image/webp"
					? "WebP exceeds the inline limits and Volt does not include a local WebP resize codec"
					: "it could not be resized below the inline image size limit",
		};
	}
	const from = resized.wasResized ? ` (resized from ${resized.originalWidth}x${resized.originalHeight})` : "";
	return {
		block: { type: "image", data: resized.data, mimeType: resized.mimeType },
		size: `${dimensions(resized.width, resized.height)}${from}`,
	};
}

/**
 * Prepares the images the script passed to `image()`: a caption for each, with the image block the model receives or
 * why it receives none, saving those without a file to temp files, and the line listing the images it received but
 * never showed.
 */
async function showImages(
	output: readonly CodeModeOutputItem[],
	received: readonly CodeModeRenderImage[],
	autoResizeImages: boolean,
): Promise<ShownImages> {
	const byRef = new Map(received.map((image) => [image.stored.ref.ref, image]));
	const captions = new Map<string, Block>();
	for (const item of output) {
		if (item.type !== "image" || captions.has(item.ref)) continue;
		const image = byRef.get(item.ref);
		if (!image) {
			captions.set(item.ref, blockOf(`[image ${oneLine(item.ref)}: unavailable]`));
			continue;
		}
		const { stored } = image;
		const bytes = Buffer.from(stored.data, "base64");
		// The format the bytes hold, which a declared MIME type may misstate.
		const format = detectSupportedImageMimeType(bytes);
		// An image without a file (from MCP) is saved as it came, so a later turn can pass it to tools that take image
		// paths.
		const declaredType = stored.ref.mimeType.split(";")[0].trim().toLowerCase();
		const extension = IMAGE_EXTENSIONS.get(format ?? declaredType) ?? "bin";
		const path = stored.ref.path ?? (await writeTempFile(extension, bytes));
		const ref: CodeModeImageRef = path === undefined ? { ...stored.ref } : { ...stored.ref, path };
		const where = path === undefined ? "" : `, ${oneLine(path)}`;
		const shown = await modelImage(stored, bytes, format, autoResizeImages);
		if ("block" in shown) {
			captions.set(
				item.ref,
				blockOf(`[image ${ref.ref}: ${shown.block.mimeType}${shown.size}${where}]`, { block: shown.block, ref }),
			);
			continue;
		}
		const declared = `${capChars(oneLine(ref.mimeType), MAX_MIME_TYPE_CHARS)}${dimensions(ref.width, ref.height)}`;
		captions.set(item.ref, blockOf(`[image ${ref.ref}: ${declared}${where}; not shown: ${shown.notShown}]`));
	}
	const unshownImages = received.filter((image) => !captions.has(image.stored.ref.ref));
	const unshown = unshownImages.map((image) => ({ ...image.stored.ref }));
	if (unshownImages.length === 0) return { captions, unshown, unshownLine: undefined };
	const listed = unshownImages
		.slice(0, MAX_LISTED_UNSHOWN_IMAGES)
		.map((image) => `${image.stored.ref.ref} (${capChars(oneLine(image.source), MAX_IMAGE_SOURCE_CHARS)})`);
	const more = unshownImages.length - listed.length;
	const list = more > 0 ? `${listed.join(", ")}, and ${more} more` : listed.join(", ");
	return {
		captions,
		unshown,
		unshownLine: { text: `${plural(unshownImages.length, "image")} not shown: ${list}` },
	};
}

/** The images that reach the model, once each. */
function shownImagesOf(lines: readonly Line[]): CodeModeImageRef[] {
	const shown = new Map<string, CodeModeImageRef>();
	for (const line of lines) if (line.image) shown.set(line.image.ref.ref, line.image.ref);
	return [...shown.values()];
}

/** The output stream in the order the script produced it, one block per item, numbered from 1, images included. */
function streamBlocks(output: readonly CodeModeOutputItem[], captions: ReadonlyMap<string, Block>): Block[] {
	const blocks: Block[] = [];
	for (let index = 0; index < output.length; index++) {
		const item = output[index];
		if (item.type === "image") {
			const caption = captions.get(item.ref);
			if (caption) blocks.push(caption);
			continue;
		}
		const prefix =
			item.type === "console" && (item.level === "warn" || item.level === "error") ? `${item.level}: ` : "";
		blocks.push(
			itemBlock(`${prefix}${withoutTrailingNewline(normalizeLineBreaks(item.text))}`, `output #${index + 1}`),
		);
	}
	return blocks;
}

/**
 * A string return value as text with one trailing line break dropped, as items are, and any other value as compact
 * JSON with exact numbers. A string with no text left renders as JSON, so `""` and `"\n"` stay distinct.
 */
function returnBlock(value: unknown): Block {
	if (typeof value === "string") {
		const text = withoutTrailingNewline(value);
		if (text.includes("\n")) return itemBlock(text, "return value");
		return blockOf(`${RETURN_VALUE_LABEL}${text === "" ? jsonString(value) : text}`);
	}
	return blockOf(`${RETURN_VALUE_LABEL}${returnValueJson(value)}`);
}

function returnValueJson(value: unknown): string {
	try {
		return encodeBridgeValue(value, "return value");
	} catch {
		// The runtime decoded the value with the codec, so it always encodes; a value from elsewhere might not.
		return "[unprintable value]";
	}
}

/**
 * Joins lines into text blocks, split after each image caption so the image follows it. Providers that join text
 * blocks with newlines read the same text as the lines joined.
 */
function assemble(lines: readonly Line[]): Array<TextContent | ImageContent> {
	const content: Array<TextContent | ImageContent> = [];
	let pending: string[] = [];
	for (const line of lines) {
		pending.push(line.text);
		if (line.image) {
			content.push({ type: "text", text: pending.join("\n") });
			content.push(line.image.block);
			pending = [];
		}
	}
	if (pending.length > 0) content.push({ type: "text", text: pending.join("\n") });
	return content;
}
