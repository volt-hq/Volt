import type { AgentMessage, ConversationLogAppend } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PromptPreflightResult } from "../../../src/core/agent-session.ts";
import { lose } from "../../utilities/faulty-log.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

/** Whether a log batch delivers a user message: a turn's delivery commit. */
function deliversUserMessage(batch: ConversationLogAppend): boolean {
	return batch.entries.some(
		(entry) => entry.type === "message" && (entry.payload as { message?: AgentMessage }).message?.role === "user",
	);
}

describe("regression #205: coding-agent delivery on the conversation kernel", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.cleanupAsync();
		harness = undefined;
	});

	it("publishes a delivery only after its commit settles", async () => {
		harness = await createHarness({ log: "memory" });
		harness.setResponses([fauxAssistantMessage("committed")]);
		const clientMessageId = "delivery-durability-publication";
		const hold = harness.log!.holdNext(deliversUserMessage);
		const preflightResults: PromptPreflightResult[] = [];

		const prompt = harness.session.prompt("durability before publication", {
			clientMessageId,
			source: "rpc",
			preflightResult: (result) => preflightResults.push(result),
		});
		await hold.started;

		expect(harness.eventsOfType("delivery_start")).toEqual([]);
		expect(preflightResults).toEqual([]);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		hold.release();
		await prompt;

		expect(harness.eventsOfType("delivery_start")).toHaveLength(1);
		expect(preflightResults).toEqual([{ success: true, outcome: "admitted" }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("completed");
		expect(getUserTexts(harness)).toEqual(["durability before publication"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("delivers a rolled-back queued input onto the branch tree navigation selects", async () => {
		harness = await createHarness({
			seed: (seed) =>
				seed
					.user("selected branch root", { id: "selected-root" })
					.assistant("selected branch reply", { id: "selected-reply" })
					.user("abandoned branch prompt")
					.assistant("abandoned branch reply"),
		});
		const providerTexts: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTexts.push((context.messages as AgentMessage[]).map(getMessageText));
				return fauxAssistantMessage("committed on selected branch");
			},
		]);
		const clientMessageId = "retained-navigation-rebase";
		harness.log!.failNext("rolled_back", deliversUserMessage);

		await harness.session.steer("retained branch input", undefined, clientMessageId);
		await harness.session.waitForIdle();
		expect(harness.control.hasQueuedMessages()).toBe(true);

		await expect(harness.session.navigateTree("selected-reply")).resolves.toMatchObject({ cancelled: false });
		expect(harness.sessionManager.getLeafId()).toBe("selected-reply");
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("accepted");

		await harness.control.continue();

		expect(providerTexts).toEqual([["selected branch root", "selected branch reply", "retained branch input"]]);
		expect(getUserTexts(harness)).toEqual(["selected branch root", "retained branch input"]);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("completed");
		expect(harness.control.hasQueuedMessages()).toBe(false);
	});

	it("commits nothing when disposal interrupts delivery preparation", async () => {
		const preparationStarted = deferred();
		const releasePreparation = deferred();
		harness = await createHarness({
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
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const append = vi.spyOn(harness.log!, "append");
		const prompting = harness.session.prompt("dispose during delivery preparation").catch(() => {});

		await preparationStarted.promise;
		harness.session.dispose("disposal");
		const disposal = harness.session.waitForClosed();
		releasePreparation.resolve();
		await Promise.all([prompting, disposal]);

		expect(harness.sessionManager.getConversationState().context.messages).toEqual([]);
		expect(append.mock.calls.filter(([batch]) => deliversUserMessage(batch))).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("fails a direct RPC prompt whose delivery commit rolls back, without delivering it", async () => {
		harness = await createHarness({ log: "memory" });
		harness.setResponses([fauxAssistantMessage("must remain unused"), fauxAssistantMessage("fresh prompt")]);
		const clientMessageId = "rolled-back-direct-rpc";
		harness.log!.failNext("rolled_back", deliversUserMessage);
		const firstPreflight: PromptPreflightResult[] = [];

		const failure = await harness.session
			.prompt("rolled back input", {
				clientMessageId,
				source: "rpc",
				preflightResult: (result) => firstPreflight.push(result),
			})
			.then(
				() => undefined,
				(error: unknown) => error,
			);

		expect(failure).toBeInstanceOf(Error);
		expect(firstPreflight).toEqual([{ success: false }]);
		expect(harness.sessionManager.getClientInput(clientMessageId)).toMatchObject({
			state: "failed",
			error: (failure as Error).message,
		});
		expect(harness.control.hasPendingPrompt()).toBe(false);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(2);

		// The input crossed its dispatch boundary; resubmitting it reports the failure instead of running it again.
		await expect(harness.session.prompt("rolled back input", { clientMessageId, source: "rpc" })).rejects.toThrow(
			(failure as Error).message,
		);
		expect(getUserTexts(harness)).toEqual([]);

		await harness.session.prompt("fresh input", { clientMessageId: "fresh-direct-rpc", source: "rpc" });
		expect(getUserTexts(harness)).toEqual(["fresh input"]);
		expect(harness.sessionManager.getClientInput("fresh-direct-rpc")?.state).toBe("completed");
	});

	it("prepares a rolled-back queued input again from its durable payload, committing it once", async () => {
		let extensionRuns = 0;
		const received: string[] = [];
		harness = await createHarness({
			log: "memory",
			extensionFactories: [
				(volt) => {
					volt.on("message_end", (event) => {
						if (event.message.role !== "user") return;
						extensionRuns++;
						received.push(getMessageText(event.message));
						return {
							message: { ...event.message, content: [{ type: "text", text: `transformed (${extensionRuns})` }] },
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("committed")]);
		const clientMessageId = "rolled-back-transformed";
		harness.log!.failNext("rolled_back", deliversUserMessage);

		await harness.session.steer("original", undefined, clientMessageId);
		await harness.session.waitForIdle();
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("accepted");
		await harness.control.continue();

		expect(received).toEqual(["original", "original"]);
		expect(getUserTexts(harness)).toEqual(["transformed (2)"]);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("completed");
	});

	it("prepares a queued input again when abort wins during its preparation", async () => {
		const extensionStarted = deferred();
		const releaseExtension = deferred();
		let extensionRuns = 0;
		harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("message_end", async (event) => {
						if (event.message.role !== "user") return;
						extensionRuns++;
						extensionStarted.resolve();
						await releaseExtension.promise;
						return {
							message: { ...event.message, content: [{ type: "text", text: `prepared (${extensionRuns})` }] },
						};
					});
				},
			],
		});
		harness.setResponses([fauxAssistantMessage("committed after abort")]);
		const clientMessageId = "abort-during-preparation";

		await harness.session.steer("original", undefined, clientMessageId);
		await extensionStarted.promise;
		const aborting = harness.session.abort("host_action");
		releaseExtension.resolve();
		await aborting;
		await harness.session.waitForIdle();

		expect(extensionRuns).toBe(1);
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("accepted");
		expect(getUserTexts(harness)).toEqual([]);
		await harness.control.continue();

		expect(extensionRuns).toBe(2);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["prepared (2)"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("disposal ends the session without delivering a rolled-back queued input, which stays recoverable", async () => {
		harness = await createHarness({ log: "memory" });
		harness.setResponses([fauxAssistantMessage("must remain unused")]);
		const clientMessageId = "dispose-retained-input";
		harness.log!.failNext("rolled_back", deliversUserMessage);

		await harness.session.steer("dispose retained input", undefined, clientMessageId);
		await harness.session.waitForIdle();
		expect(harness.control.hasQueuedMessages()).toBe(true);

		harness.session.dispose("disposal");
		await harness.session.waitForClosed();

		await expect(harness.control.continue()).rejects.toThrow("The conversation has ended");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getConversationState().context.messages).toEqual([]);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("accepted");
		expect(harness.sessionManager.getClientInputRecoveryPlan()).toMatchObject({
			kind: "replay",
			records: [{ clientMessageId }],
		});
	});

	it("ends the session when a delivery commit's outcome is unknown", async () => {
		harness = await createHarness({ log: "memory" });
		harness.setResponses([fauxAssistantMessage("must not run")]);
		harness.log!.failNext(lose("uncertain_commit", { message: "injected durability failure" }), deliversUserMessage);

		await expect(harness.session.prompt("uncertain delivery commit")).rejects.toThrow(
			"The session lost its log before the client input settled",
		);

		await expect(harness.session.lost).resolves.toMatchObject({
			reason: "uncertain_commit",
			message: "injected durability failure",
		});
		await expect(harness.control.continue()).rejects.toThrow("The conversation has ended");
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
