import { type ConversationLogEntry, type ConversationState, fold } from "@hansjm10/volt-agent-core";
import { describe, expect, it, vi } from "vitest";
import { toLogEntry } from "../../src/core/conversation-log/entry-codec.ts";
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ModelChangeEntry,
	PlanningStateChangeEntry,
	SessionEntry,
	SessionMessageEntry,
	ThinkingLevelChangeEntry,
} from "../../src/core/session-manager.ts";

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") {
		return { ...base, message: { role, content: text, timestamp: 1 } };
	}
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

function compaction(id: string, parentId: string | null, summary: string, firstKeptEntryId: string): CompactionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary,
		firstKeptEntryId,
		tokensBefore: 1000,
	};
}

/** A summary of the branch left behind, appended where the branch resumes: its source is its parent. */
function branchSummary(id: string, parentId: string | null, summary: string): BranchSummaryEntry {
	return {
		type: "branch_summary",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		summary,
		fromId: parentId ?? "root",
	};
}

function thinkingLevel(
	id: string,
	parentId: string | null,
	level: ThinkingLevelChangeEntry["thinkingLevel"],
): ThinkingLevelChangeEntry {
	return { type: "thinking_level_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", thinkingLevel: level };
}

function modelChange(id: string, parentId: string | null, provider: string, modelId: string): ModelChangeEntry {
	return { type: "model_change", id, parentId, timestamp: "2025-01-01T00:00:00Z", provider, modelId };
}

function planning(
	id: string,
	parentId: string | null,
	revision: number,
	phase: "draft" | "ready",
): PlanningStateChangeEntry {
	return {
		type: "planning_state_change",
		id,
		parentId,
		timestamp: "2025-01-01T00:00:00Z",
		planning: {
			mode: "plan",
			plan: {
				id: "plan-1",
				revision,
				phase,
				...(phase === "ready" ? { title: "Plan", summary: "Ready plan" } : {}),
				steps: [{ id: "step-1", text: "Do the work", status: "pending" }],
			},
		},
	};
}

/** The fold of `entries`, in order, with the leaf moved to `leafId` when given. */
function foldEntries(entries: readonly SessionEntry[], leafId?: string): ConversationState {
	const logEntries: ConversationLogEntry[] = entries.map((entry, index) =>
		toLogEntry({ ...entry, ordinal: index + 1 }),
	);
	if (leafId !== undefined) {
		logEntries.push({
			ordinal: entries.length + 1,
			id: "leaf",
			parentId: entries.at(-1)?.id ?? null,
			type: "leaf",
			timestamp: "2025-01-01T00:00:00Z",
			visibility: "host",
			payload: { targetId: leafId },
		});
	}
	return fold(logEntries);
}

function buildContext(entries: readonly SessionEntry[], leafId?: string) {
	const state = foldEntries(entries, leafId);
	return { ...state.context, planning: state.planning };
}

describe("branch context fold over session entries", () => {
	describe("trivial cases", () => {
		it("empty entries returns empty context", () => {
			const ctx = buildContext([]);
			expect(ctx.messages).toEqual([]);
			expect(ctx.thinkingLevel).toBe("off");
			expect(ctx.model).toBeNull();
		});

		it("single user message", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello")];
			const ctx = buildContext(entries);
			expect(ctx.messages).toHaveLength(1);
			expect(ctx.messages[0].role).toBe("user");
		});

		it("simple conversation", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				msg("2", "1", "assistant", "hi there"),
				msg("3", "2", "user", "how are you"),
				msg("4", "3", "assistant", "great"),
			];
			const ctx = buildContext(entries);
			expect(ctx.messages).toHaveLength(4);
			expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
		});

		it("tracks thinking level changes", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				thinkingLevel("2", "1", "high"),
				msg("3", "2", "assistant", "thinking hard"),
			];
			const ctx = buildContext(entries);
			expect(ctx.thinkingLevel).toBe("high");
			expect(ctx.messages).toHaveLength(2);
		});

		it("restores the newest complete planning snapshot", () => {
			const entries: SessionEntry[] = [
				planning("1", null, 1, "draft"),
				msg("2", "1", "user", "feedback"),
				planning("3", "2", 2, "ready"),
			];
			expect(buildContext(entries).planning).toMatchObject({
				mode: "plan",
				plan: { id: "plan-1", revision: 2, phase: "ready" },
			});
		});

		it("tracks model from assistant message", () => {
			const entries: SessionEntry[] = [msg("1", null, "user", "hello"), msg("2", "1", "assistant", "hi")];
			const ctx = buildContext(entries);
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-test" });
		});

		it("tracks model from model change entry", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "hello"),
				modelChange("2", "1", "openai", "gpt-4"),
				msg("3", "2", "assistant", "hi"),
			];
			const ctx = buildContext(entries);
			// Assistant message overwrites model change
			expect(ctx.model).toEqual({ provider: "anthropic", modelId: "claude-test" });
		});
	});

	describe("with compaction", () => {
		it("restores planning independently of the compaction message boundary", () => {
			const entries: SessionEntry[] = [
				planning("1", null, 1, "draft"),
				msg("2", "1", "user", "first"),
				msg("3", "2", "assistant", "response"),
				compaction("4", "3", "Summary", "2"),
				planning("5", "4", 2, "ready"),
			];
			const context = buildContext(entries);
			expect(context.planning?.plan).toMatchObject({ revision: 2, phase: "ready" });
			expect(context.messages[0]).toMatchObject({ role: "compactionSummary" });
		});
		it("includes summary before kept messages", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response1"),
				msg("3", "2", "user", "second"),
				msg("4", "3", "assistant", "response2"),
				compaction("5", "4", "Summary of first two turns", "3"),
				msg("6", "5", "user", "third"),
				msg("7", "6", "assistant", "response3"),
			];
			const ctx = buildContext(entries);

			// Should have: summary + kept (3,4) + after (6,7) = 5 messages
			expect(ctx.messages).toHaveLength(5);
			expect((ctx.messages[0] as any).summary).toContain("Summary of first two turns");
			expect((ctx.messages[1] as any).content).toBe("second");
			expect((ctx.messages[2] as any).content[0].text).toBe("response2");
			expect((ctx.messages[3] as any).content).toBe("third");
			expect((ctx.messages[4] as any).content[0].text).toBe("response3");
		});

		it("handles compaction keeping from first message", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "first"),
				msg("2", "1", "assistant", "response"),
				compaction("3", "2", "Empty summary", "1"),
				msg("4", "3", "user", "second"),
			];
			const ctx = buildContext(entries);

			// Summary + all messages (1,2,4)
			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[0] as any).summary).toContain("Empty summary");
		});

		it("multiple compactions uses latest", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "a"),
				msg("2", "1", "assistant", "b"),
				compaction("3", "2", "First summary", "1"),
				msg("4", "3", "user", "c"),
				msg("5", "4", "assistant", "d"),
				compaction("6", "5", "Second summary", "4"),
				msg("7", "6", "user", "e"),
			];
			const ctx = buildContext(entries);

			// Should use second summary, keep from 4
			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[0] as any).summary).toContain("Second summary");
		});
	});

	describe("with branches", () => {
		it("follows path to specified leaf", () => {
			// Tree:
			//   1 -> 2 -> 3 (branch A)
			//         \-> 4 (branch B)
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "response"),
				msg("3", "2", "user", "branch A"),
				msg("4", "2", "user", "branch B"),
			];

			const ctxA = buildContext(entries, "3");
			expect(ctxA.messages).toHaveLength(3);
			expect((ctxA.messages[2] as any).content).toBe("branch A");

			const ctxB = buildContext(entries, "4");
			expect(ctxB.messages).toHaveLength(3);
			expect((ctxB.messages[2] as any).content).toBe("branch B");
		});

		it("includes branch summary in path", () => {
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "response"),
				msg("3", "2", "user", "abandoned path"),
				branchSummary("4", "2", "Summary of abandoned work"),
				msg("5", "4", "user", "new direction"),
			];
			const ctx = buildContext(entries, "5");

			expect(ctx.messages).toHaveLength(4);
			expect((ctx.messages[2] as any).summary).toContain("Summary of abandoned work");
			expect((ctx.messages[3] as any).content).toBe("new direction");
		});

		it("complex tree with multiple branches and compaction", () => {
			// Tree:
			//   1 -> 2 -> 3 -> 4 -> compaction(5) -> 6 -> 7 (main path)
			//              \-> 8 -> 9 (abandoned branch)
			//                    \-> branchSummary(10) -> 11 (resumed from 3)
			const entries: SessionEntry[] = [
				msg("1", null, "user", "start"),
				msg("2", "1", "assistant", "r1"),
				msg("3", "2", "user", "q2"),
				msg("4", "3", "assistant", "r2"),
				compaction("5", "4", "Compacted history", "3"),
				msg("6", "5", "user", "q3"),
				msg("7", "6", "assistant", "r3"),
				// Abandoned branch from 3
				msg("8", "3", "user", "wrong path"),
				msg("9", "8", "assistant", "wrong response"),
				// Branch summary resuming from 3
				branchSummary("10", "3", "Tried wrong approach"),
				msg("11", "10", "user", "better approach"),
			];

			// Main path to 7: summary + kept(3,4) + after(6,7)
			const ctxMain = buildContext(entries, "7");
			expect(ctxMain.messages).toHaveLength(5);
			expect((ctxMain.messages[0] as any).summary).toContain("Compacted history");
			expect((ctxMain.messages[1] as any).content).toBe("q2");
			expect((ctxMain.messages[2] as any).content[0].text).toBe("r2");
			expect((ctxMain.messages[3] as any).content).toBe("q3");
			expect((ctxMain.messages[4] as any).content[0].text).toBe("r3");

			// Branch path to 11: 1,2,3 + branch_summary + 11
			const ctxBranch = buildContext(entries, "11");
			expect(ctxBranch.messages).toHaveLength(5);
			expect((ctxBranch.messages[0] as any).content).toBe("start");
			expect((ctxBranch.messages[1] as any).content[0].text).toBe("r1");
			expect((ctxBranch.messages[2] as any).content).toBe("q2");
			expect((ctxBranch.messages[3] as any).summary).toContain("Tried wrong approach");
			expect((ctxBranch.messages[4] as any).content).toBe("better approach");
		});
	});

	describe("edge cases", () => {
		it("walks deep branches without front insertion", () => {
			const entries: SessionEntry[] = [];
			const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
			for (let index = 0; index < 10_000; index++) {
				entries.push(
					thinkingLevel(String(index), index === 0 ? null : String(index - 1), levels[index % levels.length]!),
				);
			}

			const result = (() => {
				const unshift = vi.spyOn(Array.prototype, "unshift");
				try {
					const context = buildContext(entries);
					return { context, frontInsertions: unshift.mock.calls.length };
				} finally {
					unshift.mockRestore();
				}
			})();

			expect(result.frontInsertions).toBe(0);
			expect(result.context.thinkingLevel).toBe(levels[9_999 % levels.length]);
		});
	});
});
