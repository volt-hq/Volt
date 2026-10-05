import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentMessage,
	type ConversationLogAppend,
	ConversationLogLostError,
	clientInputRecovery,
} from "@hansjm10/volt-agent-core";
import { createFauxProvider, type FauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptPreflightResult } from "../../../src/core/agent-session.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../../src/core/agent-session-services.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { ConversationFactory } from "../../../src/core/host/hosted-conversation.ts";
import { type SessionEntry, SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	type SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "../../../src/core/session-store/index.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import type { ExtensionAPI, SessionBeforeSwitchEvent, SessionShutdownEvent } from "../../../src/index.ts";
import { loseConversationLock } from "../../lost-conversation-lock.ts";
import {
	appendsEntryType,
	type ConversationLogFault,
	type FaultyConversationLog,
	injectFaultyLog,
	lose,
} from "../../utilities/faulty-log.ts";
import { connectTestClient, openTestHost, type TestClient } from "../../utilities/host-client.ts";
import { testExtension } from "../../utilities.ts";
import {
	createHarness,
	getAssistantTexts,
	getMessageText,
	getUserTexts,
	type Harness,
	type HarnessOptions,
} from "../harness.ts";

const managers: SessionManager[] = [];
const storeLeases: SQLiteSessionStoreLease[] = [];

async function own(manager: Promise<SessionManager>): Promise<SessionManager> {
	const resolved = await manager;
	managers.push(resolved);
	return resolved;
}

async function trackedStore(sessionDirectory: string): Promise<SQLiteSessionStoreClient> {
	const lease = await acquireSharedSQLiteSessionStore(sessionDirectory);
	storeLeases.push(lease);
	return lease.client;
}

interface PlanningSnapshot {
	phase: string | undefined;
	checkpoints: number;
	userTexts: string[];
}

function snapshotEntries(entries: readonly SessionEntry[]): PlanningSnapshot {
	const planning = entries.filter((entry) => entry.type === "planning_state_change").at(-1);
	return {
		phase: planning?.planning.plan?.phase,
		checkpoints: entries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint",
		).length,
		userTexts: entries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
		),
	};
}

function snapshotHarness(harness: Harness): PlanningSnapshot {
	return {
		...snapshotEntries(harness.sessionManager.getBranch()),
		phase: harness.session.planningState.plan?.phase,
	};
}

async function createReadyPlan(session: Harness["session"]): Promise<void> {
	await session.setAgentMode("plan");
	const draft = await session.updatePlan({
		title: "Atomic append reconciliation",
		summary: "Resolve a commit's outcome before publication.",
		steps: [{ text: "Prove the commit outcome before publication" }],
	});
	await session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
}

/**
 * The outcome the next planning commit reports. While a plan is ready, the
 * delivery of user input commits its `planning_state_change` in the same batch.
 */
type PlanningCommitFault =
	| "rolled_back"
	| "uncertain_rollback"
	| "uncertain_committed"
	/** Durable, but the log head moved past it: another writer appended. */
	| "fenced_committed";

const UNCERTAIN_COMMIT_MESSAGE = "The planning commit's outcome could not be determined";
const FENCED_COMMIT_MESSAGE = "Another writer appended after the planning commit";

const isPlanningCommit = appendsEntryType("planning_state_change");

function planningFault(fault: PlanningCommitFault): ConversationLogFault {
	if (fault === "rolled_back") return "rolled_back";
	if (fault === "fenced_committed") return lose("fence_conflict", { committed: true, message: FENCED_COMMIT_MESSAGE });
	return lose("uncertain_commit", { committed: fault === "uncertain_committed", message: UNCERTAIN_COMMIT_MESSAGE });
}

/** Whether a log batch delivers a user message: a turn's delivery commit. */
function deliversUserMessage(batch: ConversationLogAppend): boolean {
	return batch.entries.some(
		(entry) => entry.type === "message" && (entry.payload as { message?: AgentMessage }).message?.role === "user",
	);
}

/** The faulted batch's fence and size, from the faulty log's record. */
function faultedBatch(faulty: FaultyConversationLog): { expectedOrdinal: number; entries: number } {
	const batch = faulty.faulted[0];
	if (!batch) throw new Error("No planning commit was faulted");
	return { expectedOrdinal: batch.expectedOrdinal, entries: batch.entries.length };
}

/** Queue inputs while a turn reservation holds the idle conversation; the returned start runs one turn for them. */
async function queueBehindReservation(
	harness: Harness,
	inputs: () => Promise<void>,
): Promise<{ start(): Promise<void> }> {
	const reservation = harness.control.conversation.reserve();
	try {
		await inputs();
	} catch (error) {
		reservation.cancel();
		throw error;
	}
	return {
		async start() {
			reservation.cancel();
			await harness.session.waitForIdle();
		},
	};
}

describe("regression #217: commits whose outcome is unknown", () => {
	const harnesses: Harness[] = [];
	const runtimeCleanups: Array<() => Promise<void>> = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		while (runtimeCleanups.length > 0) await runtimeCleanups.pop()?.();
		while (harnesses.length > 0)
			await harnesses
				.pop()!
				.cleanupAsync()
				.catch(() => {});
		while (managers.length > 0) await managers.pop()!.closePersistence();
		vi.restoreAllMocks();
		while (storeLeases.length > 0) await storeLeases.pop()!.release();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	async function setupRuntime(
		replacementHook: (event: SessionBeforeSwitchEvent | SessionShutdownEvent) => void = () => {},
	): Promise<{
		runtime: TestClient;
		faux: FauxProvider;
		log: FaultyConversationLog;
	}> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-runtime-"));
		tempDirs.push(tempDir);
		const faux = createFauxProvider();
		faux.setResponses([fauxAssistantMessage("must remain unused")]);
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "faux-key");
		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model,
			resourceLoaderOptions: {
				extensionFactories: [
					testExtension(
						"test-extension-1",
						(volt: ExtensionAPI) => {
							volt.registerProvider(model.provider, {
								baseUrl: model.baseUrl,
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
							volt.on("session_before_switch", replacementHook);
							volt.on("session_shutdown", replacementHook);
						},
						["providers"],
					),
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: ConversationFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const sessionManager = await own(SessionManager.create(tempDir, join(tempDir, "sessions")));
		// Faults are injected below the session, before it takes the manager's log.
		const log = injectFaultyLog(sessionManager);
		const { host, conversation } = await openTestHost(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
		});
		const runtime = await connectTestClient(host, conversation, { surface: {} });
		runtimeCleanups.push(async () => {
			await runtime.dispose().catch(() => {});
		});
		return { runtime, faux, log };
	}

	async function loseRuntimeLog(runtime: TestClient, log: FaultyConversationLog): Promise<void> {
		await createReadyPlan(runtime.session);
		log.failNext(planningFault("uncertain_committed"), isPlanningCommit);
		await runtime.session.steer("end this runtime", undefined, "issue-217-runtime-replacement");
		await runtime.session.lost;
		// The turn that lost the log unwinds before the runtime takes structural operations.
		await runtime.session.waitForIdle();
	}

	async function setup(options: HarnessOptions = {}): Promise<{
		harness: Harness;
		log: FaultyConversationLog;
		sessionRef: SessionReference;
		baseline: PlanningSnapshot;
	}> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-"));
		tempDirs.push(tempDir);
		const sessionManager = await own(SessionManager.create(tempDir, join(tempDir, "sessions")));
		// Faults are injected below the session, before it takes the manager's log.
		const log = injectFaultyLog(sessionManager);
		const harness = await createHarness({ ...options, sessionManager });
		harnesses.push(harness);
		await createReadyPlan(harness.session);
		return {
			harness,
			log,
			sessionRef: sessionManager.getSessionRef()!,
			baseline: snapshotHarness(harness),
		};
	}

	it("ends a runtime whose commit outcome cannot be resolved", async () => {
		const replacementHooks: string[] = [];
		const { runtime, log } = await setupRuntime((event) => {
			replacementHooks.push(event.type);
		});
		await loseRuntimeLog(runtime, log);

		await expect(runtime.lost).resolves.toMatchObject({
			reason: "uncertain_commit",
			message: UNCERTAIN_COMMIT_MESSAGE,
		});
		// The host disposes the runtime; the loss is not reported again.
		await expect(runtime.dispose()).resolves.toBeUndefined();
		expect(replacementHooks).toEqual(["session_shutdown"]);
	});

	it("does not reload a lost session from the store", async () => {
		const { runtime, log } = await setupRuntime();
		await loseRuntimeLog(runtime, log);
		await runtime.lost;
		const previousSession = runtime.session;
		const previousConversation = runtime.conversation;
		const previousOrdinal = previousSession.sessionManager.getOrdinal();
		const previousLeaf = previousSession.sessionManager.getLeafId();

		await expect(runtime.switchSessionById(previousSession.sessionId)).resolves.toEqual({
			cancelled: false,
			sessionId: previousSession.sessionId,
			seeded: false,
		});

		expect(runtime.session).toBe(previousSession);
		// The log was not reloaded: the same conversation at the same position.
		expect(runtime.conversation).toBe(previousConversation);
		expect(runtime.session.sessionManager.getOrdinal()).toBe(previousOrdinal);
		expect(runtime.session.sessionManager.getLeafId()).toBe(previousLeaf);
	});

	it("rejects a stale manager at the ordinal fence without changing the committed winner", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-stale-manager-"));
		tempDirs.push(tempDir);
		const current = await own(SessionManager.create(tempDir, join(tempDir, "sessions")));
		await current.logWriter.appendPlanningState({ mode: "build", plan: null });
		await current.logWriter.appendPlanningState({ mode: "plan", plan: null });
		const sessionRef = current.getSessionRef()!;
		const store = await trackedStore(sessionRef.sessionDirectory);
		const winner = await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration);
		await loseConversationLock(current);

		const commit = current.logWriter.appendPlanningState({ mode: "build", plan: null });
		await expect(commit).rejects.toBeInstanceOf(ConversationLogLostError);
		await expect(commit).rejects.toMatchObject({
			reason: "fence_conflict",
			message: expect.stringMatching(/Expected log ordinal \d+, but the log head is \d+/),
		});

		expect(await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration)).toMatchObject({
			lastOrdinal: winner?.lastOrdinal,
		});
		await expect(current.lost).resolves.toMatchObject({ reason: "fence_conflict" });
		await expect(current.logWriter.appendPlanningState({ mode: "build", plan: null })).rejects.toBeInstanceOf(
			ConversationLogLostError,
		);
		await expect(current.closePersistence()).resolves.toBeUndefined();
		expect((await own(SessionManager.open(sessionRef, tempDir))).getConversationState().planning).toEqual({
			mode: "plan",
			plan: null,
		});
	});

	it("keeps close pending until an in-flight commit settles", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-commit-drain-"));
		tempDirs.push(tempDir);
		const manager = await own(SessionManager.create(tempDir, join(tempDir, "sessions")));
		const hold = injectFaultyLog(manager).holdNext(isPlanningCommit);

		const committing = manager.logWriter.appendPlanningState({ mode: "plan", plan: null });
		await hold.started;
		const draining = manager.closePersistence();
		let drainSettled = false;
		void draining.then(
			() => {
				drainSettled = true;
			},
			() => {
				drainSettled = true;
			},
		);

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(drainSettled).toBe(false);
			hold.release();
			await expect(committing).resolves.toBeUndefined();
			await expect(draining).resolves.toBeUndefined();
		} finally {
			hold.release();
			await Promise.allSettled([committing, draining]);
		}
	});

	it("leaves state unchanged and keeps the input queued when the delivery commit is rolled back", async () => {
		const { harness, log, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "issue-217-rolled-back";
		log.failNext(planningFault("rolled_back"), isPlanningCommit);

		await harness.session.steer("retain this feedback", undefined, clientMessageId);
		await harness.session.waitForIdle();

		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(harness.control.hasQueuedMessages()).toBe(true);
		const reopened = await own(SessionManager.openReadOnly(sessionRef));
		expect(snapshotEntries(reopened.getBranch())).toEqual(baseline);
		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		const summary = await (await trackedStore(sessionRef.sessionDirectory)).findSessionSummary(
			sessionRef.sessionId,
			sessionRef.sessionGeneration,
		);
		expect(summary?.lastOrdinal).toBe(faultedBatch(log).expectedOrdinal);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("gates planning, delivery, RPC acceptance, and provider work until the delivery commit settles", async () => {
		const { harness, log, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("proof completed")]);
		const hold = log.holdNext(isPlanningCommit);
		const planningEventsBefore = harness.eventsOfType("planning_state_changed").length;
		const deliveryEventsBefore = harness.eventsOfType("delivery_start").length;
		const preflight: PromptPreflightResult[] = [];

		const prompting = harness.session.prompt("wait for transaction proof", {
			clientMessageId: "issue-217-gated-direct-rpc",
			source: "rpc",
			preflightResult: (result) => preflight.push(result),
		});
		await hold.started;

		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore);
		expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore);
		expect(preflight).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		hold.release();
		await prompting;

		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore + 1);
		expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore + 1);
		expect(preflight).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("ends a session whose commit became durable but another writer appended after it", async () => {
		const { harness, log, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		log.failNext(planningFault("fenced_committed"), isPlanningCommit);
		const planningEventsBefore = harness.eventsOfType("planning_state_changed").length;
		const deliveryEventsBefore = harness.eventsOfType("delivery_start").length;
		const messageEventsBefore = harness.events.filter(
			(event) => event.type === "message_start" || event.type === "message_end",
		).length;
		const preflight: PromptPreflightResult[] = [];
		const clientMessageId = "issue-217-reconciled-descendant";
		const prompting = harness.session.prompt("fence the stale manager", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflight.push(result),
		});

		try {
			await expect(prompting).rejects.toMatchObject({
				message: "The session lost its log before the client input settled",
				cause: { reason: "fence_conflict", message: FENCED_COMMIT_MESSAGE },
			});

			await expect(harness.session.lost).resolves.toBeInstanceOf(ConversationLogLostError);
			expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore);
			expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore);
			expect(
				harness.events.filter((event) => event.type === "message_start" || event.type === "message_end"),
			).toHaveLength(messageEventsBefore);
			expect(preflight).toEqual([{ success: false }]);
			expect(harness.getPendingResponseCount()).toBe(1);

			// A reopened session sees exactly the committed entries.
			const reopened = await own(SessionManager.openReadOnly(sessionRef));
			expect(snapshotEntries(reopened.getBranch())).toEqual({
				phase: "draft",
				checkpoints: baseline.checkpoints + 1,
				userTexts: ["fence the stale manager"],
			});
			expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		} finally {
			await prompting.catch(() => undefined);
		}
	});

	it("ends a session whose delivery meets a stale ordinal fence and recovers the input from a fresh manager", async () => {
		const { harness, log, sessionRef } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "issue-217-stale-generation";
		const hold = log.holdNext(deliversUserMessage);

		await harness.session.steer("recover from the authoritative revision", undefined, clientMessageId);
		await hold.started;
		// Another writer took the log after the input was admitted, before its delivery commits.
		await loseConversationLock(harness.sessionManager);
		const store = await trackedStore(sessionRef.sessionDirectory);
		const winnerOrdinal = (await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration))
			?.lastOrdinal;
		hold.release();

		await expect(harness.session.lost).resolves.toMatchObject({ reason: "fence_conflict" });
		expect((await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration))?.lastOrdinal).toBe(
			winnerOrdinal,
		);
		expect(harness.getPendingResponseCount()).toBe(1);
		// The host ends the lost session, which releases its lock.
		harness.session.dispose();
		await harness.session.waitForClosed();

		const reopened = await own(SessionManager.open(sessionRef));
		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(clientInputRecovery(reopened.getConversationState())).toMatchObject({
			kind: "replay",
			records: [{ clientMessageId }],
		});
		const replacement = await createHarness({ sessionManager: reopened });
		harnesses.push(replacement);
		replacement.setResponses([fauxAssistantMessage("fresh manager recovered delivery")]);

		await replacement.session.resumeRecoveredClientInputs();

		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(getUserTexts(replacement)).toEqual(["recover from the authoritative revision"]);
		expect(getAssistantTexts(replacement)).toEqual(["fresh manager recovered delivery"]);
		expect(replacement.getPendingResponseCount()).toBe(0);
	});

	it("rejects new work before extension, MCP, bash, provider, queue, or planning effects after an unknown outcome", async () => {
		let inputHookCalls = 0;
		const { harness, log } = await setup({
			extensionFactories: [
				(volt) => {
					volt.on("input", () => {
						inputHookCalls++;
						return { action: "continue" };
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const mcpStart = vi.fn(async () => undefined);
		const mcpDispose = vi.fn(async () => undefined);
		const internals = harness.session as unknown as {
			_tools: { mcpManager?: { startEagerServers(): Promise<void>; dispose(): Promise<void> } };
		};
		internals._tools.mcpManager = { startEagerServers: mcpStart, dispose: mcpDispose };
		log.failNext(planningFault("uncertain_rollback"), isPlanningCommit);
		const turn = await queueBehindReservation(harness, async () => {
			await harness.session.steer("fail authority", undefined, "issue-217-side-effect-fence");
			await harness.session.followUp("hand back later input");
		});
		await turn.start();

		await expect(harness.session.lost).resolves.toMatchObject({ reason: "uncertain_commit" });
		const bashOperations: BashOperations = { exec: vi.fn(async () => ({ exitCode: 0 })) };
		const planningEvents = harness.eventsOfType("planning_state_changed").length;
		const messageEvents = harness.events.filter(
			(event) => event.type === "message_start" || event.type === "message_end",
		).length;
		const preflight: PromptPreflightResult[] = [];

		await expect(
			harness.session.prompt("must reject", {
				clientMessageId: "issue-217-rejected-prompt",
				source: "rpc",
				preflightResult: (result) => preflight.push(result),
			}),
		).rejects.toBeInstanceOf(ConversationLogLostError);
		await expect(harness.session.steer("must not queue")).rejects.toBeInstanceOf(ConversationLogLostError);
		await expect(harness.session.followUp("must not queue")).rejects.toBeInstanceOf(ConversationLogLostError);
		await expect(
			harness.session.executeBash("must-not-run", undefined, { operations: bashOperations }),
		).rejects.toBeInstanceOf(ConversationLogLostError);
		expect(() => harness.session.setAgentMode("build")).toThrow(ConversationLogLostError);
		await expect(
			harness.session.updatePlan({
				title: "must not update",
				summary: "must not update",
				steps: [{ text: "must not update" }],
			}),
		).rejects.toBeInstanceOf(ConversationLogLostError);

		expect(preflight).toEqual([]);
		expect(inputHookCalls).toBe(0);
		expect(mcpStart).not.toHaveBeenCalled();
		expect(bashOperations.exec).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEvents);
		expect(
			harness.events.filter((event) => event.type === "message_start" || event.type === "message_end"),
		).toHaveLength(messageEvents);

		await expect(harness.session.abort()).resolves.toBeUndefined();
		// The steer's outcome is unknown, so only the later input is handed back.
		await expect(harness.session.clearQueue()).resolves.toEqual({
			steering: [],
			followUp: ["hand back later input"],
		});
		expect(harness.session.getSteeringMessages()).toEqual([]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		harness.session.dispose();
		// The loss was reported through `lost`; closing does not report it again.
		await expect(harness.session.waitForClosed()).resolves.toBeUndefined();
		expect(mcpDispose).toHaveBeenCalledOnce();
	});

	it.each([
		{ fault: "uncertain_committed" as const, authoritativeOutcome: "committed" as const },
		{ fault: "uncertain_rollback" as const, authoritativeOutcome: "rolled_back" as const },
	])(
		"recovers from the authoritative $authoritativeOutcome commit after its outcome was unknown",
		async ({ fault, authoritativeOutcome }) => {
			const { harness, log, sessionRef, baseline } = await setup();
			harness.setResponses([fauxAssistantMessage("must remain unused")]);
			const clientMessageId = `issue-217-unavailable-${authoritativeOutcome}`;
			const laterClientMessageId = `issue-217-later-${authoritativeOutcome}`;
			log.failNext(planningFault(fault), isPlanningCommit);
			const turn = await queueBehindReservation(harness, async () => {
				await harness.session.steer("unproven feedback", undefined, clientMessageId);
				await harness.session.followUp("later queued feedback", undefined, laterClientMessageId);
			});
			const planningEventsBefore = harness.eventsOfType("planning_state_changed").length;
			const deliveryEventsBefore = harness.eventsOfType("delivery_start").length;
			await turn.start();

			await expect(harness.sessionManager.lost).resolves.toMatchObject({ reason: "uncertain_commit" });
			await expect(harness.session.lost).resolves.toMatchObject({ reason: "uncertain_commit" });
			expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore);
			expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore);
			expect(harness.getPendingResponseCount()).toBe(1);
			const batch = faultedBatch(log);
			const store = await trackedStore(sessionRef.sessionDirectory);
			const summary = await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration);
			expect(summary?.lastOrdinal).toBe(
				authoritativeOutcome === "committed" ? batch.expectedOrdinal + batch.entries : batch.expectedOrdinal,
			);
			expect(harness.session.sessionRef).toEqual(sessionRef);
			await expect(harness.sessionManager.closePersistence()).resolves.toBeUndefined();

			// A reopened session sees exactly the committed entries.
			const reopened = await own(SessionManager.open(sessionRef));
			const replacement = await createHarness({ sessionManager: reopened });
			harnesses.push(replacement);
			replacement.setResponses([
				fauxAssistantMessage("fresh recovery first"),
				fauxAssistantMessage("fresh recovery later"),
			]);
			if (authoritativeOutcome === "committed") {
				expect(snapshotEntries(reopened.getBranch())).toEqual({
					phase: "draft",
					checkpoints: baseline.checkpoints + 1,
					userTexts: ["unproven feedback"],
				});
				expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
				expect(clientInputRecovery(reopened.getConversationState())).toMatchObject({
					kind: "replay",
					records: [{ clientMessageId: laterClientMessageId }],
				});
			} else {
				expect(snapshotEntries(reopened.getBranch())).toEqual(baseline);
				expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
				expect(clientInputRecovery(reopened.getConversationState())).toMatchObject({
					kind: "replay",
					records: [{ clientMessageId }, { clientMessageId: laterClientMessageId }],
				});
			}

			await replacement.session.resumeRecoveredClientInputs();
			expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
			expect(reopened.getClientInput(laterClientMessageId)).toMatchObject({ state: "completed" });
			expect(getUserTexts(replacement)).toEqual(["unproven feedback", "later queued feedback"]);
			// The steer, committed before the loss or replayed now, is answered before the follow-up is delivered.
			expect(getAssistantTexts(replacement)).toEqual(["fresh recovery first", "fresh recovery later"]);
			expect(replacement.getPendingResponseCount()).toBe(0);
		},
	);
});
