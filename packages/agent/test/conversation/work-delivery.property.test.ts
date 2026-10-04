import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { WorkDelivery, WorkOutcome } from "@hansjm10/volt-protocol/work";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ConversationWorkFinish } from "../../src/conversation/api.ts";
import { fold } from "../../src/conversation/fold.ts";
import { InMemoryConversationLog } from "../../src/conversation/in-memory-log.ts";
import type { ConversationLogEntry } from "../../src/conversation/log.ts";
import { openConversation, readLog, registerFauxProvider } from "./conversation-test-utils.ts";

type Step =
	| { kind: "start"; delivery: number; resume: boolean }
	| { kind: "checkpoint"; pick: number }
	| { kind: "finish"; pick: number; outcome: number; deliver: number }
	| { kind: "withdraw"; pick: number }
	| { kind: "prompt" | "settle" };

const DELIVERIES: readonly WorkDelivery[] = ["none", "message", "wake"];
const OUTCOMES: readonly WorkOutcome[] = ["completed", "failed", "cancelled", "interrupted"];
const pick = fc.nat({ max: 1_000 });

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
	{
		weight: 4,
		arbitrary: fc.record({
			kind: fc.constant("start" as const),
			delivery: fc.nat({ max: 2 }),
			resume: fc.boolean(),
		}),
	},
	fc.record({ kind: fc.constant("checkpoint" as const), pick }),
	{
		weight: 4,
		arbitrary: fc.record({
			kind: fc.constant("finish" as const),
			pick,
			outcome: fc.nat({ max: 3 }),
			deliver: fc.nat({ max: 3 }),
		}),
	},
	fc.record({ kind: fc.constant("withdraw" as const), pick }),
	{ weight: 2, arbitrary: fc.record({ kind: fc.constant("prompt" as const) }) },
	fc.record({ kind: fc.constant("settle" as const) }),
);

interface Finished {
	readonly delivery: WorkDelivery;
	readonly outcome: WorkOutcome;
	readonly suppressed: boolean;
	readonly notice?: { readonly clientMessageId: string; readonly wake: boolean };
}

function noticeWorkId(entry: ConversationLogEntry): string | undefined {
	if (entry.type !== "client_input_queued") return undefined;
	const payload = entry.payload as {
		queuedInput: { messages?: Array<{ customType?: string; details?: { workId?: string } }> };
	};
	const message = payload.queuedInput.messages?.[0];
	return message?.customType === "work_notice" ? message.details?.workId : undefined;
}

describe("work delivery properties", () => {
	it("queues at most one notice per completed or failed result, atomically with its finish", async () => {
		await fc.assert(
			fc.asyncProperty(fc.array(stepArbitrary, { minLength: 5, maxLength: 40, size: "medium" }), async (steps) => {
				const faux = registerFauxProvider();
				faux.setResponses(Array.from({ length: 200 }, (_, index) => fauxAssistantMessage(`answer ${index}`)));
				const log = new InMemoryConversationLog("delivery");
				const { conversation, events } = await openConversation({ log, faux });
				await conversation.work.reconcile();
				const open: string[] = [];
				const delivery = new Map<string, WorkDelivery>();
				const finished = new Map<string, Finished>();
				const notices: string[] = [];
				const pending: Promise<unknown>[] = [];
				let n = 0;
				for (const step of steps) {
					n++;
					switch (step.kind) {
						case "start": {
							const work = DELIVERIES[step.delivery] ?? "none";
							const record = await conversation.work.start({
								kind: "job",
								title: `job ${n}`,
								input: { n },
								cancellable: true,
								delivery: work,
								resume: step.resume,
							});
							open.push(record.workId);
							delivery.set(record.workId, work);
							break;
						}
						case "checkpoint": {
							const workId = open[step.pick % Math.max(open.length, 1)];
							if (workId !== undefined)
								await conversation.work.checkpoint(workId, { progress: { text: `${n}` } });
							break;
						}
						case "finish": {
							const index = step.pick % Math.max(open.length, 1);
							const workId = open[index];
							if (workId === undefined) break;
							open.splice(index, 1);
							const outcome = OUTCOMES[step.outcome] ?? "completed";
							const deliver: ConversationWorkFinish["deliver"] =
								step.deliver === 0 ? false : step.deliver === 1 ? { text: `custom ${n}` } : undefined;
							const result = await conversation.work.finish(workId, {
								outcome,
								result: { summary: `summary ${n}`, output: { text: "out", truncated: false } },
								...(deliver === undefined ? {} : { deliver }),
							});
							finished.set(workId, {
								delivery: delivery.get(workId) ?? "none",
								outcome,
								suppressed: deliver === false,
								...(result.notice === undefined ? {} : { notice: result.notice }),
							});
							if (result.notice) notices.push(result.notice.clientMessageId);
							break;
						}
						case "withdraw": {
							const clientMessageId = notices[step.pick % Math.max(notices.length, 1)];
							if (clientMessageId !== undefined)
								pending.push(conversation.work.withdrawHostInput(clientMessageId));
							break;
						}
						case "prompt":
							pending.push(conversation.prompt({ message: `prompt ${n}`, streamingBehavior: "followUp" }));
							break;
						case "settle":
							await Promise.allSettled(pending.splice(0));
							await conversation.waitForIdle();
							break;
					}
				}
				for (let round = 0; round < 10 && (pending.length > 0 || conversation.busy); round++) {
					await Promise.allSettled(pending.splice(0));
					await conversation.waitForIdle();
				}

				const entries = await readLog(log);
				expect(conversation.state).toEqual(fold(entries));
				const batches = events.flatMap((event) => (event.type === "committed" ? [event.entries] : []));
				for (const [workId, expected] of finished) {
					const delivers =
						!expected.suppressed &&
						expected.delivery !== "none" &&
						(expected.outcome === "completed" || expected.outcome === "failed");
					expect(entries.filter((entry) => noticeWorkId(entry) === workId)).toHaveLength(delivers ? 1 : 0);
					expect(expected.notice !== undefined).toBe(delivers);
					const batch = batches.find((entries) =>
						entries.some(
							(entry) =>
								entry.type === "work_finished" && (entry.payload as { workId: string }).workId === workId,
						),
					);
					expect(batch?.map((entry) => entry.type)).toEqual(
						delivers ? ["work_finished", "client_input_receipt", "client_input_queued"] : ["work_finished"],
					);
					if (!expected.notice) continue;
					expect(expected.notice.wake).toBe(expected.delivery === "wake");
					const input = conversation.state.clientInputs.inputs.get(expected.notice.clientMessageId);
					expect(input?.origin).toBe("host");
					expect(input?.queuedInput?.wake).toBe(expected.delivery === "wake" ? undefined : false);
					// A woken conversation delivers its notice; nothing is left behind.
					if (expected.delivery === "wake") expect(input?.state).not.toBe("accepted");
				}

				// Undelivered notices survive a restart as queued host input.
				const waiting = [...conversation.state.clientInputs.inputs.values()]
					.filter((input) => input.origin === "host" && input.state === "accepted")
					.map((input) => input.clientMessageId);
				expect(conversation.queue.steer).toHaveLength(waiting.length);
				await conversation.close();
				const reopenedLog = new InMemoryConversationLog("delivery");
				if (entries.length > 0) {
					const drafts = entries.map(({ ordinal: _ordinal, ...draft }) => draft);
					await reopenedLog.append({ expectedOrdinal: 0, commitId: "copy", entries: drafts });
				}
				const reopened = await openConversation({ log: reopenedLog, faux, withModel: false });
				expect(reopened.conversation.queue.steer).toHaveLength(waiting.length);
				await reopened.conversation.close();
			}),
			{ seed: 6_040_203, numRuns: 100 },
		);
	}, 120_000);
});
