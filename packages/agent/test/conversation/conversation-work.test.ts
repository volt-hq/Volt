import { type Context, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { WORK_INPUT_MAX_SERIALIZED_BYTES } from "@hansjm10/volt-protocol/work";
import { describe, expect, it } from "vitest";
import type { ConversationWorkStart } from "../../src/conversation/api.ts";
import type { Conversation } from "../../src/conversation/conversation.ts";
import { fold } from "../../src/conversation/fold.ts";
import { InMemoryConversationLog } from "../../src/conversation/in-memory-log.ts";
import type { ConversationLogEntry } from "../../src/conversation/log.ts";
import { calculateTool } from "../utils/calculate.ts";
import {
	openConversation,
	promptAndSettle,
	readLog,
	registerFauxProvider,
	userTexts,
} from "./conversation-test-utils.ts";

const JOB: ConversationWorkStart = {
	kind: "job",
	title: "npm test",
	input: { command: "npm test" },
	cancellable: true,
	delivery: "wake",
	resume: false,
};

async function reconciled(options: Parameters<typeof openConversation>[0] = {}) {
	const opened = await openConversation(options);
	await opened.conversation.work.reconcile();
	return opened;
}

async function copyLog(entries: readonly ConversationLogEntry[], id = "copied"): Promise<InMemoryConversationLog> {
	const log = new InMemoryConversationLog(id);
	const drafts = entries.map(({ ordinal: _ordinal, ...draft }) => draft);
	if (drafts.length > 0) await log.append({ expectedOrdinal: 0, commitId: "copy", entries: drafts });
	return log;
}

function committedTypes(events: Awaited<ReturnType<typeof openConversation>>["events"]): string[][] {
	return events.flatMap((event) => (event.type === "committed" ? [event.entries.map((entry) => entry.type)] : []));
}

function noticeText(conversation: Conversation, clientMessageId: string): unknown {
	return conversation.state.clientInputs.inputs.get(clientMessageId)?.queuedInput?.messages?.[0];
}

describe("Conversation work", () => {
	it("reconciles the previous runtime's open work once, before new work starts", async () => {
		const first = await openConversation({ withModel: false });
		await first.conversation.work.reconcile();
		const start = (workId: string, overrides: Partial<ConversationWorkStart>) =>
			first.conversation.work.start({ ...JOB, workId, delivery: "none", ...overrides });
		await start("job", {});
		await start("review", { kind: "review", resume: false });
		await start("parent", { kind: "subagent", resume: true });
		await start("child", { kind: "subagent", resume: true, parentWorkId: "parent" });
		await start("orphan-parent", { kind: "job" });
		await start("orphan", { kind: "subagent", resume: true, parentWorkId: "orphan-parent" });
		await start("done-parent", { kind: "job" });
		await first.conversation.work.finish("done-parent", { outcome: "completed" });
		await start("done-child", { kind: "subagent", resume: true, parentWorkId: "done-parent" });
		await start("remote-child", { kind: "subagent", resume: true, parentWorkId: "in-another-log" });
		const entries = await readLog(first.log);
		await first.conversation.close();

		const second = await openConversation({ log: await copyLog(entries), withModel: false });
		await expect(second.conversation.work.start(JOB)).rejects.toMatchObject({ code: "invalid_state" });
		const reconciliation = await second.conversation.work.reconcile();
		expect(reconciliation).toEqual({
			interrupt: ["job", "review", "orphan-parent", "orphan", "done-child"],
			suspended: ["parent", "child", "remote-child"],
		});
		expect(committedTypes(second.events)).toEqual([Array(5).fill("work_finished")]);
		expect(second.conversation.state.openWork).toEqual(["parent", "child", "remote-child"]);
		expect(second.conversation.state.work.get("orphan")).toMatchObject({ outcome: "interrupted" });

		expect(await second.conversation.work.reconcile()).toBe(reconciliation);
		expect(committedTypes(second.events)).toHaveLength(1);
		const started = await second.conversation.work.start({ ...JOB, workId: "new" });
		expect(started).toMatchObject({ state: "running", startedOrdinal: second.conversation.state.ordinal });
	});

	it("writes work entries only through work", async () => {
		const { conversation } = await reconciled();
		for (const type of ["work_started", "work_checkpoint", "work_finished"]) {
			await expect(conversation.append([{ type, payload: { workId: "w" } }])).rejects.toMatchObject({
				code: "invalid_argument",
			});
		}
		expect(conversation.state.work.size).toBe(0);
	});

	it("rejects malformed payloads, exceeded bounds, and lifecycle violations without committing", async () => {
		const { conversation, log } = await reconciled({ withModel: false });
		const invalid = { code: "invalid_argument" };
		await expect(conversation.work.start({ ...JOB, title: "two\nlines" })).rejects.toMatchObject(invalid);
		await expect(conversation.work.start({ ...JOB, kind: "ext:Bad/kind" })).rejects.toMatchObject(invalid);
		await expect(
			conversation.work.start({ ...JOB, input: "x".repeat(WORK_INPUT_MAX_SERIALIZED_BYTES) }),
		).rejects.toMatchObject(invalid);
		await expect(conversation.work.start({ ...JOB, parentWorkId: "unknown" })).rejects.toMatchObject(invalid);

		await conversation.work.start({ ...JOB, workId: "w", state: "awaiting_approval" });
		await expect(conversation.work.start({ ...JOB, workId: "w" })).rejects.toMatchObject(invalid);
		await expect(conversation.work.checkpoint("unknown", {})).rejects.toMatchObject(invalid);
		await conversation.work.checkpoint("w", { state: "running", progress: { value: 1, max: 2 } });
		await conversation.work.checkpoint("w", { state: "cancelling" });
		await expect(conversation.work.checkpoint("w", { state: "running" })).rejects.toMatchObject(invalid);
		await conversation.work.finish("w", { outcome: "cancelled" });
		await expect(conversation.work.checkpoint("w", {})).rejects.toMatchObject(invalid);
		await expect(conversation.work.finish("w", { outcome: "completed" })).rejects.toMatchObject(invalid);

		expect(conversation.state.work.get("w")).toMatchObject({
			state: "cancelling",
			outcome: "cancelled",
			progress: { value: 1, max: 2 },
		});
		expect((await readLog(log)).filter((entry) => entry.type.startsWith("work_"))).toHaveLength(4);
		expect(conversation.state).toEqual(fold(await readLog(log)));
	});

	it("wakes an idle conversation with a delivered result's notice", async () => {
		const { conversation, faux, events } = await reconciled();
		const requests: string[][] = [];
		faux.setResponses([
			(context: Context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage("noted");
			},
		]);
		await conversation.work.start({ ...JOB, workId: "job-1" });
		const finished = await conversation.work.finish("job-1", {
			outcome: "failed",
			error: "exit 1",
			result: { summary: "2 tests failed", output: { text: "FAIL a.test.ts", truncated: true } },
		});
		expect(finished.notice?.wake).toBe(true);
		await conversation.waitForIdle();

		expect(committedTypes(events)).toContainEqual(["work_finished", "client_input_receipt", "client_input_queued"]);
		expect(requests).toEqual([["npm test (job job-1) failed.\n2 tests failed\nError: exit 1"]]);
		const notice = finished.notice?.clientMessageId ?? "";
		expect(noticeText(conversation, notice)).toMatchObject({
			role: "custom",
			customType: "work_notice",
			display: true,
			details: {
				workId: "job-1",
				kind: "job",
				title: "npm test",
				outcome: "failed",
				summary: "2 tests failed",
				error: "exit 1",
				output: { truncated: true },
			},
		});
		expect(conversation.state.clientInputs.inputs.get(notice)).toMatchObject({ origin: "host", state: "completed" });
	});

	it("queues a message notice without a turn; it rides the next request", async () => {
		const { conversation, faux } = await reconciled();
		const requests: string[][] = [];
		faux.setResponses([
			(context: Context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage("both seen");
			},
		]);
		await conversation.work.start({ ...JOB, workId: "review", kind: "review", delivery: "message" });
		const finished = await conversation.work.finish("review", {
			outcome: "completed",
			deliver: { text: "Review finished: 3 findings." },
		});
		await conversation.waitForIdle();
		expect(finished.notice?.wake).toBe(false);
		expect(faux.state.callCount).toBe(0);
		expect(conversation.queue.steer).toHaveLength(1);
		expect(conversation.queueWakes).toBe(false);
		expect(
			conversation.state.clientInputs.inputs.get(finished.notice?.clientMessageId ?? "")?.queuedInput,
		).toMatchObject({ wake: false });

		await promptAndSettle(conversation, "what did the review find?");
		// Deliveries keep admission order: the notice was queued first.
		expect(requests).toEqual([["Review finished: 3 findings.", "what did the review find?"]]);
		expect(conversation.queue.steer).toHaveLength(0);
	});

	it("never extends a stopping turn for a message notice, but delivers it with a request the turn makes", async () => {
		const { conversation, faux } = await reconciled();
		conversation.setTools([calculateTool]);
		const requests: string[][] = [];
		let n = 0;
		const finishDuring = (stop: boolean) => async (context: Context) => {
			requests.push(userTexts(context.messages));
			n++;
			await conversation.work.start({ ...JOB, workId: `quiet-${n}`, delivery: "message" });
			await conversation.work.finish(`quiet-${n}`, { outcome: "completed", deliver: { text: `notice ${n}` } });
			return stop
				? fauxAssistantMessage("done")
				: fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: `call-${n}` }), {
						stopReason: "toolUse",
					});
		};
		faux.setResponses([
			finishDuring(true),
			finishDuring(false),
			(context: Context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage("after the tool");
			},
		]);

		await promptAndSettle(conversation, "first");
		expect(faux.state.callCount).toBe(1);
		expect(conversation.queue.steer).toHaveLength(1);

		await promptAndSettle(conversation, "second");
		expect(requests).toEqual([
			["first"],
			["first", "notice 1", "second"],
			["first", "notice 1", "second", "notice 2"],
		]);
		expect(conversation.queue.steer).toHaveLength(0);
	});

	it("delivers nothing for suppressed, cancelled, interrupted, or none-delivery results", async () => {
		const { conversation, faux, events } = await reconciled();
		faux.setResponses([]);
		const finishes = [
			{ delivery: "wake", finish: { outcome: "completed", deliver: false } },
			{ delivery: "wake", finish: { outcome: "cancelled" } },
			{ delivery: "message", finish: { outcome: "interrupted" } },
			{ delivery: "none", finish: { outcome: "completed" } },
		] as const;
		for (const [index, { delivery, finish }] of finishes.entries()) {
			await conversation.work.start({ ...JOB, workId: `w${index}`, delivery });
			expect((await conversation.work.finish(`w${index}`, finish)).notice).toBeUndefined();
		}
		await conversation.waitForIdle();
		expect(committedTypes(events).filter((types) => types.includes("work_finished"))).toEqual(
			Array(4).fill(["work_finished"]),
		);
		expect(faux.state.callCount).toBe(0);
	});

	it("keeps undelivered notices across a restart and delivers them", async () => {
		const faux = registerFauxProvider();
		const first = await reconciled({ faux, withModel: false });
		await first.conversation.work.start({ ...JOB, workId: "woke" });
		await first.conversation.work.start({ ...JOB, workId: "quiet", delivery: "message" });
		const woke = await first.conversation.work.finish("woke", { outcome: "completed" });
		const quiet = await first.conversation.work.finish("quiet", { outcome: "completed" });
		// No model yet: nothing can start a turn.
		await first.conversation.waitForIdle();
		const entries = await readLog(first.log);
		await first.conversation.close();

		const second = await openConversation({ log: await copyLog(entries), faux, queueModes: { steer: "all" } });
		expect(second.conversation.queue.steer).toHaveLength(2);
		expect(second.conversation.queueWakes).toBe(true);
		const requests: string[][] = [];
		faux.setResponses([
			(context: Context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage("caught up");
			},
		]);
		await second.conversation.continue();
		await second.conversation.waitForIdle();
		expect(requests).toEqual([["npm test (job woke) completed.", "npm test (job quiet) completed."]]);
		for (const notice of [woke.notice, quiet.notice]) {
			expect(second.conversation.state.clientInputs.inputs.get(notice?.clientMessageId ?? "")?.state).toBe(
				"completed",
			);
		}
	});

	it("withdraws a queued notice once", async () => {
		const { conversation, log, faux } = await reconciled();
		faux.setResponses([fauxAssistantMessage("first")]);
		await conversation.work.start({ ...JOB, workId: "quiet", delivery: "message" });
		const { notice } = await conversation.work.finish("quiet", { outcome: "completed" });
		const clientMessageId = notice?.clientMessageId ?? "";

		expect(await conversation.work.withdrawHostInput(clientMessageId)).toBe(true);
		expect(conversation.queue.steer).toHaveLength(0);
		expect(conversation.state.clientInputs.inputs.get(clientMessageId)?.state).toBe("withdrawn");
		expect(await conversation.work.withdrawHostInput(clientMessageId)).toBe(false);

		const prompt = await conversation.prompt({ message: "hello" });
		await prompt.completion;
		await expect(conversation.work.withdrawHostInput(prompt.clientMessageId)).rejects.toMatchObject({
			code: "invalid_argument",
		});
		expect(conversation.state).toEqual(fold(await readLog(log)));
	});
});
