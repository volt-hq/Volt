import { describe, expect, it } from "vitest";
import { type LabelEntry, SessionManager } from "../../src/core/session-manager.ts";

describe("SessionManager labels", () => {
	it("sets and gets labels", async () => {
		const session = SessionManager.inMemory();

		const msgId = await session.logWriter.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		// No label initially
		expect(session.getLabel(msgId)).toBeUndefined();

		// Set a label
		await session.logWriter.appendLabelChange(msgId, "checkpoint");
		const labelId = session.getLeafId()!;
		expect(session.getLabel(msgId)).toBe("checkpoint");

		// Label entry should be in entries
		const entries = session.getEntries();
		const labelEntry = entries.find((e) => e.type === "label") as LabelEntry;
		expect(labelEntry).toBeDefined();
		expect(labelEntry.id).toBe(labelId);
		expect(labelEntry.targetId).toBe(msgId);
		expect(labelEntry.label).toBe("checkpoint");
	});

	it("clears labels with undefined", async () => {
		const session = SessionManager.inMemory();

		const msgId = await session.logWriter.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		await session.logWriter.appendLabelChange(msgId, "checkpoint");
		expect(session.getLabel(msgId)).toBe("checkpoint");

		// Clear the label
		await session.logWriter.appendLabelChange(msgId, undefined);
		expect(session.getLabel(msgId)).toBeUndefined();
	});

	it("last label wins", async () => {
		const session = SessionManager.inMemory();

		const msgId = await session.logWriter.appendMessage({ role: "user", content: "hello", timestamp: 1 });

		await session.logWriter.appendLabelChange(msgId, "first");
		await session.logWriter.appendLabelChange(msgId, "second");
		await session.logWriter.appendLabelChange(msgId, "third");
		const lastLabelId = session.getLeafId()!;

		expect(session.getLabel(msgId)).toBe("third");

		const entries = session.getEntries();
		const lastLabelEntry = entries.find((e) => e.id === lastLabelId) as LabelEntry;
		const tree = session.getTree();
		const msgNode = tree.find((n) => n.entry.id === msgId);
		expect(msgNode?.labelTimestamp).toBe(lastLabelEntry.timestamp);
	});

	it("labels are included in tree nodes", async () => {
		const session = SessionManager.inMemory();

		const msg1Id = await session.logWriter.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const msg2Id = await session.logWriter.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		await session.logWriter.appendLabelChange(msg1Id, "start");
		const msg1LabelId = session.getLeafId()!;
		await session.logWriter.appendLabelChange(msg2Id, "response");
		const msg2LabelId = session.getLeafId()!;

		const entries = session.getEntries();
		const msg1LabelEntry = entries.find((e) => e.id === msg1LabelId) as LabelEntry;
		const msg2LabelEntry = entries.find((e) => e.id === msg2LabelId) as LabelEntry;
		const tree = session.getTree();

		// Find the message nodes (skip label entries)
		const msg1Node = tree.find((n) => n.entry.id === msg1Id);
		expect(msg1Node?.label).toBe("start");
		expect(msg1Node?.labelTimestamp).toBe(msg1LabelEntry.timestamp);

		// msg2 is a child of msg1
		const msg2Node = msg1Node?.children.find((n) => n.entry.id === msg2Id);
		expect(msg2Node?.label).toBe("response");
		expect(msg2Node?.labelTimestamp).toBe(msg2LabelEntry.timestamp);
	});

	it("labels are preserved in createBranched", async () => {
		const session = SessionManager.inMemory();

		const msg1Id = await session.logWriter.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const msg2Id = await session.logWriter.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});

		await session.logWriter.appendLabelChange(msg1Id, "important");
		const msg1LabelId = session.getLeafId()!;
		await session.logWriter.appendLabelChange(msg2Id, "also-important");
		const msg2LabelId = session.getLeafId()!;
		const originalEntries = session.getEntries();
		const msg1LabelEntry = originalEntries.find((e) => e.id === msg1LabelId) as LabelEntry;
		const msg2LabelEntry = originalEntries.find((e) => e.id === msg2LabelId) as LabelEntry;

		// Branch from msg2 into a new in-memory session holding the selected path.
		const branched = await SessionManager.createBranched(session, msg2Id);

		// Labels should be preserved
		expect(branched.getLabel(msg1Id)).toBe("important");
		expect(branched.getLabel(msg2Id)).toBe("also-important");

		// New label entries should exist
		const entries = branched.getEntries();
		const labelEntries = entries.filter((e) => e.type === "label") as LabelEntry[];
		expect(labelEntries).toHaveLength(2);

		const tree = branched.getTree();
		const msg1Node = tree.find((n) => n.entry.id === msg1Id);
		const msg2Node = msg1Node?.children.find((n) => n.entry.id === msg2Id);
		expect(msg1Node?.labelTimestamp).toBe(msg1LabelEntry.timestamp);
		expect(msg2Node?.labelTimestamp).toBe(msg2LabelEntry.timestamp);
	});

	it("rewires children of removed labels when forking", async () => {
		const session = SessionManager.inMemory();

		const msg1Id = await session.logWriter.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.logWriter.appendLabelChange(msg1Id, "checkpoint");
		await session.logWriter.appendModelChange("anthropic", "claude-test");
		const modelChangeId = session.getLeafId()!;
		const msg2Id = await session.logWriter.appendMessage({ role: "user", content: "followup", timestamp: 2 });

		const branched = await SessionManager.createBranched(session, msg2Id);

		expect(branched.getEntry(modelChangeId)?.parentId).toBe(msg1Id);
	});

	it("labels not on path are not preserved in createBranched", async () => {
		const session = SessionManager.inMemory();

		const msg1Id = await session.logWriter.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const msg2Id = await session.logWriter.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "hi" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		});
		const msg3Id = await session.logWriter.appendMessage({ role: "user", content: "followup", timestamp: 3 });

		// Label all messages
		await session.logWriter.appendLabelChange(msg1Id, "first");
		await session.logWriter.appendLabelChange(msg2Id, "second");
		await session.logWriter.appendLabelChange(msg3Id, "third");

		// Branch from msg2 (excludes msg3)
		const branched = await SessionManager.createBranched(session, msg2Id);

		// Only labels for msg1 and msg2 should be preserved
		expect(branched.getLabel(msg1Id)).toBe("first");
		expect(branched.getLabel(msg2Id)).toBe("second");
		expect(branched.getLabel(msg3Id)).toBeUndefined();
	});

	it("labels are not included in the branch context", async () => {
		const session = SessionManager.inMemory();

		const msgId = await session.logWriter.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		await session.logWriter.appendLabelChange(msgId, "checkpoint");

		const ctx = session.getConversationState().context;
		expect(ctx.messages).toHaveLength(1);
		expect(ctx.messages[0].role).toBe("user");
	});

	it("throws when labeling non-existent entry", async () => {
		const session = SessionManager.inMemory();

		await expect(session.logWriter.appendLabelChange("non-existent", "label")).rejects.toThrow(
			"Entry non-existent not found",
		);
	});
});
