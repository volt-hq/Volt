import { createHash } from "node:crypto";
import { type Context, fauxAssistantMessage } from "@hansjm10/volt-ai";
import { clientInputDigestMaterial } from "@hansjm10/volt-protocol/entries";
import { describe, expect, it } from "vitest";
import { AdmissionGate } from "../../src/conversation/admission-gate.ts";
import type {
	ConversationDelivery,
	ConversationEvent,
	ConversationMessageOrigin,
	ConversationNavigationPreparation,
	ConversationSummarizer,
} from "../../src/conversation/api.ts";
import { clientInputDigest } from "../../src/conversation/conversation.ts";
import { clientInputRecovery, fold } from "../../src/conversation/fold.ts";
import { InMemoryConversationLog } from "../../src/conversation/in-memory-log.ts";
import type { ConversationLog, ConversationLogEntry } from "../../src/conversation/log.ts";
import type { AgentMessage } from "../../src/types.ts";
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

function batches(events: readonly ConversationEvent[]): string[][] {
	return events.flatMap((event) => (event.type === "committed" ? [event.entries.map((entry) => entry.type)] : []));
}

function operations(events: readonly ConversationEvent[]): (string | null)[] {
	return events.flatMap((event) => (event.type === "phase_changed" ? [event.phase.operation] : []));
}

/** Request transcripts as `role:text`, the compaction summary shortened to `summary`. */
function transcript(context: Context): string[] {
	return context.messages.map((message) => {
		const text = textOf(message as AgentMessage);
		return `${message.role}:${text.startsWith("The conversation history before this point") ? "summary" : text}`;
	});
}

/** Keeps from the first message on the branch, optionally committing extra messages with the compaction. */
function summarizer(messages: readonly AgentMessage[] = []): ConversationSummarizer & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		compact: async ({ cause, state }) => {
			calls.push(cause);
			const firstKept = state.branch.find((id) => state.tree.byId.get(id)?.type === "message");
			return firstKept === undefined
				? undefined
				: {
						summary: `summary ${calls.length}`,
						firstKeptEntryId: firstKept,
						tokensBefore: 10,
						...(messages.length === 0 ? {} : { messages }),
					};
		},
		summarizeBranch: async () => ({ summary: "branch summary" }),
	};
}

async function copyLog(log: ConversationLog, conversationId: string): Promise<InMemoryConversationLog> {
	const copy = new InMemoryConversationLog(conversationId);
	for (const entry of await readLog(log)) {
		const { ordinal: _ordinal, ...draft } = entry;
		await copy.append({ expectedOrdinal: copy.head(), commitId: entry.id, entries: [draft] });
	}
	return copy;
}

const overflow = () =>
	fauxAssistantMessage("", {
		stopReason: "error",
		error: { kind: "context_overflow", retryable: false, message: "too long" },
	});

describe("Conversation turn reservations", () => {
	it("claims the idle conversation until a prompt consumes the reservation", async () => {
		const { conversation, faux, log, events } = await openConversation();
		faux.setResponses([fauxAssistantMessage("answer")]);
		const reservation = conversation.reserve();
		const before = await readLog(log);

		expect(conversation.phase).toMatchObject({ operation: "turn", busy: true });
		await expect(conversation.prompt({ message: "concurrent" })).rejects.toMatchObject({ code: "busy" });
		await expect(conversation.continue()).rejects.toMatchObject({ code: "busy" });
		await expect(conversation.runHostOperation(() => "host")).rejects.toMatchObject({ code: "busy" });
		expect(() => conversation.reserve()).toThrow("The conversation is busy");
		expect(await readLog(log)).toEqual(before);

		const admission = await conversation.prompt({ message: "reserved" }, { reservation });
		await expect(admission.completion).resolves.toMatchObject({ state: "completed" });
		await conversation.waitForIdle();

		expect(userTexts(conversation.state.context.messages)).toEqual(["reserved"]);
		expect(operations(events)).toEqual(["turn", null]);
		await expect(conversation.prompt({ message: "again" }, { reservation })).rejects.toMatchObject({
			code: "invalid_state",
		});
		expect(reservation.cancel()).toBe(false);
		expect(conversation.state).toEqual(fold(await readLog(log)));
	});

	it("cancels a reservation and delivers input queued behind it", async () => {
		const { conversation, faux } = await openConversation();
		faux.setResponses([fauxAssistantMessage("steered")]);
		const reservation = conversation.reserve();
		const steer = await conversation.steer({ message: "queued behind" });
		expect(faux.state.callCount).toBe(0);

		expect(reservation.cancel()).toBe(true);
		await expect(steer.completion).resolves.toMatchObject({ state: "completed" });
		await conversation.waitForIdle();

		expect(userTexts(conversation.state.context.messages)).toEqual(["queued behind"]);
		expect(reservation.cancel()).toBe(false);
		expect(reservation.signal.aborted).toBe(false);
	});

	it("is revoked by abort, a preempting compaction, and close", async () => {
		const { conversation, faux, log } = await openConversation({ summarizer: summarizer() });
		let reservation = conversation.reserve();
		expect(conversation.abort("host_action")).toMatchObject({ accepted: true, runId: reservation.id });
		expect(reservation.signal.aborted).toBe(true);
		expect(conversation.phase.operation).toBeNull();
		await expect(conversation.prompt({ message: "late" }, { reservation })).rejects.toMatchObject({
			code: "invalid_state",
		});

		faux.setResponses([fauxAssistantMessage("seeded")]);
		await promptAndSettle(conversation, "seed");
		reservation = conversation.reserve();
		await expect(conversation.compact()).resolves.toMatchObject({ status: "compacted" });
		expect(reservation.signal.aborted).toBe(true);
		expect(reservation.cancel()).toBe(false);
		expect((await readLog(log)).at(-1)?.type).toBe("compaction");

		const held = conversation.reserve();
		await conversation.close();
		expect(held.signal.aborted).toBe(true);
		await expect(conversation.ended).resolves.toMatchObject({ reason: "closed" });
	});

	it("rejects a reservation whose admission was suspended without writing", async () => {
		const admissionGate = new AdmissionGate();
		const { conversation, log } = await openConversation({ admissionGate });
		const reservation = conversation.reserve();
		const before = await readLog(log);
		admissionGate.suspend()();

		await expect(conversation.prompt({ message: "stale" }, { reservation })).rejects.toMatchObject({
			code: "busy",
		});
		expect(conversation.phase.operation).toBeNull();
		expect(await readLog(log)).toEqual(before);
	});
});

describe("Conversation compaction at a turn's first decision", () => {
	it("compacts an overflowed tail and retries it before delivering the new prompt", async () => {
		const faux = registerFauxProvider({ models: [{ id: "small", contextWindow: 1000 }] });
		let enabled = false;
		const checks: [string, boolean][] = [];
		const compacting = summarizer();
		const { conversation, events } = await openConversation({
			faux,
			summarizer: compacting,
			policy: {
				compaction: (_usage, cause, check) => {
					checks.push([cause, check.continuing]);
					return enabled && cause === "overflow" ? {} : undefined;
				},
			},
		});
		const requests: string[][] = [];
		faux.setResponses([
			overflow,
			(context) => {
				requests.push(transcript(context));
				return fauxAssistantMessage("recovered");
			},
			(context) => {
				requests.push(transcript(context));
				return fauxAssistantMessage("answered");
			},
		]);
		await promptAndSettle(conversation, "first");
		enabled = true;
		const phasesBefore = operations(events).length;

		const admission = await conversation.prompt({ message: "next" });
		await expect(admission.completion).resolves.toMatchObject({ state: "completed" });
		await conversation.waitForIdle();

		expect(checks).toEqual([
			["overflow", false],
			["overflow", true],
			["threshold", true],
			["threshold", false],
		]);
		expect(compacting.calls).toEqual(["overflow"]);
		expect(requests).toEqual([
			["user:summary", "user:first"],
			["user:summary", "user:first", "assistant:recovered", "user:next"],
		]);
		expect(operations(events).slice(phasesBefore)).toEqual(["turn", null]);
		expect(textOf(lastAssistant(conversation)!)).toBe("answered");
	});

	it("continues the prompt after a threshold compaction, and without one when nothing compacts", async () => {
		let compactNext = false;
		let skip = false;
		const compacting = summarizer();
		const { conversation, faux, events } = await openConversation({
			summarizer: { ...compacting, compact: async (request) => (skip ? undefined : compacting.compact(request)) },
			policy: {
				compaction: (_usage, cause, check) => {
					if (cause !== "threshold" || !compactNext || check.state.context.messages.at(-1) !== check.message) {
						return undefined;
					}
					compactNext = false;
					return {};
				},
			},
		});
		const requests: string[][] = [];
		const record = (text: string) => (context: Context) => {
			requests.push(transcript(context));
			return fauxAssistantMessage(text);
		};
		faux.setResponses([record("one"), record("two"), record("three")]);
		await promptAndSettle(conversation, "first");

		compactNext = true;
		await promptAndSettle(conversation, "second");
		expect(batches(events).slice(-4)).toEqual([
			["client_input_receipt"],
			["compaction"],
			["client_input_state", "message"],
			["message"],
		]);
		expect(requests[1]).toEqual(["user:summary", "user:first", "assistant:one", "user:second"]);

		compactNext = true;
		skip = true;
		await promptAndSettle(conversation, "third");
		expect(requests[2]?.at(-1)).toBe("user:third");
		expect(compacting.calls).toEqual(["threshold"]);
		expect(events.filter((event) => event.type === "compaction_end").map((event) => event.status)).toEqual([
			"compacted",
			"skipped",
		]);
	});

	it("retries a tool-free length stop without it after a threshold compaction and its messages", async () => {
		const checkpoint: AgentMessage = {
			role: "custom",
			customType: "checkpoint",
			content: "plan checkpoint",
			display: false,
			timestamp: 1,
		};
		const { conversation, faux, events } = await openConversation({
			summarizer: summarizer([checkpoint]),
			policy: {
				compaction: (_usage, cause, check) =>
					cause === "threshold" && check.message.stopReason === "length" ? { resume: "retry" } : undefined,
			},
		});
		let retried: string[] = [];
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "length" }),
			(context) => {
				retried = transcript(context);
				return fauxAssistantMessage("continued");
			},
		]);

		await promptAndSettle(conversation, "work");

		expect(batches(events)).toContainEqual(["compaction", "custom_message"]);
		expect(retried).toEqual(["user:summary", "user:work", "user:plan checkpoint"]);
		expect(conversation.state.context.messages.map((message) => message.role)).toEqual([
			"compactionSummary",
			"user",
			"assistant",
			"custom",
			"assistant",
		]);
		expect(textOf(lastAssistant(conversation)!)).toBe("continued");
		expect(faux.state.callCount).toBe(2);
	});
});

describe("Conversation delivery preparation", () => {
	it("commits prepared entries and messages with the delivery in one batch", async () => {
		const seen: ConversationDelivery[] = [];
		const checkpoint: AgentMessage = {
			role: "custom",
			customType: "checkpoint",
			content: "plan now draft",
			display: false,
			timestamp: 1,
		};
		const { conversation, faux, log, events } = await openConversation({
			policy: {
				prepareDelivery: (delivery) => {
					seen.push(delivery);
					return {
						messages: [checkpoint, ...delivery.messages],
						entries: [{ type: "planning_state_change", payload: { planning: { mode: "plan", plan: null } } }],
					};
				},
			},
		});
		let provider: string[] = [];
		faux.setResponses([
			(context) => {
				provider = transcript(context);
				return fauxAssistantMessage("done");
			},
		]);

		await conversation.prompt({ clientMessageId: "client-1", message: "hello" });
		await conversation.waitForIdle();

		expect(seen).toMatchObject([
			{ kind: "prompt", clientMessageId: "client-1", origin: "client", messages: [{ clientMessageId: "client-1" }] },
		]);
		expect(batches(events)).toContainEqual([
			"client_input_state",
			"planning_state_change",
			"custom_message",
			"message",
		]);
		expect(conversation.state.planning).toEqual({ mode: "plan", plan: null });
		expect(provider).toEqual(["user:plan now draft", "user:hello"]);
		expect(conversation.state.clientInputs.inputs.get("client-1")?.state).toBe("completed");
		expect(conversation.state).toEqual(fold(await readLog(log)));
	});

	it("fails the turn when preparation drops the client input's message or returns a disallowed entry", async () => {
		for (const prepared of [
			{ messages: [{ role: "user" as const, content: "replaced", timestamp: 1 }] },
			{ messages: [] as AgentMessage[] },
		]) {
			const { conversation, faux, log } = await openConversation({ policy: { prepareDelivery: () => prepared } });
			faux.setResponses([fauxAssistantMessage("unused")]);
			await conversation.prompt({ message: "hello" });
			await conversation.waitForIdle();

			expect(faux.state.callCount).toBe(0);
			expect(lastAssistant(conversation)).toMatchObject({ stopReason: "error" });
			expect(conversation.queue.prompt.map(textOf)).toEqual(["hello"]);
			expect((await readLog(log)).some((entry) => "clientMessageId" in entry)).toBe(false);
		}
		const { conversation, faux } = await openConversation({
			policy: {
				prepareDelivery: (delivery) => ({
					messages: delivery.messages,
					entries: [{ type: "leaf", payload: { targetId: null } }],
				}),
			},
		});
		faux.setResponses([fauxAssistantMessage("unused")]);
		await conversation.prompt({ message: "hello" });
		await conversation.waitForIdle();
		expect(lastAssistant(conversation)).toMatchObject({
			stopReason: "error",
			error: { message: "Entry type leaf cannot be appended" },
		});
	});

	it("tells messageEnd whether a message was delivered or produced by the loop", async () => {
		const origins: [string, ConversationMessageOrigin][] = [];
		const { conversation, faux } = await openConversation({
			policy: {
				messageEnd: (message, _signal, origin) => {
					origins.push([message.role, origin]);
					return undefined;
				},
			},
		});
		faux.setResponses([fauxAssistantMessage("answer")]);
		await promptAndSettle(conversation, "hello");

		expect(origins).toEqual([
			["user", "delivery"],
			["assistant", "loop"],
		]);
	});
});

describe("Conversation navigation preparation", () => {
	it("lets prepare cancel the move or supply the summary and label", async () => {
		const { conversation, faux, log, events } = await openConversation();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await promptAndSettle(conversation, "first");
		const target = conversation.state.leafId!;
		await promptAndSettle(conversation, "second");
		const leaf = conversation.state.leafId;
		const before = await readLog(log);

		await expect(conversation.navigate(target, { prepare: () => ({ cancel: true }) })).resolves.toEqual({
			status: "cancelled",
			leafId: leaf,
		});
		expect(await readLog(log)).toEqual(before);

		let preparation: ConversationNavigationPreparation | undefined;
		const result = await conversation.navigate(target, {
			summarize: true,
			label: "ignored",
			prepare: (value) => {
				preparation = value;
				return { summary: { summary: "from the host", fromHook: true }, label: "kept" };
			},
		});

		expect(preparation).toMatchObject({
			fromLeafId: leaf,
			targetId: target,
			commonAncestorId: target,
			summarize: true,
		});
		expect(preparation?.entries.map((entry) => entry.type)).toEqual(["message", "message"]);
		expect(batches(events).at(-1)).toEqual(["leaf", "branch_summary", "label"]);
		expect(conversation.state.tree.byId.get(result.summaryEntryId!)?.payload).toMatchObject({
			summary: "from the host",
			fromHook: true,
		});
		expect(conversation.state.labels.get(result.summaryEntryId!)?.label).toBe("kept");
		expect(conversation.state).toEqual(fold(await readLog(log)));
	});

	it("requires a model only when the summarizer runs", async () => {
		const { conversation } = await openConversation({ withModel: false, summarizer: summarizer() });
		const appended = await conversation.append([
			{ type: "custom_message", payload: { customType: "note", content: "one", display: true } },
			{ type: "custom_message", payload: { customType: "note", content: "two", display: true } },
		]);
		const first = appended[0]!.id;

		await expect(conversation.navigate(first, { summarize: true })).rejects.toMatchObject({ code: "invalid_state" });
		await expect(
			conversation.navigate(first, { summarize: true, prepare: () => ({ summary: { summary: "hosted" } }) }),
		).resolves.toMatchObject({ status: "navigated", leafId: expect.any(String) });
		await expect(conversation.navigate(null)).resolves.toMatchObject({ status: "navigated", leafId: null });
	});
});

describe("Conversation host-run input", () => {
	it("admits input without delivering it and fences it at most once", async () => {
		const { conversation, faux } = await openConversation();
		const admission = await conversation.admitInput(
			"prompt",
			{ clientMessageId: "cmd-1", message: "/deploy" },
			{ deliver: false },
		);

		expect(admission.ordinals).toHaveLength(1);
		expect(conversation.queue).toEqual({ prompt: [], steer: [], followUp: [] });
		expect(conversation.phase.operation).toBeNull();
		expect(conversation.state.clientInputs.inputs.get("cmd-1")).toMatchObject({ state: "accepted" });
		expect(conversation.state.clientInputs.inputs.get("cmd-1")?.origin).toBeUndefined();

		await conversation.markInputStarted("cmd-1");
		await expect(conversation.markInputStarted("cmd-1")).rejects.toMatchObject({ code: "invalid_argument" });
		expect(clientInputRecovery(conversation.state)).toMatchObject({
			kind: "blocked",
			blocker: { clientMessageId: "cmd-1" },
		});

		await conversation.settleClientInput("cmd-1", { state: "completed" });
		await expect(admission.completion).resolves.toMatchObject({ state: "completed" });
		const again = await conversation.admitInput(
			"prompt",
			{ clientMessageId: "cmd-1", message: "/deploy" },
			{ deliver: false },
		);
		expect(again.ordinals).toEqual([]);
		await expect(again.completion).resolves.toMatchObject({ state: "completed" });
		expect(faux.state.callCount).toBe(0);
	});

	it("delivers a started input once the host transformed it", async () => {
		const { conversation, faux, log } = await openConversation();
		let requested: string[] = [];
		faux.setResponses([
			(context) => {
				requested = userTexts(context.messages as AgentMessage[]);
				return fauxAssistantMessage("done");
			},
		]);
		const admitted = await conversation.admitInput(
			"prompt",
			{ clientMessageId: "hooked", message: "raw" },
			{ deliver: false },
		);
		await conversation.markInputStarted("hooked");
		await expect(conversation.prompt({ clientMessageId: "hooked", message: "other" })).rejects.toMatchObject({
			code: "client_input_conflict",
		});

		const delivered = await conversation.prompt({
			clientMessageId: "hooked",
			message: "raw",
			prepared: { message: "transformed" },
		});
		expect(delivered.ordinals).toEqual([]);
		await expect(admitted.completion).resolves.toMatchObject({ state: "completed" });
		await conversation.waitForIdle();

		expect(requested).toEqual(["transformed"]);
		expect((await readLog(log)).map((entry) => entry.type)).toEqual([
			"model_change",
			"client_input_receipt",
			"client_input_state",
			"message",
			"message",
		]);
		expect(conversation.state.clientInputs.inputs.get("hooked")?.state).toBe("completed");
	});
});

describe("Conversation host-origin input", () => {
	it("keeps queued host messages durable across a restart", async () => {
		const log = new InMemoryConversationLog("host-messages");
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
		const notice: AgentMessage = {
			role: "custom",
			customType: "notice",
			content: "job done",
			display: true,
			timestamp: 1,
		};
		const queued = await first.conversation.queueMessages("followUp", [notice]);
		first.conversation.abort();
		await first.conversation.waitForIdle();
		expect(first.conversation.state.clientInputs.inputs.get(queued.clientMessageId)).toMatchObject({
			origin: "host",
			state: "accepted",
			queuedInput: { delivery: "follow_up", messages: [notice] },
		});

		const second = await openConversation({ log: await copyLog(log, "host-messages"), faux });
		expect(second.conversation.queue.followUp).toEqual([notice]);
		let requested: string[] = [];
		faux.setResponses([
			(context) => {
				requested = transcript(context);
				return fauxAssistantMessage("noticed");
			},
		]);
		await second.conversation.continue();

		expect(requested).toEqual(["user:first", "user:job done"]);
		expect(second.conversation.state.clientInputs.inputs.get(queued.clientMessageId)?.state).toBe("completed");
	});

	it("withdraws host messages on clear and records the origin of prompts", async () => {
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
		await conversation.prompt({ message: "first" });
		await entered.promise;
		const host = await conversation.queueMessages("steer", [
			{ role: "custom", customType: "notice", content: "cleared", display: false, timestamp: 1 },
		]);
		expect((await conversation.clearQueue()).steer.map(textOf)).toEqual(["cleared"]);
		await expect(host.completion).resolves.toEqual({ state: "withdrawn" });
		release.resolve();
		await conversation.waitForIdle();

		await conversation.prompt({ clientMessageId: "from-extension", message: "hi", origin: "host" });
		await conversation.waitForIdle();
		expect(conversation.state.clientInputs.inputs.get("from-extension")).toMatchObject({
			origin: "host",
			state: "completed",
		});
		await expect(conversation.prompt({ clientMessageId: "from-extension", message: "hi" })).rejects.toMatchObject({
			code: "client_input_conflict",
		});
		await expect(conversation.queueMessages("steer", [])).rejects.toMatchObject({ code: "invalid_argument" });
	});
});

describe("Conversation client input digest", () => {
	it("hashes the shared digest material in canonical image form", async () => {
		const { conversation, faux, log } = await openConversation();
		faux.setResponses([fauxAssistantMessage("seen")]);
		const image = { mimeType: "image/png", data: "aW1n", type: "image" as const };
		await conversation.prompt({ message: "look", images: [image], streamingBehavior: "steer" });
		await conversation.waitForIdle();

		const input = { message: "look", images: [image], streamingBehavior: "steer" as const };
		const material = clientInputDigestMaterial("prompt", input);
		expect(material).toBe(
			JSON.stringify({
				command: "prompt",
				message: "look",
				images: [{ type: "image", mimeType: "image/png", data: "aW1n" }],
				streamingBehavior: "steer",
			}),
		);
		const digest = await clientInputDigest("prompt", input);
		expect(digest).toBe(createHash("sha256").update(material).digest("hex"));
		const receipt = (await readLog(log)).find(
			(entry): entry is ConversationLogEntry & { payload: { semanticDigest: string; input: unknown } } =>
				entry.type === "client_input_receipt",
		);
		expect(receipt?.payload.semanticDigest).toBe(digest);
		expect(receipt?.payload.input).toEqual({
			message: "look",
			images: [{ type: "image", mimeType: "image/png", data: "aW1n" }],
			streamingBehavior: "steer",
		});
	});
});
