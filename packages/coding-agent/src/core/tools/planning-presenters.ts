/**
 * Presenters of the native planning tools (RFC §8.3, Q9): update_plan,
 * submit_plan, update_plan_progress, and request_replan. A call's title names
 * what it changed, and its collapsed summary shows only what is worth reading:
 * the items a progress update moved and its evidence, the items a draft update
 * added, a submitted plan's status and synopsis, and a replan's reason. The
 * plan status above the editor shows the plan's phase and progress, so a card
 * repeats them only where the call changes them. Expanded, a card adds the
 * plan's numbered checklist; a progress update's checklist opens only the
 * outcomes it touched. The checklist is bounded, so a large plan still
 * presents within the remote bound; the plan inspector shows it whole.
 */

import { Buffer } from "node:buffer";
import type { ToolPresentation, UiNode, UiNodeStyledText, UiNodeToken } from "@hansjm10/volt-protocol";
import {
	getPlanLeafSteps,
	type PlanItem,
	type PlanningState,
	type PlanPhase,
	type PlanState,
	type PlanStep,
	type PlanStepStatus,
	parsePlanningState,
} from "../planning.ts";
import { resultText, type ToolPresenter, type ToolPresentInput } from "../ui/presentation.ts";
import { type Args, isFailed, isRecord, oneLine, type StyledSpans, stringArg, textNode } from "./present-utils.ts";

export type PlanningToolName = "update_plan" | "submit_plan" | "update_plan_progress" | "request_replan";

const TOOL_LABELS: Readonly<Record<PlanningToolName, string>> = {
	update_plan: "update plan",
	submit_plan: "submit plan",
	update_plan_progress: "plan progress",
	request_replan: "request replan",
};

/** Longest step or substep text a checklist shows. */
const STEP_TEXT_MAX_CHARS = 300;
/** Longest outcome text a substep's label shows before the substep's own text. */
const PARENT_TEXT_MAX_CHARS = 40;
/** Longest execution note a checklist shows. */
const NOTE_MAX_CHARS = 200;
/** Longest execution note a single progress update shows on lines of its own. */
const NOTE_LINE_MAX_CHARS = 1_000;
/** Longest plan title and summary a submitted plan shows. */
const PLAN_TITLE_MAX_CHARS = 300;
const PLAN_SUMMARY_MAX_CHARS = 2_000;
/** Longest synopsis of a submitted plan's summary a collapsed card shows. */
const SYNOPSIS_MAX_CHARS = 300;
/** Longest replan reason shown. */
const REASON_MAX_CHARS = 2_000;
/** Longest error a failed call shows. */
const ERROR_MAX_CHARS = 2_000;
/** Most serialized bytes of a card's summary and checklist together; the rest of the checklist is counted. */
const CHECKLIST_MAX_BYTES = 10 * 1024;
/** Most items, and serialized bytes of them, a collapsed list shows; the rest are counted. */
const LIST_MAX_ITEMS = 8;
const LIST_MAX_BYTES = 2 * 1024;

/** How a progress update names the status it moves an item to. */
const STATUS_VERBS: Readonly<Record<PlanStepStatus, string>> = {
	completed: "done",
	in_progress: "started",
	pending: "reopened",
};
const STATUS_TOKENS: Readonly<Record<PlanStepStatus, UiNodeToken>> = {
	completed: "success",
	in_progress: "accent",
	pending: "warning",
};
/** The order a progress update lists the items it moved in: finished work first. */
const STATUS_ORDER: readonly PlanStepStatus[] = ["completed", "in_progress", "pending"];

const SEPARATOR: StyledSpans[number] = { text: " · ", token: "muted" };

type Step = Extract<UiNode, { type: "progress"; kind: "steps" }>["steps"][number];

/** What a completed call shows; its title defaults to the one its arguments give. */
interface DonePresentation {
	readonly title?: UiNodeStyledText;
	readonly summary: UiNode[];
	readonly body: UiNode[];
}

function clip(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function count(value: number, singular: string, plural = `${singular}s`): string {
	return `${value} ${value === 1 ? singular : plural}`;
}

function bytesOf(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** What update_plan changes: its outcomes, and its tasks when outcomes have substeps. */
function updatePlanDetail(args: Args): string | undefined {
	if (!Array.isArray(args.steps)) return undefined;
	const steps = args.steps;
	const tasks = steps.reduce<number>(
		(total, step) => total + (isRecord(step) && Array.isArray(step.substeps) ? step.substeps.length : 1),
		0,
	);
	const grouped = steps.some((step) => isRecord(step) && Array.isArray(step.substeps));
	return grouped ? `${count(steps.length, "outcome")} · ${count(tasks, "task")}` : count(steps.length, "step");
}

/** What update_plan_progress changes: how many items it moves to each status. */
function progressDetail(args: Args): string | undefined {
	if (!Array.isArray(args.updates)) return undefined;
	const counts: Record<PlanStepStatus, number> = { completed: 0, in_progress: 0, pending: 0 };
	for (const update of args.updates) {
		const status = isRecord(update) ? update.status : undefined;
		if (status === "completed" || status === "in_progress" || status === "pending") counts[status] += 1;
	}
	const labels = STATUS_ORDER.filter((status) => counts[status] > 0).map(
		(status) => `${counts[status]} ${STATUS_VERBS[status]}`,
	);
	return labels.join(" · ") || count(args.updates.length, "update");
}

function callDetail(name: PlanningToolName, args: Args): string | undefined {
	switch (name) {
		case "update_plan":
			return updatePlanDetail(args);
		case "update_plan_progress":
			return progressDetail(args);
		case "submit_plan":
			return stringArg(args, "title")?.trim() || undefined;
		case "request_replan":
			return stringArg(args, "reason")?.trim() || undefined;
	}
}

function titleFor(name: PlanningToolName, detail: string | undefined): UiNodeStyledText {
	return [
		{ text: TOOL_LABELS[name], bold: true },
		...(detail === undefined ? [] : [{ text: ` · ${oneLine(detail)}`, token: "muted" as const }]),
	];
}

/** The planning state a call committed, when its details hold a valid one. */
function planningOf(details: unknown): PlanningState | undefined {
	try {
		return parsePlanningState(details);
	} catch {
		return undefined;
	}
}

function phaseLabel(phase: PlanPhase): string {
	switch (phase) {
		case "ready":
			return "READY";
		case "active":
			return "EXECUTING";
		case "completed":
			return "COMPLETE";
		case "handed_off":
			return "HANDED OFF";
		default:
			return "DRAFT";
	}
}

function phaseToken(phase: PlanPhase): UiNodeToken {
	return phase === "ready" ? "warning" : phase === "completed" ? "success" : phase === "draft" ? "muted" : "accent";
}

function progressOf(plan: PlanState): { completed: number; total: number } {
	const leaves = getPlanLeafSteps(plan);
	return { completed: leaves.filter((leaf) => leaf.status === "completed").length, total: leaves.length };
}

/** A plan's size: its outcomes and tasks when outcomes have substeps, else its steps. */
function planSize(plan: PlanState): string {
	const tasks = getPlanLeafSteps(plan).length;
	return plan.steps.some((step) => step.substeps !== undefined)
		? `${count(plan.steps.length, "outcome")} · ${count(tasks, "task")}`
		: count(tasks, "step");
}

function stepStatus(status: PlanStepStatus): Step["status"] {
	return status === "completed" ? "done" : status === "in_progress" ? "active" : "pending";
}

/** A node key of a plan item: its id, prefixed so a key never collides with a positional one. */
function itemKey(id: string, position: number | string): string {
	return id.length <= 200 ? `id:${id}` : `n:${position}`;
}

/** Item text after its checklist number, the number the model's plan checkpoint gives it. */
function numbered(number: string, text: string): string {
	return `${number} ${oneLine(text, STEP_TEXT_MAX_CHARS)}`;
}

function stepOf(key: string, label: string, item: PlanItem): Step {
	return {
		key,
		label,
		status: stepStatus(item.status),
		...(item.note ? { detail: oneLine(item.note, NOTE_MAX_CHARS) } : {}),
	};
}

/** An outcome as one step: a grouped outcome with how many of its tasks are done. */
function outcomeStep(step: PlanStep, index: number): Step {
	const key = itemKey(step.id, index);
	const label = numbered(`${index + 1}`, step.text);
	if (step.substeps === undefined) return stepOf(key, label, step);
	const done = step.substeps.filter((substep) => substep.status === "completed").length;
	return { key, label, status: stepStatus(step.status), detail: `${done}/${count(step.substeps.length, "task")}` };
}

/** A leaf of the plan: an outcome without substeps, or a substep of the outcome holding it. */
interface NumberedLeaf {
	readonly item: PlanItem;
	readonly outcome: PlanStep;
	/** "3", or "3.2" for the second substep of the third outcome. */
	readonly number: string;
	readonly outcomeNumber: string;
	readonly key: string;
	readonly outcomeKey: string;
}

function numberedLeaves(plan: PlanState): Map<string, NumberedLeaf> {
	const leaves = new Map<string, NumberedLeaf>();
	for (const [index, outcome] of plan.steps.entries()) {
		const outcomeNumber = `${index + 1}`;
		const outcomeKey = itemKey(outcome.id, index);
		if (outcome.substeps === undefined) {
			leaves.set(outcome.id, {
				item: outcome,
				outcome,
				number: outcomeNumber,
				outcomeNumber,
				key: outcomeKey,
				outcomeKey,
			});
			continue;
		}
		for (const [subindex, item] of outcome.substeps.entries()) {
			const number = `${outcomeNumber}.${subindex + 1}`;
			leaves.set(item.id, { item, outcome, number, outcomeNumber, key: itemKey(item.id, number), outcomeKey });
		}
	}
	return leaves;
}

/** A leaf as a step of a flat list: a substep after its outcome's text. */
function leafStep(leaf: Pick<NumberedLeaf, "item" | "outcome" | "number" | "key">): Step {
	const text =
		leaf.item === leaf.outcome
			? leaf.item.text
			: `${oneLine(leaf.outcome.text, PARENT_TEXT_MAX_CHARS)} › ${leaf.item.text}`;
	return stepOf(leaf.key, numbered(leaf.number, text), leaf.item);
}

/** Steps as one list of at most LIST_MAX_ITEMS within LIST_MAX_BYTES, then how many more there are. */
function listNodes(key: string, steps: readonly Step[], noun: string): UiNode[] {
	const shown: Step[] = [];
	let budget = LIST_MAX_BYTES;
	for (const step of steps) {
		const bytes = bytesOf(step);
		if (shown.length === LIST_MAX_ITEMS || bytes > budget) break;
		budget -= bytes;
		shown.push(step);
	}
	const nodes: UiNode[] = shown.length === 0 ? [] : [{ type: "progress", kind: "steps", key, steps: shown }];
	const omitted = steps.length - shown.length;
	if (omitted > 0) nodes.push(textNode(`${key}-more`, `… ${count(omitted, `more ${noun}`)}`, "muted"));
	return nodes;
}

/**
 * The plan's checklist: its progress, or its size before any progress, then
 * its numbered outcomes as progress steps, consecutive outcomes without
 * substeps together and each outcome with substeps that `open` admits as a
 * group titled with its text. An outcome it does not open is one step with
 * its task count. Leaves past `budget` serialized bytes are counted instead.
 */
function checklistNodes(plan: PlanState, budget: number, open: (outcome: PlanStep) => boolean = () => true): UiNode[] {
	const leaves = getPlanLeafSteps(plan);
	const { completed, total } = progressOf(plan);
	const started = leaves.some((leaf) => leaf.status !== "pending");
	const nodes: UiNode[] = [
		textNode("checklist", [
			{ text: "Checklist", bold: true },
			{ text: ` · ${started ? `${completed}/${total} complete` : planSize(plan)}`, token: "muted" },
		]),
	];
	if (plan.steps.length === 0) {
		nodes.push(textNode("empty", "No steps yet", "muted"));
		return nodes;
	}
	let shown = 0;
	let run: { key: string; steps: Step[] } | undefined;
	const flush = (): void => {
		if (run && run.steps.length > 0) nodes.push({ type: "progress", kind: "steps", key: run.key, steps: run.steps });
		run = undefined;
	};
	/** Spend the budget on `step`, which stands for `leafCount` leaves; false when it is spent. */
	const fits = (step: Step, leafCount: number): boolean => {
		const bytes = bytesOf(step);
		if (bytes > budget) return false;
		budget -= bytes;
		shown += leafCount;
		return true;
	};
	for (const [index, outcome] of plan.steps.entries()) {
		if (outcome.substeps === undefined || !open(outcome)) {
			const presented = outcomeStep(outcome, index);
			if (!fits(presented, outcome.substeps?.length ?? 1)) break;
			run ??= { key: `steps:${itemKey(outcome.id, index)}`, steps: [] };
			run.steps.push(presented);
			continue;
		}
		flush();
		const number = `${index + 1}`;
		const title = numbered(number, outcome.text);
		budget -= Buffer.byteLength(title, "utf8");
		const steps: Step[] = [];
		for (const [subindex, substep] of outcome.substeps.entries()) {
			const presented = stepOf(
				itemKey(substep.id, subindex),
				numbered(`${number}.${subindex + 1}`, substep.text),
				substep,
			);
			if (!fits(presented, 1)) break;
			steps.push(presented);
		}
		if (steps.length > 0) {
			nodes.push({ type: "progress", kind: "steps", key: `outcome:${itemKey(outcome.id, index)}`, title, steps });
		}
		if (steps.length < outcome.substeps.length) break;
	}
	flush();
	const omitted = total - shown;
	if (omitted > 0) nodes.push(textNode("more", `… ${count(omitted, "more item")}`, "muted"));
	return nodes;
}

/** A plan's title and summary, as Markdown. */
function planTextNode(plan: PlanState): UiNode[] {
	const parts = [
		...(plan.title ? [`### ${oneLine(plan.title, PLAN_TITLE_MAX_CHARS)}`] : []),
		...(plan.summary ? [clip(plan.summary, PLAN_SUMMARY_MAX_CHARS)] : []),
	];
	return parts.length === 0 ? [] : [{ type: "markdown", key: "plan", markdown: parts.join("\n\n") }];
}

/** The id an item of a call's arguments names, as the tool trims it. */
function argId(value: unknown): string | undefined {
	return isRecord(value) && typeof value.id === "string" ? value.id.trim() || undefined : undefined;
}

/**
 * The items a draft update added: those whose argument names no id or one the
 * committed plan did not keep. The plan keeps the arguments' order, so they
 * pair by position; without that pairing nothing is counted as added.
 */
function addedSteps(args: Args, plan: PlanState): Step[] {
	if (!Array.isArray(args.steps) || args.steps.length !== plan.steps.length) return [];
	const inputs: unknown[] = args.steps;
	const added: Step[] = [];
	for (const [index, outcome] of plan.steps.entries()) {
		const input = inputs[index];
		if (argId(input) !== outcome.id) {
			added.push(outcomeStep(outcome, index));
			continue;
		}
		const substeps = isRecord(input) ? input.substeps : undefined;
		if (outcome.substeps === undefined || !Array.isArray(substeps) || substeps.length !== outcome.substeps.length) {
			continue;
		}
		const subInputs: unknown[] = substeps;
		for (const [subindex, item] of outcome.substeps.entries()) {
			if (argId(subInputs[subindex]) === item.id) continue;
			const number = `${index + 1}.${subindex + 1}`;
			added.push(leafStep({ item, outcome, number, key: itemKey(item.id, number) }));
		}
	}
	return added;
}

/** update_plan: the draft's size and what it added; a new draft, its title and outcomes. */
function presentDraft(args: Args, plan: PlanState): DonePresentation {
	const created = plan.revision === 1;
	const added = created ? [] : addedSteps(args, plan);
	const title = titleFor(
		"update_plan",
		[created ? "new draft" : undefined, planSize(plan), added.length > 0 ? `${added.length} new` : undefined]
			.filter((part): part is string => part !== undefined)
			.join(" · "),
	);
	const head = created && plan.title ? [textNode("plan-title", [{ text: oneLine(plan.title), bold: true }])] : [];
	const summary = created
		? [
				...head,
				...listNodes(
					"outcomes",
					plan.steps.map((outcome, index) => outcomeStep(outcome, index)),
					"outcome",
				),
			]
		: listNodes("added", added, "new item");
	const bodyHead = created ? head : summary;
	return { title, summary, body: [...bodyHead, ...checklistNodes(plan, CHECKLIST_MAX_BYTES - bytesOf(bodyHead))] };
}

/** submit_plan: the plan's status and size, and a synopsis of its summary. */
function presentSubmitted(plan: PlanState): DonePresentation {
	const status = textNode("status", [
		{ text: phaseLabel(plan.phase), bold: true, token: phaseToken(plan.phase) },
		{ text: ` · submitted for approval · ${planSize(plan)}`, token: "muted" },
	]);
	const synopsis = oneLine(plan.summary?.split(/\n\s*\n/, 1)[0] ?? "", SYNOPSIS_MAX_CHARS);
	const summary = [status, ...(synopsis ? [textNode("synopsis", synopsis)] : [])];
	const head = [status, ...planTextNode(plan)];
	return { summary, body: [...head, ...checklistNodes(plan, CHECKLIST_MAX_BYTES - bytesOf(head))] };
}

/** The leaves a progress update moved, finished work first, as the committed plan holds them. */
function progressChanges(args: Args, plan: PlanState): NumberedLeaf[] {
	if (!Array.isArray(args.updates)) return [];
	const updates: unknown[] = args.updates;
	const leaves = numberedLeaves(plan);
	const changes: NumberedLeaf[] = [];
	for (const update of updates) {
		const id = argId(update);
		const leaf = id === undefined ? undefined : leaves.get(id);
		if (leaf && !changes.includes(leaf)) changes.push(leaf);
	}
	return changes.sort(
		(left, right) => STATUS_ORDER.indexOf(left.item.status) - STATUS_ORDER.indexOf(right.item.status),
	);
}

/**
 * update_plan_progress: what moved, and the plan's progress after it. One
 * moved item is named in the title, with its note below; several are listed.
 * An outcome its last substep completed is called out, and so is the plan's
 * completion.
 */
function presentProgress(args: Args, plan: PlanState): DonePresentation {
	const changes = progressChanges(args, plan);
	const { completed, total } = progressOf(plan);
	const title: StyledSpans = [{ text: TOOL_LABELS.update_plan_progress, bold: true }, SEPARATOR];
	const [only] = changes;
	if (only && changes.length === 1) {
		title.push(
			{ text: STATUS_VERBS[only.item.status], token: STATUS_TOKENS[only.item.status] },
			{ text: ` ${only.number}`, token: "muted" },
			{ text: ` ${oneLine(only.item.text)}` },
		);
	} else if (changes.length > 1) {
		for (const status of STATUS_ORDER) {
			const moved = changes.filter((leaf) => leaf.item.status === status).length;
			if (moved === 0) continue;
			if (title.length > 2) title.push(SEPARATOR);
			title.push({ text: `${moved} ${STATUS_VERBS[status]}`, token: STATUS_TOKENS[status] });
		}
	} else {
		title.push({ text: progressDetail(args) ?? "updated", token: "muted" });
	}
	title.push(
		SEPARATOR,
		plan.phase === "completed"
			? { text: `COMPLETE ${completed}/${total}`, bold: true, token: "success" }
			: { text: `${completed}/${total}`, token: "muted" },
	);

	const summary: UiNode[] =
		only && changes.length === 1
			? only.item.note
				? [textNode("note", clip(only.item.note, NOTE_LINE_MAX_CHARS), "muted")]
				: []
			: listNodes("changes", changes.map(leafStep), "update");
	const finished = changes.filter(
		(leaf, index) =>
			leaf.item !== leaf.outcome &&
			leaf.item.status === "completed" &&
			leaf.outcome.status === "completed" &&
			changes.findIndex((other) => other.outcome === leaf.outcome) === index,
	);
	for (const leaf of finished.slice(0, LIST_MAX_ITEMS)) {
		summary.push(
			textNode(`milestone:${leaf.outcomeKey}`, [
				{ text: `Outcome ${leaf.outcomeNumber} complete`, bold: true, token: "success" },
				{ text: ` · ${oneLine(leaf.outcome.text)}`, token: "muted" },
			]),
		);
	}
	if (finished.length > LIST_MAX_ITEMS) {
		summary.push(
			textNode("milestone-more", `… ${count(finished.length - LIST_MAX_ITEMS, "more outcome")} complete`, "muted"),
		);
	}
	const touched = new Set(changes.map((leaf) => leaf.outcome.id));
	return {
		title,
		summary,
		body: [
			...summary,
			...checklistNodes(plan, CHECKLIST_MAX_BYTES - bytesOf(summary), (outcome) => touched.has(outcome.id)),
		],
	};
}

/** request_replan: the return to a draft and how far execution got, and the reason. */
function presentReplan(args: Args, plan: PlanState): DonePresentation {
	const { completed, total } = progressOf(plan);
	const reason = stringArg(args, "reason")?.trim();
	const summary = reason ? [textNode("reason", clip(reason, REASON_MAX_CHARS))] : [];
	const head = [...summary, ...planTextNode(plan)];
	return {
		title: [
			{ text: TOOL_LABELS.request_replan, bold: true },
			SEPARATOR,
			{ text: "back to draft", token: "warning" },
			{ text: ` · ${completed}/${total} done`, token: "muted" },
		],
		summary,
		body: [...head, ...checklistNodes(plan, CHECKLIST_MAX_BYTES - bytesOf(head))],
	};
}

function presentDone(name: PlanningToolName, args: Args, plan: PlanState): DonePresentation {
	switch (name) {
		case "update_plan":
			return presentDraft(args, plan);
		case "submit_plan":
			return presentSubmitted(plan);
		case "update_plan_progress":
			return presentProgress(args, plan);
		case "request_replan":
			return presentReplan(args, plan);
	}
}

/** The presenter of planning tool `name`. */
export function presentPlanning(name: PlanningToolName): ToolPresenter {
	return (input: ToolPresentInput): ToolPresentation => {
		const pendingTitle = titleFor(name, callDetail(name, input.args));
		if (input.state !== "done") return { title: pendingTitle };
		if (isFailed(input)) {
			const error = clip(resultText(input.result), ERROR_MAX_CHARS) || "Planning tool failed";
			return { title: pendingTitle, summary: [textNode("error", error, "error")] };
		}
		const plan = planningOf(input.result?.details)?.plan;
		if (!plan) return { title: pendingTitle, summary: [textNode("status", "No active plan", "muted")] };
		const { title = pendingTitle, summary, body } = presentDone(name, input.args, plan);
		return {
			title,
			...(summary.length === 0 ? {} : { summary }),
			...(body.length === 0 ? {} : { body }),
		};
	};
}
