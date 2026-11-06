import type { AgentTool, AgentToolResult } from "@hansjm10/volt-agent-core";
import {
	type ImageContent,
	type JsonObject,
	type JsonValue,
	type TextContent,
	validateToolArguments,
} from "@hansjm10/volt-ai";
import type { ExtensionOperationOrigin } from "../extensions/index.ts";
import type { SessionToolRuntime } from "../session/tool-runtime.ts";
import {
	reduceToolCall,
	type SessionTurnPolicy,
	type ToolCallPolicy,
	type TurnToolCall,
} from "../session/turn-policy.ts";
import { withoutBackgroundJobs } from "../tools/background.ts";
import type { CodeModeBindingSpec } from "./bindings.ts";
import { projectToolResult } from "./projections.ts";
import { type CodeModeCall, CodeModeCallError } from "./runtime.ts";
import { CodeModeCallNotStartedError, CodeModeCallScheduler, schedulingClassFor } from "./scheduler.ts";

/** A tool result as the tool-result policy receives and returns it. */
export interface CodeModeToolResultEvent {
	toolName: string;
	toolCallId: string;
	input: JsonObject;
	content: Array<TextContent | ImageContent>;
	details?: JsonValue;
	isError: boolean;
}

/** The session as nested-call dispatch uses it: its tools and the policies model calls go through. */
export interface CodeModeDispatchHost {
	/** The session's working directory. */
	readonly cwd: string;
	isToolActive(name: string): boolean;
	/** The registered tool of that name, as the session runs it. */
	tool(name: string): AgentTool | undefined;
	/** Whether the tool is the trusted built-in tool of that name. */
	isTrustedBuiltin(name: string): boolean;
	/** The session's tool-call policies, attributing the call to `origin`. */
	toolCallPolicies(signal: AbortSignal, origin: ExtensionOperationOrigin): Iterable<ToolCallPolicy<TurnToolCall>>;
	/**
	 * The session's tool-result policy, attributing the call to `origin`. Resolves with the result as `tool_result`
	 * hooks left it, or undefined when no hook saw it.
	 */
	toolResult(
		event: CodeModeToolResultEvent,
		origin: ExtensionOperationOrigin,
	): Promise<Omit<CodeModeToolResultEvent, "toolName" | "toolCallId" | "input"> | undefined>;
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
		tool: (name) => tools.registeredTool(name),
		isTrustedBuiltin: (name) => tools.isTrustedBuiltin(name),
		toolCallPolicies: (signal, origin) => turnPolicy.toolCallPolicies(signal, origin),
		toolResult: (event, origin) => turnPolicy.toolResult(event, false, origin),
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
 * nested call goes through the rest of the host checks, the same way a model-issued call does:
 *
 * 6. The tool is still active and is the tool it was when the script started; otherwise `failed` (`unavailable`).
 * 7. Arguments are prepared and validated as the agent loop does; otherwise `invalid_arguments`. A nested call
 *    cannot start a background job.
 * 8. The session's tool-call policy, with a `code_mode` origin and the ID `<parentToolCallId>:cm:<seq>`; a denial
 *    rejects with `blocked`.
 * 9. The scheduler starts the call, which runs outside any background-job scope.
 * 10. The session's tool-result policy, then the call's projection into a script value.
 *
 * Checks 6 to 8 run in submission order: a call's checks start once the earlier call's have finished, as the agent
 * loop prepares calls in order. A call cancelled before it starts rejects with `cancelled` (`not_started`).
 */
export function createCodeModeCallHandler(
	options: CodeModeCallHandlerOptions,
): (call: CodeModeCall) => Promise<unknown> {
	const { host, parentToolCallId } = options;
	const scheduler = options.scheduler ?? new CodeModeCallScheduler();
	const bindings = new Map(options.bindings.map((binding) => [binding.name, binding]));
	// The tool each binding calls as it was when the script started; a tool replaced since is no longer available.
	const toolsAtStart = new Map<string, AgentTool | undefined>();
	for (const binding of options.bindings) {
		if (binding.target.kind === "tool") toolsAtStart.set(binding.target.toolName, host.tool(binding.target.toolName));
	}
	let checks: Promise<unknown> = Promise.resolve();

	return async (call) => {
		const binding = bindings.get(call.binding);
		if (!binding) throw new CodeModeCallError("failed", `the script has no binding ${call.binding}`, "unavailable");
		if (binding.target.kind !== "tool") {
			throw new CodeModeCallError("failed", "MCP tools cannot be called from scripts yet", "unavailable");
		}
		const toolName = binding.target.toolName;
		const toolCallId = `${parentToolCallId}:cm:${call.seq}`;
		const origin: ExtensionOperationOrigin = { kind: "code_mode", parentToolCallId, seq: call.seq };

		const check = async (): Promise<{ tool: AgentTool; input: JsonObject }> => {
			if (call.signal.aborted) throw notStarted();
			const tool = host.tool(toolName);
			if (!tool || tool !== toolsAtStart.get(toolName) || !host.isToolActive(toolName)) {
				throw new CodeModeCallError("failed", `${toolName} is no longer available in this session`, "unavailable");
			}
			const bigint = bigintPath(call.args, "args");
			if (bigint !== undefined) {
				throw new CodeModeCallError("invalid_arguments", `${bigint}: a BigInt is not a valid tool argument`);
			}
			let input: JsonObject;
			try {
				const prepared = tool.prepareArguments ? tool.prepareArguments(call.args) : call.args;
				input = validateToolArguments(tool, {
					type: "toolCall",
					id: toolCallId,
					name: toolName,
					arguments: prepared as JsonObject,
				}) as JsonObject;
			} catch (error) {
				throw new CodeModeCallError("invalid_arguments", errorMessage(error));
			}
			if (input.background === true) {
				throw new CodeModeCallError("invalid_arguments", "Scripts cannot start background jobs");
			}
			const decision = await reduceToolCall<TurnToolCall>(
				{ type: "tool_call", toolCallId, toolName, input },
				host.toolCallPolicies(call.signal, origin),
			);
			if (call.signal.aborted) throw notStarted();
			if (decision.block) {
				throw new CodeModeCallError("blocked", decision.reason ?? `The tool-call policy blocked ${toolName}`);
			}
			return { tool, input };
		};
		const checked = checks.then(check);
		checks = checked.catch(() => undefined);
		const { tool, input } = await checked;

		let executed: AgentToolResult<unknown>;
		try {
			executed = await scheduler.schedule(
				// The server limit applies only to MCP targets.
				schedulingClassFor(binding.target, tool.executionMode, 0),
				() => run(tool, toolCallId, input, call.signal),
				call.signal,
			);
		} catch (error) {
			if (error instanceof CodeModeCallNotStartedError) throw notStarted();
			throw error;
		}
		const reviewed = await host.toolResult(
			{
				toolName,
				toolCallId,
				input,
				content: executed.content,
				...(executed.details === undefined ? {} : { details: executed.details as JsonValue }),
				isError: executed.isError === true,
			},
			origin,
		);
		if (call.signal.aborted) {
			throw new CodeModeCallError("cancelled", textOf(executed.content) || "The call was cancelled");
		}
		return projectToolResult(
			{ name: toolName, trustedBuiltin: host.isTrustedBuiltin(toolName) },
			input,
			{ executed, reviewed },
			{ cwd: host.cwd, images: call.images, maxValueBytes: call.maxValueBytes },
		);
	};
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

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
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
