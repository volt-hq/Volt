import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamFn } from "@hansjm10/volt-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
} from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it } from "vitest";
import { maxComposedCheckpointChars } from "../../src/core/compaction/budget.ts";
import type { CompactionDetails } from "../../src/core/compaction/compaction.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { bashResultOperations } from "../utilities/session-reads.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()!.cleanupAsync();
});

async function harnessFor(options: Parameters<typeof createHarness>[0]): Promise<Harness> {
	const harness = await createHarness(options);
	harnesses.push(harness);
	return harness;
}

function usage(totalTokens: number) {
	return { input: totalTokens, totalTokens };
}

/** The latest compaction failure record the session wrote. */
async function failureRecord(harness: Harness): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(harness.tempDir, "debug", "compaction-latest.json"), "utf8"));
}

function compactions(harness: Harness) {
	return harness.sessionManager.getBranch().filter((entry) => entry.type === "compaction");
}

/** Tool calls without results, and results without calls, in a provider request. */
function unpairedToolIds(messages: readonly Message[]): string[] {
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) if (block.type === "toolCall") calls.add(block.id);
		} else if (message.role === "toolResult") {
			results.add(message.toolCallId);
		}
	}
	return [...calls].filter((id) => !results.has(id)).concat([...results].filter((id) => !calls.has(id)));
}

/** Answers summary requests (they carry a serialized or native checkpoint instruction) and turns separately. */
function routeRequests(
	harness: Harness,
	summary: (context: Context, maxTokens: number) => string,
	turn: (context: Context) => string,
	/** Usage the turn responses report, which automatic compaction measures. */
	turnTokens = 0,
): { summaries: Context[]; turns: Context[] } {
	const summaries: Context[] = [];
	const turns: Context[] = [];
	const streamFn: StreamFn = (model, context, options) => {
		const text = getMessageText(context.messages.at(-1));
		const isSummary =
			text.includes("Checkpoint rules:") || text.includes("Summary rules:") || text.includes("<conversation>");
		(isSummary ? summaries : turns).push(context);
		const response = fauxAssistantMessage(isSummary ? summary(context, options?.maxTokens ?? 4096) : turn(context));
		const message: AssistantMessage = {
			...response,
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...response.usage, ...(isSummary ? {} : usage(turnTokens)) },
		};
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", seq: 1, reason: "stop", message }));
		return stream;
	};
	harness.control.setStreamFn(streamFn);
	return { summaries, turns };
}

describe("compaction admission", () => {
	it("rejects an extension summary whose compacted context would not fit, keeping the branch", async () => {
		const oversized: ExtensionFactory = (volt) => {
			volt.on("session_before_compact", async (event) => ({
				compaction: {
					summary: "s".repeat(500_000),
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			}));
		};
		const harness = await harnessFor({
			extensionFactories: [oversized],
			seed: (seed) => seed.user("Original request").assistant("Answer"),
		});
		const entries = harness.sessionManager.getEntries();
		const leaf = harness.sessionManager.getLeafId();

		await expect(harness.session.compact()).rejects.toThrow(
			/Compacted context \(~[\d,]+ tokens\) and the 16,384-token response reserve would exceed the 128,000-token context window; original context was kept/,
		);
		expect(harness.sessionManager.getLeafId()).toBe(leaf);
		expect(harness.sessionManager.getEntries()).toEqual(entries);
		expect(await failureRecord(harness)).toMatchObject({
			phase: "admission",
			error: expect.stringContaining("original context was kept"),
			requests: [],
			budget: { contextWindow: 128_000, reserveTokens: 16_384, compactedTokens: expect.any(Number) },
		});
	});

	it("fails before any request when the messages it must keep cannot fit", async () => {
		const call = fauxToolCall("read", { path: "huge.log" });
		const harness = await harnessFor({
			settings: { compaction: { keepRecentTokens: 1 } },
			seed: (seed) =>
				seed
					.user("Earlier request")
					.assistant("Earlier answer")
					.user("Read the log")
					.assistant("", { toolCalls: [call] })
					// The newest indivisible exchange alone exceeds the 128k window.
					.toolResult(call.id, "x".repeat(600_000)),
		});
		const { summaries, turns } = routeRequests(
			harness,
			() => "never",
			() => "never",
		);
		const entries = harness.sessionManager.getEntries();

		await expect(harness.session.compact()).rejects.toThrow(
			/Compaction cannot fit the context window: the recent messages it must keep \(~[\d,]+ tokens\).*original context was kept/,
		);
		expect(summaries).toHaveLength(0);
		expect(turns).toHaveLength(0);
		expect(harness.sessionManager.getEntries()).toEqual(entries);
		expect(await failureRecord(harness)).toMatchObject({ phase: "preflight", requests: [] });
	});

	it("does not count bash output excluded from context toward the messages it must keep", async () => {
		const harness = await harnessFor({
			models: [{ id: "small", contextWindow: 32_768, maxTokens: 8192 }],
			settings: { compaction: { keepRecentTokens: 1 } },
			seed: (seed) => seed.user("Earlier request").assistant("Earlier answer"),
		});
		// `!!` output the model never sees is the newest exchange, so compaction keeps it.
		await harness.session.runUserBash("cat huge.log", {
			excludeFromContext: true,
			operations: bashResultOperations({ output: "x".repeat(50_000), exitCode: 0 }),
		});
		const { summaries } = routeRequests(
			harness,
			() => "Checkpoint",
			() => "never",
		);

		await harness.session.compact();
		expect(summaries.length).toBeGreaterThan(0);
		expect(compactions(harness)).toHaveLength(1);
	});

	it("bounds a split-turn checkpoint with its user messages, file lists and plan, and keeps tool exchanges valid", async () => {
		const harness = await harnessFor({ settings: { compaction: { keepRecentTokens: 1 } } });
		const writer = harness.session.sessionWriter;
		const model = harness.getModel();
		await writer.appendMessage({ role: "user", content: "Earlier request", timestamp: 1 });
		await writer.appendMessage({
			...fauxAssistantMessage("Earlier answer"),
			provider: model.provider,
			model: model.id,
		});
		await harness.session.setAgentMode("plan");
		const draft = await harness.session.updatePlan({ steps: [{ text: "Finish after compaction" }] });
		const ready = await harness.session.submitPlan({
			planId: draft.id,
			expectedRevision: draft.revision,
			title: "Compacted plan",
			summary: "Keep canonical state across compaction.",
		});
		await harness.session.activatePlan(ready.id, ready.revision, {
			id: "admission-execution",
			approvedRevision: ready.revision,
			strategy: "retain_context",
			sourceSessionId: harness.session.sessionId,
			targetSessionId: harness.session.sessionId,
		});
		await writer.appendMessage({
			role: "user",
			content: "Original goal: migrate every parser. Do not change the public API.",
			timestamp: 2,
		});
		// One long turn touching many files: the cut splits it.
		for (let batch = 0; batch < 20; batch++) {
			const calls = Array.from({ length: 20 }, (_, index) =>
				index % 2 === 0
					? fauxToolCall("read", { path: `src/parsers/read-${batch}-${index}.ts` })
					: fauxToolCall("edit", {
							path: `src/parsers/edited-${batch}-${index}.ts`,
							oldText: "sync",
							newText: "stream",
						}),
			);
			await writer.appendMessage({
				...fauxAssistantMessage(calls, { stopReason: "toolUse" }),
				provider: model.provider,
				model: model.id,
			});
			for (const call of calls) {
				await writer.appendMessage({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: `Done ${call.id}` }],
					isError: false,
					timestamp: 3,
				});
			}
		}
		// The newest exchange, with usage over the native preflight, stays verbatim.
		const last = fauxToolCall("read", { path: "src/parsers/final.ts" });
		const lastResponse = fauxAssistantMessage([last], { stopReason: "toolUse" });
		lastResponse.usage = { ...lastResponse.usage, ...usage(125_000) };
		await writer.appendMessage({ ...lastResponse, provider: model.provider, model: model.id });
		await writer.appendMessage({
			role: "toolResult",
			toolCallId: last.id,
			toolName: "read",
			content: [{ type: "text", text: "final contents" }],
			isError: false,
			timestamp: 4,
		});
		// Every summary request answers at exactly its character limit.
		const { summaries, turns } = routeRequests(
			harness,
			(_context, maxTokens) => "y".repeat(maxTokens * 4),
			() => "Continued",
		);

		const result = await harness.session.compact();
		const details = result.details as CompactionDetails;
		// The history first, then the long prefix in chronological chunks, all chunked: the native request cannot fit.
		const requests = details.requests?.map(({ strategy, purpose }) => `${strategy}:${purpose}`) ?? [];
		expect(requests[0]).toBe("chunked:history");
		expect(requests.length).toBeGreaterThan(1);
		expect(new Set(requests.slice(1))).toEqual(new Set(["chunked:turn_prefix"]));
		expect(summaries).toHaveLength(requests.length);
		expect(result.summary.length).toBeLessThanOrEqual(maxComposedCheckpointChars(model.contextWindow));
		expect(result.summary).toContain("(2) Original goal: migrate every parser. Do not change the public API.");
		expect(result.summary).toMatch(/\[\.\.\. \d+ more (modified|read) files omitted\]/);
		expect(details.modifiedFiles).toHaveLength(200);
		// The retained final read stays out of the summarized file operations.
		expect(details.readFiles).toHaveLength(200);
		expect(details.readFiles).not.toContain("src/parsers/final.ts");
		expect(compactions(harness)).toHaveLength(1);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "custom", customType: "volt-plan-checkpoint" });

		await harness.session.prompt("Continue");
		expect(turns).toHaveLength(1);
		const request = turns[0].messages;
		expect(getMessageText(request[0])).toContain("<user-messages>");
		expect(JSON.stringify(request)).toContain("final contents");
		expect(unpairedToolIds(request)).toEqual([]);
	});

	it("rejects an automatic compaction that would still reach the configured threshold", async () => {
		const harness = await harnessFor({
			settings: { retry: { enabled: false } },
			seed: (seed) => seed.user("Original request").assistant("Answer"),
		});
		const model = harness.getModel();
		harness.settingsManager.setCompactionThresholdTokens(`${model.provider}/${model.id}`, 30);
		routeRequests(
			harness,
			() => "Checkpoint",
			() => "Reply",
			1000,
		);
		const entries = harness.sessionManager.getEntries().length;

		await expect(harness.session.prompt("Next request")).rejects.toThrow(
			/Auto-compaction failed: Compacted context \(~[\d,]+ tokens\) would still reach the 30-token compaction threshold for faux\/faux-1; raise the threshold or lower compaction\.keepRecentTokens; original context was kept/,
		);
		expect(compactions(harness)).toHaveLength(0);
		expect(harness.sessionManager.getEntries().length).toBeGreaterThan(entries);
		expect(await failureRecord(harness)).toMatchObject({ phase: "admission", budget: { triggerTokens: 30 } });
	});

	it("holds an extension checkpoint that keeps an earlier boundary to the threshold", async () => {
		const keepEverything: ExtensionFactory = (volt) => {
			volt.on("session_before_compact", async (event) => ({
				compaction: {
					summary: "Extension checkpoint",
					// Keeps more than the allowance by choice: the prepared boundary keeps only the recent exchange.
					firstKeptEntryId: event.branchEntries.find((entry) => entry.type === "message")!.id,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			}));
		};
		const harness = await harnessFor({
			extensionFactories: [keepEverything],
			settings: { retry: { enabled: false }, compaction: { keepRecentTokens: 20 } },
			seed: (seed) =>
				seed
					.user(`older ask ${"x".repeat(200)}`)
					.assistant(`older answer ${"y".repeat(200)}`)
					.user("RECENT ASK")
					.assistant("recent answer"),
		});
		const model = harness.getModel();
		harness.settingsManager.setCompactionThresholdTokens(`${model.provider}/${model.id}`, 30);
		routeRequests(
			harness,
			() => "never",
			() => "Reply",
			1000,
		);

		await expect(harness.session.prompt("Next request")).rejects.toThrow(
			/Auto-compaction failed: Compacted context \(~[\d,]+ tokens\) would still reach the 30-token compaction threshold/,
		);
		expect(compactions(harness)).toHaveLength(0);
	});
});

describe("automatic compaction trigger", () => {
	async function astraHarness(responseTokens: number): Promise<Harness> {
		// openai-codex/gpt-6-astra's limits: the incident model.
		const harness = await harnessFor({
			models: [{ id: "astra", contextWindow: 272_000, maxTokens: 128_000, reasoning: true }],
			settings: { compaction: { keepRecentTokens: 1 } },
			seed: (seed) =>
				seed.user("Original request", { timestamp: 1 }).assistant("Large answer", { usage: usage(responseTokens) }),
		});
		await harness.session.setThinkingLevel("high");
		return harness;
	}

	it("compacts natively before the context leaves too little room for the native request", async () => {
		// Above the new trigger (272,000 - 16,384 reserve - 23,040 native allowance) but below the old one.
		const harness = await astraHarness(240_000);
		const { summaries } = routeRequests(
			harness,
			() => "Native checkpoint",
			() => "After the checkpoint",
		);
		await harness.session.prompt("Next request");
		expect(summaries).toHaveLength(1);
		const end = harness.eventsOfType("compaction_end").at(-1);
		expect(end).toMatchObject({ reason: "threshold", aborted: false });
		expect((end?.result?.details as CompactionDetails).requests).toMatchObject([
			{ strategy: "native", purpose: "native", stopReason: "stop" },
		]);
	});

	it("does not compact below the trigger", async () => {
		const harness = await astraHarness(230_000);
		const { summaries, turns } = routeRequests(
			harness,
			() => "never",
			() => "Reply",
		);
		await harness.session.prompt("Next request");
		expect(summaries).toHaveLength(0);
		expect(turns).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});
});

describe("drift across repeated compactions", () => {
	it("keeps the user's earlier messages verbatim, excluding the ones it retains", async () => {
		const harness = await harnessFor({
			settings: { compaction: { keepRecentTokens: 20 } },
			seed: (seed) =>
				seed
					.user(`older ask ${"x".repeat(200)}`)
					.assistant(`older answer ${"y".repeat(200)}`)
					.user("RECENT ASK")
					.assistant("recent answer"),
		});
		routeRequests(
			harness,
			() => "Checkpoint.",
			() => "Reply",
		);
		const result = await harness.session.compact();
		const record = /<user-messages>[\s\S]*<\/user-messages>/.exec(result.summary)?.[0] ?? "";
		expect(record).toContain("(1) older ask xxx");
		expect(record).not.toContain("RECENT ASK");
		expect(harness.session.messages.slice(1).map(getMessageText)).toEqual(["RECENT ASK", "recent answer"]);
	});

	it("keeps the goal, an early constraint and the latest correction after five compactions that forget everything", async () => {
		const harness = await harnessFor({ settings: { compaction: { keepRecentTokens: 1 } } });
		// The summarizer keeps nothing: only the host's own record can carry the conversation forward.
		const { summaries, turns } = routeRequests(
			harness,
			() => "Checkpoint.",
			(context) => `Reply to ${getMessageText(context.messages.at(-1)).slice(0, 40)}`,
		);
		await harness.session.prompt("GOAL: migrate the config parser to streaming input.");
		await harness.session.prompt("CONSTRAINT: never change the synchronous parseConfig(source) signature.");
		for (let round = 1; round <= 5; round++) {
			await harness.session.prompt(`Work item ${round}: continue the migration.`);
			if (round === 4) await harness.session.prompt("CORRECTION: store fixtures as JSONL, not JSON files.");
			await harness.session.compact();
		}
		expect(compactions(harness)).toHaveLength(5);
		expect(summaries).toHaveLength(5);

		await harness.session.prompt("What should happen next?");
		const request = turns.at(-1)!.messages;
		const checkpoint = getMessageText(request[0]);
		expect(checkpoint).toContain("Checkpoint.");
		expect(checkpoint).toContain("GOAL: migrate the config parser to streaming input.");
		expect(checkpoint).toContain("CONSTRAINT: never change the synchronous parseConfig(source) signature.");
		expect(checkpoint).toContain("CORRECTION: store fixtures as JSONL, not JSON files.");
		expect(checkpoint).toContain("Work item 5: continue the migration.");
		// The latest compaction's summarizer request also saw the earlier checkpoint's record.
		expect(JSON.stringify(summaries.at(-1))).toContain("GOAL: migrate the config parser");
	});
});
