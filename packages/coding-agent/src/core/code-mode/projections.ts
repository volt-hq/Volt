import { open } from "node:fs/promises";
import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import type { ImageContent, TextContent } from "@hansjm10/volt-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { contentPartToText } from "../mcp/manager.ts";
import { bashExitStatus } from "../tools/bash.ts";
import { resolveReadPathAsync } from "../tools/path-utils.ts";
import { encodeBridgeValue, encodedPrefix, encodedStringBytes, encodedSuffix } from "./codec.ts";
import type { CodeModeCallImages, CodeModeImageInput } from "./images.ts";
import { CodeModeCallError } from "./runtime.ts";

/**
 * Script values of nested calls (section 5.9 of docs/code-mode-design.md). A projection turns a tool's result
 * into the value the script's call resolves with, or rejects the call with a `CodeModeCallError`. Projections are
 * internal to built-in tools and MCP; any other tool gets the default.
 */

export interface CodeModeProjectionContext {
	/** The session's working directory, against which file arguments resolve. */
	cwd: string;
	/** Where the value's images go (`CodeModeCall.images`); the value carries their references. */
	images: CodeModeCallImages;
	/** UTF-8 bytes the encoded value may take (`CodeModeCall.maxValueBytes`); bash output is cut to fit. */
	maxValueBytes: number;
}

/** A tool that ran, and whether it is the trusted built-in tool of that name. */
export interface CodeModeProjectedTool {
	name: string;
	trustedBuiltin: boolean;
}

/** A finished tool call's result, as the tool returned it and as the tool-result policy left it. */
export interface CodeModeToolResults {
	/** The result the tool returned. */
	executed: AgentToolResult<unknown>;
	/**
	 * What the tool-result policy returned: the result as `tool_result` hooks left it, or undefined when no hook
	 * saw the result. A value never holds what a hook did not see, such as the rest of a full output file.
	 */
	reviewed: AgentToolResult<unknown> | undefined;
}

/**
 * The script value of a finished built-in, extension, or SDK tool call:
 *
 * - bash: `{ output, exitCode, truncated, fullOutputPath? }` for a command that ran, whatever its exit code.
 * - read: the text of a text file, or a reference to an image file.
 * - image_gen: a reference to the generated image and the file it was saved to.
 * - any other tool: the text blocks of the result, joined with newlines.
 *
 * An error result rejects with `failed` and the result's text, except a bash command that ran.
 */
export async function projectToolResult(
	tool: CodeModeProjectedTool,
	args: Record<string, unknown>,
	results: CodeModeToolResults,
	context: CodeModeProjectionContext,
): Promise<unknown> {
	if (tool.trustedBuiltin && tool.name === "bash") return projectBash(results, context);
	const result = results.reviewed ?? results.executed;
	if (result.isError) throw failedCall(textOf(result.content));
	if (tool.trustedBuiltin && (tool.name === "read" || tool.name === "image_gen")) {
		const image = result.content.find((part): part is ImageContent => part.type === "image");
		if (image) {
			const path =
				tool.name === "read" ? await readPath(args, context.cwd) : stringField(result.details, "outputPath");
			const [ref] = context.images.add([
				{ data: image.data, mimeType: image.mimeType, ...(path === undefined ? {} : { path }) },
			]);
			return ref;
		}
	}
	return textOf(result.content);
}

/**
 * The script value of an MCP tool call: `{ text, structured?, images }`. `text` joins the blocks other than
 * images as the gateway renders them for the model, `structured` is the result's structured content, and
 * `images` holds references to its image blocks. An error result rejects with `failed` and its text.
 */
export function projectMcpResult(result: CallToolResult, context: CodeModeProjectionContext): unknown {
	const parts: unknown[] = Array.isArray(result.content) ? result.content : [];
	const images: CodeModeImageInput[] = [];
	const texts: string[] = [];
	for (const part of parts) {
		const image = mcpImage(part);
		if (image) images.push(image);
		else {
			const text = contentPartToText(part);
			if (text !== undefined) texts.push(text);
		}
	}
	const text = texts.join("\n");
	// An error result retains none of its images.
	if (result.isError) throw failedCall(text);
	const refs = context.images.add(images);
	return {
		text,
		...(result.structuredContent === undefined ? {} : { structured: result.structuredContent }),
		images: refs,
	};
}

function failedCall(text: string): CodeModeCallError {
	return new CodeModeCallError("failed", text === "" ? "the tool failed without a message" : text);
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function recordOf(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown, key: string): string | undefined {
	const field = recordOf(value)[key];
	return typeof field === "string" ? field : undefined;
}

async function readPath(args: Record<string, unknown>, cwd: string): Promise<string | undefined> {
	return typeof args.path === "string" ? resolveReadPathAsync(args.path, cwd) : undefined;
}

function mcpImage(part: unknown): CodeModeImageInput | undefined {
	if (part === null || typeof part !== "object") return undefined;
	const { type, data, mimeType } = part as Record<string, unknown>;
	return type === "image" && typeof data === "string" && typeof mimeType === "string" ? { data, mimeType } : undefined;
}

/** Command output in a bash value, and whether it is incomplete. */
interface BoundedOutput {
	text: string;
	truncated: boolean;
}

/**
 * The bash value. The exit code comes from the result's details, present only for a command that ran to
 * completion; anything else rejects with the result's text. When no hook saw the result, output the model saw
 * truncated is read from the full output file; a reviewed result gives the text the hooks left. Output that does
 * not fit the value's limit keeps its head and tail around a marker. `truncated` says whether `output` is
 * incomplete.
 */
async function projectBash(results: CodeModeToolResults, context: CodeModeProjectionContext): Promise<unknown> {
	const reviewed = results.reviewed !== undefined;
	const result = results.reviewed ?? results.executed;
	const details = recordOf(result.details);
	const exitCode = details.exitCode;
	const text = textOf(result.content);
	if (typeof exitCode !== "number" && exitCode !== null) throw failedCall(text);
	const modelTruncated = recordOf(details.truncation).truncated === true;
	// A hook saw only the result's text, never the file.
	const fullOutputPath = !reviewed && typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;
	const path = fullOutputPath === undefined ? {} : { fullOutputPath };
	// Bytes left for `output` once the rest of the value is encoded, counting the longer `truncated` literal.
	const room =
		context.maxValueBytes -
		Buffer.byteLength(encodeBridgeValue({ output: "", exitCode, truncated: false, ...path }, "result"));
	let output: BoundedOutput | undefined;
	if (modelTruncated && fullOutputPath !== undefined) {
		output = await readBounded(fullOutputPath, room).catch(() => undefined);
	}
	output ??= boundText(reviewed ? text : commandOutput(text, exitCode, details), modelTruncated, room, fullOutputPath);
	return { output: output.text, exitCode, truncated: output.truncated, ...path };
}

/**
 * The command's output from bash's own result text: without the status line bash appends for a non-zero exit,
 * and empty for a command that printed nothing.
 */
function commandOutput(text: string, exitCode: number | null, details: Record<string, unknown>): string {
	if (details.noOutput === true) return "";
	if (exitCode !== null && exitCode !== 0) {
		const status = `\n\n${bashExitStatus(exitCode)}`;
		if (text.endsWith(status)) return text.slice(0, -status.length);
	}
	return text;
}

/** `text` when it fits `room` bytes of bridge text, or its head and tail around a marker. */
function boundText(text: string, truncated: boolean, room: number, path: string | undefined): BoundedOutput {
	if (encodedStringBytes(text) <= room) return { text, truncated };
	return { text: headAndTail(text, text, Buffer.byteLength(text), room, path), truncated: true };
}

/** The full output file's text, or its head and tail around a marker when it does not fit `room`. */
async function readBounded(path: string, room: number): Promise<BoundedOutput> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		// Every byte of the file takes at least one byte of bridge text, so only a file within `room` can fit.
		if (size <= room) {
			const whole = Buffer.alloc(size);
			const { bytesRead } = await file.read(whole, 0, size, 0);
			return boundText(whole.subarray(0, bytesRead).toString("utf8"), false, room, path);
		}
		const [headRoom, tailRoom] = splitRoom(size, room, path);
		const head = Buffer.alloc(headRoom);
		const tail = Buffer.alloc(tailRoom);
		const headRead = await file.read(head, 0, headRoom, 0);
		const tailRead = await file.read(tail, 0, tailRoom, size - tailRoom);
		const headText = wholeCharactersAtStart(head.subarray(0, headRead.bytesRead)).toString("utf8");
		const tailText = wholeCharactersAtEnd(tail.subarray(0, tailRead.bytesRead)).toString("utf8");
		return { text: headAndTail(headText, tailText, size, room, path), truncated: true };
	} finally {
		await file.close();
	}
}

/**
 * The head of `headSource` and the tail of `tailSource` around an omission marker, all within `room` bytes of
 * bridge text. `totalBytes` is the size of the whole output. When both sources are the same text, which does not
 * fit `room`, the head and tail cannot overlap.
 */
function headAndTail(
	headSource: string,
	tailSource: string,
	totalBytes: number,
	room: number,
	path: string | undefined,
): string {
	const [headRoom, tailRoom] = splitRoom(totalBytes, room, path);
	const head = encodedPrefix(headSource, headRoom);
	const tail = encodedSuffix(tailSource, tailRoom);
	const omitted = Math.max(0, totalBytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
	return `${head}${omissionMarker(omitted, path)}${tail}`;
}

/** Room for the head and the tail once the marker is placed; the marker never counts more than `totalBytes`. */
function splitRoom(totalBytes: number, room: number, path: string | undefined): [number, number] {
	const parts = Math.max(0, room - encodedStringBytes(omissionMarker(totalBytes, path)));
	const head = Math.floor(parts / 2);
	return [head, parts - head];
}

function omissionMarker(omitted: number, path: string | undefined): string {
	return `\n\n[... ${omitted} bytes omitted${path === undefined ? "" : `; full output: ${path}`} ...]\n\n`;
}

/** The bytes up to the last complete UTF-8 character. */
function wholeCharactersAtStart(bytes: Buffer): Buffer {
	let lead = bytes.length - 1;
	while (lead >= 0 && lead > bytes.length - 4 && (bytes[lead] & 0xc0) === 0x80) lead--;
	if (lead < 0) return bytes;
	const first = bytes[lead];
	const length = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
	return lead + length > bytes.length ? bytes.subarray(0, lead) : bytes;
}

/** The bytes from the first complete UTF-8 character. */
function wholeCharactersAtEnd(bytes: Buffer): Buffer {
	let start = 0;
	while (start < 3 && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
	return bytes.subarray(start);
}
