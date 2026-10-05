import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { type Component, createRenderFrame, type TUI } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ReadonlyFooterDataProvider } from "../../../src/core/footer-data-provider.ts";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import type { HostClient } from "../../../src/core/host/targets.ts";
import type { ExtensionTerminalUI } from "../../../src/core/session/extension-binding.ts";
import type { HostActionRequest } from "../../../src/core/session/host-actions.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import type { WorkContext, WorkExecution } from "../../../src/core/work/registry.ts";
import { type ExtensionAPI, type ExtensionFactory, ExtensionUIDismissedError } from "../../../src/index.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { FooterComponent } from "../../../src/modes/interactive/components/footer.ts";
import { createInteractiveTui, InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { loseConversationLock, loseLog } from "../../lost-conversation-lock.ts";
import { connectTestClient, openTestHost, type TestHost } from "../../utilities/host-client.ts";
import { createLiveRecorder } from "../../utilities/live-recorder.ts";
import { testExtension } from "../../utilities.ts";
import { getMessageText } from "../harness.ts";

type View = { regularComponents: readonly Component[]; fullscreenRoot: Component };
type InteractiveAccess = {
	followWork(): void;
	renderer: ReturnType<typeof createInteractiveTui>;
	ui: TUI;
	editor: CustomEditor;
	conversationView: View;
	activeView: View;
	extensionSelector?: { handleInput(data: string): void };
	isInitialized: boolean;
	createExtensionTerminalUI(): ExtensionTerminalUI;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
	showExtensionConfirm(title: string, message: string): Promise<boolean>;
	showExtensionInput(title: string): Promise<string | undefined>;
	showExtensionEditor(title: string, prefill?: string): Promise<string | undefined>;
	resetExtensionUI(): void;
	setupKeyHandlers(): void;
	setupPlanPaneInputRouting(): void;
	setupEditorSubmitHandler(): void;
	renderWidgets(): void;
	client: HostClient;
	showSessionExtensions(session: AgentSession): void;
	subscribeToAgent(session: AgentSession): void;
	activateView(view: View, focus: Component, forceRender?: boolean): void;
	handleFatalRuntimeError: (prefix: string, error: unknown, options?: { unsentDraft?: string }) => Promise<void>;
};

describe("regression #525: ending a session whose saved state could not be confirmed", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(() => {
		initTheme(undefined, false);
	});

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	/** Open a conversation over the faux provider in a host of its own, with no client attached yet. */
	async function openConversationForTest(
		responses: string[],
		options: { extensionFactory?: ExtensionFactory } = {},
	): Promise<TestHost & { tempDir: string }> {
		const tempDir = join(tmpdir(), `volt-525-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = createFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						testExtension(
							"test-extension-1",
							(volt: ExtensionAPI) => {
								volt.registerProvider(faux.getModel().provider, {
									baseUrl: faux.getModel().baseUrl,
									apiKey: "faux-key",
									api: faux.api,
									streamSimple: faux.streamSimple,
									models: faux.models.map((registeredModel) => ({
										id: registeredModel.id,
										name: registeredModel.name,
										api: registeredModel.api,
										reasoning: registeredModel.reasoning,
										input: registeredModel.input,
										cost: registeredModel.cost,
										contextWindow: registeredModel.contextWindow,
										maxTokens: registeredModel.maxTokens,
									})),
								});
								options.extensionFactory?.(volt);
							},
							["providers"],
						),
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const sessionManager = await SessionManager.create(tempDir);
		const { host, conversation } = await openTestHost(createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir: tempDir,
			sessionManager,
		});

		cleanups.push(async () => {
			await host.dispose().catch(() => {});
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		return { host, conversation, tempDir };
	}

	function requireSessionRef(session: AgentSession): SessionReference {
		const sessionRef = session.sessionRef;
		if (!sessionRef) throw new Error("expected a persisted session");
		return sessionRef;
	}

	async function readStoredMessageTexts(sessionRef: SessionReference): Promise<string[]> {
		const manager = await SessionManager.openReadOnly(sessionRef);
		try {
			return manager.getConversationState().context.messages.map(getMessageText);
		} finally {
			await manager.closePersistence();
		}
	}

	function withinTimeout<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms);
		});
		return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
	}

	function viewport(terminal: VirtualTerminal): string {
		return terminal.getViewport().join("\n");
	}

	function extensionFooterEntries(terminal: VirtualTerminal): number {
		const match = /extension footer: (\d+) entries/.exec(viewport(terminal));
		if (!match) throw new Error("extension footer is not rendered");
		return Number(match[1]);
	}

	function createFooterData(): ReadonlyFooterDataProvider {
		return {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map<string, string>(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		};
	}

	/** Drive InteractiveMode on a real host and VirtualTerminal, without the main input loop. */
	async function startInteractiveMode(opened: TestHost & { tempDir: string }) {
		const { host, conversation, tempDir } = opened;
		const mode = new InteractiveMode(host, conversation, { tuiMode: "regular" });
		cleanups.push(() => mode.stop());
		const access = mode as unknown as InteractiveAccess;
		const handleFatalRuntimeError = vi.fn(async () => {});
		access.handleFatalRuntimeError = handleFatalRuntimeError;
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		cleanups.push(() => exit.mockRestore());
		const terminal = new VirtualTerminal(140, 30);
		access.renderer = createInteractiveTui({
			tuiMode: "regular",
			showHardwareCursor: false,
			logDirectory: tempDir,
			terminal,
		});
		access.renderWidgets();
		access.setupKeyHandlers();
		access.setupPlanPaneInputRouting();
		access.setupEditorSubmitHandler();
		access.activateView(access.conversationView, access.editor, false);
		access.isInitialized = true;
		access.ui.start();
		await host.attach(access.client, conversation);
		access.showSessionExtensions(conversation.session);
		access.subscribeToAgent(conversation.session);
		access.followWork();
		return { access, terminal, handleFatalRuntimeError, exit };
	}

	it("keeps the footer rendering and wakes busy waiters after a lost lock fails the next commit", async () => {
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);
		cleanups.push(() => {
			process.off("unhandledRejection", onUnhandledRejection);
		});

		const opened = await openConversationForTest(["tui reply", "never sent"]);
		// A client binds the extensions the way interactive mode does, on every conversation it joins.
		const runtime = await connectTestClient(opened.host, opened.conversation, { surface: {} });
		await runtime.session.prompt("tui prompt");
		const sessionRef = requireSessionRef(runtime.session);
		const staleSession = runtime.session;
		const renderedFooter = new FooterComponent(staleSession, createFooterData());
		expect(stripAnsi(renderedFooter.render(120).lines[0])).toContain("faux-1");

		await loseConversationLock(staleSession.sessionManager);
		const stalePrompt = Promise.allSettled([staleSession.prompt("stale prompt")]);
		await expect(withinTimeout(runtime.lost, "runtime.lost")).resolves.toMatchObject({
			reason: "fence_conflict",
		});
		await stalePrompt;
		await withinTimeout(staleSession.waitForNotBusy(), "waitForNotBusy()");
		expect(staleSession.isBusy).toBe(false);

		// Every frame renders the footer; it must not throw after the loss.
		renderedFooter.invalidate();
		expect(stripAnsi(renderedFooter.render(120).lines[0])).toContain("faux-1");
		expect(stripAnsi(new FooterComponent(staleSession, createFooterData()).render(120).lines[0])).toContain("faux-1");

		// The store keeps what was committed; the stale prompt never landed and nothing reloads.
		expect(await readStoredMessageTexts(sessionRef)).toEqual(["tui prompt", "tui reply"]);
		expect(runtime.session).toBe(staleSession);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(unhandledRejections).toEqual([]);
	});

	it("ends the interactive session, rendering an extension footer that reads the lost session until it exits", async () => {
		const extensionFooter = (volt: ExtensionAPI) => {
			volt.on("session_start", (_event, ctx) => {
				ctx.ui.setFooter(() => ({
					invalidate() {},
					// Like examples/extensions/custom-footer.ts: reads the session on every frame.
					render: () => createRenderFrame([`extension footer: ${ctx.sessionManager.getBranch().length} entries`]),
				}));
			});
		};
		const opened = await openConversationForTest(["tui reply"], { extensionFactory: extensionFooter });
		const { access, terminal, handleFatalRuntimeError, exit } = await startInteractiveMode(opened);

		await opened.conversation.session.prompt("tui prompt");
		await terminal.waitForRender();
		expect(extensionFooterEntries(terminal)).toBeGreaterThan(0);

		const staleSession = opened.conversation.session;
		await loseConversationLock(staleSession.sessionManager);
		access.editor.setText("unsent draft");

		await Promise.allSettled([staleSession.prompt("stale prompt")]);
		access.ui.requestRender(true);
		await terminal.waitForRender();

		await vi.waitFor(() => expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1), { timeout: 5_000 });
		const [prefix, error, options] = handleFatalRuntimeError.mock.calls[0] as unknown as [
			string,
			Error,
			{ unsentDraft?: string },
		];
		expect(prefix).toBe("Volt stopped this session because its saved state could not be confirmed");
		expect(error.message).toContain("/resume");
		expect(options).toEqual({ unsentDraft: "unsent draft" });
		expect(exit).not.toHaveBeenCalled();
	});

	it("dismisses a command's pending select and ends the session", async () => {
		const selection = Promise.withResolvers<string | undefined>();
		const selectorShown = Promise.withResolvers<void>();
		const pickCommand = (volt: ExtensionAPI) => {
			volt.registerCommand("pick", {
				description: "Waits on a selector without a signal",
				handler: async (_args, ctx) => {
					const choice = ctx.ui.select("Pick a target", ["staging", "production"]);
					selectorShown.resolve();
					selection.resolve(await choice);
				},
			});
		};
		const opened = await openConversationForTest(["tui reply"], { extensionFactory: pickCommand });
		const { access, terminal, handleFatalRuntimeError, exit } = await startInteractiveMode(opened);
		await opened.conversation.session.prompt("tui prompt");
		const staleSession = opened.conversation.session;

		const command = staleSession.prompt("/pick");
		await selectorShown.promise;
		await terminal.waitForRender();
		expect(viewport(terminal)).toContain("Pick a target");
		expect(staleSession.isBusy).toBe(true);

		await loseLog(staleSession.sessionWriter);

		await expect(withinTimeout(selection.promise, "ctx.ui.select()")).resolves.toBeUndefined();
		await expect(withinTimeout(command, "prompt('/pick')")).resolves.toBeUndefined();
		await vi.waitFor(() => expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1), { timeout: 5_000 });
		expect(access.activeView).toBe(access.conversationView);
		expect(access.extensionSelector).toBeUndefined();
		expect(exit).not.toHaveBeenCalled();
	});

	it("ends the session while a command that ignores its signal never finishes", async () => {
		const commandStarted = Promise.withResolvers<AbortSignal>();
		const stuckCommand = (volt: ExtensionAPI) => {
			volt.registerCommand("stuck", {
				description: "Never settles and ignores ctx.signal",
				handler: async (_args, ctx) => {
					commandStarted.resolve(ctx.signal);
					await new Promise<never>(() => {});
				},
			});
		};
		const opened = await openConversationForTest([], { extensionFactory: stuckCommand });
		const { handleFatalRuntimeError, exit } = await startInteractiveMode(opened);
		const staleSession = opened.conversation.session;

		void staleSession.prompt("/stuck");
		const commandSignal = await commandStarted.promise;
		expect(staleSession.isBusy).toBe(true);

		await loseLog(staleSession.sessionWriter);

		await vi.waitFor(() => expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1), { timeout: 5_000 });
		expect(commandSignal.aborted).toBe(true);
		expect(exit).not.toHaveBeenCalled();
	});

	it("settles every pending TUI dialog and component when extension UI is reset", async () => {
		const { access, terminal } = await startInteractiveMode(await openConversationForTest([]));
		const ui = access.createExtensionTerminalUI();
		const settled = <T>(promise: Promise<T>) =>
			promise.then(
				(value) => ({ status: "fulfilled" as const, value }),
				(reason: unknown) => ({ status: "rejected" as const, reason }),
			);
		const customComponent = (label: string) => ({
			invalidate() {},
			render: () => createRenderFrame([label]),
			dispose: vi.fn(),
		});
		access.editor.setText("draft");

		// One dialog of each kind, stacked in opening order.
		const select = access.showExtensionSelector("Select dialog", ["a", "b"]);
		const input = access.showExtensionInput("Input dialog");
		const editor = access.showExtensionEditor("Editor dialog", "prefill");
		const inline = customComponent("inline custom");
		const inlineResult = settled(ui.custom<string>(() => inline));
		const overlay = customComponent("overlay custom");
		const overlayResult = settled(ui.custom<string>(() => overlay, { overlay: true }));
		const lateComponent = customComponent("late custom");
		const lateFactory = Promise.withResolvers<typeof lateComponent>();
		const lateResult = settled(ui.custom<string>(() => lateFactory.promise, { overlay: true }));
		await terminal.waitForRender();
		expect(access.ui.hasOverlay()).toBe(true);
		expect(viewport(terminal)).toContain("overlay custom");

		access.resetExtensionUI();

		await expect(select).resolves.toBeUndefined();
		await expect(input).resolves.toBeUndefined();
		await expect(editor).resolves.toBeUndefined();
		for (const result of [await inlineResult, await overlayResult, await lateResult]) {
			expect(result.status).toBe("rejected");
			expect(result.status === "rejected" && result.reason).toBeInstanceOf(ExtensionUIDismissedError);
		}
		expect(inline.dispose).toHaveBeenCalledTimes(1);
		expect(overlay.dispose).toHaveBeenCalledTimes(1);
		// A factory that resolves after dismissal is disposed and never mounted.
		lateFactory.resolve(lateComponent);
		await vi.waitFor(() => expect(lateComponent.dispose).toHaveBeenCalledTimes(1));
		await terminal.waitForRender();
		expect(access.ui.hasOverlay()).toBe(false);
		expect(access.activeView).toBe(access.conversationView);
		expect(access.ui.getFocusedComponent()).toBe(access.editor);
		expect(access.editor.getText()).toBe("draft");
		const screen = viewport(terminal);
		for (const label of ["Select dialog", "Input dialog", "Editor dialog", "inline custom", "overlay custom"]) {
			expect(screen).not.toContain(label);
		}

		const confirm = access.showExtensionConfirm("Confirm dialog", "Proceed?");
		access.resetExtensionUI();
		await expect(confirm).resolves.toBe(false);

		// Nothing is left to dismiss.
		access.resetExtensionUI();
		expect(access.activeView).toBe(access.conversationView);
	});

	it("shows the live state's dialogs and approvals one at a time and answers them in process", async () => {
		const opened = await openConversationForTest([]);
		const { access, terminal } = await startInteractiveMode(opened);
		const liveState = opened.conversation.liveState;
		const actions = opened.conversation.session.hostActions;
		const request: HostActionRequest = { action: "test.action", title: "Host action" };
		let runs = 0;
		// The install runs until the footer's work line showed its progress.
		const shown = Promise.withResolvers<void>();
		const install = async (ctx: WorkContext): Promise<WorkExecution> => {
			runs++;
			ctx.checkpoint({ text: "Installing the test tool" });
			await shown.promise;
			return { outcome: "completed", result: { summary: "Test tool installed" } };
		};

		// An extension UI reset leaves the live state's approval showing: it is the conversation's.
		const kept = actions.run({ ...request, commandPreview: "npm install" }, install);
		await vi.waitFor(() => expect(viewport(terminal)).toContain("Command: npm install"));
		access.resetExtensionUI();
		expect(access.extensionSelector).toBeDefined();
		access.extensionSelector?.handleInput("\n");
		await vi.waitFor(() =>
			expect(viewport(terminal)).toContain("host_action · Host action · Installing the test tool"),
		);
		shown.resolve();
		await expect(kept).resolves.toMatchObject({ status: "ran", execution: { outcome: "completed" } });
		// It delivers no notice, so a status line says how it ended.
		await vi.waitFor(() => expect(viewport(terminal)).toContain("Host action completed: Test tool installed"));
		await vi.waitFor(() => expect(access.extensionSelector).toBeUndefined());

		// Escape denies; the requester's abort closes the dialog without an answer. Neither runs.
		const denied = actions.run(request, install);
		await vi.waitFor(() => expect(access.extensionSelector).toBeDefined());
		access.extensionSelector?.handleInput("\x1b");
		await expect(denied).resolves.toEqual({ status: "declined" });
		const controller = new AbortController();
		const aborted = actions.run(request, install, { signal: controller.signal });
		await vi.waitFor(() => expect(access.extensionSelector).toBeDefined());
		controller.abort();
		await expect(aborted).resolves.toEqual({ status: "declined", message: "Host action cancelled" });
		await vi.waitFor(() => expect(access.extensionSelector).toBeUndefined());
		expect(runs).toBe(1);
		expect(opened.conversation.work.list().map((record) => record.outcome)).toEqual([
			"completed",
			"cancelled",
			"cancelled",
		]);

		// Dialogs show oldest first; another client's answer closes the one that shows.
		const phone = createLiveRecorder(["confirm", "select"]);
		liveState.attach("phone", phone);
		const first = liveState.request({ kind: "confirm", title: "First dialog", message: "One?" });
		const second = liveState.request({ kind: "select", title: "Second dialog", options: ["x", "y"] });
		await terminal.waitForRender();
		expect(viewport(terminal)).toContain("First dialog");
		expect(viewport(terminal)).not.toContain("Second dialog");
		const firstId = phone.pending()[0]?.requestId ?? "";
		expect(liveState.answer(firstId, { confirmed: false }, "phone")).toBe("accepted");
		await expect(first).resolves.toMatchObject({ status: "answered", clientId: "phone" });
		await vi.waitFor(() => expect(viewport(terminal)).toContain("Second dialog"));
		expect(viewport(terminal)).not.toContain("First dialog");
		access.extensionSelector?.handleInput("\n");
		await expect(second).resolves.toMatchObject({ status: "answered", response: { value: "x" } });
		expect(phone.pending()).toEqual([]);
		await vi.waitFor(() => expect(access.activeView).toBe(access.conversationView));
		expect(access.ui.getFocusedComponent()).toBe(access.editor);
	});
});
