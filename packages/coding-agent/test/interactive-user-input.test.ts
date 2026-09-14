import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { type Component, type Container, Text, type TUI, type TuiMode } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { ExtensionUIContext } from "../src/core/extensions/types.ts";
import { stopThemeWatcher } from "../src/core/theme/runtime.ts";
import { createRequestUserInputToolDefinition } from "../src/core/tools/request-user-input.ts";
import { BackgroundJobsInspector } from "../src/modes/interactive/components/background-jobs.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import type { PlanInspectorComponent } from "../src/modes/interactive/components/plan-inspector.ts";
import { UserInputDialog } from "../src/modes/interactive/components/user-input-dialog.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type View = { regularComponents: readonly Component[]; fullscreenRoot: Component };
type TestAccess = {
	renderer: ReturnType<typeof createInteractiveTui>;
	ui: TUI;
	editor: CustomEditor;
	conversationView: View;
	activeView: View;
	editorContainer: Container;
	planInspector: PlanInspectorComponent;
	pendingUserInputs: string[];
	isInitialized: boolean;
	setupKeyHandlers(): void;
	setupPlanPaneInputRouting(): void;
	setupEditorSubmitHandler(): void;
	renderWidgets(): void;
	bindCurrentSessionExtensions(session: AgentSession): Promise<void>;
	subscribeToAgent(session: AgentSession): void;
	activateView(view: View, focus: Component, forceRender?: boolean): void;
	showExtensionCustom: ExtensionUIContext["custom"];
};

const request = {
	questions: [
		{
			id: "storage",
			header: "Storage",
			question: "Where should the search index live?",
			options: [
				{ label: "Local SQLite (Recommended)", description: "Fast offline search beside the project." },
				{ label: "In memory", description: "Rebuild the index at startup." },
			],
		},
		{
			id: "scope",
			header: "Scope",
			question: "Which files should be searchable?",
			options: [
				{ label: "Project files", description: "Respect ignore rules." },
				{ label: "All files", description: "Include the whole workspace." },
			],
		},
	],
};
const fixtures: Array<{ mode: InteractiveMode; harness: Harness }> = [];

afterEach(async () => {
	for (const { mode, harness } of fixtures.splice(0)) {
		await harness.session.abort();
		mode.stop("resume-hint");
		await harness.cleanupAsync();
	}
	stopThemeWatcher();
	vi.restoreAllMocks();
});

async function fixture(tuiMode: TuiMode, columns = 80, withPlan = false) {
	const harness = await createHarness({
		settings: { theme: "dark", lsp: { enabled: false }, quietStartup: true, compaction: { enabled: false } },
	});
	if (withPlan) {
		await harness.session.setAgentMode("plan");
		const draft = harness.session.updatePlan({ steps: [{ text: "Implement project search" }] });
		harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Search implementation plan",
			summary: "Keep storage local and respect ignored files.",
		});
	}
	const runtime = { session: harness.session, setBeforeSessionInvalidate: vi.fn(), setRebindSession: vi.fn() };
	const mode = new InteractiveMode(runtime as unknown as AgentSessionRuntime, { tuiMode });
	fixtures.push({ mode, harness });
	const access = mode as unknown as TestAccess;
	const terminal = new VirtualTerminal(columns, 24);
	access.renderer = createInteractiveTui({
		tuiMode,
		showHardwareCursor: false,
		logDirectory: harness.tempDir,
		terminal,
	});
	access.renderWidgets();
	access.setupKeyHandlers();
	access.setupPlanPaneInputRouting();
	access.setupEditorSubmitHandler();
	access.activateView(access.conversationView, access.editor, false);
	access.isInitialized = true;
	access.ui.start();
	await access.bindCurrentSessionExtensions(harness.session);
	access.subscribeToAgent(harness.session);
	await terminal.waitForRender();
	return { harness, access, terminal };
}

async function ask({ harness, access, terminal }: Awaited<ReturnType<typeof fixture>>) {
	harness.setResponses([
		fauxAssistantMessage(
			[
				{ type: "text", text: "One preference determines the implementation." },
				fauxToolCall("request_user_input", request),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Preferences recorded."),
	]);
	const running = harness.session.prompt("Add project search");
	await vi.waitFor(() => expect(access.ui.getFocusedComponent()).toBeInstanceOf(UserInputDialog));
	await terminal.waitForRender();
	return { running, dialog: access.ui.getFocusedComponent() };
}

describe.each(["regular", "fullscreen"] as const)("native questions in %s InteractiveMode", (tuiMode) => {
	it("mounts in the conversation, routes text/back/Enter to questions, and preserves the editor draft", async () => {
		const f = await fixture(tuiMode);
		const { harness, access, terminal } = f;
		const draft = Array.from({ length: 20 }, (_, index) => `draft line ${index}`).join("\n");
		access.editor.handleInput(`\x1b[200~${draft}\x1b[201~`);
		access.editor.handleInput("\x1b[D");
		const cursor = access.editor.getCursor();
		const savedText = access.editor.getText();
		const { running } = await ask(f);
		expect(access.activeView).toBe(access.conversationView);
		const mounted = terminal.getViewport().join("\n");
		expect(mounted).toContain("ask user");
		expect(mounted).toContain("Working");
		expect(mounted).toContain(harness.getModel().id);
		expect(mounted).toContain("context");
		expect(mounted).toContain("Where should the search index live?");
		expect(mounted).not.toContain("draft line");
		terminal.sendInput("x");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Which files should be searchable?");
		terminal.sendInput("\x1b[Z");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Where should the search index live?");
		expect(harness.session.agentMode).toBe("build");
		terminal.sendInput("\r"); // Reopen the saved custom answer.
		terminal.sendInput("\r");
		terminal.sendInput("\r"); // Answer scope, then review.
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Review answers");
		terminal.sendInput("\r");
		await running;
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBe(access.editor);
		expect(access.editor.getText()).toBe(savedText);
		expect(access.editor.getExpandedText()).toBe(draft);
		expect(access.editor.getCursor()).toEqual(cursor);
		expect(access.pendingUserInputs).toEqual([]);
		expect(harness.eventsOfType("tool_execution_end")[0]?.result.details).toMatchObject({
			status: "answered",
			answers: { storage: { answers: ["x"] }, scope: { answers: ["Project files"] } },
		});
		expect(terminal.getScrollBuffer().join("\n")).toContain("Preferences recorded.");
	});

	it.each(["skip", "escape", "abort"] as const)("restores the prior view and draft on %s", async (action) => {
		const f = await fixture(tuiMode);
		const { harness, access, terminal } = f;
		access.editor.setText("unsubmitted draft");
		const prior = new Text("Prior custom view", 0, 0);
		const view = { regularComponents: [prior], fullscreenRoot: prior };
		access.activateView(view, prior);
		const { running } = await ask(f);
		if (action === "abort") await harness.session.abort();
		else terminal.sendInput(action === "skip" ? "\x13" : "\x1b");
		await running;
		await terminal.waitForRender();
		expect(access.activeView).toBe(view);
		expect(access.ui.getFocusedComponent()).toBe(prior);
		expect(access.editor.getText()).toBe("unsubmitted draft");
		expect(terminal.getViewport().join("\n")).toContain("Prior custom view");
		expect(access.editorContainer.children).toEqual([access.editor]);
		expect(harness.getPendingResponseCount()).toBe(action === "skip" ? 0 : 1);
		if (action === "skip") {
			expect(harness.eventsOfType("tool_execution_end")[0]?.result.details).toMatchObject({
				status: "skipped",
				answers: {},
			});
		}
	});

	it("returns focus from background inspection and dismisses the inspector on external abort", async () => {
		const f = await fixture(tuiMode);
		const { harness, access, terminal } = f;
		const { running, dialog } = await ask(f);
		terminal.sendInput("\x1bj");
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBeInstanceOf(BackgroundJobsInspector);
		terminal.sendInput("\r");
		expect(harness.eventsOfType("tool_execution_end")).toHaveLength(0);
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBe(dialog);
		terminal.sendInput("\x1bj");
		await terminal.waitForRender();
		await harness.session.abort();
		await running;
		expect(access.ui.getFocusedComponent()).toBe(access.editor);
		expect(access.ui.hasOverlay()).toBe(false);
	});

	it("retains the wide plan pane and returns pane focus to the pending question", async () => {
		const f = await fixture(tuiMode, 160, true);
		const { harness, access, terminal } = f;
		const priorFocus = access.ui.getFocusedComponent();
		// A new user prompt deliberately returns ready plans to draft. Invoke the
		// native tool directly here to exercise a question beside a still-ready plan.
		const running = createRequestUserInputToolDefinition().execute(
			"question-with-plan",
			request,
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);
		await terminal.waitForRender();
		const dialog = access.ui.getFocusedComponent();
		expect(dialog).toBeInstanceOf(UserInputDialog);
		expect(terminal.getViewport().join("\n")).toContain("Search implementation plan");
		expect(terminal.getViewport().join("\n")).toContain(harness.getModel().id);
		terminal.sendInput("\x1bp");
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBe(access.planInspector);
		terminal.sendInput("\x1bp");
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBe(dialog);
		terminal.sendInput("\x13");
		await running;
		expect(access.ui.getFocusedComponent()).toBe(priorFocus);
		expect(harness.session.planningState.plan?.phase).toBe("ready");
	});

	it("scrolls long questions with Ctrl+PageUp/Down without moving focus or submitting", async () => {
		const { harness, access, terminal } = await fixture(tuiMode);
		const longRequest = structuredClone(request);
		longRequest.questions[0].question = `Beginning of this question. ${"Consider the workspace constraints before selecting an option. ".repeat(7)}`;
		longRequest.questions[0].options[0].description = "Explain this tradeoff in detail. ".repeat(8);
		const running = createRequestUserInputToolDefinition().execute(
			"long-question",
			longRequest,
			undefined,
			undefined,
			harness.session.extensionRunner.createContext(),
		);
		await terminal.waitForRender();
		const dialog = access.ui.getFocusedComponent();
		terminal.sendInput("\x1b[5;5~");
		terminal.sendInput("\x1b[5;5~");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Beginning of this question.");
		terminal.sendInput("\x1b[6;5~");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).not.toContain("Beginning of this question.");
		expect(access.ui.getFocusedComponent()).toBe(dialog);
		terminal.sendInput("\x1b[5;5~");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Beginning of this question.");
		terminal.sendInput("\x13");
		await running;
	});

	it("keeps non-native custom components in dedicated views", async () => {
		const { access, terminal } = await fixture(tuiMode);
		const dedicated = new Text("Dedicated extension", 0, 0);
		let close = () => {};
		const showing = access.showExtensionCustom<void>((_ui, _theme, _keys, done) => {
			close = done;
			return dedicated;
		});
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBe(dedicated);
		expect(terminal.getViewport().join("\n")).toContain("Dedicated extension");
		expect(terminal.getViewport().join("\n")).not.toContain("context");
		close();
		await showing;
		expect(access.activeView).toBe(access.conversationView);
	});
});
