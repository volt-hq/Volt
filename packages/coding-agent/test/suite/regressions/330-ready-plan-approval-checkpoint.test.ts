import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { type Component, setKeybindings, TuiMainScreen } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import type { PlanState } from "../../../src/core/planning.ts";
import { stopThemeWatcher } from "../../../src/core/theme/runtime.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import type { PlanInspectorComponent } from "../../../src/modes/interactive/components/plan-inspector.ts";
import type { PlanDetailsComponent } from "../../../src/modes/interactive/components/plan-status.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

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
	subscribeToAgent(session: Harness["session"]): void;
	refreshPlanningUi(): void;
}

interface Fixture {
	harness: Harness;
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
		for (const fixture of fixtures.splice(0)) {
			fixture.mode.stop("resume-hint");
			await fixture.harness.cleanupAsync();
		}
		stopThemeWatcher();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		setKeybindings(new KeybindingsManager());
	});

	async function createFixture(columns: number, rows: number): Promise<Fixture> {
		const harness = await createHarness({ settings: { theme: "dark", retry: { enabled: false } } });
		vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.tempDir);
		await harness.session.setAgentMode("plan");
		const draft = harness.session.updatePlan({
			title: PLAN_TITLE,
			summary: PLAN_SUMMARY,
			steps: [{ text: "Apply the approved change" }],
		});
		const executePlan = vi.fn();
		const runtimeHost = {
			session: harness.session,
			setBeforeSessionInvalidate: () => undefined,
			setRebindSession: () => undefined,
			executePlan,
		} as unknown as AgentSessionRuntime;
		const mode = new InteractiveMode(runtimeHost);
		const control = mode as unknown as ModeControl;
		const terminal = new VirtualTerminal(columns, rows);
		control.renderer = new TuiMainScreen(terminal, false, harness.tempDir);
		control.activateView(control.conversationView, control.defaultEditor, false);
		control.setupKeyHandlers();
		control.setupPlanPaneInputRouting();
		control.setupEditorSubmitHandler();
		control.refreshPlanningUi();
		control.renderer.start();
		control.isInitialized = true;
		control.subscribeToAgent(harness.session);
		const fixture = { harness, mode, control, terminal, executePlan, draft };
		fixtures.push(fixture);
		return fixture;
	}

	/** Submit the draft while a run is still streaming, as submit_plan does, and hold the run open. */
	async function submitDuringRun({ harness, draft }: Fixture): Promise<{ finish(): Promise<void> }> {
		const entered = deferred();
		const release = deferred();
		harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("Plan submitted for approval");
			},
		]);
		const run = harness.session.prompt("Plan the change");
		await entered.promise;
		harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: PLAN_TITLE,
			summary: PLAN_SUMMARY,
		});
		expect(harness.session.isStreaming).toBe(true);
		expect(harness.session.planningState.plan?.phase).toBe("ready");
		return {
			async finish() {
				release.resolve();
				await run;
				await harness.session.waitForIdle();
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
		const { control, terminal, harness } = fixture;
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
		await vi.waitFor(() => expect(harness.session.planningState.plan?.phase).toBe("draft"));
		expect(control.planDetails).toBeUndefined();
		expect(control.renderer.getFocusedComponent()).toBe(control.defaultEditor);
		expect(control.defaultEditor.getText()).toBe("keep this draft");
		expect(fixture.executePlan).not.toHaveBeenCalled();
	});

	it("leaves a composer draft in control and keeps a persistent approval cue", async () => {
		const fixture = await createFixture(120, 36);
		const { control, terminal, harness } = fixture;
		const run = await submitDuringRun(fixture);
		terminal.sendInput("looks good");
		await run.finish();

		expect(control.planDetails).toBeUndefined();
		expect(control.renderer.getFocusedComponent()).toBe(control.defaultEditor);
		const output = await screen(fixture);
		expect(output).toContain("PLAN READY · APPROVAL NEEDED");
		expect(output).toMatch(/PLAN READY · Alt\+P choose next step · Enter send feedback/);

		terminal.sendInput("\r");
		expect(control.pendingUserInputs).toEqual(["looks good"]);
		expect(fixture.executePlan).not.toHaveBeenCalled();
		expect(harness.session.planningState.plan?.phase).toBe("ready");
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
