import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionFactory, SessionShutdownEvent, SessionStartEvent } from "../../../src/index.ts";
import { getMessageText } from "../harness.ts";

describe("regression #524: reloading the current session after another owner wrote to it", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(responses: string[], extensionFactory: ExtensionFactory = () => {}) {
		const tempDir = join(tmpdir(), `volt-524-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
							extensionFactory(volt);
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

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: await SessionManager.create(tempDir),
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

	/** Write through a second store handle, as the daemon runtime does during a drain. */
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

	it("absorbs the other owner's turns and persists the next prompt without a revision conflict", async () => {
		const { runtime } = await createRuntimeForTest(["tui reply", "after handoff"]);
		await runtime.session.prompt("tui prompt");
		const sessionRef = requireSessionRef(runtime);

		await appendAsOtherOwner(sessionRef, (manager) => {
			manager.appendMessage({ role: "user", content: "phone prompt", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("phone reply"));
		});

		await expect(
			runtime.reloadCurrentSessionFromStore({ expectedSessionId: runtime.session.sessionId }),
		).resolves.toEqual({ reloaded: true });

		expect(runtime.session.messages.map(getMessageText)).toEqual([
			"tui prompt",
			"tui reply",
			"phone prompt",
			"phone reply",
		]);
		await runtime.session.prompt("after handoff prompt");
		expect(runtime.session.sessionManager.getConversationAuthorityStatus()).toEqual({ status: "available" });
		expect(await readStoredMessageTexts(sessionRef)).toEqual([
			"tui prompt",
			"tui reply",
			"phone prompt",
			"phone reply",
			"after handoff prompt",
			"after handoff",
		]);
	});

	it("reloads over a queued client input that the other owner already delivered, without replaying it", async () => {
		const { runtime, faux } = await createRuntimeForTest(["unused"]);
		const sessionRef = requireSessionRef(runtime);
		const clientMessageId = "phone-follow-up-1";

		// The outdated copy recorded the phone's queued follow-up before the drain.
		const staleManager = runtime.session.sessionManager;
		staleManager.reserveClientInput(clientMessageId, "follow_up", { message: "queued from phone" });
		staleManager.markClientInputQueued(clientMessageId, { delivery: "follow_up", message: "queued from phone" });
		await staleManager.flush();
		expect(staleManager.getClientInputRecoveryPlan().kind).toBe("replay");

		// The daemon delivered it while it owned the session.
		await appendAsOtherOwner(sessionRef, async (manager) => {
			await manager.commitDelivery({
				deliveryId: "daemon-delivery",
				epoch: 1,
				attemptId: "daemon-attempt",
				messages: [{ role: "user", content: "queued from phone", timestamp: Date.now(), clientMessageId }],
			});
			manager.appendMessage(fauxAssistantMessage("daemon reply"));
		});

		await expect(
			runtime.reloadCurrentSessionFromStore({ expectedSessionId: runtime.session.sessionId }),
		).resolves.toEqual({ reloaded: true });
		expect(runtime.session.sessionManager.getClientInput(clientMessageId)?.state).toBe("completed");
		expect(runtime.session.sessionManager.getClientInputRecoveryPlan().kind).toBe("idle");

		await runtime.startRecoveredClientInputs();
		expect(faux.state.callCount).toBe(0);
		expect(runtime.session.messages.map(getMessageText)).toEqual(["queued from phone", "daemon reply"]);
	});

	it("cannot be cancelled by session_before_switch and reports the reload as a resume", async () => {
		let beforeSwitchCalls = 0;
		const lifecycle: Array<SessionShutdownEvent | SessionStartEvent> = [];
		const { runtime } = await createRuntimeForTest(["tui reply"], (volt) => {
			volt.on("session_before_switch", () => {
				beforeSwitchCalls++;
				return { cancel: true };
			});
			volt.on("session_shutdown", (event) => {
				lifecycle.push(event);
			});
			volt.on("session_start", (event) => {
				lifecycle.push(event);
			});
		});
		await runtime.session.prompt("tui prompt");
		const sessionRef = requireSessionRef(runtime);
		lifecycle.length = 0;

		await appendAsOtherOwner(sessionRef, (manager) => {
			manager.appendMessage({ role: "user", content: "phone prompt", timestamp: Date.now() });
		});
		await expect(
			runtime.reloadCurrentSessionFromStore({ expectedSessionId: runtime.session.sessionId }),
		).resolves.toEqual({ reloaded: true });

		expect(beforeSwitchCalls).toBe(0);
		expect(runtime.session.messages.map(getMessageText)).toEqual(["tui prompt", "tui reply", "phone prompt"]);
		expect(lifecycle).toEqual([
			{ type: "session_shutdown", reason: "resume", targetSessionRef: sessionRef },
			{ type: "session_start", reason: "resume", previousSessionRef: sessionRef },
		]);
	});

	it("queues behind an in-flight lifecycle operation instead of running inside it", async () => {
		const { runtime } = await createRuntimeForTest([]);
		const sessionRef = requireSessionRef(runtime);
		await appendAsOtherOwner(sessionRef, (manager) => {
			manager.appendMessage({ role: "user", content: "phone prompt", timestamp: Date.now() });
		});

		const order: string[] = [];
		let reload: Promise<{ reloaded: boolean }> | undefined;
		await runtime.runWithStableSession(async (session) => {
			// Lease events can fire from inside a session switch's lifecycle operation.
			reload = runtime.reloadCurrentSessionFromStore({ expectedSessionId: session.sessionId });
			void reload.then(() => order.push("reload"));
			await new Promise((resolve) => setTimeout(resolve, 20));
			order.push("outer");
		});

		await expect(reload).resolves.toEqual({ reloaded: true });
		expect(order).toEqual(["outer", "reload"]);
		expect(runtime.session.messages.map(getMessageText)).toEqual(["phone prompt"]);
	});

	it("does nothing when the current session changed before the reload ran", async () => {
		const { runtime } = await createRuntimeForTest([]);
		const session = runtime.session;

		await expect(runtime.reloadCurrentSessionFromStore({ expectedSessionId: "superseded-session" })).resolves.toEqual(
			{
				reloaded: false,
			},
		);
		expect(runtime.session).toBe(session);
	});
});
