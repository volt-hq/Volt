import {
	type AgentMessage,
	CONVERSATION_LOG_READ_LIMIT_MAX,
	type ConversationLog,
	type ConversationLogAppend,
	type ConversationLogAppendResult,
	type ConversationLogEntry,
	type ConversationLogLostError,
	type ConversationLogPage,
	InMemoryConversationLog,
	uuidv7,
} from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { PromptPreflightResult } from "../../../src/core/agent-session.ts";
import { appendsEntryType, lose } from "../../utilities/faulty-log.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

type BatchMatcher = (batch: ConversationLogAppend) => boolean;

/** Whether a log batch delivers a user message: a turn's delivery commit. */
function deliversUserMessage(batch: ConversationLogAppend): boolean {
	return batch.entries.some(
		(entry) => entry.type === "message" && (entry.payload as { message?: AgentMessage }).message?.role === "user",
	);
}

/** Whether a log batch delivers the user message carrying `text`. */
function deliversUserText(text: string): BatchMatcher {
	return (batch) =>
		batch.entries.some((entry) => {
			if (entry.type !== "message") return false;
			const message = (entry.payload as { message?: AgentMessage }).message;
			return message?.role === "user" && getMessageText(message) === text;
		});
}

/**
 * An in-memory log that pauses the first matching append after it committed:
 * the batch is durable, but its writer has not seen the result yet.
 */
class PostCommitGateLog implements ConversationLog {
	readonly conversationId: string;
	readonly lost: Promise<ConversationLogLostError>;
	readonly committed = deferred();
	private readonly released = deferred();
	private readonly inner = new InMemoryConversationLog(uuidv7());
	private readonly matches: BatchMatcher;
	private armed = true;

	constructor(matches: BatchMatcher) {
		this.matches = matches;
		this.conversationId = this.inner.conversationId;
		this.lost = this.inner.lost;
	}

	head(): number {
		return this.inner.head();
	}

	async append(batch: ConversationLogAppend): Promise<ConversationLogAppendResult> {
		const result = await this.inner.append(batch);
		if (this.armed && result.status === "committed" && this.matches(batch)) {
			this.armed = false;
			this.committed.resolve();
			await this.released.promise;
		}
		return result;
	}

	read(afterOrdinal: number, limit: number): Promise<ConversationLogPage> {
		return this.inner.read(afterOrdinal, limit);
	}

	close(): Promise<void> {
		return this.inner.close();
	}

	release(): void {
		this.released.resolve();
	}

	/** Every committed entry, read from the log itself. */
	async entries(): Promise<ConversationLogEntry[]> {
		return [...(await this.inner.read(0, CONVERSATION_LOG_READ_LIMIT_MAX)).entries];
	}
}

async function createReadyPlan(harness: Harness): Promise<void> {
	await harness.session.setAgentMode("plan");
	const draft = await harness.session.updatePlan({
		title: "Delivery transaction contract",
		summary: "Keep planning feedback in the delivery transaction.",
		steps: [{ text: "Apply the committed feedback" }],
	});
	await harness.session.submitPlan({
		planId: draft.id,
		expectedRevision: draft.revision,
		title: draft.title!,
		summary: draft.summary!,
	});
}

function checkpointCount(harness: Harness): number {
	return harness.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint").length;
}

function planningChangeCount(harness: Harness): number {
	return harness.sessionManager.getBranch().filter((entry) => entry.type === "planning_state_change").length;
}

function canonicalUserMessages(harness: Harness, clientMessageId: string): number {
	return harness.sessionManager
		.getBranch()
		.filter(
			(entry) =>
				entry.type === "message" && entry.message.role === "user" && entry.clientMessageId === clientMessageId,
		).length;
}

/** Queue `inputs` while a turn reservation holds the idle conversation, then start one turn for them. */
async function queueBehindReservation(harness: Harness, inputs: () => Promise<void>): Promise<void> {
	const reservation = harness.control.conversation.reserve();
	try {
		await inputs();
	} finally {
		reservation.cancel();
	}
	await harness.session.waitForIdle();
}

describe("regression #206: coding-agent delivery transaction contract", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()!.cleanupAsync();
	});

	it("settles an identified RPC prompt only after canonical client-input durability", async () => {
		const clientMessageId = "contract-direct-rpc";
		const log = new PostCommitGateLog(deliversUserMessage);
		const harness = await createHarness({ log });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("durably admitted")]);
		const preflightResults: PromptPreflightResult[] = [];

		const prompt = harness.session.prompt("durable direct prompt", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflightResults.push(result),
		});
		await log.committed.promise;

		// The delivery is durable in the log, but nothing is published or requested yet.
		const durable = (await log.entries()).filter(
			(entry) => entry.type === "message" && "clientMessageId" in entry && entry.clientMessageId === clientMessageId,
		);
		expect(durable).toHaveLength(1);
		expect(preflightResults).toEqual([]);
		expect(harness.eventsOfType("delivery_start")).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		log.release();
		await prompt;

		expect(preflightResults).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(canonicalUserMessages(harness, clientMessageId)).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it.each(["steer", "followUp"] as const)(
		"settles identified %s from durable queue admission through one canonical message",
		async (kind) => {
			const harness = await createHarness({ log: "memory" });
			harnesses.push(harness);
			const clientMessageId = `contract-${kind}`;
			const text = `${kind} delivery`;
			harness.setResponses([fauxAssistantMessage(`${kind} committed`)]);
			const hold = harness.log!.holdNext(deliversUserMessage);

			if (kind === "steer") await harness.session.steer(text, undefined, clientMessageId);
			else await harness.session.followUp(text, undefined, clientMessageId);
			await hold.started;

			expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({
				state: "accepted",
				queuedInput: { delivery: kind === "steer" ? "steer" : "follow_up", message: text },
			});
			expect(getUserTexts(harness)).toEqual([]);

			hold.release();
			await harness.session.waitForIdle();

			expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
			expect(getUserTexts(harness)).toEqual([text]);
			expect(canonicalUserMessages(harness, clientMessageId)).toBe(1);
		},
	);

	it.each(["steer", "followUp"] as const)(
		"keeps a rolled-back %s delivery queued with its accepted client input for retry",
		async (kind) => {
			const harness = await createHarness({ log: "memory" });
			harnesses.push(harness);
			const clientMessageId = `contract-retained-${kind}`;
			const text = `retained ${kind}`;
			harness.setResponses([fauxAssistantMessage("retained input committed")]);
			harness.log!.failNext("rolled_back", deliversUserText(text));

			if (kind === "steer") await harness.session.steer(text, undefined, clientMessageId);
			else await harness.session.followUp(text, undefined, clientMessageId);
			await harness.session.waitForIdle();

			expect(harness.log!.faulted).toHaveLength(1);
			expect(harness.control.hasQueuedMessages()).toBe(true);
			expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
			expect(getUserTexts(harness)).toEqual([]);
			expect(harness.getPendingResponseCount()).toBe(1);

			await harness.control.continue();

			expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
			expect(getUserTexts(harness)).toEqual([text]);
			expect(canonicalUserMessages(harness, clientMessageId)).toBe(1);
			expect(harness.control.hasQueuedMessages()).toBe(false);
		},
	);

	it("keeps transcript and planning unchanged when the planning commit rolls back, then discards explicitly", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		await createReadyPlan(harness);
		const clientMessageId = "contract-durability-discard";
		const checkpointBaseline = checkpointCount(harness);
		const planningBaseline = planningChangeCount(harness);
		const outcomes: object[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "client_input_outcome") outcomes.push(event);
		});
		harness.log!.failNext("rolled_back", appendsEntryType("planning_state_change"));

		await harness.session.steer("discard retained feedback", undefined, clientMessageId);
		await harness.session.waitForIdle();

		expect(harness.log!.faulted).toHaveLength(1);
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.session.planningState.plan?.phase).toBe("ready");
		expect(planningChangeCount(harness)).toBe(planningBaseline);
		expect(checkpointCount(harness)).toBe(checkpointBaseline);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);

		await expect(harness.session.clearQueue()).resolves.toEqual({
			steering: ["discard retained feedback"],
			followUp: [],
		});
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "withdrawn" });
		expect(outcomes).toEqual([
			{
				type: "client_input_outcome",
				clientMessageId,
				outcome: "failed",
				reason: "queue_cleared",
			},
		]);
	});

	it("ends the session when a delivery commit's outcome is unknown, leaving its input recoverable", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		const clientMessageId = "contract-unknown-commit";
		harness.log!.failNext(
			lose("uncertain_commit", { message: "injected unknown commit outcome" }),
			deliversUserMessage,
		);

		await harness.session.steer("unknown delivery", undefined, clientMessageId);

		await expect(harness.session.lost).resolves.toMatchObject({
			reason: "uncertain_commit",
			message: "injected unknown commit outcome",
		});
		// Nothing can record an outcome after the loss; the durable input stays recoverable for the next writer.
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.sessionManager.getClientInputRecoveryPlan()).toMatchObject({
			kind: "replay",
			records: [{ clientMessageId }],
		});
		expect(harness.sessionManager.getConversationState().context.messages).toEqual([]);
		await expect(harness.session.steer("after the loss")).rejects.toMatchObject({ reason: "uncertain_commit" });
	});

	it("lets an external abort win before commit without revoking retained feedback", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		const harness = await createHarness({
			log: "memory",
			extensionFactories: [
				(volt) => {
					volt.on("message_end", async (event) => {
						if (event.message.role !== "user") return;
						preparationStarted.resolve();
						await releasePreparation.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		await createReadyPlan(harness);
		const clientMessageId = "contract-abort-before-commit";
		const checkpointBaseline = checkpointCount(harness);

		await harness.session.steer("retain after external abort", undefined, clientMessageId);
		await preparationStarted.promise;
		const abort = harness.session.abort("remote_request");
		releasePreparation.resolve();
		await abort;
		await harness.session.waitForIdle();

		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "accepted" });
		expect(harness.session.planningState.plan?.phase).toBe("ready");
		expect(checkpointCount(harness)).toBe(checkpointBaseline);
		expect(getUserTexts(harness)).toEqual([]);

		await harness.session.clearQueue();
	});

	it("preserves the committed winner when external abort races canonical durability", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "contract-abort-during-durability";
		const hold = harness.log!.holdNext(appendsEntryType("planning_state_change"));
		const preflightResults: PromptPreflightResult[] = [];

		const prompt = harness.session.prompt("commit before external abort", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflightResults.push(result),
		});
		await hold.started;
		const abort = harness.session.abort("remote_request");
		expect(preflightResults).toEqual([]);
		hold.release();
		await Promise.all([prompt, abort]);

		expect(preflightResults).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(getUserTexts(harness)).toEqual(["commit before external abort"]);
		expect(checkpointCount(harness)).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("preserves delivery and planning state when disposal is requested while the delivery commits", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "contract-dispose-during-commit";
		const hold = harness.log!.holdNext(appendsEntryType("planning_state_change"));

		const prompt = harness.session.prompt("commit before disposal", { clientMessageId });
		await hold.started;
		harness.session.dispose("disposal");
		const disposal = harness.session.waitForClosed();
		hold.release();
		await prompt;
		await disposal;

		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({ state: "completed" });
		expect(
			harness.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "planning_state_change")
				.at(-1)?.planning.plan?.phase,
		).toBe("draft");
		expect(checkpointCount(harness)).toBe(1);
		const messages = harness.sessionManager.getConversationState().context.messages;
		expect(messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			"commit before disposal",
		]);
		expect(
			messages.filter((message) => message.role === "assistant" && message.stopReason === "aborted"),
		).toHaveLength(1);
	});

	it("commits one ready-to-draft transition and checkpoint for an all-mode batch", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.setSteeringMode("all");
		const planningBaseline = planningChangeCount(harness);
		const checkpointBaseline = checkpointCount(harness);
		harness.setResponses([fauxAssistantMessage("batch committed")]);

		await queueBehindReservation(harness, async () => {
			await harness.session.steer("first batch feedback", undefined, "contract-batch-first");
			await harness.session.steer("second batch feedback", undefined, "contract-batch-second");
		});

		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(planningChangeCount(harness)).toBe(planningBaseline + 1);
		expect(checkpointCount(harness)).toBe(checkpointBaseline + 1);
		expect(getUserTexts(harness)).toEqual(["first batch feedback", "second batch feedback"]);
		expect(harness.sessionManager.getClientInput("contract-batch-first")).toMatchObject({ state: "completed" });
		expect(harness.sessionManager.getClientInput("contract-batch-second")).toMatchObject({ state: "completed" });
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("preserves a committed all-mode prefix when a later delivery commit rolls back", async () => {
		const harness = await createHarness({ log: "memory" });
		harnesses.push(harness);
		await createReadyPlan(harness);
		harness.session.setSteeringMode("all");
		const planningBaseline = planningChangeCount(harness);
		const checkpointBaseline = checkpointCount(harness);
		harness.setResponses([fauxAssistantMessage("retained suffix committed")]);
		harness.log!.failNext("rolled_back", deliversUserText("second partial feedback"));

		await queueBehindReservation(harness, async () => {
			await harness.session.steer("first partial feedback", undefined, "contract-partial-first");
			await harness.session.steer("second partial feedback", undefined, "contract-partial-second");
		});

		expect(getUserTexts(harness)).toEqual(["first partial feedback"]);
		expect(harness.sessionManager.getClientInput("contract-partial-first")).toMatchObject({ state: "completed" });
		expect(harness.sessionManager.getClientInput("contract-partial-second")).toMatchObject({ state: "accepted" });
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(harness.session.planningState.plan?.phase).toBe("draft");
		expect(planningChangeCount(harness)).toBe(planningBaseline + 1);
		expect(checkpointCount(harness)).toBe(checkpointBaseline + 1);
		expect(harness.getPendingResponseCount()).toBe(1);

		await harness.control.continue();

		expect(getUserTexts(harness)).toEqual(["first partial feedback", "second partial feedback"]);
		expect(harness.sessionManager.getClientInput("contract-partial-second")).toMatchObject({ state: "completed" });
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(planningChangeCount(harness)).toBe(planningBaseline + 1);
		expect(checkpointCount(harness)).toBe(checkpointBaseline + 1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
