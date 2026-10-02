import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHarness } from "../../src/harness/agent-harness.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory-storage.ts";
import { Session } from "../../src/harness/session/session.ts";
import { type AgentHarnessOptions, type AgentHarnessRequestBoundary, SessionError } from "../../src/harness/types.ts";
import type { AgentDeliveryOwner, AgentTool } from "../../src/types.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function setup(options: Partial<AgentHarnessOptions> = {}) {
	const faux = registerFauxProvider();
	const session = options.session ?? new Session(new InMemorySessionStorage());
	const harness = new AgentHarness({
		env: new NodeExecutionEnv({ cwd: process.cwd() }),
		session,
		model: faux.getModel(),
		...options,
	});
	cleanup.push(async () => {
		harness.dispose();
		await harness.waitForClosed();
		faux.unregister();
	});
	return { harness, faux, session };
}

const suffix = [{ role: "user" as const, content: "optional evidence", timestamp: 1 }];

function optionalContext(messages = suffix) {
	return {
		messages,
		authorization: { isCurrent: vi.fn(() => true), settle: vi.fn<(admitted: boolean) => void>() },
	};
}
function pauseFinalAdmission(session: Session, phase: "snapshot" | "hook commit") {
	const entered = deferred();
	const release = deferred();
	let armed = false;
	const getSnapshot = session.getBranchSnapshot.bind(session);
	const commitBatch = session.commitBatch.bind(session);
	vi.spyOn(session, "getBranchSnapshot").mockImplementation(async (...args) => {
		if (armed && phase === "snapshot") {
			armed = false;
			entered.resolve();
			await release.promise;
		}
		return getSnapshot(...args);
	});
	vi.spyOn(session, "commitBatch").mockImplementation(async (...args) => {
		if (armed && phase === "hook commit") {
			armed = false;
			entered.resolve();
			await release.promise;
		}
		return commitBatch(...args);
	});
	return {
		entered: entered.promise,
		release: release.resolve,
		arm: () => {
			armed = true;
		},
	};
}

const tool: AgentTool = {
	name: "inspect",
	label: "Inspect",
	description: "test",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "observed" }] }),
};

describe("AgentHarness post-durability request boundary", () => {
	it("waits for verified commit and owner settlement, and appends only to the provider projection", async () => {
		const session = new Session(new InMemorySessionStorage());
		const candidate = optionalContext();
		const committed = deferred();
		const finish = deferred();
		const boundaries: AgentHarnessRequestBoundary[] = [];
		const owner: AgentDeliveryOwner = {
			prepareLogical: (context) => ({ outcome: "prepared", messages: context.sourceMessages }),
			commitAttempt: async (context) => {
				const basis = await session.getBranchSnapshot();
				const result = await session.commitBatch({
					guard: { kind: "exact", cursor: basis.cursor },
					mutations: context.preparedMessages.map((message) => ({
						kind: "append",
						entry: { type: "message", message },
					})),
					deliveryAttribution: {
						deliveryId: context.deliveryId,
						epoch: context.epoch,
						attemptId: context.attemptId,
					},
				});
				if (result.outcome !== "committed") throw result.error;
				committed.resolve();
				return { outcome: "committed", receipt: result.receipt };
			},
			finish: () => finish.promise,
		};
		const { harness, faux } = setup({
			session,
			deliveryOwner: owner,
			requestBoundary: async (boundary) => {
				boundaries.push(boundary);
				return candidate;
			},
		});
		let providerContext: Context | undefined;
		faux.setResponses([
			(context) => {
				providerContext = structuredClone(context);
				return fauxAssistantMessage("done");
			},
		]);
		const run = harness.runPrompt("request");
		await committed.promise;
		expect(boundaries).toHaveLength(0);
		expect(faux.state.callCount).toBe(0);
		finish.resolve();
		await run;
		expect(providerContext?.messages.at(-1)).toEqual(suffix[0]);
		expect(candidate.authorization.isCurrent).toHaveBeenCalledTimes(1);
		expect(candidate.authorization.settle.mock.calls).toEqual([[true]]);
		expect(boundaries).toHaveLength(1);
		expect(boundaries[0]).toMatchObject({
			newInput: true,
			cause: "input",
			batch: { deliveries: [{ kind: "prompt" }] },
		});
		expect(JSON.stringify((await session.buildContext()).messages)).not.toContain("optional evidence");
	});

	describe.each(["snapshot", "hook commit"] as const)("final %s await", (phase) => {
		it.each(["revoked", "unchanged", "abort", "batch mismatch"] as const)(
			"settles %s optional context exactly once without recollecting",
			async (change) => {
				const session = new Session(new InMemorySessionStorage());
				const pause = pauseFinalAdmission(session, phase);
				const candidate = optionalContext(structuredClone(suffix));
				const requestBoundary = vi.fn(async () => {
					pause.arm();
					return candidate;
				});
				const { harness, faux } = setup({ session, requestBoundary });
				if (phase === "hook commit") {
					harness.on("before_provider_request", async () => {
						await harness.appendMessage({ role: "user", content: "hook canonical", timestamp: 2 });
						return undefined;
					});
				}
				let providerContext: Context | undefined;
				faux.setResponses([
					(context) => {
						providerContext = structuredClone(context);
						return fauxAssistantMessage("done");
					},
				]);
				const run = harness.runPrompt("mandatory request");
				await pause.entered;
				expect(candidate.authorization.isCurrent).not.toHaveBeenCalled();
				expect(candidate.authorization.settle).not.toHaveBeenCalled();
				if (change === "revoked") candidate.authorization.isCurrent.mockReturnValue(false);
				if (change === "abort") harness.abort();
				if (change === "batch mismatch") harness.invalidateRequestBoundary();
				candidate.messages[0]!.content = "mutated after collection";
				pause.release();
				await run;
				expect(requestBoundary).toHaveBeenCalledTimes(1);
				expect(candidate.authorization.settle.mock.calls).toEqual([[change === "unchanged"]]);
				expect(faux.state.callCount).toBe(change === "abort" ? 0 : 1);
				if (change !== "abort") {
					expect(JSON.stringify(providerContext?.messages)).toContain("mandatory request");
					expect(providerContext?.messages.includes(candidate.messages[0]!)).toBe(false);
					if (change === "unchanged") expect(providerContext?.messages.at(-1)).toEqual(suffix[0]);
					else expect(JSON.stringify(providerContext?.messages)).not.toContain("optional evidence");
					if (phase === "hook commit")
						expect(JSON.stringify(providerContext?.messages)).toContain("hook canonical");
				}
				expect(JSON.stringify((await session.buildContext()).messages)).not.toContain("optional evidence");
			},
		);
	});

	it.each(["configuration", "cursor"] as const)("settles discarded candidates on %s retry", async (change) => {
		const session = new Session(new InMemorySessionStorage());
		const pause = pauseFinalAdmission(session, "snapshot");
		const candidates = [optionalContext(), optionalContext()];
		const requestBoundary = vi.fn(async () => {
			if (requestBoundary.mock.calls.length === 1) pause.arm();
			return candidates[requestBoundary.mock.calls.length - 1];
		});
		const { harness, faux } = setup({ session, requestBoundary });
		faux.setResponses([fauxAssistantMessage("done")]);
		const run = harness.runPrompt("request");
		await pause.entered;
		if (change === "configuration") await harness.setStreamOptions({ maxRetries: 2 });
		else await session.appendMessage({ role: "user", content: "late canonical", timestamp: 2 });
		pause.release();
		await run;
		expect(requestBoundary).toHaveBeenCalledTimes(2);
		expect(candidates.map((candidate) => candidate.authorization.settle.mock.calls)).toEqual([[[false]], [[true]]]);
		expect(candidates[0]!.authorization.isCurrent).not.toHaveBeenCalled();
		expect(faux.state.callCount).toBe(1);
	});

	it("settles a rolled-back hook commit candidate before retrying", async () => {
		const session = new Session(new InMemorySessionStorage());
		const commit = session.commitBatch.bind(session);
		const candidates = [optionalContext(), optionalContext()];
		const requestBoundary = vi.fn(async () => {
			if (requestBoundary.mock.calls.length === 1) {
				vi.spyOn(session, "commitBatch")
					.mockImplementationOnce(async (batch) => ({
						outcome: "rolled_back",
						cursor: batch.guard.cursor,
						error: new SessionError("conflict", "retry"),
					}))
					.mockImplementation(commit);
			}
			return candidates[requestBoundary.mock.calls.length - 1];
		});
		const { harness, faux } = setup({ session, requestBoundary });
		harness.on("before_provider_request", async () => {
			await harness.appendMessage({ role: "user", content: "hook canonical", timestamp: 2 });
			return undefined;
		});
		faux.setResponses([fauxAssistantMessage("done")]);
		await harness.runPrompt("request");
		expect(requestBoundary).toHaveBeenCalledTimes(2);
		expect(candidates.map((candidate) => candidate.authorization.settle.mock.calls)).toEqual([[[false]], [[true]]]);
		expect(faux.state.callCount).toBe(1);
	});

	it.each(["snapshot", "hook commit", "authorization", "stream"] as const)(
		"settles a candidate when %s throws",
		async (phase) => {
			const session = new Session(new InMemorySessionStorage());
			const candidate = optionalContext();
			const error = new Error("admission failed");
			const requestBoundary = vi.fn(async () => {
				if (phase === "snapshot") vi.spyOn(session, "getBranchSnapshot").mockRejectedValueOnce(error);
				if (phase === "hook commit") vi.spyOn(session, "commitBatch").mockRejectedValueOnce(error);
				return candidate;
			});
			if (phase === "authorization")
				candidate.authorization.isCurrent.mockImplementation(() => {
					throw error;
				});
			const { harness, faux } = setup({
				session,
				requestBoundary,
				...(phase === "stream"
					? {
							streamFn: () => {
								throw error;
							},
						}
					: {}),
			});
			if (phase === "hook commit")
				harness.on("before_provider_request", async () => {
					await harness.appendMessage({ role: "user", content: "hook canonical", timestamp: 2 });
					return undefined;
				});
			await harness.runPrompt("request");
			expect(requestBoundary).toHaveBeenCalledTimes(1);
			// Even a synchronous provider failure follows the context handoff.
			expect(candidate.authorization.settle.mock.calls).toEqual([[phase === "stream"]]);
			expect(faux.state.callCount).toBe(0);
			expect((await session.buildContext()).messages.at(-1)).toMatchObject({
				role: "assistant",
				stopReason: "error",
				errorMessage: "admission failed",
			});
		},
	);

	it("does not yield between final authorization and provider invocation", async () => {
		let current = true;
		const candidate = optionalContext();
		candidate.authorization.isCurrent.mockImplementation(() => {
			queueMicrotask(() => {
				current = false;
			});
			return current;
		});
		const invoked = vi.fn();
		const { harness, faux } = setup({
			requestBoundary: async () => candidate,
			streamFn: (model, context, options) => {
				invoked(current, structuredClone(candidate.authorization.settle.mock.calls));
				return streamSimple(model, context, options);
			},
		});
		faux.setResponses([fauxAssistantMessage("done")]);
		await harness.runPrompt("request");
		expect(invoked.mock.calls).toEqual([[true, [[true]]]]);
		expect(candidate.authorization.settle.mock.calls).toEqual([[true]]);
	});

	it("reports an empty candidate as omitted", async () => {
		const candidate = optionalContext([]);
		const { harness, faux } = setup({ requestBoundary: async () => candidate });
		faux.setResponses([fauxAssistantMessage("done")]);
		await harness.runPrompt("request");
		expect(candidate.authorization.settle.mock.calls).toEqual([[false]]);
		expect(faux.state.callCount).toBe(1);
	});

	it("retains batch identity over tool turns and explicit retry projections", async () => {
		const boundaries: AgentHarnessRequestBoundary[] = [];
		const { harness, faux } = setup({
			tools: [tool],
			requestBoundary: async (boundary) => {
				boundaries.push(boundary);
				return undefined;
			},
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }),
			fauxAssistantMessage("retried"),
		]);
		await harness.runPrompt("request");
		await harness.rebaseContinuationContext({ source: "retry", project: (messages) => messages.slice(0, -1) });
		await harness.continue();
		expect(boundaries.map((boundary) => boundary.cause)).toEqual(["input", "tools", "retry"]);
		expect(new Set(boundaries.map((boundary) => boundary.batch?.id)).size).toBe(1);
		expect(new Set(boundaries.map((boundary) => boundary.attemptId)).size).toBe(3);
	});

	it("reports ordered committed SDK steer/follow-up batches without text identity guesses", async () => {
		const entered = deferred();
		const release = deferred();
		const boundaries: AgentHarnessRequestBoundary[] = [];
		const { harness, faux } = setup({
			steeringMode: "all",
			followUpMode: "all",
			requestBoundary: async (boundary) => {
				boundaries.push(boundary);
				return undefined;
			},
		});
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("steered"),
			fauxAssistantMessage("followed"),
		]);
		const run = harness.runPrompt("same");
		await entered.promise;
		const steering = [await harness.steer("same"), await harness.steer("same")];
		const followUps = [await harness.followUp("same"), await harness.followUp("same")];
		expect(boundaries).toHaveLength(1);
		release.resolve();
		await run;
		expect(boundaries.map((boundary) => boundary.batch?.deliveries.map((delivery) => delivery.kind))).toEqual([
			["prompt"],
			["steer", "steer"],
			["followUp", "followUp"],
		]);
		expect(boundaries[1]?.batch?.deliveries.map((delivery) => delivery.deliveryId)).toEqual(steering);
		expect(boundaries[2]?.batch?.deliveries.map((delivery) => delivery.deliveryId)).toEqual(followUps);
		expect(new Set(boundaries.map((boundary) => boundary.batch?.id)).size).toBe(3);
	});

	it("keeps suffixes after provider-context recomputation and rebuilds stale collection", async () => {
		let boundaryCount = 0;
		const candidates: ReturnType<typeof optionalContext>[] = [];
		const { harness, faux, session } = setup({
			requestBoundary: async () => {
				boundaryCount++;
				if (boundaryCount === 1)
					await harness.appendMessage({ role: "user", content: "late canonical", timestamp: 2 });
				const candidate = optionalContext([{ role: "user", content: `suffix-${boundaryCount}`, timestamp: 3 }]);
				candidates.push(candidate);
				return candidate;
			},
		});
		harness.on("context", async () => {
			await harness.appendMessage({ role: "user", content: "hook canonical", timestamp: 2 });
			return { messages: [{ role: "user", content: "transformed", timestamp: 2 }] };
		});
		let providerContext: Context | undefined;
		faux.setResponses([
			(context) => {
				providerContext = structuredClone(context);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.runPrompt("request");
		expect(JSON.stringify(providerContext?.messages)).toContain("late canonical");
		expect(JSON.stringify(providerContext?.messages)).not.toContain("suffix-1");
		expect(providerContext?.messages.at(-1)).toMatchObject({ content: "suffix-2" });
		expect(boundaryCount).toBe(2);
		expect(candidates.map((candidate) => candidate.authorization.settle.mock.calls)).toEqual([[[false]], [[true]]]);
		expect(JSON.stringify((await session.buildContext()).messages)).not.toContain("suffix-");
	});

	it("excludes structural requests and marks final-response admission", async () => {
		const boundaries: AgentHarnessRequestBoundary[] = [];
		const { harness, faux } = setup({
			tools: [{ ...tool, execute: async () => ({ content: [], disposition: "final_response" }) }],
			requestBoundary: async (boundary) => {
				boundaries.push(boundary);
				return optionalContext();
			},
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("final"),
			fauxAssistantMessage("summary"),
			fauxAssistantMessage("tree"),
		]);
		await harness.runPrompt("request");
		expect(boundaries[1]?.requestAuthority).toBe("final_response");
		for (const structural of [harness.runCompactionOperation.bind(harness), harness.runTreeOperation.bind(harness)]) {
			await structural(async ({ streamFn, signal }) => {
				const stream = await streamFn(
					faux.getModel(),
					{ messages: [{ role: "user", content: "summarize", timestamp: 0 }] },
					{ signal },
				);
				await stream.result();
			});
		}
		expect(boundaries).toHaveLength(2);
	});

	it("never observes failed deliveries and permits reentrant abort without losing the committed user", async () => {
		let count = 0;
		const candidate = optionalContext();
		const { harness, faux, session } = setup({
			requestBoundary: async () => {
				count++;
				harness.abort();
				return candidate;
			},
		});
		await harness.runPrompt("committed");
		expect(count).toBe(1);
		expect(candidate.authorization.settle.mock.calls).toEqual([[false]]);
		expect(candidate.authorization.isCurrent).not.toHaveBeenCalled();
		expect(faux.state.callCount).toBe(0);
		expect((await session.buildContext()).messages[0]).toMatchObject({ role: "user" });
		let failedBoundaries = 0;
		const failed = setup({
			deliveryOwner: {
				prepareLogical: () => ({ outcome: "terminally_failed", error: new Error("rejected") }),
				commitAttempt: () => {
					throw new Error("unreachable");
				},
				finish: () => {},
			},
			requestBoundary: async () => {
				failedBoundaries++;
				return undefined;
			},
		});
		expect(await failed.harness.runPrompt("rejected")).toMatchObject({ status: "delivery_failed" });
		expect(failed.faux.state.callCount).toBe(0);
		expect(failedBoundaries).toBe(0);
	});
});
