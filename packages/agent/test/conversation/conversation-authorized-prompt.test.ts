import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import { fold } from "../../src/conversation/fold.ts";
import { openConversation, promptAndSettle, readLog, userTexts } from "./conversation-test-utils.ts";

describe("reserved prompt authority", () => {
	it("requires an exclusive reservation", async () => {
		const { conversation, faux } = await openConversation();
		await expect(conversation.prompt({ message: "unauthorized" }, { assertCurrent: () => {} })).rejects.toMatchObject(
			{ code: "invalid_argument" },
		);
		expect(conversation.state.clientInputs.inputs.size).toBe(0);
		expect(faux.state.callCount).toBe(0);
	});

	it("rejects revoked authority before persistence and releases its reservation", async () => {
		const { conversation, log, faux } = await openConversation();
		const before = await readLog(log);
		await expect(
			conversation.prompt(
				{ message: "stale" },
				{
					reservation: conversation.reserve(),
					assertCurrent: () => {
						throw new Error("revoked");
					},
				},
			),
		).rejects.toThrow("revoked");
		expect(await readLog(log)).toEqual(before);
		expect(conversation.operation).toBeUndefined();
		faux.setResponses([fauxAssistantMessage("fresh")]);
		await promptAndSettle(conversation, "fresh");
		expect(userTexts(conversation.state.context.messages)).toEqual(["fresh"]);
	});

	it("fails a receipt revoked during persistence without delivering or replaying its prompt", async () => {
		const { conversation, log, faux } = await openConversation();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const append = log.append.bind(log);
		vi.spyOn(log, "append").mockImplementationOnce(async (batch) => {
			entered.resolve();
			await release.promise;
			return append(batch);
		});
		let current = true;
		const pending = conversation.prompt(
			{ clientMessageId: "proposal", message: "stale" },
			{
				reservation: conversation.reserve(),
				assertCurrent: () => {
					if (!current) throw new Error("revoked");
				},
			},
		);
		const rejected = expect(pending).rejects.toThrow("revoked");
		await entered.promise;
		current = false;
		release.resolve();
		await rejected;
		await conversation.waitForIdle();
		expect(conversation.state.clientInputs.inputs.get("proposal")).toMatchObject({
			state: "failed",
			error: "revoked",
		});
		expect(conversation.state).toEqual(fold(await readLog(log)));
		expect(conversation.queue).toEqual({ prompt: [], steer: [], followUp: [] });
		expect(conversation.operation).toBeUndefined();
		expect(faux.state.callCount).toBe(0);
		faux.setResponses([fauxAssistantMessage("fresh")]);
		await promptAndSettle(conversation, "fresh");
		expect(userTexts(conversation.state.context.messages)).toEqual(["fresh"]);
	});

	it("admits a current proposal normally", async () => {
		const { conversation, faux } = await openConversation();
		faux.setResponses([fauxAssistantMessage("done")]);
		const admission = await conversation.prompt(
			{ message: "current" },
			{
				reservation: conversation.reserve(),
				assertCurrent: () => {},
			},
		);
		await expect(admission.completion).resolves.toMatchObject({ state: "completed" });
		await conversation.waitForIdle();
		expect(userTexts(conversation.state.context.messages)).toEqual(["current"]);
		expect(faux.state.callCount).toBe(1);
	});
});
