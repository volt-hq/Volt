import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { Component, TUI } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import type { HostActionRequest } from "../../../src/core/session/host-actions.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import type { UserInputRequest, UserInputResponse } from "../../../src/core/user-input.ts";
import type { WorkContext, WorkExecution } from "../../../src/core/work/registry.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../../src/index.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import type { createInteractiveTui } from "../../../src/modes/interactive/interactive-mode.ts";
import { loseConversationLock, loseLog } from "../../lost-conversation-lock.ts";
import { connectTestClient, openTestHost, type TestHost } from "../../utilities/host-client.ts";
import { createLiveRecorder } from "../../utilities/live-recorder.ts";
import { testExtension } from "../../utilities.ts";
import { getMessageText } from "../harness.ts";
import { createTuiHarness } from "../tui-harness.ts";

type View = { regularComponents: readonly Component[]; fullscreenRoot: Component };
type InteractiveAccess = {
	renderer: ReturnType<typeof createInteractiveTui>;
	ui: TUI;
	editor: CustomEditor;
	conversationView: View;
	activeView: View;
	extensionSelector?: { handleInput(data: string): void };
	isInitialized: boolean;
	showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
	showExtensionConfirm(title: string, message: string): Promise<boolean>;
	showExtensionInput(title: string): Promise<string | undefined>;
	showExtensionEditor(title: string, prefill?: string): Promise<string | undefined>;
	resetExtensionUI(): void;
	setupKeyHandlers(): void;
	setupPlanPaneInputRouting(): void;
	setupEditorSubmitHandler(): void;
	renderWidgets(): void;
	connect(): Promise<void>;
	terminalSurface(): { userInput?: (request: UserInputRequest, signal?: AbortSignal) => Promise<UserInputResponse> };
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

	function extensionStatusEntries(terminal: VirtualTerminal): number {
		const match = /extension status: (\d+) entries/.exec(viewport(terminal));
		if (!match) throw new Error("extension status is not rendered");
		return Number(match[1]);
	}

	/** InteractiveMode as the client of a conversation over the faux provider, without the main input loop. */
	async function startInteractiveMode(responses: string[], options: { extensionFactory?: ExtensionFactory } = {}) {
		const harness = await createTuiHarness({
			responses,
			...(options.extensionFactory === undefined ? {} : { extension: options.extensionFactory }),
		});
		cleanups.push(() => harness.cleanup());
		const tui = await harness.startMode({ columns: 140, rows: 30 });
		const access = tui.mode as unknown as InteractiveAccess;
		const handleFatalRuntimeError = vi.fn(async () => {});
		access.handleFatalRuntimeError = handleFatalRuntimeError;
		const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		cleanups.push(() => exit.mockRestore());
		return { access, terminal: tui.terminal, conversation: harness.startup, handleFatalRuntimeError, exit };
	}

	it("wakes busy waiters after a lost lock fails the next commit", async () => {
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

		await loseConversationLock(staleSession.sessionManager);
		const stalePrompt = Promise.allSettled([staleSession.prompt("stale prompt")]);
		await expect(withinTimeout(runtime.lost, "runtime.lost")).resolves.toMatchObject({
			reason: "fence_conflict",
		});
		await stalePrompt;
		await withinTimeout(staleSession.waitForNotBusy(), "waitForNotBusy()");
		expect(staleSession.isBusy).toBe(false);

		// The store keeps what was committed; the stale prompt never landed and nothing reloads.
		expect(await readStoredMessageTexts(sessionRef)).toEqual(["tui prompt", "tui reply"]);
		expect(runtime.session).toBe(staleSession);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(unhandledRejections).toEqual([]);
	});

	it("ends the interactive session, showing an extension status that reads the lost session until it exits", async () => {
		const extensionStatus = (volt: ExtensionAPI) => {
			// Reads the session whenever a run ends, and shows what it read as a status item.
			const show = (ctx: ExtensionContext) =>
				ctx.ui.setStatus("entries", `extension status: ${ctx.sessionManager.getBranch().length} entries`);
			volt.on("session_start", (_event, ctx) => show(ctx));
			volt.on("agent_end", (_event, ctx) => show(ctx));
		};
		const { access, terminal, conversation, handleFatalRuntimeError, exit } = await startInteractiveMode(
			["tui reply"],
			{ extensionFactory: extensionStatus },
		);

		await conversation.session.prompt("tui prompt");
		await vi.waitFor(async () => {
			await terminal.waitForRender();
			expect(extensionStatusEntries(terminal)).toBeGreaterThan(0);
		});

		const staleSession = conversation.session;
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
		const { access, terminal, conversation, handleFatalRuntimeError, exit } = await startInteractiveMode(
			["tui reply"],
			{ extensionFactory: pickCommand },
		);
		await conversation.session.prompt("tui prompt");
		const staleSession = conversation.session;

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
		const { conversation, handleFatalRuntimeError, exit } = await startInteractiveMode([], {
			extensionFactory: stuckCommand,
		});
		const staleSession = conversation.session;

		void staleSession.prompt("/stuck");
		const commandSignal = await commandStarted.promise;
		expect(staleSession.isBusy).toBe(true);

		await loseLog(staleSession.sessionWriter);

		await vi.waitFor(() => expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1), { timeout: 5_000 });
		expect(commandSignal.aborted).toBe(true);
		expect(exit).not.toHaveBeenCalled();
	});

	it("settles every pending TUI dialog and question when extension UI is reset", async () => {
		const { access, terminal } = await startInteractiveMode([]);
		access.editor.setText("draft");

		// One dialog of each kind, stacked in opening order, and a request_user_input question.
		const select = access.showExtensionSelector("Select dialog", ["a", "b"]);
		const input = access.showExtensionInput("Input dialog");
		const editor = access.showExtensionEditor("Editor dialog", "prefill");
		const userInput = access.terminalSurface().userInput;
		if (!userInput) throw new Error("The TUI asks no questions");
		const question = userInput({
			questions: [
				{
					id: "target",
					header: "Target",
					question: "Question dialog?",
					options: [
						{ label: "Staging", description: "The staging target." },
						{ label: "Production", description: "The production target." },
					],
				},
			],
		}).then(
			(value) => ({ status: "fulfilled" as const, value }),
			(reason: unknown) => ({ status: "rejected" as const, reason }),
		);
		await terminal.waitForRender();
		expect(viewport(terminal)).toContain("Question dialog?");

		access.resetExtensionUI();

		await expect(select).resolves.toBeUndefined();
		await expect(input).resolves.toBeUndefined();
		await expect(editor).resolves.toBeUndefined();
		expect((await question).status).toBe("rejected");
		await terminal.waitForRender();
		expect(access.activeView).toBe(access.conversationView);
		expect(access.ui.getFocusedComponent()).toBe(access.editor);
		expect(access.editor.getText()).toBe("draft");
		const screen = viewport(terminal);
		for (const label of ["Select dialog", "Input dialog", "Editor dialog", "Question dialog?"]) {
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
		const { access, terminal, conversation } = await startInteractiveMode([]);
		const liveState = conversation.liveState;
		const actions = conversation.session.hostActions;
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
		expect(conversation.work.list().map((record) => record.outcome)).toEqual(["completed", "cancelled", "cancelled"]);

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
