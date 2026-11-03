import {
	type Component,
	createRenderFrame,
	type Focusable,
	getKeybindings,
	type RenderFrame,
	ScrollView,
	type ScrollViewScrollbar,
	truncateToWidth,
	VStack,
	visibleWidth,
} from "@hansjm10/volt-tui";
import type { PlanningState } from "../../../core/planning.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { keyText, primaryKeyText } from "./keybinding-hints.ts";
import {
	appendWrappedPlanLine,
	fitPlanSides,
	insetPlanLines,
	renderPlanBadge,
	renderPlanBody,
	renderPlanMeta,
} from "./plan-content.ts";
import {
	getPlanActions,
	isComposerInput,
	type PlanDetailsAction,
	renderPlanActionRows,
	renderPlanChooserHint,
} from "./plan-status.ts";

/** The footer of the inspector: its action rows, then its hint row. */
interface InspectorFooter {
	readonly lines: string[];
	/** The index in `lines` of the row holding the selected action, when there are actions. */
	readonly selectedRow: number | undefined;
}

class PlanInspectorSection implements Component {
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
 * Persistent, focusable rendering of canonical branch-local planning state in
 * the plan pane: the plan's badge with its focus key, its size or progress,
 * the shared plan body, then its actions and one hint row, every row inset
 * one column from the divider and the terminal's edge.
 */
export class PlanInspectorComponent implements Component, Focusable {
	private planning: PlanningState;
	private readonly onAction: (action: PlanDetailsAction) => void;
	private readonly onReturnFocus: () => void;
	private readonly onToggleFocus: () => void;
	private readonly onTextInput: ((data: string) => void) | undefined;
	private readonly requestRender: () => void;
	private readonly bodyScroll: ScrollView;
	private readonly fullscreenLayout: VStack;
	private _focused = false;
	private selected = false;
	private actionIndex = 0;
	private regularViewportRows = 1;
	private regularPageSize = 1;
	private selectedActionVisible = false;
	private fullscreenActive = false;

	constructor(options: {
		planning: PlanningState;
		fullscreenScrollbar?: ScrollViewScrollbar;
		onAction: (action: PlanDetailsAction) => void;
		onReturnFocus: () => void;
		onToggleFocus: () => void;
		/** Receives text typed or pasted while a ready plan is focused, so it can reach the composer. */
		onTextInput?: (data: string) => void;
		requestRender: () => void;
	}) {
		this.planning = options.planning;
		this.onAction = options.onAction;
		this.onReturnFocus = options.onReturnFocus;
		this.onToggleFocus = options.onToggleFocus;
		this.onTextInput = options.onTextInput;
		this.requestRender = options.requestRender;

		this.bodyScroll = new ScrollView(new PlanInspectorSection((width) => this.renderBody(width)), {
			overscroll: "contain",
			scrollbar: options.fullscreenScrollbar ?? "auto",
			scrollbarStyle: (text) => theme.bg("scrollbarThumb", text),
		});
		this.fullscreenLayout = new VStack([
			{ component: new PlanInspectorSection((width) => this.renderFullscreenHeader(width)), shrink: 1, minSize: 0 },
			{ component: this.bodyScroll, basis: 0, grow: 1, shrink: 1, minSize: 0 },
			{
				component: new PlanInspectorSection((width) => this.renderFooter(width).lines),
				shrink: 1,
				minSize: 0,
			},
		]);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(focused: boolean) {
		this._focused = focused;
	}

	/** Whether the pane holds the user's attention: focused, or selected while a search overlay has focus. */
	get highlighted(): boolean {
		return this._focused || this.selected;
	}

	setSelected(selected: boolean): void {
		this.selected = selected;
		this.bodyScroll.setPrimary(this.fullscreenActive && selected);
	}

	setPlanning(planning: PlanningState): void {
		if (planning.plan?.id !== this.planning.plan?.id) this.bodyScroll.scrollToStart();
		if (planning.plan?.id !== this.planning.plan?.id || planning.plan?.phase !== this.planning.plan?.phase) {
			this.actionIndex = 0;
		}
		this.planning = planning;
		this.selectedActionVisible = false;
	}

	setViewportRows(rows: number): void {
		const nextRows = Math.max(0, rows);
		if (nextRows !== this.regularViewportRows) this.selectedActionVisible = false;
		this.regularViewportRows = nextRows;
	}

	setFullscreenActive(active: boolean): void {
		this.fullscreenActive = active;
		this.bodyScroll.setPrimary(active && this.selected);
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
		if (width <= 0 || this.regularViewportRows <= 0) {
			this.selectedActionVisible = false;
			return createRenderFrame([]);
		}

		const body = this.renderBody(width);
		const footer = this.renderFooter(width);
		const headerRows = Math.min(2, this.regularViewportRows);
		const footerRows = Math.min(footer.lines.length, Math.max(0, this.regularViewportRows - headerRows - 1));
		const pageSize = Math.max(1, this.regularViewportRows - headerRows - footerRows);
		this.regularPageSize = pageSize;
		this.bodyScroll.updateLayout(body.length, pageSize, this.requestRender);
		const end = Math.min(body.length, this.bodyScroll.scrollTop + pageSize);
		const header = this.renderHeader(width, body.length, end).slice(0, headerRows);
		const page = body.slice(this.bodyScroll.scrollTop, end);
		const shownRows = this.selectVisibleFooterRows(footer, footerRows);
		const visibleFooter = shownRows.map((row) => footer.lines[row] ?? "");
		this.selectedActionVisible = footer.selectedRow !== undefined && shownRows.includes(footer.selectedRow);
		const padding = Array.from(
			{ length: Math.max(0, this.regularViewportRows - header.length - page.length - visibleFooter.length) },
			() => "",
		);
		return createRenderFrame(
			[...header, ...page, ...padding, ...visibleFooter].map((line) => truncateToWidth(line, width, "")),
		);
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "app.plan.togglePane")) {
			this.onToggleFocus();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onReturnFocus();
			return;
		}
		const actions = getPlanActions(this.planning.plan?.phase);
		if (actions.length > 1) {
			if (kb.matches(data, "tui.editor.cursorLeft")) {
				this.actionIndex = (this.actionIndex + actions.length - 1) % actions.length;
				this.selectedActionVisible = false;
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.editor.cursorRight")) {
				this.actionIndex = (this.actionIndex + 1) % actions.length;
				this.selectedActionVisible = false;
				this.requestRender();
				return;
			}
		}
		if (actions.length > 0 && kb.matches(data, "tui.select.confirm")) {
			const selected = actions[this.actionIndex];
			if (selected && (this.fullscreenActive || this.selectedActionVisible)) this.onAction(selected.action);
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.bodyScroll.scrollBy(-1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.bodyScroll.scrollBy(1);
		} else if (kb.matches(data, "tui.editor.pageUp")) {
			this.bodyScroll.scrollBy(-this.getPageSize());
		} else if (kb.matches(data, "tui.editor.pageDown")) {
			this.bodyScroll.scrollBy(this.getPageSize());
		} else if (this.planning.plan?.phase === "ready" && isComposerInput(data)) {
			this.onTextInput?.(data);
		}
	}

	private getPageSize(): number {
		return Math.max(1, this.fullscreenActive ? this.bodyScroll.viewportHeight : this.regularPageSize);
	}

	private renderFullscreenHeader(width: number): string[] {
		const bodyLength = this.renderBody(this.bodyScroll.getContentWidth(width)).length;
		const end = Math.min(bodyLength, this.bodyScroll.scrollTop + this.bodyScroll.viewportHeight);
		return this.renderHeader(width, bodyLength, end);
	}

	private renderHeader(width: number, bodyRows: number, end: number): string[] {
		const plan = this.planning.plan;
		const hint = this.highlighted
			? `${primaryKeyText("tui.select.cancel")} back`
			: `${keyText("app.plan.togglePane")} ${plan?.phase === "ready" ? "choose" : "focus"}`;
		const position =
			bodyRows > this.getPageSize()
				? theme.fg("dim", `rows ${this.bodyScroll.scrollTop + 1}–${end}/${bodyRows}`)
				: "";
		return insetPlanLines(width, (inner) => {
			const metaWidth = Math.max(1, inner - visibleWidth(position) - (position ? 1 : 0));
			return [
				fitPlanSides(renderPlanBadge(plan), theme.fg("dim", hint), inner),
				fitPlanSides(plan ? renderPlanMeta(plan, metaWidth) : "", position, inner),
			];
		});
	}

	/** The shared plan body, inset, after a blank row below the header. */
	private renderBody(width: number): string[] {
		const plan = this.planning.plan;
		return insetPlanLines(width, (inner) => {
			if (plan) return ["", ...renderPlanBody(plan, inner)];
			const lines = [""];
			appendWrappedPlanLine(lines, "", theme.bold(theme.fg("text", "No plan yet")), inner);
			appendWrappedPlanLine(
				lines,
				"",
				theme.fg("muted", "Volt drafts the plan here after its initial research orientation."),
				inner,
			);
			return lines;
		});
	}

	/**
	 * The footer rows that fit `rows`, in order. When not all fit, the row
	 * holding the selected action comes first, then the hint, then the other
	 * action rows: Enter confirms only an action that shows.
	 */
	private selectVisibleFooterRows(footer: InspectorFooter, rows: number): number[] {
		if (rows <= 0) return [];
		const all = footer.lines.map((_, index) => index);
		if (rows >= all.length) return all;
		if (footer.selectedRow === undefined) return all.slice(-rows);
		const hintRow = all.length - 1;
		const priority = [
			footer.selectedRow,
			hintRow,
			...all.filter((row) => row !== footer.selectedRow && row !== hintRow),
		];
		return priority.slice(0, rows).sort((left, right) => left - right);
	}

	private renderFooter(width: number): InspectorFooter {
		const actions = getPlanActions(this.planning.plan?.phase);
		let selectedRow: number | undefined;
		const lines = insetPlanLines(width, (inner) => {
			const hint = renderPlanChooserHint(actions, inner, { back: false });
			if (actions.length === 0) return [hint];
			const buttons = renderPlanActionRows(actions, Math.min(this.actionIndex, actions.length - 1), inner);
			selectedRow = buttons.selectedRow;
			return [...buttons.rows, hint];
		});
		return { lines, selectedRow };
	}
}
