import { mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { type CustomEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";
import { assistantMsg, userMsg } from "../utilities.ts";

describe("SessionManager append and tree traversal", () => {
	describe("append operations", () => {
		it("appendMessage creates entry with correct parentId chain", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.logWriter.appendMessage(userMsg("first"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("second"));
			const id3 = await session.logWriter.appendMessage(userMsg("third"));

			const entries = session.getEntries();
			expect(entries).toHaveLength(3);

			expect(entries[0].id).toBe(id1);
			expect(entries[0].parentId).toBeNull();
			expect(entries[0].type).toBe("message");

			expect(entries[1].id).toBe(id2);
			expect(entries[1].parentId).toBe(id1);

			expect(entries[2].id).toBe(id3);
			expect(entries[2].parentId).toBe(id2);
		});

		it("appendThinkingLevelChange integrates into tree", async () => {
			const session = SessionManager.inMemory();

			const msgId = await session.logWriter.appendMessage(userMsg("hello"));
			await session.logWriter.appendThinkingLevelChange("high");
			const thinkingId = session.getLeafId()!;
			const _msg2Id = await session.logWriter.appendMessage(assistantMsg("response"));

			const entries = session.getEntries();
			expect(entries).toHaveLength(3);

			const thinkingEntry = entries.find((e) => e.type === "thinking_level_change");
			expect(thinkingEntry).toBeDefined();
			expect(thinkingEntry!.id).toBe(thinkingId);
			expect(thinkingEntry!.parentId).toBe(msgId);

			expect(entries[2].parentId).toBe(thinkingId);
		});

		it("appendModelChange integrates into tree", async () => {
			const session = SessionManager.inMemory();

			const msgId = await session.logWriter.appendMessage(userMsg("hello"));
			await session.logWriter.appendModelChange("openai", "gpt-4");
			const modelId = session.getLeafId()!;
			const _msg2Id = await session.logWriter.appendMessage(assistantMsg("response"));

			const entries = session.getEntries();
			const modelEntry = entries.find((e) => e.type === "model_change");
			expect(modelEntry).toBeDefined();
			expect(modelEntry?.id).toBe(modelId);
			expect(modelEntry?.parentId).toBe(msgId);
			if (modelEntry?.type === "model_change") {
				expect(modelEntry.provider).toBe("openai");
				expect(modelEntry.modelId).toBe("gpt-4");
			}

			expect(entries[2].parentId).toBe(modelId);
		});

		it("appendCompaction integrates into tree", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.logWriter.appendMessage(userMsg("1"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("2"));
			const compactionId = await session.logWriter.appendCompaction("summary", id1, 1000);
			const _id3 = await session.logWriter.appendMessage(userMsg("3"));

			const entries = session.getEntries();
			const compactionEntry = entries.find((e) => e.type === "compaction");
			expect(compactionEntry).toBeDefined();
			expect(compactionEntry?.id).toBe(compactionId);
			expect(compactionEntry?.parentId).toBe(id2);
			if (compactionEntry?.type === "compaction") {
				expect(compactionEntry.summary).toBe("summary");
				expect(compactionEntry.firstKeptEntryId).toBe(id1);
				expect(compactionEntry.tokensBefore).toBe(1000);
			}

			expect(entries[3].parentId).toBe(compactionId);
		});

		it("appendCustomEntry integrates into tree", async () => {
			const session = SessionManager.inMemory();

			const msgId = await session.logWriter.appendMessage(userMsg("hello"));
			const customId = await session.logWriter.appendCustomEntry("my_data", { key: "value" });
			const _msg2Id = await session.logWriter.appendMessage(assistantMsg("response"));

			const entries = session.getEntries();
			const customEntry = entries.find((e) => e.type === "custom") as CustomEntry;
			expect(customEntry).toBeDefined();
			expect(customEntry.id).toBe(customId);
			expect(customEntry.parentId).toBe(msgId);
			expect(customEntry.customType).toBe("my_data");
			expect(customEntry.data).toEqual({ key: "value" });

			expect(entries[2].parentId).toBe(customId);
		});

		it("leaf pointer advances after each append", async () => {
			const session = SessionManager.inMemory();

			expect(session.getLeafId()).toBeNull();

			const id1 = await session.logWriter.appendMessage(userMsg("1"));
			expect(session.getLeafId()).toBe(id1);

			const id2 = await session.logWriter.appendMessage(assistantMsg("2"));
			expect(session.getLeafId()).toBe(id2);

			await session.logWriter.appendThinkingLevelChange("high");
			const id3 = session.getLeafId()!;
			expect(session.getLeafId()).toBe(id3);
		});
	});

	describe("getPath", () => {
		it("returns empty array for empty session", () => {
			const session = SessionManager.inMemory();
			expect(session.getBranch()).toEqual([]);
		});

		it("returns single entry path", async () => {
			const session = SessionManager.inMemory();
			const id = await session.logWriter.appendMessage(userMsg("hello"));

			const path = session.getBranch();
			expect(path).toHaveLength(1);
			expect(path[0].id).toBe(id);
		});

		it("returns full path from root to leaf", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.logWriter.appendMessage(userMsg("1"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("2"));
			await session.logWriter.appendThinkingLevelChange("high");
			const id3 = session.getLeafId()!;
			const id4 = await session.logWriter.appendMessage(userMsg("3"));

			const path = session.getBranch();
			expect(path).toHaveLength(4);
			expect(path.map((e) => e.id)).toEqual([id1, id2, id3, id4]);
		});

		it("returns path from specified entry to root", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.logWriter.appendMessage(userMsg("1"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("2"));
			const _id3 = await session.logWriter.appendMessage(userMsg("3"));
			const _id4 = await session.logWriter.appendMessage(assistantMsg("4"));

			const path = session.getBranch(id2);
			expect(path).toHaveLength(2);
			expect(path.map((e) => e.id)).toEqual([id1, id2]);
		});
	});

	describe("getTree", () => {
		it("returns empty array for empty session", () => {
			const session = SessionManager.inMemory();
			expect(session.getTree()).toEqual([]);
		});

		it("returns single root for linear session", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.logWriter.appendMessage(userMsg("1"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("2"));
			const id3 = await session.logWriter.appendMessage(userMsg("3"));

			const tree = session.getTree();
			expect(tree).toHaveLength(1);

			const root = tree[0];
			expect(root.entry.id).toBe(id1);
			expect(root.children).toHaveLength(1);
			expect(root.children[0].entry.id).toBe(id2);
			expect(root.children[0].children).toHaveLength(1);
			expect(root.children[0].children[0].entry.id).toBe(id3);
			expect(root.children[0].children[0].children).toHaveLength(0);
		});

		it("returns tree with branches after branch", async () => {
			const session = SessionManager.inMemory();

			// Build: 1 -> 2 -> 3
			const id1 = await session.logWriter.appendMessage(userMsg("1"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("2"));
			const id3 = await session.logWriter.appendMessage(userMsg("3"));

			// Branch from id2, add new path: 2 -> 4
			await session.logWriter.branch(id2);
			const id4 = await session.logWriter.appendMessage(userMsg("4-branch"));

			const tree = session.getTree();
			expect(tree).toHaveLength(1);

			const root = tree[0];
			expect(root.entry.id).toBe(id1);
			expect(root.children).toHaveLength(1);

			const node2 = root.children[0];
			expect(node2.entry.id).toBe(id2);
			expect(node2.children).toHaveLength(2); // id3 and id4 are siblings

			const childIds = node2.children.map((c) => c.entry.id).sort();
			expect(childIds).toEqual([id3, id4].sort());
		});

		it("handles multiple branches at same point", async () => {
			const session = SessionManager.inMemory();

			const _id1 = await session.logWriter.appendMessage(userMsg("root"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("response"));

			// Branch A
			await session.logWriter.branch(id2);
			const idA = await session.logWriter.appendMessage(userMsg("branch-A"));

			// Branch B
			await session.logWriter.branch(id2);
			const idB = await session.logWriter.appendMessage(userMsg("branch-B"));

			// Branch C
			await session.logWriter.branch(id2);
			const idC = await session.logWriter.appendMessage(userMsg("branch-C"));

			const tree = session.getTree();
			const node2 = tree[0].children[0];
			expect(node2.entry.id).toBe(id2);
			expect(node2.children).toHaveLength(3);

			const branchIds = node2.children.map((c) => c.entry.id).sort();
			expect(branchIds).toEqual([idA, idB, idC].sort());
		});

		it("handles deep branching", async () => {
			const session = SessionManager.inMemory();

			// Main path: 1 -> 2 -> 3 -> 4
			const _id1 = await session.logWriter.appendMessage(userMsg("1"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("2"));
			const id3 = await session.logWriter.appendMessage(userMsg("3"));
			const _id4 = await session.logWriter.appendMessage(assistantMsg("4"));

			// Branch from 2: 2 -> 5 -> 6
			await session.logWriter.branch(id2);
			const id5 = await session.logWriter.appendMessage(userMsg("5"));
			const _id6 = await session.logWriter.appendMessage(assistantMsg("6"));

			// Branch from 5: 5 -> 7
			await session.logWriter.branch(id5);
			const _id7 = await session.logWriter.appendMessage(userMsg("7"));

			const tree = session.getTree();

			// Verify structure
			const node2 = tree[0].children[0];
			expect(node2.children).toHaveLength(2); // id3 and id5

			const node5 = node2.children.find((c) => c.entry.id === id5)!;
			expect(node5.children).toHaveLength(2); // id6 and id7

			const node3 = node2.children.find((c) => c.entry.id === id3)!;
			expect(node3.children).toHaveLength(1); // id4
		});
	});

	describe("branch", () => {
		it("moves leaf pointer to specified entry", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.logWriter.appendMessage(userMsg("1"));
			const _id2 = await session.logWriter.appendMessage(assistantMsg("2"));
			const id3 = await session.logWriter.appendMessage(userMsg("3"));

			expect(session.getLeafId()).toBe(id3);

			await session.logWriter.branch(id1);
			expect(session.getLeafId()).toBe(id1);
		});

		it("throws for non-existent entry", async () => {
			const session = SessionManager.inMemory();
			await session.logWriter.appendMessage(userMsg("hello"));

			await expect(session.logWriter.branch("nonexistent")).rejects.toThrow("Entry nonexistent not found");
		});

		it("new appends become children of branch point", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.logWriter.appendMessage(userMsg("1"));
			const _id2 = await session.logWriter.appendMessage(assistantMsg("2"));

			await session.logWriter.branch(id1);
			const id3 = await session.logWriter.appendMessage(userMsg("branched"));

			const entries = session.getEntries();
			const branchedEntry = entries.find((e) => e.id === id3)!;
			expect(branchedEntry.parentId).toBe(id1); // sibling of id2
		});
	});

	describe("branchWithSummary", () => {
		it("inserts branch summary and advances leaf", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.logWriter.appendMessage(userMsg("1"));
			const _id2 = await session.logWriter.appendMessage(assistantMsg("2"));
			const _id3 = await session.logWriter.appendMessage(userMsg("3"));

			const summaryId = await session.logWriter.branchWithSummary(id1, "Summary of abandoned work");

			expect(session.getLeafId()).toBe(summaryId);

			const entries = session.getEntries();
			const summaryEntry = entries.find((e) => e.type === "branch_summary");
			expect(summaryEntry).toBeDefined();
			expect(summaryEntry?.parentId).toBe(id1);
			if (summaryEntry?.type === "branch_summary") {
				expect(summaryEntry.summary).toBe("Summary of abandoned work");
			}
		});

		it("throws for non-existent entry", async () => {
			const session = SessionManager.inMemory();
			await session.logWriter.appendMessage(userMsg("hello"));

			await expect(session.logWriter.branchWithSummary("nonexistent", "summary")).rejects.toThrow(
				"Entry nonexistent not found",
			);
		});
	});

	describe("getLeafEntry", () => {
		it("returns undefined for empty session", () => {
			const session = SessionManager.inMemory();
			expect(session.getLeafEntry()).toBeUndefined();
		});

		it("returns current leaf entry", async () => {
			const session = SessionManager.inMemory();

			await session.logWriter.appendMessage(userMsg("1"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("2"));

			const leaf = session.getLeafEntry();
			expect(leaf).toBeDefined();
			expect(leaf!.id).toBe(id2);
		});
	});

	describe("getEntry", () => {
		it("returns undefined for non-existent id", () => {
			const session = SessionManager.inMemory();
			expect(session.getEntry("nonexistent")).toBeUndefined();
		});

		it("returns entry by id", async () => {
			const session = SessionManager.inMemory();

			const id1 = await session.logWriter.appendMessage(userMsg("first"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("second"));

			const entry1 = session.getEntry(id1);
			expect(entry1).toBeDefined();
			expect(entry1?.type).toBe("message");
			if (entry1?.type === "message" && entry1.message.role === "user") {
				expect(entry1.message.content).toBe("first");
			}

			const entry2 = session.getEntry(id2);
			expect(entry2).toBeDefined();
			if (entry2?.type === "message" && entry2.message.role === "assistant") {
				expect((entry2.message.content as any)[0].text).toBe("second");
			}
		});
	});

	describe("branch context with branches", () => {
		it("returns messages from current branch only", async () => {
			const session = SessionManager.inMemory();

			// Main: 1 -> 2 -> 3
			await session.logWriter.appendMessage(userMsg("msg1"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("msg2"));
			await session.logWriter.appendMessage(userMsg("msg3"));

			// Branch from 2: 2 -> 4
			await session.logWriter.branch(id2);
			await session.logWriter.appendMessage(assistantMsg("msg4-branch"));

			const ctx = session.getConversationState().context;
			expect(ctx.messages).toHaveLength(3); // msg1, msg2, msg4-branch (not msg3)

			expect((ctx.messages[0] as any).content).toBe("msg1");
			expect((ctx.messages[1] as any).content[0].text).toBe("msg2");
			expect((ctx.messages[2] as any).content[0].text).toBe("msg4-branch");
		});
	});
});

describe("SessionManager.createBranched", () => {
	it("throws for non-existent entry", async () => {
		const session = SessionManager.inMemory();
		await session.logWriter.appendMessage(userMsg("hello"));

		await expect(SessionManager.createBranched(session, "nonexistent")).rejects.toThrow(
			"Entry nonexistent not found",
		);
	});

	it("creates new session with path to specified leaf (in-memory)", async () => {
		const session = SessionManager.inMemory();

		// Build: 1 -> 2 -> 3 -> 4
		const id1 = await session.logWriter.appendMessage(userMsg("1"));
		const id2 = await session.logWriter.appendMessage(assistantMsg("2"));
		const id3 = await session.logWriter.appendMessage(userMsg("3"));
		await session.logWriter.appendMessage(assistantMsg("4"));

		// Branch from 3: 3 -> 5
		await session.logWriter.branch(id3);
		const _id5 = await session.logWriter.appendMessage(userMsg("5"));

		// Create branched session from id2 (should only have 1 -> 2)
		const branched = await SessionManager.createBranched(session, id2);
		expect(branched.getSessionRef()).toBeUndefined();

		// The branched session has only entries 1 and 2
		const entries = branched.getEntries();
		expect(entries).toHaveLength(2);
		expect(entries[0].id).toBe(id1);
		expect(entries[1].id).toBe(id2);
	});

	it("extracts correct path from branched tree", async () => {
		const session = SessionManager.inMemory();

		// Build: 1 -> 2 -> 3
		const id1 = await session.logWriter.appendMessage(userMsg("1"));
		const id2 = await session.logWriter.appendMessage(assistantMsg("2"));
		await session.logWriter.appendMessage(userMsg("3"));

		// Branch from 2: 2 -> 4 -> 5
		await session.logWriter.branch(id2);
		const id4 = await session.logWriter.appendMessage(userMsg("4"));
		const id5 = await session.logWriter.appendMessage(assistantMsg("5"));

		// Create branched session from id5 (should have 1 -> 2 -> 4 -> 5)
		const branched = await SessionManager.createBranched(session, id5);

		const entries = branched.getEntries();
		expect(entries).toHaveLength(4);
		expect(entries.map((e) => e.id)).toEqual([id1, id2, id4, id5]);
	});

	it("does not duplicate entries when branching from the first user message", async () => {
		const tempDir = join(tmpdir(), `session-fork-dedup-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const managerOwner = createSessionManagerTestOwner();
		managerOwner.start();

		try {
			const session = await SessionManager.create(tempDir, tempDir);
			const id1 = await session.logWriter.appendMessage(userMsg("first question"));
			await session.logWriter.appendMessage(assistantMsg("first answer"));
			await session.logWriter.appendMessage(userMsg("second question"));
			await session.logWriter.appendMessage(assistantMsg("second answer"));

			const branched = await SessionManager.createBranched(session, id1);
			const branchedRef = branched.getSessionRef();
			if (!branchedRef) throw new Error("Expected a persisted branched reference");
			await branched.logWriter.appendCustomEntry("preset-state", { name: "plan" });
			await branched.logWriter.appendMessage(assistantMsg("new answer"));

			const reopened = await SessionManager.openReadOnly(branchedRef);
			const entryIds = reopened.getEntries().map((entry) => entry.id);
			expect(new Set(entryIds).size).toBe(entryIds.length);
			expect(reopened.getConversationState().context.messages).toMatchObject([
				{ role: "user" },
				{ role: "assistant" },
			]);
		} finally {
			await managerOwner.drain();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("materializes a branch containing assistant messages", async () => {
		const tempDir = join(tmpdir(), `session-fork-with-assistant-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		const managerOwner = createSessionManagerTestOwner();
		managerOwner.start();

		try {
			const session = await SessionManager.create(tempDir, tempDir);
			const id1 = await session.logWriter.appendMessage(userMsg("first question"));
			const id2 = await session.logWriter.appendMessage(assistantMsg("first answer"));
			await session.logWriter.appendMessage(userMsg("second question"));
			await session.logWriter.appendMessage(assistantMsg("second answer"));

			const branchedRef = (await SessionManager.createBranched(session, id2)).getSessionRef();
			if (!branchedRef) throw new Error("Expected a persisted branched reference");

			const reopened = await SessionManager.openReadOnly(branchedRef);
			expect(reopened.getEntries().map((entry) => entry.id)).toEqual([id1, id2]);
			expect(reopened.getConversationState().context.messages).toHaveLength(2);
		} finally {
			await managerOwner.drain();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
