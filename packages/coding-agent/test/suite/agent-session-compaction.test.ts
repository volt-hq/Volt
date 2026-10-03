import type { AgentMessage, ConversationLogAppend } from "@hansjm10/volt-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	estimateToolDefinitionTokens,
	fauxAssistantMessage,
	fauxToolCall,
	type ProviderError,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateMessagesTokens } from "../../src/core/compaction/index.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(
	harness: Harness,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		error?: ProviderError;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage("", {
			stopReason: options.stopReason,
			error: options.error,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.control.setStreamFn((model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", seq: 1, reason: "stop", message });
		});
		return stream;
	});
	return () => callCount;
}

function useSummaryResponses(
	harness: Harness,
	responses: AssistantMessage[],
	onOptions?: (options: { reasoning?: string } | undefined) => void,
): () => number {
	let callCount = 0;
	harness.control.setStreamFn((model, _context, options) => {
		const response = responses[Math.min(callCount, responses.length - 1)];
		callCount += 1;
		onOptions?.(options);
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				seq: 1,
				reason: "stop",
				message: {
					...response,
					api: model.api,
					provider: model.provider,
					model: model.id,
				},
			});
		});
		return stream;
	});
	return () => callCount;
}

async function seedCompactableSession(harness: Harness): Promise<void> {
	const now = Date.now();
	await harness.session.sessionWriter.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	await harness.session.sessionWriter.appendMessage(
		createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 100,
			timestamp: now - 500,
		}),
	);
}

/** Whether a log batch delivers a user message: a turn's delivery commit. */
function deliversUserMessage(batch: ConversationLogAppend): boolean {
	return batch.entries.some(
		(entry) =>
			entry.type === "message" && (entry.payload as { message?: { role?: string } }).message?.role === "user",
	);
}

function compactionEntries(harness: Harness) {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
}

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

/** An extension that supplies every compaction's summary, so compaction makes no provider request. */
function summaryExtension(summary: string): ExtensionFactory {
	return (volt) => {
		volt.on("session_before_compact", async (event) => ({
			compaction: {
				summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {},
			},
		}));
	};
}

/** A final response whose usage fills the model's context window: over the compaction threshold. */
function largeResponse(harness: Harness): AssistantMessage {
	return {
		...createAssistant(harness, { stopReason: "stop", totalTokens: harness.getModel().contextWindow }),
		content: [{ type: "text", text: "large response" }],
	};
}

/** A tool-call response over the compaction threshold: the turn would continue with its tool results. */
function largeToolCallResponse(harness: Harness): AssistantMessage {
	return {
		...createAssistant(harness, { stopReason: "toolUse", totalTokens: harness.getModel().contextWindow }),
		content: [fauxToolCall("read", { path: "large.txt" })],
	};
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: 999,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");

		expect(result.summary).toBe("summary from extension");
		expect(result.tokensBefore).toBe(999);
		expect(result.estimatedTokensAfter).toBe(
			estimateMessagesTokens(harness.session.messages) + estimateToolDefinitionTokens(harness.session.state.tools),
		);
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("does not install a dormant projection after manual compaction without continuation work", async () => {
		const harness = await createHarness({ extensionFactories: [summaryExtension("idle compaction summary")] });
		harnesses.push(harness);
		await seedCompactableSession(harness);

		await harness.session.compact();
		await harness.session.sessionWriter.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after idle compaction" }],
			timestamp: Date.now(),
		});
		let requestTexts: string[] = [];
		harness.setResponses([
			(context) => {
				requestTexts = (context.messages as AgentMessage[]).map(getMessageText);
				return fauxAssistantMessage("continued from canonical context");
			},
		]);

		await harness.control.continue();
		expect(requestTexts).toContain("after idle compaction");
	});

	it("fails a prompt whose delivery rolled back and runs the next prompt over the compacted context", async () => {
		const harness = await createHarness({
			log: "memory",
			seed: (seed) => seed.user("message to compact").assistant("compactable answer"),
			extensionFactories: [summaryExtension("manual retained summary")],
		});
		harnesses.push(harness);
		const clientMessageId = "rolled-back-before-compaction";
		harness.log!.failNext("rolled_back", deliversUserMessage);

		await expect(
			harness.session.prompt("rolled back before compaction", { clientMessageId, source: "rpc" }),
		).rejects.toThrow();
		expect(harness.sessionManager.getClientInput(clientMessageId)?.state).toBe("failed");
		expect(harness.control.hasPendingPrompt()).toBe(false);
		await harness.session.compact();

		const providerTexts: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTexts.push((context.messages as AgentMessage[]).map(getMessageText));
				return fauxAssistantMessage("committed after compaction");
			},
		]);
		await harness.session.prompt("after compaction", { clientMessageId: "after-compaction", source: "rpc" });

		expect(providerTexts).toHaveLength(1);
		expect(providerTexts[0]?.some((text) => text.includes("manual retained summary"))).toBe(true);
		expect(providerTexts[0]).toContain("after compaction");
		expect(providerTexts[0]).not.toContain("rolled back before compaction");
	});

	it("rejects invalid extension compaction details before appending", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "invalid extension summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { shared: new SharedArrayBuffer(1) } as never,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const leafId = harness.sessionManager.getLeafId();

		await expect(harness.session.compact()).rejects.toThrow("Extension session_before_compact output");
		expect(harness.sessionManager.getLeafId()).toBe(leafId);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness({ selectModel: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("rejects a too-small compaction before Harness provider admission", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.compact()).rejects.toThrow("Nothing to compact (session too small)");
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		await seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toBe("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("appends the canonical active plan checkpoint after compaction", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		await seedCompactableSession(harness);
		await harness.session.setAgentMode("plan");
		const draft = await harness.session.updatePlan({ steps: [{ text: "Finish after compaction" }] });
		const ready = await harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Compacted plan",
			summary: "Keep canonical state across compaction.",
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "compaction-execution",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		const active = harness.session.planningState.plan!;
		useSummaryStreamFn(harness, "summary with active plan");

		await harness.session.compact();

		const checkpoints = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "volt-plan-checkpoint");
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({
			content: expect.stringContaining(`Revision: ${active.revision}`),
			display: false,
		});
		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "custom",
			customType: "volt-plan-checkpoint",
		});
	});

	it("commits the compaction and its plan checkpoint in one batch", async () => {
		const harness = await createHarness({ withConfiguredAuth: false, log: "memory" });
		harnesses.push(harness);
		await seedCompactableSession(harness);
		await harness.session.setAgentMode("plan");
		const draft = await harness.session.updatePlan({ steps: [{ text: "Finish after compaction" }] });
		await harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Compacted plan",
			summary: "Keep canonical state across compaction.",
		});
		useSummaryStreamFn(harness, "summary with plan");
		const batches: string[][] = [];
		const hold = harness.log!.holdNext((batch) => {
			if (!batch.entries.some((entry) => entry.type === "compaction")) return false;
			batches.push(
				batch.entries.map((entry) =>
					entry.type === "custom_message" ? (entry.payload as { customType: string }).customType : entry.type,
				),
			);
			return true;
		});

		const compaction = harness.session.compact();
		await hold.started;
		// Neither half is visible before the batch commits.
		expect(compactionEntries(harness)).toEqual([]);
		hold.release();
		await compaction;

		expect(batches).toEqual([["compaction", "volt-plan-checkpoint"]]);
		expect(harness.session.messages.map((message) => message.role).slice(0, 1)).toEqual(["compactionSummary"]);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		await seedCompactableSession(harness);
		const getStreamCallCount = useSummaryResponses(harness, [
			largeResponse(harness),
			fauxAssistantMessage("auto summary from custom stream"),
		]);

		await harness.control.run(userMessage("over the threshold"));

		expect(compactionEntries(harness)).toHaveLength(1);
		expect(compactionEntries(harness)[0]).toMatchObject({
			summary: expect.stringContaining("auto summary from custom stream"),
		});
		expect(getStreamCallCount()).toBe(2);
	});

	it("preserves the session reasoning level for cache-preserving compaction", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			models: [{ id: "reasoning-model", reasoning: true }],
		});
		harnesses.push(harness);
		await seedCompactableSession(harness);
		// The session resolves its model from the log by id; the configured model carries the level map.
		Object.assign(harness.getModel(), {
			thinkingLevelMap: { off: "none", minimal: null, xhigh: "xhigh", max: "max" },
		});
		await harness.control.setThinkingLevel("xhigh");
		const reasoningLevels: Array<string | undefined> = [];
		useSummaryResponses(harness, [fauxAssistantMessage("minimal summary")], (options) => {
			reasoningLevels.push(options?.reasoning);
		});

		await harness.session.compact();

		expect(reasoningLevels).toEqual(["xhigh"]);
	});

	it("retries transient auto-compaction summarization failures", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		await seedCompactableSession(harness);
		const getCallCount = useSummaryResponses(harness, [
			largeResponse(harness),
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "overloaded", retryable: true, message: "service unavailable request-id=req_first" },
			}),
			fauxAssistantMessage("summary after retry"),
		]);

		await harness.control.run(userMessage("over the threshold"));

		expect(getCallCount()).toBe(3);
		expect(compactionEntries(harness)).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ reason: "threshold", aborted: false });
	});

	it("fails closed after transient auto-compaction retries are exhausted", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		await seedCompactableSession(harness);
		const getCallCount = useSummaryResponses(harness, [
			largeResponse(harness),
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "overloaded", retryable: true, message: "server is overloaded request-id=req_last" },
			}),
		]);

		await harness.control.run(userMessage("over the threshold"));

		expect(getCallCount()).toBe(4);
		expect(compactionEntries(harness)).toEqual([]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			aborted: false,
			willRetry: false,
			errorMessage: expect.stringMatching(/Summarization failed after 3 attempts.*request-id=req_last/),
		});
	});

	it("does not resume a proactively interrupted run after compaction exhaustion", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		await seedCompactableSession(harness);
		const getCallCount = useSummaryResponses(harness, [
			largeToolCallResponse(harness),
			fauxAssistantMessage("", {
				stopReason: "error",
				error: { kind: "overloaded", retryable: true, message: "service unavailable" },
			}),
		]);

		await harness.control.run(userMessage("read a large file"));

		// One tool-call request, then two summarization attempts; the interrupted turn never resumes.
		expect(getCallCount()).toBe(3);
		expect(harness.eventsOfType("compaction_start")).toMatchObject([{ reason: "threshold" }]);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			errorMessage: expect.stringContaining("Summarization failed after 2 attempts"),
		});
		expect(compactionEntries(harness)).toEqual([]);
	});

	it("does not resume a proactively interrupted run after compaction cancellation", async () => {
		const harness = await createHarness({
			withConfiguredAuth: false,
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		await seedCompactableSession(harness);
		const getCallCount = useSummaryResponses(harness, [largeToolCallResponse(harness)]);

		await harness.control.run(userMessage("read a large file"));

		expect(getCallCount()).toBe(1);
		expect(harness.eventsOfType("compaction_start")).toMatchObject([{ reason: "threshold" }]);
		expect(compactionEntries(harness)).toEqual([]);
	});

	it("excludes a stripped trailing error message from estimatedTokensAfter when retrying", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		await seedCompactableSession(harness);
		const overflow: AssistantMessage = {
			...createAssistant(harness, {
				stopReason: "error",
				error: { kind: "context_overflow", retryable: false, message: "prompt is too long" },
			}),
			content: [{ type: "text", text: "partial output ".repeat(50) }],
		};
		const estimates: (number | undefined)[] = [];
		let compactedMessages: AgentMessage[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end") {
				estimates.push(event.result?.estimatedTokensAfter);
				compactedMessages = [...harness.session.messages];
			}
		});
		let retried: AgentMessage[] = [];
		let calls = 0;
		harness.control.setStreamFn((model, context) => {
			calls++;
			if (calls === 3) retried = context.messages as AgentMessage[];
			const message: AssistantMessage =
				calls === 1
					? overflow
					: { ...fauxAssistantMessage(calls === 2 ? "overflow summary" : "continued after compaction") };
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					seq: 1,
					reason: "stop",
					message: { ...message, api: model.api, provider: model.provider, model: model.id },
				});
			});
			return stream;
		});

		await harness.control.run(userMessage("overflow this"));

		expect(harness.eventsOfType("compaction_end")).toMatchObject([{ reason: "overflow", willRetry: true }]);
		expect(calls).toBe(3);
		expect(
			retried.some(
				(message) => message.role === "assistant" && (message as AssistantMessage).stopReason === "error",
			),
		).toBe(false);
		const expectedRetained = compactedMessages.filter(
			(message) => !(message.role === "assistant" && (message as AssistantMessage).stopReason === "error"),
		);
		expect(estimates.at(-1)).toBe(
			estimateMessagesTokens(expectedRetained) + estimateToolDefinitionTokens(harness.session.state.tools),
		);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(volt) => {
					volt.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("resumes after threshold compaction when only host-queued messages exist", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [summaryExtension("auto compacted")],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		const requests: string[][] = [];
		harness.setResponses([
			async () => {
				await harness.control.queueFollowUp({
					role: "custom",
					customType: "test",
					content: [{ type: "text", text: "queued custom" }],
					display: false,
					timestamp: Date.now(),
				});
				return { ...largeResponse(harness), content: [{ type: "text", text: "three" }] };
			},
			(context) => {
				requests.push((context.messages as AgentMessage[]).map(getMessageText));
				return fauxAssistantMessage("after compaction");
			},
		]);

		await harness.session.prompt("third");
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("compaction_start")).toMatchObject([{ reason: "threshold" }]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.some((text) => text.includes("auto compacted"))).toBe(true);
		expect(requests[0]).toContain("queued custom");
	});

	it.each(["plain response", "stopping tool batch"] as const)(
		"stops for proactive compaction after a %s when a message is queued",
		async (kind) => {
			const harness = await createHarness({ extensionFactories: [summaryExtension("proactive summary")] });
			harnesses.push(harness);
			await seedCompactableSession(harness);
			if (kind === "stopping tool batch") harness.control.onToolResult(() => ({ disposition: "stop" }));
			const requests: string[][] = [];
			harness.setResponses([
				async () => {
					await harness.session.followUp("queued follow-up");
					return kind === "plain response"
						? { ...largeResponse(harness), content: [{ type: "text", text: "done" }] }
						: largeToolCallResponse(harness);
				},
				(context) => {
					requests.push((context.messages as AgentMessage[]).map(getMessageText));
					return fauxAssistantMessage("after compaction");
				},
			]);

			await harness.session.prompt("start");
			await harness.session.waitForIdle();

			expect(harness.eventsOfType("compaction_start")).toMatchObject([{ reason: "threshold" }]);
			expect(harness.eventsOfType("compaction_end")).toMatchObject([{ reason: "threshold", willRetry: true }]);
			expect(requests).toHaveLength(1);
			expect(requests[0]?.some((text) => text.includes("proactive summary"))).toBe(true);
			expect(requests[0]).toContain("queued follow-up");
		},
	);

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness({ extensionFactories: [summaryExtension("overflow summary")] });
		harnesses.push(harness);
		await seedCompactableSession(harness);
		const overflow = (): AssistantMessage =>
			createAssistant(harness, {
				stopReason: "error",
				error: { kind: "context_overflow", retryable: false, message: "prompt is too long" },
				timestamp: Date.now(),
			});
		harness.setResponses([overflow, overflow]);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) compactionErrors.push(event.errorMessage);
		});

		await harness.session.prompt("overflow twice");

		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness({
			seed: (seed) =>
				seed
					.user("before compaction", { id: "kept-user" })
					.assistant("stale", { usage: { input: 610_000, totalTokens: 610_000 } })
					.compaction({ firstKeptEntryId: "kept-user", tokensBefore: 610_000 }),
			extensionFactories: [summaryExtension("unexpected summary")],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answered")]);

		await harness.session.prompt("after compaction");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(compactionEntries(harness)).toHaveLength(1);
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness({
			seed: (seed) =>
				seed
					.user("hello")
					.assistant("large answer", { usage: { input: 190_000, totalTokens: 190_000 } })
					.user("retry")
					.assistant("", {
						stopReason: "error",
						error: { kind: "overloaded", retryable: true, message: "529 overloaded" },
					}),
			extensionFactories: [summaryExtension("error tail summary")],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answered")]);

		await harness.session.prompt("next");

		expect(harness.eventsOfType("compaction_start")).toMatchObject([{ reason: "threshold" }]);
		expect(compactionEntries(harness)).toHaveLength(1);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness({
			seed: (seed) =>
				seed.user("hello").assistant("", {
					stopReason: "error",
					error: { kind: "overloaded", retryable: true, message: "529 overloaded" },
				}),
			extensionFactories: [summaryExtension("unexpected summary")],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answered")]);

		await harness.session.prompt("next");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness({
			seed: (seed) =>
				seed
					.user("before compaction", { id: "kept-user" })
					.assistant("kept", { usage: { input: 190_000, totalTokens: 190_000 } })
					.compaction({ firstKeptEntryId: "kept-user", tokensBefore: 190_000 })
					.user("new prompt")
					.assistant("", {
						stopReason: "error",
						error: { kind: "overloaded", retryable: true, message: "529 overloaded" },
					}),
			extensionFactories: [summaryExtension("unexpected summary")],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answered")]);

		await harness.session.prompt("next");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);
		belowThresholdHarness.setResponses([
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000 }),
		]);
		disabledHarness.setResponses([createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000 })]);

		await belowThresholdHarness.session.prompt("below the threshold");
		await disabledHarness.session.prompt("compaction disabled");

		expect(belowThresholdHarness.eventsOfType("compaction_start")).toEqual([]);
		expect(disabledHarness.eventsOfType("compaction_start")).toEqual([]);
	});
});
