import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fc from "fast-check";
import { afterAll, describe, expect, it, vi } from "vitest";
import { CodeModeImageStore } from "../../src/core/code-mode/images.ts";
import { MAX_BASH_OUTPUT_BYTES } from "../../src/core/code-mode/limits.ts";
import {
	type CodeModeProjectionContext,
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

function context(overrides: Partial<CodeModeProjectionContext> = {}): CodeModeProjectionContext {
	return { cwd, images: new CodeModeImageStore(), ...overrides };
}

const builtin = (name: string) => ({ name, trustedBuiltin: true });

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
		return projectToolResult(builtin("bash"), args, result, context());
	};

	it("resolves with the output and exit code of a command that ran, whatever the code", async () => {
		expect(await run("printf 'hello\\n'")).toStrictEqual({ output: "hello\n", exitCode: 0, truncated: false });
		expect(await run("printf 'oops\\n'; exit 3")).toStrictEqual({ output: "oops\n", exitCode: 3, truncated: false });
		// The placeholder the model sees for a command that printed nothing is not output.
		expect(await run("true")).toStrictEqual({ output: "", exitCode: 0, truncated: false });
		expect(await run("exit 4")).toStrictEqual({ output: "", exitCode: 4, truncated: false });
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
		// Output beyond the script-value limit keeps its head and tail.
		const large = (await run("head -c 3000000 /dev/zero | tr '\\0' 'x'; printf 'END'")) as {
			output: string;
			truncated: boolean;
		};
		expect(large.truncated).toBe(true);
		expect(large.output.startsWith("xxxx")).toBe(true);
		expect(large.output.endsWith("xxxxEND")).toBe(true);
		expect(large.output).toMatch(/\[\.\.\. \d+ bytes omitted; full output: .+ \.\.\.\]/);
		expect(Buffer.byteLength(large.output)).toBeLessThan(MAX_BASH_OUTPUT_BYTES + 1024);
	});

	it("keeps the head and tail of large output whole, within the limit", async () => {
		const unit = fc.constantFrom("a", "\n", "\u00e9", "\u20ac", "\u{1f600}");
		await fc.assert(
			fc.asyncProperty(fc.array(unit, { maxLength: 120 }), fc.integer({ min: 8, max: 64 }), async (units, max) => {
				const content = units.join("");
				const file = join(cwd, "bash-output.txt");
				writeFileSync(file, content);
				const result: AgentToolResult<unknown> = {
					content: [{ type: "text", text: "(model-facing tail)" }],
					details: { exitCode: 0, truncation: { truncated: true }, fullOutputPath: file },
				};
				const value = (await projectToolResult(
					builtin("bash"),
					{ command: "x" },
					result,
					context({ maxBashOutputBytes: max }),
				)) as { output: string; truncated: boolean; fullOutputPath: string };
				expect(value.fullOutputPath).toBe(file);
				if (Buffer.byteLength(content) <= max) {
					expect(value).toMatchObject({ output: content, truncated: false });
					return;
				}
				expect(value.truncated).toBe(true);
				const [head, tail] = value.output.split(/\n\n\[\.\.\. \d+ bytes omitted; full output: .+ \.\.\.\]\n\n/);
				// Both parts are whole characters taken from the ends of the output, each within half the limit.
				expect(content.startsWith(head)).toBe(true);
				expect(content.endsWith(tail)).toBe(true);
				expect(value.output).not.toContain("\ufffd");
				for (const part of [head, tail]) {
					expect(Buffer.byteLength(part)).toBeLessThanOrEqual(Math.floor(max / 2));
					expect(Buffer.byteLength(part)).toBeGreaterThan(Math.floor(max / 2) - 4);
				}
			}),
			{ numRuns: 300 },
		);
	});

	it("applies the bash projection only to the trusted built-in tool", async () => {
		const result: AgentToolResult<unknown> = {
			content: [{ type: "text", text: "extension output" }],
			details: { exitCode: 0 },
		};
		expect(await projectToolResult({ name: "bash", trustedBuiltin: false }, {}, result, context())).toBe(
			"extension output",
		);
	});
});

describe("code mode read and image_gen projections", () => {
	it("resolves with the text of a text file and a reference to an image file", async () => {
		const read = createReadTool(cwd);
		writeFileSync(join(cwd, "notes.txt"), "first\nsecond");
		const textResult = await read.execute("call", { path: "notes.txt" });
		expect(await projectToolResult(builtin("read"), { path: "notes.txt" }, textResult, context())).toBe(
			"first\nsecond",
		);
		writeFileSync(join(cwd, "pixel.png"), Buffer.from(PNG_1X1, "base64"));
		const images = new CodeModeImageStore();
		const imageResult = await read.execute("call", { path: "pixel.png" });
		const ref = await projectToolResult(builtin("read"), { path: "pixel.png" }, imageResult, context({ images }));
		expect(ref).toStrictEqual({
			type: "image",
			ref: "img_1",
			mimeType: "image/png",
			width: 1,
			height: 1,
			bytes: images.get("img_1")?.ref.bytes,
			path: join(cwd, "pixel.png"),
		});
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
		const ref = await projectToolResult(builtin("image_gen"), { prompt: "a pixel" }, result, context());
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
		const images = new CodeModeImageStore();
		expect(await projectToolResult(builtin("web_fetch"), {}, result, context({ images }))).toBe("one\ntwo");
		// The default projection keeps only text; images are not retained.
		expect(images.retainedBytes).toBe(0);
		const failed = await rejection(
			projectToolResult(
				builtin("edit"),
				{},
				{ content: [{ type: "text", text: "no match" }], isError: true },
				context(),
			),
		);
		expect([failed.kind, failed.message]).toStrictEqual(["failed", "no match"]);
	});

	it("resolves with an MCP result's text, structured content, and image references", () => {
		const images = new CodeModeImageStore();
		const result: CallToolResult = {
			content: [
				{ type: "text", text: "found 2 issues" },
				{ type: "image", data: PNG_1X1, mimeType: "image/png" },
				{ type: "resource", resource: { uri: "file:///a.txt", text: "body" } },
			],
			structuredContent: { issues: [1, 2] },
		};
		expect(projectMcpResult(result, context({ images }))).toStrictEqual({
			text: "found 2 issues\n[MCP resource file:///a.txt]\nbody",
			structured: { issues: [1, 2] },
			images: [images.get("img_1")?.ref],
		});
		expect(projectMcpResult({ content: [{ type: "text", text: "plain" }] }, context())).toStrictEqual({
			text: "plain",
			images: [],
		});
	});

	it("rejects an MCP error result or images over the limit, keeping none of their images", () => {
		const images = new CodeModeImageStore(10);
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
		expect(images.retainedBytes).toBe(0);
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
