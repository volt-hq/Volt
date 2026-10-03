import { type Context, fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import { describe, expect, it, vi } from "vitest";
import type { ConversationEvent, ConversationPolicy, ConversationSummarizer } from "../../src/conversation/api.ts";
import { fold } from "../../src/conversation/fold.ts";
import { InMemoryConversationLog } from "../../src/conversation/in-memory-log.ts";
import type { ConversationLog } from "../../src/conversation/log.ts";
import type { AgentLoopNextAction, AgentMessage } from "../../src/types.ts";
import { calculateTool } from "../utils/calculate.ts";
import {
	lastAssistant,
	openConversation,
	promptAndSettle,
	readLog,
	registerFauxProvider,
	textOf,
	userTexts,
} from "./conversation-test-utils.ts";

type Resolved = Extract<ConversationEvent, { type: "next_action_resolved" }>;

function resolvedActions(events: readonly ConversationEvent[]): Resolved[] {
	return events.filter((event): event is Resolved => event.type === "next_action_resolved");
}

const toolCall = (id: string) =>
	fauxAssistantMessage(fauxToolCall("calculate", { expression: "2 + 3" }, { id }), { stopReason: "toolUse" });

describe("Conversation next-action policy", () => {
	it("publishes resolved actions with stop provenance", async () => {
		const { conversation, faux, events } = await openConversation();
		faux.setResponses([fauxAssistantMessage("done")]);
		await promptAndSettle(conversation, "hello");

		expect(
			resolvedActions(events).map(({ action, requestAuthority, stopReason }) => ({
				action,
				requestAuthority,
				stopReason,
			})),
		).toEqual([
			{ action: { type: "request", reason: "delivery" }, requestAuthority: "provider", stopReason: undefined },
			{ action: { type: "stop" }, requestAuthority: "provider", stopReason: "completion" },
		]);
	});

	it.each([false, true])("attributes a tool stop unless policy stops explicitly (explicit=%s)", async (explicit) => {
		const { conversation, faux, events } = await openConversation({
			policy: {
				afterToolCall: async () => ({ disposition: "stop" }),
				nextAction: (context) => (context.completedTurn && explicit ? { type: "stop" } : undefined),
			},
		});
		conversation.setTools([calculateTool]);
		faux.setResponses([toolCall("call-1")]);
		await promptAndSettle(conversation, "calculate");

		expect(faux.state.callCount).toBe(1);
		expect(resolvedActions(events).at(-1)).toMatchObject({
			action: { type: "stop" },
			stopReason: explicit ? "policy" : "tool",
		});
	});

	it("pauses with retained tool authority and resumes on continue", async () => {
		let paused = false;
		const { conversation, faux, events } = await openConversation({
			policy: {
				nextAction: (context) => {
					if (!context.completedTurn?.toolResults.length || paused) return undefined;
					paused = true;
					return { type: "pause" };
				},
			},
		});
		conversation.setTools([calculateTool]);
		let continuation: string[] = [];
		faux.setResponses([
			toolCall("call-1"),
			(context) => {
				continuation = context.messages.map((message) => textOf(message as AgentMessage));
				return fauxAssistantMessage("done");
			},
		]);
		await promptAndSettle(conversation, "calculate");
		expect(faux.state.callCount).toBe(1);
		expect(resolvedActions(events).at(-1)).toMatchObject({
			action: { type: "pause" },
			requestAuthority: "tool_continuation",
		});

		await conversation.continue();
		expect(faux.state.callCount).toBe(2);
		expect(continuation).toContain("2 + 3 = 5");
	});

	it("delivers policy-attached messages as committed input and isolates the action", async () => {
		const returned: AgentLoopNextAction = {
			type: "request",
			reason: "delivery",
			deliveries: [{ messages: [{ role: "user", content: "policy delivery", timestamp: 1 }] }],
		};
		const { conversation, faux, log } = await openConversation({
			policy: {
				nextAction: (context) => {
					if (context.completedTurn || returned.type !== "request") return undefined;
					queueMicrotask(() => {
						const delivery = returned.type === "request" ? returned.deliveries?.[0] : undefined;
						delivery?.messages.push({ role: "user", content: "late mutation", timestamp: 2 });
					});
					return returned;
				},
			},
		});
		let provider: string[] = [];
		faux.setResponses([
			(context) => {
				provider = userTexts(context.messages as AgentMessage[]);
				return fauxAssistantMessage("done");
			},
		]);
		await promptAndSettle(conversation, "hello");

		expect(provider).toEqual(["hello", "policy delivery"]);
		expect(userTexts(conversation.state.context.messages)).toEqual(["hello", "policy delivery"]);
		expect(conversation.state).toEqual(fold(await readLog(log)));
	});

	it("keeps final-response authority across a pause and ignores weaker policy", async () => {
		let finalDecisions = 0;
		const { conversation, faux } = await openConversation({
			policy: {
				afterToolCall: async () => ({ disposition: "final_response" }),
				nextAction: (context) => {
					if (context.requestAuthority !== "final_response") return undefined;
					finalDecisions++;
					return finalDecisions === 1
						? { type: "pause" }
						: {
								type: "request",
								reason: "delivery",
								deliveries: [{ messages: [{ role: "user", content: "ignored", timestamp: 1 }] }],
							};
				},
			},
		});
		conversation.setTools([calculateTool]);
		const requests: Array<{ tools: string[]; system: string; users: string[] }> = [];
		faux.setResponses([
			toolCall("call-1"),
			(context: Context) => {
				requests.push({
					tools: context.tools?.map((tool) => tool.name) ?? [],
					system: context.systemPrompt ?? "",
					users: userTexts(context.messages as AgentMessage[]),
				});
				return fauxAssistantMessage("final answer");
			},
		]);
		await promptAndSettle(conversation, "finish");
		expect(faux.state.callCount).toBe(1);
		await conversation.continue();

		expect(finalDecisions).toBe(2);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.tools).toEqual([]);
		expect(requests[0]?.system).toContain("VOLT FINAL RESPONSE");
		expect(requests[0]?.users).toEqual(["finish"]);
	});

	it("continues from an assistant tail only when policy delivers work", async () => {
		let deliver = true;
		const { conversation, faux } = await openConversation({
			policy: {
				nextAction: () => {
					if (!deliver) return undefined;
					deliver = false;
					return {
						type: "request",
						reason: "delivery",
						deliveries: [{ messages: [{ role: "user", content: "wake", timestamp: 1 }] }],
					};
				},
			},
		});
		deliver = false;
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await promptAndSettle(conversation, "first");
		deliver = true;
		await conversation.continue();
		await conversation.continue();

		expect(faux.state.callCount).toBe(2);
		expect(userTexts(conversation.state.context.messages)).toEqual(["first", "wake"]);
	});
});

describe("Conversation message policy", () => {
	it("commits the messageEnd replacement and publishes it", async () => {
		const inputs: string[] = [];
		const { conversation, faux, log, events } = await openConversation({
			policy: {
				messageEnd: (message) => {
					if (message.role !== "assistant") return undefined;
					inputs.push(textOf(message));
					return { ...message, content: [{ type: "text", text: "replaced" }] };
				},
			},
		});
		faux.setResponses([fauxAssistantMessage("provider")]);
		await promptAndSettle(conversation, "hello");

		expect(inputs).toEqual(["provider"]);
		expect(textOf(lastAssistant(conversation)!)).toBe("replaced");
		const ended = events.find((event) => event.type === "message_end" && event.message.role === "assistant");
		expect(ended && "message" in ended && textOf(ended.message)).toBe("replaced");
		expect(conversation.state).toEqual(fold(await readLog(log)));
	});

	it("rejects a role-changing replacement with an error message", async () => {
		const { conversation, faux } = await openConversation({
			policy: {
				messageEnd: (message) =>
					message.role === "assistant" && message.stopReason === "stop"
						? { role: "user", content: "wrong", timestamp: 1 }
						: undefined,
			},
		});
		faux.setResponses([fauxAssistantMessage("provider")]);
		await promptAndSettle(conversation, "hello");
		expect(lastAssistant(conversation)).toMatchObject({
			stopReason: "error",
			error: { message: "messageEnd must preserve the message role" },
		});
	});
});

describe("Conversation retry", () => {
	it("retries a failed request inside the turn with the failure kept out of the request", async () => {
		const retry = vi.fn<NonNullable<ConversationPolicy["retry"]>>((error, attempt) =>
			error.retryable && attempt <= 2 ? 0 : undefined,
		);
		const { conversation, faux, events, log } = await openConversation({ policy: { retry } });
		const requests: string[][] = [];
		const failing = (context: Context) => {
			requests.push((context.messages as AgentMessage[]).map((message) => `${message.role}:${textOf(message)}`));
			return fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "overloaded", retryable: true, message: "overloaded" },
			});
		};
		faux.setResponses([
			failing,
			failing,
			(context) => {
				requests.push((context.messages as AgentMessage[]).map((message) => `${message.role}:${textOf(message)}`));
				return fauxAssistantMessage("recovered");
			},
		]);
		await promptAndSettle(conversation, "hello");

		expect(retry.mock.calls.map(([error, attempt]) => [error.kind, attempt])).toEqual([
			["overloaded", 1],
			["overloaded", 2],
		]);
		expect(requests).toEqual([["user:hello"], ["user:hello"], ["user:hello"]]);
		expect(textOf(lastAssistant(conversation)!)).toBe("recovered");
		const retryEvents = events.filter((event) => event.type === "retry_start" || event.type === "retry_end");
		expect(retryEvents.map((event) => event.type)).toEqual(["retry_start", "retry_start", "retry_end"]);
		expect(retryEvents.at(-1)).toMatchObject({ attempt: 2, success: true });
		const phases = events.flatMap((event) => (event.type === "phase_changed" ? [event.phase.operation] : []));
		expect(phases).toEqual(["turn", null]);
		expect((await readLog(log)).filter((entry) => entry.type === "message")).toHaveLength(4);
	});

	it("cancels the backoff on abort", async () => {
		const { conversation, faux, events } = await openConversation({ policy: { retry: () => 60_000 } });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", error: { kind: "server", retryable: true, message: "down" } }),
		]);
		conversation.subscribe((event) => {
			if (event.type === "retry_start") conversation.abort("keyboard_interrupt");
		});
		await promptAndSettle(conversation, "hello");

		expect(faux.state.callCount).toBe(1);
		expect(events.filter((event) => event.type === "retry_end")).toMatchObject([
			{ success: false, error: "Retry cancelled" },
		]);
	});
});

describe("Conversation retry and failed deliveries", () => {
	it("ends a running retry unsuccessfully when the retried request's delivery rolls back", async () => {
		const inner = new InMemoryConversationLog("retry-rollback");
		// The batch delivering the steer rolls back; everything else commits.
		const log: ConversationLog = {
			conversationId: inner.conversationId,
			lost: inner.lost,
			head: () => inner.head(),
			read: (after, limit) => inner.read(after, limit),
			close: () => inner.close(),
			append: async (batch) =>
				batch.entries.some(
					(entry) =>
						entry.type === "message" &&
						textOf((entry.payload as { message: AgentMessage }).message) === "steer during backoff",
				)
					? { status: "rolled_back", error: new Error("Injected rollback") }
					: inner.append(batch),
		};
		const { conversation, faux, events } = await openConversation({ log, policy: { retry: () => 20 } });
		faux.setResponses([
			fauxAssistantMessage("", { stopReason: "error", error: { kind: "server", retryable: true, message: "down" } }),
			fauxAssistantMessage("must remain unused"),
		]);
		conversation.subscribe((event) => {
			if (event.type === "retry_start") void conversation.steer({ message: "steer during backoff" });
		});
		await promptAndSettle(conversation, "hello");
		await conversation.waitForIdle();

		expect(events.filter((event) => event.type === "retry_end")).toMatchObject([
			{ success: false, error: "Injected rollback" },
		]);
		expect(faux.state.callCount).toBe(1);
	});
});

describe("Conversation compaction", () => {
	function compactingSummarizer(calls: string[]): ConversationSummarizer {
		return {
			compact: async ({ cause, state }) => {
				calls.push(cause);
				const firstMessage = state.branch.find((id) => state.tree.byId.get(id)?.type === "message");
				return { summary: `summary ${calls.length}`, firstKeptEntryId: firstMessage ?? "", tokensBefore: 99 };
			},
			summarizeBranch: async () => undefined,
		};
	}

	it("compacts on overflow and retries once inside the turn", async () => {
		const calls: string[] = [];
		const faux = registerFauxProvider({ models: [{ id: "small", contextWindow: 1000 }] });
		const compaction = vi.fn<NonNullable<ConversationPolicy["compaction"]>>(() => ({}));
		const { conversation, events } = await openConversation({
			faux,
			summarizer: compactingSummarizer(calls),
			policy: { compaction },
		});
		const overflow = () =>
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "context_overflow", retryable: false, message: "too long" },
			});
		let retried: string[] = [];
		faux.setResponses([
			overflow,
			(context) => {
				retried = (context.messages as AgentMessage[]).map((message) => message.role);
				return overflow();
			},
		]);
		await promptAndSettle(conversation, "big input");

		expect(calls).toEqual(["overflow"]);
		expect(compaction.mock.calls.map(([, cause]) => cause)).toEqual(["overflow"]);
		expect(retried).toEqual(["user", "user"]);
		expect(faux.state.callCount).toBe(2);
		expect(events.filter((event) => event.type === "compaction_end")).toMatchObject([
			{ cause: "overflow", status: "compacted" },
		]);
		expect(events.flatMap((event) => (event.type === "phase_changed" ? [event.phase.operation] : []))).toEqual([
			"turn",
			null,
		]);
	});

	it("compacts between requests when policy asks and resumes the turn", async () => {
		const calls: string[] = [];
		let compactNow = false;
		const { conversation, faux, log } = await openConversation({
			summarizer: compactingSummarizer(calls),
			policy: {
				compaction: (_usage, cause, check) => {
					if (cause !== "threshold" || !check.continuing || !compactNow) return undefined;
					compactNow = false;
					return {};
				},
			},
		});
		conversation.setTools([calculateTool]);
		let resumed: string[] = [];
		faux.setResponses([
			toolCall("call-1"),
			(context) => {
				resumed = (context.messages as AgentMessage[]).map((message) => message.role);
				return fauxAssistantMessage("done");
			},
		]);
		compactNow = true;
		await promptAndSettle(conversation, "work");

		expect(calls).toEqual(["threshold"]);
		expect(resumed).toEqual(["user", "user", "assistant", "toolResult"]);
		const entries = await readLog(log);
		expect(entries.map((entry) => entry.type).slice(-4)).toEqual(["message", "message", "compaction", "message"]);
		expect(conversation.state).toEqual(fold(entries));
	});

	it("compacts on request and skips when the summarizer has nothing to summarize", async () => {
		const calls: string[] = [];
		const { conversation, faux } = await openConversation({ summarizer: compactingSummarizer(calls) });
		faux.setResponses([fauxAssistantMessage("answer")]);
		await promptAndSettle(conversation, "hello");

		await expect(conversation.compact({ instructions: "focus" })).resolves.toMatchObject({ status: "compacted" });
		expect(conversation.state.context.messages[0]).toMatchObject({ role: "compactionSummary", summary: "summary 1" });

		const empty = await openConversation({
			summarizer: { compact: async () => undefined, summarizeBranch: async () => undefined },
		});
		await expect(empty.conversation.compact()).resolves.toEqual({ status: "skipped" });
	});
	it("lets next-action policy act instead of a mid-turn compaction", async () => {
		const calls: string[] = [];
		const defaults: string[] = [];
		const { conversation, faux } = await openConversation({
			summarizer: compactingSummarizer(calls),
			policy: {
				compaction: (_usage, cause, check) => (cause === "threshold" && check.continuing ? {} : undefined),
				nextAction: (context) => {
					if (!context.completedTurn) return undefined;
					defaults.push(context.defaultAction.type);
					// A host that needs a final report requests it before any compaction.
					return context.defaultAction.type === "pause"
						? {
								type: "request",
								reason: "delivery",
								deliveries: [{ messages: [{ role: "user", content: "report now", timestamp: Date.now() }] }],
							}
						: undefined;
				},
			},
		});
		conversation.setTools([calculateTool]);
		let reported: string[] = [];
		faux.setResponses([
			toolCall("call-1"),
			(context) => {
				reported = userTexts(context.messages as AgentMessage[]);
				return fauxAssistantMessage("final report");
			},
		]);
		await promptAndSettle(conversation, "work");

		expect(defaults[0]).toBe("pause");
		expect(calls).toEqual([]);
		expect(reported).toEqual(["work", "report now"]);
		expect(textOf(lastAssistant(conversation)!)).toBe("final report");
	});

	it("compacts after a tool batch that stops the turn, without resuming", async () => {
		const calls: string[] = [];
		const checks: Array<{ continuing: boolean; stopReason: string }> = [];
		const { conversation, faux, log } = await openConversation({
			summarizer: compactingSummarizer(calls),
			policy: {
				afterToolCall: async () => ({ disposition: "stop" }),
				compaction: (_usage, cause, check) => {
					checks.push({ continuing: check.continuing, stopReason: check.message.stopReason });
					return cause === "threshold" && !check.continuing ? {} : undefined;
				},
			},
		});
		conversation.setTools([calculateTool]);
		faux.setResponses([toolCall("call-1"), fauxAssistantMessage("must remain unused")]);
		await promptAndSettle(conversation, "work");

		expect(checks).toEqual([{ continuing: false, stopReason: "toolUse" }]);
		expect(calls).toEqual(["threshold"]);
		expect(faux.state.callCount).toBe(1);
		const entries = await readLog(log);
		expect(entries.at(-1)?.type).toBe("compaction");
		expect(conversation.state).toEqual(fold(entries));
	});
});
