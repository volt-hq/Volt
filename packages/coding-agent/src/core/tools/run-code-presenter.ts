/**
 * The `run_code` card (section 5.16 of docs/code-mode-design.md), built only from existing node types so every
 * client draws it: the script, its nested calls as steps, and its output as terminal lines. While the script runs it
 * reads the progress partial results carry; once it ends, the call records of its final `details`. Pure and
 * stateless like every presenter: it checks each field it reads, because `details` may come from an older log or a
 * tool that replaced `run_code` by name.
 */

import type { UiNode, UiNodeStyledText } from "@hansjm10/volt-protocol";
import type { UiStyledLine } from "../ui/ansi-tokens.ts";
import { outputLines, resultText, serializedBytes, type ToolPresenter } from "../ui/presentation.ts";
import { activityOf, errorNode, isRecord, oneLine, stringArg, textNode } from "./present-utils.ts";
import { formatDuration } from "./render-utils.ts";

type Step = Extract<UiNode, { type: "progress"; kind: "steps" }>["steps"][number];
type CallStatus = "running" | "completed" | "failed" | "cancelled" | "unsettled";

/** Calls the expanded card lists, newest first, within {@link CALLS_BYTES}. */
const CARD_CALLS = 50;
/** Calls the collapsed card lists while the script runs, within {@link RECENT_CALLS_BYTES}. */
const RECENT_CALLS = 5;
/**
 * Bytes the listed calls take, which presentation fitting cannot trim, unlike the code and terminal nodes: with the
 * title and summary, the card stays within the 16 KB bound for paired devices whatever the calls hold.
 */
const CALLS_BYTES = 8 * 1024;
const RECENT_CALLS_BYTES = 2 * 1024;
/** Output lines the card shows: the newest. */
const OUTPUT_LINES = 100;
/**
 * Characters of one output line, and of the script, the card carries. Presentations far over a client's bound are
 * refused before they are fitted, so the card stays well within that whatever the script and its output hold;
 * fitting trims the rest.
 */
const OUTPUT_LINE_CHARS = 256;
const SCRIPT_CHARS = 16 * 1024;
const STEP_LABEL_CHARS = 100;
const STEP_DETAIL_CHARS = 120;

const STEP_STATUS: Record<CallStatus, Step["status"]> = {
	running: "active",
	completed: "done",
	failed: "failed",
	cancelled: "skipped",
	unsettled: "failed",
};

/** How a failed script's summary names its failure, by `failureKind`. */
const FAILURE_LABELS: Record<string, string> = {
	script_error: "Script error",
	compute_budget: "Compute budget exhausted",
	call_budget: "Call budget exhausted",
	timeout: "Timed out",
	aborted: "Aborted",
	output_limit: "Output limit exceeded",
	sandbox: "Sandbox failure",
};

/** A nested call as the card reads it from progress or final `details`. */
interface CardCall {
	seq: number;
	tool: string;
	argsPreview?: string;
	status: CallStatus;
	/** Epoch milliseconds; progress only. */
	startedAt?: number;
	endedAt?: number;
	/** Final details only. */
	durationMs?: number;
	error?: string;
}

/** What `details` hold, checked: progress while the script runs, or the record of a run that ended. */
interface Card {
	running: boolean;
	language: "javascript" | "typescript" | undefined;
	/** Oldest first, unique by `seq`. */
	calls: CardCall[];
	totals: Record<CallStatus, number>;
	total: number;
	/** Progress only: lines of output so far. */
	outputLines?: number;
	/** Final details only. */
	failed?: boolean;
	failureKind?: string;
	wallMs?: number;
	complete?: boolean;
}

function count(value: unknown): number {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function epochMs(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
		? Math.round(value)
		: undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function parseCall(value: unknown, statuses: ReadonlySet<CallStatus>): CardCall | undefined {
	if (!isRecord(value) || !Number.isSafeInteger(value.seq) || typeof value.tool !== "string") return undefined;
	if (typeof value.status !== "string" || !statuses.has(value.status as CallStatus)) return undefined;
	const startedAt = epochMs(value.startedAt);
	const endedAt = epochMs(value.endedAt);
	const durationMs = typeof value.durationMs === "number" && value.durationMs >= 0 ? value.durationMs : undefined;
	const argsPreview = text(value.argsPreview);
	const error = text(value.error);
	return {
		seq: value.seq as number,
		tool: value.tool,
		status: value.status as CallStatus,
		...(argsPreview === undefined ? {} : { argsPreview }),
		...(startedAt === undefined ? {} : { startedAt }),
		...(endedAt === undefined || startedAt === undefined || endedAt < startedAt ? {} : { endedAt }),
		...(durationMs === undefined ? {} : { durationMs }),
		...(error === undefined ? {} : { error }),
	};
}

const PROGRESS_STATUSES: ReadonlySet<CallStatus> = new Set(["running", "completed", "failed", "cancelled"]);
const FINAL_STATUSES: ReadonlySet<CallStatus> = new Set(["completed", "failed", "cancelled", "unsettled"]);

function parseCard(details: unknown): Card | undefined {
	if (!isRecord(details)) return undefined;
	const running = details.status === "running";
	if (!running && details.status !== "completed" && details.status !== "failed") return undefined;
	const statuses = running ? PROGRESS_STATUSES : FINAL_STATUSES;
	const bySeq = new Map<number, CardCall>();
	for (const value of Array.isArray(details.calls) ? details.calls : []) {
		const call = parseCall(value, statuses);
		if (call) bySeq.set(call.seq, call);
	}
	const calls = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
	const recorded = isRecord(details.callTotals) ? details.callTotals : undefined;
	const totals: Record<CallStatus, number> = { running: 0, completed: 0, failed: 0, cancelled: 0, unsettled: 0 };
	for (const status of statuses) totals[status] = recorded ? count(recorded[status]) : 0;
	if (!recorded) for (const call of calls) totals[call.status]++;
	const sum = Object.values(totals).reduce((left, right) => left + right, 0);
	const language =
		details.language === "typescript" || details.language === "javascript" ? details.language : undefined;
	const card: Card = { running, language, calls, totals, total: Math.max(sum, calls.length) };
	if (running) return { ...card, outputLines: count(details.outputLines) };
	const failureKind = text(details.failureKind);
	return {
		...card,
		failed: details.status === "failed",
		...(failureKind === undefined ? {} : { failureKind }),
		...(typeof details.wallMs === "number" && details.wallMs >= 0 ? { wallMs: details.wallMs } : {}),
		complete: details.complete !== false,
	};
}

function plural(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A nested call's duration: milliseconds below a second, where most calls finish. */
function callDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : formatDuration(ms);
}

function step(call: CardCall): Step {
	const label = oneLine(
		call.argsPreview === undefined ? call.tool : `${call.tool} ${call.argsPreview}`,
		STEP_LABEL_CHARS,
	);
	const notes: string[] = [];
	if (call.status === "unsettled") notes.push("may have applied");
	if (call.startedAt === undefined && call.durationMs !== undefined) notes.push(callDuration(call.durationMs));
	if (call.error !== undefined) notes.push(call.error);
	const detail = notes.length === 0 ? undefined : oneLine(notes.join(" · "), STEP_DETAIL_CHARS);
	const failed = call.error !== undefined || call.status === "unsettled";
	return {
		key: `#${call.seq}`,
		label,
		status: STEP_STATUS[call.status],
		...(detail === undefined ? {} : { detail: [{ text: detail, token: failed ? "error" : "muted" }] }),
		...(call.startedAt === undefined ? {} : { startedAt: call.startedAt }),
		...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
	};
}

/** The newest calls as steps, oldest first: at most `max`, within `maxBytes`. */
function newestSteps(calls: readonly CardCall[], max: number, maxBytes: number): Step[] {
	const steps: Step[] = [];
	let bytes = 0;
	for (let index = calls.length - 1; index >= 0 && steps.length < max; index--) {
		const next = step(calls[index]);
		bytes += serializedBytes(next) + 1;
		if (bytes > maxBytes) break;
		steps.push(next);
	}
	return steps.reverse();
}

/** The steps of the newest calls, titled with how many calls the script made. */
function callsNode(card: Card, key: string, max: number, maxBytes: number, titled: boolean): UiNode[] {
	const steps = newestSteps(card.calls, max, maxBytes);
	if (steps.length === 0) return [];
	const shown = steps.length < card.total ? `, newest ${steps.length} shown` : "";
	return [
		{
			type: "progress",
			kind: "steps",
			key,
			...(titled ? { title: `${plural(card.total, "tool call")}${shown}` } : {}),
			steps,
		},
	];
}

/** How a run that ended went: its failure, its calls, and how long it took. */
function statusText(card: Card): string {
	const parts = [plural(card.total, "tool call")];
	if (card.totals.failed > 0) parts.push(`${card.totals.failed} failed`);
	if (card.totals.cancelled > 0) parts.push(`${card.totals.cancelled} cancelled`);
	if (card.totals.unsettled > 0) parts.push(`${card.totals.unsettled} still running at the end`);
	if (card.wallMs !== undefined) parts.push(formatDuration(card.wallMs));
	const counts = parts.join(", ");
	if (!card.failed) return counts;
	const failure = (card.failureKind && FAILURE_LABELS[card.failureKind]) ?? "Failed";
	return `${failure} · ${counts}`;
}

function title(args: Record<string, unknown>): UiNodeStyledText {
	const description = stringArg(args, "description")?.trim();
	if (description) return [{ text: oneLine(description) }];
	const first = stringArg(args, "code")
		?.split(/\r?\n/)
		.find((line) => line.trim() !== "");
	if (first !== undefined) return [{ text: oneLine(first), code: true }];
	return [
		{ text: "run_code", bold: true },
		{ text: " …", token: "muted" },
	];
}

/** `text` cut to `max` characters, ending in `…`, never between the halves of a surrogate pair. */
function cut(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max - 1;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end--;
	return `${text.slice(0, end)}…`;
}

/** A styled line cut to `max` characters of text. */
function cutLine(line: UiStyledLine, max: number): UiStyledLine {
	if (typeof line === "string") return cut(line, max);
	const spans: Exclude<UiStyledLine, string> = [];
	let left = max;
	for (const span of line) {
		if (left <= 0) break;
		const text = span.text.length > left ? cut(span.text, left) : span.text;
		spans.push({ ...span, text });
		left -= span.text.length;
	}
	return spans;
}

/** The script as the card carries it: its start, cut at a line when it is long. */
function scriptText(code: string): string {
	if (code.length <= SCRIPT_CHARS) return code;
	const start = cut(code, SCRIPT_CHARS).slice(0, -1);
	const line = start.lastIndexOf("\n");
	return `${line > 0 ? start.slice(0, line) : start}\n…`;
}

/** The newest output lines as a terminal node, with the rest counted. */
function outputNode(output: string, totalLines: number | undefined): UiNode[] {
	const lines = outputLines(output);
	if (lines.length === 0) return [];
	const shown = lines.slice(-OUTPUT_LINES).map((line) => cutLine(line, OUTPUT_LINE_CHARS));
	const omitted = Math.max(totalLines ?? lines.length, lines.length) - shown.length;
	return [{ type: "terminal", key: "output", lines: shown, ...(omitted > 0 ? { omittedLines: omitted } : {}) }];
}

/**
 * run_code: titled by the call's description, else the script's first line. Running, it says how many calls the
 * script made and how many still run, and collapsed shows the newest five; once it ends, collapsed shows how it went.
 * Expanded: the script, the newest 50 calls (with their times while it runs, their durations and errors once it
 * ends), and the newest 100 lines of output while it runs, or of the result once it ends.
 */
export const presentRunCode: ToolPresenter = (input) => {
	const result = input.result;
	const card = parseCard(result?.details);
	const live = card?.running === true && input.state === "running" ? card : undefined;
	const ended = input.state === "done" && card !== undefined && !card.running ? card : undefined;

	const activity =
		input.state === "running"
			? live === undefined
				? "Running script"
				: `Running script: ${plural(live.total, "call")}, ${live.totals.running} running`
			: activityOf(input, "Writing script", "Running script");

	let summary: UiNode[] = [];
	if (live !== undefined) summary = callsNode(live, "recent", RECENT_CALLS, RECENT_CALLS_BYTES, false);
	else if (ended !== undefined) summary = [textNode("status", statusText(ended), ended.failed ? "error" : undefined)];
	else if (input.state === "done" && result?.isError === true) summary = errorNode(input).slice(0, 1);

	const code = stringArg(input.args, "code");
	const language = (live ?? ended)?.language ?? "javascript";
	const shownCard = live ?? ended;
	const body: UiNode[] = [
		...(code ? [{ type: "code" as const, key: "script", language, code: scriptText(code) }] : []),
		...(shownCard === undefined ? [] : callsNode(shownCard, "calls", CARD_CALLS, CALLS_BYTES, true)),
		...(ended?.complete === false
			? [textNode("incomplete", "Some read-only call records were dropped to keep the record small.", "muted")]
			: []),
		...(live !== undefined
			? outputNode(resultText(result), live.outputLines)
			: input.state === "done"
				? outputNode(resultText(result), undefined)
				: []),
	];

	return {
		title: title(input.args),
		...(activity === undefined ? {} : { activity }),
		...(summary.length === 0 ? {} : { summary }),
		...(body.length === 0 ? {} : { body }),
		showsDuration: true,
	};
};
