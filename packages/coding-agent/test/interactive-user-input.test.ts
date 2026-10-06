import { fauxAssistantMessage, fauxToolCall, type Model } from "@hansjm10/volt-ai";
import { type Component, type Container, Text, type TUI, type TuiMode } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import type { PlanInspectorComponent } from "../src/modes/interactive/components/plan-inspector.ts";
import { UserInputDialog } from "../src/modes/interactive/components/user-input-dialog.ts";
import { WorkInspector } from "../src/modes/interactive/components/work-inspector.ts";
import { createTuiHarness, type TuiHarness } from "./suite/tui-harness.ts";

type View = { regularComponents: readonly Component[]; fullscreenRoot: Component };
type TestAccess = {
	ui: TUI;
	editor: CustomEditor;
	conversationView: View;
	activeView: View;
	editorContainer: Container;
	planInspector: PlanInspectorComponent;
	pendingUserInputs: string[];
	activateView(view: View, focus: Component, forceRender?: boolean): void;
};

/** The TUI's conversation as these tests drive it: its session, the faux provider's turns, and the session's events. */
interface Harness {
	readonly session: AgentSession;
	setResponses: TuiHarness["faux"]["setResponses"];
	getModel(): Model<string>;
	getPendingResponseCount(): number;
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
}

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
const harnesses: TuiHarness[] = [];

/** The session's request_user_input tool, which asks through the client that shows a terminal. */
function sessionTool(harness: Harness) {
	const definition = harness.session.getToolDefinition("request_user_input");
	if (!definition) throw new Error("request_user_input is not registered");
	return definition;
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.startup.session.abort();
		await harness.cleanup();
	}
	vi.restoreAllMocks();
});

/** InteractiveMode as the client of a conversation it shows in a virtual terminal. */
async function fixture(tuiMode: TuiMode, columns = 80, withPlan = false) {
	const tuiHarness = await createTuiHarness({
		globalSettings: { theme: "dark", lsp: { enabled: false }, quietStartup: true, compaction: { enabled: false } },
	});
	harnesses.push(tuiHarness);
	const session = tuiHarness.startup.session;
	if (withPlan) {
		await session.setAgentMode("plan");
		const draft = await session.updatePlan({ steps: [{ text: "Implement project search" }] });
		await session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Search implementation plan",
			summary: "Keep storage local and respect ignored files.",
		});
	}
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});
	const harness: Harness = {
		session,
		setResponses: (responses) => tuiHarness.faux.setResponses(responses),
		getModel: () => tuiHarness.faux.getModel(),
		getPendingResponseCount: () => tuiHarness.faux.getPendingResponseCount(),
		eventsOfType: <T extends AgentSessionEvent["type"]>(type: T) =>
			events.filter((event): event is Extract<AgentSessionEvent, { type: T }> => event.type === type),
	};
	const tui = await tuiHarness.startMode({ tuiMode, columns, rows: 24 });
	const access = tui.mode as unknown as TestAccess;
	return { harness, access, terminal: tui.terminal as VirtualTerminal };
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

	it("returns focus from work inspection and dismisses the inspector on external abort", async () => {
		const f = await fixture(tuiMode);
		const { harness, access, terminal } = f;
		const { running, dialog } = await ask(f);
		terminal.sendInput("\x1bj");
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBeInstanceOf(WorkInspector);
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
		const running = sessionTool(harness).execute(
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
		const running = sessionTool(harness).execute(
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
});
