import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONVERSATION_LOG_READ_LIMIT_MAX, InMemoryConversationLog } from "../../src/conversation/in-memory-log.ts";
import {
	type ConversationLogEntry,
	type ConversationLogEntryDraft,
	ConversationLogLostError,
} from "../../src/conversation/log.ts";
import { logArbitrary } from "./log-generators.ts";

const PROPERTY_SEED = 5_850_101;

function draftOf(entry: ConversationLogEntry): ConversationLogEntryDraft {
	const { ordinal: _ordinal, ...draft } = entry;
	return draft as ConversationLogEntryDraft;
}

function draft(id: string, parentId: string | null = null): ConversationLogEntryDraft {
	return {
		id,
		parentId,
		type: "custom",
		timestamp: "2026-01-01T00:00:00.000Z",
		visibility: "public",
		payload: { customType: "test" },
	};
}

/** Split `entries` into consecutive non-empty batches at the given cut points. */
function batches<T>(entries: readonly T[], cuts: readonly number[]): T[][] {
	const points = [...new Set(cuts.map((cut) => cut % (entries.length + 1)))].sort((a, b) => a - b);
	const result: T[][] = [];
	let start = 0;
	for (const point of [...points, entries.length]) {
		if (point > start) result.push(entries.slice(start, point));
		start = Math.max(start, point);
	}
	return result;
}

async function appendAll(
	log: InMemoryConversationLog,
	entries: readonly ConversationLogEntry[],
	cuts: readonly number[],
): Promise<void> {
	for (const [index, batch] of batches(entries, cuts).entries()) {
		const result = await log.append({
			expectedOrdinal: log.head(),
			commitId: `commit-${index}`,
			entries: batch.map(draftOf),
		});
		expect(result).toEqual({ status: "committed", first: batch[0]?.ordinal, last: batch.at(-1)?.ordinal });
	}
}

async function readAll(
	log: InMemoryConversationLog,
	afterOrdinal: number,
	pageSize: number,
): Promise<ConversationLogEntry[]> {
	const entries: ConversationLogEntry[] = [];
	let cursor = afterOrdinal;
	for (;;) {
		const page = await log.read(cursor, pageSize);
		expect(page.lastOrdinal).toBe(log.head());
		expect(page.entries.length).toBeLessThanOrEqual(pageSize);
		if (page.entries.length === 0) return entries;
		entries.push(...page.entries);
		cursor = page.entries.at(-1)?.ordinal ?? cursor;
	}
}

describe("InMemoryConversationLog", () => {
	it("assigns contiguous ordinals and returns frozen copies", async () => {
		const log = new InMemoryConversationLog("conversation-1");
		const first = draft("a");
		expect(log.head()).toBe(0);
		expect(await log.append({ expectedOrdinal: 0, commitId: "c1", entries: [first] })).toEqual({
			status: "committed",
			first: 1,
			last: 1,
		});
		expect(
			await log.append({ expectedOrdinal: 1, commitId: "c2", entries: [draft("b", "a"), draft("c", "b")] }),
		).toEqual({ status: "committed", first: 2, last: 3 });
		(first.payload as { customType: string }).customType = "mutated";
		const page = await log.read(0, 10);
		expect(page.entries.map((entry) => [entry.ordinal, entry.id])).toEqual([
			[1, "a"],
			[2, "b"],
			[3, "c"],
		]);
		expect(page.entries[0]?.payload).toEqual({ customType: "test" });
		expect(Object.isFrozen(page.entries[0])).toBe(true);
		expect(Object.isFrozen(page.entries[0]?.payload)).toBe(true);
		expect(page.lastOrdinal).toBe(3);
	});

	it("returns the original result for a retried commit and rejects a reused commit id", async () => {
		const log = new InMemoryConversationLog("conversation-1");
		const batch = { expectedOrdinal: 0, commitId: "c1", entries: [draft("a")] };
		const committed = await log.append(batch);
		expect(await log.append(structuredClone(batch))).toEqual(committed);
		expect(log.head()).toBe(1);
		const conflict = await log.append({ expectedOrdinal: 0, commitId: "c1", entries: [draft("b")] });
		expect(conflict.status).toBe("rolled_back");
		expect(log.head()).toBe(1);
		expect(await log.append({ expectedOrdinal: 1, commitId: "c2", entries: [draft("b", "a")] })).toEqual({
			status: "committed",
			first: 2,
			last: 2,
		});
	});

	it("rolls back invalid batches and stays writable", async () => {
		const log = new InMemoryConversationLog("conversation-1");
		await log.append({ expectedOrdinal: 0, commitId: "c1", entries: [draft("a")] });
		for (const batch of [
			{ expectedOrdinal: 1, commitId: "", entries: [draft("b")] },
			{ expectedOrdinal: 1, commitId: "c2", entries: [] },
			{ expectedOrdinal: 1, commitId: "c3", entries: [draft("a")] },
			{ expectedOrdinal: 1, commitId: "c4", entries: [draft("b"), draft("b")] },
		]) {
			expect((await log.append(batch)).status).toBe("rolled_back");
		}
		expect(log.head()).toBe(1);
		expect((await log.append({ expectedOrdinal: 1, commitId: "c2", entries: [draft("b")] })).status).toBe(
			"committed",
		);
	});

	it("bounds reads", async () => {
		const log = new InMemoryConversationLog("conversation-1");
		await expect(log.read(-1, 1)).rejects.toThrow(RangeError);
		await expect(log.read(0, 0)).rejects.toThrow(RangeError);
		await expect(log.read(0, CONVERSATION_LOG_READ_LIMIT_MAX + 1)).rejects.toThrow(RangeError);
		await expect(log.read(5, CONVERSATION_LOG_READ_LIMIT_MAX)).resolves.toEqual({ entries: [], lastOrdinal: 0 });
	});

	it("is lost with reason closed after close", async () => {
		const log = new InMemoryConversationLog("conversation-1");
		await log.close();
		const lost = await log.lost;
		expect(lost).toBeInstanceOf(ConversationLogLostError);
		expect(lost.reason).toBe("closed");
		await expect(log.append({ expectedOrdinal: 0, commitId: "c1", entries: [draft("a")] })).rejects.toBe(lost);
		await expect(log.read(0, 1)).rejects.toBe(lost);
		await log.close();
		expect((await log.lost).reason).toBe("closed");
	});

	it("resuming after any ordinal in pages of any size yields the uninterrupted sequence", async () => {
		await fc.assert(
			fc.asyncProperty(
				logArbitrary,
				fc.array(fc.nat(), { maxLength: 6 }),
				fc.nat(),
				fc.integer({ min: 1, max: 12 }),
				async (entries, cuts, after, pageSize) => {
					const log = new InMemoryConversationLog("conversation-1");
					await appendAll(log, entries, cuts);
					expect(log.head()).toBe(entries.length);
					const uninterrupted = await readAll(log, 0, CONVERSATION_LOG_READ_LIMIT_MAX);
					expect(uninterrupted).toEqual(entries);
					const afterOrdinal = after % (entries.length + 1);
					expect(await readAll(log, afterOrdinal, pageSize)).toEqual(uninterrupted.slice(afterOrdinal));
				},
			),
			{ seed: PROPERTY_SEED, numRuns: 150 },
		);
	});

	it("the fence rejects every stale expectedOrdinal without appending", async () => {
		await fc.assert(
			fc.asyncProperty(logArbitrary, fc.array(fc.nat(), { maxLength: 4 }), async (entries, cuts) => {
				for (let stale = 0; stale <= entries.length + 2; stale++) {
					if (stale === entries.length) continue;
					const log = new InMemoryConversationLog("conversation-1");
					await appendAll(log, entries, cuts);
					const rejected = log.append({
						expectedOrdinal: stale,
						commitId: "stale",
						entries: [draft("stale-entry")],
					});
					await expect(rejected).rejects.toBeInstanceOf(ConversationLogLostError);
					const lost = await log.lost;
					expect(lost.reason).toBe("fence_conflict");
					await expect(rejected).rejects.toBe(lost);
					expect(log.head()).toBe(entries.length);
					await expect(
						log.append({ expectedOrdinal: entries.length, commitId: "next", entries: [draft("next-entry")] }),
					).rejects.toBe(lost);
					expect(log.head()).toBe(entries.length);
				}
			}),
			{ seed: PROPERTY_SEED, numRuns: 60 },
		);
	});
});
