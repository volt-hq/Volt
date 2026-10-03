import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLogEntryDraft } from "../../src/core/conversation-log/entry-codec.ts";
import {
	CURRENT_SESSION_SNAPSHOT_VERSION,
	CURRENT_SESSION_VERSION,
	loadEntriesFromFile,
	type SessionEntry,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";
import { injectFaultyLog } from "../utilities/faulty-log.ts";
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

function sessionSnapshotJsonl(id: string, cwd: string, message = "hello"): string {
	return `${[
		JSON.stringify({
			type: "session",
			version: CURRENT_SESSION_VERSION,
			snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
			id,
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd,
		}),
		JSON.stringify({
			type: "message",
			id: `${id}-message`,
			parentId: null,
			ordinal: 1,
			timestamp: "2025-01-01T00:00:01.000Z",
			message: { role: "user", content: message, timestamp: Date.parse("2025-01-01T00:00:01.000Z") },
		}),
		JSON.stringify({
			type: "leaf",
			id: `${id}-leaf`,
			parentId: `${id}-message`,
			ordinal: 2,
			timestamp: "2025-01-01T00:00:02.000Z",
			targetId: `${id}-message`,
		}),
	].join("\n")}\n`;
}

describe("JSONL snapshot import parsing", () => {
	let tempDir: string;
	const managerOwner = createSessionManagerTestOwner();

	beforeEach(() => {
		managerOwner.start();
		tempDir = join(tmpdir(), `session-import-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await managerOwner.drain();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("returns no entries for missing, empty, or headerless files", () => {
		expect(loadEntriesFromFile(join(tempDir, "missing.jsonl"))).toEqual([]);
		const empty = join(tempDir, "empty.jsonl");
		writeFileSync(empty, "");
		expect(loadEntriesFromFile(empty)).toEqual([]);
		const headerless = join(tempDir, "headerless.jsonl");
		writeFileSync(headerless, '{"type":"message","id":"1"}\n');
		expect(loadEntriesFromFile(headerless)).toEqual([]);
	});

	it("loads a valid import snapshot", () => {
		const path = join(tempDir, "valid.jsonl");
		writeFileSync(path, sessionSnapshotJsonl("snapshot", tempDir));

		const entries = loadEntriesFromFile(path);
		expect(entries.map((entry) => entry.type)).toEqual(["session", "message", "leaf"]);
	});

	it("rejects a snapshot whose final leaf record is missing", async () => {
		const path = join(tempDir, "leafless.jsonl");
		const lines = sessionSnapshotJsonl("leafless", tempDir).trimEnd().split("\n");
		writeFileSync(path, `${lines.slice(0, -1).join("\n")}\n`);

		await expect(SessionManager.importFromJsonl(path, tempDir, join(tempDir, "leafless-store"))).rejects.toThrow(
			"Session snapshot must contain exactly one final leaf entry",
		);
	});

	it("rejects malformed committed records and truncated final fragments", () => {
		const malformed = join(tempDir, "malformed.jsonl");
		writeFileSync(
			malformed,
			'{"type":"session","version":5,"id":"bad","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\nnot-json\n',
		);
		expect(() => loadEntriesFromFile(malformed)).toThrow("malformed at committed line 2");

		const torn = join(tempDir, "torn.jsonl");
		writeFileSync(
			torn,
			'{"type":"session","version":5,"id":"torn","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
				'{"type":"client_input_sta',
		);
		expect(() => loadEntriesFromFile(torn)).toThrow("malformed at committed line 2");
	});

	it("rejects unsupported imports without mutating their bytes", async () => {
		const path = join(tempDir, "future.jsonl");
		const content =
			'{"type":"session","version":6,"snapshotVersion":1,"id":"future","timestamp":"2025-01-01T00:00:00.000Z","cwd":"/tmp"}\n';
		writeFileSync(path, content);

		await expect(SessionManager.importFromJsonl(path, tempDir, tempDir)).rejects.toThrow(
			"Session snapshot entry version must be 5",
		);
		expect(readFileSync(path, "utf8")).toBe(content);
	});

	it.each([
		{
			name: "entry parent",
			id: "dangling-parent",
			entries: [
				{
					type: "message",
					id: "root",
					parentId: null,
					ordinal: 1,
					timestamp: "2025-01-01T00:00:01.000Z",
					message: { role: "user", content: "root", timestamp: Date.parse("2025-01-01T00:00:01.000Z") },
				},
				{
					type: "message",
					id: "orphan",
					parentId: "missing-parent",
					ordinal: 2,
					timestamp: "2025-01-01T00:00:02.000Z",
					message: { role: "user", content: "orphan", timestamp: Date.parse("2025-01-01T00:00:02.000Z") },
				},
				{
					type: "leaf",
					id: "leaf",
					parentId: "orphan",
					ordinal: 3,
					timestamp: "2025-01-01T00:00:03.000Z",
					targetId: "orphan",
				},
			],
			error: /invalid or forward parent/,
		},
		{
			name: "leaf target",
			id: "dangling-leaf",
			entries: [
				{
					type: "message",
					id: "root",
					parentId: null,
					ordinal: 1,
					timestamp: "2025-01-01T00:00:01.000Z",
					message: { role: "user", content: "root", timestamp: Date.parse("2025-01-01T00:00:01.000Z") },
				},
				{
					type: "leaf",
					id: "leaf",
					parentId: "root",
					ordinal: 2,
					timestamp: "2025-01-01T00:00:02.000Z",
					targetId: "missing-leaf",
				},
			],
			error: /targets an invalid conversation entry/,
		},
	])("rejects a snapshot with a dangling $name without retaining a hidden row", async ({ id, entries, error }) => {
		const path = join(tempDir, `${id}.jsonl`);
		writeFileSync(
			path,
			`${[
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
					id,
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: tempDir,
				},
				...entries,
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionDir = join(tempDir, `${id}-store`);

		await expect(SessionManager.importFromJsonl(path, tempDir, sessionDir)).rejects.toThrow(error);
		expect(await SessionManager.list(tempDir, sessionDir, undefined, { includeMessageFreeDurable: true })).toEqual(
			[],
		);
	});

	it.each([
		{
			name: "missing",
			id: "missing-compaction-boundary",
			firstKeptEntryId: "missing",
		},
		{
			name: "outside the active branch",
			id: "branched-compaction-boundary",
			firstKeptEntryId: "sibling",
		},
	])("rejects a compaction boundary that is $name during direct JSONL import", async ({ id, firstKeptEntryId }) => {
		const path = join(tempDir, `${id}.jsonl`);
		writeFileSync(
			path,
			`${[
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
					id,
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: tempDir,
				},
				{
					type: "message",
					id: "root",
					parentId: null,
					ordinal: 1,
					timestamp: "2025-01-01T00:00:01.000Z",
					message: { role: "user", content: "root", timestamp: Date.parse("2025-01-01T00:00:01.000Z") },
				},
				{
					type: "message",
					id: "active",
					parentId: "root",
					ordinal: 2,
					timestamp: "2025-01-01T00:00:02.000Z",
					message: { role: "user", content: "active", timestamp: Date.parse("2025-01-01T00:00:02.000Z") },
				},
				{
					type: "message",
					id: "sibling",
					parentId: "root",
					ordinal: 3,
					timestamp: "2025-01-01T00:00:03.000Z",
					message: { role: "user", content: "sibling", timestamp: Date.parse("2025-01-01T00:00:03.000Z") },
				},
				{
					type: "compaction",
					id: "compaction",
					parentId: "active",
					ordinal: 4,
					timestamp: "2025-01-01T00:00:04.000Z",
					summary: "summary",
					firstKeptEntryId,
					tokensBefore: 100,
				},
				{
					type: "leaf",
					id: "leaf",
					parentId: "compaction",
					ordinal: 5,
					timestamp: "2025-01-01T00:00:05.000Z",
					targetId: "compaction",
				},
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionDir = join(tempDir, `${id}-store`);

		await expect(SessionManager.importFromJsonl(path, tempDir, sessionDir)).rejects.toThrow(
			"Compaction entry compaction has an invalid first-kept boundary",
		);
		expect(await SessionManager.list(tempDir, sessionDir, undefined, { includeMessageFreeDurable: true })).toEqual(
			[],
		);
	});

	it.each([
		{
			name: "Fast mode",
			id: "invalid-fast-mode",
			entry: { type: "fast_mode_change", id: "invalid-fast", enabled: "yes" },
			error: "Fast mode entry invalid-fast has an invalid enabled state",
		},
		{
			name: "thinking-level",
			id: "invalid-thinking-level",
			entry: { type: "thinking_level_change", id: "invalid-thinking", thinkingLevel: "turbo" },
			error: "Thinking level entry invalid-thinking has an invalid thinking level",
		},
	])("rejects a malformed $name import without retaining a hidden row", async ({ id, entry, error }) => {
		const path = join(tempDir, `${id}.jsonl`);
		writeFileSync(
			path,
			`${[
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
					id,
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: tempDir,
				},
				{
					...entry,
					parentId: null,
					ordinal: 1,
					timestamp: "2025-01-01T00:00:01.000Z",
				},
			]
				.map((snapshotEntry) => JSON.stringify(snapshotEntry))
				.join("\n")}\n`,
		);
		const sessionDir = join(tempDir, `${id}-store`);

		await expect(SessionManager.importFromJsonl(path, tempDir, sessionDir)).rejects.toThrow(error);
		expect(await SessionManager.list(tempDir, sessionDir, undefined, { includeMessageFreeDurable: true })).toEqual(
			[],
		);
	});

	it("imports and reopens every valid thinking level with valid Fast mode state", async () => {
		const path = join(tempDir, "valid-modes.jsonl");
		const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] satisfies ThinkingLevel[];
		const modeEntries: Record<string, unknown>[] = thinkingLevels.map((thinkingLevel, index) => ({
			type: "thinking_level_change",
			id: `thinking-${index}`,
			parentId: index === 0 ? null : `thinking-${index - 1}`,
			ordinal: index + 1,
			timestamp: "2025-01-01T00:00:01.000Z",
			thinkingLevel,
		}));
		modeEntries.push(
			{
				type: "fast_mode_change",
				id: "fast-enabled",
				parentId: `thinking-${thinkingLevels.length - 1}`,
				ordinal: thinkingLevels.length + 1,
				timestamp: "2025-01-01T00:00:02.000Z",
				enabled: true,
			},
			{
				type: "leaf",
				id: "valid-modes-leaf",
				parentId: "fast-enabled",
				ordinal: thinkingLevels.length + 2,
				timestamp: "2025-01-01T00:00:03.000Z",
				targetId: "fast-enabled",
			},
		);
		writeFileSync(
			path,
			`${[
				{
					type: "session",
					version: CURRENT_SESSION_VERSION,
					snapshotVersion: CURRENT_SESSION_SNAPSHOT_VERSION,
					id: "valid-modes",
					timestamp: "2025-01-01T00:00:00.000Z",
					cwd: tempDir,
				},
				...modeEntries,
			]
				.map((entry) => JSON.stringify(entry))
				.join("\n")}\n`,
		);
		const sessionDir = join(tempDir, "valid-modes-store");

		const imported = await SessionManager.importFromJsonl(path, tempDir, sessionDir);
		expect(imported.getConversationState().context).toMatchObject({ thinkingLevel: "max", fastMode: true });
		const ref = imported.getSessionRef();
		if (!ref) throw new Error("Expected imported session reference");
		expect((await SessionManager.openReadOnly(ref)).getConversationState().context).toMatchObject({
			thinkingLevel: "max",
			fastMode: true,
		});
	});

	it("imports a snapshot into SQLite and never treats the source as live storage", async () => {
		const path = join(tempDir, "source.jsonl");
		const sourceBytes = sessionSnapshotJsonl("imported", tempDir, "snapshot message");
		writeFileSync(path, sourceBytes);
		const sessionDir = join(tempDir, "sqlite-store");
		const manager = await SessionManager.importFromJsonl(path, tempDir, sessionDir);
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected imported session reference");

		const sqliteMessageTimestamp = Date.now();
		await manager.logWriter.appendMessage({
			role: "user",
			content: "SQLite message",
			timestamp: sqliteMessageTimestamp,
		});

		expect(readFileSync(path, "utf8")).toBe(sourceBytes);
		expect(existsSync(join(sessionDir, "sessions.sqlite"))).toBe(true);
		expect((await SessionManager.openReadOnly(ref)).getConversationState().context.messages).toEqual([
			{
				role: "user",
				content: "snapshot message",
				timestamp: Date.parse("2025-01-01T00:00:01.000Z"),
			},
			{ role: "user", content: "SQLite message", timestamp: sqliteMessageTimestamp },
		]);
	});
});

describe("SessionManager SQLite session behavior", () => {
	let tempDir: string;
	let projectA: string;
	let projectB: string;
	const managerOwner = createSessionManagerTestOwner();

	beforeEach(() => {
		managerOwner.start();
		tempDir = join(tmpdir(), `session-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		projectA = join(tempDir, "project-a");
		projectB = join(tempDir, "project-b");
		mkdirSync(projectA, { recursive: true });
		mkdirSync(projectB, { recursive: true });
	});

	afterEach(async () => {
		await managerOwner.drain();
		rmSync(tempDir, { recursive: true, force: true });
	});

	async function createVisibleSession(cwd: string, id: string, label: string): Promise<SessionManager> {
		const session = await SessionManager.create(cwd, tempDir, { id });
		await session.logWriter.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		return session;
	}

	it("scopes current-folder APIs by cwd while listing all sessions in one store", async () => {
		const sessionA = await createVisibleSession(projectA, "session-a", "from A");
		const sessionB = await createVisibleSession(projectB, "session-b", "from B");

		const currentA = await SessionManager.list(projectA, tempDir);
		expect(currentA.map((session) => session.ref)).toEqual([sessionA.getSessionRef()]);

		const all = await SessionManager.listAll(tempDir);
		expect(new Set(all.map((session) => session.id))).toEqual(new Set(["session-a", "session-b"]));
		expect(new Set(all.map((session) => session.ref.storeId))).toEqual(
			new Set([sessionA.getSessionRef()?.storeId, sessionB.getSessionRef()?.storeId]),
		);

		// Continuing opens the session for writing, so its first writer closes first.
		await sessionA.closePersistence();
		const continuedA = await SessionManager.continueRecent(projectA, tempDir);
		expect(continuedA.getSessionRef()).toEqual(sessionA.getSessionRef());
	});

	it("commits a client input delivery and its planning snapshot as one atomic batch", async () => {
		const manager = await SessionManager.create(projectA, tempDir);
		await seedSession(manager, (seed) =>
			seed.clientInput("delivery-1", "prompt", { message: "hello" }, { states: ["started"] }),
		);
		const planning = {
			mode: "plan" as const,
			plan: {
				id: "plan-1",
				revision: 1,
				phase: "draft" as const,
				steps: [{ id: "step-1", text: "Inspect", status: "pending" as const }],
			},
		};
		const message = {
			role: "user" as const,
			content: "hello",
			clientMessageId: "delivery-1",
			timestamp: Date.now(),
		};
		const delivery: BatchEntry[] = [
			{
				type: "message",
				message: { role: "user", content: message.content, timestamp: message.timestamp },
				clientMessageId: "delivery-1",
			},
			{ type: "planning_state_change", planning },
		];

		// A rolled-back batch changes nothing; the input stays started.
		const faulty = injectFaultyLog(manager);
		faulty.failNext("rolled_back");
		await expect(commitBatch(manager, delivery)).rejects.toMatchObject({ effect: "rolled_back" });
		expect(manager.getClientInput("delivery-1")).toMatchObject({ state: "started" });
		expect(manager.getConversationState()).toMatchObject({ context: { messages: [] }, planning: null });

		await commitBatch(manager, delivery);
		expect(manager.getClientInput("delivery-1")).toMatchObject({ state: "completed" });
		expect(manager.getConversationState()).toMatchObject({ context: { messages: [message] }, planning });
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected persisted session reference");
		const reopened = await SessionManager.openReadOnly(ref);
		expect(reopened.getClientInput("delivery-1")).toMatchObject({ state: "completed" });
		expect(reopened.getConversationState()).toMatchObject({ context: { messages: [message] }, planning });
	});

	it("restores navigation to an earlier entry and to root", async () => {
		const manager = await SessionManager.create(projectA, tempDir);
		const firstTimestamp = Date.now();
		const firstId = await manager.logWriter.appendMessage({
			role: "user",
			content: "first",
			timestamp: firstTimestamp,
		});
		await manager.logWriter.appendMessage({ role: "user", content: "second", timestamp: firstTimestamp + 1 });
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected persisted session reference");

		await manager.logWriter.branch(firstId);
		// Each reopen writes next, so the previous writer closes first.
		await manager.closePersistence();
		let reopened = await SessionManager.open(ref);
		expect(reopened.getLeafId()).toBe(firstId);
		expect(reopened.getEntries().map((entry) => entry.type)).toEqual(["message", "message"]);

		await reopened.logWriter.resetLeaf();
		await reopened.closePersistence();
		reopened = await SessionManager.open(ref);
		expect(reopened.getLeafId()).toBeNull();
		expect(reopened.getBranch()).toEqual([]);
	});

	it("persists planning state through a reference", async () => {
		const manager = await SessionManager.create(projectA, tempDir);
		await manager.logWriter.appendPlanningState({ mode: "plan", plan: null });
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected persisted session reference");

		expect((await SessionManager.openReadOnly(ref)).getConversationState().planning).toEqual({
			mode: "plan",
			plan: null,
		});
	});
});
