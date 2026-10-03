import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CommittedSessionEntry, isHostOnlySessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore } from "../../src/core/session-store/index.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";

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
	it("publishes ordinary appends only after their store transactions resolve", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root);
		const log = observe(manager);
		const lease = await acquireSharedSQLiteSessionStore(root);
		const applyTransaction = lease.client.applyTransaction.bind(lease.client);
		let markDurable!: () => void;
		const durable = new Promise<void>((resolve) => {
			markDurable = resolve;
		});
		let releaseResult!: () => void;
		const resultGate = new Promise<void>((resolve) => {
			releaseResult = resolve;
		});
		const applySpy = vi.spyOn(lease.client, "applyTransaction").mockImplementation(async (input) => {
			const result = await applyTransaction(input);
			markDurable();
			await resultGate;
			return result;
		});

		try {
			const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
			const second = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
			manager.branch(first);
			const third = manager.appendMessage({ role: "user", content: "third", timestamp: 3 });
			await durable;

			// The first transaction is durable but has not resolved; nothing is published.
			expect(log).toEqual([]);
			expect(manager.getCommittedOrdinal()).toBe(0);
			expect(manager.getIndexedOrdinal()).toBe(4);
			expect(manager.getLeafId()).toBe(third);

			releaseResult();
			await manager.flush();
			expect(log).toEqual([
				`entry:1:${first}`,
				`entry:2:${second}`,
				`branch:${second}->${first}`,
				`entry:4:${third}`,
			]);
			expect(manager.getCommittedOrdinal()).toBe(4);
		} finally {
			releaseResult();
			applySpy.mockRestore();
			await lease.release();
		}
	});

	it("never publishes an entry whose commit fails", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root);
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");
		const log = observe(manager);
		const lease = await acquireSharedSQLiteSessionStore(root);
		const applySpy = vi
			.spyOn(lease.client, "applyTransaction")
			.mockRejectedValue(new Error("injected commit failure"));

		try {
			const first = manager.appendMessage({ role: "user", content: "lost", timestamp: 1 });
			manager.branch(first);
			manager.appendCustomMessageEntry("test", "queued behind the failure", true);
			await expect(manager.flush()).rejects.toThrow("rolled back");
			expect(log).toEqual([]);
			expect(manager.getConversationAuthorityStatus().status).toBe("reconciliation_required");
		} finally {
			applySpy.mockRestore();
			await lease.release();
		}

		const reopened = await SessionManager.openReadOnly(ref);
		expect(reopened.getEntries()).toEqual([]);
		expect(reopened.getCommittedOrdinal()).toBe(0);
	});

	it("delivers contiguous ordinals across ordinary and atomic commits that readEntries pages back", async () => {
		const root = createTempDir();
		const manager = await SessionManager.create(root, root);
		const published: CommittedSessionEntry[] = [];
		manager.subscribeEntries((entry) => published.push(entry));

		const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		manager.reserveClientInput("ordinal-input", "prompt", { message: "host only" });
		manager.appendCustomMessageEntry("test", "custom", true);
		manager.branch(first);
		manager.appendLabelChange(first, "bookmark");
		await manager.commitCanonicalCommand({
			guard: { kind: "exact", token: manager.issueCanonicalProjection().token },
			mutations: [
				{ kind: "append", entry: { type: "custom", customType: "atomic", data: { step: 1 } } },
				{ kind: "append", entry: { type: "session_info", name: "atomic" } },
			],
		});
		manager.appendSessionInfo("after atomic");
		await manager.flush();

		const committedOrdinal = manager.getCommittedOrdinal();
		expect(committedOrdinal).toBe(manager.getIndexedOrdinal());
		const log = await manager.readEntries(0, 1_000);
		expect(log.lastOrdinal).toBe(committedOrdinal);
		expect(log.entries.map((entry) => entry.ordinal)).toEqual(
			Array.from({ length: committedOrdinal }, (_, index) => index + 1),
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
		expect(await manager.readEntries(committedOrdinal, 10)).toEqual({ entries: [], lastOrdinal: committedOrdinal });
	});

	it("publishes in-memory appends at the append and pages their log", async () => {
		const manager = SessionManager.inMemory("/tmp/ws");
		const log = observe(manager);
		const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		expect(log).toEqual([`entry:1:${first}`]);
		const second = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
		manager.branch(first);
		expect(log).toEqual([`entry:1:${first}`, `entry:2:${second}`, `branch:${second}->${first}`]);
		expect(manager.getCommittedOrdinal()).toBe(3);

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
