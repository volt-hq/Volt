/**
 * The work list of the footer: the conversation's open work at a glance,
 * whatever its kind. Work one tool call started is one group (a background
 * subagent's job and subagent, a parallel call's children); other work is a
 * group of its own. A group shows its most active item's state and elapsed
 * time, its first item's kind and title, its newest progress text, and how
 * many more items it holds past two.
 *
 * One group is one line. Several show a line of counts per state, then one
 * row per group, at most {@link WORK_LIST_MAX_ROWS} lines of them; a terminal
 * shorter than {@link WORK_LIST_MIN_TERMINAL_ROWS} rows shows only the counts.
 * The inspector's key closes the first line. Nothing shows while no work is
 * open.
 */

import { type Component, createRenderFrame, type RenderFrame, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import {
	styledWorkGlyph,
	styledWorkState,
	type WorkItemView,
	type WorkSource,
	workDisplayText,
	workStateLabel,
	workTiming,
	workTitle,
} from "./work-inspector.ts";

/** Most lines the rows of several groups take below the counts; the last says how many more groups there are. */
export const WORK_LIST_MAX_ROWS = 3;

/** Fewest terminal rows at which several groups show as rows; shorter terminals show only the counts. */
export const WORK_LIST_MIN_TERMINAL_ROWS = 20;

export interface WorkStatusOptions {
	/** The terminal's height, in rows; without it, several groups always show as rows. */
	readonly terminalRows?: () => number;
}

/** Open work grouped by the tool call that started it, in source order by each group's first item. */
function workGroups(open: readonly WorkItemView[]): WorkItemView[][] {
	const groups: WorkItemView[][] = [];
	const byToolCall = new Map<string, WorkItemView[]>();
	for (const view of open) {
		const toolCallId = view.item.toolCallId;
		const group = toolCallId === undefined ? undefined : byToolCall.get(toolCallId);
		if (group) {
			group.push(view);
			continue;
		}
		const created = [view];
		groups.push(created);
		if (toolCallId !== undefined) byToolCall.set(toolCallId, created);
	}
	return groups;
}

/** An item's progress text on one line: its live value's while it runs here, else its latest checkpoint's. */
function progressText(view: WorkItemView): string | undefined {
	const text = (view.live?.progress ?? view.item.progress)?.text;
	const line = text === undefined ? "" : workDisplayText(text).replace(/\s+/g, " ").trim();
	return line || undefined;
}

/** Open states from most to least active: a group shows its most active item's. */
const OPEN_STATE_ORDER = ["running", "cancelling", "awaiting approval", "suspended"];

function activityRank(view: WorkItemView): number {
	const rank = OPEN_STATE_ORDER.indexOf(workStateLabel(view));
	return rank === -1 ? OPEN_STATE_ORDER.length : rank;
}

/**
 * A group as its most active item, first-started among equals, whose state it shows, and what follows the
 * state: the first-started item's kind and title, the active item's elapsed time, progress, and more.
 */
function groupView(
	group: readonly WorkItemView[],
	now: number,
): { readonly active: WorkItemView; readonly parts: string[] } {
	const byStart = [...group].sort((left, right) => left.item.startedOrdinal - right.item.startedOrdinal);
	const lead = byStart[0]!;
	const active = byStart.reduce((best, view) => (activityRank(view) < activityRank(best) ? view : best));
	const progress = byStart.map(progressText).findLast((text) => text !== undefined);
	const elapsed = workTiming(active, now);
	return {
		active,
		parts: [
			theme.fg("muted", workDisplayText(lead.item.kind)),
			workTitle(lead.item),
			...(elapsed ? [theme.fg("dim", elapsed)] : []),
			...(progress ? [theme.fg("dim", progress)] : []),
			...(group.length > 2 ? [theme.fg("dim", `+${group.length - 1}`)] : []),
		],
	};
}

/** `content` with the inspector's key right-aligned; narrow widths keep the content, not the key. */
function withHint(content: string, width: number): string {
	const hint = keyDisplayText("app.work.open") || "/work";
	const hintWidth = visibleWidth(hint);
	if (width < hintWidth + 16) return truncateToWidth(content, width);
	const shown = truncateToWidth(content, width - hintWidth - 2);
	return `${shown}${" ".repeat(width - visibleWidth(shown) - hintWidth)}${theme.fg("dim", hint)}`;
}

export class WorkStatus implements Component {
	private readonly source: () => WorkSource | undefined;
	private readonly terminalRows: (() => number) | undefined;

	constructor(source: () => WorkSource | undefined, options: WorkStatusOptions = {}) {
		this.source = source;
		this.terminalRows = options.terminalRows;
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		const open = (this.source()?.items() ?? []).filter((view) => view.item.outcome === undefined);
		if (open.length === 0 || width <= 0) return createRenderFrame([]);
		const separator = theme.fg("dim", " · ");
		const title = theme.fg("accent", "Work");
		const now = Date.now();
		const groups = workGroups(open).map((group) => groupView(group, now));
		if (groups.length === 1) {
			const { active, parts } = groups[0]!;
			return createRenderFrame([withHint([title, styledWorkState(active), ...parts].join(separator), width)]);
		}
		const counts = new Map<string, number>();
		for (const { active } of groups) {
			counts.set(workStateLabel(active), (counts.get(workStateLabel(active)) ?? 0) + 1);
		}
		const header = withHint(
			[title, ...[...counts].map(([label, count]) => theme.fg("muted", `${count} ${label}`))].join(separator),
			width,
		);
		const terminalRows = this.terminalRows?.();
		if (terminalRows !== undefined && terminalRows < WORK_LIST_MIN_TERMINAL_ROWS) return createRenderFrame([header]);
		const shown = groups.length > WORK_LIST_MAX_ROWS ? groups.slice(0, WORK_LIST_MAX_ROWS - 1) : groups;
		const rows = shown.map(({ active, parts }) => {
			const state = workStateLabel(active) === "running" ? styledWorkGlyph(active) : styledWorkState(active);
			return truncateToWidth(`  ${[state, ...parts].join(separator)}`, width);
		});
		if (shown.length < groups.length) {
			rows.push(truncateToWidth(theme.fg("dim", `  +${groups.length - shown.length} more`), width));
		}
		return createRenderFrame([header, ...rows]);
	}
}
