/**
 * Presenters of the native planning tools (RFC §8.3, Q9): update_plan,
 * submit_plan, update_plan_progress, and request_replan. A call's title names
 * what it changes, from its arguments; its result is the planning state the
 * tool committed, shown as the plan's phase and progress (collapsed) and its
 * checklist as progress steps (expanded), each outcome with substeps as a
 * titled group of its own. A submitted plan, and one sent back for replanning,
 * also shows its title and summary. The checklist is bounded, so a large plan
 * still presents within the remote bound; the plan inspector shows it whole.
 */

import { Buffer } from "node:buffer";
import type { ToolPresentation, UiNode, UiNodeStyledText, UiNodeToken } from "@hansjm10/volt-protocol";
import {
	getPlanLeafSteps,
	type PlanItem,
	type PlanningState,
	type PlanPhase,
	type PlanState,
	type PlanStepStatus,
	parsePlanningState,
} from "../planning.ts";
import { resultText, type ToolPresenter, type ToolPresentInput } from "../ui/presentation.ts";
import { type Args, isFailed, isRecord, oneLine, stringArg, textNode } from "./present-utils.ts";

export type PlanningToolName = "update_plan" | "submit_plan" | "update_plan_progress" | "request_replan";

const TOOL_LABELS: Readonly<Record<PlanningToolName, string>> = {
	update_plan: "update plan",
	submit_plan: "submit plan",
	update_plan_progress: "update plan progress",
	request_replan: "request replan",
};

/** Longest step or substep text a checklist shows. */
const STEP_TEXT_MAX_CHARS = 300;
/** Longest execution note a checklist shows. */
const NOTE_MAX_CHARS = 200;
/** Longest plan title and summary a submitted plan shows. */
const PLAN_TITLE_MAX_CHARS = 300;
const PLAN_SUMMARY_MAX_CHARS = 2_000;
/** Longest error a failed call shows. */
const ERROR_MAX_CHARS = 2_000;
/** Most serialized bytes of checklist steps a presentation carries; the rest is counted. */
const CHECKLIST_MAX_BYTES = 10 * 1024;

type Step = Extract<UiNode, { type: "progress"; kind: "steps" }>["steps"][number];

function clip(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function count(value: number, singular: string, plural = `${singular}s`): string {
	return `${value} ${value === 1 ? singular : plural}`;
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
	const counts = { completed: 0, in_progress: 0, pending: 0 };
	for (const update of args.updates) {
		const status = isRecord(update) ? update.status : undefined;
		if (status === "completed" || status === "in_progress" || status === "pending") counts[status] += 1;
	}
	const labels = [
		counts.completed > 0 ? `${counts.completed} completed` : undefined,
		counts.in_progress > 0 ? `${counts.in_progress} in progress` : undefined,
		counts.pending > 0 ? `${counts.pending} pending` : undefined,
	].filter((label): label is string => label !== undefined);
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

/** The plan's phase and revision, and with `progress` how much of it is complete. */
function statusNode(plan: PlanState, progress: boolean): UiNode {
	const { completed, total } = progressOf(plan);
	return textNode("status", [
		{ text: phaseLabel(plan.phase), bold: true, token: phaseToken(plan.phase) },
		{
			text: ` · revision ${plan.revision}${progress ? ` · ${completed}/${total} complete` : ""}`,
			token: "muted",
		},
	]);
}

function stepStatus(status: PlanStepStatus): Step["status"] {
	return status === "completed" ? "done" : status === "in_progress" ? "active" : "pending";
}

/** A node key of a plan item: its id, prefixed so a key never collides with a positional one. */
function itemKey(id: string, index: number): string {
	return id.length <= 200 ? `id:${id}` : `n:${index}`;
}

function stepOf(item: PlanItem, index: number): Step {
	return {
		key: itemKey(item.id, index),
		label: oneLine(item.text, STEP_TEXT_MAX_CHARS),
		status: stepStatus(item.status),
		...(item.note ? { detail: oneLine(item.note, NOTE_MAX_CHARS) } : {}),
	};
}

/**
 * The plan's checklist: its progress, then its outcomes as progress steps,
 * consecutive outcomes without substeps together and each outcome with
 * substeps as a group titled with its text. Steps past the byte budget are
 * counted instead.
 */
function checklistNodes(plan: PlanState): UiNode[] {
	const { completed, total } = progressOf(plan);
	const nodes: UiNode[] = [
		textNode("checklist", [
			{ text: "Checklist", bold: true },
			{ text: ` · ${completed}/${total} complete`, token: "muted" },
		]),
	];
	if (plan.steps.length === 0) {
		nodes.push(textNode("empty", "No steps yet", "muted"));
		return nodes;
	}
	let budget = CHECKLIST_MAX_BYTES;
	let shown = 0;
	let run: { key: string; steps: Step[] } | undefined;
	const flush = (): void => {
		if (run && run.steps.length > 0) nodes.push({ type: "progress", kind: "steps", key: run.key, steps: run.steps });
		run = undefined;
	};
	/** Spend the budget on `step`; false when it is spent. */
	const fits = (step: Step): boolean => {
		const bytes = Buffer.byteLength(JSON.stringify(step), "utf8");
		if (bytes > budget) return false;
		budget -= bytes;
		shown += 1;
		return true;
	};
	outer: for (const [index, step] of plan.steps.entries()) {
		if (step.substeps === undefined) {
			const presented = stepOf(step, index);
			if (!fits(presented)) break;
			run ??= { key: `steps:${itemKey(step.id, index)}`, steps: [] };
			run.steps.push(presented);
			continue;
		}
		flush();
		const title = oneLine(step.text, STEP_TEXT_MAX_CHARS);
		budget -= Buffer.byteLength(title, "utf8");
		const steps: Step[] = [];
		for (const [subindex, substep] of step.substeps.entries()) {
			const presented = stepOf(substep, subindex);
			if (!fits(presented)) {
				if (steps.length > 0) {
					nodes.push({ type: "progress", kind: "steps", key: `outcome:${itemKey(step.id, index)}`, title, steps });
				}
				break outer;
			}
			steps.push(presented);
		}
		nodes.push({ type: "progress", kind: "steps", key: `outcome:${itemKey(step.id, index)}`, title, steps });
	}
	flush();
	const omitted = total - shown;
	if (omitted > 0) nodes.push(textNode("more", `… ${count(omitted, "more item")}`, "muted"));
	return nodes;
}

/** A submitted plan's title and summary, as Markdown. */
function planTextNode(plan: PlanState): UiNode[] {
	const parts = [
		...(plan.title ? [`### ${oneLine(plan.title, PLAN_TITLE_MAX_CHARS)}`] : []),
		...(plan.summary ? [clip(plan.summary, PLAN_SUMMARY_MAX_CHARS)] : []),
	];
	return parts.length === 0 ? [] : [{ type: "markdown", key: "plan", markdown: parts.join("\n\n") }];
}

function presentResult(name: PlanningToolName, input: ToolPresentInput): Pick<ToolPresentation, "summary" | "body"> {
	if (isFailed(input)) {
		const error = clip(resultText(input.result), ERROR_MAX_CHARS) || "Planning tool failed";
		return { summary: [textNode("error", error, "error")] };
	}
	const plan = planningOf(input.result?.details)?.plan;
	if (!plan) return { summary: [textNode("status", "No active plan", "muted")] };
	const withPlanText = name === "submit_plan" || name === "request_replan";
	const reason = name === "request_replan" ? stringArg(input.args, "reason")?.trim() : undefined;
	return {
		summary: [
			statusNode(plan, true),
			...(withPlanText && plan.title ? [textNode("plan-title", oneLine(plan.title, PLAN_TITLE_MAX_CHARS))] : []),
		],
		body: [
			statusNode(plan, false),
			...(withPlanText ? planTextNode(plan) : []),
			...(reason ? [textNode("reason", `Reason: ${clip(reason, PLAN_SUMMARY_MAX_CHARS)}`)] : []),
			...checklistNodes(plan),
		],
	};
}

/** The presenter of planning tool `name`. */
export function presentPlanning(name: PlanningToolName): ToolPresenter {
	return (input) => {
		const title = titleFor(name, callDetail(name, input.args));
		if (input.state !== "done") return { title };
		const { summary, body } = presentResult(name, input);
		return {
			title,
			...(summary === undefined || summary.length === 0 ? {} : { summary }),
			...(body === undefined || body.length === 0 ? {} : { body }),
		};
	};
}
