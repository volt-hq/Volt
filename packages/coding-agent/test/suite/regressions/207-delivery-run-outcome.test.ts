import { setImmediate } from "node:timers/promises";
import type { AgentMessage, ConversationLogAppend } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
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

/** Whether a log batch delivers the user message carrying `text`. */
function deliversUserText(text: string): (batch: ConversationLogAppend) => boolean {
	return (batch) =>
		batch.entries.some((entry) => {
			if (entry.type !== "message") return false;
			const message = (entry.payload as { message?: AgentMessage }).message;
			return message?.role === "user" && getMessageText(message) === text;
		});
}

describe("regression #207: delivery run outcomes", () => {
	let harness: Harness | undefined;

	afterEach(async () => {
		await harness?.cleanupAsync();
		harness = undefined;
	});

	it("does not automatically retry a rolled-back delivery after the run settles", async () => {
		harness = await createHarness({ log: "memory" });
		harness.setResponses([fauxAssistantMessage("explicit retry completed")]);
		const log = harness.log!;
		const append = vi.spyOn(log, "append");
		const deliveryAttempts = () => append.mock.calls.filter(([batch]) => deliversUserMessage(batch)).length;
		const clientMessageId = "bounded-retained-input";
		log.failNext("rolled_back", deliversUserMessage);

		await harness.session.steer("bounded retained input", undefined, clientMessageId);
		await harness.session.waitForIdle();
		for (let tick = 0; tick < 5; tick++) await setImmediate();

		expect(deliveryAttempts()).toBe(1);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("accepted");
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(getUserTexts(harness)).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);

		await harness.control.continue();

		expect(deliveryAttempts()).toBe(2);
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("completed");
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["bounded retained input"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not retry a delivery commit whose outcome is unknown as a transient provider failure", async () => {
		harness = await createHarness({
			log: "memory",
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harness.setResponses([fauxAssistantMessage("unexpected provider retry")]);
		harness.log!.failNext(lose("uncertain_commit", { message: "overloaded_error" }), deliversUserMessage);

		await expect(harness.session.prompt("ambiguous delivery")).rejects.toThrow(
			"The session lost its log before the client input settled",
		);

		await expect(harness.session.lost).resolves.toMatchObject({
			reason: "uncertain_commit",
			message: "overloaded_error",
		});
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.messages).toEqual([]);
		await expect(harness.control.continue()).rejects.toThrow("The conversation has ended");
	});

	it("settles an active provider retry when a queued delivery commit rolls back", async () => {
		const retryStarted = deferred();
		const retryEnds: Array<{ success: boolean; finalError?: string }> = [];
		const retryDecisions: boolean[] = [];
		harness = await createHarness({
			log: "memory",
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 50 } },
		});
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "overloaded", retryable: true, message: "overloaded_error" },
			}),
			fauxAssistantMessage("explicit retry completed"),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "agent_end") retryDecisions.push(event.willRetry);
			if (event.type === "auto_retry_start") retryStarted.resolve();
			if (event.type === "auto_retry_end") {
				retryEnds.push({ success: event.success, ...(event.finalError ? { finalError: event.finalError } : {}) });
			}
		});
		harness.log!.failNext("rolled_back", deliversUserText("retained retry input"));

		const prompt = harness.session.prompt("provider retry origin");
		await retryStarted.promise;
		await harness.session.steer("retained retry input");
		await prompt;
		await harness.session.waitForIdle();

		expect(retryEnds).toEqual([{ success: false, finalError: "Injected rollback" }]);
		expect(retryDecisions).toEqual([true, false]);
		expect(harness.control.hasQueuedMessages()).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);

		await harness.control.continue();

		expect(retryEnds).toEqual([{ success: false, finalError: "Injected rollback" }]);
		expect(harness.control.hasQueuedMessages()).toBe(false);
		expect(getUserTexts(harness)).toEqual(["provider retry origin", "retained retry input"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
