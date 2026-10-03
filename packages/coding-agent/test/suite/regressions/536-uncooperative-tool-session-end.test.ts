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
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/index.ts";
import type { CustomEditor } from "../../../src/modes/interactive/components/custom-editor.ts";
import { createInteractiveTui, InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
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
	bindCurrentSessionExtensions(session: AgentSession): Promise<void>;
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

	async function createRuntimeForTest(
		responses: string[],
		options: { extensionFactory?: ExtensionFactory; interactive?: boolean } = {},
	) {
		const tempDir = join(tmpdir(), `volt-536-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
			// A runtime whose session lost authority cannot close its persistence cleanly.
			await runtime.dispose().catch(() => {});
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

	async function readStoredMessageTexts(sessionRef: SessionReference): Promise<string[]> {
		const manager = await SessionManager.openReadOnly(sessionRef);
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
			const { runtime, faux, tempDir } = await createRuntimeForTest([], { extensionFactory, interactive: true });
			// Also releases the tool on a failed assertion so test teardown cannot hang.
			cleanups.push(() => result.resolve({ content: [{ type: "text", text: "cleanup" }] }));
			const { access, terminal, handleFatalRuntimeError, exit } = await startInteractiveMode(runtime, tempDir);
			faux.setResponses([fauxAssistantMessage(fauxToolCall("stuck", {}), { stopReason: "toolUse" })]);
			const staleSession = runtime.session;
			const sessionRef = requireSessionRef(runtime);
			const prompt = Promise.allSettled([staleSession.prompt("start")]);
			const signal = await started.promise;
			const abort = cancelFirst ? staleSession.abort("keyboard_interrupt") : Promise.resolve();
			if (cancelFirst) await vi.waitFor(() => expect(signal.aborted).toBe(true));
			access.editor.setText("unsent draft");
			staleSession.sessionManager.retireConversationAuthority(new Error("write could not be confirmed"));
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
