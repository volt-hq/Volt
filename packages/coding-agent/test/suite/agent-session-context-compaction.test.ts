import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type CompactionDetails, prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length) await harnesses.pop()!.cleanupAsync();
});

/** The message of a seeded message entry. */
function seededMessage(harness: Harness, entryId: string): AgentMessage {
	const entry = harness.sessionManager.getEntry(entryId);
	if (entry?.type !== "message") throw new Error(`Expected message entry ${entryId}`);
	return entry.message;
}

describe("AgentSession cache-preserving compaction", () => {
	it("preserves the provider prefix and policy while persisting compaction request usage and diagnostics", async () => {
		// The prior compaction is seeded before the session opens; a live session refuses structural writes.
		const harness = await createHarness({
			log: "sqlite",
			seed: (seed) =>
				seed
					.user("Early goal", { timestamp: 1 })
					.compaction({ summary: "PRIOR-ONLY-CONSTRAINT", tokensBefore: 580_000 })
					.user(`OLD-SOURCE-START\n${"native source content\n".repeat(28_000)}\nOLD-SOURCE-END`, { timestamp: 2 }),
			models: [{ id: "large", reasoning: true, contextWindow: 1_000_000, maxTokens: 32_768 }],
			settings: { compaction: { keepRecentTokens: 1 }, retry: { provider: { maxRetries: 9 } } },
			extensionFactories: [
				(volt) => {
					volt.on("before_agent_start", () => ({ systemPrompt: "EXTENSION SYSTEM" }));
					volt.on("context", (event) => ({
						messages: event.messages.map((message) =>
							message.role === "user"
								? {
										...message,
										content:
											typeof message.content === "string"
												? `${message.content} [context hook]`
												: message.content,
									}
								: message,
						),
					}));
				},
			],
		});
		harnesses.push(harness);
		await harness.session.setSessionName("compaction test");
		await harness.session.setThinkingLevel("high");
		harness.session.setTransport("sse");
		await harness.session.setFastModeEnabled(true);
		let normal: Context | undefined;
		let normalOptions: SimpleStreamOptions | undefined;
		harness.setResponses([
			(context, options) => {
				normal = context;
				normalOptions = options as SimpleStreamOptions;
				return fauxAssistantMessage("Recent answer retained verbatim");
			},
		]);
		await harness.session.prompt("Latest request");
		const savedEntries = harness.sessionManager.getEntries();
		const retainedEntry = harness.sessionManager.getLeafEntry()!;
		const latestAssistant = harness.session.messages.at(-1)!;
		expect(retainedEntry).toMatchObject({ type: "message", message: latestAssistant });
		let summaryCalls = 0;
		const diagnostics = [
			{
				type: "codex_request",
				timestamp: 123,
				details: { payload: { sha256: "a".repeat(64) }, transport: { sseAttempts: 1 } },
			},
		];
		harness.setResponses([
			(context, rawOptions) => {
				summaryCalls++;
				const options = rawOptions as SimpleStreamOptions;
				expect(context.systemPrompt).toBe(normal!.systemPrompt);
				expect(context.tools).toEqual(normal!.tools);
				expect(context.messages.slice(0, -1)).toEqual([...normal!.messages, latestAssistant]);
				expect(JSON.stringify(context.messages)).toContain("PRIOR-ONLY-CONSTRAINT");
				expect(JSON.stringify(context.messages)).toContain("OLD-SOURCE-END");
				expect(context.messages.at(-1)?.role).toBe("user");
				const instruction = getMessageText(context.messages.at(-1));
				expect(instruction).toContain("Summary scope:");
				expect(instruction).toContain("last 1 saved conversation messages");
				expect(instruction).toContain("Additional focus: Preserve the deadline");
				expect(instruction).not.toContain("[context hook]");
				expect(options).toMatchObject({
					maxTokens: 4096,
					maxRetries: 0,
					reasoning: normalOptions!.reasoning,
					sessionId: normalOptions!.sessionId,
					transport: "sse",
					inferenceSpeed: "fast",
				});
				for (const message of context.messages) expect(message).not.toHaveProperty("diagnostics");
				const message = fauxAssistantMessage("## Goal\nPRIOR-ONLY-CONSTRAINT\nPreserve the current task");
				message.diagnostics = diagnostics;
				return message;
			},
		]);
		const result = await harness.session.compact("Preserve the deadline");
		expect(summaryCalls).toBe(1);
		expect(result.summary).toContain("PRIOR-ONLY-CONSTRAINT");
		expect(result.firstKeptEntryId).toBe(retainedEntry.id);
		expect(harness.session.messages.slice(1)).toEqual([latestAssistant]);
		expect(harness.sessionManager.getEntries().slice(0, savedEntries.length)).toEqual(savedEntries);
		const details = result.details as CompactionDetails;
		expect(details.requests).toEqual([
			{
				strategy: "native",
				attempt: 1,
				provider: harness.getModel().provider,
				model: "large",
				startedAt: expect.any(Number),
				timeToFirstEventMs: expect.any(Number),
				timeToFirstTextMs: expect.any(Number),
				durationMs: expect.any(Number),
				stopReason: "stop",
				usage: {
					input: expect.any(Number),
					output: expect.any(Number),
					cacheRead: expect.any(Number),
					cacheWrite: expect.any(Number),
					totalTokens: expect.any(Number),
				},
				diagnostics,
			},
		]);
		expect(details.requests?.[0].usage?.cacheRead).toBeGreaterThan(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.result?.details).toEqual(details);
		const savedDetails = structuredClone(details);
		diagnostics[0].details.transport.sseAttempts = 99;
		expect(details).toEqual(savedDetails);
		harness.setResponses([
			(context) => {
				for (const message of context.messages) expect(message).not.toHaveProperty("diagnostics");
				expect(JSON.stringify(context)).not.toContain(diagnostics[0].details.payload.sha256);
				expect(JSON.stringify(context)).not.toContain("codex_request");
				return fauxAssistantMessage("Continued after compaction");
			},
		]);
		await harness.session.prompt("Continue the current task");
		const reopened = await SessionManager.openReadOnly(harness.sessionManager.getSessionRef()!);
		try {
			expect(
				reopened
					.getBranch()
					.filter((entry) => entry.type === "compaction")
					.at(-1),
			).toMatchObject({
				summary: result.summary,
				firstKeptEntryId: retainedEntry.id,
				details,
			});
			expect(reopened.getEntry(retainedEntry.id)).toEqual(retainedEntry);
			expect(reopened.getConversationState().context.messages[1]).toEqual(latestAssistant);
			// Usage and diagnostics stay host metadata, not part of the synthetic summary or provider context.
			expect(reopened.getConversationState().context.messages[0]).toEqual({
				role: "compactionSummary",
				summary: result.summary,
				tokensBefore: result.tokensBefore,
				timestamp: expect.any(Number),
			});
		} finally {
			await reopened.closePersistence();
		}
	});

	it.each(["preflight", "provider"] as const)(
		"carries a previous checkpoint through a split-turn %s fallback with no complete history turns",
		async (overflow) => {
			const constraint = "Keep the public API unchanged; deployment is not authorized.";
			const retainedId = "retained";
			// The previous checkpoint keeps the current turn's user message; it is seeded before the session opens.
			const harness = await createHarness({
				models: [
					{
						id: "summary",
						reasoning: true,
						contextWindow: overflow === "preflight" ? 16_384 : 1_000_000,
						maxTokens: 32_768,
					},
				],
				settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
				seed: (seed) =>
					seed
						.user(constraint, { timestamp: 1 })
						.user("Continue the implementation", { timestamp: 2 })
						.compaction({ summary: constraint, tokensBefore: 50_000 })
						.assistant("Investigating the implementation. ".repeat(100))
						.assistant("Next implementation step", { id: retainedId }),
			});
			harnesses.push(harness);
			await harness.session.setSessionName("repeated split compaction");
			await harness.session.setThinkingLevel("high");
			const retained = seededMessage(harness, retainedId);
			const entriesBefore = harness.sessionManager.getEntries();
			const preparation = prepareCompaction(
				harness.sessionManager.getBranch(),
				harness.sessionManager.getConversationState().context.messages,
				harness.settingsManager.getCompactionSettings(),
			);
			expect(preparation).toMatchObject({
				previousSummary: constraint,
				isSplitTurn: true,
				messagesToSummarize: [],
				firstKeptEntryId: retainedId,
			});
			let historyRequests = 0;
			let prefixRequests = 0;
			const summarize = (context: Context) => {
				const prompt = getMessageText(context.messages.at(-1));
				if (prompt.includes("<previous-summary>")) {
					historyRequests++;
					expect(prompt).toContain(constraint);
					return fauxAssistantMessage(`## Constraints & Preferences\n${constraint}`);
				}
				prefixRequests++;
				expect(prompt).toContain("Continue the implementation");
				return fauxAssistantMessage("## Context for Suffix\nImplementation remains unfinished.");
			};
			if (overflow === "provider") {
				harness.setResponses([
					fauxAssistantMessage("", {
						stopReason: "error",
						error: {
							kind: "context_overflow",
							retryable: false,
							message: "Your input exceeds the context window of this model",
						},
					}),
				]);
			}
			harness.faux.setSimpleResponses([summarize, summarize]);
			const result = await harness.session.compact();
			expect(historyRequests).toBe(1);
			expect(prefixRequests).toBe(1);
			expect(result.summary).toContain(constraint);
			expect(result.summary).toContain("Implementation remains unfinished.");
			expect(result.firstKeptEntryId).toBe(retainedId);
			expect(harness.session.messages.slice(1)).toEqual([retained]);
			expect(harness.sessionManager.getEntries().slice(0, entriesBefore.length)).toEqual(entriesBefore);
			expect((result.details as CompactionDetails).requests?.map((request) => request.strategy)).toEqual([
				...(overflow === "provider" ? ["native"] : []),
				"chunked",
				"chunked",
			]);
			harness.setResponses([
				(context) => {
					expect(getMessageText(context.messages[0])).toContain(constraint);
					return fauxAssistantMessage("Continue without changing the API or deploying.");
				},
			]);
			await harness.session.prompt("Continue");
		},
	);

	it("persists normal request diagnostics for comparison after reopening the session", async () => {
		const harness = await createHarness({ log: "sqlite" });
		harnesses.push(harness);
		await harness.session.setSessionName("normal request diagnostics test");
		const response = fauxAssistantMessage("Normal reply");
		response.diagnostics = [
			{
				type: "codex_request",
				timestamp: 123,
				details: { transport: "websocket", requestMode: "delta", hashes: { inputItems: ["b".repeat(64)] } },
			},
		];
		harness.setResponses([response]);
		await harness.session.prompt("Warm the prefix");
		const reopened = await SessionManager.openReadOnly(harness.sessionManager.getSessionRef()!);
		try {
			expect(reopened.getConversationState().context.messages.at(-1)).toMatchObject({
				role: "assistant",
				diagnostics: response.diagnostics,
			});
		} finally {
			await reopened.closePersistence();
		}
	});

	it.each(["length", "toolUse", "empty"] as const)(
		"keeps the original branch intact after a %s summary",
		async (failure) => {
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 1 } },
				seed: (log) => log.user("Original request", { timestamp: 1 }).assistant("Recent answer"),
			});
			harnesses.push(harness);
			await harness.session.setSessionName("compaction test");
			const entries = harness.sessionManager.getEntries();
			const leaf = harness.sessionManager.getLeafId();
			harness.setResponses([
				failure === "toolUse"
					? fauxAssistantMessage([fauxToolCall("bash", { command: "must never execute" })], {
							stopReason: "toolUse",
						})
					: fauxAssistantMessage(failure === "empty" ? "" : "partial summary", {
							stopReason: failure === "length" ? "length" : "stop",
						}),
			]);
			await expect(harness.session.compact()).rejects.toThrow();
			const record = JSON.parse(await readFile(join(harness.tempDir, "debug", "compaction-latest.json"), "utf8"));
			expect(record).toMatchObject({
				sessionId: harness.sessionManager.getSessionId(),
				error: expect.any(String),
				phase: "after native request 1 finished",
				requests: [{ strategy: "native", attempt: 1, durationMs: expect.any(Number) }],
			});
			expect(harness.sessionManager.getLeafId()).toBe(leaf);
			expect(harness.sessionManager.getEntries()).toEqual(entries);
			expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
			expect(harness.session.isCompacting).toBe(false);
		},
	);

	it("uses the same one-pass path for automatic compaction", async () => {
		// The saved response's usage is over the threshold (128k window less the 16k reserve), so the
		// next prompt's turn compacts before its first request.
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			seed: (seed) =>
				seed
					.user("Original", { timestamp: 1 })
					.assistant("recent", { usage: { input: 120_000, totalTokens: 120_000 } }),
		});
		harnesses.push(harness);
		let calls = 0;
		let promptContext: Context | undefined;
		harness.setResponses([
			(context) => {
				calls++;
				expect(context.tools).toBeDefined();
				expect(JSON.stringify(context.messages)).not.toContain("Next request");
				return fauxAssistantMessage("automatic checkpoint");
			},
			(context) => {
				promptContext = context;
				return fauxAssistantMessage("after the checkpoint");
			},
		]);
		await harness.session.prompt("Next request");
		expect(calls).toBe(1);
		expect(getMessageText(promptContext?.messages[0])).toContain("automatic checkpoint");
		expect(getMessageText(promptContext?.messages.at(-1))).toBe("Next request");
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			result: {
				summary: "automatic checkpoint",
				details: {
					requests: [
						{
							strategy: "native",
							attempt: 1,
							stopReason: "stop",
							usage: { input: expect.any(Number), cacheRead: expect.any(Number) },
						},
					],
				},
			},
		});
	});

	it.each(["rewrite", "filter"] as const)(
		"passes full history through the context hook once when it performs a %s",
		async (transformation) => {
			const hookInputs: AgentMessage[][] = [];
			let hookOutput: AgentMessage[] | undefined;
			const harness = await createHarness({
				settings: { compaction: { keepRecentTokens: 12 } },
				extensionFactories: [
					(volt) => {
						volt.on("context", (event) => {
							hookInputs.push(structuredClone(event.messages));
							const messages =
								transformation === "filter"
									? event.messages.filter((message) => message.role !== "assistant")
									: event.messages;
							if (transformation === "rewrite") {
								for (const message of messages) {
									const text = `HOOK-REWRITE: ${getMessageText(message).replaceAll("RAW-RETAINED", "REDACTED")}`;
									if (message.role === "user") message.content = text;
									else if (message.role === "assistant") message.content = [{ type: "text", text }];
								}
							}
							hookOutput = structuredClone(messages);
							return { messages };
						});
					},
				],
			});
			harnesses.push(harness);
			await harness.session.sessionWriter.appendMessage({
				role: "user",
				content: "Older goal ".repeat(100),
				timestamp: 1,
			});
			await harness.session.sessionWriter.appendMessage(fauxAssistantMessage("Older answer"));
			const firstKeptEntryId = await harness.session.sessionWriter.appendMessage({
				role: "user",
				content: "RAW-RETAINED-REQUEST",
				timestamp: 2,
			});
			await harness.session.sessionWriter.appendMessage(fauxAssistantMessage("RAW-RETAINED-ANSWER"));
			const savedEntries = harness.sessionManager.getEntries();
			const originalHistory = harness.sessionManager.getConversationState().context.messages;
			let calls = 0;
			harness.setResponses([
				(context) => {
					calls++;
					expect(context.messages.slice(0, -1)).toEqual(convertToLlm(hookOutput!));
					expect(context.messages.slice(0, -1)).toHaveLength(transformation === "filter" ? 2 : 4);
					expect(context.messages.at(-1)?.role).toBe("user");
					const instruction = getMessageText(context.messages.at(-1));
					expect(instruction).toContain("Summary scope:");
					expect(instruction).toContain("last 2 saved conversation messages");
					if (transformation === "rewrite") {
						expect(instruction).toContain("Retained suffix starts with");
						expect(instruction).toContain("HOOK-REWRITE: REDACTED-REQUEST");
						expect(instruction).toContain("HOOK-REWRITE: REDACTED-ANSWER");
						expect(JSON.stringify(context)).not.toContain("RAW-RETAINED");
					} else {
						expect(instruction).toContain("no exact boundary excerpt is available");
						expect(instruction).not.toContain("Retained suffix starts with");
						expect(JSON.stringify(context)).not.toContain("RAW-RETAINED-ANSWER");
					}
					return fauxAssistantMessage("hook checkpoint");
				},
			]);
			const result = await harness.session.compact();
			expect(calls).toBe(1);
			expect(hookInputs).toEqual([originalHistory]);
			expect(result.firstKeptEntryId).toBe(firstKeptEntryId);
			expect(harness.session.messages.slice(1)).toEqual(originalHistory.slice(-2));
			expect(harness.sessionManager.getEntries().slice(0, savedEntries.length)).toEqual(savedEntries);
		},
	);

	it("keeps retained-only file operations out of the checkpoint despite including them in the native request", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		await harness.session.sessionWriter.appendMessage({
			role: "user",
			content: "Inspect and update files",
			timestamp: 1,
		});
		for (const calls of [
			[
				fauxToolCall("read", { path: "older-read.ts" }),
				fauxToolCall("edit", { path: "older-edit.ts", oldText: "before", newText: "after" }),
			],
			[
				fauxToolCall("read", { path: "retained-read.ts" }),
				fauxToolCall("write", { path: "retained-write.ts", content: "new file" }),
			],
		]) {
			await harness.session.sessionWriter.appendMessage(fauxAssistantMessage(calls, { stopReason: "toolUse" }));
			for (const call of calls) {
				await harness.session.sessionWriter.appendMessage({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: `Saved ${call.name} result` }],
					isError: false,
					timestamp: 2,
				});
			}
		}
		const savedEntries = harness.sessionManager.getEntries();
		const retainedEntry = harness.sessionManager.getBranch().at(-3)!;
		const originalHistory = harness.sessionManager.getConversationState().context.messages;
		let calls = 0;
		harness.setResponses([
			(context) => {
				calls++;
				expect(context.messages.slice(0, -1)).toEqual(convertToLlm([...originalHistory]));
				expect(getMessageText(context.messages.at(-1))).toContain("last 3 saved conversation messages");
				return fauxAssistantMessage("file checkpoint");
			},
		]);
		const result = await harness.session.compact();
		expect(calls).toBe(1);
		expect(result.firstKeptEntryId).toBe(retainedEntry.id);
		expect(result.details).toMatchObject({ readFiles: ["older-read.ts"], modifiedFiles: ["older-edit.ts"] });
		expect(result.summary).toBe(
			"file checkpoint\n\n<read-files>\nolder-read.ts\n</read-files>\n\n<modified-files>\nolder-edit.ts\n</modified-files>",
		);
		expect(harness.session.messages.slice(1)).toEqual(originalHistory.slice(-3));
		expect(harness.sessionManager.getEntries().slice(0, savedEntries.length)).toEqual(savedEntries);
		expect(harness.eventsOfType("tool_execution_start")).toHaveLength(0);
	});

	it("includes the split-turn suffix while ignoring empty branch summaries when locating the retained tail", async () => {
		const retainedEntryId = "retained";
		// The empty branch summary is seeded before the session opens; a live session refuses structural writes.
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			seed: (seed) =>
				seed
					.user("Original turn", { timestamp: 1 })
					.branchSummary("")
					.assistant("EARLY-PREFIX-CONTEXT")
					.assistant("RETAINED-SUFFIX", { id: retainedEntryId }),
		});
		harnesses.push(harness);
		const originalHistory = harness.sessionManager.getConversationState().context.messages;
		const preparation = prepareCompaction(
			harness.sessionManager.getBranch(),
			harness.sessionManager.getConversationState().context.messages,
			harness.settingsManager.getCompactionSettings(),
		);
		expect(preparation?.isSplitTurn).toBe(true);
		let calls = 0;
		harness.setResponses([
			(context) => {
				calls++;
				expect(context.messages.slice(0, -1)).toEqual(convertToLlm([...originalHistory]));
				expect(JSON.stringify(context.messages.slice(0, -1))).toContain("EARLY-PREFIX-CONTEXT");
				expect(context.messages.at(-2)).toEqual(originalHistory.at(-1));
				const instruction = getMessageText(context.messages.at(-1));
				expect(instruction).toContain("Summary scope:");
				expect(instruction).toContain("last 1 saved conversation messages");
				expect(instruction).toContain("Retained suffix starts with");
				expect(instruction).toContain(JSON.stringify("[Assistant]: RETAINED-SUFFIX"));
				return fauxAssistantMessage("split checkpoint");
			},
		]);
		const result = await harness.session.compact();
		expect(calls).toBe(1);
		expect(result.firstKeptEntryId).toBe(retainedEntryId);
		expect(harness.session.messages.slice(1)).toEqual(originalHistory.slice(-1));
	});
});
