/**
 * The plan's visual language, shared by every TUI plan surface (the status
 * strip, the plan pane, and Plan Details) and matching the planning tools'
 * transcript cards:
 *
 * - a `◆ PLAN · PHASE` badge: the plan's mark in the theme's `planMode`
 *   color, its phase in the color the cards give it;
 * - checklist items as a status glyph, their checklist number, and their
 *   text, with details muted two spaces after the text and notes below;
 * - the cards' `Checklist · …` heading;
 * - progress as the TUI's block bar.
 *
 * Plan chrome (the badge mark, rules, the focused pane's divider) is
 * `planMode`; plan content uses the semantic status colors the cards do.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@hansjm10/volt-tui";
import {
	getPlanLeafSteps,
	type PlanItem,
	type PlanPhase,
	type PlanState,
	type PlanStep,
	type PlanStepStatus,
} from "../../../core/planning.ts";
import { type ThemeColor, theme } from "../../../core/theme/runtime.ts";

export interface PlanProgress {
	completed: number;
	total: number;
	percent: number;
}

/** A checklist leaf with the number the checklist gives it ("3", or "3.2" for a substep). */
export interface NumberedPlanItem {
	readonly item: PlanItem;
	readonly number: string;
}

export function usesAsciiPlanMarkers(): boolean {
	const termProgram = process.env.TERM_PROGRAM ?? "";
	return process.env.VOLT_ASCII === "1" || process.env.TERM === "linux" || termProgram === "";
}

export function planPhaseLabel(plan: PlanState): string {
	switch (plan.phase) {
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

/** A phase's color, as the planning tools' cards give it: a ready plan waits on the user. */
function planPhaseColor(phase: PlanPhase): ThemeColor {
	return phase === "ready" ? "warning" : phase === "completed" ? "success" : phase === "draft" ? "muted" : "accent";
}

/** `◆ PLAN · PHASE`, or the mark alone before there is a plan. */
export function renderPlanBadge(plan: PlanState | null | undefined): string {
	const mark = theme.bold(theme.fg("planMode", usesAsciiPlanMarkers() ? "PLAN" : "◆ PLAN"));
	if (!plan) return mark;
	return `${mark}${theme.fg("dim", " · ")}${theme.bold(theme.fg(planPhaseColor(plan.phase), planPhaseLabel(plan)))}`;
}

/** A rule across `width` in the plan's chrome color, with `label` near its start. */
export function renderPlanRule(width: number, label?: string): string {
	if (width <= 0) return "";
	const rule = usesAsciiPlanMarkers() ? "-" : "─";
	if (label === undefined) return theme.fg("planMode", rule.repeat(width));
	const head = `${rule.repeat(2)} `;
	const tail = rule.repeat(Math.max(0, width - visibleWidth(head) - visibleWidth(label) - 1));
	return truncateToWidth(`${theme.fg("planMode", head)}${label}${theme.fg("planMode", ` ${tail}`)}`, width, "");
}

/** A plan's size: its outcomes and tasks when outcomes have substeps, else its steps. */
export function planSizeText(plan: PlanState): string {
	const { total } = getPlanProgress(plan);
	const outcomes = plan.steps.length;
	return plan.steps.some((step) => step.substeps !== undefined)
		? `${outcomes} ${outcomes === 1 ? "outcome" : "outcomes"} · ${total} ${total === 1 ? "task" : "tasks"}`
		: `${total} ${total === 1 ? "step" : "steps"}`;
}

/** `left` truncated with `ellipsis` so `right` stays flush with the right edge of `width`. */
export function fitPlanSides(left: string, right: string, width: number, ellipsis = ""): string {
	if (width <= 0) return "";
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(right, width, "");
	const fittedLeft = truncateToWidth(left, Math.max(0, width - rightWidth - 1), ellipsis);
	const gap = " ".repeat(Math.max(1, width - visibleWidth(fittedLeft) - rightWidth));
	return truncateToWidth(`${fittedLeft}${gap}${right}`, width, "");
}

/**
 * Lines `render` draws one column in from both edges of `width`, so a plan
 * surface's content never touches a divider or the terminal's edge.
 */
export function insetPlanLines(width: number, render: (innerWidth: number) => readonly string[]): string[] {
	if (width <= 0) return [];
	if (width < 3) return [...render(width)];
	return render(width - 2).map((line) => ` ${line}`);
}

export function getPlanProgress(plan: PlanState): PlanProgress {
	const leaves = getPlanLeafSteps(plan);
	const total = leaves.length;
	const completed = leaves.filter((step) => step.status === "completed").length;
	return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

/** The leaf execution is on: the first in progress, else the first pending. */
export function getCurrentPlanItem(plan: PlanState): NumberedPlanItem | undefined {
	for (const status of ["in_progress", "pending"] as const) {
		for (const [index, step] of plan.steps.entries()) {
			if (!step.substeps) {
				if (step.status === status) return { item: step, number: `${index + 1}` };
				continue;
			}
			const subindex = step.substeps.findIndex((item) => item.status === status);
			if (subindex !== -1) return { item: step.substeps[subindex]!, number: `${index + 1}.${subindex + 1}` };
		}
	}
	return undefined;
}

/**
 * A plan's progress as the TUI's block bar, at most `maxBarWidth` cells, then
 * its count: the bar fills the rest of `width`. A finished plan's bar is
 * complete in the success color.
 */
export function renderPlanProgressBar(plan: PlanState, width: number, maxBarWidth = 40): string {
	const { completed, total } = getPlanProgress(plan);
	const count = ` ${completed}/${total}`;
	const barWidth = Math.max(4, Math.min(maxBarWidth, width - visibleWidth(count)));
	const filled = total === 0 ? 0 : Math.round((completed / total) * barWidth);
	const [full, empty] = usesAsciiPlanMarkers() ? ["#", "-"] : ["█", "░"];
	const fill = total > 0 && completed === total ? "success" : "accent";
	return truncateToWidth(
		theme.fg(fill, full.repeat(filled)) + theme.fg("muted", empty.repeat(barWidth - filled) + count),
		width,
		"",
	);
}

/**
 * What a plan's header says of its extent: a draft's size and revision, a
 * ready plan's size, or the progress bar of a plan that is executing or done.
 */
export function renderPlanMeta(plan: PlanState, width: number, maxBarWidth?: number): string {
	if (plan.phase === "draft") return theme.fg("dim", `${planSizeText(plan)} · revision ${plan.revision}`);
	if (plan.phase === "ready") return theme.fg("dim", planSizeText(plan));
	return renderPlanProgressBar(plan, width, maxBarWidth);
}

/**
 * `content` after `prefix`, wrapped to `width` with continuation lines under
 * the content. `suffix` stays whole: on the last line where it fits, else on
 * a continuation line of its own.
 */
export function appendWrappedPlanLine(
	lines: string[],
	prefix: string,
	content: string,
	width: number,
	suffix = "",
): void {
	if (width <= 0) return;
	const safePrefix = truncateToWidth(prefix, Math.max(0, width - 1), "");
	const prefixWidth = visibleWidth(safePrefix);
	const contentWidth = Math.max(1, width - prefixWidth);
	const wrapped = wrapTextWithAnsi(content, contentWidth);
	if (suffix) {
		const last = wrapped.length - 1;
		if (last >= 0 && visibleWidth(wrapped[last] ?? "") + visibleWidth(suffix) <= contentWidth) {
			wrapped[last] = `${wrapped[last] ?? ""}${suffix}`;
		} else {
			wrapped.push(suffix.trimStart());
		}
	}
	for (let index = 0; index < wrapped.length; index += 1) {
		const linePrefix = index === 0 ? safePrefix : " ".repeat(prefixWidth);
		lines.push(truncateToWidth(`${linePrefix}${wrapped[index] ?? ""}`, width, ""));
	}
}

const ITEM_GLYPHS: Readonly<Record<PlanStepStatus, { unicode: string; ascii: string; color: ThemeColor }>> = {
	completed: { unicode: "✓", ascii: "[x]", color: "success" },
	in_progress: { unicode: "●", ascii: "[>]", color: "accent" },
	pending: { unicode: "○", ascii: "[ ]", color: "muted" },
};

/** An item's status glyph, as the cards draw a step's. */
export function planItemGlyph(status: PlanStepStatus): string {
	const glyph = ITEM_GLYPHS[status];
	return theme.fg(glyph.color, usesAsciiPlanMarkers() ? glyph.ascii : glyph.unicode);
}

/** An outcome's task count as the cards give it: done of all. */
function outcomeDetail(step: PlanStep): string | undefined {
	if (step.substeps === undefined) return undefined;
	const done = step.substeps.filter((substep) => substep.status === "completed").length;
	return `${done}/${step.substeps.length} ${step.substeps.length === 1 ? "task" : "tasks"}`;
}

export interface PlanItemLineOptions {
	/** Columns before the glyph. */
	readonly indent?: number;
	/** The width the number pads to, so the texts of sibling items align. */
	readonly numberWidth?: number;
	/** Muted text two spaces after the item's text. */
	readonly detail?: string;
	/** One truncated line without the note, for bounded summaries; else wrapped, with the note below. */
	readonly singleLine?: boolean;
}

/**
 * One checklist item: its glyph, its number, and its text, which finished
 * items mute, then `detail`. Wrapped lines align with the text, and the note
 * follows on its own lines. Returns the column the text starts at.
 */
export function appendPlanItemLines(
	lines: string[],
	{ item, number }: NumberedPlanItem,
	width: number,
	options: PlanItemLineOptions = {},
): number {
	const prefix = `${" ".repeat(options.indent ?? 0)}${planItemGlyph(item.status)} ${theme.fg(
		"dim",
		number.padEnd(options.numberWidth ?? number.length),
	)} `;
	const textColumn = visibleWidth(prefix);
	const text = theme.fg(item.status === "completed" ? "muted" : "text", item.text.replace(/\s+/g, " "));
	if (options.singleLine) {
		const detail = options.detail === undefined ? "" : theme.fg("muted", `  ${options.detail}`);
		// The text gives way so its detail stays beside it.
		const room = Math.max(1, width - textColumn - visibleWidth(detail));
		lines.push(truncateToWidth(`${prefix}${truncateToWidth(text, room, "…")}${detail}`, width, ""));
		return textColumn;
	}
	// The detail stays whole, as a styled suffix the wrap keeps together.
	appendWrappedPlanLine(
		lines,
		prefix,
		text,
		width,
		options.detail === undefined ? "" : `  ${theme.fg("muted", options.detail)}`,
	);
	if (item.note) {
		const arrow = usesAsciiPlanMarkers() ? "->" : "↳";
		appendWrappedPlanLine(
			lines,
			`${" ".repeat(textColumn)}${theme.fg("dim", arrow)} `,
			theme.fg("dim", item.note),
			width,
		);
	}
	return textColumn;
}

/** A plan's outcomes as single item lines, with the cards' task counts. */
export function appendPlanOutcomeLines(
	lines: string[],
	steps: readonly PlanStep[],
	width: number,
	options: { indent: number; numberWidth: number },
): void {
	for (const [index, step] of steps.entries()) {
		const detail = outcomeDetail(step);
		appendPlanItemLines(lines, { item: step, number: `${index + 1}` }, width, {
			...options,
			singleLine: true,
			...(detail === undefined ? {} : { detail }),
		});
	}
}

/**
 * A plan's body, as the plan pane and Plan Details show it: its title and
 * summary, where an execution session runs it, then its checklist under the
 * cards' heading. A draft or ready plan shows every group; execution opens
 * only the group it is on.
 */
export function renderPlanBody(plan: PlanState, width: number): string[] {
	if (width <= 0) return [];
	const lines: string[] = [];
	appendWrappedPlanLine(lines, "", theme.bold(theme.fg("text", plan.title ?? "Untitled plan")), width);
	if (plan.summary) {
		lines.push("");
		appendWrappedPlanLine(lines, "", theme.fg("muted", plan.summary), width);
	}
	if (plan.phase === "handed_off" && plan.execution) {
		lines.push("");
		appendWrappedPlanLine(
			lines,
			"",
			theme.fg("accent", `Executing in session ${plan.execution.targetSessionId}`),
			width,
		);
	}
	lines.push("");
	const progress = getPlanProgress(plan);
	const started = getPlanLeafSteps(plan).some((leaf) => leaf.status !== "pending");
	lines.push(
		truncateToWidth(
			`${theme.bold(theme.fg("text", "Checklist"))}${theme.fg(
				"muted",
				` · ${started ? `${progress.completed}/${progress.total} complete` : planSizeText(plan)}`,
			)}`,
			width,
			"",
		),
	);
	if (plan.steps.length === 0) {
		lines.push(truncateToWidth(theme.fg("muted", "No steps yet"), width, ""));
		return lines;
	}
	const current =
		plan.phase === "active"
			? (plan.steps.find((step) => (step.substeps ?? [step]).some((item) => item.status === "in_progress")) ??
				plan.steps.find((step) => (step.substeps ?? [step]).some((item) => item.status === "pending")))
			: undefined;
	const numberWidth = `${plan.steps.length}`.length;
	for (const [index, step] of plan.steps.entries()) {
		const number = `${index + 1}`;
		const detail = outcomeDetail(step);
		const textColumn = appendPlanItemLines(lines, { item: step, number }, width, {
			numberWidth,
			...(detail === undefined ? {} : { detail }),
		});
		const open =
			step.substeps !== undefined && (plan.phase === "draft" || plan.phase === "ready" || current === step);
		if (!open) continue;
		const substepNumberWidth = `${number}.${step.substeps!.length}`.length;
		for (const [subindex, substep] of step.substeps!.entries()) {
			appendPlanItemLines(lines, { item: substep, number: `${number}.${subindex + 1}` }, width, {
				indent: textColumn,
				numberWidth: substepNumberWidth,
			});
		}
	}
	return lines;
}
