import { isDeepStrictEqual } from "node:util";
import type { AgentTool, AgentToolResult } from "@hansjm10/volt-agent-core";
import {
	type ImageContent,
	type JsonObject,
	type JsonValue,
	type TextContent,
	validateToolArguments,
} from "@hansjm10/volt-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ExtensionOperationOrigin } from "../extensions/index.ts";
import { DEFAULT_MCP_MAX_CONCURRENT_CALLS } from "../mcp/config.ts";
import { callToolResultToText, McpToolUnavailableError } from "../mcp/manager.ts";
import type { SessionToolRuntime } from "../session/tool-runtime.ts";
import {
	reduceToolCall,
	type SessionTurnPolicy,
	type ToolCallPolicy,
	type TurnToolCall,
} from "../session/turn-policy.ts";
import { withoutBackgroundJobs } from "../tools/background.ts";
import type { CodeModeBindingSpec, CodeModeBindingTarget } from "./bindings.ts";
import { projectMcpResult, projectToolResult } from "./projections.ts";
import { type CodeModeCall, CodeModeCallError } from "./runtime.ts";
import { CodeModeCallScheduler, schedulingClassFor } from "./scheduler.ts";

/** A tool result as the tool-result policy receives and returns it. */
export interface CodeModeToolResultEvent {
	toolName: string;
	toolCallId: string;
	input: JsonObject;
	content: Array<TextContent | ImageContent>;
	details?: JsonValue;
	isError: boolean;
}

/** A registered tool, as the session runs it, and whether it is the trusted built-in tool of its name. */
export interface CodeModeHostTool {
	readonly tool: AgentTool;
	readonly trustedBuiltin: boolean;
}

/** The session as nested-call dispatch uses it: its tools and the policies model calls go through. */
export interface CodeModeDispatchHost {
	/** The session's working directory. */
	readonly cwd: string;
	isToolActive(name: string): boolean;
	/** The registered tool of that name and its trust, read together from the same registry. */
	tool(name: string): CodeModeHostTool | undefined;
	/** The session's tool-call policies, whose hooks observe `signal`, attributing the call to `origin`. */
	toolCallPolicies(signal: AbortSignal, origin: ExtensionOperationOrigin): Iterable<ToolCallPolicy<TurnToolCall>>;
	/**
	 * The session's tool-result policy, whose hooks observe `signal`, attributing the call to `origin`. Resolves with
	 * the result as `tool_result` hooks left it, or undefined when no hook saw it.
	 */
	toolResult(
		event: CodeModeToolResultEvent,
		signal: AbortSignal,
		origin: ExtensionOperationOrigin,
	): Promise<Omit<CodeModeToolResultEvent, "toolName" | "toolCallId" | "input"> | undefined>;
	/**
	 * Calls an MCP tool through the session's MCP manager, as the model's call to it would be, limited to trusted
	 * reads while a grant profile restricts the session. Resolves with the result as the server sent it. A failure
	 * before the request is sent, including a session without MCP, rejects with `McpToolUnavailableError`.
	 */
	callMcpTool(server: string, tool: string, args: JsonObject, signal: AbortSignal): Promise<CallToolResult>;
	/** Calls to the MCP server from scripts that may run at once, across the process. */
	mcpServerLimit(server: string): number;
}

/** A session's tools and turn policy as nested-call dispatch uses them. */
export function codeModeDispatchHostOf(
	tools: SessionToolRuntime,
	turnPolicy: SessionTurnPolicy,
	cwd: string,
): CodeModeDispatchHost {
	return {
		cwd,
		isToolActive: (name) => tools.isToolActive(name),
		tool: (name) => {
			const tool = tools.registeredTool(name);
			return tool === undefined ? undefined : { tool, trustedBuiltin: tools.isTrustedBuiltin(name) };
		},
		toolCallPolicies: (signal, origin) => turnPolicy.toolCallPolicies(signal, origin),
		toolResult: (event, signal, origin) => turnPolicy.toolResult(event, { signal, origin }),
		callMcpTool: async (server, tool, args, signal) => {
			const manager = tools.getMcpManager();
			if (!manager) throw new McpToolUnavailableError("MCP is not available in this session");
			// Read at call time, as the gateway reads it: the session may have entered a restricted mode since.
			const restricted = tools.isOperationRestricted();
			const called = await manager.callToolRaw(
				server,
				tool,
				args,
				{ surface: "model", caller: "model", ...(restricted ? { restrictedTrustedRead: true } : {}) },
				signal,
			);
			return called.result;
		},
		mcpServerLimit: (server) =>
			tools.getMcpManager()?.getMaxConcurrentCalls(server) ?? DEFAULT_MCP_MAX_CONCURRENT_CALLS,
	};
}

export interface CodeModeCallHandlerOptions {
	host: CodeModeDispatchHost;
	/** The script's bindings, fixed when it started. */
	bindings: readonly CodeModeBindingSpec[];
	/** The ID of the code-mode tool call running the script. */
	parentToolCallId: string;
	/** Schedules the script's calls; one per script. */
	scheduler?: CodeModeCallScheduler;
}

/**
 * The `onCall` handler of one script (section 5.9 of docs/code-mode-design.md). After the runtime's checks, each
 * nested call goes through the rest of the host checks, the same way a model-issued call does. A call to an MCP
 * tool is checked as the call of the tool the model would make it through: the built-in `mcp` gateway, with the
 * input `{ action: "call", server, tool, arguments }`, or the MCP tool's direct tool, with the arguments as input.
 *
 * 6. The tool is still active and is the tool it was when the script started; otherwise `failed` (`unavailable`).
 *    The tool's trust, read with it then, picks the call's projection.
 * 7. Arguments are prepared and validated as the agent loop does; otherwise `invalid_arguments`. A built-in or
 *    extension tool call cannot start a background job; MCP arguments go to the server as they are.
 * 8. The session's tool-call policy, with a `code_mode` origin and the ID `<parentToolCallId>:cm:<seq>`; a denial
 *    rejects with `blocked`. Policies see copies of the call, so it runs with the input checked here.
 * 9. The scheduler starts the call, which runs outside any background-job scope. A built-in or extension tool runs
 *    as registered; an MCP tool runs through the session's MCP manager, limited per server, with the binding's
 *    server and tool and the validated arguments.
 * 10. The session's tool-result policy, whose hooks observe the call's signal, then the call's projection into a
 *     script value. Hooks see an MCP result as its complete text. Unless they change it, the value is the full
 *     MCP projection; once they do, it is the text they left, without structured content or images.
 *
 * Checks 6 to 8 run in submission order: a call's checks start once the earlier call's have finished, as the agent
 * loop prepares calls in order. A call cancelled before its tool starts rejects with `cancelled` (`not_started`),
 * whatever failed on the way; a call cancelled after rejects with `cancelled` and none of the tool's output. An MCP
 * call that fails before its request is sent rejects with `failed` (`unavailable`).
 */
export function createCodeModeCallHandler(
	options: CodeModeCallHandlerOptions,
): (call: CodeModeCall) => Promise<unknown> {
	const { host, parentToolCallId } = options;
	const scheduler = options.scheduler ?? new CodeModeCallScheduler();
	const bindings = new Map(options.bindings.map((binding) => [binding.name, binding]));
	// The tool each binding's calls go through as it was when the script started; a tool replaced since is no longer
	// available.
	const toolsAtStart = new Map<string, CodeModeHostTool | undefined>();
	for (const { target } of options.bindings) toolsAtStart.set(target.toolName, host.tool(target.toolName));
	let checks: Promise<unknown> = Promise.resolve();

	return async (call) => {
		const binding = bindings.get(call.binding);
		if (!binding) throw new CodeModeCallError("failed", `the script has no binding ${call.binding}`, "unavailable");
		const { target } = binding;
		const { toolName } = target;
		const toolCallId = `${parentToolCallId}:cm:${call.seq}`;
		const origin: ExtensionOperationOrigin = { kind: "code_mode", parentToolCallId, seq: call.seq };

		const check = async (): Promise<{ registered: CodeModeHostTool; input: JsonObject }> => {
			// Skips the checks, and the policy's hooks, for a call that can no longer start.
			if (call.signal.aborted) throw notStarted();
			const registered = toolsAtStart.get(toolName);
			if (!registered || host.tool(toolName)?.tool !== registered.tool || !host.isToolActive(toolName)) {
				throw new CodeModeCallError("failed", `${toolName} is no longer available in this session`, "unavailable");
			}
			const bigint = bigintPath(call.args, "args");
			if (bigint !== undefined) {
				throw new CodeModeCallError("invalid_arguments", `${bigint}: a BigInt is not a valid tool argument`);
			}
			const { tool } = registered;
			// The routing tool's input: the gateway's call action, or the arguments themselves.
			const args = isGatewayRoute(target)
				? { action: "call", server: target.server, tool: target.tool, arguments: call.args }
				: call.args;
			let input: JsonObject;
			try {
				const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
				input = validateToolArguments(tool, {
					type: "toolCall",
					id: toolCallId,
					name: toolName,
					arguments: prepared as JsonObject,
				}) as JsonObject;
			} catch (error) {
				throw new CodeModeCallError("invalid_arguments", errorMessage(error));
			}
			// MCP arguments are the server's to interpret.
			if (target.kind === "tool" && input.background === true) {
				throw new CodeModeCallError("invalid_arguments", "Scripts cannot start background jobs");
			}
			const decision = await reduceToolCall<TurnToolCall>(
				{ type: "tool_call", toolCallId, toolName, input },
				host.toolCallPolicies(call.signal, origin),
			);
			if (decision.block) {
				throw new CodeModeCallError("blocked", decision.reason ?? `The tool-call policy blocked ${toolName}`);
			}
			return { registered, input };
		};

		// Nothing has run until the tool starts, so whatever fails once the call is cancelled, a policy rejecting on the
		// abort or the scheduler dropping the call, rejects as not started.
		let checked: { registered: CodeModeHostTool; input: JsonObject };
		try {
			const checking = checks.then(check);
			checks = checking.catch(() => undefined);
			checked = await checking;
		} catch (error) {
			if (call.signal.aborted) throw notStarted();
			throw error;
		}
		const { registered, input } = checked;
		let started = false;
		const schedule = async <T>(serverLimit: number, start: () => Promise<T>): Promise<T> => {
			try {
				return await scheduler.schedule(
					schedulingClassFor(target, registered.tool.executionMode, serverLimit),
					() => {
						started = true;
						return start();
					},
					call.signal,
				);
			} catch (error) {
				if (!started && call.signal.aborted) throw notStarted();
				throw error;
			}
		};

		if (target.kind === "mcp") {
			const args = isGatewayRoute(target) ? objectField(input, "arguments") : input;
			const outcome = await schedule(host.mcpServerLimit(target.server), () =>
				callMcp(host, target.server, target.tool, args, call.signal),
			);
			// Hooks see the complete result as text; its images and structured content reach the value only unchanged.
			const event = {
				content: [
					{
						type: "text" as const,
						text: "result" in outcome ? callToolResultToText(outcome.result) : errorMessage(outcome.error),
					},
				],
				isError: "result" in outcome ? outcome.result.isError === true : true,
			};
			const reviewed = await host.toolResult({ toolName, toolCallId, input, ...event }, call.signal, origin);
			if (call.signal.aborted) throw new CodeModeCallError("cancelled", "The call was cancelled");
			const unchanged =
				reviewed === undefined ||
				(reviewed.isError === event.isError && isDeepStrictEqual(reviewed.content, event.content));
			if (unchanged && "result" in outcome) {
				return projectMcpResult(outcome.result, {
					cwd: host.cwd,
					images: call.images,
					maxValueBytes: call.maxValueBytes,
				});
			}
			const final = reviewed ?? event;
			const text = textOf(final.content);
			if (final.isError) {
				const unavailable = "error" in outcome && outcome.error instanceof McpToolUnavailableError;
				throw new CodeModeCallError(
					"failed",
					text === "" ? "the tool failed without a message" : text,
					unavailable ? "unavailable" : undefined,
				);
			}
			return { text, images: [] };
		}

		// The server limit applies only to MCP targets.
		const executed = await schedule(0, () => run(registered.tool, toolCallId, input, call.signal));
		const reviewed = await host.toolResult(
			{
				toolName,
				toolCallId,
				input,
				content: executed.content,
				...(executed.details === undefined ? {} : { details: executed.details as JsonValue }),
				isError: executed.isError === true,
			},
			call.signal,
			origin,
		);
		// The call record keeps this message; the tool's output, which hooks may have redacted, stays out of it.
		if (call.signal.aborted) throw new CodeModeCallError("cancelled", "The call was cancelled");
		return projectToolResult(
			{ name: toolName, trustedBuiltin: registered.trustedBuiltin },
			input,
			{ executed, reviewed },
			{ cwd: host.cwd, images: call.images, maxValueBytes: call.maxValueBytes },
		);
	};
}

/** Whether calls to a binding's target are MCP calls through the built-in `mcp` gateway, not a direct tool. */
function isGatewayRoute(
	target: CodeModeBindingTarget,
): target is Extract<CodeModeBindingTarget, { kind: "mcp" }> & { toolName: "mcp" } {
	return target.kind === "mcp" && target.toolName === "mcp";
}

/** An MCP tool call's result as the server sent it, or the error the call failed with. */
type McpCallOutcome = { result: CallToolResult } | { error: unknown };

/** Calls an MCP tool for a nested call; a failure becomes the outcome, as a tool's thrown error becomes its result. */
async function callMcp(
	host: CodeModeDispatchHost,
	server: string,
	tool: string,
	args: JsonObject,
	signal: AbortSignal,
): Promise<McpCallOutcome> {
	try {
		return { result: await withoutBackgroundJobs(() => host.callMcpTool(server, tool, args, signal)) };
	} catch (error) {
		return { error };
	}
}

/** The object `input[key]`, or an empty object when it holds anything else. */
function objectField(input: JsonObject, key: string): JsonObject {
	const value = input[key];
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** Runs a tool for a nested call. A thrown error becomes an error result, as the agent loop treats it. */
async function run(
	tool: AgentTool,
	toolCallId: string,
	input: JsonObject,
	signal: AbortSignal,
): Promise<AgentToolResult<unknown>> {
	try {
		return await withoutBackgroundJobs(() => tool.execute(toolCallId, input, signal));
	} catch (error) {
		return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
	}
}

function notStarted(): CodeModeCallError {
	return new CodeModeCallError("cancelled", "The call was cancelled before it ran", "not_started");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/** The path of the first BigInt in decoded arguments, which no tool schema accepts, or undefined. */
function bigintPath(value: unknown, path: string): string | undefined {
	if (typeof value === "bigint") return path;
	if (value === null || typeof value !== "object") return undefined;
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index++) {
			const found = bigintPath(value[index], `${path}[${index}]`);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	for (const [key, item] of Object.entries(value)) {
		const found = bigintPath(item, IDENTIFIER.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);
		if (found !== undefined) return found;
	}
	return undefined;
}
