import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fc from "fast-check";
import { afterAll, describe, expect, it, vi } from "vitest";
import { encodeBridgeValue, encodedStringBytes } from "../../src/core/code-mode/codec.ts";
import { CodeModeImageStore } from "../../src/core/code-mode/images.ts";
import { DEFAULT_CODE_MODE_SCRIPT_LIMITS } from "../../src/core/code-mode/limits.ts";
import {
	type CodeModeProjectionContext,
	type CodeModeToolResults,
	projectMcpResult,
	projectToolResult,
} from "../../src/core/code-mode/projections.ts";
import { CodeModeCallError } from "../../src/core/code-mode/runtime.ts";
import { createBashTool } from "../../src/core/tools/bash.ts";
import { createImageGenTool } from "../../src/core/tools/image-gen.ts";
import { createReadTool } from "../../src/core/tools/read.ts";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

const cwd = mkdtempSync(join(tmpdir(), "volt-code-mode-projections-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

const MAX_VALUE_BYTES = DEFAULT_CODE_MODE_SCRIPT_LIMITS.maxScriptValueBytes;

function context(overrides: Partial<CodeModeProjectionContext> = {}): CodeModeProjectionContext {
	return { cwd, images: new CodeModeImageStore().stage(), maxValueBytes: MAX_VALUE_BYTES, ...overrides };
}

/** A result no `tool_result` hook saw. */
const unreviewed = (executed: AgentToolResult<unknown>): CodeModeToolResults => ({ executed, reviewed: undefined });

const builtin = (name: string) => ({ name, trustedBuiltin: true });

const encodedBytes = (value: unknown) => Buffer.byteLength(encodeBridgeValue(value, "result"));

const OMISSION = /\n\n\[\.\.\. \d+ bytes omitted(?:; full output: .+)? \.\.\.\]\n\n/;

async function rejection(promise: Promise<unknown>): Promise<CodeModeCallError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof CodeModeCallError) return error;
		throw error;
	}
	throw new Error("expected the projection to reject");
}

describe("code mode bash projection", () => {
	const bash = createBashTool(cwd);
	const run = async (command: string, options: { timeout?: number; signal?: AbortSignal } = {}) => {
		const args = { command, ...(options.timeout === undefined ? {} : { timeout: options.timeout }) };
		const result = await bash.execute("call", args, options.signal);
		return projectToolResult(builtin("bash"), args, unreviewed(result), context());
	};

	it("resolves with the output and exit code of a command that ran, whatever the code", async () => {
		expect(await run("printf 'hello\\n'")).toStrictEqual({ output: "hello\n", exitCode: 0, truncated: false });
		expect(await run("printf 'oops\\n'; exit 3")).toStrictEqual({ output: "oops\n", exitCode: 3, truncated: false });
		// The placeholder the model sees for a command that printed nothing is not output.
		expect(await run("true")).toStrictEqual({ output: "", exitCode: 0, truncated: false });
		expect(await run("exit 4")).toStrictEqual({ output: "", exitCode: 4, truncated: false });
		// Output that reads like the placeholder is output.
		expect(await run("printf '(no output)'")).toStrictEqual({ output: "(no output)", exitCode: 0, truncated: false });
		expect(await run("printf '(no output)'; exit 2")).toStrictEqual({
			output: "(no output)",
			exitCode: 2,
			truncated: false,
		});
	});

	it("rejects a command that timed out or was aborted", async () => {
		const timedOut = await rejection(run("sleep 5", { timeout: 1 }));
		expect(timedOut.kind).toBe("failed");
		expect(timedOut.message).toMatch(/timed out after 1 seconds/);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		expect((await rejection(run("sleep 5", { signal: controller.signal }))).message).toMatch(/Command aborted/);
	});

	it("reads output the model saw truncated from the full output file", async () => {
		// 3,000 lines exceed the 2,000 lines the model sees, but fit in a script value.
		const lines = await run('i=0; while [ $i -lt 3000 ]; do echo "line $i"; i=$((i+1)); done');
		const expected = Array.from({ length: 3000 }, (_, i) => `line ${i}\n`).join("");
		expect(lines).toMatchObject({ output: expected, exitCode: 0, truncated: false });
		expect((lines as { fullOutputPath?: unknown }).fullOutputPath).toEqual(expect.any(String));
		// Output beyond the script-value limit keeps its head and tail, and the whole value fits the limit.
		const large = (await run("head -c 3000000 /dev/zero | tr '\\0' 'x'; printf 'END'")) as {
			output: string;
			truncated: boolean;
		};
		expect(large.truncated).toBe(true);
		expect(large.output.startsWith("xxxx")).toBe(true);
		expect(large.output.endsWith("xxxxEND")).toBe(true);
		expect(large.output).toMatch(/\[\.\.\. \d+ bytes omitted; full output: .+ \.\.\.\]/);
		expect(encodedBytes(large)).toBeLessThanOrEqual(MAX_VALUE_BYTES);
		expect(encodedBytes(large)).toBeGreaterThan(MAX_VALUE_BYTES - 64);
	});

	it("keeps the head and tail of large output whole, with the value within its limit", async () => {
		// Characters of each encoded size: escapes of 2 and 6 bytes, and UTF-8 of 1 to 4 bytes.
		const unit = fc.constantFrom("a", "\n", '"', "\\", "\u0001", "\u00e9", "\u20ac", "\u{1f600}");
		const file = join(cwd, "bash-output.txt");
		const details = { exitCode: 0, truncation: { truncated: true }, fullOutputPath: file };
		const base = encodedBytes({ output: "", exitCode: 0, truncated: false, fullOutputPath: file });
		const marker = encodedStringBytes(`\n\n[... 1000 bytes omitted; full output: ${file} ...]\n\n`);
		await fc.assert(
			fc.asyncProperty(fc.array(unit, { maxLength: 120 }), fc.nat({ max: 64 }), async (units, extra) => {
				const content = units.join("");
				writeFileSync(file, content);
				const maxValueBytes = base + marker + extra;
				const result: AgentToolResult<unknown> = {
					content: [{ type: "text", text: "(model-facing tail)" }],
					details,
				};
				const value = (await projectToolResult(
					builtin("bash"),
					{ command: "x" },
					unreviewed(result),
					context({ maxValueBytes }),
				)) as { output: string; truncated: boolean; fullOutputPath: string };
				expect(value.fullOutputPath).toBe(file);
				expect(encodedBytes(value)).toBeLessThanOrEqual(maxValueBytes);
				if (encodedBytes({ ...value, output: content, truncated: false }) <= maxValueBytes) {
					expect(value).toMatchObject({ output: content, truncated: false });
					return;
				}
				expect(value.truncated).toBe(true);
				const [head, tail] = value.output.split(OMISSION);
				// Whole characters from the ends of the output that use the room, short of one character on each side.
				expect(content.startsWith(head)).toBe(true);
				expect(content.endsWith(tail)).toBe(true);
				expect(head.length + tail.length).toBeLessThan(content.length);
				expect(value.output).not.toContain("\ufffd");
				expect(encodedBytes(value)).toBeGreaterThan(maxValueBytes - 16);
			}),
			{ numRuns: 300 },
		);
	});

	it("gives a result a hook saw as the hook left it, never reading the full output file", async () => {
		const file = join(cwd, "secret-output.txt");
		writeFileSync(file, "head: SECRET\n...\ntail\n");
		const details = { exitCode: 2, truncation: { truncated: true }, fullOutputPath: file };
		const executed: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "tail\n\n[Showing lines 3-3 of 3]\n\nCommand exited with code 2" }],
			details,
			isError: true,
		};
		const project = (reviewed: AgentToolResult<unknown>) =>
			projectToolResult(builtin("bash"), { command: "x" }, { executed, reviewed }, context());
		// A hook replaced the text and kept the details, as the tool-result policy does when a hook returns no details.
		expect(await project({ ...executed, content: [{ type: "text", text: "[redacted]" }] })).toStrictEqual({
			output: "[redacted]",
			exitCode: 2,
			truncated: true,
		});
		// A hook that left the result unchanged saw only the tail; the value is still the text it saw.
		expect(await project(executed)).toStrictEqual({
			output: "tail\n\n[Showing lines 3-3 of 3]\n\nCommand exited with code 2",
			exitCode: 2,
			truncated: true,
		});
		// Reviewed text is bounded like any other output.
		const long = (await projectToolResult(
			builtin("bash"),
			{ command: "x" },
			{ executed, reviewed: { ...executed, content: [{ type: "text", text: "y".repeat(5_000) }] } },
			context({ maxValueBytes: 500 }),
		)) as { output: string; truncated: boolean };
		expect(long.truncated).toBe(true);
		expect(long.output).toMatch(OMISSION);
		expect(encodedBytes(long)).toBeLessThanOrEqual(500);
	});

	it("applies the bash projection only to the trusted built-in tool", async () => {
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "extension output" }],
			details: { exitCode: 0 },
		};
		expect(await projectToolResult({ name: "bash", trustedBuiltin: false }, {}, unreviewed(result), context())).toBe(
			"extension output",
		);
	});
});

describe("code mode read and image_gen projections", () => {
	it("resolves with the text of a text file and a reference to an image file", async () => {
		const read = createReadTool(cwd);
		writeFileSync(join(cwd, "notes.txt"), "first\nsecond");
		const textResult = await read.execute("call", { path: "notes.txt" });
		expect(await projectToolResult(builtin("read"), { path: "notes.txt" }, unreviewed(textResult), context())).toBe(
			"first\nsecond",
		);
		writeFileSync(join(cwd, "pixel.png"), Buffer.from(PNG_1X1, "base64"));
		const images = new CodeModeImageStore().stage();
		const imageResult = await read.execute("call", { path: "pixel.png" });
		const ref = await projectToolResult(
			builtin("read"),
			{ path: "pixel.png" },
			unreviewed(imageResult),
			context({ images }),
		);
		expect(ref).toStrictEqual({
			type: "image",
			ref: "img_1",
			mimeType: "image/png",
			width: 1,
			height: 1,
			bytes: Buffer.from(PNG_1X1, "base64").length,
			path: join(cwd, "pixel.png"),
		});
		expect(images.refs).toStrictEqual(["img_1"]);
	});

	it("resolves with a reference to a generated image and the file it was saved to", async () => {
		const fetcher = vi.fn(async () =>
			Response.json({ data: [{ b64_json: PNG_1X1 }], size: "1024x1024", quality: "high" }),
		);
		const tool = createImageGenTool(cwd, {
			fetcher,
			outputRoot: join(cwd, "generated"),
			modelContext: () => ({ model: codexModel(), apiKey: codexToken() }),
		});
		const result = await tool.execute("gen-1", { prompt: "a pixel" });
		const outputPath = (result.details as { outputPath: string }).outputPath;
		const ref = await projectToolResult(builtin("image_gen"), { prompt: "a pixel" }, unreviewed(result), context());
		expect(ref).toMatchObject({ type: "image", ref: "img_1", mimeType: "image/png", width: 1, height: 1 });
		expect((ref as { path?: string }).path).toBe(outputPath);
	});
});

describe("code mode default and MCP projections", () => {
	it("joins a result's text blocks and rejects an error result with its text", async () => {
		const result: AgentToolResult<unknown> = {
			content: [
				{ type: "text", text: "one" },
				{ type: "image", data: PNG_1X1, mimeType: "image/png" },
				{ type: "text", text: "two" },
			],
		};
		const images = new CodeModeImageStore().stage();
		expect(await projectToolResult(builtin("web_fetch"), {}, unreviewed(result), context({ images }))).toBe(
			"one\ntwo",
		);
		// The default projection keeps only text; images are not retained.
		expect(images.refs).toStrictEqual([]);
		const failed = await rejection(
			projectToolResult(
				builtin("edit"),
				{},
				unreviewed({ content: [{ type: "text", text: "no match" }], isError: true }),
				context(),
			),
		);
		expect([failed.kind, failed.message]).toStrictEqual(["failed", "no match"]);
		// Other tools take the result as the hooks left it.
		const reviewed = await projectToolResult(
			builtin("web_fetch"),
			{},
			{ executed: result, reviewed: { content: [{ type: "text", text: "[redacted]" }] } },
			context(),
		);
		expect(reviewed).toBe("[redacted]");
	});

	it("resolves with an MCP result's text, structured content, and image references", () => {
		const store = new CodeModeImageStore();
		const images = store.stage();
		const result: CallToolResult = {
			content: [
				{ type: "text", text: "found 2 issues" },
				{ type: "image", data: PNG_1X1, mimeType: "image/png" },
				{ type: "resource", resource: { uri: "file:///a.txt", text: "body" } },
			],
			structuredContent: { issues: [1, 2] },
		};
		const value = projectMcpResult(result, context({ images }));
		images.commit();
		expect(value).toStrictEqual({
			text: "found 2 issues\n[MCP resource file:///a.txt]\nbody",
			structured: { issues: [1, 2] },
			images: [store.get("img_1")?.ref],
		});
		expect(projectMcpResult({ content: [{ type: "text", text: "plain" }] }, context())).toStrictEqual({
			text: "plain",
			images: [],
		});
	});

	it("rejects an MCP error result or images over the limit, keeping none of their images", () => {
		const images = new CodeModeImageStore(10).stage();
		const errorResult: CallToolResult = {
			content: [
				{ type: "text", text: "rate limited" },
				{ type: "image", data: PNG_1X1, mimeType: "image/png" },
			],
			isError: true,
		};
		expect(() => projectMcpResult(errorResult, context({ images }))).toThrow(
			expect.objectContaining({ kind: "failed", message: "rate limited" }),
		);
		const large: CallToolResult = { content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }] };
		expect(() => projectMcpResult(large, context({ images }))).toThrow(
			expect.objectContaining({ kind: "failed", reason: "limit_exceeded" }),
		);
		expect(images.refs).toStrictEqual([]);
	});
});

function codexModel(): Model<Api> {
	return {
		id: "gpt-5.4",
		name: "GPT-5.4",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function codexToken(): string {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "a" } })).toString(
		"base64url",
	);
	return `header.${payload}.signature`;
}
