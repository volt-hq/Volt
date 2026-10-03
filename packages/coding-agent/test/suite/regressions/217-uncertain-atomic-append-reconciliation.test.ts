import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLogLostError } from "@hansjm10/volt-agent-core";
import { createFauxProvider, type FauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptPreflightResult } from "../../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { type SessionEntry, SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	type SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "../../../src/core/session-store/index.ts";
import type { BashOperations } from "../../../src/core/tools/bash.ts";
import type { ExtensionAPI, SessionBeforeSwitchEvent, SessionShutdownEvent } from "../../../src/index.ts";
import { createAgentSessionTestControl } from "../../agent-session-test-control.ts";
import { loseConversationLock } from "../../lost-conversation-lock.ts";
import {
	appendsEntryType,
	type ConversationLogHold,
	type FaultyConversationLog,
	injectFaultyLog,
	lose,
} from "../../utilities/faulty-log.ts";
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

async function commitPlanningState(manager: SessionManager, mode: "build" | "plan"): Promise<void> {
	const projection = manager.issueCanonicalProjection();
	await manager.commitCanonicalCommand({
		guard: { kind: "exact", token: projection.token },
		mutations: [{ kind: "append", entry: { type: "planning_state_change", planning: { mode, plan: null } } }],
	});
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

async function createReadyPlan(harness: Harness): Promise<void> {
	await harness.session.setAgentMode("plan");
	const draft = await harness.session.updatePlan({
		title: "Atomic append reconciliation",
		summary: "Resolve a commit's outcome before publication.",
		steps: [{ text: "Prove the commit outcome before publication" }],
	});
	await harness.session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
}

/**
 * The outcome the next planning commit reports. The ready plan's delivery
 * commits its `planning_state_change` together with the delivered input.
 */
type PlanningCommitFault =
	| "rolled_back"
	| "uncertain_rollback"
	| "uncertain_committed"
	/** Durable, but the log head moved past it: another writer appended. */
	| "fenced_committed";

const UNCERTAIN_COMMIT_MESSAGE = "The planning commit's outcome could not be determined";

const isPlanningCommit = appendsEntryType("planning_state_change");

function faultNextPlanningCommit(manager: SessionManager, fault: PlanningCommitFault): FaultyConversationLog {
	const faulty = injectFaultyLog(manager);
	faulty.failNext(
		fault === "rolled_back"
			? "rolled_back"
			: fault === "fenced_committed"
				? lose("fence_conflict", { committed: true, message: "Another writer appended after the planning commit" })
				: lose("uncertain_commit", {
						committed: fault === "uncertain_committed",
						message: UNCERTAIN_COMMIT_MESSAGE,
					}),
		isPlanningCommit,
	);
	return faulty;
}

function holdNextPlanningCommit(manager: SessionManager): ConversationLogHold {
	return injectFaultyLog(manager).holdNext(isPlanningCommit);
}

/** The faulted batch's fence and size, from the faulty log's record. */
function faultedBatch(faulty: FaultyConversationLog): { expectedOrdinal: number; entries: number } {
	const batch = faulty.faulted[0];
	if (!batch) throw new Error("No planning commit was faulted");
	return { expectedOrdinal: batch.expectedOrdinal, entries: batch.entries.length };
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
		runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
		faux: FauxProvider;
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
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
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
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: await own(SessionManager.create(tempDir, join(tempDir, "sessions"))),
		});
		await runtime.session.bindExtensions({});
		runtimeCleanups.push(async () => {
			await runtime.dispose().catch(() => {});
		});
		return { runtime, faux };
	}

	async function loseRuntimeLog(runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>): Promise<void> {
		await runtime.session.setAgentMode("plan");
		const draft = await runtime.session.updatePlan({
			title: "Runtime reconciliation",
			summary: "End the runtime whose commit outcome is unknown.",
			steps: [{ text: "Reopen authoritative SQLite state" }],
		});
		await runtime.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: draft.title!,
			summary: draft.summary!,
		});
		await runtime.session.steer("end this runtime", undefined, "issue-217-runtime-replacement");
		faultNextPlanningCommit(runtime.session.sessionManager, "uncertain_committed");
		await expect(createAgentSessionTestControl(runtime.session).continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});
	}

	async function setup(options: HarnessOptions = {}): Promise<{
		harness: Harness;
		sessionRef: SessionReference;
		baseline: PlanningSnapshot;
	}> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-"));
		tempDirs.push(tempDir);
		const sessionManager = await own(SessionManager.create(tempDir, join(tempDir, "sessions")));
		const harness = await createHarness({ ...options, sessionManager });
		harnesses.push(harness);
		await createReadyPlan(harness);
		return {
			harness,
			sessionRef: sessionManager.getSessionRef()!,
			baseline: snapshotHarness(harness),
		};
	}

	it("ends a runtime whose commit outcome cannot be resolved", async () => {
		const replacementHooks: string[] = [];
		const { runtime } = await setupRuntime((event) => {
			replacementHooks.push(event.type);
		});
		await loseRuntimeLog(runtime);

		await expect(runtime.lost).resolves.toMatchObject({
			reason: "uncertain_commit",
			message: UNCERTAIN_COMMIT_MESSAGE,
		});
		// The host disposes the runtime; the loss is not reported again.
		await expect(runtime.dispose()).resolves.toBeUndefined();
		expect(replacementHooks).toEqual(["session_shutdown"]);
	});

	it("does not reload a lost session from the store", async () => {
		const { runtime } = await setupRuntime();
		await loseRuntimeLog(runtime);
		await runtime.lost;
		const previousSession = runtime.session;
		const previousBranchEpoch = runtime.conversationProjectionFeed.branchEpoch;

		await expect(runtime.switchSessionById(previousSession.sessionId)).resolves.toEqual({
			cancelled: false,
			seeded: false,
		});

		expect(runtime.session).toBe(previousSession);
		expect(runtime.conversationProjectionFeed.branchEpoch).toBe(previousBranchEpoch);
	});

	it("rejects a stale manager at the ordinal fence without changing the committed winner", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-stale-manager-"));
		tempDirs.push(tempDir);
		const current = await own(SessionManager.create(tempDir, join(tempDir, "sessions")));
		await current.appendPlanningState({ mode: "build", plan: null });
		await current.appendPlanningState({ mode: "plan", plan: null });
		const sessionRef = current.getSessionRef()!;
		const store = await trackedStore(sessionRef.sessionDirectory);
		const winner = await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration);
		await loseConversationLock(current);

		const commit = commitPlanningState(current, "build");
		await expect(commit).rejects.toBeInstanceOf(ConversationLogLostError);
		await expect(commit).rejects.toMatchObject({
			reason: "fence_conflict",
			message: expect.stringMatching(/Expected log ordinal \d+, but the log head is \d+/),
		});

		expect(await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration)).toMatchObject({
			lastOrdinal: winner?.lastOrdinal,
		});
		await expect(current.lost).resolves.toMatchObject({ reason: "fence_conflict" });
		await expect(current.appendPlanningState({ mode: "build", plan: null })).rejects.toBeInstanceOf(
			ConversationLogLostError,
		);
		await expect(current.closePersistence()).resolves.toBeUndefined();
		expect((await own(SessionManager.open(sessionRef, tempDir))).buildSessionContext().planning).toEqual({
			mode: "plan",
			plan: null,
		});
	});

	it("keeps close pending until an in-flight commit settles", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-217-commit-drain-"));
		tempDirs.push(tempDir);
		const manager = await own(SessionManager.create(tempDir, join(tempDir, "sessions")));
		const hold = holdNextPlanningCommit(manager);

		const committing = commitPlanningState(manager, "plan");
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
			await expect(Promise.all([committing, draining])).resolves.toEqual([undefined, undefined]);
		} finally {
			hold.release();
			await Promise.allSettled([committing, draining]);
		}
	});

	it("retains delivery and client-input ownership when the commit is rolled back", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "issue-217-rolled-back";
		await harness.session.steer("retain this feedback", undefined, clientMessageId);
		const faulty = faultNextPlanningCommit(harness.sessionManager, "rolled_back");

		await expect(harness.control.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "retained", phase: "settlement" },
		});

		expect(snapshotHarness(harness)).toEqual(baseline);
		const reopened = await own(SessionManager.openReadOnly(sessionRef));
		expect(snapshotEntries(reopened.getBranch())).toEqual(baseline);
		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		const summary = await (await trackedStore(sessionRef.sessionDirectory)).findSessionSummary(
			sessionRef.sessionId,
			sessionRef.sessionGeneration,
		);
		expect(summary?.lastOrdinal).toBe(faultedBatch(faulty).expectedOrdinal);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("gates planning, delivery, RPC acceptance, and provider work until the delivery commit settles", async () => {
		const { harness, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("proof completed")]);
		const hold = holdNextPlanningCommit(harness.sessionManager);
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
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		faultNextPlanningCommit(harness.sessionManager, "fenced_committed");
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
			const authoritativeAfterCommit = {
				phase: "draft",
				checkpoints: baseline.checkpoints + 1,
				userTexts: ["fence the stale manager"],
			};
			await expect(prompting).rejects.toMatchObject({
				reason: "fence_conflict",
				message: "Another writer appended after the planning commit",
			});

			await expect(harness.session.lost).resolves.toBeInstanceOf(ConversationLogLostError);
			expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore);
			expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore);
			expect(
				harness.events.filter((event) => event.type === "message_start" || event.type === "message_end"),
			).toHaveLength(messageEventsBefore);
			expect(preflight).toEqual([{ success: false }]);
			expect(harness.getPendingResponseCount()).toBe(1);

			const reopened = await own(SessionManager.openReadOnly(sessionRef));
			expect(snapshotEntries(reopened.getBranch())).toEqual(authoritativeAfterCommit);
			expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		} finally {
			await prompting.catch(() => undefined);
		}
	});

	it("terminally consumes a stale-generation delivery and recovers it from a fresh manager", async () => {
		const { harness, sessionRef } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "issue-217-stale-generation";
		await harness.session.steer("recover from the authoritative revision", undefined, clientMessageId);

		await loseConversationLock(harness.sessionManager);
		const store = await trackedStore(sessionRef.sessionDirectory);
		const winnerOrdinal = (await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration))
			?.lastOrdinal;

		await expect(harness.control.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});

		await expect(harness.session.lost).resolves.toMatchObject({ reason: "fence_conflict" });
		expect((await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration))?.lastOrdinal).toBe(
			winnerOrdinal,
		);
		expect(harness.control.hasPendingPrompt()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
		// The host ends the lost session, which releases its lock.
		harness.session.dispose();
		await harness.session.waitForClosed();

		const reopened = await own(SessionManager.open(sessionRef));
		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(reopened.getClientInputRecoveryPlan()).toMatchObject({
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
		const { harness } = await setup({
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
			_mcpManager?: { startEagerServers(): Promise<void>; dispose(): Promise<void> };
		};
		internals._mcpManager = { startEagerServers: mcpStart, dispose: mcpDispose };
		await harness.session.steer("fail authority", undefined, "issue-217-side-effect-fence");
		await harness.session.followUp("hand back later input");
		faultNextPlanningCommit(harness.sessionManager, "uncertain_rollback");

		await expect(harness.control.continue()).resolves.toMatchObject({
			status: "delivery_failed",
			failure: { outcome: "terminally_failed", phase: "settlement" },
		});

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
		await expect(harness.session.clearQueue()).resolves.toEqual({
			steering: [],
			followUp: ["hand back later input"],
		});
		expect(harness.control.hasQueuedMessages()).toBe(false);
		harness.session.dispose();
		// The loss was reported through `lost`; closing does not report it again.
		await expect(harness.session.waitForClosed()).resolves.toBeUndefined();
		expect(mcpDispose).toHaveBeenCalledOnce();
	});

	it.each([
		{ mode: "uncertain_committed" as const, authoritativeOutcome: "committed" as const },
		{ mode: "uncertain_rollback" as const, authoritativeOutcome: "rolled_back" as const },
	])(
		"recovers from the authoritative $authoritativeOutcome commit after its outcome was unknown",
		async ({ mode, authoritativeOutcome }) => {
			const { harness, sessionRef, baseline } = await setup();
			harness.setResponses([fauxAssistantMessage("must remain unused")]);
			const clientMessageId = `issue-217-unavailable-${authoritativeOutcome}`;
			const laterClientMessageId = `issue-217-later-${authoritativeOutcome}`;
			await harness.session.steer("unproven feedback", undefined, clientMessageId);
			await harness.session.followUp("later queued feedback", undefined, laterClientMessageId);
			const faulty = faultNextPlanningCommit(harness.sessionManager, mode);
			const planningEventsBefore = harness.eventsOfType("planning_state_changed").length;
			const deliveryEventsBefore = harness.eventsOfType("delivery_start").length;
			const queueEventsBefore = harness.eventsOfType("queue_update").length;

			await expect(harness.control.continue()).resolves.toMatchObject({
				status: "delivery_failed",
				failure: { outcome: "terminally_failed", phase: "settlement" },
			});

			expect(harness.eventsOfType("planning_state_changed")).toHaveLength(planningEventsBefore);
			expect(harness.eventsOfType("delivery_start")).toHaveLength(deliveryEventsBefore);
			expect(harness.eventsOfType("queue_update")).toHaveLength(queueEventsBefore);
			expect(harness.getPendingResponseCount()).toBe(1);
			await expect(harness.sessionManager.lost).resolves.toMatchObject({ reason: "uncertain_commit" });
			const batch = faultedBatch(faulty);
			const store = await trackedStore(sessionRef.sessionDirectory);
			const summary = await store.findSessionSummary(sessionRef.sessionId, sessionRef.sessionGeneration);
			expect(summary?.lastOrdinal).toBe(
				authoritativeOutcome === "committed" ? batch.expectedOrdinal + batch.entries : batch.expectedOrdinal,
			);
			expect(harness.session.sessionRef).toEqual(sessionRef);
			await expect(harness.sessionManager.closePersistence()).resolves.toBeUndefined();

			const reopened = await own(SessionManager.open(sessionRef));
			const replacement = await createHarness({ sessionManager: reopened });
			harnesses.push(replacement);
			if (authoritativeOutcome === "committed") {
				replacement.setResponses([fauxAssistantMessage("fresh recovery later")]);
				expect(snapshotEntries(reopened.getBranch())).toEqual({
					phase: "draft",
					checkpoints: baseline.checkpoints + 1,
					userTexts: ["unproven feedback"],
				});
				expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
				expect(reopened.getClientInputRecoveryPlan()).toMatchObject({
					kind: "replay",
					records: [{ clientMessageId: laterClientMessageId }],
				});
			} else {
				replacement.setResponses([
					fauxAssistantMessage("fresh recovery first"),
					fauxAssistantMessage("fresh recovery later"),
				]);
				expect(snapshotEntries(reopened.getBranch())).toEqual(baseline);
				expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
				expect(reopened.getClientInputRecoveryPlan()).toMatchObject({
					kind: "replay",
					records: [{ clientMessageId }, { clientMessageId: laterClientMessageId }],
				});
			}

			await replacement.session.resumeRecoveredClientInputs();
			expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
			expect(reopened.getClientInput(laterClientMessageId)).toMatchObject({ state: "completed" });
			expect(getUserTexts(replacement)).toEqual(["unproven feedback", "later queued feedback"]);
			expect(getAssistantTexts(replacement)).toEqual(
				authoritativeOutcome === "committed"
					? ["fresh recovery later"]
					: ["fresh recovery first", "fresh recovery later"],
			);
			expect(replacement.getPendingResponseCount()).toBe(0);
		},
	);
});
