import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@hansjm10/volt-agent-core";
import type { ImageContent, JsonObject, JsonValue, TextContent } from "@hansjm10/volt-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import { afterAll, describe, expect, it } from "vitest";
import type { CodeModeBindingSpec } from "../../src/core/code-mode/bindings.ts";
import { type CodeModeDispatchHost, createCodeModeCallHandler } from "../../src/core/code-mode/dispatch.ts";
import { CodeModeImageStore } from "../../src/core/code-mode/images.ts";
import { type CodeModeCall, CodeModeCallError } from "../../src/core/code-mode/runtime.ts";
import { CodeModeCallScheduler, CodeModeServerLimiter } from "../../src/core/code-mode/scheduler.ts";
import type { ExtensionOperationOrigin } from "../../src/core/extensions/index.ts";
import { callToolResultToText, McpToolUnavailableError } from "../../src/core/mcp/manager.ts";
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
	signal: AbortSignal;
}

interface FakeHostOptions {
	tools: AgentTool[];
	trusted?: string[];
	inactive?: string[];
	decide?: (
		call: TurnToolCall,
		signal: AbortSignal,
	) => ToolCallDecision | undefined | Promise<ToolCallDecision | undefined>;
	patchResult?: (event: ResultCall) => ToolResultPatch | undefined;
	/** The session's MCP manager; without it, MCP calls fail as unavailable. */
	mcp?: (server: string, tool: string, args: JsonObject, signal: AbortSignal) => Promise<CallToolResult>;
	serverLimit?: number;
}

/** A session stand-in that records what reaches its policies. */
function fakeHost(options: FakeHostOptions) {
	const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
	const inactive = new Set(options.inactive);
	const trusted = new Set(options.trusted);
	const policyCalls: PolicyCall[] = [];
	const resultCalls: ResultCall[] = [];
	const mcpCalls: Array<{ server: string; tool: string; args: JsonObject }> = [];
	const limitRequests: string[] = [];
	const host: CodeModeDispatchHost = {
		cwd,
		isToolActive: (name) => tools.has(name) && !inactive.has(name),
		tool: (name) => {
			const registered = tools.get(name);
			return registered && { tool: registered, trustedBuiltin: trusted.has(name) };
		},
		*toolCallPolicies(signal, origin) {
			yield async (call) => {
				policyCalls.push({ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input, origin });
				return await options.decide?.(call, signal);
			};
		},
		toolResult: async (event, signal, origin) => {
			const recorded = { ...event, origin, signal };
			resultCalls.push(recorded);
			return options.patchResult?.(recorded);
		},
		callMcpTool: async (server, tool, args, signal) => {
			mcpCalls.push({ server, tool, args: structuredClone(args) });
			if (!options.mcp) throw new McpToolUnavailableError("MCP is not available in this session");
			return await options.mcp(server, tool, args, signal);
		},
		mcpServerLimit: (server) => {
			limitRequests.push(server);
			return options.serverLimit ?? 4;
		},
	};
	return { host, tools, inactive, trusted, policyCalls, resultCalls, mcpCalls, limitRequests };
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

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";

/** The built-in gateway as nested-call dispatch uses it: its schema. Dispatch never runs it. */
function gateway(): AgentTool {
	return {
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
			throw new Error("the gateway does not run nested calls");
		},
		executionMode: "sequential",
	} as AgentTool;
}

/** The direct tool of `github.search`, with the MCP tool's schema. Dispatch never runs it. */
function directTool(): AgentTool {
	return {
		name: "mcp__github__search",
		label: "search",
		description: "search",
		parameters: Type.Object({ query: Type.String(), background: Type.Optional(Type.Boolean()) }),
		execute: async () => {
			throw new Error("the direct tool does not run nested calls");
		},
		executionMode: "sequential",
	} as AgentTool;
}

function searchResult(): CallToolResult {
	return {
		content: [
			{ type: "text", text: "found 2 issues" },
			{ type: "image", data: PNG_1X1, mimeType: "image/png" },
		],
		structuredContent: { issues: [1, 2] },
	};
}

function mcpBinding(server: string, tool: string, toolName: string): CodeModeBindingSpec {
	const path = ["mcp", server, tool];
	return { name: JSON.stringify(path), path, target: { kind: "mcp", server, tool, toolName } };
}

function mcpCall(
	seq: number,
	server: string,
	tool: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
): CodeModeCall {
	return { ...call(seq, tool, args, signal), binding: JSON.stringify(["mcp", server, tool]) };
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

	it("rejects a call cancelled while a policy is pending, which rejects on the abort, as cancelled before it ran", async () => {
		let executed = false;
		const { host } = fakeHost({
			tools: [
				tool("write", async () => {
					executed = true;
					return text("written");
				}),
			],
			decide: (_call, signal) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("approval withdrawn")), { once: true });
				}),
		});
		const controller = new AbortController();
		const pending = handlerFor(host, [binding("write")])(call(1, "write", {}, controller.signal));
		await settle();
		controller.abort(new Error("the script ended"));
		expect(await rejection(pending)).toMatchObject({ kind: "cancelled", reason: "not_started" });
		expect(executed).toBe(false);
	});

	it("rejects a call aborted while it runs as cancelled, with none of the tool's output", async () => {
		const { host } = fakeHost({
			tools: [
				tool("read", (_id, _args, signal) => {
					return new Promise((resolve) => {
						signal?.addEventListener("abort", () => resolve(text("secret token 1234")), { once: true });
					});
				}),
			],
			patchResult: () => ({ content: [{ type: "text", text: "[redacted]" }], isError: false }),
		});
		const controller = new AbortController();
		const pending = handlerFor(host, [binding("read")])(call(1, "read", {}, controller.signal));
		await settle();
		controller.abort();
		const error = await rejection(pending);
		expect(error).toMatchObject({ kind: "cancelled", message: "The call was cancelled" });
		expect(error.reason).toBeUndefined();
	});

	it("gives the tool-result policy the call's signal, which shows a script that stopped during the call", async () => {
		const { host, resultCalls } = fakeHost({
			tools: [
				tool("read", (_id, _args, signal) => {
					return new Promise((resolve) => {
						signal?.addEventListener("abort", () => resolve(text("partial")), { once: true });
					});
				}),
			],
		});
		const controller = new AbortController();
		const pending = handlerFor(host, [binding("read")])(call(1, "read", {}, controller.signal));
		await settle();
		controller.abort();
		await rejection(pending);
		expect(resultCalls).toHaveLength(1);
		expect(resultCalls[0]!.signal).toBe(controller.signal);
		expect(resultCalls[0]!.signal.aborted).toBe(true);
	});

	it("projects a result by the trust of the tool that ran, even when the registry changes while it runs", async () => {
		const file = join(cwd, "extension-output.txt");
		writeFileSync(file, "read from the full output file\n");
		let finish: () => void = () => {};
		const extensionBash = tool(
			"bash",
			async () =>
				await new Promise<AgentToolResult<unknown>>((resolve) => {
					finish = () =>
						resolve({
							content: [{ type: "text", text: "extension output" }],
							details: { exitCode: 0, truncation: { truncated: true }, fullOutputPath: file },
						});
				}),
		);
		const { host, tools, trusted } = fakeHost({ tools: [extensionBash] });
		const pending = handlerFor(host, [binding("bash")])(call(1, "bash", {}));
		await settle();
		// The trusted built-in takes the name while the extension's tool runs.
		tools.set(
			"bash",
			tool("bash", async () => text("built-in")),
		);
		trusted.add("bash");
		finish();
		expect(await pending).toBe("extension output");
	});

	it("runs an MCP call through the gateway's policies and the session's MCP manager, with its nested call id and origin", async () => {
		const raw = searchResult();
		const { host, policyCalls, resultCalls, mcpCalls, limitRequests } = fakeHost({
			tools: [gateway()],
			mcp: async () => raw,
		});
		const value = await handlerFor(host, [mcpBinding("github", "search", "mcp")])(
			mcpCall(4, "github", "search", { query: "bug" }),
		);
		const origin = { kind: "code_mode", parentToolCallId: "parent", seq: 4 };
		const input = { action: "call", server: "github", tool: "search", arguments: { query: "bug" } };
		expect(policyCalls).toStrictEqual([{ toolCallId: "parent:cm:4", toolName: "mcp", input, origin }]);
		expect(mcpCalls).toStrictEqual([{ server: "github", tool: "search", args: { query: "bug" } }]);
		expect(limitRequests).toStrictEqual(["github"]);
		// The tool-result policy sees the complete result as text, without details.
		expect(resultCalls).toHaveLength(1);
		expect(resultCalls[0]).toMatchObject({
			toolName: "mcp",
			toolCallId: "parent:cm:4",
			input,
			content: [{ type: "text", text: callToolResultToText(raw) }],
			isError: false,
			origin,
		});
		expect(resultCalls[0]).not.toHaveProperty("details");
		expect(value).toMatchObject({
			text: "found 2 issues",
			structured: { issues: [1, 2] },
			images: [{ type: "image", mimeType: "image/png" }],
		});
	});

	it("runs an MCP call through its direct tool's validation and policies when that tool is its route", async () => {
		const { host, policyCalls, mcpCalls } = fakeHost({
			tools: [directTool()],
			mcp: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});
		const handle = handlerFor(host, [mcpBinding("github", "search", "mcp__github__search")]);
		expect(await handle(mcpCall(1, "github", "search", { query: "bug" }))).toStrictEqual({ text: "ok", images: [] });
		expect(await rejection(handle(mcpCall(2, "github", "search", { query: { nested: true } })))).toMatchObject({
			kind: "invalid_arguments",
		});
		expect(policyCalls).toStrictEqual([
			{
				toolCallId: "parent:cm:1",
				toolName: "mcp__github__search",
				input: { query: "bug" },
				origin: { kind: "code_mode", parentToolCallId: "parent", seq: 1 },
			},
		]);
		expect(mcpCalls).toStrictEqual([{ server: "github", tool: "search", args: { query: "bug" } }]);
	});

	it("schedules MCP calls with their server's limit", async () => {
		const releases: Array<() => void> = [];
		const { host, mcpCalls } = fakeHost({
			tools: [gateway()],
			serverLimit: 1,
			mcp: () =>
				new Promise((resolve) => {
					releases.push(() => resolve({ content: [{ type: "text", text: "done" }] }));
				}),
		});
		const handle = handlerFor(host, [mcpBinding("github", "search", "mcp")]);
		const first = handle(mcpCall(1, "github", "search", {}));
		const second = handle(mcpCall(2, "github", "search", {}));
		await settle();
		expect(mcpCalls).toHaveLength(1);
		releases[0]!();
		await first;
		await settle();
		expect(mcpCalls).toHaveLength(2);
		releases[1]!();
		expect(await second).toStrictEqual({ text: "done", images: [] });
	});

	it("rejects an MCP call whose routing tool is no longer active or was replaced, before any policy runs", async () => {
		const { host, tools, inactive, policyCalls, mcpCalls } = fakeHost({
			tools: [gateway()],
			mcp: async () => ({ content: [] }),
		});
		const handle = handlerFor(host, [mcpBinding("github", "search", "mcp")]);
		inactive.add("mcp");
		expect(await rejection(handle(mcpCall(1, "github", "search", {})))).toMatchObject({
			kind: "failed",
			reason: "unavailable",
			message: "mcp is no longer available in this session",
		});
		inactive.clear();
		tools.set("mcp", gateway());
		expect(await rejection(handle(mcpCall(2, "github", "search", {})))).toMatchObject({
			kind: "failed",
			reason: "unavailable",
		});
		expect([policyCalls, mcpCalls]).toStrictEqual([[], []]);
	});

	it("calls the binding's MCP tool with the checked arguments, whatever a policy does to its copy of the call", async () => {
		const { host, mcpCalls } = fakeHost({
			tools: [gateway(), directTool()],
			decide: (decided) => {
				const input = decided.input;
				input.server = "other";
				input.tool = "delete_repository";
				input.query = "changed";
				if (input.arguments !== null && typeof input.arguments === "object" && !Array.isArray(input.arguments)) {
					input.arguments.query = "changed";
				}
				return undefined;
			},
			mcp: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});
		await handlerFor(host, [mcpBinding("github", "search", "mcp")])(mcpCall(1, "github", "search", { query: "bug" }));
		await handlerFor(host, [mcpBinding("github", "search", "mcp__github__search")])(
			mcpCall(1, "github", "search", { query: "bug" }),
		);
		expect(mcpCalls).toStrictEqual([
			{ server: "github", tool: "search", args: { query: "bug" } },
			{ server: "github", tool: "search", args: { query: "bug" } },
		]);
	});

	it("passes background through to an MCP tool and rejects BigInt arguments", async () => {
		const { host, policyCalls, mcpCalls } = fakeHost({
			tools: [directTool()],
			mcp: async () => ({ content: [{ type: "text", text: "ok" }] }),
		});
		const handle = handlerFor(host, [mcpBinding("github", "search", "mcp__github__search")]);
		expect(await handle(mcpCall(1, "github", "search", { query: "bug", background: true }))).toStrictEqual({
			text: "ok",
			images: [],
		});
		expect(mcpCalls).toStrictEqual([{ server: "github", tool: "search", args: { query: "bug", background: true } }]);
		expect(await rejection(handle(mcpCall(2, "github", "search", { query: "bug", id: 2n ** 70n })))).toMatchObject({
			kind: "invalid_arguments",
			message: "args.id: a BigInt is not a valid tool argument",
		});
		expect(policyCalls.map((policyCall) => policyCall.toolCallId)).toStrictEqual(["parent:cm:1"]);
	});

	it("rejects an MCP call that fails before its request is sent as unavailable, after the tool-result policy sees the failure", async () => {
		const failures: unknown[] = [
			new McpToolUnavailableError("MCP server needs authentication: github. Sign in with `volt mcp auth github`."),
			new Error("MCP error -32603: internal error"),
		];
		const { host, resultCalls } = fakeHost({
			tools: [gateway()],
			mcp: async () => {
				const failure = failures.shift();
				if (failure) throw failure;
				return { content: [{ type: "text", text: "rate limited" }], isError: true };
			},
		});
		const handle = handlerFor(host, [mcpBinding("github", "search", "mcp")]);
		const unavailable = await rejection(handle(mcpCall(1, "github", "search", {})));
		expect(unavailable).toMatchObject({
			kind: "failed",
			reason: "unavailable",
			message: "MCP server needs authentication: github. Sign in with `volt mcp auth github`.",
		});
		// A failure after the request was sent, or an error result, has no reason.
		const failed = await rejection(handle(mcpCall(2, "github", "search", {})));
		expect([failed.kind, failed.reason, failed.message]).toStrictEqual([
			"failed",
			undefined,
			"MCP error -32603: internal error",
		]);
		const errorResult = await rejection(handle(mcpCall(3, "github", "search", {})));
		expect([errorResult.kind, errorResult.reason, errorResult.message]).toStrictEqual([
			"failed",
			undefined,
			"rate limited",
		]);
		expect(resultCalls.map(({ content, isError }) => ({ content, isError }))).toStrictEqual([
			{ content: [{ type: "text", text: unavailable.message }], isError: true },
			{ content: [{ type: "text", text: "MCP error -32603: internal error" }], isError: true },
			{ content: [{ type: "text", text: "rate limited" }], isError: true },
		]);
	});

	it("projects an MCP result in full unless a hook changes it, then gives only the text the hook left", async () => {
		const search = mcpBinding("github", "search", "mcp");
		const valueWith = async (patchResult: FakeHostOptions["patchResult"]) => {
			const { host } = fakeHost({ tools: [gateway()], mcp: async () => searchResult(), patchResult });
			return await handlerFor(host, [search])(mcpCall(1, "github", "search", {}));
		};
		// Hooks that ran and left the result as it was.
		expect(await valueWith((event) => ({ content: event.content, isError: event.isError }))).toMatchObject({
			text: "found 2 issues",
			structured: { issues: [1, 2] },
			images: [{ type: "image" }],
		});
		const redacted = { content: [{ type: "text" as const, text: "[redacted]" }], isError: false };
		expect(await valueWith(() => redacted)).toStrictEqual({ text: "[redacted]", images: [] });
		const denied = await rejection(
			valueWith(() => ({ content: [{ type: "text", text: "denied by policy" }], isError: true })),
		);
		expect([denied.kind, denied.reason, denied.message]).toStrictEqual(["failed", undefined, "denied by policy"]);
	});
});
