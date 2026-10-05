/**
 * The work line of the footer: the conversation's open work at a glance.
 * One item shows its state, kind, title, and progress text; several show a
 * count per state. The inspector's key closes the line. Nothing shows while
 * no work is open.
 */

import { type Component, createRenderFrame, type RenderFrame, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import { theme } from "../../../core/theme/runtime.ts";
import { keyDisplayText } from "./keybinding-hints.ts";
import { styledWorkState, type WorkSource, workDisplayText, workStateLabel, workTitle } from "./work-inspector.ts";

export class WorkStatus implements Component {
	private readonly source: () => WorkSource | undefined;

	constructor(source: () => WorkSource | undefined) {
		this.source = source;
	}

	invalidate(): void {}

	render(width: number): RenderFrame {
		const open = (this.source()?.items() ?? []).filter((view) => view.item.outcome === undefined);
		if (open.length === 0 || width <= 0) return createRenderFrame([]);
		const separator = theme.fg("dim", " · ");
		const title = theme.fg("accent", "Work");
		let content: string;
		if (open.length === 1) {
			const view = open[0]!;
			const progress = (view.live?.progress ?? view.item.progress)?.text;
			content = [
				title,
				styledWorkState(view),
				theme.fg("muted", workDisplayText(view.item.kind)),
				workTitle(view.item),
				...(progress ? [theme.fg("dim", workDisplayText(progress).replace(/\s+/g, " ").trim())] : []),
			].join(separator);
		} else {
			const counts = new Map<string, number>();
			for (const view of open) counts.set(workStateLabel(view), (counts.get(workStateLabel(view)) ?? 0) + 1);
			content = [title, ...[...counts].map(([label, count]) => theme.fg("muted", `${count} ${label}`))].join(
				separator,
			);
		}
		const hint = keyDisplayText("app.work.open") || "/work";
		const hintWidth = visibleWidth(hint);
		// Narrow widths keep the work, not the hint.
		if (width < hintWidth + 16) return createRenderFrame([truncateToWidth(content, width)]);
		const shown = truncateToWidth(content, width - hintWidth - 2);
		return createRenderFrame([
			`${shown}${" ".repeat(width - visibleWidth(shown) - hintWidth)}${theme.fg("dim", hint)}`,
		]);
	}
}
