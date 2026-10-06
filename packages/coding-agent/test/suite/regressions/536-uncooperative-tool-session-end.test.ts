import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@hansjm10/volt-agent-core";
import { createFauxProvider, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import type { Component, TUI } from "@hansjm10/volt-tui";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import type { HostClient } from "../../../src/core/host/targets.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/index.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { TuiHost } from "../../../src/modes/interactive/host/tui-host.ts";
import { createInteractiveTui, InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { loseLog } from "../../lost-conversation-lock.ts";
import { openTestHost, type TestHost } from "../../utilities/host-client.ts";
import { testExtension } from "../../utilities.ts";
import { getMessageText } from "../harness.ts";

type View = { regularComponents: readonly Component[]; fullscreenRoot: Component };
type InteractiveAccess = {
	renderer: ReturnType<typeof createInteractiveTui>;
	ui: TUI;
	editor: CustomEditor;
	conversationView: View;
	activeView: View;
	isInitialized: boolean;
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

describe("regression #536: ending a lost session while an uncooperative tool is running", () => {
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
	async function openConversationForTest(responses: string[], options: { extensionFactory?: ExtensionFactory } = {}) {
		const tempDir = join(tmpdir(), `volt-536-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
									// Interactive extension reset clears dynamic providers; rebind the
									// same faux implementation as well as its model metadata.
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
		return { host, conversation, faux, tempDir };
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

	/** Drive InteractiveMode on a real host and VirtualTerminal, without the main input loop. */
	async function startInteractiveMode(opened: TestHost & { tempDir: string }) {
		const { host, conversation, tempDir } = opened;
		const mode = new InteractiveMode(TuiHost.start({ host, conversation }), { tuiMode: "regular" });
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
		return { access, terminal, handleFatalRuntimeError, exit };
	}

	it.each([
		["resolve", false],
		["reject", false],
		["never", false],
		["resolve", true],
		["reject", true],
		["never", true],
	] as const)(
		"ends the session and hands back the draft when abandoned output will %s (already cancelled: %s)",
		async (lateOutcome, cancelFirst) => {
			const started = Promise.withResolvers<AbortSignal>();
			const result = Promise.withResolvers<AgentToolResult>();
			let lateUpdate: AgentToolUpdateCallback | undefined;
			const extensionFactory: ExtensionFactory = (volt) => {
				volt.registerTool({
					name: "stuck",
					label: "Stuck",
					description: "Ignores cancellation",
					parameters: Type.Object({}),
					execute: async (_id, _args, signal, onUpdate) => {
						if (!signal) throw new Error("expected a tool signal");
						lateUpdate = onUpdate;
						started.resolve(signal);
						return result.promise;
					},
				});
			};
			const opened = await openConversationForTest([], { extensionFactory });
			// Also releases the tool on a failed assertion so test teardown cannot hang.
			cleanups.push(() => result.resolve({ content: [{ type: "text", text: "cleanup" }] }));
			const { access, terminal, handleFatalRuntimeError, exit } = await startInteractiveMode(opened);
			opened.faux.setResponses([fauxAssistantMessage(fauxToolCall("stuck", {}), { stopReason: "toolUse" })]);
			const staleSession = opened.conversation.session;
			const sessionRef = requireSessionRef(staleSession);
			const prompt = Promise.allSettled([staleSession.prompt("start")]);
			const signal = await started.promise;
			const abort = cancelFirst ? staleSession.abort("keyboard_interrupt") : Promise.resolve();
			if (cancelFirst) await vi.waitFor(() => expect(signal.aborted).toBe(true));
			access.editor.setText("unsent draft");
			await loseLog(staleSession.sessionWriter);
			await withinTimeout(prompt, "aborted prompt");
			await withinTimeout(abort, "prior cancellation");
			// Disposal must not wait for the uncooperative tool before the TUI exits.
			await vi.waitFor(() => expect(handleFatalRuntimeError).toHaveBeenCalledTimes(1), { timeout: 5_000 });
			expect(handleFatalRuntimeError).toHaveBeenCalledWith(
				"Volt stopped this session because its saved state could not be confirmed",
				expect.objectContaining({ message: expect.stringContaining("/resume") }),
				{ unsentDraft: "unsent draft" },
			);
			expect(signal.aborted).toBe(true);
			expect(staleSession.isStreaming).toBe(false);
			expect(exit).not.toHaveBeenCalled();

			lateUpdate?.({ content: [{ type: "text", text: "late progress" }] });
			if (lateOutcome === "resolve") result.resolve({ content: [{ type: "text", text: "late result" }] });
			if (lateOutcome === "reject") result.reject(new Error("late rejection"));
			await new Promise((resolve) => setTimeout(resolve, 0));
			access.ui.requestRender(true);
			await terminal.waitForRender();
			expect(viewport(terminal)).not.toContain("late progress");
			expect(await readStoredMessageTexts(sessionRef)).not.toContain("late result");
		},
	);
});
