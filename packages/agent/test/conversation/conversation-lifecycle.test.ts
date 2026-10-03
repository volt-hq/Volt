import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { AdmissionGate } from "../../src/conversation/admission-gate.ts";
import type { ConversationEvent, ConversationSummarizer } from "../../src/conversation/api.ts";
import { fold } from "../../src/conversation/fold.ts";
import type { AgentTool } from "../../src/types.ts";
import {
	deferred,
	lastAssistant,
	observe,
	openConversation,
	promptAndSettle,
	readLog,
	textOf,
	userTexts,
} from "./conversation-test-utils.ts";

const suspended = { code: "busy", message: "Operation admission is suspended" };

function runtimeAbortSources(conversation: { state: { context: { messages: readonly unknown[] } } }): unknown[] {
	return conversation.state.context.messages.flatMap((message) => {
		const diagnostics = (message as { diagnostics?: { type: string; details?: { source?: unknown } }[] }).diagnostics;
		return (diagnostics ?? []).flatMap((diagnostic) =>
			diagnostic.type === "runtime_abort" ? [diagnostic.details?.source] : [],
		);
	});
}

const summarizer: ConversationSummarizer = {
	compact: async ({ state }) => ({
		summary: "compacted",
		firstKeptEntryId: state.branch.at(-1) ?? "",
		tokensBefore: 10,
	}),
	summarizeBranch: async () => ({ summary: "branch summary" }),
};

describe("Conversation admission", () => {
	it("rejects suspended operations before any write or hook and recovers after release", async () => {
		const admissionGate = new AdmissionGate();
		const systemPrompt = vi.fn(() => "prompt");
		const strategy = vi.fn(() => "host result");
		const { conversation, log, faux } = await openConversation({ admissionGate, systemPrompt, summarizer });
		const before = await readLog(log);
		const release = admissionGate.suspend();

		await expect(conversation.prompt({ message: "blocked" })).rejects.toMatchObject(suspended);
		await expect(conversation.continue()).rejects.toMatchObject(suspended);
		await expect(conversation.compact()).rejects.toMatchObject(suspended);
		await expect(conversation.navigate(null)).rejects.toMatchObject(suspended);
		await expect(conversation.runHostOperation(strategy)).rejects.toMatchObject(suspended);
		expect(() => conversation.beginActivity("bash")).toThrow("Operation admission is suspended");
		expect(await readLog(log)).toEqual(before);
		expect(systemPrompt).not.toHaveBeenCalled();
		expect(strategy).not.toHaveBeenCalled();
		expect(conversation.busy).toBe(false);

		release();
		faux.setResponses([fauxAssistantMessage("accepted")]);
		await promptAndSettle(conversation, "accepted");
		await expect(conversation.runHostOperation(strategy)).resolves.toBe("host result");
		expect(faux.state.callCount).toBe(1);
	});

	it("keeps queue and settings intents usable while suspended without starting a turn", async () => {
		const admissionGate = new AdmissionGate();
		const { conversation, faux } = await openConversation({ admissionGate });
		faux.setResponses([fauxAssistantMessage("first answer")]);
		await promptAndSettle(conversation, "first");
		const release = admissionGate.suspend();

		const steer = await conversation.steer({ message: "queued steer" });
		await conversation.followUp({ message: "queued follow-up" });
		await conversation.setThinkingLevel("high");
		await conversation.append([{ type: "custom", payload: { customType: "host" } }]);
		await conversation.waitForIdle();
		expect(conversation.phase.operation).toBeNull();
		expect(conversation.queue.steer.map(textOf)).toEqual(["queued steer"]);

		const requests: string[][] = [];
		faux.setResponses([
			(context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage("steered");
			},
			(context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage("followed");
			},
		]);
		release();
		await conversation.continue();

		expect(requests).toEqual([
			["first", "queued steer"],
			["first", "queued steer", "queued follow-up"],
		]);
		await expect(steer.completion).resolves.toMatchObject({ state: "completed" });
		expect(conversation.state.context.thinkingLevel).toBe("high");
	});

	it("lets a running request finish while admission is suspended", async () => {
		const admissionGate = new AdmissionGate();
		const { conversation, faux } = await openConversation({ admissionGate });
		const entered = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("existing response");
			},
		]);
		await conversation.prompt({ message: "running" });
		await entered.promise;
		const releaseGate = admissionGate.suspend();
		release.resolve();
		await conversation.waitForIdle();

		expect(lastAssistant(conversation)).toMatchObject({ stopReason: "stop" });
		await expect(conversation.prompt({ message: "late" })).rejects.toMatchObject(suspended);
		releaseGate();
	});
});

describe("Conversation abort", () => {
	it("accepts abort synchronously, keeps the first source, and records it on the committed message", async () => {
		const { conversation, faux } = await openConversation();
		const entered = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("late response");
			},
		]);
		await conversation.prompt({ message: "abort me" });
		await entered.promise;
		const before = conversation.operation;
		expect(before).toMatchObject({ kind: "turn", stage: "executing", requestAccepted: true });
		expect(before?.signal.aborted).toBe(false);
		expect(Object.isFrozen(before)).toBe(true);

		const first = conversation.abort("host_action");
		expect(conversation.operation).toMatchObject({ id: first.runId, abortSource: "host_action" });
		expect(before?.signal.aborted).toBe(true);
		const second = conversation.abort("disposal");
		expect(first).toMatchObject({ accepted: true, source: "host_action" });
		expect(second).toMatchObject({ accepted: false, source: "host_action", runId: first.runId });
		release.resolve();
		await conversation.waitForIdle();

		expect(runtimeAbortSources(conversation)).toEqual(["host_action"]);
		expect(conversation.operation).toBeUndefined();
		expect(conversation.abort("remote_request")).toEqual({ accepted: false, runId: undefined, source: undefined });
	});

	it("retains a prompt whose turn was aborted before delivery and resumes it explicitly", async () => {
		const { conversation, faux, events } = await openConversation();
		faux.setResponses([fauxAssistantMessage("resumed")]);
		let aborted = false;
		conversation.subscribe((event) => {
			if (event.type === "agent_start" && !aborted) {
				aborted = true;
				conversation.abort();
			}
		});

		const admission = await conversation.prompt({ message: "preserve me" });
		await conversation.waitForIdle();
		expect(faux.state.callCount).toBe(0);
		expect(conversation.queue.prompt.map(textOf)).toEqual(["preserve me"]);
		expect(events.filter((event) => "basedOn" in event).map((event) => event.type)).toEqual([
			"agent_start",
			"agent_end",
		]);

		await conversation.continue();
		await expect(admission.completion).resolves.toMatchObject({ state: "completed" });
		expect(userTexts(conversation.state.context.messages)).toEqual(["preserve me"]);
		expect(conversation.queue.prompt).toEqual([]);
	});

	it("does not request again after a tool aborts between requests", async () => {
		const { conversation, faux } = await openConversation();
		const tool: AgentTool = {
			name: "stop_tool",
			label: "Stop",
			description: "Queues work and aborts",
			parameters: Type.Object({}),
			execute: async () => {
				await conversation.steer({ message: "queued steering" });
				conversation.abort("host_action");
				return { content: [{ type: "text", text: "stopped" }] };
			},
		};
		conversation.setTools([tool]);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("stop_tool", {}, { id: "call-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("resumed"),
		]);

		await promptAndSettle(conversation, "run tool");
		expect(faux.state.callCount).toBe(1);
		expect(conversation.queue.steer.map(textOf)).toEqual(["queued steering"]);

		await conversation.continue();
		expect(faux.state.callCount).toBe(2);
		expect(conversation.queue.steer).toEqual([]);
	});

	it("keeps terminal listeners inside waitForIdle and rejects abort once the turn is sealed", async () => {
		const { conversation, faux } = await openConversation();
		faux.setResponses([fauxAssistantMessage("done")]);
		const entered = deferred();
		const release = deferred();
		let abortResult: unknown;
		conversation.subscribe(async (event) => {
			if (event.type !== "agent_end") return;
			abortResult = conversation.abort("remote_request");
			entered.resolve();
			await release.promise;
		});

		await conversation.prompt({ message: "settle listeners" });
		await entered.promise;
		expect(abortResult).toMatchObject({ accepted: false });
		await expect(conversation.prompt({ message: "overlap" })).rejects.toMatchObject({ code: "busy" });
		let idle = false;
		const waiting = conversation.waitForIdle().then(() => {
			idle = true;
		});
		await Promise.resolve();
		expect(idle).toBe(false);
		release.resolve();
		await waiting;
		expect(conversation.phase.operation).toBeNull();
	});
});

describe("Conversation operations", () => {
	it("publishes one phase_changed stream for operations and counted activities", async () => {
		const { conversation, faux, events } = await openConversation();
		faux.setResponses([fauxAssistantMessage("done")]);
		const releaseBash = conversation.beginActivity("bash");
		expect(conversation.phase).toMatchObject({ operation: null, busy: true, activities: { bash: 1 } });
		await promptAndSettle(conversation, "hello");
		let notBusy = false;
		const waiting = conversation.waitForNotBusy().then(() => {
			notBusy = true;
		});
		await Promise.resolve();
		expect(notBusy).toBe(false);
		releaseBash();
		releaseBash();
		await waiting;

		const phases = events.flatMap((event) => (event.type === "phase_changed" ? [event.phase] : []));
		expect(phases.map((phase) => [phase.operation, phase.activities.bash, phase.busy])).toEqual([
			[null, 1, true],
			["turn", 1, true],
			[null, 1, true],
			[null, 0, false],
		]);
	});

	it("preempts a turn that has not reached the provider with compaction", async () => {
		const entered = deferred();
		const release = deferred();
		let block = false;
		const { conversation, faux, log } = await openConversation({
			summarizer,
			systemPrompt: async () => {
				if (block) {
					block = false;
					entered.resolve();
					await release.promise;
				}
				return "system";
			},
		});
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await promptAndSettle(conversation, "seed");
		block = true;
		faux.setResponses([fauxAssistantMessage("must not run")]);
		await conversation.prompt({ message: "pending" });
		await entered.promise;

		const compaction = conversation.compact();
		expect(conversation.phase.operation).toBe("turn");
		release.resolve();
		await expect(compaction).resolves.toMatchObject({ status: "compacted" });
		await conversation.waitForIdle();

		const entries = await readLog(log);
		expect(entries.at(-1)?.type).toBe("compaction");
		expect(conversation.state).toEqual(fold(entries));
		expect(faux.state.callCount).toBe(1);
	});

	it("rejects navigation that would preempt an accepted request", async () => {
		const { conversation, faux } = await openConversation();
		const entered = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("answer");
			},
		]);
		await conversation.prompt({ message: "running" });
		await entered.promise;
		await expect(conversation.navigate(null)).rejects.toMatchObject({ code: "busy" });
		release.resolve();
		await conversation.waitForIdle();
	});

	it("moves the branch with its summary and label in one batch", async () => {
		const summarize = vi.fn(summarizer.summarizeBranch);
		const { conversation, faux, log, events } = await openConversation({
			summarizer: { ...summarizer, summarizeBranch: summarize },
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await promptAndSettle(conversation, "first");
		const target = conversation.state.leafId!;
		await promptAndSettle(conversation, "second");

		const result = await conversation.navigate(target, { summarize: true, label: "returned" });

		expect(result).toMatchObject({ status: "navigated" });
		expect(summarize.mock.calls[0]?.[0]).toMatchObject({ targetId: target, commonAncestorId: target });
		expect(summarize.mock.calls[0]?.[0].entries.map((entry) => entry.type)).toEqual(["message", "message"]);
		const batches = events.flatMap((event) =>
			event.type === "committed" ? [event.entries.map((entry) => entry.type)] : [],
		);
		expect(batches.at(-1)).toEqual(["leaf", "branch_summary", "label"]);
		expect(conversation.state.labels.get(result.summaryEntryId!)?.label).toBe("returned");
		expect(userTexts(conversation.state.context.messages)).toEqual(["first"]);
		expect(conversation.state).toEqual(fold(await readLog(log)));
	});

	it("runs host operations exclusively", async () => {
		const { conversation, faux } = await openConversation();
		faux.setResponses([fauxAssistantMessage("unused")]);
		const entered = deferred();
		const release = deferred();
		const running = conversation.runHostOperation(async (context) => {
			entered.resolve();
			await release.promise;
			return await context.append([{ type: "custom", payload: { customType: "host-op" } }]);
		});
		await entered.promise;
		expect(conversation.phase.operation).toBe("host");
		await expect(conversation.prompt({ message: "blocked" })).rejects.toMatchObject({ code: "busy" });
		await expect(conversation.compact()).rejects.toMatchObject({ code: "invalid_state" });
		release.resolve();
		await expect(running).resolves.toHaveLength(1);
	});
});

describe("Conversation lifecycle", () => {
	it("closes once, ends with the log, and rejects later intents", async () => {
		const { conversation, faux, events } = await openConversation();
		const entered = deferred();
		faux.setResponses([
			async (_context, options) => {
				entered.resolve();
				await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
				return fauxAssistantMessage("aborted");
			},
		]);
		await conversation.prompt({ message: "running" });
		await entered.promise;
		const queued = await conversation.followUp({ message: "never delivered" });

		await Promise.all([conversation.close(), conversation.close()]);

		await expect(conversation.ended).resolves.toMatchObject({ reason: "closed" });
		await expect(queued.completion).rejects.toMatchObject({ code: "ended" });
		await expect(conversation.prompt({ message: "late" })).rejects.toMatchObject({ code: "ended" });
		await expect(conversation.setName("late")).rejects.toMatchObject({ code: "ended" });
		expect(() => conversation.abort()).not.toThrow();
		expect(events.at(-1)).toMatchObject({ type: "ended", reason: "closed" });
	});

	it("ends when another writer takes the log, without committing further entries", async () => {
		const { conversation, log, faux } = await openConversation();
		const entered = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("never committed");
			},
		]);
		await conversation.prompt({ message: "running" });
		await entered.promise;
		const head = log.head();
		await expect(
			log.append({
				expectedOrdinal: head - 1,
				commitId: "intruder",
				entries: [
					{
						id: "intruder",
						parentId: null,
						type: "custom",
						timestamp: new Date().toISOString(),
						visibility: "public",
						payload: { customType: "x" },
					},
				],
			}),
		).rejects.toMatchObject({ reason: "fence_conflict" });
		const ended = await conversation.ended;
		release.resolve();
		await conversation.waitForIdle();

		expect(ended.reason).toBe("fence_conflict");
		expect(conversation.state.ordinal).toBe(head);
		const terminal: ConversationEvent[] = [];
		conversation.subscribe((event) => {
			terminal.push(event);
		});
		await expect(conversation.continue()).rejects.toMatchObject({ code: "ended" });
		expect(terminal).toEqual([]);
	});
});

describe("Conversation input observers", () => {
	it("isolates listener failures and mutations from the committed log", async () => {
		const { conversation, faux, log } = await openConversation();
		faux.setResponses([fauxAssistantMessage("provider")]);
		conversation.subscribe((event) => {
			if (event.type !== "message_end" || event.message.role !== "assistant") return;
			const content = event.message.content;
			if (content[0]?.type === "text") content[0].text = "mutated by listener";
			throw new Error("listener failure");
		});
		const results = await observe(promptAndSettle(conversation, "hello"));
		expect(results.status).toBe("fulfilled");
		expect(textOf(lastAssistant(conversation)!)).toBe("provider");
		expect(conversation.state).toEqual(fold(await readLog(log)));
	});
});
