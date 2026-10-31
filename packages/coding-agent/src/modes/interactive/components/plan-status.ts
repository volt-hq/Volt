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
import { keyText, primaryKeyText, rawKeyHint } from "./keybinding-hints.ts";
import {
	appendPlanItemLines,
	appendPlanOutcomeLines,
	fitPlanSides,
	getCurrentPlanItem,
	insetPlanLines,
	planSizeText,
	renderPlanBadge,
	renderPlanBody,
	renderPlanMeta,
	renderPlanProgressBar,
	renderPlanRule,
} from "./plan-content.ts";

/** The most outcomes a working draft lists in the status strip, for a terminal of `rows`. */
function draftOutcomeRows(rows: number): number {
	return Math.max(2, Math.min(5, Math.floor(rows / 8)));
}

/** Columns the status strip indents its rows under its badge. */
const STRIP_INDENT = 2;

/**
 * Bounded branch-local plan summary kept directly above the editor where the
 * plan pane does not fit: the plan's badge, title, and size or progress, then
 * one row of what matters in its phase. A working draft lists its outcomes as
 * they evolve, as many as the terminal's height allows; execution shows the
 * item it is on. Plan mode itself shows in the composer's border and label,
 * so the strip appears once there is a plan, and a ready plan leaves its
 * next-step keys to the composer's label.
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

		const badge = renderPlanBadge(plan);
		const left = plan.title ? `${badge}  ${theme.fg("text", plan.title)}` : badge;
		const right =
			plan.phase === "draft" || plan.phase === "ready"
				? theme.fg("dim", planSizeText(plan))
				: renderPlanProgressBar(plan, width, 10);
		const lines = [fitPlanSides(left, right, width, "…")];
		const footer = (parts: readonly string[]): string =>
			truncateToWidth(theme.fg("dim", `${" ".repeat(STRIP_INDENT)}${parts.join(" · ")}`), width, "");
		switch (plan.phase) {
			case "draft": {
				const shown = plan.steps.slice(0, draftOutcomeRows(this.getTerminalRows()));
				appendPlanOutcomeLines(lines, shown, width, {
					indent: STRIP_INDENT,
					numberWidth: `${shown.length}`.length,
				});
				const more = plan.steps.length - shown.length;
				const details = keyText("app.plan.togglePane");
				lines.push(
					footer([
						...(more > 0 ? [`… ${more} more`] : []),
						`revision ${plan.revision}`,
						details ? `${details} details` : "/plan-details to inspect",
					]),
				);
				break;
			}
			case "active": {
				const current = getCurrentPlanItem(plan);
				if (current) appendPlanItemLines(lines, current, width, { indent: STRIP_INDENT, singleLine: true });
				break;
			}
			case "completed":
				lines.push(footer(["All steps complete", "/plan-close to close"]));
				break;
			case "handed_off":
				if (plan.execution) {
					lines.push(footer([`Executing in session ${plan.execution.targetSessionId}`, "/plan-close to close"]));
				}
				break;
			default:
				break;
		}
		return createRenderFrame(lines);
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
	let row = "";
	let rowWidth = 0;
	let selectedRow = 0;
	for (const [index, item] of actions.entries()) {
		const isSelected = index === selected;
		const cell = isSelected
			? theme.bold(theme.fg("accent", `[ ${item.label} ]`))
			: theme.fg("muted", `  ${item.label}  `);
		const cellWidth = visibleWidth(cell);
		if (rowWidth > 0 && rowWidth + 1 + cellWidth > width) {
			rows.push(truncateToWidth(row, width, ""));
			row = "";
			rowWidth = 0;
		}
		if (rowWidth > 0) {
			row += " ";
			rowWidth += 1;
		}
		row += cell;
		rowWidth += cellWidth;
		if (isSelected) selectedRow = rows.length;
	}
	if (rowWidth > 0) rows.push(truncateToWidth(row, width, ""));
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
	return truncateToWidth(hints.join("  "), width, "");
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
 * Scrollable plan viewer where the plan pane does not fit, laid out as the
 * pane is: a rule carrying the plan's badge, the plan's size or progress,
 * the shared plan body, then its actions and one hint row above a closing
 * rule. Regular mode keeps its bounded native-scrollback rendering;
 * fullscreen mode uses a fixed header/actions layout around one body
 * ScrollView while sharing the same plan, action, and scroll state. Its
 * actions are one row of buttons at every width, chosen with the horizontal
 * keys; the vertical keys always scroll.
 */
export class PlanDetailsComponent implements Component {
	private static readonly RESERVED_OUTSIDE_ROWS = 7;
	private static readonly HEADER_ROWS = 2;
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

		const body = new PlanDetailsSection((width) => this.renderBody(width));
		this.bodyScroll = new ScrollView(body, {
			overscroll: "contain",
			scrollbar: options.fullscreenScrollbar ?? "auto",
			scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
		});
		const header = new PlanDetailsSection((width) => this.renderFullscreenHeader(width));
		const actions = new PlanDetailsSection((width) => this.renderFooter(width));
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
		const bodyContent = this.renderBody(width);
		const footer = this.renderFooter(width);
		const headerRows = PlanDetailsComponent.HEADER_ROWS;
		const targetRows = Math.max(
			headerRows + footer.length + 2,
			this.getTerminalRows() - PlanDetailsComponent.RESERVED_OUTSIDE_ROWS,
		);
		const pageSize = Math.max(2, targetRows - headerRows - footer.length);
		this.regularPageSize = pageSize;
		this.bodyScroll.updateLayout(bodyContent.length, pageSize, this.requestRender);
		const end = Math.min(bodyContent.length, this.bodyScroll.scrollTop + pageSize);

		return createRenderFrame([
			...this.renderHeader(width, bodyContent.length, end),
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

	/** The shared plan body, inset, after a blank row below the header. */
	private renderBody(width: number): string[] {
		return insetPlanLines(width, (inner) => ["", ...renderPlanBody(this.plan, inner)]);
	}

	private renderFullscreenHeader(width: number): string[] {
		const bodyLength = this.renderBody(this.bodyScroll.getContentWidth(width)).length;
		const end = Math.min(bodyLength, this.bodyScroll.scrollTop + this.bodyScroll.viewportHeight);
		return this.renderHeader(width, bodyLength, end);
	}

	/** The rule carrying the plan's badge, then its size or progress with the scroll position at its right. */
	private renderHeader(width: number, bodyLength: number, end: number): string[] {
		const pageRows = this.fullscreenActive ? this.bodyScroll.viewportHeight : this.regularPageSize;
		const position =
			bodyLength > Math.max(1, pageRows)
				? theme.fg("dim", `rows ${this.bodyScroll.scrollTop + 1}–${end}/${bodyLength}`)
				: "";
		return [
			renderPlanRule(width, renderPlanBadge(this.plan)),
			...insetPlanLines(width, (inner) => {
				const metaWidth = Math.max(1, inner - visibleWidth(position) - (position ? 1 : 0));
				return [fitPlanSides(renderPlanMeta(this.plan, metaWidth), position, inner)];
			}),
		];
	}

	private renderFooter(width: number): string[] {
		const actions = getPlanActions(this.plan.phase);
		return [
			...insetPlanLines(width, (inner) => [
				"",
				...(actions.length > 0
					? renderPlanActionRows(actions, Math.min(this.actionIndex, actions.length - 1), inner).rows
					: []),
				renderPlanChooserHint(actions, inner, { back: true }),
			]),
			renderPlanRule(width),
		];
	}
}
