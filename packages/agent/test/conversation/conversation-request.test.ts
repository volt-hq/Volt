import {
	type Context,
	fauxAssistantMessage,
	fauxToolCall,
	type PromptCacheMetadata,
	type SimpleStreamOptions,
	type StreamOptions,
} from "@hansjm10/volt-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { ConversationRequestBoundary, ConversationSummarizer } from "../../src/conversation/api.ts";
import type { AgentMessage, AgentTool, StreamFn } from "../../src/types.ts";
import {
	client,
	deferred,
	openConversation,
	promptAndSettle,
	registerFauxProvider,
	textOf,
	userTexts,
} from "./conversation-test-utils.ts";

const suffix = [{ role: "user" as const, content: "optional evidence", timestamp: 1 }];

function optionalContext(messages = structuredClone(suffix)) {
	return {
		messages,
		authorization: { isCurrent: vi.fn(() => true), settle: vi.fn<(admitted: boolean) => void>() },
	};
}

const inspectTool: AgentTool = {
	name: "inspect",
	label: "Inspect",
	description: "test",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "observed" }] }),
};

describe("Conversation request boundary", () => {
	it("runs after the input commits and appends only to the provider request", async () => {
		const candidate = optionalContext();
		const boundaries: ConversationRequestBoundary[] = [];
		const { conversation, faux, log } = await openConversation({
			policy: {
				requestBoundary: async (boundary) => {
					boundaries.push(boundary);
					expect(log.head()).toBe(4);
					return candidate;
				},
			},
		});
		let provider: Context | undefined;
		faux.setResponses([
			(context) => {
				provider = structuredClone(context);
				return fauxAssistantMessage("done");
			},
		]);
		const admission = await conversation.prompt({ message: "request" });
		await admission.completion;

		expect(provider?.messages.at(-1)).toEqual(suffix[0]);
		expect(candidate.authorization.settle.mock.calls).toEqual([[true]]);
		expect(boundaries).toMatchObject([
			{
				newInput: true,
				cause: "input",
				basisOrdinal: 4,
				batch: { deliveries: [{ kind: "prompt", clientMessageId: admission.clientMessageId }] },
			},
		]);
		expect(JSON.stringify(conversation.state.context.messages)).not.toContain("optional evidence");
	});

	it.each(["revoked", "unchanged", "abort", "batch mismatch"] as const)(
		"settles a %s candidate exactly once",
		async (change) => {
			const candidate = optionalContext();
			let invalidate = (): void => undefined;
			const { conversation, faux } = await openConversation({
				policy: {
					requestBoundary: async () => {
						if (change === "revoked") candidate.authorization.isCurrent.mockReturnValue(false);
						if (change === "abort") conversation.abort();
						if (change === "batch mismatch") invalidate();
						return candidate;
					},
				},
			});
			invalidate = () => conversation.invalidateRequestBoundary();
			let provider: Context | undefined;
			faux.setResponses([
				(context) => {
					provider = structuredClone(context);
					return fauxAssistantMessage("done");
				},
			]);
			await promptAndSettle(conversation, "mandatory");

			expect(candidate.authorization.settle.mock.calls).toEqual([[change === "unchanged"]]);
			expect(faux.state.callCount).toBe(change === "abort" ? 0 : 1);
			if (change !== "abort") {
				expect(JSON.stringify(provider?.messages).includes("optional evidence")).toBe(change === "unchanged");
			}
		},
	);

	it.each(["configuration", "context"] as const)("recollects after a %s change during collection", async (change) => {
		const candidates = [optionalContext(), optionalContext()];
		let calls = 0;
		const { conversation, faux } = await openConversation({
			policy: {
				requestBoundary: async () => {
					calls++;
					if (calls === 1) {
						if (change === "configuration") conversation.setStreamOptions({ maxRetries: 2 });
						else
							await conversation.append([
								{ type: "message", payload: { message: { role: "user", content: "late", timestamp: 2 } } },
							]);
					}
					return candidates[calls - 1];
				},
			},
		});
		let provider: string[] = [];
		faux.setResponses([
			(context) => {
				provider = (context.messages as AgentMessage[]).map(textOf);
				return fauxAssistantMessage("done");
			},
		]);
		await promptAndSettle(conversation, "request");

		expect(calls).toBe(2);
		expect(candidates.map((candidate) => candidate.authorization.settle.mock.calls)).toEqual([[[false]], [[true]]]);
		expect(provider).toEqual(
			change === "context" ? ["request", "late", "optional evidence"] : ["request", "optional evidence"],
		);
	});

	it("does not yield between final authorization and the provider call", async () => {
		let current = true;
		const candidate = optionalContext();
		candidate.authorization.isCurrent.mockImplementation(() => {
			queueMicrotask(() => {
				current = false;
			});
			return current;
		});
		const invoked = vi.fn();
		const stream: StreamFn = (model, context, options) => {
			invoked(current, structuredClone(candidate.authorization.settle.mock.calls));
			return client.streamSimple(model, context, options);
		};
		const { conversation, faux } = await openConversation({
			stream,
			policy: { requestBoundary: async () => candidate },
		});
		faux.setResponses([fauxAssistantMessage("done")]);
		await promptAndSettle(conversation, "request");
		expect(invoked.mock.calls).toEqual([[true, [[true]]]]);
	});

	it("reports an empty candidate as omitted", async () => {
		const candidate = optionalContext([]);
		const { conversation, faux } = await openConversation({ policy: { requestBoundary: async () => candidate } });
		faux.setResponses([fauxAssistantMessage("done")]);
		await promptAndSettle(conversation, "request");
		expect(candidate.authorization.settle.mock.calls).toEqual([[false]]);
	});

	it("keeps batch identity across tool turns and retries", async () => {
		const boundaries: ConversationRequestBoundary[] = [];
		const { conversation, faux } = await openConversation({
			policy: {
				retry: (_error, attempt) => (attempt === 1 ? 0 : undefined),
				requestBoundary: async (boundary) => {
					boundaries.push(boundary);
					return undefined;
				},
			},
		});
		conversation.setTools([inspectTool]);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("inspect", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "overloaded", retryable: true, message: "busy" },
			}),
			fauxAssistantMessage("retried"),
		]);
		await promptAndSettle(conversation, "request");

		expect(boundaries.map((boundary) => boundary.cause)).toEqual(["input", "tools", "retry"]);
		expect(new Set(boundaries.map((boundary) => boundary.batch?.id)).size).toBe(1);
		expect(new Set(boundaries.map((boundary) => boundary.attemptId)).size).toBe(3);
	});

	it("reports ordered steer and follow-up batches by delivery, not by text", async () => {
		const boundaries: ConversationRequestBoundary[] = [];
		const { conversation, faux } = await openConversation({
			queueModes: { steer: "all", followUp: "all" },
			policy: {
				requestBoundary: async (boundary) => {
					boundaries.push(boundary);
					return undefined;
				},
			},
		});
		const entered = deferred();
		const release = deferred();
		faux.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("first");
			},
			fauxAssistantMessage("steered"),
			fauxAssistantMessage("followed"),
		]);
		await conversation.prompt({ message: "same" });
		await entered.promise;
		const steering = [await conversation.steer({ message: "same" }), await conversation.steer({ message: "same" })];
		const followUps = [
			await conversation.followUp({ message: "same" }),
			await conversation.followUp({ message: "same" }),
		];
		release.resolve();
		await conversation.waitForIdle();

		expect(boundaries.map((boundary) => boundary.batch?.deliveries.map((delivery) => delivery.kind))).toEqual([
			["prompt"],
			["steer", "steer"],
			["followUp", "followUp"],
		]);
		expect(boundaries[1]?.batch?.deliveries.map((delivery) => delivery.clientMessageId)).toEqual(
			steering.map((admission) => admission.clientMessageId),
		);
		expect(boundaries[2]?.batch?.deliveries.map((delivery) => delivery.clientMessageId)).toEqual(
			followUps.map((admission) => admission.clientMessageId),
		);
		expect(new Set(boundaries.map((boundary) => boundary.batch?.id)).size).toBe(3);
	});

	it("never sends structural requests through the boundary", async () => {
		const requestBoundary = vi.fn(async () => undefined);
		const summarizer: ConversationSummarizer = {
			compact: async ({ stream, model, signal, state }) => {
				const response = await stream(
					model,
					{ messages: [{ role: "user", content: "summarize", timestamp: 0 }] },
					{ signal },
				);
				await response.result();
				return { summary: "s", firstKeptEntryId: state.branch.at(-1) ?? "", tokensBefore: 1 };
			},
			summarizeBranch: async () => undefined,
		};
		const { conversation, faux } = await openConversation({ summarizer, policy: { requestBoundary } });
		faux.setResponses([fauxAssistantMessage("answer")]);
		faux.setSimpleResponses([fauxAssistantMessage("summary")]);
		await promptAndSettle(conversation, "request");
		await conversation.compact();
		expect(requestBoundary).toHaveBeenCalledTimes(1);
		expect(faux.state).toMatchObject({ callCount: 1, simpleCallCount: 1 });
	});
});

describe("Conversation stream configuration", () => {
	it("forwards curated options with the conversation id and runs provider hooks", async () => {
		let captured: SimpleStreamOptions | undefined;
		let finalPayload: unknown;
		const responses: number[] = [];
		const { conversation, faux } = await openConversation({
			streamOptions: {
				timeoutMs: 1000,
				maxRetries: 2,
				headers: { "x-base": "base" },
				metadata: { base: true },
				env: { BASE_ENV: "base" },
				transport: "websocket",
				cacheRetention: "none",
				thinkingBudgets: { low: 128 },
			},
			policy: {
				beforeProviderPayload: (payload) => ({ steps: [...(payload as { steps: string[] }).steps, "hook"] }),
				afterProviderResponse: (response) => {
					responses.push(response.status);
				},
			},
		});
		faux.setResponses([
			async (_context, options, _state, model) => {
				captured = options as SimpleStreamOptions;
				finalPayload = await options?.onPayload?.({ steps: ["provider"] }, model);
				return fauxAssistantMessage("ok");
			},
		]);
		await promptAndSettle(conversation, "hello");

		expect(captured).toMatchObject({
			timeoutMs: 1000,
			maxRetries: 2,
			sessionId: "conversation-test",
			transport: "websocket",
			cacheRetention: "none",
			thinkingBudgets: { low: 128 },
			inferenceSpeed: "standard",
			headers: { "x-base": "base" },
			metadata: { base: true },
			env: { BASE_ENV: "base" },
		});
		expect(captured?.apiKey).toBeUndefined();
		expect(finalPayload).toEqual({ steps: ["provider", "hook"] });
		expect(responses).toEqual([200]);
	});

	it("uses updated stream options for the next request of a running turn", async () => {
		const timeouts: unknown[] = [];
		const { conversation, faux } = await openConversation({ streamOptions: { timeoutMs: 1000 } });
		conversation.setTools([inspectTool]);
		faux.setResponses([
			(_context, options) => {
				timeouts.push(options?.timeoutMs);
				return fauxAssistantMessage([fauxToolCall("inspect", {})], { stopReason: "toolUse" });
			},
			(_context, options) => {
				timeouts.push(options?.timeoutMs);
				return fauxAssistantMessage("done");
			},
		]);
		conversation.subscribe((event) => {
			if (event.type === "tool_execution_start") conversation.setStreamOptions({ timeoutMs: 2000 });
		});
		await promptAndSettle(conversation, "hello");
		expect(timeouts).toEqual([1000, 2000]);
		expect(conversation.currentStreamOptions).toEqual({ timeoutMs: 2000 });
	});

	it("sends summary requests with stream options, hooks, and the summarizer's reasoning", async () => {
		const faux = registerFauxProvider({ models: [{ id: "reasoning", reasoning: true }] });
		let captured: (StreamOptions & { reasoning?: unknown }) | undefined;
		const payloads = vi.fn((payload: unknown) => payload);
		const summarizer: ConversationSummarizer = {
			compact: async () => undefined,
			summarizeBranch: async ({ stream, model, signal }) => {
				const response = await stream(
					model,
					{ messages: [{ role: "user", content: "summarize", timestamp: 0 }] },
					{ reasoning: "low", maxTokens: 2048, signal },
				);
				await response.result();
				return { summary: "branch" };
			},
		};
		const { conversation } = await openConversation({
			faux,
			summarizer,
			streamOptions: { headers: { "x-base": "base" } },
			policy: { beforeProviderPayload: payloads },
		});
		await conversation.setThinkingLevel("xhigh");
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await promptAndSettle(conversation, "first");
		const target = conversation.state.branch[0] ?? null;
		faux.setSimpleResponses([
			async (_context, options, _state, model) => {
				captured = options as typeof captured;
				await options?.onPayload?.({ structural: true }, model);
				return fauxAssistantMessage("summary");
			},
		]);
		await conversation.navigate(target, { summarize: true });

		expect(captured).toMatchObject({
			reasoning: "low",
			maxTokens: 2048,
			headers: { "x-base": "base" },
			sessionId: "conversation-test",
		});
		expect(payloads).toHaveBeenCalledWith({ structural: true }, expect.objectContaining({ id: "reasoning" }));
	});
});

describe("Conversation prompt cache refresh", () => {
	const renewing: PromptCacheMetadata = {
		modes: ["explicit"],
		retention: { short: { ttlSeconds: 300 } },
		refreshesOnHit: true,
	};

	async function cacheConversation(withRefresher = true) {
		const refreshes: Context[] = [];
		const faux = registerFauxProvider({
			models: [{ id: "cache-test", promptCache: renewing }],
			refreshPromptCache: (context) => {
				refreshes.push(context);
				return {
					status: "refreshed",
					usage: {
						availability: "complete",
						input: 0,
						output: 0,
						cacheRead: 42,
						cacheWrite: 0,
						totalTokens: 42,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				};
			},
		});
		const requests: Context[] = [];
		const opened = await openConversation({
			faux,
			systemPrompt: "system",
			...(withRefresher ? { promptCacheRefresh: client } : {}),
		});
		faux.setResponses([
			(context) => {
				requests.push(context);
				return fauxAssistantMessage("first");
			},
		]);
		return { ...opened, refreshes, requests };
	}

	it("replays the latest turn request", async () => {
		const { conversation, faux, refreshes, requests } = await cacheConversation();
		expect(conversation.canRefreshPromptCache()).toBe(false);
		expect(await conversation.refreshPromptCache()).toEqual({ status: "unavailable", reason: "no_request" });
		await promptAndSettle(conversation, "hello");

		expect(conversation.canRefreshPromptCache()).toBe(true);
		const result = await conversation.refreshPromptCache();
		expect(result).toMatchObject({ status: "refreshed", usage: { cacheRead: 42 }, model: { id: "cache-test" } });
		expect(refreshes).toEqual([requests[0]]);
		expect(faux.state).toMatchObject({ callCount: 1, refreshCount: 1 });
	});

	it("stays valid while the branch grows and stops after configuration or branch changes", async () => {
		const { conversation, faux } = await cacheConversation();
		await promptAndSettle(conversation, "hello");
		await conversation.append([{ type: "custom", payload: { customType: "note" } }]);
		expect((await conversation.refreshPromptCache()).status).toBe("refreshed");

		await conversation.setThinkingLevel("high");
		expect(conversation.canRefreshPromptCache()).toBe(false);
		expect(await conversation.refreshPromptCache()).toEqual({
			status: "unavailable",
			reason: "configuration_changed",
		});
		await conversation.navigate(null);
		expect(await conversation.refreshPromptCache()).toEqual({ status: "unavailable", reason: "branch_changed" });
		expect(faux.state.refreshCount).toBe(1);
	});

	it("is unavailable without a refresh function", async () => {
		const { conversation, faux } = await cacheConversation(false);
		await promptAndSettle(conversation, "hello");
		expect(await conversation.refreshPromptCache()).toEqual({ status: "unavailable", reason: "no_refresh_function" });
		expect(faux.state.refreshCount).toBe(0);
		expect(userTexts(conversation.state.context.messages)).toEqual(["hello"]);
	});
});
