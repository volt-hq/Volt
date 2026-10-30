/**
 * A working draft shows as it evolves: beside the conversation in the plan
 * pane where the terminal can split, and as its outcomes above the editor
 * where it cannot. Neither takes focus from the composer.
 */

import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { TuiMainScreen } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VirtualTerminal } from "../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { stopThemeWatcher } from "../../src/core/theme/runtime.ts";
import type { CustomEditor } from "../../src/modes/interactive/components/custom-editor.ts";
import type { PlanInspectorComponent } from "../../src/modes/interactive/components/plan-inspector.ts";
import { createTuiHarness, type TuiHarness } from "./tui-harness.ts";

interface ModeControl {
	renderer: TuiMainScreen;
	defaultEditor: CustomEditor;
	planInspector: PlanInspectorComponent;
}

const harnesses: TuiHarness[] = [];

afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.cleanup();
	stopThemeWatcher();
});

async function start(columns: number, rows: number) {
	const harness = await createTuiHarness({ globalSettings: { theme: "dark", retry: { enabled: false } } });
	harnesses.push(harness);
	const session = harness.startup.session;
	await session.setAgentMode("plan");
	const tui = await harness.startMode({ columns, rows });
	return { harness, session, control: tui.mode as unknown as ModeControl, terminal: tui.terminal };
}

async function screen(control: ModeControl, terminal: VirtualTerminal): Promise<string> {
	control.renderer.requestRender(true);
	await Promise.resolve();
	await terminal.waitForRender();
	return terminal.getViewport().join("\n");
}

/** Hold a run open while `during` drafts and revises the plan, then let it finish. */
async function draftDuringRun(harness: TuiHarness, session: AgentSession, during: () => Promise<void>): Promise<void> {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	harness.faux.setResponses([
		async () => {
			entered.resolve();
			await release.promise;
			return fauxAssistantMessage("Still researching");
		},
	]);
	const run = session.prompt("Plan the change");
	await entered.promise;
	try {
		await during();
	} finally {
		release.resolve();
		await run;
		await session.waitForIdle();
	}
}

async function draftTwoOutcomes(session: AgentSession): Promise<void> {
	const draft = await session.updatePlan({ title: "Live draft", steps: [{ text: "First outcome" }] });
	await session.updatePlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: "Live draft",
		steps: [{ id: draft.steps[0]!.id, text: "First outcome" }, { text: "Second outcome" }],
	});
}

describe("the TUI shows a working draft as it evolves", () => {
	it("in the plan pane where the terminal can split, leaving focus in the composer", async () => {
		const { harness, session, control, terminal } = await start(160, 30);
		expect(await screen(control, terminal)).not.toContain("PLAN · DRAFT");

		await draftDuringRun(harness, session, async () => {
			terminal.sendInput("typing along");
			await draftTwoOutcomes(session);
			const shown = await vi.waitFor(async () => {
				const text = await screen(control, terminal);
				expect(text).toContain("Second outcome");
				return text;
			});
			expect(shown).toContain("PLAN · DRAFT");
			expect(shown).toContain("Live draft");
			expect(shown).toMatch(/1\. (\[ \]|○) First outcome/);
			expect(shown).toContain(`revision ${session.planningState.plan!.revision}`);
		});

		expect(control.planInspector.focused).toBe(false);
		expect(control.renderer.getFocusedComponent()).toBe(control.defaultEditor);
		expect(control.defaultEditor.getText()).toBe("typing along");
	});

	it("as its outcomes above the editor where the terminal cannot split", async () => {
		const { harness, session, control, terminal } = await start(100, 30);
		await draftDuringRun(harness, session, () => draftTwoOutcomes(session));

		const shown = await screen(control, terminal);
		expect(shown).toMatch(/PLAN DRAFT · Live draft +2 proposed steps/);
		expect(shown).toContain("1. First outcome");
		expect(shown).toContain("2. Second outcome");
		expect(shown).toMatch(/revision \d+ · (alt|option)\+p details/);
		expect(control.renderer.getFocusedComponent()).toBe(control.defaultEditor);
	});
});
