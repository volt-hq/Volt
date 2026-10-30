import {
	type Component,
	createRenderFrame,
	decodePrintableKey,
	getKeybindings,
	type RenderFrame,
	ScrollView,
	type ScrollViewScrollbar,
	truncateToWidth,
	VStack,
	visibleWidth,
} from "@hansjm10/volt-tui";
import type { PlanningState, PlanPhase, PlanState } from "../../../core/planning.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyText, primaryKeyText, rawKeyHint } from "./keybinding-hints.ts";
import {
	appendWrappedPlanLine,
	fitPlanSides,
	getCurrentPlanStep,
	getPlanProgress,
	planMarkColor,
	planPhaseLabel,
	planSizeText,
	renderPlanContentLines,
	usesAsciiPlanMarkers,
} from "./plan-content.ts";

/** The most outcomes a working draft lists in the status strip, for a terminal of `rows`. */
function draftOutcomeRows(rows: number): number {
	return Math.max(2, Math.min(5, Math.floor(rows / 8)));
}

/**
 * Bounded branch-local plan summary kept directly above the editor where the
 * plan pane does not fit. Plan mode itself shows in the composer's border and
 * label, so the strip appears once there is a plan. A working draft lists its
 * outcomes as they evolve, as many as the terminal's height allows; a ready
 * plan's strip names it, and the composer's label says how to decide on it.
 */
export class PlanStatusComponent implements Component {
	private planning: PlanningState;
	private readonly getTerminalRows: () => number;

	constructor(planning: PlanningState, options: { getTerminalRows?: () => number } = {}) {
		this.planning = planning;
		this.getTerminalRows = options.getTerminalRows ?? (() => Number.POSITIVE_INFINITY);
	}

	setPlanning(planning: PlanningState): void {
		this.planning = planning;
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const plan = this.planning.plan;
		if (!plan) return createRenderFrame([]);

		const mark = usesAsciiPlanMarkers() ? "PLAN" : "◆ PLAN";
		const { completed, total, percent } = getPlanProgress(plan);
		const ready = plan.phase === "ready";
		const draft = plan.phase === "draft";
		const label = theme.bold(theme.fg(planMarkColor(plan.phase), `${mark} ${planPhaseLabel(plan)}`));
		const left =
			(ready || draft) && plan.title ? `${label}${theme.fg("muted", " · ")}${theme.fg("text", plan.title)}` : label;
		const right = theme.fg("dim", draft || ready ? planSizeText(plan) : `${completed}/${total} · ${percent}%`);
		const lines = [fitPlanSides(left, right, width, "…")];
		if (draft) return createRenderFrame([...lines, ...this.renderDraftOutcomes(plan, width)]);
		// The composer's label carries a ready plan's next-step keys at every width.
		if (ready || width < 100) return createRenderFrame(lines);

		const step = getCurrentPlanStep(plan);
		if (plan.phase === "handed_off" && plan.execution) {
			lines.push(
				truncateToWidth(
					theme.fg("muted", ` Execution session: ${plan.execution.targetSessionId} · /plan-close to close`),
					width,
				),
			);
		} else if (plan.phase === "completed") {
			lines.push(truncateToWidth(theme.fg("muted", " All steps complete · /plan-close to close"), width));
		} else if (step) {
			lines.push(truncateToWidth(theme.fg("muted", ` Current · ${step}`), width));
		}
		return createRenderFrame(lines);
	}

	/**
	 * A working draft's outcomes, one line each, then a line with how many more
	 * there are, its revision, and how to open it whole.
	 */
	private renderDraftOutcomes(plan: PlanState, width: number): string[] {
		const shown = plan.steps.slice(0, draftOutcomeRows(this.getTerminalRows()));
		const lines = shown.map((step, index) => {
			const tasks = step.substeps
				? theme.fg("dim", ` · ${step.substeps.length} ${step.substeps.length === 1 ? "task" : "tasks"}`)
				: "";
			const number = theme.fg("dim", `   ${index + 1}. `);
			// The text gives way so its task count stays beside it.
			const room = Math.max(1, width - visibleWidth(number) - visibleWidth(tasks));
			const text = truncateToWidth(theme.fg("muted", step.text.replace(/\s+/g, " ")), room, "…");
			return truncateToWidth(`${number}${text}${tasks}`, width, "");
		});
		const more = plan.steps.length - shown.length;
		const details = keyText("app.plan.togglePane");
		const footer = [
			...(more > 0 ? [`… ${more} more`] : []),
			`revision ${plan.revision}`,
			details ? `${details} details` : "/plan-details to inspect",
		].join(" · ");
		return [...lines, truncateToWidth(theme.fg("dim", `   ${footer}`), width)];
	}
}

export type PlanDetailsAction = "retain_context" | "new_session" | "change" | "close";

export interface PlanActionItem {
	label: string;
	action: PlanDetailsAction;
}

const READY_PLAN_ACTIONS: ReadonlyArray<PlanActionItem> = [
	{ label: "Execute Plan", action: "retain_context" },
	{ label: "Execute Plan & Clear Context", action: "new_session" },
	{ label: "Change Plan", action: "change" },
];

const FINISHED_PLAN_ACTIONS: ReadonlyArray<PlanActionItem> = [{ label: "Close Plan", action: "close" }];

/** Actions offered by the plan views for a lifecycle phase; draft and active plans offer none. */
export function getPlanActions(phase: PlanPhase | undefined): ReadonlyArray<PlanActionItem> {
	if (phase === "ready") return READY_PLAN_ACTIONS;
	if (phase === "completed" || phase === "handed_off") return FINISHED_PLAN_ACTIONS;
	return [];
}

/** The action buttons of a plan chooser, and the row of them holding the selected one. */
export interface PlanActionRows {
	readonly rows: string[];
	readonly selectedRow: number;
}

/**
 * Plan actions as one row of buttons, wrapped onto further rows where they do
 * not fit `width`. The selected button is bracketed and the others pad to the
 * same width, so moving the selection never reflows the rows.
 */
export function renderPlanActionRows(
	actions: ReadonlyArray<PlanActionItem>,
	selected: number,
	width: number,
): PlanActionRows {
	const rows: string[] = [];
	let row = " ";
	let rowWidth = 1;
	let selectedRow = 0;
	for (const [index, item] of actions.entries()) {
		const isSelected = index === selected;
		const cell = isSelected
			? theme.bold(theme.fg("accent", `[ ${item.label} ]`))
			: theme.fg("muted", `  ${item.label}  `);
		const cellWidth = visibleWidth(cell);
		if (rowWidth > 1 && rowWidth + 1 + cellWidth > width) {
			rows.push(truncateToWidth(row, width, ""));
			row = " ";
			rowWidth = 1;
		}
		if (rowWidth > 1) {
			row += " ";
			rowWidth += 1;
		}
		row += cell;
		rowWidth += cellWidth;
		if (isSelected) selectedRow = rows.length;
	}
	if (rowWidth > 1) rows.push(truncateToWidth(row, width, ""));
	return { rows, selectedRow };
}

/** The one hint row under a plan chooser: how to choose or confirm its actions, scroll it, and (`back`) leave it. */
export function renderPlanChooserHint(
	actions: ReadonlyArray<PlanActionItem>,
	width: number,
	options: { back: boolean },
): string {
	const hints: string[] = [];
	if (actions.length > 1) {
		hints.push(rawKeyHint("←/→", "choose"), rawKeyHint(primaryKeyText("tui.select.confirm"), "confirm"));
	} else if (actions[0]) {
		hints.push(rawKeyHint(primaryKeyText("tui.select.confirm"), actions[0].label.toLowerCase()));
	}
	hints.push(
		rawKeyHint(`${primaryKeyText("tui.select.up")}/${primaryKeyText("tui.select.down")}`, "scroll"),
		rawKeyHint(`${primaryKeyText("tui.editor.pageUp")}/${primaryKeyText("tui.editor.pageDown")}`, "page"),
	);
	if (options.back) hints.push(rawKeyHint(primaryKeyText("tui.select.cancel"), "back"));
	return truncateToWidth(` ${hints.join("  ")}`, width, "");
}

/** Printable keystrokes and pastes that belong in the composer rather than the ready-plan chooser. */
export function isComposerInput(data: string): boolean {
	return data.includes("\x1b[200~") || decodePrintableKey(data) !== undefined || /^[^\x00-\x1f\x7f]/u.test(data);
}

class PlanDetailsSection implements Component {
	private readonly renderSection: (width: number) => string[];

	constructor(renderSection: (width: number) => string[]) {
		this.renderSection = renderSection;
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): RenderFrame {
		return createRenderFrame(this.renderSection(width));
	}
}

/**
 * Scrollable plan viewer. Regular mode keeps its bounded native-scrollback
 * rendering; fullscreen mode uses a fixed header/actions layout around one
 * body ScrollView while sharing the same plan, action, and scroll state.
 * Its actions are one row of buttons at every width, chosen with the
 * horizontal keys; the vertical keys always scroll.
 */
export class PlanDetailsComponent implements Component {
	private static readonly RESERVED_OUTSIDE_ROWS = 7;
	private plan: PlanState;
	private readonly getTerminalRows: () => number;
	private readonly onAction: (action: PlanDetailsAction) => void;
	private readonly onClose: () => void;
	private readonly onTextInput: ((data: string) => void) | undefined;
	private readonly requestRender: () => void;
	private readonly bodyScroll: ScrollView;
	private readonly fullscreenLayout: VStack;
	private actionIndex = 0;
	private regularPageSize = 1;
	private fullscreenActive = false;

	constructor(options: {
		plan: PlanState;
		getTerminalRows: () => number;
		fullscreenScrollbar?: ScrollViewScrollbar;
		onAction: (action: PlanDetailsAction) => void;
		onClose: () => void;
		/** Receives text typed or pasted while a ready plan is shown, so it can reach the composer. */
		onTextInput?: (data: string) => void;
		requestRender: () => void;
	}) {
		this.plan = options.plan;
		this.getTerminalRows = options.getTerminalRows;
		this.onAction = options.onAction;
		this.onClose = options.onClose;
		this.onTextInput = options.onTextInput;
		this.requestRender = options.requestRender;

		const body = new PlanDetailsSection((width) => renderPlanContentLines(this.plan, width, theme));
		this.bodyScroll = new ScrollView(body, {
			overscroll: "contain",
			scrollbar: options.fullscreenScrollbar ?? "auto",
			scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
		});
		const header = new PlanDetailsSection((width) => this.renderFullscreenHeader(width));
		const actions = new PlanDetailsSection((width) => this.renderFooter(width, this.renderBorder(width)));
		this.fullscreenLayout = new VStack([
			{ component: header, shrink: 1, minSize: 0 },
			{ component: this.bodyScroll, basis: 0, grow: 1, shrink: 1, minSize: 0 },
			{ component: actions, shrink: 1, minSize: 0 },
		]);
	}

	setPlan(plan: PlanState): void {
		if (plan.id !== this.plan.id) this.bodyScroll.scrollToStart();
		if (plan.id !== this.plan.id || plan.phase !== this.plan.phase) this.actionIndex = 0;
		this.plan = plan;
	}

	setFullscreenActive(active: boolean): void {
		this.fullscreenActive = active;
	}

	setFullscreenScrollbar(scrollbar: ScrollViewScrollbar): void {
		this.bodyScroll.setScrollbar(scrollbar);
	}

	getFullscreenLayout(): Component {
		return this.fullscreenLayout;
	}

	invalidate(): void {
		this.fullscreenLayout.invalidate();
	}

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const border = this.renderBorder(width);
		const titleLines = this.renderTitle(width);
		const bodyContent = renderPlanContentLines(this.plan, width, theme);
		const footer = this.renderFooter(width, border);
		const headerRows = 2 + titleLines.length;
		const targetRows = Math.max(
			headerRows + footer.length + 2,
			this.getTerminalRows() - PlanDetailsComponent.RESERVED_OUTSIDE_ROWS,
		);
		const pageSize = Math.max(2, targetRows - headerRows - footer.length);
		this.regularPageSize = pageSize;
		this.bodyScroll.updateLayout(bodyContent.length, pageSize, this.requestRender);
		const end = Math.min(bodyContent.length, this.bodyScroll.scrollTop + pageSize);

		return createRenderFrame([
			border,
			...titleLines,
			this.renderMetadata(width, bodyContent.length, end),
			...bodyContent.slice(this.bodyScroll.scrollTop, end),
			...footer,
		]);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		const actions = getPlanActions(this.plan.phase);
		if (actions.length > 0 && kb.matches(data, "tui.select.confirm")) {
			const selected = actions[Math.min(this.actionIndex, actions.length - 1)];
			if (selected) this.onAction(selected.action);
			return;
		}
		if (actions.length > 1) {
			if (kb.matches(data, "tui.editor.cursorLeft")) {
				this.actionIndex = (this.actionIndex + actions.length - 1) % actions.length;
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.editor.cursorRight")) {
				this.actionIndex = (this.actionIndex + 1) % actions.length;
				this.requestRender();
				return;
			}
		}

		const pageSize = Math.max(1, this.fullscreenActive ? this.bodyScroll.viewportHeight : this.regularPageSize);
		if (kb.matches(data, "tui.select.up")) {
			this.bodyScroll.scrollBy(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.bodyScroll.scrollBy(1);
		} else if (kb.matches(data, "tui.editor.pageUp")) {
			this.bodyScroll.scrollBy(-pageSize);
		} else if (kb.matches(data, "tui.editor.pageDown")) {
			this.bodyScroll.scrollBy(pageSize);
		} else if (this.plan.phase === "ready" && isComposerInput(data)) {
			this.onTextInput?.(data);
		}
	}

	private renderBorder(width: number): string {
		return new DynamicBorder().render(width).lines[0] ?? "";
	}

	private renderTitle(width: number): string[] {
		const lines: string[] = [];
		appendWrappedPlanLine(lines, " ", theme.bold(theme.fg("accent", this.plan.title ?? "Plan Details")), width);
		return lines;
	}

	private renderFullscreenHeader(width: number): string[] {
		const bodyLength = renderPlanContentLines(this.plan, width, theme).length;
		const end = Math.min(bodyLength, this.bodyScroll.scrollTop + this.bodyScroll.viewportHeight);
		return [this.renderBorder(width), ...this.renderTitle(width), this.renderMetadata(width, bodyLength, end)];
	}

	private renderMetadata(width: number, bodyLength: number, end: number): string {
		const progress = getPlanProgress(this.plan);
		const maxScroll = Math.max(0, bodyLength - Math.max(1, this.bodyScroll.viewportHeight));
		const position = maxScroll > 0 ? ` · rows ${this.bodyScroll.scrollTop + 1}–${end}/${bodyLength}` : "";
		const size =
			this.plan.phase === "draft" || this.plan.phase === "ready"
				? planSizeText(this.plan)
				: `${progress.completed}/${progress.total} complete`;
		const phase = theme.bold(theme.fg(planMarkColor(this.plan.phase), planPhaseLabel(this.plan)));
		return truncateToWidth(` ${phase}${theme.fg("dim", ` · ${size}${position}`)}`, width, "");
	}

	private renderFooter(width: number, border: string): string[] {
		const actions = getPlanActions(this.plan.phase);
		const lines: string[] = [];
		if (actions.length > 0) {
			lines.push("", ...renderPlanActionRows(actions, Math.min(this.actionIndex, actions.length - 1), width).rows);
		}
		lines.push(renderPlanChooserHint(actions, width, { back: true }), border);
		return lines;
	}
}
