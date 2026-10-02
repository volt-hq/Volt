import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { type Component, createRenderFrame, type TUI } from "@hansjm10/volt-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ExtensionUIContext } from "../../../src/core/extensions/index.ts";
import type { ReadonlyFooterDataProvider } from "../../../src/core/footer-data-provider.ts";
import type { HostActionDecision, HostActionRequest } from "../../../src/core/host-interaction.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import { type ExtensionAPI, type ExtensionFactory, ExtensionUIDismissedError } from "../../../src/index.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { FooterComponent } from "../../../src/modes/interactive/components/footer.ts";
import { createInteractiveTui, InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { getMessageText } from "../harness.ts";

type View = { regularComponents: readonly Component[]; fullscreenRoot: Component };
type InteractiveAccess = {
	renderer: ReturnType<typeof createInteractiveTui>;
	ui: TUI;
	editor: CustomEditor;
	conversationView: View;
	activeView: View;
	extensionSelector?: { handleInput(data: string): void };
	isInitialized: boolean;
	createExtensionUIContext(): ExtensionUIContext;
	requestHostAction(request: HostActionRequest, options?: { signal?: AbortSignal }): Promise<HostActionDecision>;
	resetExtensionUI(): void;
	setupKeyHandlers(): void;
	setupPlanPaneInputRouting(): void;
	setupEditorSubmitHandler(): void;
	renderWidgets(): void;
	bindCurrentSessionExtensions(session: AgentSession): Promise<void>;
	subscribeToAgent(session: AgentSession): void;
	activateView(view: View, focus: Component, forceRender?: boolean): void;
	handleFatalRuntimeError: (prefix: string, error: unknown, options?: { unsentDraft?: string }) => Promise<void>;
};

describe("regression #525: recovering a session whose saved state could not be confirmed", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	beforeAll(() => {
		initTheme(undefined, false);
	});

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		responses: string[],
		options: { extensionFactory?: ExtensionFactory; interactive?: boolean } = {},
	) {
		const tempDir = join(tmpdir(), `volt-525-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = createFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
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
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir: tempDir,
			sessionManager,
		});
		if (!options.interactive) {
			// Bind replacements the way interactive mode does.
			runtime.setRebindSession(async (session) => {
				await session.bindExtensions({});
			});
			await runtime.session.bindExtensions({});
		}

		cleanups.push(async () => {
			await runtime.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		return { runtime, faux, tempDir };
	}

	function requireSessionRef(runtime: AgentSessionRuntime): SessionReference {
		const sessionRef = runtime.session.sessionRef;
		if (!sessionRef) throw new Error("expected a persisted session");
		return sessionRef;
	}

	/** Write through a second store handle, as another owner of the session does. */
	async function appendAsOtherOwner(
		sessionRef: SessionReference,
		write: (manager: SessionManager) => Promise<void> | void,
	): Promise<void> {
		const manager = await SessionManager.open(sessionRef);
		try {
			await write(manager);
			await manager.flush();
		} finally {
			await manager.closePersistence();
		}
	}

	async function readStoredMessageTexts(sessionRef: SessionReference): Promise<string[]> {
		const manager = await SessionManager.open(sessionRef);
		try {
			return manager.buildSessionContext().messages.map(getMessageText);
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

	/** Drive InteractiveMode on a real runtime and VirtualTerminal, without the main input loop. */
	async function startInteractiveMode(runtime: AgentSessionRuntime, tempDir: string) {
		const mode = new InteractiveMode(runtime, { tuiMode: "regular" });
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
		await access.bindCurrentSessionExtensions(runtime.session);
		access.subscribeToAgent(runtime.session);
		return { access, terminal, handleFatalRuntimeError, exit };
	}

	it("keeps the footer rendering, wakes busy waiters, and reloads the session from the store", async () => {
		const unhandledRejections: unknown[] = [];
		const onUnhandledRejection = (reason: unknown) => {
			unhandledRejections.push(reason);
		};
		process.on("unhandledRejection", onUnhandledRejection);
		cleanups.push(() => {
			process.off("unhandledRejection", onUnhandledRejection);
		});

		const { runtime } = await createRuntimeForTest(["tui reply", "after reload"]);
		await runtime.session.prompt("tui prompt");
		const sessionRef = requireSessionRef(runtime);
		const staleSession = runtime.session;
		const renderedFooter = new FooterComponent(staleSession, createFooterData());
		expect(stripAnsi(renderedFooter.render(120).lines[0])).toContain("faux-1");

		await appendAsOtherOwner(sessionRef, (manager) => {
			manager.appendMessage({ role: "user", content: "phone prompt", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("phone reply"));
		});

		// Start recovery the way interactive mode does: from the authority-loss
		// listener, which runs synchronously inside the failing write.
		let waitWhileBusy: Promise<void> | undefined;
		let reload: Promise<{ reloaded: boolean }> | undefined;
		const unsubscribe = staleSession.sessionManager.subscribeConversationAuthorityChanges(() => {
			if (staleSession.isBusy) waitWhileBusy = staleSession.waitForNotBusy();
			queueMicrotask(() => {
				reload = runtime.reloadCurrentSessionFromStore({ expectedSessionId: staleSession.sessionId });
			});
		});
		cleanups.push(unsubscribe);

		await Promise.allSettled([staleSession.prompt("stale prompt")]);
		expect(staleSession.sessionManager.getConversationAuthorityStatus().status).toBe("reconciliation_required");

		// Every frame renders the footer; it must not throw after the loss.
		renderedFooter.invalidate();
		expect(stripAnsi(renderedFooter.render(120).lines[0])).toContain("faux-1");
		expect(stripAnsi(new FooterComponent(staleSession, createFooterData()).render(120).lines[0])).toContain("faux-1");

		expect(waitWhileBusy).toBeDefined();
		await withinTimeout(waitWhileBusy!, "waitForNotBusy()");
		expect(reload).toBeDefined();
		await expect(withinTimeout(reload!, "reloadCurrentSessionFromStore()")).resolves.toEqual({ reloaded: true });

		expect(runtime.session).not.toBe(staleSession);
		expect(runtime.session.sessionManager.getConversationAuthorityStatus()).toEqual({ status: "available" });
		expect(runtime.session.messages.map(getMessageText)).toEqual([
			"tui prompt",
			"tui reply",
			"phone prompt",
			"phone reply",
		]);

		await runtime.session.prompt("after reload prompt");
		expect(await readStoredMessageTexts(sessionRef)).toEqual([
			"tui prompt",
			"tui reply",
			"phone prompt",
			"phone reply",
			"after reload prompt",
			"after reload",
		]);

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(unhandledRejections).toEqual([]);
	});

	it("reloads in interactive mode, replacing an extension footer that reads the lost session", async () => {
		const extensionFooter = (volt: ExtensionAPI) => {
			volt.on("session_start", (_event, ctx) => {
				ctx.ui.setFooter(() => ({
					invalidate() {},
					// Like examples/extensions/custom-footer.ts: reads the session on every frame.
					render: () => createRenderFrame([`extension footer: ${ctx.sessionManager.getBranch().length} entries`]),
				}));
			});
		};
		const { runtime, tempDir } = await createRuntimeForTest(["tui reply"], {
			extensionFactory: extensionFooter,
			interactive: true,
		});
		const { access, terminal, handleFatalRuntimeError, exit } = await startInteractiveMode(runtime, tempDir);

		await runtime.session.prompt("tui prompt");
		await terminal.waitForRender();
		const entriesBefore = extensionFooterEntries(terminal);
		expect(entriesBefore).toBeGreaterThan(0);

		const sessionRef = requireSessionRef(runtime);
		const staleSession = runtime.session;
		await appendAsOtherOwner(sessionRef, (manager) => {
			manager.appendMessage({ role: "user", content: "phone prompt", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("phone reply"));
		});
		access.editor.setText("unsent draft");

		await Promise.allSettled([staleSession.prompt("stale prompt")]);
		expect(staleSession.sessionManager.getConversationAuthorityStatus().status).toBe("reconciliation_required");

		await vi.waitFor(() => expect(viewport(terminal)).toContain("Reloaded the session from the store."), {
			timeout: 5_000,
		});
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		expect(runtime.session).not.toBe(staleSession);
		expect(runtime.session.messages.map(getMessageText)).toEqual([
			"tui prompt",
			"tui reply",
			"phone prompt",
			"phone reply",
		]);
		const recovered = viewport(terminal);
		expect(recovered).toContain("Could not confirm the session's saved state");
		expect(recovered).toContain("phone reply");
		// The extension reinstalled its footer for the reloaded session, which has the other owner's turns.
		expect(extensionFooterEntries(terminal)).toBeGreaterThanOrEqual(entriesBefore + 2);
		expect(access.editor.getText()).toBe("unsent draft");
	});

	it("dismisses a command's pending select and still reloads the session", async () => {
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
		const { runtime, tempDir } = await createRuntimeForTest(["tui reply"], {
			extensionFactory: pickCommand,
			interactive: true,
		});
		const { access, terminal, handleFatalRuntimeError, exit } = await startInteractiveMode(runtime, tempDir);
		await runtime.session.prompt("tui prompt");
		const staleSession = runtime.session;

		const command = staleSession.prompt("/pick");
		await selectorShown.promise;
		await terminal.waitForRender();
		expect(viewport(terminal)).toContain("Pick a target");
		expect(staleSession.isBusy).toBe(true);

		staleSession.sessionManager.retireConversationAuthority(new Error("write could not be confirmed"));

		await expect(withinTimeout(selection.promise, "ctx.ui.select()")).resolves.toBeUndefined();
		await expect(withinTimeout(command, "prompt('/pick')")).resolves.toBeUndefined();
		await vi.waitFor(() => expect(viewport(terminal)).toContain("Reloaded the session from the store."), {
			timeout: 5_000,
		});
		expect(viewport(terminal)).not.toContain("Pick a target");
		expect(access.activeView).toBe(access.conversationView);
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		expect(runtime.session).not.toBe(staleSession);
		expect(runtime.session.messages.map(getMessageText)).toEqual(["tui prompt", "tui reply"]);
	});

	it("reloads the session while a command that ignores its signal never finishes", async () => {
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
		const { runtime, tempDir } = await createRuntimeForTest([], {
			extensionFactory: stuckCommand,
			interactive: true,
		});
		const { terminal, handleFatalRuntimeError, exit } = await startInteractiveMode(runtime, tempDir);
		const staleSession = runtime.session;

		void staleSession.prompt("/stuck");
		const commandSignal = await commandStarted.promise;
		expect(staleSession.isBusy).toBe(true);

		staleSession.sessionManager.retireConversationAuthority(new Error("write could not be confirmed"));

		await vi.waitFor(() => expect(viewport(terminal)).toContain("Reloaded the session from the store."), {
			timeout: 5_000,
		});
		expect(commandSignal.aborted).toBe(true);
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
		expect(exit).not.toHaveBeenCalled();
		expect(runtime.session).not.toBe(staleSession);
	});

	it("settles every pending extension dialog when extension UI is reset", async () => {
		const { runtime, tempDir } = await createRuntimeForTest([], { interactive: true });
		const { access, terminal } = await startInteractiveMode(runtime, tempDir);
		const ui = access.createExtensionUIContext();
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
		const select = ui.select("Select dialog", ["a", "b"]);
		const input = ui.input("Input dialog");
		const editor = ui.editor("Editor dialog", "prefill");
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

		// Confirm and host actions share the selector; open them one at a time.
		const confirm = ui.confirm("Confirm dialog", "Proceed?");
		access.resetExtensionUI();
		await expect(confirm).resolves.toBe(false);

		const request: HostActionRequest = { id: "host-action", action: "test.action", title: "Host action" };
		const dismissed = access.requestHostAction(request);
		access.resetExtensionUI();
		await expect(dismissed).resolves.toEqual({ decision: "dismissed" });

		const controller = new AbortController();
		const aborted = access.requestHostAction(request, { signal: controller.signal });
		controller.abort();
		await expect(aborted).resolves.toEqual({ decision: "dismissed" });

		const approved = access.requestHostAction(request);
		access.extensionSelector?.handleInput("\n");
		await expect(approved).resolves.toEqual({ decision: "approved" });

		const denied = access.requestHostAction(request);
		access.extensionSelector?.handleInput("\x1b");
		await expect(denied).resolves.toEqual({ decision: "denied" });

		// Nothing is left to dismiss.
		access.resetExtensionUI();
		expect(access.activeView).toBe(access.conversationView);
	});
});
