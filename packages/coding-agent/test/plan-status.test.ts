import { describe, expect, it } from "vitest";
import type { PlanState } from "../src/core/planning.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import {
	type PlanDetailsAction,
	PlanDetailsComponent,
	PlanStatusComponent,
} from "../src/modes/interactive/components/plan-status.ts";

function readyPlan(stepCount = 12): PlanState {
	return {
		id: "plan-1",
		revision: 4,
		phase: "ready",
		title: "Native Plan Mode",
		summary: "Keep planning durable and responsive.",
		steps: Array.from({ length: stepCount }, (_, index) => ({
			id: `step-${index + 1}`,
			text: `Plan step ${index + 1}`,
			status: index < 4 ? ("completed" as const) : index === 4 ? ("in_progress" as const) : ("pending" as const),
		})),
	};
}

function plain(lines: string[]): string {
	return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

describe("Plan TUI components", () => {
	it("hides an empty Build status and bounds the strip at narrow widths", () => {
		initTheme("dark");
		expect(new PlanStatusComponent({ mode: "build", plan: null }).render(80)).toEqual([]);

		const rendered = new PlanStatusComponent({ mode: "plan", plan: readyPlan() }).render(80);
		expect(rendered).toHaveLength(1);
		expect(plain(rendered)).toContain("PLAN READY");
		expect(plain(rendered)).toContain("4/12 · 33%");
	});

	it("renders all three ready actions verbatim in compact and full layouts", () => {
		initTheme("dark");
		for (const width of [80, 120]) {
			const details = new PlanDetailsComponent({
				plan: readyPlan(),
				getTerminalRows: () => 24,
				onAction: () => undefined,
				onClose: () => undefined,
				requestRender: () => undefined,
			});
			const rendered = plain(details.render(width));
			expect(rendered).toContain("Execute Plan");
			expect(rendered).toContain("Execute Plan & Clear Context");
			expect(rendered).toContain("Change Plan");
			expect(details.render(width).length).toBeLessThanOrEqual(width < 100 ? 10 : 17);
		}
	});

	it("moves through ready actions and confirms the exact selected strategy", () => {
		initTheme("dark");
		const actions: PlanDetailsAction[] = [];
		let renders = 0;
		const details = new PlanDetailsComponent({
			plan: readyPlan(),
			getTerminalRows: () => 36,
			onAction: (action) => actions.push(action),
			onClose: () => undefined,
			requestRender: () => {
				renders += 1;
			},
		});

		details.handleInput("\u001b[C");
		details.handleInput("\r");
		details.handleInput("\u001b[C");
		details.handleInput("\r");

		expect(renders).toBe(2);
		expect(actions).toEqual(["new_session", "change"]);
	});

	it("keeps long plans within the terminal-derived viewport and scrolls", () => {
		initTheme("light");
		let renders = 0;
		const details = new PlanDetailsComponent({
			plan: readyPlan(64),
			getTerminalRows: () => 24,
			onAction: () => undefined,
			onClose: () => undefined,
			requestRender: () => {
				renders += 1;
			},
		});
		const before = plain(details.render(120));
		expect(before).toContain("Plan step 1");
		expect(before).not.toContain("Plan step 64");

		details.handleInput("\u001b[6~");
		const after = plain(details.render(120));
		expect(renders).toBe(1);
		expect(after).not.toMatch(/Plan step 1(?:\n|$)/);
		expect(after).toContain("Plan step 11");
	});
});
