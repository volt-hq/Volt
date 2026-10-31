import { type Component, createRenderFrame, type RenderFrame, truncateToWidth, visibleWidth } from "@hansjm10/volt-tui";
import type { AgentMode } from "../../../core/planning.ts";
import { theme } from "../../../core/theme/runtime.ts";
import { usesAsciiPlanMarkers } from "./plan-content.ts";

/**
 * A rule across the transcript where the conversation switched between Build
 * and Plan mode, so its history shows where planning began and ended. Plan
 * mode draws in the theme's `planMode` color, as the composer's border does.
 */
export class AgentModeDividerComponent implements Component {
	private readonly mode: AgentMode;

	constructor(mode: AgentMode) {
		this.mode = mode;
	}

	invalidate(): void {
		// Theme styling is resolved during render.
	}

	render(width: number): RenderFrame {
		if (width <= 0) return createRenderFrame([]);
		const ascii = usesAsciiPlanMarkers();
		const rule = ascii ? "-" : "─";
		const plan = this.mode === "plan";
		const ruleColor = plan ? "planMode" : "borderMuted";
		// Plan mode carries the plan's mark, as its badge does.
		const label = plan
			? `${theme.bold(theme.fg("planMode", `${ascii ? "" : "◆ "}Plan mode`))}${theme.fg("muted", " · agent tools are read-only")}`
			: theme.fg("muted", "Build mode");
		const head = ` ${rule.repeat(2)} `;
		const tail = rule.repeat(Math.max(0, width - 1 - visibleWidth(head) - visibleWidth(label) - 1));
		const line = theme.fg(ruleColor, head) + label + theme.fg(ruleColor, ` ${tail}`);
		return createRenderFrame([truncateToWidth(line, width, "")]);
	}
}
