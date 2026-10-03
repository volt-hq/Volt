import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONVERSATION_LOG_READ_LIMIT_MAX,
	type ConversationLog,
	type ConversationLogEntry,
	type ConversationState,
	clientInputRecovery,
	fold,
} from "@hansjm10/volt-agent-core";
import * as fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { acquireSharedSQLiteSessionStore, type SQLiteSessionStoreLease } from "../../src/core/session-store/index.ts";
import { buildDrafts, type DraftLogState, draftBatchArbitrary, EMPTY_DRAFT_LOG } from "./session-log-drafts.ts";

// The durable queue and its recovery plan are folded from client input
// entries. However the log is read, in pages of any size or as a session's
// view folds whatever committed since its last read, the plan is the one the
// whole log folds to.

const PROPERTY_SEED = 5_850_801;

let root: string;
let sessionDirectory: string;
/** Keeps one store worker alive across generated cases. */
let storeLease: SQLiteSessionStoreLease;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "volt-client-input-recovery-"));
	sessionDirectory = join(root, "sessions");
	storeLease = await acquireSharedSQLiteSessionStore(sessionDirectory);
});

afterAll(async () => {
	await storeLease.release();
	rmSync(root, { recursive: true, force: true });
});

async function readAll(log: ConversationLog): Promise<ConversationLogEntry[]> {
	const entries: ConversationLogEntry[] = [];
	for (;;) {
		const page = await log.read(entries.length, CONVERSATION_LOG_READ_LIMIT_MAX);
		if (page.entries.length === 0) return entries;
		entries.push(...page.entries);
	}
}

/** Fold the log page by page; `limits` gives the size of each page in turn. */
async function foldInPages(log: ConversationLog, limits: readonly number[]): Promise<ConversationState> {
	let state = fold([]);
	for (let page = 0; ; page++) {
		const { entries } = await log.read(state.ordinal, limits[page % limits.length]!);
		if (entries.length === 0) return state;
		state = fold(entries, state);
	}
}

const batchesArbitrary = fc.array(fc.record({ ops: draftBatchArbitrary, read: fc.boolean() }), { maxLength: 16 });
const pageLimitsArbitrary = fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 4 });

describe("client input recovery", () => {
	it.each([
		{ store: "memory" as const, numRuns: 100 },
		{ store: "sqlite" as const, numRuns: 25 },
	])("is invariant under chunked reads of a $store log", async ({ store, numRuns }) => {
		await fc.assert(
			fc.asyncProperty(batchesArbitrary, pageLimitsArbitrary, async (batches, pageLimits) => {
				const cwd = join(root, "workspace");
				const manager =
					store === "memory" ? SessionManager.inMemory(cwd) : await SessionManager.create(cwd, sessionDirectory);
				const log = manager.takeLog();
				try {
					let drafts: DraftLogState = EMPTY_DRAFT_LOG;
					const reads: ConversationState[] = [];
					for (const { ops, read } of batches) {
						const built = buildDrafts(drafts, ops);
						if (built.drafts.length > 0) {
							const result = await log.append({
								expectedOrdinal: log.head(),
								commitId: randomUUID(),
								entries: built.drafts,
							});
							if (result.status === "committed") drafts = built.state;
						}
						// The manager's view folds what committed since it was last read.
						if (read) reads.push(manager.getConversationState());
					}

					const entries = await readAll(log);
					const expected = clientInputRecovery(fold(entries));
					expect(clientInputRecovery(await foldInPages(log, pageLimits))).toEqual(expected);
					expect(clientInputRecovery(manager.getConversationState())).toEqual(expected);
					for (const state of reads) {
						expect(clientInputRecovery(state)).toEqual(
							clientInputRecovery(fold(entries.slice(0, state.ordinal))),
						);
					}
				} finally {
					await log.close();
				}
			}),
			{ seed: PROPERTY_SEED, numRuns },
		);
	});
});
