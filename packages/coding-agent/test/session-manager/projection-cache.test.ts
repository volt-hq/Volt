import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toLogEntryDraft } from "../../src/core/conversation-log/entry-codec.ts";
import { type FileEntry, type SessionEntry, type SessionInfo, SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore, type SQLiteSessionStoreLease } from "../../src/core/session-store/index.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";
import { seedSession } from "../utilities/seed-log.ts";

type BatchEntry = SessionEntry extends infer T
	? T extends SessionEntry
		? Omit<T, "id" | "parentId" | "timestamp" | "ordinal">
		: never
	: never;

/** Commit `entries` to `manager` in one atomic batch, each conversation entry a child of the previous one. */
function commitBatch(manager: SessionManager, entries: readonly BatchEntry[]): Promise<SessionEntry[]> {
	return seedSession(manager, (seed) => {
		let parentId = manager.getLeafId();
		for (const entry of entries) {
			const draft = toLogEntryDraft({
				...entry,
				id: randomUUID(),
				parentId,
				timestamp: new Date().toISOString(),
			} as SessionEntry);
			seed.drafts.push(draft);
			if (draft.visibility === "public") parentId = draft.id;
		}
	});
}

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

function assistantMessage(text: string, timestamp: number): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function instrumentFileEntryFiltering(manager: SessionManager): {
	readVisits(): number;
	restore(): void;
} {
	const internals = manager as unknown as { fileEntries: FileEntry[] };
	const entries = internals.fileEntries;
	let visits = 0;
	Object.defineProperty(entries, "filter", {
		configurable: true,
		value(
			predicate: (entry: FileEntry, index: number, entries: FileEntry[]) => unknown,
			thisArg?: unknown,
		): FileEntry[] {
			const filtered: FileEntry[] = [];
			for (let index = 0; index < entries.length; index++) {
				const entry = entries[index]!;
				visits++;
				if (predicate.call(thisArg, entry, index, entries)) filtered.push(entry);
			}
			return filtered;
		},
	});
	return {
		readVisits: () => visits,
		restore: () => {
			Reflect.deleteProperty(entries, "filter");
			if (internals.fileEntries !== entries) Reflect.deleteProperty(internals.fileEntries, "filter");
		},
	};
}

describe("SessionManager projection cache", () => {
	const roots: string[] = [];
	const storeLeases: SQLiteSessionStoreLease[] = [];
	const managerOwner = createSessionManagerTestOwner();

	function fixture(): { root: string; cwd: string; sessionDir: string } {
		const root = mkdtempSync(join(tmpdir(), "volt-session-projection-cache-"));
		roots.push(root);
		const cwd = join(root, "workspace");
		const sessionDir = join(root, "sessions");
		mkdirSync(cwd, { recursive: true });
		return { root, cwd, sessionDir };
	}

	async function storedSummary(cwd: string, sessionDir: string, sessionId: string): Promise<SessionInfo> {
		const summary = (await SessionManager.list(cwd, sessionDir, undefined, { includeMessageFreeDurable: true })).find(
			(candidate) => candidate.id === sessionId,
		);
		if (!summary) throw new Error(`Stored session summary not found: ${sessionId}`);
		return summary;
	}

	beforeEach(() => managerOwner.start());

	afterEach(async () => {
		await managerOwner.drain();
		vi.restoreAllMocks();
		for (const lease of storeLeases.splice(0)) await lease.release();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("rebuilds fallback identity on load before a later user message overrides it", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await SessionManager.create(cwd, sessionDir, { id: "fallback-rebuild" });
		await manager.logWriter.appendCustomMessageEntry(
			"displayed",
			"displayed fallback",
			true,
			undefined,
			BASE_TIME + 2_000,
		);
		await manager.logWriter.appendMessage(assistantMessage("later assistant", BASE_TIME + 3_000));
		await manager.logWriter.appendCustomMessageEntry("hidden", "hidden newest", false, undefined, BASE_TIME + 9_000);

		expect(await storedSummary(cwd, sessionDir, manager.getSessionId())).toMatchObject({
			firstMessage: "displayed fallback",
			messageCount: 2,
			modified: new Date(BASE_TIME + 3_000),
		});

		// Continuing opens the session for writing, so its first writer closes first.
		await manager.closePersistence();
		const continued = await SessionManager.continueRecent(cwd, sessionDir);
		await continued.logWriter.appendMessage({ role: "user", content: "first user", timestamp: BASE_TIME + 1_000 });

		expect(await storedSummary(cwd, sessionDir, continued.getSessionId())).toMatchObject({
			firstMessage: "first user",
			messageCount: 3,
			modified: new Date(BASE_TIME + 3_000),
		});
	});

	it("preserves planning visibility, cleared names, and recorded-null Git context across reopen", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await SessionManager.create(cwd, sessionDir, { id: "metadata-rebuild" });
		const header = manager.getHeader();
		if (!header) throw new Error("Expected session header");
		await manager.logWriter.appendPlanningState({ mode: "plan", plan: null });
		await manager.logWriter.appendSessionInfo("  Named session  ");
		expect(await manager.logWriter.recordStartingGitContext(null)).toBe(true);
		await manager.logWriter.appendCustomMessageEntry(
			"hidden",
			"not visible activity",
			false,
			undefined,
			new Date(header.timestamp).getTime() + 60_000,
		);

		expect((await SessionManager.list(cwd, sessionDir)).map((session) => session.id)).toContain(
			manager.getSessionId(),
		);
		expect(await storedSummary(cwd, sessionDir, manager.getSessionId())).toMatchObject({
			name: "Named session",
			firstMessage: "(no messages)",
			messageCount: 0,
			modified: new Date(header.timestamp),
			startingGitContext: null,
		});

		// The reopen writes next, so the first writer closes first.
		await manager.closePersistence();
		const reopened = await SessionManager.open(manager.getSessionRef()!);
		expect(reopened.getSessionName()).toBe("Named session");
		expect(reopened.getStartingGitContext()).toBeNull();
		await reopened.logWriter.appendSessionInfo("   ");

		const cleared = await storedSummary(cwd, sessionDir, reopened.getSessionId());
		expect(cleared.name).toBeUndefined();
		expect(cleared.startingGitContext).toBeNull();
		expect(cleared.modified).toEqual(new Date(header.timestamp));
	});

	it("keeps lifetime summaries across leaf moves and rebuilds them from a retained branch", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await SessionManager.create(cwd, sessionDir, { id: "branch-projection" });
		await manager.logWriter.appendMessage({ role: "user", content: "root", timestamp: BASE_TIME + 1_000 });
		const keptId = await manager.logWriter.appendMessage(assistantMessage("kept", BASE_TIME + 2_000));
		await manager.logWriter.appendMessage({ role: "user", content: "abandoned", timestamp: BASE_TIME + 5_000 });
		await manager.logWriter.branch(keptId);
		const activeId = await manager.logWriter.appendMessage(assistantMessage("active", BASE_TIME + 4_000));

		expect(await storedSummary(cwd, sessionDir, manager.getSessionId())).toMatchObject({
			firstMessage: "root",
			messageCount: 4,
			modified: new Date(BASE_TIME + 5_000),
		});

		const branched = await SessionManager.createBranched(manager, activeId);
		expect(branched.getSessionId()).not.toBe(manager.getSessionId());
		expect(await storedSummary(cwd, sessionDir, branched.getSessionId())).toMatchObject({
			firstMessage: "root",
			messageCount: 3,
			modified: new Date(BASE_TIME + 4_000),
		});
	});

	it.each([
		{ name: "an earlier entry", reset: false },
		{ name: "root", reset: true },
	])("preserves a source leaf moved to $name when forking", async ({ reset }) => {
		const { root, cwd, sessionDir } = fixture();
		const source = await SessionManager.create(cwd, sessionDir, { id: reset ? "reset-source" : "branch-source" });
		const firstId = await source.logWriter.appendMessage({ role: "user", content: "first", timestamp: BASE_TIME });
		await source.logWriter.appendMessage({ role: "user", content: "second", timestamp: BASE_TIME + 1_000 });
		if (reset) await source.logWriter.resetLeaf();
		else await source.logWriter.branch(firstId);

		const forkCwd = join(root, reset ? "reset-fork" : "branch-fork");
		mkdirSync(forkCwd, { recursive: true });
		const forked = await SessionManager.forkFrom(source.getSessionRef()!, forkCwd, join(root, "moved-leaf-forks"));
		expect(forked.getLeafId()).toBe(reset ? null : firstId);
		expect(forked.getConversationState().context.messages).toEqual(
			reset ? [] : [{ role: "user", content: "first", timestamp: BASE_TIME }],
		);

		const reopened = await SessionManager.openReadOnly(forked.getSessionRef()!);
		expect(reopened.getLeafId()).toBe(reset ? null : firstId);
		expect(reopened.getConversationState().context).toEqual(forked.getConversationState().context);
	});

	it("derives forked and imported projections and preserves labels when branching immediately", async () => {
		const { root, cwd, sessionDir } = fixture();
		const source = await SessionManager.create(cwd, sessionDir, { id: "projection-source" });
		await source.logWriter.appendMessage(assistantMessage("fallback", BASE_TIME + 2_000));
		const labeledMessageId = await source.logWriter.appendMessage({
			role: "user",
			content: "first user",
			timestamp: BASE_TIME + 1_000,
		});
		await source.logWriter.appendLabelChange(labeledMessageId, "checkpoint");
		const labelEntryId = source.getLeafId()!;
		const labelTimestamp = source.getEntry(labelEntryId)?.timestamp;
		if (!labelTimestamp) throw new Error("Expected source label timestamp");
		const sourceRef = source.getSessionRef();
		if (!sourceRef) throw new Error("Expected source session reference");
		const expectProjectedLabel = (manager: SessionManager): void => {
			expect(manager.getLabel(labeledMessageId)).toBe("checkpoint");
			const pending = [...manager.getTree()];
			let node = pending.shift();
			while (node && node.entry.id !== labeledMessageId) {
				pending.push(...node.children);
				node = pending.shift();
			}
			expect(node).toMatchObject({ label: "checkpoint", labelTimestamp });
		};

		const forkCwd = join(root, "fork-workspace");
		const forkSessionDir = join(root, "fork-sessions");
		mkdirSync(forkCwd, { recursive: true });
		const forked = await SessionManager.forkFrom(sourceRef, forkCwd, forkSessionDir, {
			id: "forked-projection",
		});
		expect(await storedSummary(forkCwd, forkSessionDir, forked.getSessionId())).toMatchObject({
			firstMessage: "first user",
			messageCount: 2,
			modified: new Date(BASE_TIME + 2_000),
		});
		expectProjectedLabel(forked);
		const forkBranch = await SessionManager.createBranched(forked, labeledMessageId);
		const forkBranchRef = forkBranch.getSessionRef();
		if (!forkBranchRef) throw new Error("Expected fork branch session reference");
		expectProjectedLabel(forkBranch);
		expectProjectedLabel(await SessionManager.openReadOnly(forkBranchRef));

		const snapshotPath = join(root, "projection-source.jsonl");
		await SessionManager.exportJsonlSnapshot(sourceRef, snapshotPath);
		const importCwd = join(root, "import-workspace");
		const importSessionDir = join(root, "import-sessions");
		mkdirSync(importCwd, { recursive: true });
		const imported = await SessionManager.importFromJsonl(snapshotPath, importCwd, importSessionDir, {
			id: "imported-projection",
		});
		expect(await storedSummary(importCwd, importSessionDir, imported.getSessionId())).toMatchObject({
			firstMessage: "first user",
			messageCount: 2,
			modified: new Date(BASE_TIME + 2_000),
		});
		expectProjectedLabel(imported);
		const importBranch = await SessionManager.createBranched(imported, labeledMessageId);
		const importBranchRef = importBranch.getSessionRef();
		if (!importBranchRef) throw new Error("Expected import branch session reference");
		expectProjectedLabel(importBranch);
		expectProjectedLabel(await SessionManager.openReadOnly(importBranchRef));
	});

	it("does not filter historical file entries for direct or atomic batch payloads", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await SessionManager.create(cwd, sessionDir, { id: "bounded-projection" });
		await manager.logWriter.appendMessage({ role: "user", content: "historical", timestamp: BASE_TIME });
		for (let index = 0; index < 8; index++) await manager.logWriter.appendCustomEntry("history", { index });

		const direct = instrumentFileEntryFiltering(manager);
		try {
			await manager.logWriter.appendSessionInfo("direct");
			expect(direct.readVisits()).toBe(0);
		} finally {
			direct.restore();
		}

		const atomic = instrumentFileEntryFiltering(manager);
		try {
			await commitBatch(manager, [
				{ type: "custom", customType: "atomic" },
				{ type: "session_info", name: "atomic" },
			]);
			expect(atomic.readVisits()).toBe(0);
		} finally {
			atomic.restore();
		}
	});

	it("restores cached projection metadata after a proven atomic rollback", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = await SessionManager.create(cwd, sessionDir, { id: "projection-rollback" });
		const baselineId = await manager.logWriter.appendCustomMessageEntry(
			"baseline",
			"baseline fallback",
			true,
			undefined,
			BASE_TIME,
		);
		await manager.logWriter.appendLabelChange(baselineId, "baseline label");
		const baselineLabelId = manager.getLeafId()!;
		const baselineLabelTimestamp = manager.getEntry(baselineLabelId)?.timestamp;
		if (!baselineLabelTimestamp) throw new Error("Expected baseline label timestamp");

		const faultLease = await acquireSharedSQLiteSessionStore(sessionDir);
		storeLeases.push(faultLease);
		vi.spyOn(faultLease.client, "applyTransaction").mockRejectedValueOnce(
			new Error("injected pre-commit response failure"),
		);
		await expect(
			commitBatch(manager, [
				{
					type: "message",
					message: { role: "user", content: "rolled back user", timestamp: BASE_TIME + 10_000 },
				},
				{ type: "planning_state_change", planning: { mode: "plan", plan: null } },
				{ type: "session_info", name: "Rolled back" },
				{ type: "label", targetId: baselineId, label: "rolled back" },
			]),
		).rejects.toMatchObject({ effect: "rolled_back" });

		await manager.logWriter.appendCustomEntry("post-rollback", { durable: true });
		expect(await storedSummary(cwd, sessionDir, manager.getSessionId())).toMatchObject({
			firstMessage: "baseline fallback",
			messageCount: 1,
			modified: new Date(BASE_TIME),
		});
		expect(manager.getSessionName()).toBeUndefined();
		expect(manager.getConversationState().planning).toBeNull();
		expect(manager.getLabel(baselineId)).toBe("baseline label");
		expect(manager.getTree()[0]).toMatchObject({
			label: "baseline label",
			labelTimestamp: baselineLabelTimestamp,
		});

		await commitBatch(manager, [
			{ type: "message", message: { role: "user", content: "committed user", timestamp: BASE_TIME + 1_000 } },
			{ type: "planning_state_change", planning: { mode: "plan", plan: null } },
			{ type: "session_info", name: "Committed" },
		]);
		expect(await storedSummary(cwd, sessionDir, manager.getSessionId())).toMatchObject({
			name: "Committed",
			firstMessage: "committed user",
			messageCount: 2,
			modified: new Date(BASE_TIME + 1_000),
		});
	});
});
