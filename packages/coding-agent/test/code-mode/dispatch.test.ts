import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@hansjm10/volt-agent-core";
import type { ImageContent, JsonObject, JsonValue, TextContent } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterAll, describe, expect, it } from "vitest";
import type { CodeModeBindingSpec } from "../../src/core/code-mode/bindings.ts";
import { type CodeModeDispatchHost, createCodeModeCallHandler } from "../../src/core/code-mode/dispatch.ts";
import { CodeModeImageStore } from "../../src/core/code-mode/images.ts";
import { type CodeModeCall, CodeModeCallError } from "../../src/core/code-mode/runtime.ts";
import { CodeModeCallScheduler, CodeModeServerLimiter } from "../../src/core/code-mode/scheduler.ts";
import type { ExtensionOperationOrigin } from "../../src/core/extensions/index.ts";
import type { ToolCallDecision, TurnToolCall } from "../../src/core/session/turn-policy.ts";

const cwd = mkdtempSync(join(tmpdir(), "volt-code-mode-dispatch-"));
afterAll(() => rmSync(cwd, { recursive: true, force: true }));

type ToolResultPatch = { content: Array<TextContent | ImageContent>; details?: JsonValue; isError: boolean };

interface PolicyCall {
	toolCallId: string;
	toolName: string;
	input: JsonObject;
	origin: ExtensionOperationOrigin;
}

interface ResultCall extends PolicyCall {
	content: Array<TextContent | ImageContent>;
	details?: JsonValue;
	isError: boolean;
}

interface FakeHostOptions {
	tools: AgentTool[];
	trusted?: string[];
	inactive?: string[];
	decide?: (call: TurnToolCall) => ToolCallDecision | undefined | Promise<ToolCallDecision | undefined>;
	patchResult?: (event: ResultCall) => ToolResultPatch | undefined;
}

/** A session stand-in that records what reaches its policies. */
function fakeHost(options: FakeHostOptions) {
	const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
	const inactive = new Set(options.inactive);
	const policyCalls: PolicyCall[] = [];
	const resultCalls: ResultCall[] = [];
	const host: CodeModeDispatchHost = {
		cwd,
		isToolActive: (name) => tools.has(name) && !inactive.has(name),
		tool: (name) => tools.get(name),
		isTrustedBuiltin: (name) => options.trusted?.includes(name) ?? false,
		*toolCallPolicies(_signal, origin) {
			yield async (call) => {
				policyCalls.push({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input, origin });
				return await options.decide?.(call);
			};
		},
		toolResult: async (event, origin) => {
			const recorded = { ...event, origin };
			resultCalls.push(recorded);
			return options.patchResult?.(recorded);
		},
	};
	return { host, tools, inactive, policyCalls, resultCalls };
}

function tool(
	name: string,
	execute: (
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<AgentToolResult<unknown>>,
	extra: Partial<AgentTool> = {},
): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({ path: Type.Optional(Type.String()), background: Type.Optional(Type.Boolean()) }),
		execute: (toolCallId, args, signal) => execute(toolCallId, args as Record<string, unknown>, signal),
		...extra,
	} as AgentTool;
}

const text = (value: string): AgentToolResult<unknown> => ({ content: [{ type: "text", text: value }] });

function binding(toolName: string): CodeModeBindingSpec {
	return { name: JSON.stringify([toolName]), path: [toolName], target: { kind: "tool", toolName } };
}

function handlerFor(host: CodeModeDispatchHost, bindings: CodeModeBindingSpec[]) {
	return createCodeModeCallHandler({
		host,
		bindings,
		parentToolCallId: "parent",
		scheduler: new CodeModeCallScheduler({ limiter: new CodeModeServerLimiter() }),
	});
}

function call(seq: number, toolName: string, args: Record<string, unknown>, signal?: AbortSignal): CodeModeCall {
	return {
		seq,
		binding: JSON.stringify([toolName]),
		args,
		signal: signal ?? new AbortController().signal,
		images: new CodeModeImageStore().stage(),
		maxValueBytes: 1024 * 1024,
	};
}

async function rejection(promise: Promise<unknown>): Promise<CodeModeCallError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof CodeModeCallError) return error;
		throw error;
	}
	throw new Error("expected the call to reject");
}

function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("code mode call dispatch", () => {
	it("runs a call through the policies and the tool with its nested call id and origin", async () => {
		const executed: string[] = [];
		const { host, policyCalls, resultCalls } = fakeHost({
			tools: [
				tool("read", async (toolCallId, args) => {
					executed.push(toolCallId);
					return text(`read ${String(args.path)}`);
				}),
			],
		});
		const value = await handlerFor(host, [binding("read")])(call(3, "read", { path: "a.ts" }));
		expect(value).toBe("read a.ts");
		const origin = { kind: "code_mode", parentToolCallId: "parent", seq: 3 };
		expect(policyCalls).toStrictEqual([
			{ toolCallId: "parent:cm:3", toolName: "read", input: { path: "a.ts" }, origin },
		]);
		expect(executed).toStrictEqual(["parent:cm:3"]);
		expect(resultCalls).toMatchObject([{ toolCallId: "parent:cm:3", isError: false, origin }]);
	});

	it("rejects a call to a tool that is no longer active or was replaced, before any policy runs", async () => {
		const read = tool("read", async () => text("ok"));
		const { host, tools, inactive, policyCalls } = fakeHost({ tools: [read] });
		const handle = handlerFor(host, [binding("read")]);
		inactive.add("read");
		expect(await rejection(handle(call(1, "read", {})))).toMatchObject({ kind: "failed", reason: "unavailable" });
		inactive.clear();
		tools.set(
			"read",
			tool("read", async () => text("replacement")),
		);
		expect(await rejection(handle(call(2, "read", {})))).toMatchObject({ kind: "failed", reason: "unavailable" });
		expect(policyCalls).toStrictEqual([]);
	});

	it("prepares and validates arguments as the agent loop does", async () => {
		const prepared = tool("read", async (_id, args) => text(String(args.path)), {
			prepareArguments: (args: unknown) => {
				const record = args as Record<string, unknown>;
				return { path: record.file_path ?? record.path };
			},
		});
		const { host, policyCalls } = fakeHost({ tools: [prepared] });
		const handle = handlerFor(host, [binding("read")]);
		expect(await handle(call(1, "read", { file_path: "legacy.ts" }))).toBe("legacy.ts");
		// Validation coerces primitives as it does for model calls, so an object stands in for a wrong type.
		const invalid = await rejection(handle(call(2, "read", { path: { nested: true } })));
		expect(invalid.kind).toBe("invalid_arguments");
		expect(invalid.message).toMatch(/path/);
		const big = await rejection(handle(call(3, "read", { path: "a", line: 2n ** 70n })));
		expect(big).toMatchObject({
			kind: "invalid_arguments",
			message: "args.line: a BigInt is not a valid tool argument",
		});
		expect(policyCalls.map((policyCall) => policyCall.toolCallId)).toStrictEqual(["parent:cm:1"]);
	});

	it("rejects background jobs without running the policies or the tool", async () => {
		let executed = false;
		const { host, policyCalls } = fakeHost({
			tools: [
				tool("bash", async () => {
					executed = true;
					return text("ran");
				}),
			],
		});
		const error = await rejection(handlerFor(host, [binding("bash")])(call(1, "bash", { background: true })));
		expect(error).toMatchObject({ kind: "invalid_arguments", message: "Scripts cannot start background jobs" });
		expect([executed, policyCalls.length]).toStrictEqual([false, 0]);
	});

	it("rejects a call the policy blocks, with its reason", async () => {
		let executed = false;
		const { host } = fakeHost({
			tools: [
				tool("write", async () => {
					executed = true;
					return text("written");
				}),
			],
			decide: () => ({ block: true, reason: "writes need approval" }),
		});
		const error = await rejection(handlerFor(host, [binding("write")])(call(1, "write", {})));
		expect(error).toMatchObject({ kind: "blocked", message: "writes need approval" });
		expect(executed).toBe(false);
	});

	it("passes a tool's failure through the tool-result policy and rejects with it", async () => {
		const { host, resultCalls } = fakeHost({
			tools: [
				tool("read", async () => {
					throw new Error("ENOENT: no such file");
				}),
			],
		});
		const error = await rejection(handlerFor(host, [binding("read")])(call(1, "read", { path: "missing" })));
		expect(error).toMatchObject({ kind: "failed", message: "ENOENT: no such file" });
		expect(resultCalls).toMatchObject([{ isError: true, content: [{ type: "text", text: "ENOENT: no such file" }] }]);
	});

	it("passes the tool-result policy's result to the projection, which then never reads the full output file", async () => {
		const file = join(cwd, "full-output.txt");
		writeFileSync(file, "secret token 1234\n");
		const bash = tool("bash", async () => ({
			content: [{ type: "text", text: "secret token 1234\n" }],
			details: { exitCode: 0, truncation: { truncated: true }, fullOutputPath: file },
		}));
		const unchanged = fakeHost({ tools: [bash], trusted: ["bash"] });
		expect(await handlerFor(unchanged.host, [binding("bash")])(call(1, "bash", {}))).toStrictEqual({
			output: "secret token 1234\n",
			exitCode: 0,
			truncated: false,
			fullOutputPath: file,
		});
		// A hook that redacts the result also keeps the script from reading the full output file.
		const redacted = fakeHost({
			tools: [bash],
			trusted: ["bash"],
			patchResult: (event) => ({
				content: [{ type: "text", text: "[redacted]" }],
				details: event.details,
				isError: false,
			}),
		});
		const value = await handlerFor(redacted.host, [binding("bash")])(call(1, "bash", {}));
		expect(value).toMatchObject({ output: "[redacted]", exitCode: 0 });
		expect(value).not.toHaveProperty("fullOutputPath");
	});

	it("runs the checks of a later call only after an earlier call's checks finish", async () => {
		let approve: () => void = () => {};
		const approval = new Promise<void>((resolve) => {
			approve = resolve;
		});
		const { host, policyCalls } = fakeHost({
			tools: [tool("write", async () => text("written"))],
			decide: async (decided) => {
				if (decided.toolCallId === "parent:cm:1") await approval;
				return undefined;
			},
		});
		const handle = handlerFor(host, [binding("write")]);
		const first = handle(call(1, "write", {}));
		const second = handle(call(2, "write", {}));
		await settle();
		expect(policyCalls.map((policyCall) => policyCall.toolCallId)).toStrictEqual(["parent:cm:1"]);
		approve();
		expect(await Promise.all([first, second])).toStrictEqual(["written", "written"]);
		expect(policyCalls.map((policyCall) => policyCall.toolCallId)).toStrictEqual(["parent:cm:1", "parent:cm:2"]);
	});

	it("rejects a call cancelled while it waits to run as cancelled before it ran", async () => {
		let finish: () => void = () => {};
		let executions = 0;
		const exclusive = tool(
			"deploy",
			async () => {
				executions++;
				await new Promise<void>((resolve) => {
					finish = resolve;
				});
				return text("deployed");
			},
			{ executionMode: "sequential" },
		);
		const { host } = fakeHost({ tools: [exclusive] });
		const handle = handlerFor(host, [binding("deploy")]);
		const running = handle(call(1, "deploy", {}));
		const controller = new AbortController();
		const queued = handle(call(2, "deploy", {}, controller.signal));
		await settle();
		controller.abort(new Error("the script ended"));
		expect(await rejection(queued)).toMatchObject({ kind: "cancelled", reason: "not_started" });
		finish();
		expect(await running).toBe("deployed");
		expect(executions).toBe(1);
	});

	it("rejects a call aborted while it runs as cancelled", async () => {
		const { host } = fakeHost({
			tools: [
				tool("read", (_id, _args, signal) => {
					return new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(new Error("Operation aborted")), { once: true });
					});
				}),
			],
		});
		const controller = new AbortController();
		const pending = handlerFor(host, [binding("read")])(call(1, "read", {}, controller.signal));
		await settle();
		controller.abort();
		expect(await rejection(pending)).toMatchObject({ kind: "cancelled", message: "Operation aborted" });
	});

	it("rejects calls to MCP tools as unavailable until MCP dispatch exists", async () => {
		const { host } = fakeHost({ tools: [] });
		const mcp: CodeModeBindingSpec = {
			name: '["mcp","github","x"]',
			path: ["mcp", "github", "x"],
			target: { kind: "mcp", server: "github", tool: "x" },
		};
		const error = await rejection(handlerFor(host, [mcp])({ ...call(1, "x", {}), binding: mcp.name }));
		expect(error).toMatchObject({ kind: "failed", reason: "unavailable" });
	});
});
