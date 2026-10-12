import { clientInputRecovery } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { HostedConversation } from "../../../src/core/host/hosted-conversation.ts";
import { feedLiveState } from "../../../src/core/host/live-feed.ts";
import { type IntentContext, IntentRejectedError, intentRegistry } from "../../../src/core/protocol/intents/index.ts";
import { rejectionReason } from "../../../src/core/protocol/server/connection.ts";
import {
	ClientInputRecoveryBlockedError,
	DISCARDED_CLIENT_INPUT_ERROR,
} from "../../../src/core/session/client-inputs.ts";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

/** A conversation whose recovery replays the session's recovered input, as a hosted conversation's does. */
function recoveringConversation(harness: Harness): { conversation: HostedConversation; recoveries: Promise<void>[] } {
	const recoveries: Promise<void>[] = [];
	const conversation = {
		startRecoveredClientInputs: () => {
			const recovery = harness.session.resumeRecoveredClientInputs();
			recoveries.push(recovery);
			return recovery;
		},
	} as unknown as HostedConversation;
	return { conversation, recoveries };
}

function intentContext(harness: Harness, conversation: HostedConversation, remote = false): IntentContext {
	return {
		target: { session: harness.session, conversation, host: {} as never, client: {} as never },
		services: {},
		profile: remote
			? {
					name: "remote",
					grant: { schemaVersion: 1, revision: 1, capabilities: ["conversation.control.v1"] },
				}
			: { name: "local" },
	};
}

describe("#492 discarding an ambiguous started client input", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()!.cleanupAsync();
	});

	async function blockedHarness(): Promise<Harness> {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed
					.clientInput("lost-a", "prompt", { message: "lost while sending" }, { states: ["started"] })
					.clientInput("queued-b", "follow_up", { message: "queued behind" }, { queued: "follow_up" }),
		});
		harnesses.push(harness);
		return harness;
	}

	it("fails the input without replaying it, then replays the queue behind it and admits fresh input", async () => {
		const harness = await blockedHarness();
		harness.setResponses([fauxAssistantMessage("replayed reply"), fauxAssistantMessage("fresh reply")]);
		const manager = harness.sessionManager;
		expect(harness.session.ambiguousClientInput).toEqual({
			clientMessageId: "lost-a",
			message: "lost while sending",
		});

		const blocked = await harness.session.prompt("fresh", { clientMessageId: "fresh-c" }).then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(blocked).toBeInstanceOf(ClientInputRecoveryBlockedError);
		expect(blocked).toMatchObject({ code: "client_input_recovery_blocked", clientMessageId: "lost-a" });
		expect(rejectionReason(blocked)).toMatchObject({ code: "unavailable" });

		await expect(harness.session.discardAmbiguousClientInput("lost-a")).resolves.toBeUndefined();
		expect(manager.getClientInput("lost-a")).toMatchObject({ state: "failed", error: DISCARDED_CLIENT_INPUT_ERROR });
		expect(harness.session.ambiguousClientInput).toBeUndefined();
		expect(clientInputRecovery(manager.getConversationState())).toMatchObject({ kind: "replay" });
		// The client that sent it learns the outcome; it was never delivered.
		expect(harness.eventsOfType("client_input_outcome")).toEqual([
			{ type: "client_input_outcome", clientMessageId: "lost-a", outcome: "failed", reason: "dispatch_failed" },
		]);
		// Discarding it again does nothing.
		await expect(harness.session.discardAmbiguousClientInput("lost-a")).resolves.toBeUndefined();

		await harness.session.resumeRecoveredClientInputs();
		expect(manager.getClientInput("queued-b")?.state).toBe("completed");
		// A retry of the same input reports the discard instead of sending it.
		await expect(harness.session.prompt("lost while sending", { clientMessageId: "lost-a" })).rejects.toThrow(
			DISCARDED_CLIENT_INPUT_ERROR,
		);
		await harness.session.prompt("fresh", { clientMessageId: "fresh-c" });
		expect(getUserTexts(harness)).toEqual(["queued behind", "fresh"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("reports the next ambiguous input while another one still blocks", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed
					.clientInput("lost-a", "prompt", { message: "first" }, { states: ["started"] })
					.clientInput("lost-b", "prompt", { message: "second" }, { states: ["started"] }),
		});
		harnesses.push(harness);

		await expect(harness.session.discardAmbiguousClientInput("lost-a")).resolves.toEqual({
			clientMessageId: "lost-b",
			message: "second",
		});
		await expect(harness.session.prompt("fresh", { clientMessageId: "fresh-c" })).rejects.toMatchObject({
			clientMessageId: "lost-b",
		});
		await expect(harness.session.discardAmbiguousClientInput("lost-b")).resolves.toBeUndefined();
		await expect(harness.session.resumeRecoveredClientInputs()).resolves.toBeUndefined();
	});

	it("refuses an input that is not ambiguous", async () => {
		const harness = await blockedHarness();
		await expect(harness.session.discardAmbiguousClientInput("unknown")).rejects.toThrow("Unknown client input");
		await expect(harness.session.discardAmbiguousClientInput("queued-b")).rejects.toThrow(
			"only an ambiguous input is discarded",
		);
		expect(harness.sessionManager.getClientInput("queued-b")?.state).toBe("accepted");
	});

	it("refuses a started input a live prompt still dispatches", async () => {
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const hookEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("input", async () => {
						entered();
						await released;
						return { action: "continue" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("reply")]);

		const prompt = harness.session.prompt("in flight", { clientMessageId: "live-a" });
		await hookEntered;
		expect(harness.sessionManager.getClientInput("live-a")?.state).toBe("started");
		expect(harness.session.ambiguousClientInput).toBeUndefined();
		await expect(harness.session.discardAmbiguousClientInput("live-a")).rejects.toThrow("still being dispatched");
		release();
		await prompt;
		expect(harness.sessionManager.getClientInput("live-a")?.state).toBe("completed");
	});

	describe("the live intents value", () => {
		const stuck = (value: string, label: string) => ({
			name: "discard_client_input",
			enabled: true,
			state: { type: "string", value, label },
		});
		const noneStuck = {
			name: "discard_client_input",
			enabled: false,
			reason: "No message is stuck",
			state: { type: "string", value: null },
		};

		/** Discard over the intent, as a client does, while the live feed publishes the session's live state. */
		async function fedHarness(inputs: ReadonlyArray<readonly [string, string]>) {
			const harness = await createHarness({
				log: "sqlite",
				seed: (seed) => {
					for (const [clientMessageId, message] of inputs) {
						seed.clientInput(clientMessageId, "prompt", { message }, { states: ["started"] });
					}
					return seed;
				},
			});
			harnesses.push(harness);
			const feed = feedLiveState(harness.session);
			const { conversation, recoveries } = recoveringConversation(harness);
			const ctx = intentContext(harness, conversation);
			return {
				feed,
				recoveries,
				discard: (clientMessageId: string) =>
					intentRegistry.invoke(ctx, "discard_client_input", { clientMessageId }),
				published: () => {
					const value = harness.session.liveState.get("intents");
					if (value?.kind !== "intents") return undefined;
					return value.availability.find((intent) => intent.name === "discard_client_input");
				},
			};
		}

		it("stops naming the one stuck input once it is discarded", async () => {
			const { feed, recoveries, discard, published } = await fedHarness([["lost-a", "lost while sending"]]);
			expect(published()).toEqual(stuck("lost-a", "lost while sending"));

			await discard("lost-a");
			expect(published()).toEqual(noneStuck);
			await Promise.all(recoveries);
			feed.close();
		});

		it("names the next stuck input after each discard", async () => {
			const { feed, recoveries, discard, published } = await fedHarness([
				["lost-a", "first"],
				["lost-b", "second"],
			]);
			expect(published()).toEqual(stuck("lost-a", "first"));

			expect((await discard("lost-a")).result).toEqual({
				blocker: { clientMessageId: "lost-b", preview: "second" },
			});
			expect(published()).toEqual(stuck("lost-b", "second"));

			expect((await discard("lost-b")).result).toEqual({});
			expect(published()).toEqual(noneStuck);
			await Promise.all(recoveries);
			feed.close();
		});
	});

	it("discards over the intent for a remote client and replays the queue behind it", async () => {
		const harness = await blockedHarness();
		harness.setResponses([fauxAssistantMessage("replayed reply")]);
		const { conversation, recoveries } = recoveringConversation(harness);
		const ctx = intentContext(harness, conversation, true);

		const invocation = await intentRegistry.invoke(ctx, "discard_client_input", { clientMessageId: "lost-a" });
		expect(invocation.result).toEqual({});
		expect(recoveries).toHaveLength(1);
		await recoveries[0];
		expect(harness.sessionManager.getClientInput("queued-b")?.state).toBe("completed");
		expect(getUserTexts(harness)).toEqual(["queued behind"]);
	});

	it("answers the next blocker over the intent and starts no recovery behind it", async () => {
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed
					.clientInput("lost-a", "prompt", { message: "first" }, { states: ["started"] })
					.clientInput("lost-b", "prompt", { message: "x".repeat(300) }, { states: ["started"] }),
		});
		harnesses.push(harness);
		const { conversation, recoveries } = recoveringConversation(harness);

		const invocation = await intentRegistry.invoke(intentContext(harness, conversation), "discard_client_input", {
			clientMessageId: "lost-a",
		});
		expect(invocation.result).toEqual({ blocker: { clientMessageId: "lost-b", preview: `${"x".repeat(199)}…` } });
		expect(recoveries).toHaveLength(0);
	});

	it("rejects the intent while the conversation is busy", async () => {
		const harness = await blockedHarness();
		const { conversation } = recoveringConversation(harness);
		const busy = { ...intentContext(harness, conversation) };
		Object.defineProperty(harness.session, "isBusy", { get: () => true, configurable: true });
		try {
			intentRegistry.prepare(busy, "discard_client_input", { clientMessageId: "lost-a" });
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(IntentRejectedError);
			expect(error).toMatchObject({ code: "unavailable" });
		} finally {
			Reflect.deleteProperty(harness.session, "isBusy");
		}
		expect(harness.sessionManager.getClientInput("lost-a")?.state).toBe("started");
	});
});
