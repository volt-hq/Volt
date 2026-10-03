import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePersistedSessionEntry } from "../../../src/core/session-entry-codec.ts";
import { type SessionEntry, SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	type SQLiteSessionStoreLease,
} from "../../../src/core/session-store/index.ts";
import { loseConversationLock } from "../../lost-conversation-lock.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "../harness.ts";

async function faultNextTransaction(manager: SessionManager): Promise<SQLiteSessionStoreLease> {
	const lease = await acquireSharedSQLiteSessionStore(manager.getSessionDir());
	const store = lease.client;
	const applyTransaction = store.applyTransaction.bind(store);
	vi.spyOn(store, "applyTransaction").mockImplementation(async (input) => {
		if (
			!input.payload.entries.some(
				(entry) => parsePersistedSessionEntry(entry.entry).type === "planning_state_change",
			)
		) {
			return applyTransaction(input);
		}
		throw new Error("injected pre-commit transaction failure");
	});
	return lease;
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

async function snapshotReopened(sessionRef: SessionReference): Promise<PlanningSnapshot> {
	const manager = await SessionManager.openReadOnly(sessionRef);
	try {
		return snapshotEntries(manager.getBranch());
	} finally {
		await manager.closePersistence();
	}
}

async function createReadyPlan(harness: Harness): Promise<void> {
	await harness.session.setAgentMode("plan");
	const draft = await harness.session.updatePlan({
		title: "Atomic planning feedback",
		summary: "Commit plan state and canonical feedback together.",
		steps: [{ text: "Apply feedback atomically" }],
	});
	await harness.session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
}

describe("regression #212: planning and canonical delivery atomicity", () => {
	const harnesses: Harness[] = [];
	const managers: SessionManager[] = [];
	const storeLeases: SQLiteSessionStoreLease[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
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

	async function setup(
		extensionFactories?: HarnessOptions["extensionFactories"],
	): Promise<{ harness: Harness; sessionRef: SessionReference; baseline: PlanningSnapshot }> {
		const tempDir = mkdtempSync(join(tmpdir(), "volt-issue-212-"));
		tempDirs.push(tempDir);
		const sessionManager = await SessionManager.create(tempDir, join(tempDir, "sessions"));
		const harness = await createHarness({
			sessionManager,
			...(extensionFactories === undefined ? {} : { extensionFactories }),
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		return {
			harness,
			sessionRef: sessionManager.getSessionRef()!,
			baseline: snapshotHarness(harness),
		};
	}

	async function expectRetainedFailure(
		harness: Harness,
		sessionRef: SessionReference,
		baseline: PlanningSnapshot,
		clientMessageId: string,
	): Promise<void> {
		// An idle steer starts its turn; its delivery transaction rolls back and the steer stays queued.
		await harness.session.steer("revise this ready plan", undefined, clientMessageId);
		await harness.session.waitForIdle();
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(await snapshotReopened(sessionRef)).toEqual(baseline);
		expect(harness.getPendingResponseCount()).toBe(1);
		await harness.session.clearQueue();
	}

	it("keeps the ready plan when the SQLite transaction rolls back", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		storeLeases.push(await faultNextTransaction(harness.sessionManager));

		await expectRetainedFailure(harness, sessionRef, baseline, "issue-212-first-durability");
	});

	it("atomically commits after reopening the SQLite-backed session", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harnesses.pop();
		harness.session.dispose();
		await harness.session.waitForClosed();
		await harness.cleanupAsync();

		const resumed = await createHarness({ sessionManager: await SessionManager.open(sessionRef) });
		harnesses.push(resumed);
		resumed.setResponses([fauxAssistantMessage("feedback applied")]);
		await resumed.session.prompt("revise this ready plan");

		expect(snapshotHarness(resumed)).toEqual({
			phase: "draft",
			checkpoints: baseline.checkpoints + 1,
			userTexts: ["revise this ready plan"],
		});
		expect(await snapshotReopened(sessionRef)).toEqual(snapshotHarness(resumed));
		expect(resumed.getPendingResponseCount()).toBe(0);
	});

	it("ends the session instead of committing past a lost lock", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "issue-212-stale-preimage";
		// The steer queues behind a held turn claim; the lock is lost before its turn delivers it.
		const claim = harness.control.conversation.reserve();
		await harness.session.steer("revise this ready plan", undefined, clientMessageId);
		await loseConversationLock(harness.sessionManager);
		claim.cancel();

		await expect(harness.session.lost).resolves.toMatchObject({ reason: "fence_conflict" });
		expect(harness.getPendingResponseCount()).toBe(1);
		const reopened = await SessionManager.openReadOnly(sessionRef);
		managers.push(reopened);
		expect(snapshotEntries(reopened.getBranch())).toEqual(baseline);
		expect(reopened.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		harnesses.pop();
		harness.session.dispose();
		await harness.session.waitForClosed().catch(() => {});
		await harness.cleanupAsync().catch(() => {});
	});

	it("assigns one ready-plan transition across a mixed prompt and steer batch", async () => {
		const preparing = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { harness, sessionRef, baseline } = await setup([
			(volt) => {
				volt.on("before_agent_start", async () => {
					preparing.resolve();
					await release.promise;
				});
			},
		]);
		harness.setResponses([fauxAssistantMessage("both applied")]);
		// The steer arrives while the prompt prepares its turn; the turn delivers both together.
		const prompt = harness.session.prompt("pending prompt", {
			clientMessageId: "issue-212-mixed-prompt",
			source: "rpc",
		});
		await preparing.promise;
		await harness.session.steer("queued steer", undefined, "issue-212-mixed-steer");
		release.resolve();
		await prompt;
		await harness.session.waitForIdle();

		const live = snapshotHarness(harness);
		expect(live).toEqual({
			phase: "draft",
			checkpoints: baseline.checkpoints + 1,
			userTexts: ["queued steer", "pending prompt"],
		});
		expect(await snapshotReopened(sessionRef)).toEqual(live);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("publishes planning before transcript observers and commits nested writes after the delivery", async () => {
		const { harness } = await setup();
		harness.setResponses([fauxAssistantMessage("feedback applied")]);
		const observedPhases: Array<string | undefined> = [];
		const nestedWrites: Promise<void>[] = [];
		const unsubscribe = harness.sessionManager.subscribeEntries((entry) => {
			if (
				(entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint") ||
				(entry.type === "message" && entry.message.role === "user")
			) {
				observedPhases.push(harness.session.planningState.plan?.phase);
				nestedWrites.push(harness.session.sessionWriter.appendFastModeChange(true));
			}
		});

		await harness.session.steer("revise this ready plan", undefined, "issue-212-observer-order");
		await harness.session.waitForIdle();
		unsubscribe();
		await Promise.all(nestedWrites);

		expect(observedPhases).toEqual(["draft", "draft"]);
		// Observer writes commit after the delivery instead of joining its batch.
		const branch = harness.sessionManager.getBranch();
		const userIndex = branch.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
		expect(branch[userIndex - 1]).toMatchObject({ type: "custom_message", customType: "volt-plan-checkpoint" });
		expect(branch.slice(userIndex + 1).map((entry) => entry.type)).toEqual([
			"fast_mode_change",
			"fast_mode_change",
			"message",
		]);
	});

	it("fails an identified direct prompt whose delivery transaction rolls back", async () => {
		const { harness, sessionRef, baseline } = await setup();
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		storeLeases.push(await faultNextTransaction(harness.sessionManager));
		const clientMessageId = "issue-212-direct-pre-replacement";

		await expect(
			harness.session.prompt("revise this ready plan", {
				clientMessageId,
				source: "rpc",
			}),
		).rejects.toThrow();
		// The prompt's caller learns the failure; nothing of the delivery or the plan transition persists.
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "failed" });
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(snapshotHarness(harness)).toEqual(baseline);
		expect(await snapshotReopened(sessionRef)).toEqual(baseline);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
