import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLogLostError } from "@hansjm10/volt-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CommittedSessionEntry,
	isHostOnlySessionEntry,
	SessionAtomicAppendError,
	SessionManager,
} from "../../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";
import { injectFaultyLog, lose } from "../utilities/faulty-log.ts";
import { seedSession } from "../utilities/seed-log.ts";

const cleanups: string[] = [];
const managerOwner = createSessionManagerTestOwner();

function createTempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-commit-publish-"));
	cleanups.push(root);
	return root;
}

/** Records entry and branch notifications in delivery order. */
function observe(manager: SessionManager): string[] {
	const log: string[] = [];
	manager.subscribeEntries((entry) => log.push(`entry:${entry.ordinal}:${entry.id}`));
	manager.subscribeBranchChanges((change) => log.push(`branch:${change.previousLeafId}->${change.nextLeafId}`));
	return log;
}

beforeEach(() => managerOwner.start());

afterEach(async () => {
	await managerOwner.drain();
	for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("SessionManager commit-then-publish", () => {
	it("publishes and indexes a write only after its commit, and runs later writes after it", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root);
		const log = observe(manager);
		const faulty = injectFaultyLog(manager);
		const hold = faulty.holdNext();

		const first = manager.logWriter.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const second = manager.logWriter.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await hold.started;

		// The first commit is in flight: nothing is published or readable, and the second waits for it.
		expect(log).toEqual([]);
		expect(manager.getEntries()).toEqual([]);
		expect(manager.getLeafId()).toBeNull();
		expect(manager.getOrdinal()).toBe(0);

		hold.release();
		const [firstId, secondId] = await Promise.all([first, second]);
		expect(log).toEqual([`entry:1:${firstId}`, `entry:2:${secondId}`]);
		expect(manager.getEntry(secondId)?.parentId).toBe(firstId);
		expect(manager.getOrdinal()).toBe(2);

		await manager.logWriter.branch(firstId);
		expect(log.at(-1)).toBe(`branch:${secondId}->${firstId}`);
		expect(manager.getOrdinal()).toBe(3);
	});

	it("leaves the session unchanged and writable after a rolled-back commit", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root);
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const log = observe(manager);
		const faulty = injectFaultyLog(manager);
		faulty.failNext("rolled_back");

		const rolledBack = manager.logWriter.appendMessage({ role: "user", content: "rolled back", timestamp: 1 });
		await expect(rolledBack).rejects.toBeInstanceOf(SessionAtomicAppendError);
		await expect(rolledBack).rejects.toMatchObject({ effect: "rolled_back" });
		expect(log).toEqual([]);
		expect(manager.getEntries()).toEqual([]);
		expect(manager.getOrdinal()).toBe(0);

		const kept = await manager.logWriter.appendMessage({ role: "user", content: "kept", timestamp: 2 });
		expect(log).toEqual([`entry:1:${kept}`]);
		const reopened = await SessionManager.openReadOnly(ref);
		expect(reopened.getEntries().map((entry) => entry.id)).toEqual([kept]);
		expect(reopened.getOrdinal()).toBe(1);
	});

	it.each([
		{ committed: false, durable: [] as string[] },
		{ committed: true, durable: ["unconfirmed"] },
	])(
		"rejects the unconfirmed write and every later write once the log is lost (committed: $committed)",
		async ({ committed, durable }) => {
			const root = createTempDir();
			const manager = await SessionManager.create(root, root);
			const ref = manager.getSessionRef();
			if (!ref) throw new Error("Expected a persisted session reference");
			const log = observe(manager);
			const faulty = injectFaultyLog(manager);
			faulty.failNext(lose("uncertain_commit", { committed }));

			const unconfirmed = manager.logWriter.appendMessage({ role: "user", content: "unconfirmed", timestamp: 1 });
			const queued = manager.logWriter.appendCustomEntry("queued-behind-the-loss");
			await expect(unconfirmed).rejects.toBeInstanceOf(ConversationLogLostError);
			await expect(queued).rejects.toBeInstanceOf(ConversationLogLostError);
			await expect(manager.lost).resolves.toMatchObject({ reason: "uncertain_commit" });
			await expect(manager.logWriter.appendSessionInfo("after the loss")).rejects.toBe(await manager.lost);
			expect(log).toEqual([]);
			expect(manager.getEntries()).toEqual([]);

			// Closing a lost manager releases its lock; the log holds what actually committed.
			await expect(manager.closePersistence()).resolves.toBeUndefined();
			const reopened = await SessionManager.open(ref);
			expect(
				reopened
					.getEntries()
					.map((entry) =>
						entry.type === "message" && entry.message.role === "user" ? entry.message.content : "",
					),
			).toEqual(durable);
		},
	);

	it("delivers contiguous ordinals across ordinary and atomic commits that readEntries pages back", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root);
		const published: CommittedSessionEntry[] = [];
		manager.subscribeEntries((entry) => published.push(entry));

		const first = await manager.logWriter.appendMessage({ role: "user", content: "first", timestamp: 1 });
		await seedSession(manager, (seed) => seed.clientInput("ordinal-input", "prompt", { message: "host only" }));
		await manager.logWriter.appendCustomMessageEntry("test", "custom", true);
		await manager.logWriter.branch(first);
		await manager.logWriter.appendLabelChange(first, "bookmark");
		// One atomic batch of several entries, host-only and public.
		await seedSession(manager, (seed) =>
			seed
				.custom("atomic", { step: 1 })
				.clientInput("atomic-input", "prompt", { message: "atomic" }, { states: ["started"] })
				.user("atomic", { clientMessageId: "atomic-input" }),
		);
		await manager.logWriter.appendSessionInfo("after atomic");

		const ordinal = manager.getOrdinal();
		const log = await manager.readEntries(0, 1_000);
		expect(log.lastOrdinal).toBe(ordinal);
		expect(log.entries.map((entry) => entry.ordinal)).toEqual(
			Array.from({ length: ordinal }, (_, index) => index + 1),
		);
		expect(log.entries.some(isHostOnlySessionEntry)).toBe(true);
		expect(published).toEqual(log.entries.filter((entry) => !isHostOnlySessionEntry(entry)));

		const paged: CommittedSessionEntry[] = [];
		for (let cursor = 0; cursor < log.lastOrdinal; ) {
			const page = await manager.readEntries(cursor, 2);
			expect(page.entries[0]?.ordinal).toBe(cursor + 1);
			paged.push(...page.entries);
			cursor = page.entries.at(-1)!.ordinal;
		}
		expect(paged).toEqual(log.entries);
		expect(await manager.readEntries(ordinal, 10)).toEqual({ entries: [], lastOrdinal: ordinal });

		// The store holds exactly what was published.
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		await manager.closePersistence();
		const reopened = await SessionManager.openReadOnly(ref);
		expect(await reopened.readEntries(0, 1_000)).toEqual(log);
	});

	it("commits in-memory writes through the same lane and pages their log", async () => {
		const manager = SessionManager.inMemory("/tmp/ws");
		const log = observe(manager);
		const pending = manager.logWriter.appendMessage({ role: "user", content: "first", timestamp: 1 });
		expect(log).toEqual([]);
		const first = await pending;
		expect(log).toEqual([`entry:1:${first}`]);
		const second = await manager.logWriter.appendMessage({ role: "user", content: "second", timestamp: 2 });
		await manager.logWriter.branch(first);
		expect(log).toEqual([`entry:1:${first}`, `entry:2:${second}`, `branch:${second}->${first}`]);
		expect(manager.getOrdinal()).toBe(3);

		expect((await manager.readEntries(1, 1)).entries.map((entry) => entry.id)).toEqual([second]);
		const all = await manager.readEntries(0, 10);
		expect(all.lastOrdinal).toBe(3);
		expect(all.entries.map((entry) => [entry.ordinal, entry.type])).toEqual([
			[1, "message"],
			[2, "message"],
			[3, "leaf"],
		]);
		expect(await manager.readEntries(3, 10)).toEqual({ entries: [], lastOrdinal: 3 });
		await expect(manager.readEntries(0, 0)).rejects.toThrow("limit");
		await expect(manager.readEntries(-1, 1)).rejects.toThrow("afterOrdinal");
	});
});
