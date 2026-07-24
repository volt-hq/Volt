import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import type { PlanningState, PlanState } from "../../../core/planning.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

function asciiOnly(): boolean {
	const termProgram = process.env.TERM_PROGRAM ?? "";
	return process.env.VOLT_ASCII === "1" || process.env.TERM === "linux" || termProgram === "";
}

function phaseLabel(plan: PlanState): string {
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

function progress(plan: PlanState): { completed: number; total: number; percent: number } {
	const total = plan.steps.length;
	const completed = plan.steps.filter((step) => step.status === "completed").length;
	return { completed, total, percent: total === 0 ? 0 : Math.round((completed / total) * 100) };
}

function currentStep(plan: PlanState): string | undefined {
	return (
		plan.steps.find((step) => step.status === "in_progress") ?? plan.steps.find((step) => step.status === "pending")
	)?.text;
}

/** Bounded one/two-line branch-local plan summary kept directly above the editor. */
export class PlanStatusComponent implements Component {
	private planning: PlanningState;

	constructor(planning: PlanningState) {
		this.planning = planning;
	}

	setPlanning(planning: PlanningState): void {
		this.planning = planning;
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const plan = this.planning.plan;
		if (!plan && this.planning.mode === "build") return [];

		const mark = asciiOnly() ? "PLAN" : "◆ PLAN";
		if (!plan) {
			return [
				truncateToWidth(
					`${theme.bold(theme.fg("accent", mark))}${theme.fg("dim", " · DRAFT · Agent tools are read-only")}`,
					width,
				),
			];
		}

		const { completed, total, percent } = progress(plan);
		const left = theme.bold(theme.fg(plan.phase === "ready" ? "warning" : "accent", `${mark} ${phaseLabel(plan)}`));
		const right = theme.fg("dim", `${completed}/${total} · ${percent}%`);
		const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
		const lines = [truncateToWidth(`${left}${gap}${right}`, width)];
		if (width < 100) return lines;

		const step = currentStep(plan);
		if (plan.phase === "handed_off" && plan.execution) {
			lines.push(truncateToWidth(theme.fg("muted", ` Execution session: ${plan.execution.targetSessionId}`), width));
		} else if (step) {
			lines.push(truncateToWidth(theme.fg("muted", ` Current · ${step}`), width));
		} else if (plan.phase === "ready") {
			lines.push(truncateToWidth(theme.fg("muted", " Choose how to execute or return to editing"), width));
		}
		return lines;
	}
}

export type PlanDetailsAction = "retain_context" | "new_session" | "change";

/**
 * Scrollable plan viewer. It lives above the normal editor, so even the compact
 * ready-state selector never displaces draft feedback input.
 */
export class PlanDetailsComponent implements Component {
	private plan: PlanState;
	private readonly getTerminalRows: () => number;
	private readonly onAction: (action: PlanDetailsAction) => void;
	private readonly onClose: () => void;
	private readonly requestRender: () => void;
	private actionIndex = 0;
	private scrollOffset = 0;

	constructor(options: {
		plan: PlanState;
		getTerminalRows: () => number;
		onAction: (action: PlanDetailsAction) => void;
		onClose: () => void;
		requestRender: () => void;
	}) {
		this.plan = options.plan;
		this.getTerminalRows = options.getTerminalRows;
		this.onAction = options.onAction;
		this.onClose = options.onClose;
		this.requestRender = options.requestRender;
	}

	setPlan(plan: PlanState): void {
		this.plan = plan;
		this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, plan.steps.length - 1));
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const compact = width < 100;
		const border = new DynamicBorder().render(width)[0]!;
		const title = theme.bold(theme.fg("accent", this.plan.title ?? "Plan Details"));
		const progressValue = progress(this.plan);
		const lines = [
			border,
			truncateToWidth(
				` ${title}${theme.fg("dim", ` · ${progressValue.completed}/${progressValue.total} complete`)}`,
				width,
			),
		];

		if (!compact) {
			if (this.plan.summary) {
				lines.push(truncateToWidth(` ${theme.fg("muted", this.plan.summary)}`, width));
			}
			const availableRows = Math.max(2, Math.min(10, this.getTerminalRows() - 14));
			const maxOffset = Math.max(0, this.plan.steps.length - availableRows);
			this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
			for (const step of this.plan.steps.slice(this.scrollOffset, this.scrollOffset + availableRows)) {
				const marker =
					step.status === "completed"
						? asciiOnly()
							? "[x]"
							: "✓"
						: step.status === "in_progress"
							? asciiOnly()
								? "[>]"
								: "→"
							: asciiOnly()
								? "[ ]"
								: "○";
				lines.push(
					truncateToWidth(
						` ${theme.fg(step.status === "in_progress" ? "accent" : "text", `${marker} ${step.text}`)}${
							step.note ? theme.fg("dim", ` · ${step.note}`) : ""
						}`,
						width,
					),
				);
			}
		}

		if (this.plan.phase === "ready") {
			const actions = ["Execute Plan", "Execute Plan & Clear Context", "Change Plan"];
			lines.push("");
			if (compact) {
				lines.push(
					...actions.map((label, index) =>
						truncateToWidth(
							` ${index === this.actionIndex ? theme.bold(theme.fg("accent", `> ${label}`)) : theme.fg("muted", `  ${label}`)}`,
							width,
						),
					),
				);
			} else {
				lines.push(
					truncateToWidth(
						` ${actions
							.map((label, index) =>
								index === this.actionIndex
									? theme.bold(theme.fg("accent", `[ ${label} ]`))
									: theme.fg("muted", label),
							)
							.join(theme.fg("dim", "   "))}`,
						width,
					),
				);
			}
		}
		lines.push(
			truncateToWidth(
				` ${this.plan.phase === "ready" ? `${rawKeyHint("←/→", "choose")}  ${keyHint("tui.select.confirm", "confirm")}  ` : ""}${keyHint("tui.editor.pageUp", "scroll")}  ${keyHint("tui.select.cancel", "close")}`,
				width,
			),
		);
		lines.push(border);
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (this.plan.phase === "ready") {
			if (kb.matches(data, "tui.editor.cursorLeft") || kb.matches(data, "tui.select.up")) {
				this.actionIndex = (this.actionIndex + 2) % 3;
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.editor.cursorRight") || kb.matches(data, "tui.select.down")) {
				this.actionIndex = (this.actionIndex + 1) % 3;
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				this.onAction((["retain_context", "new_session", "change"] as const)[this.actionIndex]!);
				return;
			}
		}
		const pageSize = Math.max(1, Math.min(10, this.getTerminalRows() - 14));
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - pageSize);
			this.requestRender();
		} else if (kb.matches(data, "tui.editor.pageDown")) {
			this.scrollOffset = Math.min(Math.max(0, this.plan.steps.length - pageSize), this.scrollOffset + pageSize);
			this.requestRender();
		}
	}
}
