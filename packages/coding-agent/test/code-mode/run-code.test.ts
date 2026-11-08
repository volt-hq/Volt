import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@hansjm10/volt-agent-core";
import type { ImageContent, TextContent } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterAll, describe, expect, it } from "vitest";
import type {
	CodeModeActiveTool,
	CodeModeBindingSources,
	CodeModeBindingTarget,
} from "../../src/core/code-mode/bindings.ts";
import type { CodeModeDispatchHost } from "../../src/core/code-mode/dispatch.ts";
import { CodeModeWorkerPool } from "../../src/core/code-mode/pool.ts";
import type { CodeModeRenderCall } from "../../src/core/code-mode/render.ts";
import type { CodeModeScriptResult } from "../../src/core/code-mode/runtime.ts";
import {
	getTrustedToolOperationResolver,
	type IntegrationReadAuthority,
	RESEARCH_OPERATION_GRANT_PROFILE,
} from "../../src/core/operation-authorization.ts";
import {
	buildRunCodeDetails,
	createRunCodeTool,
	describeRunCode,
	type RunCodeDetails,
} from "../../src/core/tools/run-code.ts";

const cwd = mkdtempSync(join(tmpdir(), "volt-run-code-"));
const pool = new CodeModeWorkerPool();
const extraPools: CodeModeWorkerPool[] = [];
afterAll(() => {
	pool.close();
	for (const extra of extraPools) extra.close();
	rmSync(cwd, { recursive: true, force: true });
});

const authority: IntegrationReadAuthority = {
	hasTrustedReads: () => true,
	hasTrustedToolReads: () => true,
	hasTrustedResourceReads: () => true,
	isTrustedToolRead: () => true,
};

function builtin(name: string): CodeModeActiveTool {
	return {
		name,
		kind: "builtin",
		resolver: getTrustedToolOperationResolver(name, { integrationReadAuthority: authority }),
	};
}

function sources(partial: Partial<CodeModeBindingSources>): CodeModeBindingSources {
	return { activeTools: [], grantProfile: undefined, mcpTools: [], ...partial };
}

/** The binding lines of a description. */
function bindingLines(description: string): string[] {
	return description.split("\n").filter((line) => line.startsWith("- "));
}

const DEFAULT_BUILD_TOOLS = [
	"request_user_input",
	"jobs",
	"read",
	"bash",
	"edit",
	"write",
	"image_gen",
	"web_search",
	"web_fetch",
	"lsp",
	"run_code",
].map(builtin);

const BASH_LINE =
	"- tools.bash(args): Promise<{ output: string; exitCode: number | null; truncated: boolean; fullOutputPath?: string }>, resolving for any exit code";
const READ_LINE = "- tools.read(args): Promise<string | ImageRef>";
const MCP_LINE_START = "- MCP tools: tools.mcp.<server>.<tool>(args)";
const NO_TOOLS = "No tools are available to scripts in this session.";

describe("run_code description", () => {
	it("lists the default Build tools' bindings, with the shapes of bash, read, and image_gen", () => {
		const description = describeRunCode(sources({ activeTools: DEFAULT_BUILD_TOOLS }));
		expect(bindingLines(description)).toStrictEqual([
			BASH_LINE,
			READ_LINE,
			"- tools.image_gen(args): Promise<ImageRef>",
			"- tools.edit(args), tools.write(args), tools.web_search(args), tools.web_fetch(args), tools.lsp(args): Promise<string>",
		]);
		expect(description).toContain(
			"Call tools as `await tools.<name>(args)` with the same arguments as the tool itself:",
		);
		expect(description).toContain("A failed call rejects with ToolCallError");
		expect(description).toContain("Limits: 30 s of computation, 200 tool calls, and 64 MiB of memory per script.");
		expect(description).toContain(`Write shell commands with String.raw\`...\` and $VAR instead of \${VAR}.`);
	});

	it("lists only the bindings the research profile authorizes in Plan mode", () => {
		const description = describeRunCode(
			sources({
				activeTools: [...DEFAULT_BUILD_TOOLS, ...["grep", "find", "ls", "inspect"].map(builtin)],
				grantProfile: RESEARCH_OPERATION_GRANT_PROFILE,
			}),
		);
		expect(bindingLines(description)).toStrictEqual([
			READ_LINE,
			"- tools.web_search(args), tools.web_fetch(args), tools.lsp(args), tools.grep(args), tools.find(args), tools.ls(args), tools.inspect(args): Promise<string>",
		]);
		// No bash binding, so no advice on writing shell commands.
		expect(description).not.toContain("String.raw");
	});

	it("gives a tool an extension replaced by name the plain text shape", () => {
		const description = describeRunCode(
			sources({
				activeTools: [{ name: "read", kind: "other" }, builtin("bash"), { name: "my-tool", kind: "other" }],
			}),
		);
		expect(bindingLines(description)).toStrictEqual([
			BASH_LINE,
			'- tools.read(args), tools["my-tool"](args): Promise<string>',
		]);
	});

	it("lists MCP tools while the gateway or a direct MCP tool makes them callable, whatever servers are listed", () => {
		const direct: CodeModeActiveTool = {
			name: "mcp__github__search",
			kind: "mcp_direct",
			server: "github",
			tool: "search",
		};
		const hasMcpLine = (input: CodeModeBindingSources) =>
			bindingLines(describeRunCode(input)).some((line) => line.startsWith(MCP_LINE_START));
		expect(hasMcpLine(sources({ activeTools: [builtin("read")] }))).toBe(false);
		expect(hasMcpLine(sources({ activeTools: [builtin("read"), builtin("mcp")] }))).toBe(true);
		expect(hasMcpLine(sources({ activeTools: [builtin("read"), direct] }))).toBe(true);
		// The gateway is authorized for trusted reads in Plan mode; a direct tool is not.
		const plan = RESEARCH_OPERATION_GRANT_PROFILE;
		expect(hasMcpLine(sources({ activeTools: [builtin("read"), builtin("mcp")], grantProfile: plan }))).toBe(true);
		expect(hasMcpLine(sources({ activeTools: [builtin("read"), direct], grantProfile: plan }))).toBe(false);
		// An extension's tool named mcp is not the gateway.
		expect(hasMcpLine(sources({ activeTools: [{ name: "mcp", kind: "other" }] }))).toBe(false);
		// Listed MCP tools never change the description, so connecting a server keeps the prompt cache.
		const active = [builtin("read"), builtin("mcp")];
		expect(
			describeRunCode(
				sources({ activeTools: active, mcpTools: [{ server: "github", tool: "search", trustedRead: false }] }),
			),
		).toBe(describeRunCode(sources({ activeTools: active })));
	});

	it("says no tools are available when nothing is bound", () => {
		const description = describeRunCode(sources({ activeTools: [builtin("jobs"), builtin("run_code")] }));
		expect(description).toContain(NO_TOOLS);
		expect(bindingLines(description)).toStrictEqual([]);
		expect(description).not.toContain("Call tools as");
		expect(description).not.toContain("ToolCallError");
	});
});

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

function tool(
	name: string,
	execute: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<AgentToolResult<unknown>>,
): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({}),
		execute: (_toolCallId, args, signal) => execute(args as Record<string, unknown>, signal),
	} as AgentTool;
}

const text = (value: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: value }] });
const image = (details?: unknown): AgentToolResult<unknown> => ({
	content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" } satisfies ImageContent],
	details,
});

const gateway = (): AgentTool =>
	({
		name: "mcp",
		label: "mcp",
		description: "mcp",
		parameters: Type.Object({
			action: Type.String(),
			server: Type.Optional(Type.String()),
			tool: Type.Optional(Type.String()),
			arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		}),
		execute: async () => {
			throw new Error("nested MCP calls do not run the gateway");
		},
	}) as AgentTool;

/** Trusted built-in stand-ins: reads and writes that echo their arguments, image tools, and a tool that fails. */
const TOOLS = [
	tool("read", async (args) =>
		String(args.path).endsWith(".png") ? image() : text(`contents of ${String(args.path)}`),
	),
	tool("write", async (args) => text(`wrote ${String(args.path)}`)),
	tool("grep", async (args) => text(`matches for ${String(args.pattern)}`)),
	tool("image_gen", async () => image({ outputPath: "images/generated.png" })),
	tool("broken", async () => {
		throw new Error("the tool broke");
	}),
	tool("wait", (_args, signal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", reject))),
	gateway(),
];
const READ_ONLY = new Set(["read", "grep"]);
/** Tools that stand in for extension tools: no trusted resolver, and bound only by name. */
const EXTENSION_TOOLS = new Set(["broken", "wait"]);

/** A `run_code` tool over a session stand-in with every policy allowing every call. */
function runCode(target: CodeModeWorkerPool = pool) {
	const tools = new Map(TOOLS.map((registered) => [registered.name, registered]));
	const host: CodeModeDispatchHost = {
		cwd,
		isToolActive: (name) => tools.has(name),
		tool: (name) => {
			const registered = tools.get(name);
			return registered && { tool: registered, trustedBuiltin: !EXTENSION_TOOLS.has(name) };
		},
		*toolCallPolicies() {},
		toolResult: async () => undefined,
		callMcpTool: async () => ({ content: [{ type: "image", data: PNG_1X1, mimeType: "image/png" }] }),
		mcpServerLimit: () => 4,
	};
	return createRunCodeTool({
		bindingSources: () =>
			sources({
				activeTools: TOOLS.map(
					({ name }): CodeModeActiveTool => (EXTENSION_TOOLS.has(name) ? { name, kind: "other" } : builtin(name)),
				),
				mcpTools: [{ server: "browser", tool: "screenshot", trustedRead: false }],
			}),
		dispatchHost: () => host,
		callIsReadOnly: (bindingTarget: CodeModeBindingTarget) =>
			bindingTarget.kind === "tool" && READ_ONLY.has(bindingTarget.toolName),
		autoResizeImages: true,
		pool: target,
	});
}

async function run(code: string, options: { timeoutMs?: number; pool?: CodeModeWorkerPool } = {}) {
	const result = await runCode(options.pool).execute(
		"call-1",
		{ code, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) },
		undefined,
	);
	const output = result.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return { output, isError: result.isError === true, details: result.details as RunCodeDetails };
}

describe("run_code", () => {
	// First to strip in this file's process: Node warns only for the first strip in a process. The test runner filters
	// warning events, so the test watches the calls that would emit one.
	it("strips TypeScript annotations around top-level await and return, emitting no warning", async () => {
		const emitWarning = process.emitWarning;
		const warned: string[] = [];
		const watching = (...args: unknown[]): void => {
			warned.push(String(args[0] instanceof Error ? args[0].message : args[0]));
			Reflect.apply(emitWarning, process, args);
		};
		process.emitWarning = watching as typeof process.emitWarning;
		try {
			const { output, isError, details } = await run(
				"const contents: string = await tools.read({ path: 'a.txt' });\nreturn contents.toUpperCase() as string;",
			);
			expect(isError).toBe(false);
			expect(output).toMatch(/^Script completed in \S+ \(1 tool call\)\nReturn value: CONTENTS OF A\.TXT$/);
			expect(details.language).toBe("typescript");
			expect(warned.filter((message) => /stripTypeScriptTypes|type stripping/i.test(message))).toStrictEqual([]);
			expect(process.emitWarning).toBe(watching);
		} finally {
			process.emitWarning = emitWarning;
		}
	});

	it("keeps the script's line numbers in stack traces of stripped TypeScript", async () => {
		const { output, isError } = await run(
			"const count: number = 1;\nfunction fail(): never {\n  throw new Error('boom');\n}\nfail();",
		);
		expect(isError).toBe(true);
		expect(output).toContain("Error: boom\n    at fail (script.js:3:");
		expect(output).toContain("(script.js:5:");
	});

	it("fails TypeScript that strip mode does not support as a syntax error, without starting a VM", async () => {
		const unused = new CodeModeWorkerPool();
		extraPools.push(unused);
		const { output, isError, details } = await run("const ok = 1;\nenum Color { Red }\nreturn Color.Red;", {
			pool: unused,
		});
		expect(isError).toBe(true);
		expect(output).toMatch(/^Script failed after \S+ \(0 tool calls\): syntax error\n/);
		expect(output).toContain(
			"The script did not start.\nSyntaxError: TypeScript enum is not supported in strip-only mode\n    at script.js:2",
		);
		expect(details).toMatchObject({ status: "failed", failureKind: "script_error", language: "typescript" });
		expect(unused.stats.workers).toBe(0);
	});

	it("runs code the TypeScript parser rejects unchanged, so the engine reports genuine errors", async () => {
		// A legacy octal literal is valid sloppy-mode JavaScript but invalid TypeScript.
		const octal = await run("return 010;");
		expect(octal.isError).toBe(false);
		expect(octal.output).toContain("Return value: 8");
		expect(octal.details.language).toBe("javascript");
		const broken = await run("return )(;");
		expect(broken.isError).toBe(true);
		expect(broken.output).toContain("syntax error");
		expect(broken.output).not.toContain("did not start");
		expect(broken.output).toContain("script.js:1:");
	});

	it("records each call's tool, arguments, and path, with exact totals and output statistics", async () => {
		const { isError, details } = await run(
			[
				"console.log('reading');",
				"await tools.read({ path: 'a.txt' });",
				"await tools.write({ path: 'b.txt', content: 'x'.repeat(100) });",
				"await tools.grep({ pattern: 'TODO', path: 'src' });",
				"await Promise.allSettled([tools.broken({ path: 'c.txt' })]);",
				"text('done');",
			].join("\n"),
		);
		expect(isError).toBe(false);
		expect(details.calls).toStrictEqual([
			{
				seq: 1,
				tool: "read",
				argsPreview: 'path="a.txt"',
				path: "a.txt",
				status: "completed",
				readOnly: true,
				durationMs: expect.any(Number),
			},
			{
				seq: 2,
				tool: "write",
				argsPreview: 'path="b.txt" content=<100 chars>',
				path: "b.txt",
				status: "completed",
				readOnly: false,
				durationMs: expect.any(Number),
			},
			{
				seq: 3,
				tool: "grep",
				argsPreview: 'pattern="TODO" path="src"',
				status: "completed",
				readOnly: true,
				durationMs: expect.any(Number),
			},
			{
				seq: 4,
				tool: "broken",
				argsPreview: 'path="c.txt"',
				status: "failed",
				readOnly: false,
				durationMs: expect.any(Number),
				error: "the tool broke",
			},
		]);
		expect(details).toMatchObject({
			status: "completed",
			callTotals: { completed: 3, failed: 1, cancelled: 0, unsettled: 0 },
			complete: true,
			output: { truncated: false, items: 2, characters: "reading".length + "done".length },
			images: { shown: [], unshown: [] },
		});
		expect(details.wallMs).toBeGreaterThanOrEqual(0);
	});

	it("names MCP calls by server and tool and passes the script's timeout to the runtime", async () => {
		const { output, isError, details } = await run(
			"await tools.mcp.browser.screenshot({ url: 'https://example.com' });\nawait tools.wait({});",
			{ timeoutMs: 300 },
		);
		expect(isError).toBe(true);
		expect(output).toContain("timed out after 0.3s");
		expect(details.failureKind).toBe("timeout");
		expect(details.calls.map(({ tool, status }) => ({ tool, status }))).toStrictEqual([
			{ tool: "mcp.browser.screenshot", status: "completed" },
			{ tool: "wait", status: "cancelled" },
		]);
	});

	it("labels the images a script did not show by the call that returned them", async () => {
		const { output, details } = await run(
			[
				"await tools.read({ path: 'b.png' });",
				"await tools.image_gen({ prompt: 'a cat' });",
				"await tools.mcp.browser.screenshot({});",
			].join("\n"),
		);
		expect(output).toContain(
			"3 images not shown: img_1 (read b.png), img_2 (image_gen images/generated.png), img_3 (MCP browser.screenshot)",
		);
		expect(details.images.unshown.map((ref) => ref.ref)).toStrictEqual(["img_1", "img_2", "img_3"]);
	});
});

describe("run_code details", () => {
	const rendered = { content: [], isError: false, truncated: false, shownImages: [], unshownImages: [] };

	function details(calls: CodeModeRenderCall[]): RunCodeDetails {
		const result: CodeModeScriptResult = { ok: true, hasValue: false, output: [], calls, durationMs: 5 };
		return buildRunCodeDetails({ result, calls, rendered, language: "javascript" });
	}

	/** Every fourth call writes; the others read. Each has a path of `pathChars` characters. */
	function calls(count: number, pathChars: number): CodeModeRenderCall[] {
		return Array.from({ length: count }, (_, index): CodeModeRenderCall => {
			const writes = index % 4 === 0;
			return {
				seq: index + 1,
				binding: JSON.stringify([writes ? "write" : "read"]),
				status: "completed",
				durationMs: 1,
				tool: writes ? "write" : "read",
				args: { path: `${"p".repeat(pathChars)}${index}`, content: "c".repeat(100) },
				readOnly: !writes,
			};
		});
	}

	const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

	it("drops the argument previews of the oldest read-only calls first to fit 64 KB", () => {
		const recorded = details(calls(200, 200));
		expect(bytes(recorded)).toBeLessThanOrEqual(64 * 1024);
		expect(recorded.complete).toBe(false);
		expect(recorded.calls).toHaveLength(200);
		const reads = recorded.calls.filter((call) => call.readOnly);
		const firstKept = reads.findIndex((call) => call.argsPreview !== undefined);
		expect(firstKept).toBeGreaterThan(0);
		// Previews were dropped from the oldest read-only calls, and every later one kept its preview.
		expect(reads.slice(firstKept).every((call) => call.argsPreview !== undefined)).toBe(true);
		expect(recorded.calls.filter((call) => !call.readOnly).every((call) => call.argsPreview !== undefined)).toBe(
			true,
		);
		expect(recorded.callTotals.completed).toBe(200);
	});

	it("then drops the oldest read-only records, never a state-changing one", () => {
		const recorded = details(calls(200, 1000));
		expect(bytes(recorded)).toBeLessThanOrEqual(64 * 1024);
		expect(recorded.complete).toBe(false);
		const writes = recorded.calls.filter((call) => !call.readOnly);
		expect(writes).toHaveLength(50);
		expect(writes.every((call) => call.argsPreview !== undefined && call.path !== undefined)).toBe(true);
		const reads = recorded.calls.filter((call) => call.readOnly).map((call) => call.seq);
		expect(reads.length).toBeLessThan(150);
		// The newest read-only records are the ones kept.
		const allReads = calls(200, 0)
			.filter((call) => call.readOnly)
			.map((call) => call.seq);
		expect(reads).toStrictEqual(allReads.slice(allReads.length - reads.length));
		// Totals stay exact.
		expect(recorded.callTotals.completed).toBe(200);
	});

	it("keeps every record of a run that fits, and caps errors at 256 characters", () => {
		const [failed] = calls(1, 10);
		const recorded = details([{ ...failed, status: "failed", error: { kind: "failed", message: "x".repeat(1000) } }]);
		expect(recorded.complete).toBe(true);
		expect(recorded.calls[0].error).toHaveLength(256);
		expect(recorded.callTotals).toStrictEqual({ completed: 0, failed: 1, cancelled: 0, unsettled: 0 });
	});
});
