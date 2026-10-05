import type { AgentToolResult } from "@hansjm10/volt-agent-core";
import type { AssistantMessage } from "@hansjm10/volt-ai";
import { WORK_NOTICE_CUSTOM_TYPE } from "@hansjm10/volt-protocol";
import type { Component, OverlayHandle, TUI, TuiMode } from "@hansjm10/volt-tui";
import { type Container, Text } from "@hansjm10/volt-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { liveKey } from "../src/core/host/live-state.ts";
import type { HostClient } from "../src/core/host/targets.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { stopThemeWatcher } from "../src/core/theme/runtime.ts";
import { withBackgroundJobs } from "../src/core/tools/background.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import {
	createJobsTool,
	createJobsToolDefinition,
	JOB_LIST_MAX,
	type JobSource,
	jobResult,
} from "../src/core/tools/jobs.ts";
import type { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { PresentedMessageComponent } from "../src/modes/interactive/components/presented-message.ts";
import { PresentedToolComponent } from "../src/modes/interactive/components/presented-tool.ts";
import type { StreamingRenderCoalescer } from "../src/modes/interactive/components/streaming-render-coalescer.ts";
import { WorkInspector } from "../src/modes/interactive/components/work-inspector.ts";
import type { WorkStatus } from "../src/modes/interactive/components/work-status.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createFakeConversation, createFakeHost } from "./utilities/fake-conversation-host.ts";
import { createTestJobRuntime, type TestJobRuntime } from "./utilities/job-runtime.ts";

type View = { regularComponents: readonly Component[]; fullscreenRoot: Component };
type InteractiveTestAccess = {
	renderer: ReturnType<typeof createInteractiveTui>;
	ui: TUI;
	editor: CustomEditor;
	defaultEditor: CustomEditor;
	conversationView: View;
	chatContainer: Container;
	editorContainer: Container;
	workStatus: WorkStatus;
	workInspector?: WorkInspector;
	workOverlay?: OverlayHandle;
	followWork(): void;
	jobsRenderCoalescer?: StreamingRenderCoalescer<void>;
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
	client: HostClient;
	beginSessionReplacementUi(): void;
	renderCurrentSessionState(): void;
	reloadRuntimeResources(): Promise<boolean>;
};

/** The tool call that launched the fixture's job. */
const LAUNCH_CALL = "live-background-launch";

const fixtures: Array<{ mode: InteractiveMode; harnesses: Harness[]; runtime: TestJobRuntime; finish: () => void }> =
	[];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) {
		fixture.mode.stop("resume-hint");
		fixture.finish();
		await fixture.runtime.close();
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
	expect(harness.session.jobs).toBe(harness.session.jobs);
	expect(harness.session.jobs.list()).toEqual([]);
	const runtime = await createTestJobRuntime();
	const jobs = runtime.jobs;
	const listeners = new Set<() => void>();
	const source: JobSource = {
		list: () => jobs.list(),
		listWaits: () => jobs.listWaits(),
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
	vi.spyOn(harness.session, "jobs", "get").mockReturnValue(source);
	// The conversation's work is the fixture's: the TUI's work inspector and footer line read it.
	vi.spyOn(harness.session, "work", "get").mockReturnValue(runtime.work);
	const getToolDefinition = harness.session.getToolDefinition.bind(harness.session);
	const bash = withBackgroundJobs(createBashToolDefinition(harness.tempDir), {
		start: (job) => jobs.start(job),
	});
	const jobsTool = createJobsToolDefinition({ jobs });
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
	const host = createFakeHost({ extensionMode: "tui" });
	const { conversation } = createFakeConversation(harness.session);
	const mode = new InteractiveMode(host.host, conversation, { tuiMode });
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
	access.followWork();
	if (access.client.live) runtime.live.attach("tui", access.client.live);
	access.isInitialized = true;
	access.ui.start();

	let finish!: () => void;
	const pending = new Promise<void>((resolve) => {
		finish = resolve;
	});
	let update!: (partial: AgentToolResult<unknown>) => void;
	const job = await jobs.start({
		tool: "bash",
		toolCallId: LAUNCH_CALL,
		label: "Run focused integration checks",
		run: async (_signal, onUpdate) => {
			update = onUpdate;
			onUpdate({ content: [{ type: "text", text: "first live output" }] });
			await pending;
			return { content: [{ type: "text", text: "final output" }], isError: outcome === "failed" };
		},
	});
	const fixture = { mode, harnesses: [harness], runtime, finish };
	fixtures.push(fixture);
	await vi.waitFor(() => expect(jobs.get(job.id).output).toBe("first live output"));
	access.jobsRenderCoalescer?.flush();
	await terminal.waitForRender();
	return { ...fixture, harness, access, host, terminal, source, listeners, jobs, job, update };
}

async function acknowledgeLaunch(fixture: Awaited<ReturnType<typeof createFixture>>) {
	const { harness, access, job } = fixture;
	const model = harness.getModel();
	const args = { command: job.label, background: true };
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: LAUNCH_CALL, name: "bash", arguments: args }],
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
	const result = jobResult(job);
	await harness.session.sessionWriter.appendMessage(assistant);
	await harness.session.sessionWriter.appendMessage({
		...result,
		role: "toolResult",
		toolCallId: LAUNCH_CALL,
		toolName: "bash",
		isError: false,
		timestamp: Date.now(),
	});
	await access.handleEvent({ type: "tool_execution_start", toolCallId: LAUNCH_CALL, toolName: "bash", args });
	await access.handleEvent({
		type: "tool_execution_end",
		toolCallId: LAUNCH_CALL,
		toolName: "bash",
		result,
		isError: false,
	});
	access.jobsRenderCoalescer?.flush();
	const card = access.chatContainer.children.find((child) => child instanceof PresentedToolComponent);
	if (!card) throw new Error("Expected the live background launch card");
	return card;
}

describe("interactive background jobs", () => {
	it("registers /work, and no longer /jobs or /subagents, as a built-in local command", () => {
		expect(BUILTIN_SLASH_COMMANDS.find((command) => command.name === "work")?.description).toContain("jobs");
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "jobs" || command.name === "subagents")).toBe(
			false,
		);
	});

	it.each(["regular", "fullscreen"] as const)(
		"opens /work during a foreground wait without cancelling work (%s)",
		async (tuiMode) => {
			const { harness, access, jobs, job, terminal, listeners, update, finish } = await createFixture(tuiMode);
			vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);
			const prompt = vi.spyOn(harness.session, "prompt");
			const abort = vi.spyOn(harness.session, "abort");
			const cancel = vi.spyOn(jobs, "cancel");
			let waitSettled = false;
			const waiting = jobs.wait([job.id]).then(() => {
				waitSettled = true;
			});

			await access.defaultEditor.onSubmit?.(" /work ");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBeInstanceOf(WorkInspector);
			expect(listeners.size).toBe(1);
			terminal.sendInput("\r");
			await vi.waitFor(async () => {
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("first live output");
			});
			update({ content: [{ type: "text", text: "latest inspector output" }] });
			// The job keeps its output itself: the inspector reads it again while it runs.
			await vi.waitFor(
				async () => {
					await terminal.waitForRender();
					expect(terminal.getViewport().join("\n")).toContain("latest inspector output");
				},
				{ timeout: 3000 },
			);
			expect(waitSettled).toBe(false);
			expect(prompt).not.toHaveBeenCalled();
			expect(access.pendingUserInputs).toEqual([]);

			terminal.sendInput("\x1b");
			terminal.sendInput("\x1b");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBe(access.editor);
			expect(access.workInspector).toBeUndefined();
			expect(abort).not.toHaveBeenCalled();
			expect(cancel).not.toHaveBeenCalled();
			expect(jobs.get(job.id).status).toBe("running");
			finish();
			await waiting;
		},
	);

	it("says how work ended when no notice or tool call reports it", async () => {
		const { access, runtime, terminal } = await createFixture("regular");
		runtime.work.register({
			kind: "ext:test/install",
			delivery: "none",
			cancellable: true,
			maxActive: 2,
			title: () => "Install rust-analyzer",
		});
		const installed = await runtime.work.start("ext:test/install", null, async () => ({
			outcome: "completed",
			result: { summary: "rust-analyzer is ready\nmore detail" },
		}));
		const denied = await runtime.work.start("ext:test/install", null, async () => ({
			outcome: "failed",
			error: "denied",
		}));
		await runtime.work.settled(installed.workId);
		await runtime.work.settled(denied.workId);
		await vi.waitFor(async () => {
			await terminal.waitForRender();
			const chat = stripAnsi(access.chatContainer.render(100).lines.join("\n"));
			expect(chat).toContain("Install rust-analyzer completed: rust-analyzer is ready");
			expect(chat).toContain("Install rust-analyzer failed: denied");
			expect(chat).not.toContain("more detail");
		});
		// The job its tool call reports says nothing here.
		expect(stripAnsi(access.chatContainer.render(100).lines.join("\n"))).not.toContain(
			"Run focused integration checks",
		);
	});

	it.each(["regular", "fullscreen"] as const)(
		"keeps a one-row work line in the footer below the editor beside a wide plan (%s)",
		async (tuiMode) => {
			const { access, terminal, runtime, job } = await createFixture(tuiMode, 160, true);
			// A job's last output line is its progress, which its live work value carries a coalescing
			// interval after the output: wait for it, so the line is read as it settles.
			await vi.waitFor(() =>
				expect(runtime.live.get(liveKey("work", job.id))).toMatchObject({
					progress: { text: "first live output" },
				}),
			);
			await terminal.waitForRender();
			const viewport = terminal.getViewport();
			const statusRow = viewport.findIndex((line) => line.includes("Work · ● running"));
			const editorRow = viewport.findIndex((line) => line.includes("ASK VOLT"));
			expect(statusRow).toBeGreaterThanOrEqual(0);
			expect(statusRow).toBeGreaterThan(editorRow);
			expect(viewport.join("\n")).toContain("Keep the plan visible");
			expect(viewport.filter((line) => line.includes("Work · ● running"))).toHaveLength(1);
			expect(viewport[statusRow]).toContain("Run focused integration checks · first live output");
			// The output shows only as the work line's progress: not in the transcript or the plan pane.
			expect(viewport.filter((line) => line.includes("first live output"))).toEqual([viewport[statusRow]]);
			expect(access.workStatus.render(80).lines).toHaveLength(1);

			access.ui.setFocus(access.editor);
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBeInstanceOf(WorkInspector);
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBe(access.editor);
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"removes the work line once the job finished and keeps it in the inspector (%s)",
		async (tuiMode) => {
			const { access, terminal, jobs, job, finish } = await createFixture(tuiMode);
			expect(terminal.getViewport().join("\n")).toContain("Work · ● running");
			expect(terminal.getViewport().join("\n")).not.toContain("first live output");
			finish();
			await jobs.wait([job.id]);
			access.jobsRenderCoalescer?.flush();
			await terminal.waitForRender();
			const settled = terminal.getViewport().join("\n");
			expect(settled).not.toContain("Work · ");
			expect(settled).not.toContain("final output");
			expect(access.workStatus.render(80).lines).toEqual([]);
			expect(access.ui.getFocusedComponent()).toBe(access.editor);
			await access.defaultEditor.onSubmit?.("/work");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("✓ completed");
			terminal.sendInput("\r");
			await vi.waitFor(async () => {
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("final output");
			});
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"shows one main failed-job card, its notice, and a compact inspection (%s)",
		async (tuiMode) => {
			const fixture = await createFixture(tuiMode, 80, false, "failed");
			const { access, harness, terminal, jobs, job, finish } = fixture;
			await acknowledgeLaunch(fixture);
			finish();
			await jobs.wait([job.id]);
			const notice: CustomMessage = {
				role: "custom",
				customType: WORK_NOTICE_CUSTOM_TYPE,
				content: `${job.label} (job ${job.id}) failed.`,
				display: true,
				details: { workId: job.id, kind: "job", title: job.label, outcome: "failed" },
				timestamp: Date.now(),
			};
			await harness.session.sessionWriter.appendCustomMessageEntry(
				notice.customType,
				notice.content,
				notice.display,
				notice.details,
			);
			await access.handleEvent({ type: "message_start", message: notice });
			access.jobsRenderCoalescer?.flush();
			const notification = access.chatContainer.children.find((child) => child instanceof PresentedMessageComponent);
			expect(
				stripAnsi(notification?.render(120).lines.join(" ") ?? "")
					.replace(/\s+/g, " ")
					.trim(),
			).toContain(`(job ${job.id}) failed.`);
			const launch = harness.sessionManager
				.getConversationState()
				.context.messages.find((message) => message.role === "assistant");
			if (!launch || launch.role !== "assistant") throw new Error("Expected launch message");
			const args = { action: "wait" as const, ids: [job.id] };
			const toolCallId = "collect-failed-job";
			await harness.session.sessionWriter.appendMessage({
				...launch,
				content: [{ type: "toolCall", name: "jobs", id: toolCallId, arguments: args }],
			});
			await access.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "jobs", args });
			const result = await createJobsTool({ jobs }).execute(toolCallId, args);
			await harness.session.sessionWriter.appendMessage({
				...result,
				role: "toolResult",
				toolName: "jobs",
				toolCallId,
				isError: true,
				timestamp: Date.now(),
			});
			await access.handleEvent({ type: "tool_execution_end", toolCallId, toolName: "jobs", result, isError: true });
			await terminal.waitForRender();
			const collapsed = stripAnsi(access.chatContainer.render(80).lines.join("\n"));
			// The launch's title and its job's line, the notice, and the wait's table row.
			expect(collapsed.match(/Run focused integration checks/g)).toHaveLength(4);
			expect(collapsed.match(/final output/g)).toHaveLength(1);
			expect(collapsed).toContain("$ Run focused integration checks");
			expect(collapsed).toContain("Failed · Run focused integration checks");
			expect(collapsed).toContain(`jobs wait ${job.id}`);
			expect(collapsed).toContain("1 failed");
			expect(collapsed).not.toContain("terminal (any)");
			const saved = harness.sessionManager.getConversationState().context;
			terminal.sendInput("\x0f");
			await terminal.waitForRender();
			const expanded = stripAnsi(access.chatContainer.render(80).lines.join("\n"));
			expect(expanded).toContain(`jobs wait ${job.id}`);
			expect(expanded).toContain(job.id);
			expect(expanded.match(/final output/g)).toHaveLength(2);
			terminal.sendInput("\x0f");
			access.renderCurrentSessionState();
			expect(stripAnsi(access.chatContainer.render(80).lines.join("\n"))).toBe(collapsed);
			expect(harness.sessionManager.getConversationState().context).toEqual(saved);
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
		expect(inspector).toBeInstanceOf(WorkInspector);
		closeExtension();
		await extension;
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBe(inspector);
		expect(access.workInspector).toBe(inspector);
		terminal.sendInput("\x1b");
		await terminal.waitForRender();
		expect(access.ui.getFocusedComponent()).toBe(access.editor);
		expect(access.workInspector).toBeUndefined();
		expect(listeners.size).toBe(1);
	});

	it.each(["regular", "fullscreen"] as const)(
		"keeps confirmations visible and prevents inspection keys from approving them (%s)",
		async (tuiMode) => {
			const { access, terminal, listeners, jobs, job } = await createFixture(tuiMode);
			await access.defaultEditor.onSubmit?.("/work");
			await terminal.waitForRender();
			let resolved = false;
			const confirmation = access
				.showExtensionConfirm("Permission required", "Allow the requested action?")
				.then((value) => {
					resolved = true;
					return value;
				});
			await terminal.waitForRender();
			expect(access.workInspector).toBeUndefined();
			expect(listeners.size).toBe(1);
			expect(terminal.getViewport().join("\n")).toContain("Permission required");
			expect(resolved).toBe(false);
			// Opening the inspector above a visible pending confirmation must keep its input separate.
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			terminal.sendInput("\r");
			await vi.waitFor(async () => {
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("Following latest");
			});
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
			expect(access.ui.getFocusedComponent()).toBeInstanceOf(WorkInspector);
			const component = new Text("Dedicated confirmation content", 0, 0);
			ready(component);
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBe(component);
			expect(access.workInspector).toBeUndefined();
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
		"restores login input after account selection interrupts work inspection (%s, cancel: %s)",
		async (tuiMode, cancel) => {
			const { access, terminal, jobs, job } = await createFixture(tuiMode);
			const input = vi.fn();
			const dialog = Object.assign(new Text("Waiting for login input", 0, 0), { handleInput: input });
			access.activateView({ regularComponents: [dialog], fullscreenRoot: dialog }, dialog);
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBeInstanceOf(WorkInspector);
			const selected = access.showOAuthLoginSelect(dialog, {
				message: "Choose an account",
				options: [{ id: "first", label: "First account" }],
			});
			await terminal.waitForRender();
			expect(access.workInspector).toBeUndefined();
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
				.getConversationState()
				.context.messages.find((message) => message.role === "assistant");
			if (!assistant || assistant.role !== "assistant") throw new Error("Expected launch message");
			const toolCallId = "pending-job-wait";
			const args = { action: "wait" as const, ids: [job.id] };
			await harness.session.sessionWriter.appendMessage({
				...assistant,
				content: [{ type: "toolCall", id: toolCallId, name: "jobs", arguments: args }],
			});
			await access.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "jobs", args });
			const waiting = createJobsTool({ jobs }).execute(toolCallId, args);
			for (let index = 0; index < 3; index++) {
				terminal.sendInput("\x14");
				update({ content: [{ type: "text", text: `live wait output ${index}` }] });
				access.jobsRenderCoalescer?.flush();
				await terminal.waitForRender();
				const card = access.chatContainer.children
					.filter((child) => child instanceof PresentedToolComponent)
					.at(-1);
				if (!card) throw new Error("Expected pending wait card");
				const output = stripAnsi(card.render(80).lines.join("\n"));
				expect(output).toContain("Waiting for background job");
				expect(output).toContain("jobs wait");
				// The job's own launch card above shows it live, as the job reports it.
				const transcript = stripAnsi(access.chatContainer.render(80).lines.join("\n"));
				expect(transcript).toContain(`Running · ${job.label}`);
				expect(transcript).not.toContain("Running at capture");
			}
			finish();
			const result = await waiting;
			await access.handleEvent({ type: "tool_execution_end", toolCallId, toolName: "jobs", result, isError: false });
			const card = access.chatContainer.children.filter((child) => child instanceof PresentedToolComponent).at(-1);
			if (!card) throw new Error("Expected completed wait card");
			const collapsed = stripAnsi(card.render(80).lines.join("\n"));
			expect(collapsed).toContain("completed");
			expect(collapsed).not.toContain("final output");
			card.setExpanded(true);
			const output = stripAnsi(card.render(80).lines.join("\n"));
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
				expect(inspector).toBeInstanceOf(WorkInspector);
				access.ui.setFocus(inspector);
				expect(access.workInspector).toBe(inspector);
				release();
				await operation;
				await terminal.waitForRender();
				expect(access.workInspector).toBeUndefined();
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
			await jobs.wait([job.id]);
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
				expect(access.ui.getFocusedComponent()).toBeInstanceOf(WorkInspector);
				expect(access.workInspector).toBeDefined();
				release();
				expect(await reloading).toBe(!failed);
				await terminal.waitForRender();
				expect(access.workInspector).toBeUndefined();
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

	it("keeps follow-up /work local and cancels only the selected job after confirmation", async () => {
		const { harness, access, jobs, terminal, job, listeners } = await createFixture("fullscreen");
		vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);
		const prompt = vi.spyOn(harness.session, "prompt");
		const other = await jobs.start({
			tool: "bash",
			toolCallId: "second",
			label: "Other job",
			run: async () => ({ content: [] }),
		});
		await jobs.wait([other.id]);
		access.editor.setText("/work");
		await access.handleFollowUp();
		await terminal.waitForRender();
		expect(prompt).not.toHaveBeenCalled();
		// The running job is listed first, and selected.
		expect(terminal.getViewport().join("\n")).toContain("1 running · 1 completed");
		terminal.sendInput("\x0b");
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Cancel this work?");
		await terminal.waitForRender();
		expect(jobs.get(job.id).status).toBe("running");
		terminal.sendInput("\r");
		await terminal.waitForRender();
		await vi.waitFor(() => expect(jobs.get(job.id).status).toBe("cancelling"));
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
			toolCallId: LAUNCH_CALL,
			toolName: "bash",
			args: { command: job.label, background: true },
		});
		await access.handleEvent({
			type: "tool_execution_end",
			toolCallId: LAUNCH_CALL,
			toolName: "bash",
			result: jobResult(job),
			isError: false,
		});
		const card = access.chatContainer.children.find((child) => child instanceof PresentedToolComponent);
		if (!card) throw new Error("Expected the live background launch card");
		access.jobsRenderCoalescer?.flush();
		const invalidate = vi.spyOn(card, "invalidate");
		const invalidateHistory = vi.spyOn(history, "invalidate");
		for (let index = 0; index < 100; index++) update({ content: [{ type: "text", text: `output ${index}` }] });
		access.jobsRenderCoalescer?.flush();
		expect(invalidate.mock.calls.length).toBeLessThanOrEqual(2);
		expect(invalidate).toHaveBeenCalled();
		expect(invalidateHistory).not.toHaveBeenCalled();
		expect(access.chatContainer.children).toContain(history);
		expect(stripAnsi(card.render(100).lines.join("\n"))).toContain("output 99");
		finish();
		await jobs.wait([job.id]);
		access.jobsRenderCoalescer?.flush();
		expect(stripAnsi(card.render(100).lines.join("\n"))).toContain("Completed");
		invalidate.mockClear();
		access.jobsRenderCoalescer?.flush();
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("does not invalidate completed inspections while their worker remains active", async () => {
		const fixture = await createFixture("regular");
		const { access, jobs, job, update } = fixture;
		const launch = await acknowledgeLaunch(fixture);
		const inspections: PresentedToolComponent[] = [];
		for (let index = 0; index < 200; index++) {
			const toolCallId = `completed-inspection-${index}`;
			const args: { action: "read"; id: string } | { action: "wait"; ids: string[]; timeoutMs: number } =
				index % 2 === 0 ? { action: "read", id: job.id } : { action: "wait", ids: [job.id], timeoutMs: 0 };
			await access.handleEvent({ type: "tool_execution_start", toolCallId, toolName: "jobs", args });
			const component = access.chatContainer.children.at(-1);
			if (!(component instanceof PresentedToolComponent)) throw new Error("Expected inspection component");
			await access.handleEvent({
				type: "tool_execution_end",
				toolCallId,
				toolName: "jobs",
				result: await createJobsTool({ jobs }).execute(toolCallId, args),
				isError: false,
			});
			inspections.push(component);
		}
		access.jobsRenderCoalescer?.flush();
		const invalidations = inspections.map((component) => vi.spyOn(component, "invalidate"));
		const launchInvalidation = vi.spyOn(launch, "invalidate");
		await access.handleEvent({
			type: "tool_execution_start",
			toolCallId: "pending-inspection",
			toolName: "jobs",
			args: { action: "wait", ids: [job.id] },
		});
		const pending = access.chatContainer.children.at(-1);
		if (!(pending instanceof PresentedToolComponent)) throw new Error("Expected pending inspection");
		const pendingInvalidation = vi.spyOn(pending, "invalidate");
		for (let index = 0; index < 10; index++)
			update({ content: [{ type: "text", text: `latest live output ${index}` }] });
		access.jobsRenderCoalescer?.flush();
		await new Promise((resolve) => setTimeout(resolve, 1100));
		for (const invalidate of invalidations) expect(invalidate).not.toHaveBeenCalled();
		expect(launchInvalidation).toHaveBeenCalled();
		expect(pendingInvalidation).toHaveBeenCalled();
		// The launch card shows the job's live output; a pending wait shows what it waits for.
		expect(stripAnsi(launch.render(80).lines.join("\n"))).toContain("latest live output 9");
		expect(stripAnsi(pending.render(80).lines.join("\n"))).toContain("Waiting for background job");
		expect(stripAnsi(inspections[0].render(80).lines.join("\n"))).not.toContain("first live output");
		inspections[0].setExpanded(true);
		expect(stripAnsi(inspections[0].render(80).lines.join("\n"))).toContain("first live output");
	});

	it.each(["completed", "failed"] as const)(
		"preserves %s launch status and final output through repeated transcript reconstruction",
		async (outcome) => {
			const fixture = await createFixture("regular", 80, false, outcome);
			const { access, harness, terminal, job, jobs, finish } = fixture;
			const card = await acknowledgeLaunch(fixture);
			const transcript = harness.sessionManager.getConversationState().context;
			const modelMessages = harness.session.messages;
			finish();
			await jobs.wait([job.id]);
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
			expect(harness.sessionManager.getConversationState().context).toEqual(transcript);
			expect(harness.session.messages).toEqual(modelMessages);
			const invalidate = vi.spyOn(card, "invalidate");
			const repaint = vi.spyOn(access.ui, "requestRender");
			await new Promise((resolve) => setTimeout(resolve, 1100));
			expect(repaint).not.toHaveBeenCalled();
			const other = await jobs.start({
				tool: "bash",
				toolCallId: "unrelated-work",
				label: "Unrelated work",
				run: async (_signal, update) => {
					for (let index = 0; index < 100; index++)
						update({ content: [{ type: "text", text: `unrelated output ${index}` }] });
					return { content: [] };
				},
			});
			await jobs.wait([other.id]);
			access.jobsRenderCoalescer?.flush();
			expect(invalidate).not.toHaveBeenCalled();
			expect(stripAnsi(access.chatContainer.render(100).lines.join("\n"))).toContain("final output");
		},
	);

	it("releases a settled launch binding once its job leaves the list, and replays its recorded outcome", async () => {
		const fixture = await createFixture("regular");
		const { access, jobs, job, finish, source } = fixture;
		const card = await acknowledgeLaunch(fixture);
		finish();
		await jobs.wait([job.id]);
		access.jobsRenderCoalescer?.flush();
		const dispose = vi.spyOn(card, "dispose");
		for (let index = 0; index < JOB_LIST_MAX; index++) {
			const other = await jobs.start({
				tool: "bash",
				toolCallId: `newer-work-${index}`,
				label: "New work",
				run: async () => ({ content: [] }),
			});
			await jobs.wait([other.id]);
		}
		expect(jobs.list()).toHaveLength(JOB_LIST_MAX);
		expect(jobs.list().some((listed) => listed.id === job.id)).toBe(false);
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
		for (let index = 0; index < 2; index++) {
			access.renderCurrentSessionState();
			// A finished job's card shows its recorded outcome, not the running state it captured.
			const output = stripAnsi(access.chatContainer.render(100).lines.join("\n"));
			expect(output).toContain("Completed · Run focused integration checks");
			expect(output).toContain("final output");
			expect(output).not.toContain("Running at capture");
		}
		expect(source.get(job.id).status).toBe("completed");
	});

	it.each(["regular", "fullscreen"] as const)(
		"covers both transcript edges in the work inspector and restores editor input (%s)",
		async (tuiMode) => {
			const { access, terminal } = await createFixture(tuiMode);
			access.chatContainer.addChild(new Text(Array.from({ length: 30 }, () => "X".repeat(80)).join("\n"), 0, 0));
			access.ui.requestRender();
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("X".repeat(80));
			terminal.sendInput("\x1bj");
			await terminal.waitForRender();
			expect(terminal.getViewport().slice(1, -1).join("\n")).not.toContain("X");
			expect(access.ui.getFocusedComponent()).toBeInstanceOf(WorkInspector);
			terminal.sendInput("\x1b");
			terminal.sendInput("editor restored");
			await terminal.waitForRender();
			expect(access.ui.getFocusedComponent()).toBe(access.editor);
			expect(access.editor.getText()).toBe("editor restored");
		},
	);

	it.each([false, true])(
		"closes old subscriptions and releases launch cards before moving to another session (settled: %s)",
		async (settled) => {
			const fixture = await createFixture("regular");
			const { harnesses, access, host, terminal, listeners, update, finish, jobs, job } = fixture;
			const card = await acknowledgeLaunch(fixture);
			if (settled) {
				finish();
				await jobs.wait([job.id]);
				access.jobsRenderCoalescer?.flush();
			}
			const dispose = vi.spyOn(card, "dispose");
			await access.defaultEditor.onSubmit?.("/work");
			await terminal.waitForRender();
			expect(access.workInspector).toBeDefined();
			access.beginSessionReplacementUi();
			expect(listeners.size).toBe(0);
			expect(dispose).toHaveBeenCalledOnce();
			expect(access.workInspector).toBeUndefined();
			const replacement = await createHarness({
				settings: { lsp: { enabled: false }, theme: "dark", quietStartup: true },
			});
			harnesses.push(replacement);
			// The TUI moves to the replacement's conversation as one of its structural intents moves it.
			await host.move(access.client, createFakeConversation(replacement.session).conversation);
			access.renderCurrentSessionState();
			update({ content: [{ type: "text", text: "stale runtime output" }] });
			await terminal.waitForRender();
			expect(access.workStatus.render(80).lines).toEqual([]);
			expect(terminal.getViewport().join("\n")).not.toContain("stale runtime output");
			await access.defaultEditor.onSubmit?.("/work");
			await terminal.waitForRender();
			expect(terminal.getViewport().join("\n")).toContain("No work in this conversation.");
		},
	);
});
