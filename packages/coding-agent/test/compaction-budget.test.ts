import type { AgentMessage } from "@hansjm10/volt-agent-core";
import { type AssistantMessage, type Context, fauxAssistantMessage, type Model, type Usage } from "@hansjm10/volt-ai";
import { describe, expect, it } from "vitest";
import {
	CHECKPOINT_MAX_CHARS,
	checkpointMaxTokens,
	checkpointTargetChars,
	compactionResponseReserve,
	compactionTriggerReserve,
	fileListsMaxChars,
	hostBlocksMaxChars,
	installedCheckpointTokens,
	maxComposedCheckpointChars,
	maxInstalledCheckpointTokens,
	NATIVE_INSTRUCTION_TOKENS,
	nativeCompactionAllowance,
	reasoningAllowanceTokens,
	splitCheckpointTokens,
	userMessagesMaxChars,
} from "../src/core/compaction/budget.ts";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateMessagesTokens,
	estimateRequestTokens,
	prepareCompaction,
	shouldCompact,
} from "../src/core/compaction/compaction.ts";
import { nativeCheckpointInstruction, nativeSummaryScope } from "../src/core/compaction/context-compaction.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";

/** The incident model: openai-codex/gpt-6-astra's catalog limits. */
const astra: Model<"openai-codex-responses"> = {
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://test.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 272_000,
	maxTokens: 128_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function usage(totalTokens: number): Usage {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(text: string, totalTokens: number, timestamp: number): AssistantMessage {
	const message = fauxAssistantMessage(text, { timestamp });
	message.usage = usage(totalTokens);
	return message;
}

describe("compaction budgets", () => {
	it("triggers early enough at incident-like sizes for the native request to fit", () => {
		const allowance = nativeCompactionAllowance(astra, "xhigh");
		// 4,096 output + 16,384 reasoning (xhigh budgets as high) + instruction + margin.
		expect(allowance).toBe(4096 + 16_384 + NATIVE_INSTRUCTION_TOKENS + 1024);
		const reserve = compactionTriggerReserve(astra, DEFAULT_COMPACTION_SETTINGS.reserveTokens, "xhigh");
		expect(reserve).toBe(DEFAULT_COMPACTION_SETTINGS.reserveTokens + allowance);
		const settings = { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: reserve };
		const trigger = astra.contextWindow - reserve;
		expect(shouldCompact(trigger, astra.contextWindow, settings)).toBe(false);
		expect(shouldCompact(trigger + 1, astra.contextWindow, settings)).toBe(true);
		// The largest context that does not trigger still fits the native request with its allowance.
		expect(trigger + allowance).toBeLessThanOrEqual(astra.contextWindow);
		// The incident compacted at ~265,000 estimated tokens, past the native fit; the new trigger fires before it.
		expect(265_095).toBeGreaterThan(trigger);
		expect(265_095 + allowance).toBeGreaterThan(astra.contextWindow);
	});

	it("never moves the trigger below half of a small window", () => {
		const small = { ...astra, contextWindow: 32_768 };
		expect(compactionTriggerReserve(small, 16_384, "high")).toBe(16_384);
		const medium = { ...astra, contextWindow: 65_536 };
		expect(compactionTriggerReserve(medium, 16_384, "high")).toBe(32_768);
		expect(compactionTriggerReserve({ ...astra, contextWindow: 0 }, 16_384, "high")).toBe(16_384);
		expect(compactionTriggerReserve({ ...astra, reasoning: false }, 16_384, "high")).toBe(
			16_384 + 4096 + NATIVE_INSTRUCTION_TOKENS + 1024,
		);
	});

	it("budgets reasoning per level, honoring configured budgets", () => {
		expect(reasoningAllowanceTokens("off")).toBe(0);
		expect(reasoningAllowanceTokens("minimal")).toBe(1024);
		expect(reasoningAllowanceTokens("medium")).toBe(8192);
		expect(reasoningAllowanceTokens("max")).toBe(16_384);
		expect(reasoningAllowanceTokens("xhigh", { high: 4000 })).toBe(4000);
	});

	it("tightens correction targets and splits split-turn budgets 75/25", () => {
		expect([0, 1, 2, 3].map((correction) => checkpointTargetChars(CHECKPOINT_MAX_CHARS, correction))).toEqual([
			9830, 6553, 4096, 4096,
		]);
		expect(splitCheckpointTokens(4096)).toEqual({ history: 3072, turnPrefix: 1024 });
	});

	it("keeps the full limits on normal windows and scales them down for small ones", () => {
		expect(checkpointMaxTokens(272_000)).toBe(4096);
		expect(checkpointMaxTokens(16_384)).toBe(1638);
		expect(checkpointMaxTokens(2048)).toBe(512);
		expect(userMessagesMaxChars(272_000)).toBe(16_384);
		expect(userMessagesMaxChars(128_000)).toBe(10_240);
		expect(userMessagesMaxChars(4096)).toBe(1024);
		expect(fileListsMaxChars(272_000)).toBe(8192);
		expect(fileListsMaxChars(16_384)).toBe(3276);
		expect(hostBlocksMaxChars(272_000)).toBe(16_384 + 8192);
		expect(hostBlocksMaxChars(16_384)).toBe(userMessagesMaxChars(16_384) + fileListsMaxChars(16_384));
		expect(maxComposedCheckpointChars(272_000)).toBe(16_384 + 16_384 + 8192 + 512);
		expect(maxInstalledCheckpointTokens(272_000)).toBeLessThan(11_000);
		// Even a small window keeps room for the conversation itself.
		expect(maxInstalledCheckpointTokens(16_384)).toBeLessThan(16_384 * 0.25);
		for (const contextWindow of [2048, 4096, 8192]) {
			expect(maxInstalledCheckpointTokens(contextWindow)).toBeLessThan(contextWindow * 0.5);
		}
		expect(compactionResponseReserve(16_384, 16_384)).toBe(8192);
		expect(compactionResponseReserve(272_000, 16_384)).toBe(16_384);
	});

	it("shares one host-block minimum on small windows instead of one per block", () => {
		// The user-message record keeps its 1,024-character minimum; the file lists get what is left.
		expect(userMessagesMaxChars(2048)).toBe(1024);
		expect(fileListsMaxChars(2048)).toBe(408);
		expect(hostBlocksMaxChars(2048)).toBe(1024);
		// The record's and the file lists' shares: 324 + 816 characters.
		expect(hostBlocksMaxChars(4096)).toBe(324 + 816);
		expect(maxComposedCheckpointChars(2048)).toBe(2048 + 1024 + 512);
	});

	it("counts the host-owned blocks at their size and the generated text at its limit", () => {
		const generatedChars = checkpointMaxTokens(16_384) * 4;
		expect(installedCheckpointTokens(16_384, 0)).toBeGreaterThan(generatedChars / 4);
		expect(installedCheckpointTokens(16_384, 400) - installedCheckpointTokens(16_384, 0)).toBe(100);
		expect(installedCheckpointTokens(16_384, hostBlocksMaxChars(16_384))).toBe(maxInstalledCheckpointTokens(16_384));
	});

	it("reserves enough for the longest native instruction, boundary excerpt included", () => {
		const awkward = '"\n'.repeat(2000);
		const source: Context = {
			messages: [
				{ role: "user", content: "older", timestamp: 1 },
				{ role: "user", content: awkward, timestamp: 2 },
				{ role: "user", content: awkward, timestamp: 3 },
			],
		};
		const instruction = nativeCheckpointInstruction(
			{ targetChars: 99_999, maxChars: 99_999, correction: { observedChars: 99_999 } },
			nativeSummaryScope(source, source.messages.length, 2),
		);
		expect(instruction.length).toBeLessThanOrEqual(NATIVE_INSTRUCTION_TOKENS * 4);
	});
});

describe("estimateRequestTokens", () => {
	it("anchors on the latest usage and estimates later messages", () => {
		const later: AgentMessage = { role: "user", content: "x".repeat(400), timestamp: 3 };
		const messages: AgentMessage[] = [
			{ role: "user", content: "first", timestamp: 1 },
			assistant("reply", 50_000, 2),
			later,
		];
		expect(estimateRequestTokens({ messages, systemPrompt: "s".repeat(4000) })).toBe(50_000 + 100);
	});

	it("ignores usage older than the latest compaction and estimates everything instead", () => {
		const messages: AgentMessage[] = [
			{ role: "compactionSummary", summary: "c".repeat(400), tokensBefore: 200_000, timestamp: 10 },
			// A retained response still carries usage of the larger pre-compaction context.
			assistant("retained", 190_000, 5),
			{ role: "user", content: "u".repeat(400), timestamp: 11 },
		];
		const systemPrompt = "s".repeat(4000);
		expect(estimateRequestTokens({ messages, systemPrompt })).toBe(estimateMessagesTokens(messages) + 1000);
		// A response newer than the compaction anchors again.
		const fresh = [...messages, assistant("fresh", 30_000, 12)];
		expect(estimateRequestTokens({ messages: fresh, systemPrompt })).toBe(30_000);
	});

	it("skips unavailable and failed usage", () => {
		const failed = assistant("", 99_000, 3);
		failed.stopReason = "error";
		const messages: AgentMessage[] = [assistant("ok", 10_000, 1), assistant("zero", 0, 2), failed];
		expect(estimateRequestTokens({ messages })).toBe(10_000 + estimateMessagesTokens(messages.slice(1)));
	});
});

describe("estimateMessagesTokens", () => {
	it("does not count bash output excluded from context", () => {
		const bash = (excludeFromContext: boolean): AgentMessage => ({
			role: "bashExecution",
			command: "cat huge.log",
			output: "x".repeat(4000),
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext,
			timestamp: 1,
		});
		expect(estimateMessagesTokens([bash(true)])).toBe(0);
		expect(estimateMessagesTokens([bash(false)])).toBe(Math.ceil(("cat huge.log".length + 4000) / 4));
	});
});

describe("retained-message allowance", () => {
	function entries(): SessionEntry[] {
		const result: SessionEntry[] = [];
		for (let index = 0; index < 10; index++) {
			const message: AgentMessage =
				index % 2 === 0
					? { role: "user", content: `${index} ${"u".repeat(2000)}`, timestamp: index }
					: assistant(`${index} ${"a".repeat(2000)}`, 1000, index);
			result.push({
				type: "message",
				id: `entry-${index}`,
				parentId: index === 0 ? null : `entry-${index - 1}`,
				timestamp: new Date(index).toISOString(),
				message,
			});
		}
		return result;
	}

	it("leaves room for the system prompt, plan checkpoint and largest checkpoint", () => {
		const path = entries();
		const messages = path.map((entry) => (entry.type === "message" ? entry.message : undefined)).filter((m) => !!m);
		const settings = { enabled: true, reserveTokens: 1000, keepRecentTokens: 20_000 };
		const roomy = prepareCompaction(path, messages, settings, { contextWindow: 10_000 });
		const tight = prepareCompaction(path, messages, settings, { contextWindow: 10_000, fixedTokens: 7_000 });
		const kept = (id: string | undefined) => path.findIndex((entry) => entry.id === id);
		expect(roomy && tight).toBeTruthy();
		// 9,000 tokens of allowance keep more messages than 2,000.
		expect(kept(tight?.firstKeptEntryId)).toBeGreaterThan(kept(roomy?.firstKeptEntryId));
		const retained = messages.slice(kept(tight?.firstKeptEntryId));
		expect(estimateMessagesTokens(retained)).toBeLessThanOrEqual(2000);
	});
});
