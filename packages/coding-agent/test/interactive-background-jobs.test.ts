import type { AgentToolUpdateCallback } from "@hansjm10/volt-agent-core";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import type { Component, OverlayHandle, TUI, TuiMode } from "@hansjm10/volt-tui";
import { type Container, Text } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import {
	BACKGROUND_JOB_MAX_RETAINED,
	BackgroundJobManager,
	type BackgroundJobSource,
} from "../src/core/background-jobs.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { stopThemeWatcher } from "../src/core/theme/runtime.ts";
import { backgroundJobResult, withBackgroundJobs } from "../src/core/tools/background.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createJobsToolDefinition } from "../src/core/tools/jobs.ts";
import {
	BackgroundJobsInspector,
	type BackgroundJobsStatus,
} from "../src/modes/interactive/components/background-jobs.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import type { StreamingRenderCoalescer } from "../src/modes/interactive/components/streaming-render-coalescer.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

type View = { regularComponents: readonly Component[]; fullscreenRoot: Component };
type InteractiveTestAccess = {
	renderer: ReturnType<typeof createInteractiveTui>;
	ui: TUI;
	editor: CustomEditor;
	defaultEditor: CustomEditor;
	conversationView: View;
	chatContainer: Container;
	editorContainer: Container;
	backgroundJobsStatus: BackgroundJobsStatus;
	backgroundJobsInspector?: BackgroundJobsInspector;
	backgroundJobsOverlay?: OverlayHandle;
	backgroundJobsRenderCoalescer?: StreamingRenderCoalescer<void>;
	isInitialized: boolean;
	pendingUserInputs: string[];
	setupKeyHandlers(): void;
	setupEditorSubmitHandler(): void;
	showExtensionConfirm(title: string, message: string): Promise<boolean>;
	showOAuthLoginSelect(
		dialog: Component,
		prompt: { message: string; options: { id: string; label: string }[] },
	): Promise<string | undefined>;
	showExtensionCustom(
		factory: (ui: TUI, theme: unknown, keys: unknown, done: () => void) => Component | Promise<Component>,
		options: { overlay: boolean },
	): Promise<void>;
	activateView(view: View, focus: Component, forceRender?: boolean): void;
	subscribeToBackgroundJobs(session: AgentSession): void;
	handleEvent(event: AgentSessionEvent): Promise<void>;
	handleFollowUp(): Promise<void>;
	beginSessionReplacementUi(): void;
	rebindReplacementSession(session: AgentSession): Promise<void>;
	renderCurrentSessionState(): void;
	reloadRuntimeResources(): Promise<boolean>;
};

const fixtures: Array<{ mode: InteractiveMode; harnesses: Harness[]; jobs: BackgroundJobManager; finish: () => void }> =
	[];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		fixture.mode.stop("resume-hint");
		fixture.finish();
		await fixture.jobs.close();
		for (const harness of fixture.harnesses) await harness.cleanupAsync();
	}
	stopThemeWatcher();
	vi.restoreAllMocks();
});

async function createFixture(
	tuiMode: TuiMode,
	columns = 80,
	withPlan = false,
	outcome: "completed" | "failed" = "completed",
) {
	const harness = await createHarness({ settings: { lsp: { enabled: false }, theme: "dark", quietStartup: true } });
	// The public session getter is stable and initially contains no jobs.
	expect(harness.session.backgroundJobs).toBe(harness.session.backgroundJobs);
	expect(harness.session.backgroundJobs.list()).toEqual([]);
	const scope = { allowed: true, generation: 0 };
	const jobs = new BackgroundJobManager({
		isToolAllowed: () => scope.allowed,
		getGeneration: () => scope.generation,
	});
	const listeners = new Set<() => void>();
	const source: BackgroundJobSource = {
		list: () => jobs.list(),
		get: (id) => jobs.get(id),
		cancel: (id) => jobs.cancel(id),
		subscribe: (listener) => {
			listeners.add(listener);
			const unsubscribe = jobs.subscribe(listener);
			return () => {
				listeners.delete(listener);
				unsubscribe();
			};
		},
	};
	vi.spyOn(harness.session, "backgroundJobs", "get").mockReturnValue(source);
	const getToolDefinition = harness.session.getToolDefinition.bind(harness.session);
	const bash = withBackgroundJobs(createBashToolDefinition(harness.tempDir), { manager: jobs });
	const jobsTool = createJobsToolDefinition({ manager: jobs });
	vi.spyOn(harness.session, "getToolDefinition").mockImplementation((name) =>
		name === "bash" ? bash : name === "jobs" ? jobsTool : getToolDefinition(name),
	);
	if (withPlan) {
		vi.spyOn(harness.session, "planningState", "get").mockReturnValue({
			mode: "build",
			plan: {
				id: "plan-jobs",
				revision: 1,
				phase: "ready",
				title: "Keep the plan visible",
				summary: "Inspect background work without losing the plan pane.",
				steps: [{ id: "step-1", text: "Observe the job dock", status: "pending" }],
			},
		});
	}
	const runtime = {
		session: harness.session,
		setBeforeSessionInvalidate: vi.fn(),
		setRebindSession: vi.fn(),
	};
	const mode = new InteractiveMode(runtime as unknown as AgentSessionRuntime, { tuiMode });
	const access = mode as unknown as InteractiveTestAccess;
	const terminal = new VirtualTerminal(columns, 24);
	access.renderer = createInteractiveTui({
		tuiMode,
		showHardwareCursor: false,
		logDirectory: harness.tempDir,
		terminal,
	});
	access.setupKeyHandlers();
	access.setupEditorSubmitHandler();
	access.activateView(access.conversationView, access.editor, false);
	access.subscribeToBackgroundJobs(harness.session);
	access.isInitialized = true;
	access.ui.start();

	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let update!: AgentToolUpdateCallback<unknown>;
	const job = jobs.start({
		toolName: "bash",
		toolCallId: "live-background-launch",
		label: "Run focused integration checks",
		execute: async (_signal, onUpdate) => {
			update = onUpdate;
			onUpdate({ content: [{ type: "text", text: "first live output" }] });
			await pending;
			return { content: [{ type: "text", text: "final output" }], isError: outcome === "failed" };
		},
	});
	const fixture = { mode, harnesses: [harness], jobs, finish };
	fixtures.push(fixture);
	await Promise.resolve();
	access.backgroundJobsRenderCoalescer?.flush();
	await terminal.waitForRender();
	return { ...fixture, harness, access, runtime, terminal, source, listeners, job, update, scope };
}

async function acknowledgeLaunch(fixture: Awaited<ReturnType<typeof createFixture>>) {
	const { harness, access, job } = fixture;
	const model = harness.getModel();
	const args = { command: job.label, background: true };
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: job.toolCallId, name: "bash", arguments: args }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	const result = backgroundJobResult(job);
	harness.sessionManager.appendMessage(assistant);
	harness.sessionManager.appendMessage({
		...result,
		role: "toolResult",
		toolCallId: job.toolCallId,
		toolName: "bash",
		isError: false,
		timestamp: Date.now(),
	});
	await access.handleEvent({ type: "tool_execution_start", toolCallId: job.toolCallId, toolName: "bash", args });
	await access.handleEvent({
		type: "tool_execution_end",
		toolCallId: job.toolCallId,
		toolName: "bash",
		result,
		isError: false,
	});
	access.backgroundJobsRenderCoalescer?.flush();
	const card = access.chatContainer.children.find((child) => child instanceof ToolExecutionComponent);
	if (!card) throw new Error("Expected the live background launch card");
	return card;
}

describe("interactive background jobs", () => {
	it("registers /jobs as a built-in local command", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "jobs")?.description).toContain(
			"background jobs",
		);
	});

	it.each(["regular", "fullscreen"] as const)(
		"opens /jobs during a foreground wait without cancelling work (%s)",
		async (tuiMode) => {
			const { harness, access, jobs, job, terminal, listeners, update, finish } = await createFixture(tuiMode);
			vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);
			const prompt = vi.spyOn(harness.session, "prompt");
			const abort = vi.spyOn(harness.session, "abort");
			const cancel = vi.spyOn(jobs, "cancel");
			let waitSettled = false;
			const waiting = jobs.wait(job.id).then(() => {
				waitSettled = true;
			});

			await access.defaultEditor.onSubmit?.(" /jobs ");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBeInstanceOf(BackgroundJobsInspector);
			expect(listeners.size).toBe(2);
			expect(terminal.getViewport().join("\n")).toContain("first live output");
			update({ content: [{ type: "text", text: "latest inspector output" }] });
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("latest inspector output");
			expect(waitSettled).toBe(false);
			expect(prompt).not.toHaveBeenCalled();
			expect(access.pendingUserInputs).toEqual([]);

			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBe(access.editor);
			expect(listeners.size).toBe(1);
			expect(abort).not.toHaveBeenCalled();
			expect(cancel).not.toHaveBeenCalled();
			expect(jobs.get(job.id).status).toBe("running");
			finish();
			await waiting;
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"keeps the background dock above the editor beside a wide plan (%s)",
		async (tuiMode) => {
			const { access, terminal } = await createFixture(tuiMode, 160, true);
			const viewport = terminal.getViewport();
			const statusRow = viewport.findIndex((line) => line.includes("Background:"));
			const editorRow = viewport.findIndex((line) => line.includes("ASK VOLT"));
			expect(statusRow).toBeGreaterThanOrEqual(0);
			expect(editorRow).toBeGreaterThan(statusRow);
			expect(viewport.join("\n")).toContain("Keep the plan visible");
			expect(viewport.join("\n")).toContain("first live output");

			access.ui.setFocus(access.editor);
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBeInstanceOf(BackgroundJobsInspector);
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBe(access.editor);
		},
	);

	it("keeps the inspector open when an underlying asynchronous extension overlay closes", async () => {
		const { access, terminal, listeners } = await createFixture("fullscreen");
		let closeExtension!: () => void;
		const extension = access.showExtensionCustom(
			(_ui, _theme, _keys, done) => {
				closeExtension = done;
				return new Text("Asynchronous extension work", 0, 0);
			},
			{ overlay: true },
		);
		await terminal.waitForRender();
		terminal.sendInput("\x1bj");
		await terminal.waitForRender();
		const inspector = access.ui.getFocusedComponent();
		expect(inspector).toBeInstanceOf(BackgroundJobsInspector);
		closeExtension();
		await extension;
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBe(inspector);
		expect(listeners.size).toBe(2);
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBe(access.editor);
		expect(listeners.size).toBe(1);
	});

	it.each(["regular", "fullscreen"] as const)(
		"keeps confirmations visible and prevents inspection keys from approving them (%s)",
		async (tuiMode) => {
			const { access, terminal, listeners, jobs, job } = await createFixture(tuiMode);
			await access.defaultEditor.onSubmit?.("/jobs");
			await terminal.waitForRender();
			let resolved = false;
			const confirmation = access
				.showExtensionConfirm("Permission required", "Allow the requested action?")
				.then((value) => {
					resolved = true;
					return value;
				});
			await terminal.waitForRender();
			expect(access.backgroundJobsInspector).toBeUndefined();
			expect(listeners.size).toBe(1);
			expect(terminal.getViewport().join("\n")).toContain("Permission required");
			expect(resolved).toBe(false);
			// Opening the inspector above a visible pending confirmation must keep its input separate.
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			terminal.sendInput("\r");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("Following latest");
			expect(resolved).toBe(false);
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("Permission required");
			terminal.sendInput("\x1b");
			expect(await confirmation).toBe(false);
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBe(access.editor);
			expect(jobs.get(job.id).status).toBe("running");
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"dismisses inspection before an asynchronous dedicated UI takes focus (%s)",
		async (tuiMode) => {
			const { access, terminal, listeners } = await createFixture(tuiMode);
			let ready!: (component: Component) => void;
			let close!: () => void;
			const pendingComponent = new Promise<Component>((resolve) => {
				ready = resolve;
			});
			const extension = access.showExtensionCustom(
				(_ui, _theme, _keys, done) => {
					close = done;
					return pendingComponent;
				},
				{ overlay: false },
			);
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBeInstanceOf(BackgroundJobsInspector);
			const component = new Text("Dedicated confirmation content", 0, 0);
			ready(component);
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBe(component);
			expect(access.backgroundJobsInspector).toBeUndefined();
			expect(terminal.getViewport().join("\n")).toContain("Dedicated confirmation content");
			expect(listeners.size).toBe(1);
			close();
			await extension;
			expect(access.ui.getFocusedComponent()).toBe(access.editor);
		},
	);

	it.each([
		["regular", false],
		["regular", true],
		["fullscreen", false],
		["fullscreen", true],
	] as const)(
		"restores login input after account selection interrupts jobs inspection (%s, cancel: %s)",
		async (tuiMode, cancel) => {
			const { access, terminal, jobs, job } = await createFixture(tuiMode);
			const input = vi.fn();
			const dialog = Object.assign(new Text("Waiting for login input", 0, 0), { handleInput: input });
			access.activateView({ regularComponents: [dialog], fullscreenRoot: dialog }, dialog);
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBeInstanceOf(BackgroundJobsInspector);
			const selected = access.showOAuthLoginSelect(dialog, {
				message: "Choose an account",
				options: [{ id: "first", label: "First account" }],
			});
			await terminal.waitForRender();
			expect(access.backgroundJobsInspector).toBeUndefined();
			expect(terminal.getViewport().join("\n")).toContain("Choose an account");
			terminal.sendInput(cancel ? "\x1b" : "\r");
			expect(await selected).toBe(cancel ? undefined : "first");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBe(dialog);
			terminal.sendInput("login input");
			terminal.sendInput("\x1b");
			expect(input).toHaveBeenCalledWith("login input");
			expect(input).toHaveBeenCalledWith("\x1b");
			expect(jobs.get(job.id).status).toBe("running");
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"preserves the live target and output of pending waits through reconstruction (%s)",
		async (tuiMode) => {
			const fixture = await createFixture(tuiMode);
			const { access, terminal, harness, jobs, job, update, finish } = fixture;
			await acknowledgeLaunch(fixture);
			const assistant = harness.sessionManager
				.buildSessionContext()
				.messages.find((message) => message.role === "assistant");
			if (!assistant || assistant.role !== "assistant") throw new Error("Expected launch message");
			const toolCallId = "pending-job-wait";
			const args = { action: "wait", id: job.id };
			harness.sessionManager.appendMessage({
				...assistant,
				content: [{ type: "toolCall", id: toolCallId, name: "jobs", arguments: args }],
			});
			await access.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "jobs", args });
			const waiting = jobs.wait(job.id);
			for (let index = 0; index < 3; index++) {
				terminal.sendInput("\x14");
				update({ content: [{ type: "text", text: `live wait output ${index}` }] });
				access.backgroundJobsRenderCoalescer?.flush();
				await terminal.waitForRender();
				const card = access.chatContainer.children
					.filter((child) => child instanceof ToolExecutionComponent)
					.at(-1);
				if (!card) throw new Error("Expected pending wait card");
				const output = stripAnsi(card.render(80).lines.join("\n"));
				expect(output).toContain("Waiting for background job");
				expect(output).toContain(job.label);
				expect(output).toContain(`live wait output ${index}`);
				expect(output).not.toContain("Running at capture");
			}
			finish();
			const result = backgroundJobResult(await waiting);
			await access.handleEvent({ type: "tool_execution_end", toolCallId, toolName: "jobs", result, isError: false });
			const card = access.chatContainer.children.filter((child) => child instanceof ToolExecutionComponent).at(-1);
			if (!card) throw new Error("Expected completed wait card");
			const output = stripAnsi(card.render(80).lines.join("\n"));
			expect(output).toContain("Completed");
			expect(output).toContain("final output");
			expect(output).not.toContain("live status unavailable");
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"dismisses inspection when a cached host focus callback restores input (%s)",
		async (tuiMode) => {
			const { access, terminal, jobs, job, listeners } = await createFixture(tuiMode);
			const loader = new Text("Asynchronous host operation", 0, 0);
			access.editorContainer.clear();
			access.editorContainer.addChild(loader);
			access.ui.setFocus(loader);
			const restoreFocus = access.ui.setFocus;
			let release!: () => void;
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			const operation = pending.then(() => {
				access.editorContainer.clear();
				access.editorContainer.addChild(access.editor);
				restoreFocus(access.editor);
				access.ui.requestRender();
			});
			try {
				terminal.sendInput("\x1bj");
				await terminal.waitForRender();
				const inspector = access.ui.getFocusedComponent();
				expect(inspector).toBeInstanceOf(BackgroundJobsInspector);
				access.ui.setFocus(inspector);
				expect(access.backgroundJobsInspector).toBe(inspector);
				release();
				await operation;
				await terminal.waitForRender();
				expect(access.backgroundJobsInspector).toBeUndefined();
				expect(access.ui.getFocusedComponent()).toBe(access.editor);
				expect(listeners.size).toBe(1);
				terminal.sendInput("visible draft");
				await terminal.waitForRender();
				expect(access.editor.getText()).toBe("visible draft");
				expect(terminal.getViewport().join("\n")).toContain("visible draft");
				expect(jobs.get(job.id).status).toBe("running");
			} finally {
				release();
				await operation;
			}
		},
	);

	it.each([
		["regular", false],
		["regular", true],
		["fullscreen", false],
		["fullscreen", true],
	] as const)(
		"restores visible editor input when reload settles after inspection opens (%s, failure: %s)",
		async (tuiMode, failed) => {
			const { harness, access, terminal, jobs, job, finish, listeners } = await createFixture(tuiMode);
			finish();
			await jobs.wait(job.id);
			let entered!: () => void;
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let release!: () => void;
			const pending = new Promise<void>((resolve) => {
				release = resolve;
			});
			vi.spyOn(harness.session, "reload").mockImplementation(async () => {
				entered();
				await pending;
				if (failed) throw new Error("Controlled reload failure");
			});
			const reloading = access.reloadRuntimeResources();
			try {
				await started;
				terminal.sendInput("\x1bj");
				await terminal.waitForRender();
				expect(access.ui.getFocusedComponent()).toBeInstanceOf(BackgroundJobsInspector);
				expect(listeners.size).toBe(2);
				release();
				expect(await reloading).toBe(!failed);
				await terminal.waitForRender();
				expect(access.backgroundJobsInspector).toBeUndefined();
				expect(access.ui.getFocusedComponent()).toBe(access.editor);
				expect(listeners.size).toBe(1);
				terminal.sendInput("draft after reload");
				await terminal.waitForRender();
				expect(access.editor.getText()).toBe("draft after reload");
				expect(terminal.getViewport().join("\n")).toContain("draft after reload");
				expect(jobs.get(job.id).status).toBe("completed");
			} finally {
				release();
				await reloading;
			}
		},
	);

	it("keeps follow-up /jobs local and cancels only the selected job after confirmation", async () => {
		const { harness, access, jobs, terminal, job, listeners } = await createFixture("fullscreen");
		vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);
		const prompt = vi.spyOn(harness.session, "prompt");
		const other = jobs.start({
			toolName: "bash",
			toolCallId: "second",
			label: "Other job",
			execute: async () => ({ content: [] }),
		});
		await jobs.wait(other.id);
		access.editor.setText("/jobs");
		await access.handleFollowUp();
		await terminal.waitForRender();
		expect(prompt).not.toHaveBeenCalled();
		terminal.sendInput("\x0b");
		await terminal.waitForRender();
		expect(jobs.get(job.id).status).toBe("running");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		expect(jobs.get(job.id).status).toBe("cancelling");
		expect(jobs.get(other.id).status).toBe("completed");
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(listeners.size).toBe(1);
	});

	it("coalesces live launch-card invalidation after acknowledgement without rebuilding history", async () => {
		const { access, job, jobs, update, finish } = await createFixture("regular");
		const history = new Text("STATIC HISTORY", 0, 0);
		access.chatContainer.addChild(history);
		await access.handleEvent({
			type: "tool_execution_start",
			toolCallId: job.toolCallId,
			toolName: "bash",
			args: { command: job.label, background: true },
		});
		await access.handleEvent({
			type: "tool_execution_end",
			toolCallId: job.toolCallId,
			toolName: "bash",
			result: backgroundJobResult(job),
			isError: false,
		});
		const card = access.chatContainer.children.find((child) => child instanceof ToolExecutionComponent);
		if (!card) throw new Error("Expected the live background launch card");
		access.backgroundJobsRenderCoalescer?.flush();
		const invalidate = vi.spyOn(card, "invalidate");
		const invalidateHistory = vi.spyOn(history, "invalidate");
		for (let index = 0; index < 100; index++) update({ content: [{ type: "text", text: `output ${index}` }] });
		access.backgroundJobsRenderCoalescer?.flush();
		expect(invalidate.mock.calls.length).toBeLessThanOrEqual(2);
		expect(invalidate).toHaveBeenCalled();
		expect(invalidateHistory).not.toHaveBeenCalled();
		expect(access.chatContainer.children).toContain(history);
		expect(stripAnsi(card.render(100).lines.join("\n"))).toContain("output 99");
		finish();
		await jobs.wait(job.id);
		access.backgroundJobsRenderCoalescer?.flush();
		expect(stripAnsi(card.render(100).lines.join("\n"))).toContain("Completed");
		invalidate.mockClear();
		access.backgroundJobsRenderCoalescer?.flush();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("does not invalidate completed inspections while their worker remains active", async () => {
		const fixture = await createFixture("regular");
		const { access, jobs, job, update } = fixture;
		const launch = await acknowledgeLaunch(fixture);
		const inspections: ToolExecutionComponent[] = [];
		for (let index = 0; index < 200; index++) {
			const toolCallId = `completed-inspection-${index}`;
			const args = { action: index % 2 === 0 ? "read" : "wait", id: job.id };
			await access.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "jobs", args });
			const component = access.chatContainer.children.at(-1);
			if (!(component instanceof ToolExecutionComponent)) throw new Error("Expected inspection component");
			await access.handleEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: "jobs",
				result: backgroundJobResult(jobs.get(job.id)),
				isError: false,
			});
			inspections.push(component);
		}
		access.backgroundJobsRenderCoalescer?.flush();
		const invalidations = inspections.map((component) => vi.spyOn(component, "invalidate"));
		const launchInvalidation = vi.spyOn(launch, "invalidate");
		await access.handleEvent({
			type: "tool_execution_start",
			toolCallId: "pending-inspection",
			toolName: "jobs",
			args: { action: "wait", id: job.id },
		});
		const pending = access.chatContainer.children.at(-1);
		if (!(pending instanceof ToolExecutionComponent)) throw new Error("Expected pending inspection");
		const pendingInvalidation = vi.spyOn(pending, "invalidate");
		for (let index = 0; index < 10; index++)
			update({ content: [{ type: "text", text: `latest live output ${index}` }] });
		access.backgroundJobsRenderCoalescer?.flush();
		await new Promise((resolve) => setTimeout(resolve, 1100));
		for (const invalidate of invalidations) expect(invalidate).not.toHaveBeenCalled();
		expect(launchInvalidation).toHaveBeenCalled();
		expect(pendingInvalidation).toHaveBeenCalled();
		expect(stripAnsi(launch.render(80).lines.join("\n"))).toContain("latest live output 9");
		expect(stripAnsi(pending.render(80).lines.join("\n"))).toContain("latest live output 9");
		expect(stripAnsi(inspections[0].render(80).lines.join("\n"))).toContain("first live output");
	});

	it.each(["completed", "failed"] as const)(
		"preserves %s launch status and final output through repeated transcript reconstruction",
		async (outcome) => {
			const fixture = await createFixture("regular", 80, false, outcome);
			const { access, harness, terminal, job, jobs, finish } = fixture;
			const card = await acknowledgeLaunch(fixture);
			const transcript = harness.sessionManager.buildSessionContext();
			const modelMessages = harness.session.messages;
			finish();
			await jobs.wait(job.id);
			// The first reconstruction must also flush any queued terminal-status repaint.
			for (let index = 0; index < 3; index++) {
				terminal.sendInput("\x14"); // Ctrl+T reconstructs the transcript.
				await terminal.waitForRender();
				const output = terminal.getViewport().join("\n");
				expect(output).toContain(outcome === "completed" ? "Completed" : "Failed");
				expect(output).toContain("final output");
				expect(output).not.toContain("Running at capture");
				expect(access.ui.getFocusedComponent()).toBe(access.editor);
			}
			expect(harness.sessionManager.buildSessionContext()).toEqual(transcript);
			expect(harness.session.messages).toEqual(modelMessages);
			const invalidate = vi.spyOn(card, "invalidate");
			const repaint = vi.spyOn(access.ui, "requestRender");
			await new Promise((resolve) => setTimeout(resolve, 1100));
			expect(repaint).not.toHaveBeenCalled();
			const other = jobs.start({
				toolName: "bash",
				toolCallId: "unrelated-work",
				label: "Unrelated work",
				execute: async (_signal, update) => {
					for (let index = 0; index < 100; index++)
						update({ content: [{ type: "text", text: `unrelated output ${index}` }] });
					return { content: [] };
				},
			});
			await jobs.wait(other.id);
			access.backgroundJobsRenderCoalescer?.flush();
			expect(invalidate).not.toHaveBeenCalled();
			expect(stripAnsi(access.chatContainer.render(100).lines.join("\n"))).toContain("final output");
		},
	);

	it.each(["grant", "branch", "eviction"] as const)(
		"releases settled launch bindings after %s access loss without reacquiring replay handles",
		async (reason) => {
			const fixture = await createFixture("regular");
			const { access, jobs, job, finish, scope, source } = fixture;
			const card = await acknowledgeLaunch(fixture);
			finish();
			await jobs.wait(job.id);
			access.backgroundJobsRenderCoalescer?.flush();
			const dispose = vi.spyOn(card, "dispose");
			if (reason === "eviction") {
				for (let index = 0; index < BACKGROUND_JOB_MAX_RETAINED; index++) {
					const other = jobs.start({
						toolName: "bash",
						toolCallId: `evicting-work-${index}`,
						label: "New work",
						execute: async () => ({ content: [] }),
					});
					await jobs.wait(other.id);
				}
				expect(jobs.list()).toHaveLength(BACKGROUND_JOB_MAX_RETAINED);
			} else {
				if (reason === "grant") scope.allowed = false;
				else scope.generation++;
				jobs.cancelInaccessible();
				// Restore access before the coalescer flushes; the old binding must stay released.
				scope.allowed = true;
				scope.generation = 0;
				jobs.cancelInaccessible();
			}
			expect(dispose).toHaveBeenCalledOnce();
			const get = vi.spyOn(source, "get");
			const managerGet = vi.spyOn(jobs, "get");
			for (let index = 0; index < 2; index++) {
				access.renderCurrentSessionState();
				const output = stripAnsi(access.chatContainer.render(100).lines.join("\n"));
				expect(output).toContain("Running at capture");
				expect(output).not.toContain("final output");
			}
			expect(get).not.toHaveBeenCalledWith(job.id);
			expect(managerGet).not.toHaveBeenCalledWith(job.id);
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"covers both transcript edges in the jobs inspector and restores editor input (%s)",
		async (tuiMode) => {
			const { access, terminal } = await createFixture(tuiMode);
			access.chatContainer.addChild(new Text(Array.from({ length: 30 }, () => "X".repeat(80)).join("\n"), 0, 0));
			access.ui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("X".repeat(80));
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			expect(terminal.getViewport().slice(1, -1).join("\n")).not.toContain("X");
			expect(access.ui.getFocusedComponent()).toBeInstanceOf(BackgroundJobsInspector);
			terminal.sendInput("\x1b");
			terminal.sendInput("editor restored");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBe(access.editor);
			expect(access.editor.getText()).toBe("editor restored");
		},
	);

	it.each([false, true])(
		"closes old subscriptions and releases launch cards before replacing a session (settled: %s)",
		async (settled) => {
			const fixture = await createFixture("regular");
			const { harnesses, access, runtime, terminal, listeners, update, finish, jobs, job } = fixture;
			const card = await acknowledgeLaunch(fixture);
			if (settled) {
				finish();
				await jobs.wait(job.id);
				access.backgroundJobsRenderCoalescer?.flush();
			}
			const dispose = vi.spyOn(card, "dispose");
			await access.defaultEditor.onSubmit?.("/jobs");
			await terminal.waitForRender();
			expect(listeners.size).toBe(2);
			access.beginSessionReplacementUi();
			expect(listeners.size).toBe(0);
			expect(dispose).toHaveBeenCalledOnce();
			expect(access.backgroundJobsInspector).toBeUndefined();
			const replacement = await createHarness({
				settings: { lsp: { enabled: false }, theme: "dark", quietStartup: true },
			});
			harnesses.push(replacement);
			runtime.session = replacement.session;
			await access.rebindReplacementSession(replacement.session);
			access.renderCurrentSessionState();
			update({ content: [{ type: "text", text: "stale runtime output" }] });
			await terminal.waitForRender();
			expect(access.backgroundJobsStatus.render(80).lines).toEqual([]);
			expect(terminal.getViewport().join("\n")).not.toContain("stale runtime output");
			await access.defaultEditor.onSubmit?.("/jobs");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("No background jobs");
		},
	);
});
