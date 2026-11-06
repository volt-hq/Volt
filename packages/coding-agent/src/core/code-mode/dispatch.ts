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
 *    The tool's trust, read with it then, picks the call's projection.
 * 7. Arguments are prepared and validated as the agent loop does; otherwise `invalid_arguments`. A nested call
 *    cannot start a background job.
 * 8. The session's tool-call policy, with a `code_mode` origin and the ID `<parentToolCallId>:cm:<seq>`; a denial
 *    rejects with `blocked`.
 * 9. The scheduler starts the call, which runs outside any background-job scope.
 * 10. The session's tool-result policy, whose hooks observe the call's signal, then the call's projection into a
 *     script value.
 *
 * Checks 6 to 8 run in submission order: a call's checks start once the earlier call's have finished, as the agent
 * loop prepares calls in order. A call cancelled before its tool starts rejects with `cancelled` (`not_started`),
 * whatever failed on the way; a call cancelled after rejects with `cancelled` and none of the tool's output.
 */
export function createCodeModeCallHandler(
	options: CodeModeCallHandlerOptions,
): (call: CodeModeCall) => Promise<unknown> {
	const { host, parentToolCallId } = options;
	const scheduler = options.scheduler ?? new CodeModeCallScheduler();
	const bindings = new Map(options.bindings.map((binding) => [binding.name, binding]));
	// The tool each binding calls as it was when the script started; a tool replaced since is no longer available.
	const toolsAtStart = new Map<string, CodeModeHostTool | undefined>();
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
			if (decision.block) {
				throw new CodeModeCallError("blocked", decision.reason ?? `The tool-call policy blocked ${toolName}`);
			}
			return { registered, input };
		};

		// Set as the tool starts. Until then, nothing has run, so whatever fails once the call is cancelled, a policy
		// rejecting on the abort or the scheduler dropping the call, rejects as not started.
		let started = false;
		let checked: { registered: CodeModeHostTool; input: JsonObject };
		let executed: AgentToolResult<unknown>;
		try {
			const checking = checks.then(check);
			checks = checking.catch(() => undefined);
			const ready = await checking;
			checked = ready;
			executed = await scheduler.schedule(
				// The server limit applies only to MCP targets.
				schedulingClassFor(binding.target, ready.registered.tool.executionMode, 0),
				() => {
					started = true;
					return run(ready.registered.tool, toolCallId, ready.input, call.signal);
				},
				call.signal,
			);
		} catch (error) {
			if (!started && call.signal.aborted) throw notStarted();
			throw error;
		}
		const { registered, input } = checked;
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
