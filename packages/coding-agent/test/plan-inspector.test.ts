import { setKeybindings, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { PlanningState, PlanPhase, PlanState } from "../src/core/planning.ts";
import { initTheme } from "../src/core/theme/runtime.ts";
import { PlanInspectorComponent } from "../src/modes/interactive/components/plan-inspector.ts";
import type { PlanDetailsAction } from "../src/modes/interactive/components/plan-status.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function planning(phase: PlanPhase, stepCount = 3): PlanningState {
	const execution =
		phase === "active" || phase === "completed" || phase === "handed_off"
			? {
					id: "execution-1",
					approvedRevision: 4,
					strategy: "new_session" as const,
					sourceSessionId: "source-session",
					targetSessionId: "target-session",
				}
			: undefined;
	const plan: PlanState = {
		id: "plan-1",
		revision: 4,
		phase,
		title: `${phase} lifecycle title`,
		summary: `Canonical ${phase} lifecycle summary`,
		steps: Array.from({ length: stepCount }, (_, index) => ({
			id: `step-${index + 1}`,
			text: `Lifecycle step ${index + 1}`,
			status: index === 0 ? ("completed" as const) : index === 1 ? ("in_progress" as const) : ("pending" as const),
			...(index === 0 ? { note: "Observed verification note" } : {}),
		})),
		...(execution ? { execution } : {}),
	};
	return { mode: phase === "draft" || phase === "ready" ? "plan" : "build", plan };
}

function createInspector(
	state: PlanningState,
	options: {
		actions?: PlanDetailsAction[];
		onReturnFocus?: () => void;
		onToggleFocus?: () => void;
		requestRender?: () => void;
	} = {},
): PlanInspectorComponent {
	const inspector = new PlanInspectorComponent({
		planning: state,
		onAction: (action) => options.actions?.push(action),
		onReturnFocus: options.onReturnFocus ?? (() => undefined),
		onToggleFocus: options.onToggleFocus ?? (() => undefined),
		requestRender: options.requestRender ?? (() => undefined),
	});
	inspector.setViewportRows(22);
	return inspector;
}

function text(inspector: PlanInspectorComponent, width = 60): string {
	return inspector.render(width).lines.map(stripAnsi).join("\n");
}

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("PlanInspectorComponent", () => {
	it("renders Plan mode before its first draft from PlanningState", () => {
		const output = text(createInspector({ mode: "plan", plan: null }));
		expect(output.split("\n")[0]).toMatch(/^ (◆ )?PLAN +/);
		expect(output).not.toContain("DRAFT");
		expect(output).toContain("No plan yet");
		expect(output.replace(/\s+/g, " ")).toContain("initial research orientation");
	});

	it("renders every canonical lifecycle without proof-of-concept controls", () => {
		for (const phase of ["draft", "ready", "active", "completed", "handed_off"] as const) {
			const output = text(createInspector(planning(phase)));
			expect(output).toContain(`${phase} lifecycle title`);
			expect(output).toContain(`Canonical ${phase} lifecycle summary`);
			// Items read as the cards draw them: glyph, checklist number, text; notes below.
			expect(output).toMatch(/^ (\[x\]|✓) 1 Lifecycle step 1$/m);
			expect(output).toMatch(/^ {5,}(->|↳) Observed verification note$/m);
			expect(output).not.toContain("Elapsed");
			expect(output).not.toContain("Pause");
			expect(output).not.toContain("Maximize");
			if (phase === "active") expect(output).toContain("PLAN · EXECUTING");
			if (phase === "completed") expect(output).toContain("PLAN · COMPLETE");
			if (phase === "handed_off") expect(output).toContain("Executing in session target-session");
		}
	});

	it("shows progress and focused state while bounding every line", () => {
		const inspector = createInspector(planning("active"));
		const unfocused = inspector.render(48).lines.map(stripAnsi);
		expect(unfocused[0]).toMatch(/(alt|option)\+p focus$/);
		inspector.focused = true;
		const lines = inspector.render(48).lines;
		const output = lines.map(stripAnsi).join("\n");
		// Focused, the header says how to leave; the progress bar and the cards' heading carry progress.
		expect(output.split("\n")[0]).toMatch(/escape back$/);
		expect(output.split("\n")[1]).toMatch(/^ (#|█)+(-|░)+ 1\/3/);
		expect(output).toContain("Checklist · 1/3 complete");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(48);
	});

	it("expands every group for review and only the active group during execution", () => {
		const state = planning("active", 2);
		state.plan!.steps = [
			{
				id: "group-complete",
				text: "Completed outcome",
				status: "completed",
				substeps: [{ id: "completed-child", text: "Hidden completed child", status: "completed" }],
			},
			{
				id: "group-partial",
				text: "Earlier partial outcome",
				status: "in_progress",
				substeps: [
					{ id: "partial-complete", text: "Hidden partial completed child", status: "completed" },
					{ id: "partial-pending", text: "Hidden partial pending child", status: "pending" },
				],
			},
			{
				id: "group-active",
				text: "Active outcome",
				status: "in_progress",
				substeps: [
					{ id: "active-child", text: "Visible active child", status: "in_progress" },
					{ id: "pending-child", text: "Visible pending child", status: "pending" },
				],
			},
		];
		const inspector = createInspector(state);
		const executing = text(inspector);
		expect(executing).toContain("Completed outcome");
		expect(executing).not.toContain("Hidden completed child");
		expect(executing).not.toContain("Hidden partial completed child");
		expect(executing).not.toContain("Hidden partial pending child");
		expect(executing).toContain("Visible active child");
		expect(executing).toContain("Visible pending child");

		state.mode = "plan";
		state.plan!.phase = "ready";
		delete state.plan!.execution;
		inspector.setPlanning(state);
		const ready = text(inspector);
		expect(ready).toContain("Hidden completed child");
		expect(ready).toContain("Hidden partial pending child");
		expect(ready).toContain("Visible active child");

		// A working draft is reviewed as it evolves, so it shows its whole hierarchy too.
		state.plan!.phase = "draft";
		inspector.setPlanning(state);
		const draft = text(inspector);
		expect(draft).toContain("Hidden completed child");
		expect(draft).toContain("Hidden partial pending child");
		expect(draft).toContain("3 outcomes · 5 tasks · revision 4");
	});

	it("marks a ready plan as waiting for a decision", () => {
		setKeybindings(new KeybindingsManager({ "app.plan.togglePane": "alt+x" }));
		try {
			const inspector = createInspector(planning("ready"));
			const lines = inspector.render(48).lines;
			const header = stripAnsi(lines[0] ?? "");
			expect(header).toContain("PLAN · READY");
			expect(header).toMatch(/(alt|option)\+x choose$/);
			// Before approval the plan has a size, not progress.
			expect(stripAnsi(lines[1] ?? "")).toMatch(/^ 3 steps *$/);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(48);

			inspector.focused = true;
			expect(stripAnsi(inspector.render(60).lines[0] ?? "")).toMatch(/PLAN · READY.*escape back$/);

			const active = stripAnsi(createInspector(planning("active")).render(60).lines[0] ?? "");
			expect(active).toContain("PLAN · EXECUTING");
			expect(active).toMatch(/(alt|option)\+x focus$/);
		} finally {
			setKeybindings(new KeybindingsManager());
		}
	});

	it("hands typed and pasted text to the composer while a ready plan is focused", () => {
		const actions: PlanDetailsAction[] = [];
		const typed: string[] = [];
		const create = (phase: PlanPhase) =>
			new PlanInspectorComponent({
				planning: planning(phase),
				onAction: (action) => actions.push(action),
				onReturnFocus: () => undefined,
				onToggleFocus: () => undefined,
				onTextInput: (data) => typed.push(data),
				requestRender: () => undefined,
			});
		const inspector = create("ready");
		inspector.setViewportRows(22);
		inspector.render(60);
		for (const data of ["o", "\x1b[111u", "\x1b[200~pasted\x1b[201~"]) inspector.handleInput(data);
		expect(typed).toEqual(["o", "\x1b[111u", "\x1b[200~pasted\x1b[201~"]);
		expect(actions).toEqual([]);
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context"]);

		for (const phase of ["draft", "active", "completed"] as const) create(phase).handleInput("x");
		expect(typed).toHaveLength(3);
	});

	it("routes ready actions without changing planning state", () => {
		const actions: PlanDetailsAction[] = [];
		const state = planning("ready");
		const inspector = createInspector(state, { actions });
		inspector.render(60).lines;
		inspector.handleInput("\r");
		inspector.handleInput("\x1b[C");
		inspector.render(60).lines;
		inspector.handleInput("\r");
		inspector.handleInput("\x1b[C");
		inspector.render(60).lines;
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context", "new_session", "change"]);
		expect(state.plan?.phase).toBe("ready");
	});

	it("keeps the selected ready action visible before accepting confirmation", () => {
		const actions: PlanDetailsAction[] = [];
		const inspector = createInspector(planning("ready"), { actions });
		inspector.setViewportRows(7);
		let output = text(inspector, 48);
		expect(output).toContain("[ Execute Plan ]");
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context"]);

		inspector.handleInput("\x1b[C");
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context"]);
		output = text(inspector, 48);
		expect(output).toContain("[ Execute Plan & Clear Context ]");
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context", "new_session"]);

		inspector.setViewportRows(3);
		text(inspector, 48);
		inspector.handleInput("\r");
		expect(actions).toEqual(["retain_context", "new_session"]);
	});

	it("lays ready actions out as buttons that wrap in a narrow pane and keeps the selected one visible", () => {
		const wide = createInspector(planning("ready"));
		const wideLines = wide.render(72).lines.map(stripAnsi);
		const buttonRow = wideLines.find((line) => line.includes("[ Execute Plan ]"));
		expect(buttonRow).toContain("Execute Plan & Clear Context");
		expect(buttonRow).toContain("Change Plan");
		expect(wideLines.at(-1)).toMatch(/←\/→ choose {2}enter confirm {2}up\/down scroll/);

		const actions: PlanDetailsAction[] = [];
		const narrow = createInspector(planning("ready"), { actions });
		narrow.handleInput("\x1b[C");
		narrow.handleInput("\x1b[C");
		// Room for one button row and the hint: the selected button's row shows, the others do not.
		narrow.setViewportRows(5);
		const output = text(narrow, 48);
		expect(output).toContain("[ Change Plan ]");
		expect(output).not.toContain("Execute Plan & Clear Context");
		expect(output).toContain("choose");
		narrow.handleInput("\r");
		expect(actions).toEqual(["change"]);
	});

	it("keeps an item's detail whole: beside its text where it fits, else below it", () => {
		const state = planning("ready", 1);
		state.plan!.steps = [
			{
				id: "group",
				text: "Integrate the hierarchical plan presentation",
				status: "pending",
				substeps: [
					{ id: "a", text: "First task", status: "pending" },
					{ id: "b", text: "Second task", status: "pending" },
				],
			},
		];
		const wide = text(createInspector(state), 72);
		expect(wide).toMatch(/1 Integrate the hierarchical plan presentation {2}0\/2 tasks$/m);
		// Too narrow for both, the count moves to a line of its own under the text, never split.
		const narrow = text(createInspector(state), 52);
		expect(narrow).toMatch(/1 Integrate the hierarchical plan presentation\n {5,}0\/2 tasks$/m);
	});

	it("offers Close Plan only for finished plans and confirms it with Enter", () => {
		for (const phase of ["completed", "handed_off"] as const) {
			const actions: PlanDetailsAction[] = [];
			const inspector = createInspector(planning(phase), { actions });
			const output = text(inspector);
			expect(output).toContain("[ Close Plan ]");
			expect(output).toContain("close plan");
			expect(output).not.toContain("choose");
			inspector.handleInput("\x1b[C");
			inspector.handleInput("\x1b[D");
			expect(text(inspector)).toContain("[ Close Plan ]");
			inspector.handleInput("\r");
			expect(actions).toEqual(["close"]);
		}

		for (const phase of ["draft", "active"] as const) {
			const actions: PlanDetailsAction[] = [];
			const inspector = createInspector(planning(phase), { actions });
			const output = text(inspector);
			expect(output).not.toContain("Close Plan");
			expect(output).not.toContain("Execute Plan");
			inspector.handleInput("\r");
			expect(actions).toEqual([]);
		}
	});

	it("selects Close Plan when a ready plan with another action selected completes", () => {
		const actions: PlanDetailsAction[] = [];
		const inspector = createInspector(planning("ready"), { actions });
		inspector.handleInput("\x1b[C");
		inspector.handleInput("\x1b[C");
		expect(text(inspector)).toContain("[ Change Plan ]");

		inspector.setPlanning(planning("completed"));
		const output = text(inspector);
		expect(output).toContain("[ Close Plan ]");
		expect(output).not.toContain("Change Plan");
		inspector.handleInput("\r");
		expect(actions).toEqual(["close"]);
	});

	it("ignores Close Plan confirmation while the action footer is hidden", () => {
		const actions: PlanDetailsAction[] = [];
		const inspector = createInspector(planning("completed"), { actions });
		inspector.setViewportRows(2);
		expect(text(inspector, 48)).not.toContain("Close Plan");
		inspector.handleInput("\r");
		expect(actions).toEqual([]);

		inspector.setViewportRows(4);
		expect(text(inspector, 48)).toContain("[ Close Plan ]");
		inspector.handleInput("\r");
		expect(actions).toEqual(["close"]);
	});

	it("scrolls long wrapped content and reports page position", () => {
		const state = planning("active", 30);
		state.plan!.steps[0]!.text =
			"A very long completed lifecycle step that wraps across several rows before the remaining checklist can be shown";
		const inspector = createInspector(state);
		inspector.setViewportRows(16);
		const before = text(inspector, 48);
		expect(before).toContain("rows 1–");
		expect(before).toContain("very long completed lifecycle");
		inspector.handleInput("\x1b[6~");
		const after = text(inspector, 48);
		expect(after).toMatch(/rows (?!1–)\d+–/);
		expect(after).not.toContain("active lifecycle title");
	});

	it("routes focus controls through configurable keybindings", () => {
		const toggled = vi.fn();
		const returned = vi.fn();
		setKeybindings(new KeybindingsManager({ "app.plan.togglePane": "alt+x" }));
		try {
			const inspector = createInspector(planning("active"), {
				onToggleFocus: toggled,
				onReturnFocus: returned,
			});
			inspector.handleInput("\x1bx");
			inspector.handleInput("\x1b");
			expect(toggled).toHaveBeenCalledTimes(1);
			expect(returned).toHaveBeenCalledTimes(1);
		} finally {
			setKeybindings(new KeybindingsManager());
		}
	});

	it("uses ASCII status markers when requested", () => {
		vi.stubEnv("VOLT_ASCII", "1");
		const output = text(createInspector(planning("active")));
		expect(output).toContain("[x]");
		expect(output).toContain("[>]");
		expect(output).toContain("[ ]");
	});
});
