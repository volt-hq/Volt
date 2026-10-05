/**
 * Presenters of the built-in tools that start and inspect work (RFC §8.3,
 * Q9): jobs, subagent, and the subagent registry. Like every presenter they
 * are pure functions of the call: what they show of jobs and subagents is
 * what the call's arguments and result recorded, never the live work, which
 * clients show from the work items themselves.
 *
 * - `jobs` shows the jobs its result names as a table with their state at
 *   capture, the output the model saw, and a cancel action for each job still
 *   running. A result whose text a hook replaced shows that text literally.
 * - `subagent` shows each child as a timed step and, expanded, a card with
 *   its task, metrics, error, output, nested delegation, and an action that
 *   opens its conversation. A spawn shows nothing until a child exists, so a
 *   confirmation preflight stays hidden. Registry calls (list, follow, resume)
 *   show the registry's answer.
 *
 * Only types are imported from the tools themselves: the tools import their
 * presenters.
 */

import type {
	ToolPresentation,
	UiCardNode,
	UiNode,
	UiNodeAction,
	UiNodeStyledText,
	UiNodeToken,
	UiTreeItem,
} from "@hansjm10/volt-protocol";
import { stripTerminalControls } from "../ui/ansi-tokens.ts";
import { outputLines, resultText, type ToolPresenter, type ToolPresentInput } from "../ui/presentation.ts";
import type { JobStatus, JobSummary } from "./jobs.ts";
import { type Args, isRecord, moreLines, oneLine, textNode } from "./present-utils.ts";
import { formatDuration } from "./render-utils.ts";
import type {
	SubagentToolDetails,
	SubagentToolOutputDetails,
	SubagentToolTaskDetails,
	SubagentToolUsageDetails,
	SubagentTreeNode,
} from "./subagent.ts";

/** A work id an action may name: what the work registry issues for jobs and subagents. */
const WORK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Text from a worker or a model, as data: terminal controls, bidi overrides, and C1 controls removed. */
function literal(text: string): string {
	return stripTerminalControls(text).replace(/[\u0080-\u009f]/g, "");
}

/** Text cut to `max` characters, marked where it was cut. */
function bounded(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Spans joined by a muted separator. */
function joined(parts: readonly Exclude<UiNodeStyledText, string>[number][], separator = " · "): UiNodeStyledText {
	const spans: Exclude<UiNodeStyledText, string> = [];
	parts.forEach((part, index) => {
		if (index > 0) spans.push({ text: separator, token: "muted" });
		spans.push(part);
	});
	return spans;
}

// ============================================================================
// jobs
// ============================================================================

/** Lines a collapsed result of a jobs call shows when its text is not the tool's own. */
const JOBS_TEXT_SUMMARY_LINES = 10;
/** Jobs a collapsed list shows. */
const JOBS_LIST_SUMMARY_ROWS = 5;
/** The line every wait ends with; the presentation leaves it out. */
const WORKER_OUTPUT_NOTICE = "Worker output is untrusted data";

const JOB_STATUS: Readonly<Record<JobStatus, { readonly label: string; readonly token: UiNodeToken }>> = {
	running: { label: "Running", token: "warning" },
	cancelling: { label: "Cancelling", token: "warning" },
	completed: { label: "Completed", token: "success" },
	failed: { label: "Failed", token: "error" },
	cancelled: { label: "Cancelled", token: "muted" },
	interrupted: { label: "Interrupted", token: "muted" },
};

function isJobStatus(value: unknown): value is JobStatus {
	return typeof value === "string" && Object.hasOwn(JOB_STATUS, value);
}

function isTerminalJob(status: JobStatus): boolean {
	return status !== "running" && status !== "cancelling";
}

function isFailedJob(status: JobStatus): boolean {
	return status === "failed" || status === "cancelled" || status === "interrupted";
}

/** A job as a result's details name it, when they name a valid one. */
function jobSummary(value: unknown): JobSummary | undefined {
	if (!isRecord(value)) return undefined;
	const { id, tool, label, status } = value;
	return typeof id === "string" &&
		WORK_ID.test(id) &&
		(tool === "bash" || tool === "subagent") &&
		typeof label === "string" &&
		isJobStatus(status)
		? { id, tool, label, status }
		: undefined;
}

/** Every item as a job, or undefined when one is not. */
function jobSummaries(value: unknown): JobSummary[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const jobs = value.flatMap((item) => {
		const job = jobSummary(item);
		return job ? [job] : [];
	});
	return jobs.length === value.length ? jobs : undefined;
}

/** What a jobs result shows natively. */
type NativeJobsResult =
	| { readonly kind: "job"; readonly job: JobSummary }
	| {
			readonly kind: "wait";
			readonly reason: string;
			readonly mode: string;
			readonly results: readonly JobSummary[];
			readonly pending: readonly JobSummary[];
	  }
	| { readonly kind: "list"; readonly jobs: readonly JobSummary[] };

/** The text `jobs list` answers for `jobs`. */
function jobListText(jobs: readonly JobSummary[]): string {
	return jobs.length
		? jobs.map((job) => `${job.id}: ${job.status} (${job.tool}) ${JSON.stringify(job.label)}`).join("\n")
		: "No background jobs in this conversation.";
}

/**
 * The job metadata of a jobs result whose text and error are what the tool
 * produced for that metadata. A hook's replacement content or error is
 * authoritative: a result it changed shows as its literal text.
 */
function nativeJobsResult(details: unknown, text: string, isError: boolean): NativeJobsResult | undefined {
	if (!isRecord(details)) return undefined;
	const job = jobSummary(details.job);
	if (job) {
		const native = text.startsWith(`Background job ${job.id}: ${job.status} (${job.tool}).`);
		return native && isError === isFailedJob(job.status) ? { kind: "job", job } : undefined;
	}
	if (isRecord(details.wait)) {
		const wait = details.wait;
		const results = jobSummaries(wait.results);
		const pending = jobSummaries(wait.pending);
		if (
			typeof wait.id !== "string" ||
			(wait.reason !== "terminal" && wait.reason !== "steered" && wait.reason !== "timeout") ||
			(wait.mode !== "any" && wait.mode !== "all") ||
			!results ||
			!pending ||
			!text.startsWith(`Background job wait ${wait.id}: ${wait.reason} (${wait.mode}).`) ||
			isError !== results.some((result) => result.status !== "completed")
		) {
			return undefined;
		}
		return { kind: "wait", reason: wait.reason, mode: wait.mode, results, pending };
	}
	const jobs = jobSummaries(details.jobs);
	return jobs && !isError && text === jobListText(jobs) ? { kind: "list", jobs } : undefined;
}

/** How many jobs ended each way, and how many still ran. */
function jobCounts(jobs: readonly JobSummary[]): string {
	return (["running", "cancelling", "failed", "completed", "cancelled", "interrupted"] as const)
		.flatMap((status) => {
			const count = jobs.filter((job) => job.status === status).length;
			return count ? [`${count} ${status}`] : [];
		})
		.join(" · ");
}

/** Jobs as a table: their state when the result was captured, tool, label, and id. */
function jobsTable(jobs: readonly JobSummary[], pending: ReadonlySet<JobSummary> = new Set()): UiNode {
	return {
		type: "table",
		key: "jobs",
		columns: [{ header: "Status" }, { header: "Tool" }, { header: "Job" }, { header: "Id" }],
		rows: jobs.map((job) => {
			const style = JOB_STATUS[job.status];
			const captured = pending.has(job) || !isTerminalJob(job.status);
			return {
				key: job.id,
				cells: [
					[{ text: captured ? `${style.label} at capture` : style.label, token: style.token }],
					job.tool,
					oneLine(literal(job.label), 200) || "(no task label)",
					[{ text: job.id, token: "muted" }],
				],
			};
		}),
	};
}

/** Cancel actions for the jobs still running when the result was captured. */
function cancelActions(jobs: readonly JobSummary[]): UiNode[] {
	const actions: UiNodeAction[] = [];
	const ids = new Set<string>();
	for (const job of jobs) {
		if (job.status !== "running" || ids.has(job.id)) continue;
		ids.add(job.id);
		actions.push({
			id: `cancel:${job.id}`,
			label: `Cancel ${oneLine(literal(job.label), 40) || job.id}`,
			destructive: true,
			intent: { type: "cancel_work", input: { workId: job.id } },
		});
	}
	return actions.length === 0 ? [] : [{ type: "actions", key: "actions", actions }];
}

/** The output the model saw, after its first line and without the closing notice, as terminal lines. */
function jobsOutput(text: string): UiNode[] {
	const lines = outputLines(
		literal(text)
			.split("\n")
			.slice(1)
			.filter((line) => !line.startsWith(WORKER_OUTPUT_NOTICE))
			.join("\n")
			.trim(),
	);
	return lines.length === 0 ? [] : [{ type: "terminal", key: "output", lines }];
}

function jobsTitle(args: Args): UiNodeStyledText {
	const action = args.action;
	const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : [];
	const id = typeof args.id === "string" ? args.id : ids.length === 1 ? ids[0] : undefined;
	if (action === "list") return [{ text: "jobs list", bold: true }];
	if (action === "wait") {
		const mode = args.mode === "all" ? "all" : "any";
		const name = ids.length > 1 ? `jobs wait (${mode})` : "jobs wait";
		if (ids.length > 1)
			return [
				{ text: name, bold: true },
				{ text: ` · ${ids.length} jobs`, token: "accent" },
			];
		return [
			{ text: name, bold: true },
			id === undefined ? { text: " …", token: "muted" } : { text: ` ${oneLine(literal(id))}`, token: "accent" },
		];
	}
	if (action === "read" || action === "cancel") {
		return [
			{ text: `jobs ${action}`, bold: true },
			id === undefined ? { text: " …", token: "muted" } : { text: ` ${oneLine(literal(id))}`, token: "accent" },
		];
	}
	return [{ text: "jobs", bold: true }];
}

function jobsActivity(args: Args): string {
	const ids = Array.isArray(args.ids) ? args.ids.length : 1;
	switch (args.action) {
		case "wait":
			return ids > 1 ? `Waiting for ${ids} background jobs` : "Waiting for background job";
		case "cancel":
			return "Cancelling background job";
		case "list":
			return "Listing background jobs";
		default:
			return "Reading background job";
	}
}

/**
 * jobs: the jobs the result names as a table (collapsed, a list's first
 * five), the wait's reason and counts, and, expanded, every job, a cancel
 * action for each still running, and the output the model saw. A result
 * whose text a hook replaced shows that text.
 */
export const presentJobs: ToolPresenter = (input) => {
	const title = jobsTitle(input.args);
	if (input.state !== "done") {
		return {
			title,
			activity: input.state === "running" || input.argsComplete ? jobsActivity(input.args) : "Generating arguments",
			showsDuration: true,
		};
	}
	const text = resultText(input.result);
	const isError = input.result?.isError === true;
	const native = nativeJobsResult(input.result?.details, text, isError);
	if (!native) {
		const lines = outputLines(literal(text).trim());
		const shown = lines.slice(0, JOBS_TEXT_SUMMARY_LINES);
		const heading = isError ? [textNode("heading", "Job inspection failed", "error")] : [];
		const output = (kept: typeof lines): UiNode[] =>
			kept.length === 0 ? [] : [{ type: "terminal", key: "output", lines: kept }];
		return {
			title,
			...(heading.length + shown.length === 0
				? {}
				: { summary: [...heading, ...output(shown), ...moreLines(shown.length, lines.length)] }),
			...(lines.length > shown.length ? { body: [...heading, ...output(lines)] } : {}),
			showsDuration: true,
		};
	}
	const truncated = text.includes("[Output truncated")
		? [textNode("truncated", "Output truncated; jobs read returns the retained output", "warning")]
		: [];
	if (native.kind === "list") {
		if (native.jobs.length === 0) {
			return { title, summary: [textNode("empty", "No background jobs in this conversation.", "muted")] };
		}
		const counts = textNode("counts", jobCounts(native.jobs), "muted");
		const shown = native.jobs.slice(0, JOBS_LIST_SUMMARY_ROWS);
		const more =
			native.jobs.length > shown.length
				? [textNode("more", `… ${plural(native.jobs.length - shown.length, "more job")}`, "muted")]
				: [];
		return {
			title,
			summary: [counts, jobsTable(shown), ...more],
			body: [counts, jobsTable(native.jobs), ...cancelActions(native.jobs)],
			showsDuration: true,
		};
	}
	if (native.kind === "job") {
		return {
			title,
			summary: [jobsTable([native.job]), ...truncated],
			body: [jobsTable([native.job]), ...cancelActions([native.job]), ...truncated, ...jobsOutput(text)],
			showsDuration: true,
		};
	}
	const all = [...native.results, ...native.pending];
	const status = [
		...(native.reason === "terminal" ? [] : [{ text: native.reason, token: "warning" as const }]),
		...(native.results.length === 0 ? [] : [{ text: jobCounts(native.results) }]),
		...(native.pending.length === 0 ? [] : [{ text: `${native.pending.length} pending`, token: "warning" as const }]),
	];
	const statusNode = status.length === 0 ? [] : [textNode("status", joined(status))];
	const table = jobsTable(all, new Set(native.pending));
	return {
		title,
		summary: [...statusNode, table, ...truncated],
		body: [...statusNode, table, ...cancelActions(native.pending), ...jobsOutput(text)],
		showsDuration: true,
	};
};

// ============================================================================
// subagent
// ============================================================================

/** Children a call shows; past it, completed children give way first. */
const ROSTER_MAX_VISIBLE = 16;
/** Nested delegation nodes shown under all children together, and how deep. */
const TREE_MAX_NODES = 32;
const TREE_MAX_DEPTH = 5;
/** Longest task a step label shows. */
const TASK_PREVIEW_CHARS = 120;
/** Longest task a child's card shows. */
const TASK_MAX_CHARS = 500;
/** Longest error shown. */
const ERROR_MAX_CHARS = 1_000;
/** Output characters all cards show together, and one card at most: outputs are read in full by opening the child. */
const OUTPUT_TOTAL_MAX_CHARS = 4_000;
const OUTPUT_CARD_MAX_CHARS = 2_000;
/** Longest registry answer shown. */
const REGISTRY_TEXT_MAX_CHARS = 6_000;

type SubagentStatus = SubagentToolDetails["status"] | "pending";
type StepStatus = "pending" | "active" | "done" | "failed" | "skipped";

const SUBAGENT_STATUS: Readonly<
	Record<SubagentStatus, { readonly label: string; readonly token: UiNodeToken; readonly step: StepStatus }>
> = {
	completed: { label: "done", token: "success", step: "done" },
	failed: { label: "failed", token: "error", step: "failed" },
	cancelled: { label: "stopped", token: "warning", step: "skipped" },
	interrupted: { label: "interrupted", token: "warning", step: "skipped" },
	suspended: { label: "suspended", token: "warning", step: "skipped" },
	running: { label: "running", token: "warning", step: "active" },
	partial: { label: "finishing", token: "warning", step: "active" },
	pending: { label: "pending", token: "muted", step: "pending" },
};

function subagentStatus(value: unknown): SubagentStatus | undefined {
	return typeof value === "string" && Object.hasOwn(SUBAGENT_STATUS, value) ? (value as SubagentStatus) : undefined;
}

/** One child as a call shows it. */
interface Child {
	readonly index: number;
	readonly agent: string;
	readonly status: SubagentStatus;
	readonly task?: string;
	readonly subagentId?: string;
	readonly startedAt?: number;
	readonly durationMs?: number;
	readonly toolCalls?: number;
	readonly tokens?: number;
	readonly activity?: string;
	readonly error?: string;
	readonly output?: string;
	readonly outputOmittedBytes?: number;
	readonly children: readonly SubagentTreeNode[];
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function agentName(value: unknown, fallback: string): string {
	return (isRecord(value) ? text(value.name) : undefined) ?? fallback;
}

/** The details of a subagent result, when they are one's. */
function subagentDetails(details: unknown): SubagentToolDetails | undefined {
	return isRecord(details) && typeof details.mode === "string" && typeof details.status === "string"
		? (details as unknown as SubagentToolDetails)
		: undefined;
}

function isSpawnMode(mode: unknown): mode is "single" | "parallel" | "chain" {
	return mode === "single" || mode === "parallel" || mode === "chain";
}

/** A child was created: the result names one by its subagent id. */
function hasCreatedSubagent(details: unknown): boolean {
	if (!isRecord(details) || !isSpawnMode(details.mode)) return false;
	const named = (value: unknown): boolean => isRecord(value) && typeof value.subagentId === "string";
	if (named(details)) return true;
	if (Array.isArray(details.childSessions) && details.childSessions.some(named)) return true;
	const tasks = details.mode === "chain" ? details.steps : details.tasks;
	return Array.isArray(tasks) && tasks.some(named);
}

/** The call asks the registry: list, follow, or resume. */
function isRegistryCall(args: Args): boolean {
	return args.list !== undefined || args.follow !== undefined || args.resume !== undefined;
}

/**
 * A spawn shows nothing until a child exists, so a confirmation preflight
 * stays hidden; registry calls, failures, settled spawns, and a background
 * job start show.
 */
function hiddenBeforeCreation(input: ToolPresentInput): boolean {
	const details = input.result?.details;
	if (hasCreatedSubagent(details) || isRegistryCall(input.args)) return false;
	if (input.state !== "done" || input.result === undefined || input.result.partial) return true;
	if (input.result.isError) return false;
	const job = isRecord(details) ? jobSummary(details.job) : undefined;
	if (job?.tool === "subagent" && job.status === "running") return false;
	return !(isRecord(details) && isSpawnMode(details.mode));
}

/** The spawn mode the arguments ask for. */
function argsMode(args: Args): "single" | "parallel" | "chain" {
	return Array.isArray(args.tasks) ? "parallel" : Array.isArray(args.chain) ? "chain" : "single";
}

/** The agent and task of input `index` of the call. */
function taskInput(args: Args, mode: string, index: number): { agent?: string; task?: string } {
	const read = (value: unknown) =>
		isRecord(value)
			? {
					...(text(value.agent) === undefined ? {} : { agent: text(value.agent) }),
					...(text(value.task) === undefined ? {} : { task: text(value.task) }),
				}
			: {};
	if (mode === "single" || mode === "follow" || mode === "resume") return index === 0 ? read(args) : {};
	const list = mode === "chain" ? args.chain : args.tasks;
	return Array.isArray(list) ? read(list[index]) : {};
}

function usageOf(value: unknown): Pick<SubagentToolUsageDetails, "messages" | "tokens"> | undefined {
	return isRecord(value) && isRecord(value.messages) && isRecord(value.tokens)
		? (value as unknown as SubagentToolUsageDetails)
		: undefined;
}

function treeOf(value: unknown): SubagentTreeNode[] {
	return Array.isArray(value) ? value.filter((node): node is SubagentTreeNode => isRecord(node)) : [];
}

/** One child from a task's (or a single run's) details. */
function childOf(
	value: SubagentToolTaskDetails | SubagentToolDetails,
	index: number,
	status: SubagentStatus,
	input: { agent?: string; task?: string },
): Child {
	const usage = usageOf(value.usage);
	const output: SubagentToolOutputDetails | undefined = isRecord(value.output) ? value.output : undefined;
	const error = isRecord(value.error) ? text(value.error.message) : undefined;
	const subagentId = typeof value.subagentId === "string" ? value.subagentId : undefined;
	const toolCalls = finite(usage?.messages.toolCalls) ?? finite(value.toolCalls);
	const tokens = finite(usage?.tokens.total) ?? finite(value.tokens);
	const startedAt = finite(value.startedAt);
	const durationMs = finite(value.durationMs);
	const activity = text(value.currentActivity);
	const outputText = text(output?.text);
	const omitted = output?.truncated === true ? (finite(output.omittedBytes) ?? 0) : undefined;
	return {
		index,
		agent: agentName(value.agent, input.agent ?? "subagent"),
		status,
		...(input.task === undefined ? {} : { task: input.task }),
		...(subagentId === undefined ? {} : { subagentId }),
		...(startedAt === undefined ? {} : { startedAt }),
		...(durationMs === undefined ? {} : { durationMs }),
		...(toolCalls === undefined ? {} : { toolCalls }),
		...(tokens === undefined ? {} : { tokens }),
		...(activity === undefined ? {} : { activity }),
		...(error === undefined ? {} : { error }),
		...(outputText === undefined ? {} : { output: outputText }),
		...(omitted === undefined ? {} : { outputOmittedBytes: omitted }),
		children: treeOf(value.children),
	};
}

/** The children a call shows: from its result's details, else from its arguments. */
function childrenOf(input: ToolPresentInput, details: SubagentToolDetails | undefined): Child[] {
	const args = input.args;
	const failed = input.state === "done" && input.result?.isError === true;
	if (details && (details.mode === "single" || details.mode === "follow" || details.mode === "resume")) {
		const status = subagentStatus(details.status) ?? "running";
		const child = childOf(details, 0, status, taskInput(args, details.mode, 0));
		// A single run's result text is its output when the details carry none.
		const resultOutput =
			child.output === undefined && input.state === "done" && input.result?.partial !== true
				? text(resultText(input.result))
				: undefined;
		return [resultOutput === undefined ? child : { ...child, output: resultOutput }];
	}
	if (details && isSpawnMode(details.mode)) {
		const tasks = details.mode === "chain" ? details.steps : details.tasks;
		if (Array.isArray(tasks) && tasks.length > 0) {
			return tasks.flatMap((task, position) => {
				if (!isRecord(task)) return [];
				const index = typeof task.index === "number" && Number.isInteger(task.index) ? task.index : position;
				const status = subagentStatus(task.status) ?? "running";
				return [childOf(task, index, status, taskInput(args, details.mode, index))];
			});
		}
	}
	const mode = argsMode(args);
	const list = mode === "single" ? [args] : ((mode === "chain" ? args.chain : args.tasks) as unknown[]);
	const inputs = list
		.map((_value, index) => taskInput(args, mode, index))
		.filter((value) => value.agent !== undefined);
	const shown = failed && inputs.length === 0 ? [taskInput(args, "single", 0)] : inputs;
	const started = input.state !== "pending";
	const overall = details ? subagentStatus(details.status) : undefined;
	const error = text(resultText(input.result));
	return shown.map((value, index) => ({
		index,
		agent: value.agent ?? "subagent",
		status: failed ? (index === 0 ? "failed" : "pending") : (overall ?? (started ? "running" : "pending")),
		...(value.task === undefined ? {} : { task: value.task }),
		...(failed && index === 0 && error !== undefined ? { error } : {}),
		children: [],
	}));
}

/** The children shown: all when few, else the ones not done first, in their order. */
function visibleChildren(children: readonly Child[]): Child[] {
	if (children.length <= ROSTER_MAX_VISIBLE) return [...children];
	const prioritized = [...children].sort(
		(left, right) => Number(left.status === "completed") - Number(right.status === "completed"),
	);
	const selected = new Set(prioritized.slice(0, ROSTER_MAX_VISIBLE));
	return children.filter((child) => selected.has(child));
}

/** How many children run, wait, are done, failed, and stopped, as styled spans. */
function rosterCounts(children: readonly Child[]): Exclude<UiNodeStyledText, string>[number][] {
	const counts = { running: 0, pending: 0, done: 0, failed: 0, stopped: 0 };
	for (const child of children) {
		if (child.status === "completed") counts.done++;
		else if (child.status === "failed") counts.failed++;
		else if (child.status === "pending") counts.pending++;
		else if (child.status === "running" || child.status === "partial") counts.running++;
		else counts.stopped++;
	}
	return [
		...(counts.running ? [{ text: `${counts.running} running`, token: "warning" as const }] : []),
		...(counts.pending ? [{ text: `${counts.pending} pending`, token: "muted" as const }] : []),
		...(counts.done ? [{ text: `${counts.done} done`, token: "success" as const }] : []),
		...(counts.failed ? [{ text: `${counts.failed} failed`, token: "error" as const }] : []),
		...(counts.stopped ? [{ text: `${counts.stopped} stopped`, token: "warning" as const }] : []),
	];
}

function compactCount(value: number): string {
	if (value < 1_000) return String(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 100_000 ? 1 : 0).replace(/\.0$/, "")}k`;
	return `${(value / 1_000_000).toFixed(value < 100_000_000 ? 1 : 0).replace(/\.0$/, "")}m`;
}

/** The start and end of a timed step, in epoch milliseconds, as the steps schema takes them. */
function stepTiming(startedAt: number | undefined, durationMs: number | undefined) {
	if (startedAt === undefined || startedAt > Number.MAX_SAFE_INTEGER) return {};
	const start = Math.round(startedAt);
	const end = durationMs === undefined ? undefined : Math.round(startedAt + durationMs);
	return end === undefined || end > Number.MAX_SAFE_INTEGER
		? { startedAt: start }
		: { startedAt: start, endedAt: end };
}

/** A node's metrics: its state, tool calls, duration when its start is unknown, tokens, and what it does now. */
function metrics(
	status: SubagentStatus,
	values: { toolCalls?: number; durationMs?: number; startedAt?: number; tokens?: number; activity?: string },
): string {
	return [
		SUBAGENT_STATUS[status].label,
		...(values.toolCalls === undefined ? [] : [plural(values.toolCalls, "tool call")]),
		...(values.durationMs !== undefined && values.startedAt === undefined ? [formatDuration(values.durationMs)] : []),
		...(values.tokens === undefined ? [] : [`${compactCount(values.tokens)} tokens`]),
		...(values.activity !== undefined && (status === "running" || status === "partial")
			? [oneLine(literal(values.activity))]
			: []),
	].join(" · ");
}

/** A step's label: the agent, then its task on one line. */
function stepLabel(agent: string, task: string | undefined): UiNodeStyledText {
	const name = oneLine(literal(agent), 80) || "subagent";
	const preview = task === undefined ? "" : oneLine(literal(task), TASK_PREVIEW_CHARS);
	return preview ? [{ text: name, bold: true }, { text: ` · ${preview}` }] : [{ text: name, bold: true }];
}

/** Keys of the children's steps and cards: their subagent ids where unique, else their index. */
function childKeys(children: readonly Child[]): string[] {
	const seen = new Set<string>();
	return children.map((child) => {
		const id = child.subagentId !== undefined && WORK_ID.test(child.subagentId) ? child.subagentId : undefined;
		const key = id !== undefined && !seen.has(id) ? id : `#${child.index}`;
		const unique = seen.has(key) ? `#${child.index}:${seen.size}` : key;
		seen.add(unique);
		return unique;
	});
}

/** Nested delegation as tree items, within a budget shared by every child of the call. */
function treeItems(nodes: readonly SubagentTreeNode[], path: string, depth: number, budget: { remaining: number }) {
	const items: UiTreeItem[] = [];
	if (depth >= TREE_MAX_DEPTH) return items;
	for (const [position, node] of nodes.entries()) {
		if (budget.remaining <= 0) {
			items.push({ id: `${path}.more`, label: [{ text: "…", token: "muted" }] });
			break;
		}
		budget.remaining--;
		const status = subagentStatus(node.status) ?? "running";
		const id = `${path}.${position}`;
		const children = treeItems(treeOf(node.children), id, depth + 1, budget);
		items.push({
			id,
			label: stepLabel(agentName(node.agent, "subagent"), text(node.task)),
			description: [
				{
					text: metrics(status, {
						...(finite(node.toolCalls) === undefined ? {} : { toolCalls: finite(node.toolCalls) }),
						...(finite(node.durationMs) === undefined ? {} : { durationMs: finite(node.durationMs) }),
						...(finite(node.tokens) === undefined ? {} : { tokens: finite(node.tokens) }),
						...(text(node.currentActivity) === undefined ? {} : { activity: text(node.currentActivity) }),
					}),
					token: SUBAGENT_STATUS[status].token,
				},
			],
			...(children.length === 0 ? {} : { children }),
		});
	}
	return items;
}

/** One child's card: its task, metrics, error, output, nested delegation, and the action that opens it. */
function childCard(child: Child, key: string, outputChars: number, tree: { remaining: number }): UiCardNode {
	const style = SUBAGENT_STATUS[child.status];
	const metricItems = [
		...(child.toolCalls === undefined ? [] : [{ key: "tools", label: "Tool calls", value: String(child.toolCalls) }]),
		...(child.tokens === undefined ? [] : [{ key: "tokens", label: "Tokens", value: compactCount(child.tokens) }]),
		...(child.durationMs === undefined
			? []
			: [{ key: "duration", label: "Duration", value: formatDuration(child.durationMs) }]),
		...(child.activity === undefined || (child.status !== "running" && child.status !== "partial")
			? []
			: [{ key: "activity", label: "Now", value: oneLine(literal(child.activity)) }]),
	];
	const output =
		child.output === undefined || child.output.trim() === child.error?.trim() || outputChars <= 0
			? undefined
			: bounded(literal(child.output).trim(), outputChars);
	const nested = treeItems(child.children, "n", 0, tree);
	const sections: NonNullable<UiCardNode["sections"]> = [
		...(child.task === undefined
			? []
			: [{ key: "task", children: [textNode("task", bounded(literal(child.task).trim(), TASK_MAX_CHARS))] }]),
		...(metricItems.length === 0
			? []
			: [{ key: "metrics", children: [{ type: "keyValue" as const, items: metricItems }] }]),
		...(child.error === undefined
			? []
			: [{ key: "error", children: [textNode("error", bounded(literal(child.error), ERROR_MAX_CHARS), "error")] }]),
		...(child.outputOmittedBytes === undefined
			? []
			: [
					{
						key: "truncated",
						children: [
							textNode("truncated", `[Truncated: ${child.outputOmittedBytes} bytes omitted]`, "warning"),
						],
					},
				]),
		...(output === undefined
			? []
			: [{ key: "output", title: "Output", children: [{ type: "markdown" as const, markdown: output }] }]),
		...(nested.length === 0
			? []
			: [{ key: "delegation", title: "Delegation", children: [{ type: "tree" as const, items: nested }] }]),
	];
	const open =
		child.subagentId !== undefined && WORK_ID.test(child.subagentId)
			? [
					{
						id: `open:${child.subagentId}`,
						label: "Open",
						intent: { type: "open_work", input: { workId: child.subagentId } },
					},
				]
			: [];
	return {
		type: "card",
		key,
		title: [{ text: oneLine(literal(child.agent), 80) || "subagent", bold: true }],
		badges: [{ label: style.label, token: style.token }],
		...(sections.length === 0 ? {} : { sections }),
		...(open.length === 0 ? {} : { actions: open }),
	};
}

/** A registry answer's counts: how many runs completed, failed, were cancelled, and run. */
function registryCounts(details: SubagentToolDetails): string {
	const summary = isRecord(details.summary) ? details.summary : undefined;
	const total = finite(summary?.total);
	const completed = finite(summary?.completed);
	if (summary === undefined || total === undefined || completed === undefined) return String(details.status);
	const failed = finite(summary.failed) ?? 0;
	const cancelled = finite(summary.cancelled) ?? 0;
	const running = finite(summary.running) ?? 0;
	return [
		`${completed}/${total} completed`,
		...(failed > 0 ? [`${failed} failed`] : []),
		...(cancelled > 0 ? [`${cancelled} cancelled`] : []),
		...(running > 0 ? [`${running} running`] : []),
	].join(", ");
}

/** A registry call: what the registry answered, or that it is asked. */
function presentRegistry(input: ToolPresentInput, details: SubagentToolDetails | undefined): ToolPresentation {
	const title: UiNodeStyledText = [
		{ text: "Subagent registry", bold: true, token: "accent" },
		{ text: `  ${details ? registryCounts(details) : "querying…"}`, token: "muted" },
	];
	const answer = input.state === "done" ? literal(resultText(input.result)).trim() : "";
	if (!answer) return { title };
	const failed = input.result?.isError === true;
	const node: UiNode = failed
		? textNode("answer", bounded(answer, REGISTRY_TEXT_MAX_CHARS), "error")
		: { type: "markdown", key: "answer", markdown: bounded(answer, REGISTRY_TEXT_MAX_CHARS) };
	return { title, ...(failed ? { summary: [node] } : {}), body: [node] };
}

/** subagent and subagent_registry; `hideBeforeCreation` for the spawning tool. */
function presentSubagentCall(input: ToolPresentInput, hideBeforeCreation: boolean): ToolPresentation {
	const details = subagentDetails(input.result?.details);
	if (hideBeforeCreation && hiddenBeforeCreation(input)) {
		return { title: [{ text: "Subagent", bold: true, token: "accent" as const }], hidden: true };
	}
	const registry = details ? details.mode === "list" : isRegistryCall(input.args);
	if (registry) return presentRegistry(input, details);
	const children = childrenOf(input, details);
	const mode = details?.mode ?? argsMode(input.args);
	const counts = rosterCounts(children);
	const title: UiNodeStyledText = [
		{ text: children.length === 1 ? "Subagent" : "Subagents", bold: true, token: "accent" },
		...(children.length > 1 ? [{ text: ` · ${mode}`, token: "muted" as const }] : []),
		...(counts.length === 0 ? [] : [{ text: "  " }, ...(joined(counts) as Exclude<UiNodeStyledText, string>)]),
	];
	if (children.length === 0) {
		return { title, activity: input.state === "pending" ? "Preparing subagent" : "Starting subagent" };
	}
	const visible = visibleChildren(children);
	const keys = childKeys(visible);
	const hidden = children.length - visible.length;
	const more = hidden > 0 ? [textNode("more", `…and ${plural(hidden, "more agent")}`, "muted")] : [];
	const steps: UiNode = {
		type: "progress",
		key: "children",
		kind: "steps",
		steps: visible.map((child, index) => ({
			key: keys[index],
			label: stepLabel(child.agent, child.task),
			status: SUBAGENT_STATUS[child.status].step,
			detail: [
				{
					text: [
						metrics(child.status, child),
						...(child.error === undefined ? [] : [oneLine(literal(child.error), 200)]),
					].join(" · "),
					token: child.error === undefined ? "muted" : "error",
				},
			],
			...stepTiming(child.startedAt, child.durationMs),
		})),
	};
	const outputs = visible.filter((child) => child.output !== undefined).length;
	const outputChars = Math.min(OUTPUT_CARD_MAX_CHARS, Math.floor(OUTPUT_TOTAL_MAX_CHARS / Math.max(1, outputs)));
	const tree = { remaining: TREE_MAX_NODES };
	const cards = visible.map((child, index) => childCard(child, keys[index] ?? `#${index}`, outputChars, tree));
	return { title, summary: [steps, ...more], body: [...cards, ...more] };
}

/**
 * subagent: a step per child with its state, metrics, and timing; expanded,
 * a card per child with its task, error, output, nested delegation, and an
 * action opening its conversation. Hidden until a child exists. Registry
 * calls show the registry's answer.
 */
export const presentSubagent: ToolPresenter = (input) => presentSubagentCall(input, true);

/** subagent_registry: the registry's answer to list, and follow and resume like a single child. */
export const presentSubagentRegistry: ToolPresenter = (input) => presentSubagentCall(input, false);
