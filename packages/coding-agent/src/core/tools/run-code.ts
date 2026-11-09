import { stripTypeScriptTypes } from "node:module";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import type { TextContent } from "@hansjm10/volt-ai";
import { type Static, Type } from "typebox";
import {
	CODE_MODE_MCP_RESULT_SHAPE,
	type CodeModeBindingSources,
	type CodeModeBindingTarget,
	codeModeCallExpression,
	codeModeCallsMcpTools,
	computeCodeModeBindings,
} from "../code-mode/bindings.ts";
import { type CodeModeDispatchHost, createCodeModeCallHandler } from "../code-mode/dispatch.ts";
import { type CodeModeCallImages, type CodeModeImageRef, CodeModeImageStore } from "../code-mode/images.ts";
import {
	DEFAULT_CODE_MODE_POOL_OPTIONS,
	DEFAULT_CODE_MODE_SCRIPT_LIMITS,
	MAX_CODE_MODE_SCRIPT_TIMEOUT_MS,
	MAX_SCRIPT_ERROR_CHARS,
	MAX_SCRIPT_ERROR_SUMMARY_CHARS,
	MAX_STORED_BYTES,
} from "../code-mode/limits.ts";
import { type CodeModeWorkerPool, getCodeModeWorkerPool } from "../code-mode/pool.ts";
import { type CodeModeErrorDescription, SCRIPT_FILENAME, SCRIPT_PREFIX, SCRIPT_SUFFIX } from "../code-mode/prelude.ts";
import {
	type CodeModeRenderCall,
	type CodeModeRenderedResult,
	type CodeModeRenderImage,
	previewCodeModeArgs,
	renderCodeModeResult,
} from "../code-mode/render.ts";
import {
	CodeModeCallError,
	type CodeModeCallStatus,
	type CodeModeFailure,
	type CodeModeOutputItem,
	type CodeModeScriptResult,
	type CodeModeStoreWrites,
	runCodeModeScript,
} from "../code-mode/runtime.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { presentRunCode } from "./run-code-presenter.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES } from "./truncate.ts";

/**
 * The `run_code` tool (sections 5.14 to 5.16 of docs/code-mode-design.md): runs a model-written script in the code
 * mode sandbox, whose nested calls go through the session's tool policies, and returns the rendered result.
 */

const runCodeSchema = Type.Object({
	code: Type.String({
		description: "The script: the body of an async function, in JavaScript or erasable TypeScript",
	}),
	description: Type.Optional(
		Type.String({ description: "A short label for the script, at most 80 characters, shown as its title" }),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_CODE_MODE_SCRIPT_TIMEOUT_MS,
			description: `Optional wall-clock limit for the script in milliseconds, at most ${MAX_CODE_MODE_SCRIPT_TIMEOUT_MS}`,
		}),
	),
});

export type RunCodeToolInput = Static<typeof runCodeSchema>;

/** A nested call as `details` records it (section 5.16). */
export interface RunCodeCallDetails {
	seq: number;
	/** The tool the call went through, or `mcp.<server>.<tool>` for an MCP tool. */
	tool: string;
	/** A preview of the arguments; dropped for read-only calls when the records do not fit their bound. */
	argsPreview?: string;
	/** The exact `path` argument of a `read`, `write`, or `edit` call. */
	path?: string;
	status: CodeModeCallStatus;
	/** Whether the call's trusted operation resolution holds only read capabilities (section 5.11). */
	readOnly: boolean;
	/** When the script issued the call, in milliseconds since the run started, the origin of `wallMs`. */
	startMs: number;
	/** From when the script issued the call, including any wait to be scheduled, until it settled. */
	durationMs: number;
	/** The error message of a failed or cancelled call, at most 256 characters. */
	error?: string;
}

/** What a `run_code` result records for the TUI, session records, and remote clients (section 5.16). */
export interface RunCodeDetails {
	status: "completed" | "failed";
	failureKind?: CodeModeFailure["kind"];
	/** `typescript` when stripping types changed the script. */
	language: "javascript" | "typescript";
	wallMs: number;
	calls: RunCodeCallDetails[];
	callTotals: Record<CodeModeCallStatus, number>;
	/** False when records were dropped to fit the bound. */
	complete: boolean;
	output: { truncated: boolean; fullOutputPath?: string; items: number; characters: number };
	images: { shown: CodeModeImageRef[]; unshown: CodeModeImageRef[] };
}

/** A nested call as the live card shows it while the script runs (section 5.16). */
export interface RunCodeProgressCall {
	seq: number;
	/** The tool the call went through, or `mcp.<server>.<tool>` for an MCP tool. */
	tool: string;
	argsPreview: string;
	status: "running" | "completed" | "failed" | "cancelled";
	/** When the call passed the runtime's checks, in epoch milliseconds. */
	startedAt: number;
	/** When it settled, in epoch milliseconds. */
	endedAt?: number;
	/** The error message of a failed or cancelled call, at most 256 characters. */
	error?: string;
}

/**
 * What a partial `run_code` result carries while the script runs, for the live card (section 5.16). Clients see it
 * live; the session stores only the final result, whose `details` are a {@link RunCodeDetails}.
 */
export interface RunCodeProgress {
	status: "running";
	language: RunCodeDetails["language"];
	/** The newest calls, at most 50, oldest first. */
	calls: RunCodeProgressCall[];
	/** Every call so far, by status. */
	callTotals: Record<RunCodeProgressCall["status"], number>;
	/** Lines of output the script has produced; the partial result's text holds the newest 100. */
	outputLines: number;
}

/** The `details` of a `run_code` result: progress while the script runs, then the record of the run. */
export type RunCodeToolDetails = RunCodeDetails | RunCodeProgress;

export interface RunCodeToolOptions {
	/** What the model could call directly now. A script's bindings are computed from it when the script starts. */
	bindingSources(): CodeModeBindingSources;
	/** The session's tools and the policies a script's nested calls go through. */
	dispatchHost(): CodeModeDispatchHost;
	/** Whether a nested call's trusted operation resolution holds only read capabilities (section 5.11). */
	callIsReadOnly(target: CodeModeBindingTarget, args: Record<string, unknown>): boolean;
	/** Whether shown images are resized to fit providers' inline limits, as `read` resizes its images. */
	autoResizeImages: boolean;
	/**
	 * The conversation's stored values along its current branch (section 5.17): keys and the codec text of their
	 * values. Read when a script starts.
	 */
	storedValues(): Array<[string, string]>;
	/** Records a script's net writes to the stored values; called once for each script that wrote anything. */
	recordStoreWrites(writes: CodeModeStoreWrites): Promise<void>;
	/** The worker pool scripts run on; the process's pool by default. */
	pool?: CodeModeWorkerPool;
}

const MIB = 1024 * 1024;

const INTRO =
	"Run a JavaScript script in a sandbox. The script calls tools and only what it prints or returns comes back to you. Prefer it for independent call batches, pagination, large-result reduction, or deterministic read-only loops. Use direct calls for small results or steps requiring interpretation.";
const LANGUAGE =
	"The script is the body of an async function: top-level await and return work. Erasable TypeScript annotations are allowed. The sandbox has no file system, network, process, timers, or modules; tools are its only way out.";
const CALLS = "Call tools as `await tools.<name>(args)` with the same arguments as the tool itself";
const NO_TOOLS = "No tools are available to scripts in this session.";
const MCP_LINE = `- MCP tools: tools.mcp.<server>.<tool>(args): ${CODE_MODE_MCP_RESULT_SHAPE}. Discover missing schemas with the direct mcp tool's search and describe actions. Reuse complete, current schemas already returned. tools.mcp is a namespace, not a callable gateway; discovery is not available inside scripts. Use brackets for names that are not identifiers: tools.mcp["my-server"]["get-file"](args).`;
const ERRORS =
	'A failed call rejects with ToolCallError { tool; kind: "invalid_arguments" | "blocked" | "failed" | "cancelled"; reason?; message }. Run independent calls concurrently with Promise.allSettled, inspect rejected results, and await dependent calls in order.';
const OUTPUT = `Output: text(value), console.log/warn/error(...), image(ref), and the return value appear in order. ImageRef = { type: "image"; ref; mimeType; width?; height?; bytes; path? }; only images passed to image(ref) reach you. Output is limited to ${DEFAULT_MAX_BYTES / 1024} KB, with the full output saved to a file you can read.`;
const LIMITS = `Limits: ${DEFAULT_CODE_MODE_SCRIPT_LIMITS.computeBudgetMs / 1000} s of computation, ${DEFAULT_CODE_MODE_SCRIPT_LIMITS.callBudget} tool calls, and ${DEFAULT_CODE_MODE_POOL_OPTIONS.memoryLimitBytes / MIB} MiB of memory per script. Tool calls made before a failure are not undone; a failed result lists them.`;
const STORE = `store(key, value) and load(key) keep small JSON values across scripts in this conversation; up to ${MAX_STORED_BYTES / MIB} MiB in total.`;
const SHELL = `Write shell commands with String.raw\`...\` and $VAR instead of \${VAR}.`;

/** Result shapes of the trusted built-in tools whose script values are not plain text, in the order they are listed. */
const RESULT_SHAPES = new Map([
	[
		"bash",
		"Promise<{ output: string; exitCode: number | null; truncated: boolean; fullOutputPath?: string }>, resolving for any exit code",
	],
	["read", "Promise<string | ImageRef>"],
	["image_gen", "Promise<ImageRef>"],
]);

/**
 * The `run_code` description for a session (section 5.14): the bindings scripts get and the result shapes that are
 * not plain text. It depends only on the active tools and the grant profile, never on which MCP servers are
 * connected, so connecting a server does not change it.
 */
export function describeRunCode(sources: CodeModeBindingSources): string {
	const bindings = computeCodeModeBindings({ ...sources, mcpTools: [] });
	const trusted = new Set(sources.activeTools.flatMap((tool) => (tool.kind === "builtin" ? [tool.name] : [])));
	const shaped = new Set<string>();
	const plain: string[] = [];
	for (const { target } of bindings) {
		// MCP bindings, here only direct tools, are covered by the MCP line.
		if (target.kind !== "tool") continue;
		if (trusted.has(target.toolName) && RESULT_SHAPES.has(target.toolName)) shaped.add(target.toolName);
		else plain.push(target.toolName);
	}
	const lines: string[] = [];
	for (const [name, shape] of RESULT_SHAPES) {
		if (shaped.has(name)) lines.push(`- ${codeModeCallExpression([name])}: ${shape}`);
	}
	if (plain.length > 0)
		lines.push(`- ${plain.map((name) => codeModeCallExpression([name])).join(", ")}: Promise<string>`);
	if (codeModeCallsMcpTools(sources)) lines.push(MCP_LINE);
	const limits = shaped.has("bash") ? `${LIMITS} ${SHELL}` : LIMITS;
	if (lines.length === 0) return [INTRO, LANGUAGE, NO_TOOLS, OUTPUT, limits, STORE].join("\n\n");
	return [INTRO, LANGUAGE, `${CALLS}:\n${lines.join("\n")}`, ERRORS, OUTPUT, limits, STORE].join("\n\n");
}

/** The description of the registered tool, before a session stages the one that lists its bindings. */
const REGISTERED_DESCRIPTION = [INTRO, LANGUAGE, `${CALLS}.`, ERRORS, OUTPUT, LIMITS, STORE].join("\n\n");

type PreparedScript =
	| { ok: true; code: string; language: "javascript" | "typescript" }
	| { ok: false; error: CodeModeErrorDescription };

/**
 * Strips TypeScript from a script (section 5.14). The script is stripped inside the wrapper the runtime evaluates it
 * in, so top-level `await` and `return` parse; strip mode keeps every offset, so the wrapper is sliced back off and
 * stack traces still map to the script. Syntax strip mode does not support, such as `enum`, fails as a syntax error
 * before the script starts. Code the TypeScript parser rejects runs unchanged, so the engine reports genuine
 * JavaScript errors.
 */
function prepareScript(code: string): PreparedScript {
	const wrapped = `${SCRIPT_PREFIX}${code}${SCRIPT_SUFFIX}`;
	let stripped: string;
	try {
		stripped = withoutTypeStrippingWarning(() => stripTypeScriptTypes(wrapped, { mode: "strip" }));
	} catch (error) {
		if (isRecord(error) && error.code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
			return { ok: false, error: unsupportedSyntax(error) };
		}
		return { ok: true, code, language: "javascript" };
	}
	if (!stripped.startsWith(SCRIPT_PREFIX) || !stripped.endsWith(SCRIPT_SUFFIX)) {
		return { ok: true, code, language: "javascript" };
	}
	const body = stripped.slice(SCRIPT_PREFIX.length, stripped.length - SCRIPT_SUFFIX.length);
	return body === code ? { ok: true, code, language: "javascript" } : { ok: true, code: body, language: "typescript" };
}

/**
 * Runs `strip` without the `ExperimentalWarning` type stripping emits, which would otherwise reach the terminal or a
 * client. Any other warning passes.
 */
function withoutTypeStrippingWarning<T>(strip: () => T): T {
	const emitWarning = process.emitWarning;
	const filtered = (...args: unknown[]): void => {
		if (isTypeStrippingWarning(args[0], args[1])) return;
		Reflect.apply(emitWarning, process, args);
	};
	process.emitWarning = filtered as typeof process.emitWarning;
	try {
		return strip();
	} finally {
		process.emitWarning = emitWarning;
	}
}

function isTypeStrippingWarning(warning: unknown, typeOrOptions: unknown): boolean {
	const type =
		warning instanceof Error
			? warning.name
			: typeof typeOrOptions === "string"
				? typeOrOptions
				: isRecord(typeOrOptions)
					? typeOrOptions.type
					: undefined;
	const message = warning instanceof Error ? warning.message : warning;
	return (
		type === "ExperimentalWarning" &&
		typeof message === "string" &&
		/stripTypeScriptTypes|type stripping/i.test(message)
	);
}

/** A script error for TypeScript that strip mode does not support, with its line when Node reports one. */
function unsupportedSyntax(error: Record<string, unknown>): CodeModeErrorDescription {
	const message = typeof error.message === "string" ? error.message.replace(/\s*\n\s*/g, " ") : "unsupported syntax";
	const summary = capChars(`SyntaxError: ${message}`, MAX_SCRIPT_ERROR_SUMMARY_CHARS);
	// Node's stack starts with the source line of the error. The script shares its first line with the wrapper.
	const line = typeof error.stack === "string" ? /^:(\d+)\n/.exec(error.stack)?.[1] : undefined;
	const text = line === undefined ? summary : `${summary}\n    at ${SCRIPT_FILENAME}:${line}`;
	return { name: "SyntaxError", summary, text: capChars(text, MAX_SCRIPT_ERROR_CHARS), outOfMemory: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/** `text` cut to at most `max` characters with a trailing ellipsis, never between the halves of a surrogate pair. */
function capChars(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max - 1;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end--;
	return `${text.slice(0, end)}…`;
}

/** The tool a call went through, as `details` and failure summaries name it. */
function toolLabel(target: CodeModeBindingTarget): string {
	return target.kind === "mcp" ? `mcp.${target.server}.${target.tool}` : target.toolName;
}

/** Where an image a call returned came from, for the list of images the script did not show. */
function imageSource(target: CodeModeBindingTarget, args: Record<string, unknown>, ref: CodeModeImageRef): string {
	if (target.kind === "mcp") return `MCP ${target.server}.${target.tool}`;
	if (target.toolName === "read") {
		const path = typeof args.path === "string" ? args.path : ref.path;
		return path === undefined ? "read" : `read ${path}`;
	}
	if (target.toolName === "image_gen") return ref.path === undefined ? "image_gen" : `image_gen ${ref.path}`;
	return target.toolName;
}

/** A call's image store that reports each reference it issues. */
function taggingImages(images: CodeModeCallImages, onRef: (ref: CodeModeImageRef) => void): CodeModeCallImages {
	return {
		add(inputs) {
			const refs = images.add(inputs);
			for (const ref of refs) onRef(ref);
			return refs;
		},
	};
}

/** Bytes `details` may take (section 5.16). */
const MAX_DETAILS_BYTES = 64 * 1024;
const MAX_DETAILS_ARGS_PREVIEW_CHARS = 160;
const MAX_DETAILS_ERROR_CHARS = 256;
/** Tools whose `path` argument `details` records, for compaction's file lists. */
const PATH_TOOLS = new Set(["read", "write", "edit"]);
/** `"argsPreview":` and the comma after the value; `status` always follows it. */
const ARGS_PREVIEW_ENVELOPE_BYTES = '"argsPreview":,'.length;

function jsonBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/**
 * The `details` of a `run_code` result (section 5.16): the outcome, a record of each nested call, and what the
 * rendering left out. Nested results are never recorded. When the records do not fit 64 KB, argument previews of
 * read-only calls are dropped first, then the oldest read-only records, and `complete` becomes false;
 * state-changing records are always kept.
 */
export function buildRunCodeDetails(input: {
	result: CodeModeScriptResult;
	calls: readonly CodeModeRenderCall[];
	rendered: CodeModeRenderedResult;
	language: RunCodeDetails["language"];
	maxBytes?: number;
}): RunCodeDetails {
	const { result, rendered } = input;
	const callTotals: RunCodeDetails["callTotals"] = { completed: 0, failed: 0, cancelled: 0, unsettled: 0 };
	const calls = input.calls.map((call): RunCodeCallDetails => {
		callTotals[call.status]++;
		const path = PATH_TOOLS.has(call.tool) && typeof call.args?.path === "string" ? call.args.path : undefined;
		return {
			seq: call.seq,
			tool: call.tool,
			argsPreview: previewCodeModeArgs(call.args ?? {}, MAX_DETAILS_ARGS_PREVIEW_CHARS),
			...(path === undefined ? {} : { path }),
			status: call.status,
			readOnly: call.readOnly,
			startMs: Math.round(call.startMs),
			durationMs: Math.round(call.durationMs),
			...(call.error === undefined ? {} : { error: capChars(call.error.message, MAX_DETAILS_ERROR_CHARS) }),
		};
	});
	let characters = 0;
	for (const item of result.output) if (item.type !== "image") characters += item.text.length;
	const details: RunCodeDetails = {
		status: result.ok ? "completed" : "failed",
		...(result.ok ? {} : { failureKind: result.failure.kind }),
		language: input.language,
		wallMs: Math.round(result.durationMs),
		calls,
		callTotals,
		complete: true,
		output: {
			truncated: rendered.truncated,
			...(rendered.fullOutputPath === undefined ? {} : { fullOutputPath: rendered.fullOutputPath }),
			items: result.output.length,
			characters,
		},
		images: { shown: rendered.shownImages, unshown: rendered.unshownImages },
	};
	const maxBytes = input.maxBytes ?? MAX_DETAILS_BYTES;
	let bytes = jsonBytes(details);
	if (bytes <= maxBytes) return details;
	details.complete = false;
	for (const call of calls) {
		if (bytes <= maxBytes) return details;
		if (!call.readOnly || call.argsPreview === undefined) continue;
		bytes -= ARGS_PREVIEW_ENVELOPE_BYTES + jsonBytes(call.argsPreview);
		delete call.argsPreview;
	}
	for (let index = 0; index < calls.length && bytes > maxBytes; ) {
		if (!calls[index].readOnly) {
			index++;
			continue;
		}
		bytes -= jsonBytes(calls[index]) + (calls.length > 1 ? 1 : 0);
		calls.splice(index, 1);
	}
	return details;
}

/** The live card's updates come at most this often (section 5.16). */
const PROGRESS_INTERVAL_MS = 250;
const PROGRESS_CALLS = 50;
const PROGRESS_OUTPUT_LINES = 100;
/** Characters of one output line the live card carries; the final result keeps the whole output. */
const PROGRESS_LINE_CHARS = 512;
const PROGRESS_LINE_BREAKS = /\r\n|[\r\u2028\u2029]/g;

/**
 * Reports a running script to the live card (section 5.16): its newest calls, from when each passes the runtime's
 * checks until it settles, and the newest lines of its output, as partial results at most every 250 ms, the last
 * change always reported. Nothing is reported once it is closed.
 */
class RunCodeProgressReporter {
	private readonly onUpdate: (update: { content: TextContent[]; details: RunCodeProgress }) => void;
	private readonly language: RunCodeDetails["language"];
	/** The newest calls by `seq`, in the order they started. */
	private readonly calls = new Map<number, RunCodeProgressCall>();
	private readonly callTotals: RunCodeProgress["callTotals"] = { running: 0, completed: 0, failed: 0, cancelled: 0 };
	private lines: string[] = [];
	private outputLines = 0;
	private lastReportedAt = Number.NEGATIVE_INFINITY;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private closed = false;

	constructor(
		onUpdate: (update: { content: TextContent[]; details: RunCodeProgress }) => void,
		language: RunCodeDetails["language"],
	) {
		this.onUpdate = onUpdate;
		this.language = language;
	}

	/** A call that passed the runtime's checks started; `settled` is its outcome. */
	callStarted(seq: number, tool: string, args: Record<string, unknown>, settled: Promise<unknown>): void {
		this.calls.set(seq, {
			seq,
			tool,
			argsPreview: previewCodeModeArgs(args, MAX_DETAILS_ARGS_PREVIEW_CHARS),
			status: "running",
			startedAt: Date.now(),
		});
		if (this.calls.size > PROGRESS_CALLS) this.calls.delete(this.calls.keys().next().value as number);
		this.callTotals.running++;
		this.schedule();
		settled.then(
			() => this.callSettled(seq, "completed"),
			(error: unknown) => {
				const cancelled = error instanceof CodeModeCallError && error.kind === "cancelled";
				const message = error instanceof Error ? error.message : String(error);
				this.callSettled(seq, cancelled ? "cancelled" : "failed", message);
			},
		);
	}

	output(item: CodeModeOutputItem): void {
		let text: string;
		if (item.type === "image") text = `[image ${item.ref}]`;
		else {
			const prefix =
				item.type === "console" && (item.level === "warn" || item.level === "error") ? `${item.level}: ` : "";
			text = `${prefix}${item.text.replace(PROGRESS_LINE_BREAKS, "\n")}`;
			if (text.endsWith("\n")) text = text.slice(0, -1);
		}
		const lines = text.split("\n");
		this.outputLines += lines.length;
		this.lines = [...this.lines, ...lines.slice(-PROGRESS_OUTPUT_LINES)]
			.slice(-PROGRESS_OUTPUT_LINES)
			.map((line) => capChars(line, PROGRESS_LINE_CHARS));
		this.schedule();
	}

	/** Stops reporting: the script ended. */
	close(): void {
		this.closed = true;
		clearTimeout(this.timer);
		this.timer = undefined;
	}

	private callSettled(seq: number, status: "completed" | "failed" | "cancelled", error?: string): void {
		this.callTotals.running--;
		this.callTotals[status]++;
		const call = this.calls.get(seq);
		if (call) {
			call.status = status;
			call.endedAt = Date.now();
			if (error !== undefined) call.error = capChars(error, MAX_DETAILS_ERROR_CHARS);
		}
		this.schedule();
	}

	private schedule(): void {
		if (this.closed || this.timer !== undefined) return;
		const wait = this.lastReportedAt + PROGRESS_INTERVAL_MS - Date.now();
		if (wait <= 0) {
			this.report();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.report();
		}, wait);
	}

	private report(): void {
		if (this.closed) return;
		this.lastReportedAt = Date.now();
		const details: RunCodeProgress = {
			status: "running",
			language: this.language,
			calls: [...this.calls.values()].map((call) => ({ ...call })),
			callTotals: { ...this.callTotals },
			outputLines: this.outputLines,
		};
		try {
			this.onUpdate({ content: [{ type: "text", text: this.lines.join("\n") }], details });
		} catch {
			// Reported from a timer, where a throw would reach the process: a card that cannot update stops updating.
			this.close();
		}
	}
}

export function createRunCodeToolDefinition(
	options: RunCodeToolOptions,
): ToolDefinition<typeof runCodeSchema, RunCodeToolDetails> {
	return {
		name: "run_code",
		label: "run_code",
		description: REGISTERED_DESCRIPTION,
		promptSnippet: "Batch tool calls and filter large results with sandboxed JavaScript",
		promptGuidelines: [
			"Prefer run_code for batches of independent tool calls, pagination, and filtering or aggregating large results, including a single large listing.",
			"For read-only workflows with known schemas, keep deterministic loops and branches (such as graph traversal or binary search) in one bounded run_code script. Dependent calls do not necessarily require model judgment.",
			"Use direct calls for small results you can answer reliably without scripting, including trivial projections or filters, and for questions to the user. Stop the script for ambiguous evidence, an unfamiliar tool, or a new strategy.",
			"In run_code scripts, print relevant fields, counts, and summaries rather than whole tool results.",
			"When a run_code script fails, check which nested calls completed before running it again.",
		],
		parameters: runCodeSchema,
		// Sibling calls never run during a script, where a sibling MCP call would bypass the per-server limit.
		executionMode: "sequential",
		present: presentRunCode,
		async execute(toolCallId, params, signal, onUpdate) {
			const startedAt = performance.now();
			const prepared = prepareScript(params.code);
			// Fixed when the script starts (section 5.9).
			const bindings = computeCodeModeBindings(options.bindingSources());
			const targets = new Map(bindings.map((binding) => [binding.name, binding.target]));
			const images = new CodeModeImageStore();
			const callArgs = new Map<number, Record<string, unknown>>();
			// The source of each image reference issued, in the order they were issued.
			const imageSources = new Map<string, string>();
			let result: CodeModeScriptResult;
			if (prepared.ok) {
				const handle = createCodeModeCallHandler({
					host: options.dispatchHost(),
					bindings,
					parentToolCallId: toolCallId,
				});
				const progress = onUpdate && new RunCodeProgressReporter(onUpdate, prepared.language);
				try {
					result = await runCodeModeScript(options.pool ?? getCodeModeWorkerPool(), {
						code: prepared.code,
						bindings,
						signal,
						...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
						images,
						stored: options.storedValues(),
						onCall: (call) => {
							callArgs.set(call.seq, call.args);
							const target = targets.get(call.binding);
							const handled = handle({
								...call,
								images: taggingImages(call.images, (ref) => {
									if (target) imageSources.set(ref.ref, imageSource(target, call.args, ref));
								}),
							});
							progress?.callStarted(
								call.seq,
								target === undefined ? call.binding : toolLabel(target),
								call.args,
								handled,
							);
							return handled;
						},
						...(progress ? { onOutput: (item: CodeModeOutputItem) => progress.output(item) } : {}),
					});
				} finally {
					progress?.close();
				}
			} else {
				result = {
					ok: false,
					failure: { kind: "script_error", phase: "evaluate", error: prepared.error },
					started: false,
					output: [],
					calls: [],
					durationMs: performance.now() - startedAt,
					storeWrites: { set: [], delete: [] },
				};
			}
			// Kept when the script failed too: its side effects stay, and a script that records progress can resume.
			if (result.storeWrites.set.length > 0 || result.storeWrites.delete.length > 0) {
				await options.recordStoreWrites(result.storeWrites);
			}
			const calls = result.calls.map((record): CodeModeRenderCall => {
				const target = targets.get(record.binding);
				const args = callArgs.get(record.seq);
				return {
					...record,
					tool: target === undefined ? record.binding : toolLabel(target),
					...(args === undefined ? {} : { args }),
					readOnly: target !== undefined && options.callIsReadOnly(target, args ?? {}),
				};
			});
			// Images whose values reached the script; the store drops the others.
			const received = [...imageSources].flatMap(([ref, source]): CodeModeRenderImage[] => {
				const stored = images.get(ref);
				return stored === undefined ? [] : [{ stored, source }];
			});
			const rendered = await renderCodeModeResult({
				result,
				calls,
				images: received,
				autoResizeImages: options.autoResizeImages,
			});
			const details = buildRunCodeDetails({
				result,
				calls,
				rendered,
				language: prepared.ok ? prepared.language : "typescript",
			});
			return { content: rendered.content, details, ...(rendered.isError ? { isError: true } : {}) };
		},
	};
}

export function createRunCodeTool(options: RunCodeToolOptions): AgentTool<typeof runCodeSchema, RunCodeToolDetails> {
	return wrapToolDefinition(createRunCodeToolDefinition(options));
}
