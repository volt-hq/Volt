import { setKeybindings, TuiAltScreen, visibleWidth } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
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

function longPlan(): PlanState {
	return {
		...readyPlan(3),
		title: "A deliberately long Plan title that must wrap instead of disappearing beyond the terminal edge",
		summary:
			"Keep every decision-complete finding visible in compact terminals, including the final summary words SUMMARY_TAIL.",
		steps: [
			{
				id: "step-1",
				text: "Render a long completed checklist item across multiple visual rows without truncating its final token STEP_TAIL",
				status: "completed",
				note: "Verified with deterministic narrow and wide captures NOTE_TAIL",
			},
			{
				id: "step-2",
				text: "Keep the active implementation step visually distinct",
				status: "in_progress",
			},
			{ id: "step-3", text: "Leave remaining work visible", status: "pending" },
		],
	};
}

function finishedPlan(phase: "completed" | "handed_off", stepCount = 12): PlanState {
	const plan = readyPlan(stepCount);
	return {
		...plan,
		phase,
		steps: plan.steps.map((step) => ({ ...step, status: "completed" as const })),
		execution: {
			id: "execution-1",
			approvedRevision: plan.revision,
			strategy: "new_session",
			sourceSessionId: "source-session",
			targetSessionId: "target-session",
		},
	};
}

function plain(lines: readonly string[]): string {
	return lines.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

function normalized(lines: readonly string[]): string {
	return plain(lines).replace(/\s+/g, " ");
}

function createDetails(
	plan: PlanState,
	widthRows = 24,
	onAction: (action: PlanDetailsAction) => void = () => undefined,
) {
	return new PlanDetailsComponent({
		plan,
		getTerminalRows: () => widthRows,
		onAction,
		onClose: () => undefined,
		requestRender: () => undefined,
	});
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Plan TUI components", () => {
	it("shows the strip only once there is a plan and bounds it at narrow widths", () => {
		initTheme("dark");
		expect(new PlanStatusComponent({ mode: "build", plan: null }).render(80).lines).toEqual([]);
		// The composer's border and label carry Plan mode before a plan exists.
		expect(new PlanStatusComponent({ mode: "plan", plan: null }).render(80).lines).toEqual([]);

		const active = { ...readyPlan(), phase: "active" as const };
		const rendered = new PlanStatusComponent({ mode: "build", plan: active }).render(80).lines;
		expect(rendered).toHaveLength(2);
		expect(plain(rendered)).toMatch(/PLAN · EXECUTING {2}Native Plan Mode +\S+ 4\/12\n/);
		// The item execution is on, numbered as the cards number it.
		expect(plain(rendered)).toMatch(/^ {2}(\[>\]|●) 5 Plan step 5$/m);
		for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	it("names a ready plan and its size on one row at every width, leaving its keys to the composer", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager({ "app.plan.togglePane": "alt+x" }));
		try {
			const status = new PlanStatusComponent({ mode: "plan", plan: readyPlan() });
			for (const width of [60, 80, 120]) {
				const rendered = status.render(width).lines;
				expect(rendered).toHaveLength(1);
				const text = plain(rendered);
				expect(text).toMatch(/PLAN · READY {2}Native Plan Mode +12 steps$/);
				expect(text).not.toContain("choose next step");
				expect(visibleWidth(rendered[0]!)).toBeLessThanOrEqual(width);
			}
			// A long title gives way to the size.
			const long = plain(new PlanStatusComponent({ mode: "plan", plan: longPlan() }).render(60).lines);
			expect(long).toMatch(/^(◆ )?PLAN · READY {2}A deliberately.*… +3 steps$/);
		} finally {
			setKeybindings(new KeybindingsManager());
		}
	});

	it("lists a working draft's outcomes as many as the terminal's height allows", () => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager({ "app.plan.togglePane": "alt+x" }));
		try {
			const draft = { ...readyPlan(), phase: "draft" as const };
			let rows = 40;
			const status = new PlanStatusComponent({ mode: "plan", plan: draft }, { getTerminalRows: () => rows });
			for (const width of [60, 120]) {
				const rendered = status.render(width).lines;
				const text = plain(rendered);
				expect(text).toMatch(/PLAN · DRAFT {2}Native Plan Mode +12 steps\n/);
				expect(text).toMatch(/^ {2}(\[x\]|✓) 1 Plan step 1$/m);
				expect(text).toMatch(/^ {2}(\[>\]|●) 5 Plan step 5$/m);
				expect(text).not.toContain("Plan step 6");
				expect(text).toMatch(/^ {2}… 7 more · revision 4 · (alt|option)\+x details$/m);
				for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}

			// A short terminal lists fewer; a draft that fits lists them all.
			rows = 24;
			expect(status.render(120).lines).toHaveLength(5);
			const small = new PlanStatusComponent(
				{ mode: "plan", plan: { ...readyPlan(2), phase: "draft" } },
				{ getTerminalRows: () => 24 },
			);
			const text = plain(small.render(120).lines);
			expect(text).toContain("2 Plan step 2");
			expect(text).not.toContain("more");
			expect(text).toMatch(/^ {2}revision 4 · (alt|option)\+x details$/m);
		} finally {
			setKeybindings(new KeybindingsManager());
		}
	});

	it("counts grouped draft outcomes and executable tasks", () => {
		initTheme("dark");
		const draft = { ...readyPlan(1), phase: "draft" as const };
		draft.steps = [
			{
				id: "group-1",
				text: "Implement hierarchy",
				status: "pending",
				substeps: [
					{ id: "substep-1", text: "Persist hierarchy", status: "pending" },
					{ id: "substep-2", text: "Render hierarchy", status: "pending" },
				],
			},
		];
		const rendered = plain(new PlanStatusComponent({ mode: "plan", plan: draft }).render(120).lines);
		expect(rendered).toContain("1 outcome · 2 tasks");
		// An outcome keeps its task count beside its text, as the cards give it, even where the text gives way.
		expect(rendered).toContain("1 Implement hierarchy  0/2 tasks");
		draft.steps[0]!.text = "Implement a hierarchy whose outcome text is far too long to fit beside its task count";
		expect(plain(new PlanStatusComponent({ mode: "plan", plan: draft }).render(48).lines)).toMatch(
			/1 Implement a hierarchy.*… {2}0\/2 tasks\n/,
		);
	});

	it("renders grouped draft outcomes and substeps in plan details", () => {
		initTheme("dark");
		const grouped = readyPlan(1);
		grouped.phase = "draft";
		grouped.steps = [
			{
				id: "group-1",
				text: "Implement hierarchy",
				status: "in_progress",
				substeps: [
					{ id: "substep-1", text: "Persist hierarchy", status: "completed", note: "Stored" },
					{ id: "substep-2", text: "Render hierarchy", status: "in_progress" },
				],
			},
		];
		const rendered = normalized(createDetails(grouped, 30).render(80).lines);
		expect(rendered).toContain("1 Implement hierarchy 1/2 tasks");
		expect(rendered).toContain("1.1 Persist hierarchy");
		expect(rendered).toMatch(/(↳|->) Stored/);
		expect(rendered).toContain("1.2 Render hierarchy");
	});

	it("wraps all authored plan content at compact and wide widths", () => {
		initTheme("dark");
		for (const width of [80, 120]) {
			const details = createDetails(longPlan(), 60);
			const rendered = details.render(width).lines;
			const text = normalized(rendered);
			expect(text).toContain("SUMMARY_TAIL");
			expect(text).toContain("STEP_TAIL");
			expect(text).toContain("NOTE_TAIL");
			expect(text).toContain("Execute Plan");
			expect(text).toContain("Execute Plan & Clear Context");
			expect(text).toContain("Change Plan");
			for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("uses terminal height for the rendered-row viewport and reports its position", () => {
		initTheme("light");
		const details = createDetails(readyPlan(40), 36);
		const rendered = plain(details.render(120).lines);
		expect(rendered).toContain("rows 1–23/46");
		expect(rendered).toContain("Plan step 17");
		expect(rendered).not.toContain("Plan step 18");
	});

	it("scrolls by rendered visual rows rather than logical checklist items", () => {
		initTheme("light");
		let renders = 0;
		const plan = readyPlan(30);
		plan.summary = "A summary that occupies the first rendered body row.";
		plan.steps[0]!.text =
			"A first checklist item that wraps over several visual rows at compact width and therefore consumes viewport space before later steps.";
		const details = new PlanDetailsComponent({
			plan,
			getTerminalRows: () => 24,
			onAction: () => undefined,
			onClose: () => undefined,
			requestRender: () => {
				renders += 1;
			},
		});
		const before = plain(details.render(80).lines);
		expect(before).toContain("rows 1–11/");
		expect(before).toContain("first checklist item");

		details.handleInput("\u001b[6~");
		const after = plain(details.render(80).lines);
		expect(renders).toBe(1);
		expect(after).toContain("rows 12–22/");
		expect(after).not.toContain("A summary that occupies");
		// The wrapped first item spends two rows, so the page opens at the fifth.
		expect(after).toMatch(/ 5 {2}Plan step 5$/m);
		expect(after).not.toMatch(/ 4 {2}Plan step 4$/m);
	});

	it("settles fullscreen plan metadata before display, resize, and body scrolling", async () => {
		initTheme("dark");
		for (const seedRegularGeometry of [false, true]) {
			const terminal = new VirtualTerminal(80, 16);
			const details = createDetails(readyPlan(40), 16);
			if (seedRegularGeometry) details.render(80).lines;
			details.setFullscreenActive(true);
			const tui = new TuiAltScreen(terminal, false, "/tmp", { mouse: false });
			tui.addChild(details);
			tui.setLayoutRoot(details.getFullscreenLayout());
			tui.setFocus(details);
			tui.start();
			try {
				await terminal.waitForRender();
				const before = plain(terminal.getViewport());
				expect(before).toContain("Native Plan Mode");
				expect(before).toContain("rows 1–10/46");
				expect(before).toContain("Execute Plan");
				expect(before).toContain("Plan step 1");

				terminal.resize(80, 20);
				await terminal.waitForRender();
				const resized = plain(terminal.getViewport());
				expect(resized).toContain("rows 1–14/46");
				expect(resized).toContain("Native Plan Mode");
				expect(resized).toContain("Execute Plan");

				terminal.sendInput("\u001b[6~");
				await terminal.waitForRender();
				const after = plain(terminal.getViewport());
				expect(after).toContain("rows 11–24/46");
				// The badge and meta stay fixed while the body, title included, scrolls.
				expect(after).toContain("PLAN · READY");
				expect(after).not.toContain("Native Plan Mode");
				expect(after).toContain("Execute Plan");
				expect(after).not.toMatch(/Plan step 1\s*$/m);
			} finally {
				tui.stop({ preserveScreen: true });
			}
		}
	});

	it("names the phase above the plan and offers its actions as one row of buttons at every width", () => {
		initTheme("dark");
		for (const width of [80, 120]) {
			const rendered = plain(createDetails(readyPlan(), 36).render(width).lines);
			// The badge rides the top rule, as the composer's label rides its border.
			expect(rendered).toMatch(/^(--|──) (◆ )?PLAN · READY (-|─)+$/m);
			expect(rendered).toMatch(/^ 12 steps *$/m);
			expect(rendered).toMatch(/\[ Execute Plan \] +Execute Plan & Clear Context +Change Plan/);
			expect(rendered).toMatch(
				/←\/→ choose {2}enter confirm {2}up\/down scroll {2}pageUp\/pageDown page {2}escape back/,
			);
		}
		// Too narrow for one row, the buttons wrap; moving the selection does not reflow them.
		const narrow = createDetails(readyPlan(), 36);
		const before = plain(narrow.render(40).lines);
		expect(before).toMatch(/\[ Execute Plan \]\n +Execute Plan & Clear Context *\n +Change Plan/);
		narrow.handleInput("\u001b[C");
		const after = plain(narrow.render(40).lines);
		expect(after).toMatch(/Execute Plan *\n \[ Execute Plan & Clear Context \]\n +Change Plan/);
		expect(after.split("\n")).toHaveLength(before.split("\n").length);

		const completed = plain(createDetails(finishedPlan("completed"), 36).render(120).lines);
		expect(completed).toContain("PLAN · COMPLETE");
		expect(completed).toMatch(/^ (#|█)+ 12\/12/m);
		expect(completed).not.toContain("READY");
	});

	it("scrolls a ready plan with the vertical keys while the horizontal keys choose its action", () => {
		initTheme("dark");
		const actions: PlanDetailsAction[] = [];
		const details = createDetails(readyPlan(40), 24, (action) => actions.push(action));
		expect(plain(details.render(80).lines)).toContain("rows 1–");
		details.handleInput("\u001b[B");
		details.handleInput("\u001b[B");
		expect(plain(details.render(80).lines)).toContain("rows 3–");
		details.handleInput("\u001b[A");
		expect(plain(details.render(80).lines)).toContain("rows 2–");
		details.handleInput("\r");
		expect(actions).toEqual(["retain_context"]);
	});

	it("hands typed and pasted text to the composer instead of confirming a ready action", () => {
		initTheme("dark");
		const actions: PlanDetailsAction[] = [];
		const typed: string[] = [];
		const options = {
			getTerminalRows: () => 36,
			onAction: (action: PlanDetailsAction) => actions.push(action),
			onClose: () => undefined,
			onTextInput: (data: string) => typed.push(data),
			requestRender: () => undefined,
		};
		const details = new PlanDetailsComponent({ ...options, plan: readyPlan() });
		for (const data of ["l", "é", "\x1b[108u", "\x1b[200~pasted\x1b[201~"]) details.handleInput(data);
		expect(typed).toEqual(["l", "é", "\x1b[108u", "\x1b[200~pasted\x1b[201~"]);
		expect(actions).toEqual([]);

		details.handleInput("\x1b[C");
		details.handleInput("\x01");
		expect(typed).toHaveLength(4);
		details.handleInput("\r");
		expect(actions).toEqual(["new_session"]);

		const finished = new PlanDetailsComponent({ ...options, plan: finishedPlan("completed") });
		finished.handleInput("x");
		expect(typed).toHaveLength(4);
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

	it("scrolls a completed plan with the vertical keys and closes it with Enter", () => {
		initTheme("dark");
		const actions: PlanDetailsAction[] = [];
		const details = createDetails(finishedPlan("completed", 40), 24, (action) => actions.push(action));
		for (const width of [80, 120]) {
			const rendered = plain(details.render(width).lines);
			expect(rendered).toContain("Close Plan");
			expect(rendered).toContain("close plan");
			expect(rendered).not.toContain("Execute Plan");
		}
		for (const width of [100, 120]) {
			expect(plain(details.render(width).lines)).toMatch(/^ enter close plan {2}up\/down scroll .*escape back$/m);
		}

		expect(plain(details.render(80).lines)).toContain("rows 1–");
		details.handleInput("\u001b[B");
		expect(plain(details.render(80).lines)).toContain("rows 2–");
		details.handleInput("\u001b[A");
		expect(plain(details.render(80).lines)).toContain("rows 1–");
		expect(actions).toEqual([]);

		details.handleInput("\r");
		expect(actions).toEqual(["close"]);
	});

	it("selects Close Plan when a ready plan in Plan Details completes", () => {
		initTheme("dark");
		const actions: PlanDetailsAction[] = [];
		const details = createDetails(readyPlan(), 36, (action) => actions.push(action));
		details.handleInput("\u001b[C");
		details.handleInput("\u001b[C");
		details.setPlan(finishedPlan("handed_off"));
		details.handleInput("\r");
		expect(actions).toEqual(["close"]);
	});

	it("says how to close a finished plan at every width", () => {
		initTheme("dark");
		const completed = new PlanStatusComponent({ mode: "build", plan: finishedPlan("completed") });
		for (const width of [80, 120]) {
			const lines = completed.render(width).lines;
			expect(lines).toHaveLength(2);
			expect(plain(lines)).toMatch(/PLAN · COMPLETE {2}Native Plan Mode +\S+ 12\/12\n/);
			expect(plain(lines)).toMatch(/^ {2}All steps complete · \/plan-close to close$/m);
		}

		const handedOff = new PlanStatusComponent({ mode: "build", plan: finishedPlan("handed_off") });
		expect(plain(handedOff.render(80).lines)).toContain("Executing in session target-session · /plan-close to close");
	});

	it("renders Unicode markers normally and ASCII markers when requested", () => {
		initTheme("dark");
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("TERM_PROGRAM", "iTerm.app");
		vi.stubEnv("VOLT_ASCII", "0");
		const unicode = plain(createDetails(longPlan(), 60).render(120).lines);
		expect(unicode).toContain("✓");
		expect(unicode).toContain("→");
		expect(unicode).toContain("○");

		vi.stubEnv("VOLT_ASCII", "1");
		const ascii = plain(createDetails(longPlan(), 60).render(120).lines);
		expect(ascii).toContain("[x]");
		expect(ascii).toContain("[>]");
		expect(ascii).toContain("[ ]");
	});
});
