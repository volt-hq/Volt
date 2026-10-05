/**
 * Presentations (RFC §4.3, §8.3): how a tool call or a custom message looks,
 * as `UiNode` data. A tool's `present()` and a custom message type's message
 * presenter are pure, synchronous, and stateless: the same input gives the
 * same presentation, so the host computes presentations whenever it projects
 * an entry or streams a call and never stores them. Clients draw the generic
 * chrome around a presentation (state, elapsed time, collapsing, the result's
 * images) and never run tool code.
 *
 * Every presentation is normalized on the host (normalize.ts): ANSI styling
 * becomes semantic tokens, actions an extension may not bind are dropped, and
 * the data is bounded. A presentation over the profile's bound first loses
 * the oldest lines of its terminal output and the end of its code and diffs;
 * one that still does not fit, one that is invalid, and one whose presenter
 * throws is replaced by the generic presentation, as is a call whose tool has
 * no presenter (such as a disabled extension's tool).
 */

import type { ImageContent, JsonValue, TextContent } from "@hansjm10/volt-ai";
import {
	type MessagePresentation,
	MessagePresentationSchema,
	type ToolPresentation,
	ToolPresentationSchema,
	UI_NODE_LINE_MAX_CHARS,
	UI_NODE_TERMINAL_MAX_LINES,
	type UiNode,
	type UiNodeAction,
	UiNodeActionSchema,
	type UiNodeStyledText,
	type WorkProgress,
} from "@hansjm10/volt-protocol";
import { Compile, type Validator } from "typebox/compile";
import { ansiToStyledLines, stripTerminalControls, type UiStyledLine } from "./ansi-tokens.ts";
import {
	isAllowedUiIntent,
	normalizeStyledText,
	normalizeUiNodes,
	type UiActionPolicy,
	UiNormalizeError,
} from "./normalize.ts";

// ============================================================================
// Presenter types
// ============================================================================

/** Where a call is: its arguments still stream (`pending`), its tool runs (`running`), or it ended (`done`). */
export type ToolPresentState = "pending" | "running" | "done";

/** A call's result as its presenter sees it: the final one, or the latest partial one while it runs. */
export interface ToolPresentResult<TDetails = unknown> {
	readonly content: readonly (TextContent | ImageContent)[];
	readonly details?: TDetails;
	readonly isError: boolean;
	/** A partial result the call reported while it runs. */
	readonly partial: boolean;
}

/**
 * What a tool's `present()` sees of one call. `args` holds what was parsed
 * so far, which may be incomplete while `argsComplete` is false and may hold
 * values of the wrong type: a presenter checks what it reads.
 */
export interface ToolPresentInput<TArgs = Record<string, unknown>, TDetails = unknown> {
	readonly args: Partial<TArgs>;
	readonly argsComplete: boolean;
	readonly state: ToolPresentState;
	readonly result?: ToolPresentResult<TDetails>;
	/** The conversation's working directory, for showing paths relative to it. */
	readonly cwd: string;
}

/** A tool's presenter: pure, synchronous, and stateless. A presenter that throws gets the generic presentation. */
export type ToolPresenter<TArgs = Record<string, unknown>, TDetails = unknown> = (
	input: ToolPresentInput<TArgs, TDetails>,
) => ToolPresentation;

/** What a message presenter sees of one custom message. */
export interface MessagePresentInput<T = JsonValue> {
	readonly customType: string;
	readonly content: string | readonly (TextContent | ImageContent)[];
	readonly details?: T;
}

/** A custom message type's presenter: pure, synchronous, and stateless. */
export type MessagePresenter<T = JsonValue> = (message: MessagePresentInput<T>) => MessagePresentation;

/**
 * What a work kind's detail presenter sees of one running work item. Every
 * client sees the detail, so a kind that `requires` remote capabilities sees
 * no input (`null`) and no output text.
 */
export interface WorkDetailInput {
	readonly workId: string;
	readonly title: string;
	/** The input the work started with, as the log keeps it. */
	readonly input: JsonValue;
	readonly state: "running" | "cancelling";
	readonly progress?: WorkProgress;
	/** The newest output the work reported, and how many bytes it reported in all. */
	readonly output: { readonly text: string; readonly truncated: boolean; readonly bytes: number };
}

/** A work kind's detail presenter: pure, synchronous, and stateless; `undefined` for no detail. */
export type WorkDetailPresenter = (work: WorkDetailInput) => UiNode | undefined;

/** A tool presenter, with the actions its presentations may bind. */
export interface ResolvedToolPresenter {
	readonly present: ToolPresenter;
	readonly policy: UiActionPolicy;
}

/** A message presenter, with the actions its presentations may bind. */
export interface ResolvedMessagePresenter {
	readonly present: MessagePresenter;
	readonly policy: UiActionPolicy;
}

/**
 * The presenters a conversation's host holds: built-in tools', extension
 * tools', and extension message types'. `generation` changes whenever one is
 * registered or removed, so what was presented with an older generation is
 * presented again.
 */
export interface PresenterSet {
	readonly generation: number;
	tool(toolName: string): ResolvedToolPresenter | undefined;
	message(customType: string): ResolvedMessagePresenter | undefined;
}

/** The action policy of host code: built-in tools bind any intent. */
export const HOST_UI_POLICY: UiActionPolicy = Object.freeze({ owner: "host" });

// ============================================================================
// Bounds
// ============================================================================

/** Largest title or activity, as serialized JSON in UTF-8 bytes. */
const TITLE_MAX_SERIALIZED_BYTES = 2 * 1024;
/** Longest argument JSON the generic presentation shows, in characters. */
const GENERIC_ARGS_MAX_CHARS = 2_000;
/** Output lines the generic presentation shows collapsed. */
const GENERIC_SUMMARY_LINES = 10;

const encoder = new TextEncoder();

/** Serialized size in UTF-8 bytes. */
export function serializedBytes(value: unknown): number {
	return encoder.encode(JSON.stringify(value) ?? "").byteLength;
}

let presentationValidator: Validator | undefined;
let messageValidator: Validator | undefined;
let actionValidator: Validator | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ============================================================================
// Normalization
// ============================================================================

export interface PresentationNormalizeOptions {
	readonly policy: UiActionPolicy;
	/** The profile's bound: `PRESENTATION_MAX_SERIALIZED_BYTES`, or the remote one. */
	readonly maxBytes: number;
}

/** Presenter output larger than this many times the bound, as JSON, is refused before it is read. */
const INPUT_BUDGET_FACTOR = 8;

/**
 * Presenter output as plain JSON data, read once: getters, prototypes, and
 * `toJSON` cannot answer one way when checked and another when sent. Output
 * that is not JSON, or far over `maxBytes`, is refused.
 */
function plainJson(value: unknown, maxBytes: number): unknown {
	let json: string | undefined;
	try {
		json = JSON.stringify(value);
	} catch (error) {
		throw new UiNormalizeError(
			`A presentation is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (json === undefined) throw new UiNormalizeError("A presentation is not JSON");
	if (json.length > maxBytes * INPUT_BUDGET_FACTOR) {
		throw new UiNormalizeError(`A presentation exceeds the ${maxBytes}-byte bound`);
	}
	return JSON.parse(json);
}

/**
 * Whether a presenter returned a promise (presenters are synchronous): its
 * rejection is observed, so it never ends the host, and the value is refused.
 */
export function refuseThenable(value: unknown): void {
	if ((typeof value === "object" || typeof value === "function") && value !== null && "then" in value) {
		const then = (value as { then?: unknown }).then;
		if (typeof then === "function") {
			try {
				then.call(value, undefined, () => {});
			} catch {
				// A thenable that throws when observed is refused all the same.
			}
			throw new UiNormalizeError("A presenter must return its presentation, not a promise");
		}
	}
}

/** A title or activity: ANSI styling to tokens, one line, bounded. */
function normalizeLine(value: unknown): UiNodeStyledText {
	const text = normalizeStyledText(value, { maxBytes: TITLE_MAX_SERIALIZED_BYTES });
	return typeof text === "string"
		? text.replace(/\s*\n\s*/g, " ")
		: text.map((span) => ({ ...span, text: span.text.replace(/\s*\n\s*/g, " ") }));
}

function normalizeActions(value: unknown, policy: UiActionPolicy): UiNodeAction[] {
	if (!Array.isArray(value)) throw new UiNormalizeError("Presentation actions must be an array");
	actionValidator ??= Compile(UiNodeActionSchema);
	const kept: UiNodeAction[] = [];
	const ids = new Set<string>();
	for (const raw of value) {
		const action =
			isRecord(raw) && typeof raw.label === "string" ? { ...raw, label: stripTerminalControls(raw.label) } : raw;
		if (!actionValidator.Check(action)) throw new UiNormalizeError("Invalid presentation action");
		const typed = action as UiNodeAction;
		if (ids.has(typed.id)) throw new UiNormalizeError(`Duplicate presentation action id "${typed.id}"`);
		ids.add(typed.id);
		if (isAllowedUiIntent(typed.intent, policy)) kept.push(typed);
	}
	return kept;
}

/**
 * A tool presentation as clients may receive it: normalized, its actions
 * filtered by `policy`, and fitted to `maxBytes` (`fitPresentation`). Throws
 * `UiNormalizeError` for data that is invalid or does not fit.
 */
export function normalizeToolPresentation(input: unknown, options: PresentationNormalizeOptions): ToolPresentation {
	refuseThenable(input);
	const value = plainJson(input, options.maxBytes);
	if (!isRecord(value)) throw new UiNormalizeError("A presentation must be an object");
	const nodeOptions = { policy: options.policy, maxBytes: options.maxBytes * 8 };
	const { title, activity, summary, body, actions, hidden, showsDuration } = value;
	const kept = actions === undefined ? [] : normalizeActions(actions, options.policy);
	const summaryNodes = summary === undefined ? [] : normalizeUiNodes(summary, nodeOptions);
	const bodyNodes = body === undefined ? [] : normalizeUiNodes(body, nodeOptions);
	// An empty tree is an absent one, as patches leave it.
	const presentation: ToolPresentation = {
		title: normalizeLine(title),
		...(activity === undefined ? {} : { activity: normalizeLine(activity) }),
		...(summaryNodes.length === 0 ? {} : { summary: summaryNodes }),
		...(bodyNodes.length === 0 ? {} : { body: bodyNodes }),
		...(kept.length === 0 ? {} : { actions: kept }),
		...(hidden === true ? { hidden: true } : {}),
		...(showsDuration === true ? { showsDuration: true } : {}),
	};
	presentationValidator ??= Compile(ToolPresentationSchema);
	if (!presentationValidator.Check(presentation)) throw new UiNormalizeError("Invalid tool presentation");
	const fitted = fitPresentation(presentation, options.maxBytes);
	if (fitted === undefined) {
		throw new UiNormalizeError(`The presentation does not fit in ${options.maxBytes} bytes`);
	}
	return fitted;
}

/** A message presentation as clients may receive it; throws `UiNormalizeError` as tool presentations do. */
export function normalizeMessagePresentation(
	input: unknown,
	options: PresentationNormalizeOptions,
): MessagePresentation {
	refuseThenable(input);
	const value = plainJson(input, options.maxBytes);
	if (!isRecord(value)) throw new UiNormalizeError("A presentation must be an object");
	const nodeOptions = { policy: options.policy, maxBytes: options.maxBytes * 8 };
	const { title, summary, body } = value;
	const summaryNodes = summary === undefined ? [] : normalizeUiNodes(summary, nodeOptions);
	const presentation: MessagePresentation = {
		...(title === undefined ? {} : { title: normalizeLine(title) }),
		...(summaryNodes.length === 0 ? {} : { summary: summaryNodes }),
		body: normalizeUiNodes(body, nodeOptions),
	};
	messageValidator ??= Compile(MessagePresentationSchema);
	if (!messageValidator.Check(presentation)) throw new UiNormalizeError("Invalid message presentation");
	const fitted = fitPresentation(presentation, options.maxBytes);
	if (fitted === undefined) {
		throw new UiNormalizeError(`The presentation does not fit in ${options.maxBytes} bytes`);
	}
	return fitted;
}

// ============================================================================
// Fitting
// ============================================================================

/** A trimmable leaf in a presentation's trees, with how to cut `bytes` from it. */
interface Trimmable {
	readonly bytes: number;
	/** Cut at least `excess` bytes; how many bytes it cut, about (0 when nothing is left to cut). */
	cut(excess: number): number;
}

function trimmables(nodes: UiNode[] | undefined, found: Trimmable[]): void {
	for (const node of nodes ?? []) {
		switch (node.type) {
			case "terminal":
				found.push(terminalTrim(node));
				break;
			case "code":
				found.push(codeTrim(node));
				break;
			case "diff":
				found.push(diffTrim(node));
				break;
			case "list":
				trimmables(node.items, found);
				break;
			case "card":
				for (const section of node.sections ?? []) trimmables(section.children, found);
				break;
			default:
				break;
		}
	}
}

/** Drops a terminal's oldest lines, counting them in `omittedLines`: what it keeps is still its newest output. */
function terminalTrim(node: Extract<UiNode, { type: "terminal" }>): Trimmable {
	return {
		bytes: serializedBytes(node.lines),
		cut(excess) {
			if (node.lines.length === 0) return 0;
			let removed = 0;
			let drop = 0;
			while (drop < node.lines.length && removed < excess) removed += serializedBytes(node.lines[drop++]) + 1;
			node.lines = node.lines.slice(drop);
			node.omittedLines = (node.omittedLines ?? 0) + drop;
			return removed;
		},
	};
}

/** Cuts code from its end at a line, marking the cut. */
function codeTrim(node: Extract<UiNode, { type: "code" }>): Trimmable {
	return {
		bytes: serializedBytes(node.code),
		cut(excess) {
			if (node.code.length === 0 || node.code === "…") return 0;
			const lines = node.code.split("\n");
			let removed = 0;
			while (lines.length > 0 && removed < excess + 8) removed += serializedBytes(lines.pop()) + 1;
			node.code = lines.length === 0 ? "…" : `${lines.join("\n")}\n…`;
			return removed;
		},
	};
}

/** Cuts a diff's last lines, ending it with a `meta` line that says how many. */
function diffTrim(node: Extract<UiNode, { type: "diff" }>): Trimmable {
	return {
		bytes: serializedBytes(node.lines),
		cut(excess) {
			const marker = node.lines.at(-1)?.kind === "meta" && node.lines.at(-1)?.text.startsWith("… ");
			const lines = marker ? node.lines.slice(0, -1) : [...node.lines];
			if (lines.length === 0) return 0;
			let removed = 0;
			let dropped = marker ? Number.parseInt(node.lines.at(-1)?.text.slice(2) ?? "0", 10) || 0 : 0;
			while (lines.length > 0 && removed < excess + 40) {
				removed += serializedBytes(lines.pop()) + 1;
				dropped++;
			}
			node.lines = [...lines, { kind: "meta", text: `… ${dropped} more lines` }];
			return removed;
		},
	};
}

/** Passes over a presentation's leaves `fitPresentation` makes at most, each measuring the whole once. */
const FIT_PASSES = 3;

/**
 * `presentation` within `maxBytes`: unchanged when it fits; otherwise a copy
 * whose largest terminal outputs lose their oldest lines and whose largest
 * code and diffs lose their end until it fits. Undefined when even that does
 * not fit. Deterministic, so successive streamed presentations trimmed alike
 * still differ by appended lines. Linear in the presentation's size: cuts
 * count what they removed, and the whole is measured once per pass.
 */
export function fitPresentation<T extends ToolPresentation | MessagePresentation>(
	presentation: T,
	maxBytes: number,
): T | undefined {
	let size = serializedBytes(presentation);
	if (size <= maxBytes) return presentation;
	const copy = structuredClone(presentation);
	const found: Trimmable[] = [];
	trimmables(copy.body, found);
	trimmables(copy.summary, found);
	found.sort((left, right) => right.bytes - left.bytes);
	for (let pass = 0; pass < FIT_PASSES; pass++) {
		let estimate = size;
		for (const trimmable of found) {
			if (estimate <= maxBytes) break;
			estimate -= trimmable.cut(estimate - maxBytes);
		}
		size = serializedBytes(copy);
		if (size <= maxBytes) return copy;
	}
	return undefined;
}

// ============================================================================
// The generic presentation
// ============================================================================

/** The text blocks of a result, joined. */
export function resultText(result: ToolPresentResult | undefined): string {
	if (!result) return "";
	return result.content
		.filter((block): block is TextContent => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Output text as styled terminal lines, without trailing blank lines. */
export function outputLines(text: string): UiStyledLine[] {
	const lines = ansiToStyledLines(text);
	while (lines.length > 0) {
		const last = lines.at(-1);
		const blank = typeof last === "string" ? last.trim() === "" : last?.every((span) => span.text.trim() === "");
		if (!blank) break;
		lines.pop();
	}
	return lines.slice(-UI_NODE_TERMINAL_MAX_LINES);
}

function cutChars(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * How a call looks without a presenter of its own: its tool's name, its
 * arguments as JSON, and its output. Within `maxBytes` whatever the call
 * holds; at the least, the tool's name.
 */
export function genericToolPresentation(toolName: string, input: ToolPresentInput, maxBytes: number): ToolPresentation {
	const title = cutChars(stripTerminalControls(toolName).replace(/\s+/g, " ").trim() || "tool", 256);
	let argsJson: string;
	try {
		argsJson = JSON.stringify(input.args, null, 2) ?? "";
	} catch {
		argsJson = "";
	}
	const args: UiNode[] =
		argsJson && argsJson !== "{}"
			? [
					{
						type: "code",
						key: "args",
						language: "json",
						code: stripTerminalControls(cutChars(argsJson, GENERIC_ARGS_MAX_CHARS)),
					},
				]
			: [];
	const lines = outputLines(boundedOutput(resultText(input.result), maxBytes * 2));
	const isError = input.result?.isError === true && !input.result.partial;
	const output = (shown: UiStyledLine[]): UiNode[] =>
		shown.length === 0
			? []
			: isError
				? [{ type: "text", key: "output", text: shown.map(lineText).join("\n"), token: "error" }]
				: [{ type: "terminal", key: "output", lines: shown }];
	const summaryLines =
		input.state === "done" ? lines.slice(0, GENERIC_SUMMARY_LINES) : lines.slice(-GENERIC_SUMMARY_LINES);
	// Output the summary shows whole, without arguments, needs no body.
	const fits = args.length === 0 && summaryLines.length === lines.length;
	const presentation: ToolPresentation = {
		title,
		...(summaryLines.length === 0 ? {} : { summary: output(summaryLines) }),
		...(fits ? {} : { body: [...args, ...output(lines)] }),
	};
	// Normalized as a presenter's would be: lines within their bound, the whole within `maxBytes`.
	try {
		return normalizeToolPresentation(presentation, { policy: HOST_UI_POLICY, maxBytes });
	} catch {
		return { title };
	}
}

/** The newest output lines within about `maxChars`, each cut to the line bound: what the generic presentation shows of it. */
function boundedOutput(text: string, maxChars: number): string {
	const kept: string[] = [];
	let chars = 0;
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0 && kept.length < UI_NODE_TERMINAL_MAX_LINES; index--) {
		const line = cutChars(lines[index] ?? "", UI_NODE_LINE_MAX_CHARS);
		chars += line.length + 1;
		if (chars > maxChars && kept.length > 0) break;
		kept.push(line);
	}
	return kept.reverse().join("\n");
}

function lineText(line: UiStyledLine): string {
	return typeof line === "string" ? line : line.map((span) => span.text).join("");
}

// ============================================================================
// Presenting
// ============================================================================

/**
 * The presentation of one call: what its presenter returns, normalized under
 * the presenter's policy and fitted to `maxBytes`, or the generic one when
 * there is no presenter or it fails. `genericArgs` are the arguments the
 * generic presentation shows, when a profile shows fewer than the call holds.
 */
export function presentToolCall(
	presenter: ResolvedToolPresenter | undefined,
	toolName: string,
	input: ToolPresentInput,
	maxBytes: number,
	genericArgs: Record<string, unknown> = input.args,
): ToolPresentation {
	if (presenter !== undefined) {
		try {
			// An extension's presenter sees a copy: what it changes never reaches the log or another presenter.
			const seen = presenter.policy.owner === "extension" ? structuredClone(input) : input;
			return normalizeToolPresentation(presenter.present(seen), { policy: presenter.policy, maxBytes });
		} catch {
			// A presenter that throws, or returns data that is invalid or too large, gets the generic presentation.
		}
	}
	return genericToolPresentation(toolName, { ...input, args: genericArgs }, maxBytes);
}

/**
 * The presentation of one custom message: what its type's presenter returns,
 * normalized and fitted, or none (clients show its text) without a presenter
 * or when the presenter fails.
 */
export function presentCustomMessage(
	presenter: ResolvedMessagePresenter | undefined,
	message: MessagePresentInput,
	maxBytes: number,
): MessagePresentation | undefined {
	if (presenter === undefined) return undefined;
	try {
		const seen = presenter.policy.owner === "extension" ? structuredClone(message) : message;
		return normalizeMessagePresentation(presenter.present(seen), { policy: presenter.policy, maxBytes });
	} catch {
		return undefined;
	}
}
