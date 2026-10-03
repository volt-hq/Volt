import { fauxAssistantMessage, fauxToolCall } from "@hansjm10/volt-ai";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ConversationSummarizer, ConversationTurnReservation } from "../../src/conversation/api.ts";
import { fold } from "../../src/conversation/fold.ts";
import { InMemoryConversationLog } from "../../src/conversation/in-memory-log.ts";
import type { ConversationLogEntry } from "../../src/conversation/log.ts";
import { calculateTool } from "../utils/calculate.ts";
import { openConversation, readLog, registerFauxProvider } from "./conversation-test-utils.ts";

type Response = "text" | "tool" | "retryable" | "overflow" | "length";

type Step =
	| { kind: "prompt"; queued: boolean }
	| { kind: "steer" | "followUp" | "abort" | "continue" | "clear" | "settle" | "compact" }
	| { kind: "navigate"; pick: number; summarize: boolean; prepare: number }
	| { kind: "setting"; which: number }
	| { kind: "append" | "host" | "command" }
	/** Reserve the settled conversation, then prompt with or cancel the reservation after `hold` more steps. */
	| { kind: "reserve"; hold: number; use: boolean };

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
	{ weight: 5, arbitrary: fc.record({ kind: fc.constant("prompt" as const), queued: fc.boolean() }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("steer" as const) }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("followUp" as const) }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("abort" as const) }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("continue" as const) }) },
	fc.record({ kind: fc.constant("clear" as const) }),
	{ weight: 3, arbitrary: fc.record({ kind: fc.constant("settle" as const) }) },
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("compact" as const) }) },
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("navigate" as const),
			pick: fc.nat({ max: 1_000 }),
			summarize: fc.boolean(),
			prepare: fc.nat({ max: 2 }),
		}),
	},
	fc.record({ kind: fc.constant("setting" as const), which: fc.nat({ max: 4 }) }),
	fc.record({ kind: fc.constant("append" as const) }),
	{
		weight: 3,
		arbitrary: fc.record({ kind: fc.constant("reserve" as const), hold: fc.nat({ max: 3 }), use: fc.boolean() }),
	},
	fc.record({ kind: fc.constant("host" as const) }),
	fc.record({ kind: fc.constant("command" as const) }),
);

const responseArbitrary = fc.constantFrom<Response>("text", "text", "tool", "retryable", "overflow", "length");

const summarizer: ConversationSummarizer = {
	compact: async ({ state }) => {
		const firstKept = state.branch.findLast((id) => state.tree.byId.get(id)?.type === "message");
		return firstKept === undefined
			? undefined
			: {
					summary: "summary",
					firstKeptEntryId: firstKept,
					tokensBefore: 1,
					...(state.ordinal % 2 === 0
						? {
								messages: [
									{ role: "custom", customType: "checkpoint", content: "plan", display: false, timestamp: 1 },
								],
							}
						: {}),
				};
	},
	summarizeBranch: async ({ entries }) => (entries.length === 0 ? undefined : { summary: "branch" }),
};

async function settle(promises: Promise<unknown>[]): Promise<void> {
	await Promise.allSettled(promises.splice(0));
}

describe("Conversation properties", () => {
	it("keeps live state equal to the fold of its log under random schedules", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(stepArbitrary, { minLength: 1, maxLength: 30 }),
				fc.array(responseArbitrary, { minLength: 1, maxLength: 8 }),
				async (steps, responses) => {
					const faux = registerFauxProvider({ models: [{ id: "model", contextWindow: 100_000 }] });
					let served = 0;
					const respond = () => {
						const kind = responses[served++ % responses.length];
						if (kind === "tool") {
							return fauxAssistantMessage(
								fauxToolCall("calculate", { expression: "1 + 1" }, { id: `call-${served}` }),
								{
									stopReason: "toolUse",
								},
							);
						}
						if (kind === "length") return fauxAssistantMessage("", { stopReason: "length" });
						if (kind === "retryable" || kind === "overflow") {
							return fauxAssistantMessage("", {
								stopReason: "error",
								error:
									kind === "retryable"
										? { kind: "overloaded", retryable: true, message: "busy" }
										: { kind: "context_overflow", retryable: false, message: "too long" },
							});
						}
						return fauxAssistantMessage(`answer ${served}`);
					};
					faux.setResponses(Array.from({ length: 400 }, () => respond));
					faux.setSimpleResponses(Array.from({ length: 400 }, () => () => fauxAssistantMessage("summary")));
					const log = new InMemoryConversationLog("property");
					const { conversation, events } = await openConversation({
						log,
						faux,
						summarizer,
						tools: [calculateTool],
						policy: {
							retry: (error, attempt) => (error.retryable && attempt <= 1 ? 0 : undefined),
							compaction: (_usage, cause, check) =>
								cause === "overflow"
									? {}
									: check.message.stopReason === "length" && check.state.ordinal % 2 === 0
										? { resume: "retry" as const }
										: undefined,
							prepareDelivery: (delivery) =>
								delivery.kind === "prompt"
									? {
											messages: delivery.messages,
											entries: [{ type: "custom", payload: { customType: "delivered" } }],
										}
									: undefined,
						},
					});
					const pending: Promise<unknown>[] = [];
					let held: { reservation: ConversationTurnReservation; hold: number; use: boolean } | undefined;
					const release = () => {
						held?.reservation.cancel();
						held = undefined;
					};
					let text = 0;
					for (const step of steps) {
						const message = `input ${++text}`;
						switch (step.kind) {
							case "prompt":
								pending.push(
									conversation.prompt({
										message,
										...(step.queued ? { streamingBehavior: "followUp" as const } : {}),
									}),
								);
								break;
							case "steer":
								pending.push(conversation.steer({ message }));
								break;
							case "followUp":
								pending.push(conversation.followUp({ message }));
								break;
							case "abort":
								conversation.abort("host_action");
								break;
							case "continue":
								pending.push(conversation.continue());
								break;
							case "clear":
								pending.push(conversation.clearQueue());
								break;
							case "compact":
								pending.push(conversation.compact());
								break;
							case "navigate": {
								const targets = [
									null,
									...(conversation.state.tree.children.get(null) ?? []),
									...conversation.state.branch,
								];
								pending.push(
									conversation.navigate(targets[step.pick % targets.length] ?? null, {
										summarize: step.summarize,
										...(step.prepare === 0
											? {}
											: {
													prepare: () =>
														step.prepare === 1
															? { cancel: true as const }
															: { summary: { summary: "prepared", fromHook: true }, label: message },
												}),
									}),
								);
								break;
							}
							case "reserve":
								release();
								await settle(pending);
								await conversation.waitForIdle();
								held = { reservation: conversation.reserve(), hold: step.hold + 1, use: step.use };
								break;
							case "host":
								pending.push(
									conversation.queueMessages(text % 2 === 0 ? "steer" : "followUp", [
										{ role: "custom", customType: "notice", content: message, display: true, timestamp: 1 },
									]),
								);
								break;
							case "command":
								pending.push(
									(async () => {
										const admission = await conversation.admitInput(
											"prompt",
											{ message: `/${message}` },
											{ deliver: false },
										);
										await conversation.markInputStarted(admission.clientMessageId);
										await conversation.settleClientInput(admission.clientMessageId, { state: "completed" });
									})(),
								);
								break;
							case "setting":
								pending.push(
									[
										() => conversation.setThinkingLevel("high"),
										() => conversation.setFastMode(text % 2 === 0),
										() => conversation.setName(message),
										() => conversation.setPlanning({ mode: "plan", plan: null }),
										() => conversation.setModel(faux.getModel()),
									][step.which]!(),
								);
								break;
							case "append":
								pending.push(conversation.append([{ type: "custom", payload: { customType: "note" } }]));
								break;
							case "settle": {
								release();
								await settle(pending);
								await conversation.waitForIdle();
								const entries = await readLog(log);
								expect(conversation.state).toEqual(fold(entries));
								break;
							}
						}
						if (held && --held.hold === 0) {
							const { reservation, use } = held;
							held = undefined;
							if (use) pending.push(conversation.prompt({ message: `reserved ${text}` }, { reservation }));
							else reservation.cancel();
						}
						await Promise.resolve();
					}
					release();
					for (let rounds = 0; rounds < 20 && (pending.length > 0 || conversation.busy); rounds++) {
						await settle(pending);
						await conversation.waitForIdle();
					}
					const entries = await readLog(log);
					expect(conversation.state).toEqual(fold(entries));
					const committed: ConversationLogEntry[] = events.flatMap((event) =>
						event.type === "committed" ? event.entries : [],
					);
					expect(committed).toEqual(entries);
					await conversation.close();
				},
			),
			{ numRuns: 100 },
		);
	}, 120_000);
});
