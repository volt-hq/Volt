import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLogLostError } from "@hansjm10/volt-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "../../src/core/session-store/index.ts";
import { loseConversationLock } from "../lost-conversation-lock.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";

const cleanups: string[] = [];
const managerOwner = createSessionManagerTestOwner();

function createTempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-async-session-"));
	cleanups.push(root);
	return root;
}

beforeEach(() => managerOwner.start());

afterEach(async () => {
	await managerOwner.drain();
	for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("SessionManager asynchronous SQLite persistence", () => {
	it("awaits creation of a durable hidden session and exposes it by reference", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root, { id: "hidden-session" });
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");

		expect(existsSync(join(root, "sessions.sqlite"))).toBe(true);
		expect(await SessionManager.list(root, root)).toEqual([]);
		expect(await SessionManager.list(root, root, undefined, { includeMessageFreeDurable: true })).toMatchObject([
			{ id: "hidden-session", ref },
		]);
		expect((await SessionManager.openReadOnly(ref)).getSessionId()).toBe("hidden-session");
	});

	it("preserves append order and ordinals after flush and reopen", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root);
		const observed: string[] = [];
		manager.subscribeEntries((entry) => observed.push(entry.id));

		const first = manager.appendCustomMessageEntry("test", "one", true);
		const second = manager.appendCustomEntry("test", { value: "two" });
		const third = manager.appendSessionInfo("three");
		const watermark = manager.flush();

		expect(manager.flush()).toBe(watermark);
		expect(observed).toEqual([]);
		await watermark;
		expect(observed).toEqual([first, second, third]);

		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const reopened = await SessionManager.openReadOnly(ref);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual([first, second, third]);
		expect(reopened.getEntries().map((entry) => entry.ordinal)).toEqual([1, 2, 3]);
	});

	it("materializes custom-only sessions without making them selector-visible", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root);
		const customEntryId = manager.appendCustomEntry("test", { durable: true });

		await manager.materialize();
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const reopened = await SessionManager.openReadOnly(ref);
		expect(reopened.getEntry(customEntryId)).toMatchObject({
			type: "custom",
			customType: "test",
			data: { durable: true },
		});
		expect(await SessionManager.list(root, root)).toEqual([]);
	});

	it("rejects replacement until queued persistence settles", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root, { id: "queued-source" });
		const sourceRef = manager.getSessionRef();
		if (!sourceRef) throw new Error("Expected a persisted source reference");

		manager.appendSessionInfo("queued source write");
		expect(() => manager.newSession({ id: "queued-replacement" })).toThrow(
			"Cannot create a new session while persistence is pending; await flush() first",
		);
		expect(manager.getSessionRef()).toEqual(sourceRef);

		await manager.flush();
		const replacementRef = manager.newSession({ id: "queued-replacement" });
		if (!replacementRef) throw new Error("Expected a persisted replacement reference");
		await manager.flush();

		expect((await SessionManager.openReadOnly(sourceRef)).getSessionName()).toBe("queued source write");
		expect((await SessionManager.openReadOnly(replacementRef)).getEntries()).toEqual([]);
	});

	it("rejects replacement until an in-flight commit result settles", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root, { id: "inflight-source" });
		const sourceRef = manager.getSessionRef();
		if (!sourceRef) throw new Error("Expected a persisted source reference");
		const lease = await acquireSharedSQLiteSessionStore(root);
		const applyTransaction = lease.client.applyTransaction.bind(lease.client);
		let markCommitReturned!: () => void;
		const commitReturned = new Promise<void>((resolve) => {
			markCommitReturned = resolve;
		});
		let releaseCommitResult!: () => void;
		const commitResultGate = new Promise<void>((resolve) => {
			releaseCommitResult = resolve;
		});
		let holdNextResult = true;
		const applySpy = vi.spyOn(lease.client, "applyTransaction").mockImplementation(async (input) => {
			const result = await applyTransaction(input);
			if (holdNextResult) {
				holdNextResult = false;
				markCommitReturned();
				await commitResultGate;
			}
			return result;
		});

		try {
			manager.appendSessionInfo("in-flight source write");
			await commitReturned;
			expect(() => manager.newSession({ id: "inflight-replacement" })).toThrow(
				"Cannot create a new session while persistence is pending; await flush() first",
			);
			expect(manager.getSessionRef()).toEqual(sourceRef);

			releaseCommitResult();
			await manager.flush();
			const replacementRef = manager.newSession({ id: "inflight-replacement" });
			if (!replacementRef) throw new Error("Expected a persisted replacement reference");
			manager.appendSessionInfo("replacement write");
			await manager.flush();

			expect((await SessionManager.openReadOnly(sourceRef)).getSessionName()).toBe("in-flight source write");
			expect((await SessionManager.openReadOnly(replacementRef)).getSessionName()).toBe("replacement write");
		} finally {
			releaseCommitResult();
			applySpy.mockRestore();
			await lease.release();
		}
	});

	it("persists separate sessions independently in one store", async () => {
		const root = createTempDir();
		const first = await SessionManager.create(root, root, { id: "first" });
		const second = await SessionManager.create(root, root, { id: "second" });
		first.appendCustomMessageEntry("test", "first entry", true);
		second.appendCustomMessageEntry("test", "second entry", true);

		await Promise.all([first.flush(), second.flush()]);

		const firstRef = first.getSessionRef();
		const secondRef = second.getSessionRef();
		if (!firstRef || !secondRef) throw new Error("Expected persisted session references");
		expect((await SessionManager.openReadOnly(firstRef)).getSessionName()).toBeUndefined();
		expect((await SessionManager.openReadOnly(firstRef)).buildSessionContext().messages).toMatchObject([
			{ role: "custom", content: "first entry" },
		]);
		expect((await SessionManager.openReadOnly(secondRef)).buildSessionContext().messages).toMatchObject([
			{ role: "custom", content: "second entry" },
		]);
	});

	it("loses its log when matched commit evidence trails a descendant", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root, { id: "reconciled-descendant" });
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const lease = await acquireSharedSQLiteSessionStore(root);
		const applyTransaction = lease.client.applyTransaction.bind(lease.client);
		const findSessionSummary = lease.client.findSessionSummary.bind(lease.client);
		let intercepted = false;
		const applySpy = vi.spyOn(lease.client, "applyTransaction").mockImplementation(async (input) => {
			if (intercepted) return applyTransaction(input);
			intercepted = true;
			await applyTransaction(input);
			throw new Error("injected lost transaction response");
		});
		// The commit is found, but the log has moved past it: another writer appended.
		const summarySpy = vi
			.spyOn(lease.client, "findSessionSummary")
			.mockImplementation(async (sessionId, sessionGeneration) => {
				const summary = await findSessionSummary(sessionId, sessionGeneration);
				return summary && { ...summary, lastOrdinal: summary.lastOrdinal + 1 };
			});

		try {
			const committedId = manager.appendCustomEntry("test", { writer: "reconciling-manager" });
			const watermark = manager.flush();
			await expect(watermark).rejects.toBeInstanceOf(ConversationLogLostError);
			await expect(manager.lost).resolves.toMatchObject({
				reason: "fence_conflict",
				message: "SQLite session transaction committed but authoritative session state has changed",
			});
			expect(() => manager.appendCustomEntry("test", { writer: "stale-manager" })).toThrow(ConversationLogLostError);
			// Reads keep working; the runtime ends instead of reloading.
			expect(manager.getEntry(committedId)).toMatchObject({ type: "custom" });

			summarySpy.mockRestore();
			const reopened = await SessionManager.openReadOnly(ref);
			expect(reopened.getEntries().map((entry) => entry.id)).toEqual([committedId]);
		} finally {
			summarySpy.mockRestore();
			applySpy.mockRestore();
			await lease.release();
		}
	});

	it("loses its log when a lost lock fails the ordinal fence", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root, { id: "fenced" });
		const committedId = manager.appendCustomEntry("test", { writer: "first" });
		await manager.flush();
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");

		await loseConversationLock(manager);
		manager.appendCustomEntry("test", { writer: "stale" });
		await expect(manager.flush()).rejects.toThrow("Session ordinal changed");
		await expect(manager.lost).resolves.toMatchObject({ reason: "fence_conflict" });
		expect(() => manager.appendCustomEntry("test", { writer: "later" })).toThrow("Session ordinal changed");
		// Closing a lost manager reports nothing new: `lost` already did.
		await expect(manager.closePersistence()).resolves.toBeUndefined();

		const reopened = await SessionManager.openReadOnly(ref);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual([committedId]);
	});

	it("imports a current JSONL snapshot once and continues only in SQLite", async () => {
		const root = createTempDir();
		const snapshotPath = join(root, "snapshot.jsonl");
		const snapshotBytes = `${JSON.stringify({
			type: "session",
			version: 5,
			snapshotVersion: 1,
			id: "snapshot",
			timestamp: "2025-01-01T00:00:00.000Z",
			cwd: root,
		})}\n${JSON.stringify({
			type: "leaf",
			id: "snapshot-leaf",
			parentId: null,
			ordinal: 1,
			timestamp: "2025-01-01T00:00:01.000Z",
			targetId: null,
		})}\n`;
		writeFileSync(snapshotPath, snapshotBytes);

		const manager = await SessionManager.importFromJsonl(snapshotPath, root, join(root, "sqlite-store"));
		manager.appendCustomMessageEntry("test", "SQLite entry", true);
		await manager.flush();

		expect(readFileSync(snapshotPath, "utf8")).toBe(snapshotBytes);
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		expect((await SessionManager.openReadOnly(ref)).buildSessionContext().messages).toMatchObject([
			{ role: "custom", content: "SQLite entry" },
		]);
	});

	it.runIf(process.platform !== "win32")("keeps the SQLite database private", async () => {
		const root = createTempDir();
		await SessionManager.create(root, root);
		expect(statSync(join(root, "sessions.sqlite")).mode & 0o777).toBe(0o600);
	});
});
