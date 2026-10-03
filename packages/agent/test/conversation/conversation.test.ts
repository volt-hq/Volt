import { type Context, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@hansjm10/volt-ai";
import { defineLogEntryType } from "@hansjm10/volt-protocol/entries";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { ConversationAgentEvent, ConversationEvent } from "../../src/conversation/api.ts";
import { Conversation } from "../../src/conversation/conversation.ts";
import { fold } from "../../src/conversation/fold.ts";
import { InMemoryConversationLog } from "../../src/conversation/in-memory-log.ts";
import type { AgentTool } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";
import {
	deferred,
	lastAssistant,
	openConversation,
	promptAndSettle,
	readLog,
	registerFauxProvider,
	textOf,
	userTexts,
} from "./conversation-test-utils.ts";

function committedEntries(events: readonly ConversationEvent[]) {
	return events.flatMap((event) => (event.type === "committed" ? event.entries : []));
}

describe("Conversation turns", () => {
	it("commits a prompt as durable input, delivers it, and keeps the fold equal to the log", async () => {
		const { conversation, log, faux, events } = await openConversation();
		faux.setResponses([fauxAssistantMessage("hello back")]);

		const admission = await conversation.prompt({ clientMessageId: "client-1", message: "hello" });
		expect(admission.clientMessageId).toBe("client-1");
		expect(admission.ordinals).toEqual([2]);
		const outcome = await admission.completion;
		await conversation.waitForIdle();

		const entries = await readLog(log);
		expect(entries.map((entry) => entry.type)).toEqual([
			"model_change",
			"client_input_receipt",
			"client_input_state",
			"message",
			"message",
		]);
		expect(entries[3]).toMatchObject({ clientMessageId: "client-1", payload: { message: { role: "user" } } });
		expect(outcome).toEqual({ state: "completed", entryId: entries[3]?.id, ordinal: 4 });
		expect(conversation.state).toEqual(fold(entries));
		expect(committedEntries(events)).toEqual(entries);
		expect(conversation.state.clientInputs.inputs.get("client-1")?.state).toBe("completed");
		expect(textOf(lastAssistant(conversation)!)).toBe("hello back");
		expect(conversation.phase).toMatchObject({ operation: null, busy: false });
	});

	it("keys agent events to the ordinal they build on", async () => {
		const { conversation, faux, events } = await openConversation();
		faux.setResponses([fauxAssistantMessage("answer")]);
		await promptAndSettle(conversation, "question");

		const agentEvents = events.filter((event): event is ConversationAgentEvent => "basedOn" in event);
		const assistantStart = agentEvents.find(
			(event) => event.type === "message_start" && event.message.role === "assistant",
		);
		const assistantEnd = agentEvents.find(
			(event) => event.type === "message_end" && event.message.role === "assistant",
		);
		expect(assistantStart?.basedOn).toBe(4);
		expect(assistantEnd?.basedOn).toBe(5);
		const committedIndex = events.findIndex((event) => event.type === "committed" && event.ordinal === 5);
		expect(committedIndex).toBeLessThan(events.indexOf(assistantEnd!));
	});

	it("drains queued steering one message at a time at each boundary", async () => {
		const { conversation, faux, events } = await openConversation();
		const userCounts: number[] = [];
		const respond = (text: string) => (context: Context) => {
			userCounts.push(context.messages.filter((message) => message.role === "user").length);
			return fauxAssistantMessage(text);
		};
		faux.setResponses([respond("first"), respond("second"), respond("third")]);
		let queued = false;
		conversation.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				void conversation.steer({ message: "one" });
				void conversation.steer({ message: "two" });
			}
		});

		await promptAndSettle(conversation, "hello");

		expect(userCounts).toEqual([1, 2, 3]);
		const steerLengths = events.flatMap((event) =>
			event.type === "queue_changed" ? [event.queue.steer.length] : [],
		);
		expect(steerLengths.filter((length, index) => length !== steerLengths[index - 1])).toEqual([0, 1, 2, 1, 0]);
	});

	it("drains follow-ups only after the turn would otherwise stop", async () => {
		const { conversation, faux } = await openConversation({ queueModes: { followUp: "all" } });
		const requests: string[][] = [];
		faux.setResponses([
			(context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage("tool done");
			},
			(context) => {
				requests.push(userTexts(context.messages));
				return fauxAssistantMessage("follow-ups done");
			},
		]);
		conversation.setTools([calculateTool]);
		let queued = false;
		conversation.subscribe((event) => {
			if (event.type === "tool_execution_start" && !queued) {
				queued = true;
				void conversation.followUp({ message: "later one" });
				void conversation.followUp({ message: "later two" });
			}
		});

		await promptAndSettle(conversation, "start");

		expect(requests).toEqual([["start"], ["start"], ["start", "later one", "later two"]]);
	});

	it("finalizes a tool-requested final response before leasing queued steering", async () => {
		const { conversation, faux } = await openConversation({
			policy: { afterToolCall: async () => ({ disposition: "final_response" }) },
		});
		const snapshots: Array<{ users: string[]; tools: string[] }> = [];
		const capture =
			(text: string, toolUse = false) =>
			(context: Context) => {
				snapshots.push({
					users: userTexts(context.messages),
					tools: context.tools?.map((tool) => tool.name) ?? [],
				});
				return toolUse
					? fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
							stopReason: "toolUse",
						})
					: fauxAssistantMessage(text);
			};
		faux.setResponses([capture("", true), capture("finalized"), capture("handled steering")]);
		conversation.setTools([calculateTool]);
		let queued = false;
		conversation.subscribe((event) => {
			if (event.type === "message_start" && event.message.role === "assistant" && !queued) {
				queued = true;
				void conversation.steer({ message: "queued steering" });
			}
		});

		await promptAndSettle(conversation, "complete and summarize");

		expect(textOf(lastAssistant(conversation)!)).toBe("handled steering");
		expect(snapshots).toEqual([
			{ users: ["complete and summarize"], tools: ["calculate"] },
			{ users: ["complete and summarize"], tools: [] },
			{ users: ["complete and summarize", "queued steering"], tools: ["calculate"] },
		]);
	});

	it("reads model, thinking level, fast mode, system prompt, and tools for every request", async () => {
		const faux = registerFauxProvider({
			models: [
				{ id: "first", reasoning: true },
				{ id: "second", reasoning: true },
			],
		});
		let systemPrompt = "first prompt";
		const { conversation } = await openConversation({ faux, systemPrompt: () => systemPrompt });
		const captured: unknown[] = [];
		faux.setResponses([
			(context, options, _state, model) => {
				captured.push({
					model: model.id,
					reasoning: (options as SimpleStreamOptions | undefined)?.reasoning,
					speed: (options as SimpleStreamOptions | undefined)?.inferenceSpeed,
					systemPrompt: context.systemPrompt,
					tools: context.tools?.map((tool) => tool.name),
				});
				return fauxAssistantMessage(fauxToolCall("calculate", { expression: "1 + 1" }, { id: "call-1" }), {
					stopReason: "toolUse",
				});
			},
			(context, options, _state, model) => {
				captured.push({
					model: model.id,
					reasoning: (options as SimpleStreamOptions | undefined)?.reasoning,
					speed: (options as SimpleStreamOptions | undefined)?.inferenceSpeed,
					systemPrompt: context.systemPrompt,
					tools: context.tools?.map((tool) => tool.name),
				});
				return fauxAssistantMessage("done");
			},
		]);
		conversation.setTools([calculateTool]);
		const timeTool: AgentTool = { ...calculateTool, name: "time" };
		conversation.subscribe((event) => {
			if (event.type !== "tool_execution_start") return;
			systemPrompt = "second prompt";
			conversation.setTools([calculateTool, timeTool]);
			void conversation.setModel(faux.getModel("second")!);
			void conversation.setThinkingLevel("high");
			void conversation.setFastMode(true);
		});

		await promptAndSettle(conversation, "hello");

		expect(captured).toEqual([
			{
				model: "first",
				reasoning: undefined,
				speed: "standard",
				systemPrompt: "first prompt",
				tools: ["calculate"],
			},
			{
				model: "second",
				reasoning: "high",
				speed: "fast",
				systemPrompt: "second prompt",
				tools: ["calculate", "time"],
			},
		]);
	});

	it("settles a throwing hook with a committed error message and stays usable", async () => {
		let fail = true;
		const { conversation, log, faux } = await openConversation({
			policy: {
				transformContext: (messages) => {
					if (fail) throw new Error("context exploded");
					return messages;
				},
			},
		});
		faux.setResponses([fauxAssistantMessage("recovered")]);

		await promptAndSettle(conversation, "hello");
		expect(lastAssistant(conversation)).toMatchObject({
			stopReason: "error",
			error: { kind: "unknown", message: "context exploded" },
		});
		fail = false;
		await promptAndSettle(conversation, "again");

		expect(textOf(lastAssistant(conversation)!)).toBe("recovered");
		expect(conversation.state).toEqual(fold(await readLog(log)));
	});

	it("fails the turn when a tool result cannot be committed", async () => {
		const { conversation, faux, log } = await openConversation();
		const tool: AgentTool = {
			...calculateTool,
			name: "uncloneable",
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { callback: () => "x" } }),
		};
		conversation.setTools([tool]);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("uncloneable", { expression: "1" }, { id: "call-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("must not run"),
		]);

		await promptAndSettle(conversation, "run it");

		expect(faux.state.callCount).toBe(1);
		expect(lastAssistant(conversation)).toMatchObject({ stopReason: "error" });
		expect(
			(await readLog(log)).some(
				(entry) =>
					entry.type === "message" &&
					"message" in (entry.payload as object) &&
					(entry.payload as { message: { role: string } }).message.role === "toolResult",
			),
		).toBe(false);
	});

	it("runs tool hooks and commits the patched result", async () => {
		const seen: string[] = [];
		const { conversation, faux } = await openConversation({
			policy: {
				beforeToolCall: async ({ toolCall }) => {
					seen.push(toolCall.id);
					return undefined;
				},
				afterToolCall: async () => ({ content: [{ type: "text", text: "patched" }], disposition: "stop" }),
			},
		});
		conversation.setTools([calculateTool]);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 2" }, { id: "call-1" }), {
				stopReason: "toolUse",
			}),
		]);

		await promptAndSettle(conversation, "calculate");

		expect(seen).toEqual(["call-1"]);
		expect(conversation.state.context.messages.at(-1)).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "patched" }],
		});
		expect(faux.state.callCount).toBe(1);
	});
});

describe("Conversation client input", () => {
	it("answers a resubmitted input idempotently and rejects a conflicting one", async () => {
		const { conversation, faux, log } = await openConversation();
		faux.setResponses([fauxAssistantMessage("once")]);
		const first = await conversation.prompt({ clientMessageId: "same", message: "hello" });
		const outcome = await first.completion;
		await conversation.waitForIdle();

		const again = await conversation.prompt({ clientMessageId: "same", message: "hello" });
		expect(again.ordinals).toEqual([]);
		await expect(again.completion).resolves.toEqual(outcome);
		await expect(conversation.prompt({ clientMessageId: "same", message: "different" })).rejects.toMatchObject({
			code: "client_input_conflict",
		});
		await expect(conversation.steer({ clientMessageId: "same", message: "hello" })).rejects.toMatchObject({
			code: "client_input_conflict",
		});
		expect(faux.state.callCount).toBe(1);
		expect((await readLog(log)).filter((entry) => entry.type === "client_input_receipt")).toHaveLength(1);
	});

	it("rejects a prompt while busy unless it names a streaming behavior", async () => {
		const { conversation, faux } = await openConversation();
		const entered = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("second"),
		]);
		const running = await conversation.prompt({ message: "first" });
		await entered.promise;

		await expect(conversation.prompt({ message: "rejected" })).rejects.toMatchObject({ code: "busy" });
		const queued = await conversation.prompt({ message: "queued", streamingBehavior: "followUp" });
		expect(queued.ordinals).toHaveLength(2);
		release.resolve();
		await Promise.all([running.completion, queued.completion]);
		await conversation.waitForIdle();

		expect(userTexts(conversation.state.context.messages)).toEqual(["first", "queued"]);
		expect(conversation.state.clientInputs.inputs.get(queued.clientMessageId)).toMatchObject({
			state: "completed",
			queuedInput: { delivery: "follow_up", message: "queued" },
		});
	});

	it("delivers the prepared text, images, and attachments in one batch", async () => {
		const { conversation, faux, log } = await openConversation();
		let providerMessages: unknown[] = [];
		faux.setResponses([
			(context) => {
				providerMessages = context.messages;
				return fauxAssistantMessage("done");
			},
		]);
		const image = { type: "image" as const, mimeType: "image/png", data: "aW1n" };

		const admission = await conversation.prompt({
			message: "/template",
			images: [image],
			prepared: { message: "expanded template", images: [image] },
			attachments: [{ role: "custom", customType: "note", content: "attached", display: false, timestamp: 1 }],
		});
		await admission.completion;
		await conversation.waitForIdle();

		const entries = await readLog(log);
		const receipt = entries.find((entry) => entry.type === "client_input_receipt");
		expect(receipt?.payload).toMatchObject({ input: { message: "/template", images: [image] } });
		const delivered = entries.filter((entry) => entry.ordinal >= 3 && entry.ordinal <= 5);
		expect(delivered.map((entry) => entry.type)).toEqual(["client_input_state", "message", "custom_message"]);
		const committed = new Set(delivered.map((entry) => entry.ordinal));
		expect(committed.size).toBe(3);
		expect(providerMessages).toMatchObject([
			{ role: "user", content: [{ type: "text", text: "expanded template" }, image] },
			{ role: "user", content: [{ type: "text", text: "attached" }] },
		]);
		expect(JSON.stringify(providerMessages)).not.toContain("clientMessageId");
	});

	it("withdraws queued input on clear and leaves it in the log", async () => {
		const { conversation, faux, log } = await openConversation();
		const entered = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("late");
			},
		]);
		const running = await conversation.prompt({ message: "first" });
		await entered.promise;
		const steer = await conversation.steer({ message: "steer" });
		const followUp = await conversation.followUp({ message: "follow" });
		expect(conversation.abort("host_action")).toMatchObject({ accepted: true, source: "host_action" });
		release.resolve();
		await running.completion;
		await conversation.waitForIdle();

		expect(conversation.queue.steer.map(textOf)).toEqual(["steer"]);
		const cleared = await conversation.clearQueue();
		expect(cleared.steer.map(textOf)).toEqual(["steer"]);
		expect(cleared.followUp.map(textOf)).toEqual(["follow"]);
		await expect(steer.completion).resolves.toEqual({ state: "withdrawn" });
		await expect(followUp.completion).resolves.toEqual({ state: "withdrawn" });
		expect(conversation.queue).toEqual({ prompt: [], steer: [], followUp: [] });
		expect(conversation.state.clientInputs.queued).toEqual([]);
		expect(conversation.state).toEqual(fold(await readLog(log)));
		expect(faux.state.callCount).toBe(1);
	});

	it("replays queued input a previous runtime left behind", async () => {
		const log = new InMemoryConversationLog("recovered");
		const faux = registerFauxProvider();
		const first = await openConversation({ log, faux });
		const entered = deferred();
		faux.setResponses([
			async (_context, options) => {
				entered.resolve();
				await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve()));
				return fauxAssistantMessage("interrupted");
			},
		]);
		await first.conversation.prompt({ message: "first" });
		await entered.promise;
		await first.conversation.followUp({ clientMessageId: "queued-1", message: "do this next" });
		first.conversation.abort();
		await first.conversation.waitForIdle();
		const entries = await readLog(log);
		await first.conversation.close();

		const reopenedLog = new InMemoryConversationLog("recovered");
		for (const entry of entries) {
			const { ordinal: _ordinal, ...draft } = entry;
			await reopenedLog.append({ expectedOrdinal: reopenedLog.head(), commitId: entry.id, entries: [draft] });
		}
		const second = await openConversation({ log: reopenedLog, faux });
		expect(second.conversation.queue.followUp.map(textOf)).toEqual(["do this next"]);
		let requested: string[] = [];
		faux.setResponses([
			(context) => {
				requested = userTexts(context.messages);
				return fauxAssistantMessage("resumed");
			},
		]);
		await second.conversation.continue();

		expect(requested).toEqual(["first", "do this next"]);
		expect(second.conversation.state.clientInputs.inputs.get("queued-1")?.state).toBe("completed");
		const resubmitted = await second.conversation.followUp({ clientMessageId: "queued-1", message: "do this next" });
		await expect(resubmitted.completion).resolves.toMatchObject({ state: "completed" });
	});

	it("settles a pending input the host handled without delivering it", async () => {
		const { conversation, faux } = await openConversation();
		const entered = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("first");
			},
		]);
		await conversation.prompt({ message: "first" });
		await entered.promise;
		const handled = await conversation.followUp({ message: "/handled" });
		expect(conversation.queue.followUp.map(textOf)).toEqual(["/handled"]);

		await conversation.settleClientInput(handled.clientMessageId, { state: "completed" });
		await expect(handled.completion).resolves.toMatchObject({ state: "completed" });
		expect(conversation.queue.followUp).toEqual([]);
		release.resolve();
		await conversation.waitForIdle();

		expect(faux.state.callCount).toBe(1);
		expect(userTexts(conversation.state.context.messages)).toEqual(["first"]);
		await expect(
			conversation.settleClientInput(handled.clientMessageId, { state: "failed", error: "late" }),
		).rejects.toMatchObject({ code: "invalid_argument" });
	});

	it("delivers queued host messages as one committed batch", async () => {
		const { conversation, faux, events } = await openConversation();
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("noticed")]);
		await promptAndSettle(conversation, "first");

		conversation.queueMessages("followUp", [
			{ role: "custom", customType: "notice", content: "job finished", display: true, timestamp: 1 },
			{ role: "user", content: "host note", timestamp: 2 },
		]);
		await conversation.waitForIdle();

		const batches = events.flatMap((event) =>
			event.type === "committed" ? [event.entries.map((entry) => entry.type)] : [],
		);
		expect(batches).toContainEqual(["custom_message", "message"]);
		expect(conversation.state.context.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"custom",
			"user",
			"assistant",
		]);
		expect(faux.state.callCount).toBe(2);
	});

	it("records host-settled input and unblocks recovery past a started input", async () => {
		const { conversation, log } = await openConversation();
		const admission = await conversation.prompt({ clientMessageId: "handled", message: "/command" });
		await conversation.waitForIdle();
		await expect(admission.completion).resolves.toMatchObject({ state: "completed" });

		const blocked = new InMemoryConversationLog("blocked");
		const entries = await readLog(log);
		for (const entry of entries.slice(0, 3)) {
			const { ordinal: _ordinal, ...draft } = entry;
			await blocked.append({ expectedOrdinal: blocked.head(), commitId: entry.id, entries: [draft] });
		}
		const reopened = await openConversation({ log: blocked });
		expect(reopened.conversation.state.clientInputs.started).toEqual(["handled"]);
		await reopened.conversation.settleClientInput("handled", {
			state: "failed",
			error: "lost by the previous runtime",
		});
		expect(reopened.conversation.state.clientInputs.inputs.get("handled")).toMatchObject({
			state: "failed",
			error: "lost by the previous runtime",
		});
	});
});

describe("Conversation durable settings and host entries", () => {
	it("commits settings, labels, names, planning, and registered product entries", async () => {
		const reviewType = defineLogEntryType("review_state", "host", Type.Object({ open: Type.Boolean() }));
		const { conversation, log, faux } = await openConversation({ entryTypes: [reviewType] });
		faux.setResponses([fauxAssistantMessage("answer")]);
		await promptAndSettle(conversation, "question");
		const assistantId = conversation.state.leafId!;

		await conversation.setThinkingLevel("medium");
		await conversation.setFastMode(true);
		await conversation.setPlanning({ mode: "plan", plan: null });
		await conversation.setName("  Named  ");
		await conversation.setLabel(assistantId, "checkpoint");
		const appended = await conversation.append([
			{ type: "review_state", payload: { open: true } },
			{ type: "custom", payload: { customType: "ext", data: { n: 1 } } },
		]);

		expect(appended.map((entry) => [entry.type, entry.visibility])).toEqual([
			["review_state", "host"],
			["custom", "public"],
		]);
		const state = conversation.state;
		expect(state.context).toMatchObject({ thinkingLevel: "medium", fastMode: true });
		expect(state.planning).toEqual({ mode: "plan", plan: null });
		expect(state.name).toBe("Named");
		expect(state.labels.get(assistantId)?.label).toBe("checkpoint");
		expect(state).toEqual(fold(await readLog(log)));
		await expect(conversation.append([{ type: "leaf", payload: { targetId: null } }])).rejects.toMatchObject({
			code: "invalid_argument",
		});
		await expect(conversation.append([{ type: "unregistered", payload: {} }])).rejects.toMatchObject({
			code: "invalid_argument",
		});
		await expect(conversation.setLabel("missing", "x")).rejects.toMatchObject({ code: "invalid_argument" });
	});

	it("rejects a malformed host entry without appending it", async () => {
		const { conversation, log } = await openConversation();
		const before = await readLog(log);
		await expect(conversation.append([{ type: "message", payload: {} }])).rejects.toMatchObject({
			code: "invalid_argument",
		});
		expect(await readLog(log)).toEqual(before);
	});

	it("rejects a product type that reuses a core type", async () => {
		const log = new InMemoryConversationLog("collision");
		const faux = registerFauxProvider();
		await expect(
			Conversation.open({
				log,
				stream: () => {
					throw new Error("unused");
				},
				resolveModel: () => faux.getModel(),
				entryTypes: [defineLogEntryType("custom", "public", Type.Object({}))],
			}),
		).rejects.toMatchObject({ code: "invalid_argument" });
	});
});
