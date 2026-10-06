import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { type Component, setKeybindings, type TuiMainScreen } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import type * as PlanHandoff from "../../../src/core/host/plan-handoff.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import type { PlanState } from "../../../src/core/planning.ts";
import { stopThemeWatcher } from "../../../src/core/theme/runtime.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import type { PlanInspectorComponent } from "../../../src/modes/interactive/components/plan-inspector.ts";
import type { PlanDetailsComponent } from "../../../src/modes/interactive/components/plan-status.ts";
import type { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createTuiHarness, type TuiHarness } from "../tui-harness.ts";

const executePlan = vi.hoisted(() => vi.fn());
vi.mock("../../../src/core/host/plan-handoff.ts", async (importOriginal) => ({
	...(await importOriginal<typeof PlanHandoff>()),
	executePlan,
}));

interface ModeControl {
	renderer: TuiMainScreen;
	defaultEditor: CustomEditor;
	conversationView: unknown;
	planDetails: PlanDetailsComponent | undefined;
	planInspector: PlanInspectorComponent;
	pendingUserInputs: string[];
	isInitialized: boolean;
	activateView(view: unknown, focus: Component | null, forceRender?: boolean): void;
	setupKeyHandlers(): void;
	setupPlanPaneInputRouting(): void;
	setupEditorSubmitHandler(): void;
	refreshPlanningUi(): void;
}

interface Fixture {
	harness: TuiHarness;
	session: AgentSession;
	mode: InteractiveMode;
	control: ModeControl;
	terminal: VirtualTerminal;
	executePlan: ReturnType<typeof vi.fn>;
	draft: PlanState;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const PLAN_TITLE = "Approval checkpoint";
const PLAN_SUMMARY = "Wait for an explicit decision.";

describe("regression #330: ready plans are an explicit approval checkpoint", () => {
	const fixtures: Fixture[] = [];

	afterEach(async () => {
		for (const fixture of fixtures.splice(0)) await fixture.harness.cleanup();
		stopThemeWatcher();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		setKeybindings(new KeybindingsManager());
	});

	async function createFixture(columns: number, rows: number): Promise<Fixture> {
		const harness = await createTuiHarness({ globalSettings: { theme: "dark", retry: { enabled: false } } });
		const session = harness.startup.session;
		await session.setAgentMode("plan");
		const draft = await session.updatePlan({
			title: PLAN_TITLE,
			summary: PLAN_SUMMARY,
			steps: [{ text: "Apply the approved change" }],
		});
		executePlan.mockReset();
		const tui = await harness.startMode({ columns, rows });
		const control = tui.mode as unknown as ModeControl;
		const fixture = { harness, session, mode: tui.mode, control, terminal: tui.terminal, executePlan, draft };
		fixtures.push(fixture);
		return fixture;
	}

	/** Submit the draft while a run is still streaming, as submit_plan does, and hold the run open. */
	async function submitDuringRun({ harness, session, draft }: Fixture): Promise<{ finish(): Promise<void> }> {
		const entered = deferred();
		const release = deferred();
		harness.faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("Plan submitted for approval");
			},
		]);
		const run = session.prompt("Plan the change");
		await entered.promise;
		await session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: PLAN_TITLE,
			summary: PLAN_SUMMARY,
		});
		expect(session.isStreaming).toBe(true);
		expect(session.planningState.plan?.phase).toBe("ready");
		return {
			async finish() {
				release.resolve();
				await run;
				await session.waitForIdle();
			},
		};
	}

	async function screen({ control, terminal }: Fixture): Promise<string> {
		control.renderer.requestRender(true);
		await Promise.resolve();
		await terminal.waitForRender();
		return terminal.getViewport().join("\n");
	}

	it("offers the chooser only after settlement and returns typing to the composer", async () => {
		const fixture = await createFixture(120, 36);
		const { control, terminal, session } = fixture;
		const run = await submitDuringRun(fixture);
		expect(control.planDetails).toBeUndefined();
		expect(control.renderer.getFocusedComponent()).toBe(control.defaultEditor);

		await run.finish();
		expect(control.planDetails).toBeDefined();
		expect(control.renderer.getFocusedComponent()).toBe(control.planDetails);
		expect(await screen(fixture)).toContain("Plan ready — choose the next step");

		terminal.sendInput("l");
		expect(control.planDetails).toBeUndefined();
		expect(control.renderer.getFocusedComponent()).toBe(control.defaultEditor);
		expect(control.defaultEditor.getText()).toBe("l");

		// Dismissal sticks: an unrelated planning refresh does not reopen the chooser.
		control.defaultEditor.setText("");
		control.refreshPlanningUi();
		expect(control.planDetails).toBeUndefined();
		control.defaultEditor.setText("keep this draft");

		terminal.sendInput("\x1bp");
		expect(control.renderer.getFocusedComponent()).toBe(control.planDetails);
		terminal.sendInput("\x1b[C");
		terminal.sendInput("\x1b[C");
		terminal.sendInput("\r");
		await vi.waitFor(() => expect(session.planningState.plan?.phase).toBe("draft"));
		expect(control.planDetails).toBeUndefined();
		expect(control.renderer.getFocusedComponent()).toBe(control.defaultEditor);
		expect(control.defaultEditor.getText()).toBe("keep this draft");
		expect(fixture.executePlan).not.toHaveBeenCalled();
	});

	it("leaves a composer draft in control and keeps a persistent approval cue", async () => {
		const fixture = await createFixture(120, 36);
		const { control, terminal, session } = fixture;
		const run = await submitDuringRun(fixture);
		terminal.sendInput("looks good");
		await run.finish();

		expect(control.planDetails).toBeUndefined();
		expect(control.renderer.getFocusedComponent()).toBe(control.defaultEditor);
		const output = await screen(fixture);
		expect(output).toContain("PLAN READY · APPROVAL NEEDED");
		expect(output).toMatch(/PLAN READY · (Alt|Option)\+P choose next step · Enter send feedback/);

		terminal.sendInput("\r");
		expect(control.pendingUserInputs).toEqual(["looks good"]);
		expect(fixture.executePlan).not.toHaveBeenCalled();
		expect(session.planningState.plan?.phase).toBe("ready");
	});

	it("focuses the split inspector only after settlement and returns typing to the composer", async () => {
		const fixture = await createFixture(160, 30);
		const { control, terminal } = fixture;
		const run = await submitDuringRun(fixture);
		const during = await screen(fixture);
		expect(during).toContain("APPROVAL NEEDED");
		expect(control.planInspector.focused).toBe(false);
		expect(control.renderer.getFocusedComponent()).toBe(control.defaultEditor);

		await run.finish();
		expect(control.planInspector.focused).toBe(true);

		terminal.sendInput("x");
		expect(control.planInspector.focused).toBe(false);
		expect(control.renderer.getFocusedComponent()).toBe(control.defaultEditor);
		expect(control.defaultEditor.getText()).toBe("x");
		expect(fixture.executePlan).not.toHaveBeenCalled();
	});
});
