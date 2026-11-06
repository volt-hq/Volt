import { open } from "node:fs/promises";
import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import type { ImageContent, TextContent } from "@hansjm10/volt-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { contentPartToText } from "../mcp/manager.ts";
import { BASH_NO_OUTPUT_TEXT, bashExitStatus } from "../tools/bash.ts";
import { resolveReadPathAsync } from "../tools/path-utils.ts";
import type { CodeModeImageInput, CodeModeImageStore } from "./images.ts";
import { MAX_BASH_OUTPUT_BYTES } from "./limits.ts";
import { CodeModeCallError } from "./runtime.ts";

/**
 * Script values of nested calls (section 5.9 of docs/code-mode-design.md). A projection turns a tool's result,
 * after the tool-result policy, into the value the script's call resolves with, or rejects the call with a
 * `CodeModeCallError`. Projections are internal to built-in tools and MCP; any other tool gets the default.
 */

export interface CodeModeProjectionContext {
	/** The session's working directory, against which file arguments resolve. */
	cwd: string;
	/** The images of the script; images in a value are retained here and replaced by references. */
	images: CodeModeImageStore;
	/** Bytes of command output in a bash value. */
	maxBashOutputBytes?: number;
}

/** A tool that ran, and whether it is the trusted built-in tool of that name. */
export interface CodeModeProjectedTool {
	name: string;
	trustedBuiltin: boolean;
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
	result: AgentToolResult<unknown>,
	context: CodeModeProjectionContext,
): Promise<unknown> {
	if (tool.trustedBuiltin && tool.name === "bash") return projectBash(result, context);
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

function stringField(value: unknown, key: string): string | undefined {
	if (value === null || typeof value !== "object") return undefined;
	const field = (value as Record<string, unknown>)[key];
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

/**
 * The bash value. The exit code comes from the result's details, present only for a command that ran to
 * completion; anything else rejects with the result's text. Output the model saw truncated is read from the
 * full output file, keeping its head and tail when it exceeds the value's limit. `truncated` says whether
 * `output` is incomplete.
 */
async function projectBash(result: AgentToolResult<unknown>, context: CodeModeProjectionContext): Promise<unknown> {
	const details: Record<string, unknown> =
		result.details !== null && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
	const exitCode = details.exitCode;
	const text = textOf(result.content);
	if (typeof exitCode !== "number" && exitCode !== null) throw failedCall(text);
	const fullOutputPath = typeof details.fullOutputPath === "string" ? details.fullOutputPath : undefined;
	const modelTruncated =
		details.truncation !== null &&
		typeof details.truncation === "object" &&
		(details.truncation as { truncated?: unknown }).truncated === true;
	let output: { text: string; truncated: boolean } | undefined;
	if (modelTruncated && fullOutputPath !== undefined) {
		output = await readHeadAndTail(fullOutputPath, context.maxBashOutputBytes ?? MAX_BASH_OUTPUT_BYTES).catch(
			() => undefined,
		);
	}
	output ??= { text: stripBashStatus(text, exitCode), truncated: modelTruncated };
	return {
		output: output.text,
		exitCode,
		truncated: output.truncated,
		...(fullOutputPath === undefined ? {} : { fullOutputPath }),
	};
}

/**
 * The command's output from the result text: without the status line bash appends for a non-zero exit, and
 * empty instead of the no-output placeholder. Text a tool-result hook changed is kept whole.
 */
function stripBashStatus(text: string, exitCode: number | null): string {
	let output = text;
	if (exitCode !== null && exitCode !== 0) {
		const status = `\n\n${bashExitStatus(exitCode)}`;
		if (output.endsWith(status)) output = output.slice(0, -status.length);
	}
	return output === BASH_NO_OUTPUT_TEXT ? "" : output;
}

/** The file's text, or its first and last halves of `maxBytes` around a marker, cut at character boundaries. */
async function readHeadAndTail(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
	const file = await open(path, "r");
	try {
		const { size } = await file.stat();
		if (size <= maxBytes) {
			const whole = Buffer.alloc(size);
			await file.read(whole, 0, size, 0);
			return { text: whole.toString("utf8"), truncated: false };
		}
		const half = Math.floor(maxBytes / 2);
		const head = Buffer.alloc(half);
		const tail = Buffer.alloc(half);
		await file.read(head, 0, half, 0);
		await file.read(tail, 0, half, size - half);
		const headText = wholeCharactersAtStart(head);
		const tailText = wholeCharactersAtEnd(tail);
		const omitted = size - headText.length - tailText.length;
		return {
			text: `${headText.toString("utf8")}\n\n[... ${omitted} bytes omitted; full output: ${path} ...]\n\n${tailText.toString("utf8")}`,
			truncated: true,
		};
	} finally {
		await file.close();
	}
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
