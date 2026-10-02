import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
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

	async function createRuntimeForTest(
		responses: string[],
		extensionFactory: ExtensionFactory = () => {},
		createSessionManager: (tempDir: string) => Promise<SessionManager> = (tempDir) => SessionManager.create(tempDir),
	) {
		const tempDir = join(tmpdir(), `volt-524-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

		const sessionManager = await createSessionManager(tempDir);
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
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		return { runtime, faux, tempDir };
	}

	/**
	 * A session whose stored cwd was deleted, opened with a "continue in current
	 * cwd" override the way startup and /resume do. The store keeps the old cwd.
	 */
	async function createRuntimeWithCwdOverride(responses: string[]) {
		let storedCwd = "";
		const created = await createRuntimeForTest(responses, undefined, async (tempDir) => {
			storedCwd = join(tempDir, "moved-project");
			mkdirSync(storedCwd, { recursive: true });
			const seed = await SessionManager.create(storedCwd, join(tempDir, "sessions"));
			let sessionRef: SessionReference | undefined;
			try {
				seed.appendMessage({ role: "user", content: "before move", timestamp: Date.now() });
				seed.appendMessage(fauxAssistantMessage("before move reply"));
				await seed.flush();
				sessionRef = seed.getSessionRef();
			} finally {
				await seed.closePersistence();
			}
			if (!sessionRef) throw new Error("expected a persisted session");
			rmSync(storedCwd, { recursive: true, force: true });
			return SessionManager.open(sessionRef, tempDir);
		});
		await created.runtime.session.sessionManager.flush();
		const cwdBefore = created.runtime.session.sessionManager.getCwd();
		expect(cwdBefore).toBe(created.tempDir);
		expect(created.runtime.cwd).toBe(cwdBefore);
		return { ...created, storedCwd, cwdBefore };
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

	function customEntryData(manager: SessionManager, customType: string): unknown[] {
		return manager
			.getEntries()
			.flatMap((entry) => (entry.type === "custom" && entry.customType === customType ? [entry.data] : []));
	}

	function delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function trackSettlement(promise: Promise<unknown>): () => boolean {
		let settled = false;
		promise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		return () => settled;
	}

	/** Register a detached review the way interactive /review does; it runs until released or aborted. */
	function startGatedReview(runtime: AgentSessionRuntime) {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const workflow = runtime.reviewWorkflows.start({
			prepared: {
				workflowId: `review:${Math.random().toString(36).slice(2)}`,
				action: "review.uncommitted",
				startedAt: Date.now(),
				resolution: { description: "uncommitted changes", diffCommand: "git diff" },
			},
			execute: async ({ signal }) => {
				await Promise.race([
					gate,
					new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
				]);
				return { status: "cancelled" };
			},
		});
		workflow.launch();
		return { finished: workflow.finished, release };
	}

	async function readStoredCustomEntryData(sessionRef: SessionReference, customType: string): Promise<unknown[]> {
		const manager = await SessionManager.open(sessionRef);
		try {
			return customEntryData(manager, customType);
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

	it("keeps what a session_shutdown handler writes during the reload and persists the next prompt", async () => {
		const { runtime } = await createRuntimeForTest(["tui reply", "after handoff"], (volt) => {
			volt.on("session_shutdown", (event) => {
				if (event.reason === "resume") volt.appendEntry("handoff-state", { phase: "shutdown" });
			});
		});
		await runtime.session.prompt("tui prompt");
		const sessionRef = requireSessionRef(runtime);

		// No other owner wrote: a warm grant still reloads, and the shutdown write
		// advances the store past the revision a pre-teardown read would pin.
		await expect(
			runtime.reloadCurrentSessionFromStore({ expectedSessionId: runtime.session.sessionId }),
		).resolves.toEqual({ reloaded: true });

		expect(customEntryData(runtime.session.sessionManager, "handoff-state")).toEqual([{ phase: "shutdown" }]);
		await runtime.session.prompt("after handoff prompt");
		expect(runtime.session.sessionManager.getConversationAuthorityStatus()).toEqual({ status: "available" });
		expect(await readStoredCustomEntryData(sessionRef, "handoff-state")).toEqual([{ phase: "shutdown" }]);
		expect(await readStoredMessageTexts(sessionRef)).toEqual([
			"tui prompt",
			"tui reply",
			"after handoff prompt",
			"after handoff",
		]);
	});

	it("reloads when the replacement's session_start handler writes after a session_shutdown write", async () => {
		const { runtime } = await createRuntimeForTest(["tui reply"], (volt) => {
			volt.on("session_shutdown", (event) => {
				if (event.reason === "resume") volt.appendEntry("handoff-state", { phase: "shutdown" });
			});
			volt.on("session_start", (event) => {
				if (event.reason === "resume") volt.appendEntry("handoff-state", { phase: "start" });
			});
		});
		await runtime.session.prompt("tui prompt");
		const sessionRef = requireSessionRef(runtime);

		await expect(
			runtime.reloadCurrentSessionFromStore({ expectedSessionId: runtime.session.sessionId }),
		).resolves.toEqual({ reloaded: true });

		expect(runtime.session.sessionManager.getConversationAuthorityStatus()).toEqual({ status: "available" });
		expect(customEntryData(runtime.session.sessionManager, "handoff-state")).toEqual([
			{ phase: "shutdown" },
			{ phase: "start" },
		]);
		expect(await readStoredCustomEntryData(sessionRef, "handoff-state")).toEqual([
			{ phase: "shutdown" },
			{ phase: "start" },
		]);
	});

	it("drops a session_shutdown write from an outdated copy without failing the reload", async () => {
		const { runtime } = await createRuntimeForTest(["tui reply", "after handoff"], (volt) => {
			volt.on("session_shutdown", (event) => {
				if (event.reason === "resume") volt.appendEntry("handoff-state", { phase: "shutdown" });
			});
		});
		await runtime.session.prompt("tui prompt");
		const sessionRef = requireSessionRef(runtime);
		await appendAsOtherOwner(sessionRef, (manager) => {
			manager.appendMessage({ role: "user", content: "phone prompt", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("phone reply"));
		});

		await expect(
			runtime.reloadCurrentSessionFromStore({ expectedSessionId: runtime.session.sessionId }),
		).resolves.toEqual({ reloaded: true });

		// Known limitation: the outdated copy's write conflicts with the other
		// owner's turns and is dropped. The reload itself must stay non-fatal.
		expect(runtime.session.messages.map(getMessageText)).toEqual([
			"tui prompt",
			"tui reply",
			"phone prompt",
			"phone reply",
		]);
		expect(customEntryData(runtime.session.sessionManager, "handoff-state")).toEqual([]);
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

	it("waits for a running detached review instead of failing the reload", async () => {
		const { runtime } = await createRuntimeForTest(["tui reply"]);
		await runtime.session.prompt("tui prompt");
		const sessionRef = requireSessionRef(runtime);
		const session = runtime.session;
		const review = startGatedReview(runtime);
		await appendAsOtherOwner(sessionRef, (manager) => {
			manager.appendMessage({ role: "user", content: "phone prompt", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("phone reply"));
		});

		const reload = runtime.reloadCurrentSessionFromStore({ expectedSessionId: session.sessionId });
		const reloadSettled = trackSettlement(reload);
		await delay(20);
		expect(reloadSettled()).toBe(false);
		expect(runtime.session).toBe(session);

		review.release();
		await expect(reload).resolves.toEqual({ reloaded: true });
		expect(runtime.session).not.toBe(session);
		expect(runtime.session.messages.map(getMessageText)).toEqual([
			"tui prompt",
			"tui reply",
			"phone prompt",
			"phone reply",
		]);
	});

	it("waits again for a review that starts while the reload is queued", async () => {
		const { runtime } = await createRuntimeForTest([]);
		const session = runtime.session;
		let reload: Promise<{ reloaded: boolean }> | undefined;
		let review: ReturnType<typeof startGatedReview> | undefined;
		await runtime.runWithStableSession(async (current) => {
			// The session is idle here, so the reload queues behind this operation.
			reload = runtime.reloadCurrentSessionFromStore({ expectedSessionId: current.sessionId });
			await delay(10);
			review = startGatedReview(runtime);
		});
		if (!reload || !review) throw new Error("expected a queued reload and a running review");

		const reloadSettled = trackSettlement(reload);
		await delay(20);
		expect(reloadSettled()).toBe(false);
		expect(runtime.session).toBe(session);

		review.release();
		await expect(reload).resolves.toEqual({ reloaded: true });
		expect(runtime.session).not.toBe(session);
	});

	it("waits again for an agent run that starts while the reload is queued", async () => {
		const { runtime, faux } = await createRuntimeForTest([]);
		let releaseRun = (): void => {};
		const runGate = new Promise<void>((resolve) => {
			releaseRun = resolve;
		});
		// Runs before runtime disposal, so a failed assertion cannot strand the run.
		cleanups.push(() => releaseRun());
		let markRunStarted = (): void => {};
		const runStarted = new Promise<void>((resolve) => {
			markRunStarted = resolve;
		});
		faux.setResponses([
			async () => {
				markRunStarted();
				await runGate;
				return fauxAssistantMessage("local reply");
			},
		]);
		const sessionRef = requireSessionRef(runtime);
		const session = runtime.session;
		let reload: Promise<{ reloaded: boolean }> | undefined;
		let prompt: Promise<void> | undefined;
		await runtime.runWithStableSession(async (current) => {
			reload = runtime.reloadCurrentSessionFromStore({ expectedSessionId: current.sessionId });
			prompt = current.prompt("local prompt");
			await runStarted;
		});
		if (!reload || !prompt) throw new Error("expected a queued reload and a running prompt");

		const reloadSettled = trackSettlement(reload);
		await delay(20);
		expect(reloadSettled()).toBe(false);
		expect(runtime.session).toBe(session);
		expect(session.isStreaming).toBe(true);

		releaseRun();
		await prompt;
		await expect(reload).resolves.toEqual({ reloaded: true });
		expect(runtime.session).not.toBe(session);
		expect(runtime.session.messages.map(getMessageText)).toEqual(["local prompt", "local reply"]);
		expect(await readStoredMessageTexts(sessionRef)).toEqual(["local prompt", "local reply"]);
	});

	it("lets a finished review open its findings session before the waiting reload runs", async () => {
		const { runtime } = await createRuntimeForTest([]);
		const session = runtime.session;
		const review = startGatedReview(runtime);
		const reload = runtime.reloadCurrentSessionFromStore({ expectedSessionId: session.sessionId });
		await delay(10);

		// Interactive /review opens a findings session as soon as its workflow ends.
		const promoted = review.finished.then(() => runtime.newSession());
		review.release();

		await expect(promoted).resolves.toEqual({ cancelled: false, seeded: false });
		await expect(reload).resolves.toEqual({ reloaded: false });
		expect(runtime.session.sessionId).not.toBe(session.sessionId);
	});

	it("stops waiting and rejects when the runtime is disposed", async () => {
		const { runtime } = await createRuntimeForTest([]);
		startGatedReview(runtime);
		const reload = runtime.reloadCurrentSessionFromStore({ expectedSessionId: runtime.session.sessionId });
		const rejected = expect(reload).rejects.toThrow(
			"Agent session runtime is no longer accepting structural operations",
		);
		await delay(10);

		await runtime.dispose();
		await rejected;
	});

	it("keeps a cwd override when the stored cwd is missing", async () => {
		const { runtime, cwdBefore } = await createRuntimeWithCwdOverride(["after handoff"]);
		const sessionRef = requireSessionRef(runtime);
		await appendAsOtherOwner(sessionRef, (manager) => {
			manager.appendMessage({ role: "user", content: "phone prompt", timestamp: Date.now() });
			manager.appendMessage(fauxAssistantMessage("phone reply"));
		});

		await expect(
			runtime.reloadCurrentSessionFromStore({ expectedSessionId: runtime.session.sessionId }),
		).resolves.toEqual({ reloaded: true });

		expect(runtime.cwd).toBe(cwdBefore);
		expect(runtime.session.sessionManager.getCwd()).toBe(cwdBefore);
		expect(runtime.session.messages.map(getMessageText)).toEqual([
			"before move",
			"before move reply",
			"phone prompt",
			"phone reply",
		]);
		await runtime.session.prompt("after handoff prompt");
		expect(await readStoredMessageTexts(sessionRef)).toEqual([
			"before move",
			"before move reply",
			"phone prompt",
			"phone reply",
			"after handoff prompt",
			"after handoff",
		]);
	});

	it("keeps a cwd override when the stored cwd exists again", async () => {
		const { runtime, storedCwd, cwdBefore } = await createRuntimeWithCwdOverride([]);
		mkdirSync(storedCwd, { recursive: true });

		await expect(
			runtime.reloadCurrentSessionFromStore({ expectedSessionId: runtime.session.sessionId }),
		).resolves.toEqual({ reloaded: true });

		expect(runtime.cwd).toBe(cwdBefore);
		expect(runtime.session.sessionManager.getCwd()).toBe(cwdBefore);
	});

	it("keeps a cwd override when switching to the current session without conversation authority", async () => {
		const { runtime, cwdBefore } = await createRuntimeWithCwdOverride([]);
		const sessionRef = requireSessionRef(runtime);
		await appendAsOtherOwner(sessionRef, (manager) => {
			manager.appendMessage({ role: "user", content: "phone prompt", timestamp: Date.now() });
		});
		const staleManager = runtime.session.sessionManager;
		staleManager.appendCustomEntry("test", { writer: "stale" });
		await expect(staleManager.flush()).rejects.toThrow("Session revision changed");
		expect(staleManager.getConversationAuthorityStatus().status).toBe("reconciliation_required");

		await expect(runtime.switchSession(sessionRef)).resolves.toMatchObject({ cancelled: false });

		expect(runtime.session.sessionManager).not.toBe(staleManager);
		expect(runtime.session.sessionManager.getConversationAuthorityStatus()).toEqual({ status: "available" });
		expect(runtime.cwd).toBe(cwdBefore);
		expect(runtime.session.sessionManager.getCwd()).toBe(cwdBefore);
		expect(runtime.session.messages.map(getMessageText)).toEqual([
			"before move",
			"before move reply",
			"phone prompt",
		]);
	});

	it("keeps a cwd override in the forked session", async () => {
		const { runtime, cwdBefore } = await createRuntimeWithCwdOverride([]);
		const sourceSessionRef = requireSessionRef(runtime);
		const leafId = runtime.session.sessionManager.getLeafId();
		if (!leafId) throw new Error("expected a leaf entry");

		await expect(runtime.fork(leafId, { position: "at" })).resolves.toMatchObject({ cancelled: false });

		const forkedSessionRef = requireSessionRef(runtime);
		expect(forkedSessionRef.sessionId).not.toBe(sourceSessionRef.sessionId);
		expect(runtime.cwd).toBe(cwdBefore);
		expect(runtime.session.sessionManager.getCwd()).toBe(cwdBefore);
		const reopened = await SessionManager.open(forkedSessionRef);
		try {
			expect(reopened.getCwd()).toBe(cwdBefore);
		} finally {
			await reopened.closePersistence();
		}
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
