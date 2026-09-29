import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ReadonlyFooterDataProvider } from "../../../src/core/footer-data-provider.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { initTheme } from "../../../src/core/theme/runtime.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { FooterComponent } from "../../../src/modes/interactive/components/footer.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { getMessageText } from "../harness.ts";

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

	async function createRuntimeForTest(responses: string[]) {
		const tempDir = join(tmpdir(), `volt-525-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
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
		// Bind replacements the way interactive mode does.
		runtime.setRebindSession(async (session) => {
			await session.bindExtensions({});
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		return { runtime, faux };
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

	function createFooterData(): ReadonlyFooterDataProvider {
		return {
			getGitBranch: () => null,
			getExtensionStatuses: () => new Map<string, string>(),
			getAvailableProviderCount: () => 1,
			onBranchChange: () => () => {},
		};
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
});
