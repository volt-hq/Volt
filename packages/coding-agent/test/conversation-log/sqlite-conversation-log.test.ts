import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
	CONVERSATION_LOG_READ_LIMIT_MAX,
	Conversation,
	type ConversationLog,
	type ConversationLogAppend,
	type ConversationLogAppendResult,
	type ConversationLogEntry,
	type ConversationLogEntryDraft,
	type ConversationLogLossReason,
	ConversationLogLostError,
	type ConversationLogPage,
	fold,
	InMemoryConversationLog,
} from "@hansjm10/volt-agent-core";
import * as fc from "fast-check";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ConversationLock, ConversationLockedError } from "../../src/core/conversation-log/conversation-lock.ts";
import { SqliteConversationLog } from "../../src/core/conversation-log/sqlite-conversation-log.ts";
import {
	acquireSharedSQLiteSessionStore,
	SessionStoreError,
	SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "../../src/core/session-store/index.ts";
import { CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES } from "../../src/core/session-store/projection.ts";
import {
	buildDrafts,
	type DraftLogState,
	type DraftOp,
	draftBatchArbitrary,
	EMPTY_DRAFT_LOG,
} from "./session-log-drafts.ts";

const PROPERTY_SEED = 5_850_104;
const CWD = "/workspace/project";

let root: string;
let sessionDirectory: string;
/** Keeps one store worker alive across tests so each log does not start its own. */
let storeLease: SQLiteSessionStoreLease;
const logs: ConversationLog[] = [];
const leases: SQLiteSessionStoreLease[] = [];

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "volt-sqlite-log-"));
	sessionDirectory = join(root, "sessions");
	storeLease = await acquireSharedSQLiteSessionStore(sessionDirectory);
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const log of logs.splice(0)) await log.close();
	for (const lease of leases.splice(0)) await lease.release();
});

afterAll(async () => {
	await storeLease.release();
	rmSync(root, { recursive: true, force: true });
});

async function createLog(): Promise<SqliteConversationLog> {
	const log = await SqliteConversationLog.create({ sessionDirectory, cwd: CWD });
	logs.push(log);
	return log;
}

async function openLog(log: SqliteConversationLog): Promise<SqliteConversationLog> {
	const reopened = await SqliteConversationLog.open(log.ref);
	logs.push(reopened);
	return reopened;
}

/** The store client the logs in `sessionDirectory` currently share. */
async function sharedClient(): Promise<SQLiteSessionStoreClient> {
	const lease = await acquireSharedSQLiteSessionStore(sessionDirectory);
	leases.push(lease);
	return lease.client;
}

/** Kill a client's worker thread the way a crash would: its pending and later requests fail. */
async function crashWorker(client: SQLiteSessionStoreClient): Promise<void> {
	const worker: unknown = Reflect.get(client, "worker");
	if (!(worker instanceof Worker)) throw new Error("The session store client has no worker thread");
	await worker.terminate();
}

function drafts(state: DraftLogState, ops: readonly DraftOp[] = []): ConversationLogEntryDraft[] {
	return buildDrafts(state, ops).drafts;
}

/** Commit ids share one namespace per store; tests scope theirs to the log's session. */
function commitIdFor(log: ConversationLog, name: string): string {
	return `${log.conversationId}:${name}`;
}

function customDraft(id: string, parentId: string | null): ConversationLogEntryDraft {
	return {
		id,
		parentId,
		type: "custom",
		timestamp: "2026-01-01T00:00:00.000Z",
		visibility: "public",
		payload: { customType: "test" },
	};
}

type Observed =
	| { readonly status: "committed"; readonly first: number; readonly last: number }
	| { readonly status: "rolled_back" }
	| { readonly status: "lost"; readonly reason: ConversationLogLossReason };

function lossReason(error: unknown): ConversationLogLossReason {
	if (error instanceof ConversationLogLostError) return error.reason;
	throw error;
}

async function observe(append: Promise<ConversationLogAppendResult>): Promise<Observed> {
	try {
		const result = await append;
		return result.status === "committed"
			? { status: "committed", first: result.first, last: result.last }
			: { status: "rolled_back" };
	} catch (error) {
		return { status: "lost", reason: lossReason(error) };
	}
}

/** The loss a read was rejected with. */
async function readLoss(read: Promise<ConversationLogPage>): Promise<ConversationLogLossReason> {
	try {
		await read;
	} catch (error) {
		return lossReason(error);
	}
	throw new Error("The read was not rejected");
}

// ============================================================================
// Model: the SQLite log behaves exactly like the in-memory reference log
// ============================================================================

interface Model {
	readonly memory: InMemoryConversationLog;
	generated: DraftLogState;
	commits: number;
	/** Batches committed through the current SQLite log instance; idempotency is per instance. */
	retryable: ConversationLogAppend[];
	lost: ConversationLogLossReason | undefined;
}

interface Real {
	log: SqliteConversationLog;
}

/** Run one append against both logs and require identical observable outcomes. */
async function appendBoth(model: Model, real: Real, batch: ConversationLogAppend): Promise<Observed> {
	const expected = await observe(model.memory.append(batch));
	const actual = await observe(real.log.append(batch));
	expect(actual).toEqual(expected);
	expect(real.log.head()).toBe(model.memory.head());
	return expected;
}

async function readBoth(model: Model, real: Real, afterOrdinal: number, limit: number): Promise<ConversationLogPage> {
	const expected = await model.memory.read(afterOrdinal, limit);
	expect(await real.log.read(afterOrdinal, limit)).toEqual(expected);
	return expected;
}

function nextCommitId(model: Model): string {
	model.commits += 1;
	return commitIdFor(model.memory, `commit-${model.commits}`);
}

class AppendCommand implements fc.AsyncCommand<Model, Real> {
	readonly ops: readonly DraftOp[];
	constructor(ops: readonly DraftOp[]) {
		this.ops = ops;
	}
	check(model: Readonly<Model>): boolean {
		return model.lost === undefined;
	}
	async run(model: Model, real: Real): Promise<void> {
		const built = buildDrafts(model.generated, this.ops);
		const head = model.memory.head();
		const batch = { expectedOrdinal: head, commitId: nextCommitId(model), entries: built.drafts };
		expect(await appendBoth(model, real, batch)).toEqual({
			status: "committed",
			first: head + 1,
			last: head + built.drafts.length,
		});
		model.generated = built.state;
		model.retryable.push(batch);
	}
	toString(): string {
		return `append(${this.ops.map((op) => op.kind).join(",")})`;
	}
}

/** Retrying a committed batch returns its original result without appending. */
class RetryCommand implements fc.AsyncCommand<Model, Real> {
	readonly pick: number;
	constructor(pick: number) {
		this.pick = pick;
	}
	check(model: Readonly<Model>): boolean {
		return model.lost === undefined && model.retryable.length > 0;
	}
	async run(model: Model, real: Real): Promise<void> {
		const batch = model.retryable[this.pick % model.retryable.length]!;
		const outcome = await appendBoth(model, real, structuredClone(batch));
		expect(outcome).toEqual({
			status: "committed",
			first: batch.expectedOrdinal + 1,
			last: batch.expectedOrdinal + batch.entries.length,
		});
	}
	toString(): string {
		return `retry(${this.pick})`;
	}
}

/** Reusing a commit id for a different batch rolls back. */
class ReuseCommitIdCommand implements fc.AsyncCommand<Model, Real> {
	readonly pick: number;
	constructor(pick: number) {
		this.pick = pick;
	}
	check(model: Readonly<Model>): boolean {
		return model.lost === undefined && model.retryable.length > 0;
	}
	async run(model: Model, real: Real): Promise<void> {
		const commitId = model.retryable[this.pick % model.retryable.length]!.commitId;
		const batch = { expectedOrdinal: model.memory.head(), commitId, entries: drafts(model.generated) };
		expect(await appendBoth(model, real, batch)).toEqual({ status: "rolled_back" });
	}
	toString(): string {
		return `reuse(${this.pick})`;
	}
}

type InvalidBatch = "empty_commit_id" | "no_entries" | "duplicate_in_batch" | "existing_id";

/** Invalid batches roll back and leave the log writable. */
class InvalidAppendCommand implements fc.AsyncCommand<Model, Real> {
	readonly invalid: InvalidBatch;
	constructor(invalid: InvalidBatch) {
		this.invalid = invalid;
	}
	check(model: Readonly<Model>): boolean {
		return model.lost === undefined && (this.invalid !== "existing_id" || model.generated.ids.length > 0);
	}
	async run(model: Model, real: Real): Promise<void> {
		const head = model.memory.head();
		const leaf = model.generated.leafId;
		const entries: ConversationLogEntryDraft[] =
			this.invalid === "no_entries"
				? []
				: this.invalid === "duplicate_in_batch"
					? [customDraft("duplicate", leaf), customDraft("duplicate", leaf)]
					: this.invalid === "existing_id"
						? [customDraft(model.generated.ids[0]!, leaf)]
						: drafts(model.generated);
		const commitId = this.invalid === "empty_commit_id" ? "" : nextCommitId(model);
		expect(await appendBoth(model, real, { expectedOrdinal: head, commitId, entries })).toEqual({
			status: "rolled_back",
		});
	}
	toString(): string {
		return `invalid(${this.invalid})`;
	}
}

/** Reading after any ordinal, in pages of any size, yields the uninterrupted sequence. */
class ReadCommand implements fc.AsyncCommand<Model, Real> {
	readonly after: number;
	readonly pageSize: number;
	constructor(after: number, pageSize: number) {
		this.after = after;
		this.pageSize = pageSize;
	}
	check(model: Readonly<Model>): boolean {
		return model.lost === undefined;
	}
	async run(model: Model, real: Real): Promise<void> {
		const uninterrupted = await readBoth(model, real, 0, CONVERSATION_LOG_READ_LIMIT_MAX);
		expect(uninterrupted.lastOrdinal).toBe(model.memory.head());
		const afterOrdinal = this.after % (model.memory.head() + 1);
		const resumed: ConversationLogEntry[] = [];
		for (let cursor = afterOrdinal; ; ) {
			const page = await readBoth(model, real, cursor, this.pageSize);
			if (page.entries.length === 0) break;
			resumed.push(...page.entries);
			cursor = page.entries.at(-1)!.ordinal;
		}
		expect(resumed).toEqual(uninterrupted.entries.slice(afterOrdinal));
	}
	toString(): string {
		return `read(${this.after}, ${this.pageSize})`;
	}
}

/** A stale fence loses both logs with `fence_conflict` and appends nothing. */
class StaleFenceCommand implements fc.AsyncCommand<Model, Real> {
	readonly offset: number;
	constructor(offset: number) {
		this.offset = offset;
	}
	check(model: Readonly<Model>): boolean {
		return model.lost === undefined;
	}
	async run(model: Model, real: Real): Promise<void> {
		const head = model.memory.head();
		const expectedOrdinal = head + this.offset >= 0 ? head + this.offset : head - this.offset;
		const batch = { expectedOrdinal, commitId: nextCommitId(model), entries: drafts(model.generated) };
		expect(await appendBoth(model, real, batch)).toEqual({ status: "lost", reason: "fence_conflict" });
		expect((await real.log.lost).reason).toBe("fence_conflict");
		model.lost = "fence_conflict";
	}
	toString(): string {
		return `stale(${this.offset})`;
	}
}

class CloseCommand implements fc.AsyncCommand<Model, Real> {
	check(model: Readonly<Model>): boolean {
		return model.lost === undefined;
	}
	async run(model: Model, real: Real): Promise<void> {
		await model.memory.close();
		await real.log.close();
		expect((await real.log.lost).reason).toBe("closed");
		model.lost = "closed";
	}
	toString(): string {
		return "close";
	}
}

/** A reopened SQLite log continues exactly where the closed one stopped. */
class ReopenCommand implements fc.AsyncCommand<Model, Real> {
	check(model: Readonly<Model>): boolean {
		return model.lost === undefined;
	}
	async run(model: Model, real: Real): Promise<void> {
		await real.log.close();
		real.log = await openLog(real.log);
		expect(real.log.head()).toBe(model.memory.head());
		model.retryable = [];
	}
	toString(): string {
		return "reopen";
	}
}

/** A lost log rejects every append and read with its loss. */
class AfterLossCommand implements fc.AsyncCommand<Model, Real> {
	check(model: Readonly<Model>): boolean {
		return model.lost !== undefined;
	}
	async run(model: Model, real: Real): Promise<void> {
		const batch = {
			expectedOrdinal: model.memory.head(),
			commitId: nextCommitId(model),
			entries: drafts(model.generated),
		};
		expect(await appendBoth(model, real, batch)).toEqual({ status: "lost", reason: model.lost });
		expect(await readLoss(model.memory.read(0, 1))).toBe(model.lost);
		expect(await readLoss(real.log.read(0, 1))).toBe(model.lost);
	}
	toString(): string {
		return "after-loss";
	}
}

const commandArbitrary: fc.Arbitrary<fc.AsyncCommand<Model, Real>> = fc.oneof(
	{ weight: 20, arbitrary: draftBatchArbitrary.map((ops) => new AppendCommand(ops)) },
	{
		weight: 8,
		arbitrary: fc
			.tuple(fc.nat({ max: 200 }), fc.integer({ min: 1, max: 7 }))
			.map(([after, pageSize]) => new ReadCommand(after, pageSize)),
	},
	{ weight: 3, arbitrary: fc.nat({ max: 100 }).map((pick) => new RetryCommand(pick)) },
	{ weight: 2, arbitrary: fc.nat({ max: 100 }).map((pick) => new ReuseCommitIdCommand(pick)) },
	{
		weight: 3,
		arbitrary: fc
			.constantFrom<InvalidBatch>("empty_commit_id", "no_entries", "duplicate_in_batch", "existing_id")
			.map((invalid) => new InvalidAppendCommand(invalid)),
	},
	{ weight: 3, arbitrary: fc.constant(new ReopenCommand()) },
	{
		weight: 1,
		arbitrary: fc
			.integer({ min: -3, max: 3 })
			.filter((offset) => offset !== 0)
			.map((offset) => new StaleFenceCommand(offset)),
	},
	{ weight: 1, arbitrary: fc.constant(new CloseCommand()) },
	{ weight: 1, arbitrary: fc.constant(new AfterLossCommand()) },
);

describe("SqliteConversationLog", () => {
	it("is observably identical to the in-memory log under random appends, reads, retries, and reopens", async () => {
		await fc.assert(
			fc.asyncProperty(fc.commands([commandArbitrary], { maxCommands: 40, size: "max" }), async (commands) => {
				const real: Real = { log: await createLog() };
				const model: Model = {
					memory: new InMemoryConversationLog(real.log.conversationId),
					generated: EMPTY_DRAFT_LOG,
					commits: 0,
					retryable: [],
					lost: undefined,
				};
				await fc.asyncModelRun(() => ({ model, real }), commands);
				await real.log.close();
			}),
			{ seed: PROPERTY_SEED, numRuns: 50 },
		);
	}, 180_000);

	it("opens a created session's log by reference", async () => {
		const log = await createLog();
		expect(log.ref).toMatchObject({ sessionId: log.conversationId, storeId: storeLease.client.info.storeId });
		const { drafts: first, state } = buildDrafts(EMPTY_DRAFT_LOG, [
			{ kind: "user", text: "hello", array: false },
			{ kind: "receipt", command: "prompt", behavior: null, text: "queued" },
		]);
		expect(await log.append({ expectedOrdinal: 0, commitId: commitIdFor(log, "c1"), entries: first })).toEqual({
			status: "committed",
			first: 1,
			last: 2,
		});
		const written = await log.read(0, 10);
		await log.close();
		const reopened = await openLog(log);
		expect(reopened.head()).toBe(2);
		expect(await reopened.read(0, 10)).toEqual(written);
		const next = drafts(state, [{ kind: "transition", pick: 0, choice: 0, error: null }]);
		expect(
			await reopened.append({ expectedOrdinal: 2, commitId: commitIdFor(reopened, "c2"), entries: next }),
		).toEqual({
			status: "committed",
			first: 3,
			last: 3,
		});
		await reopened.close();
		await expect(SqliteConversationLog.open({ ...log.ref, sessionGeneration: "other" })).rejects.toThrow(
			/Session not found/,
		);
		await expect(SqliteConversationLog.open({ ...log.ref, storeId: "other-store" })).rejects.toThrow(
			/different store/,
		);
	});

	it("holds the session's writer lock from open or create until close", async () => {
		const log = await createLog();
		await expect(SqliteConversationLog.open(log.ref)).rejects.toBeInstanceOf(ConversationLockedError);
		await expect(
			SqliteConversationLog.create({ sessionDirectory, cwd: CWD, id: log.conversationId }),
		).rejects.toMatchObject({ code: "conversation_locked", holder: "this_process" });
		await log.close();
		// A failed open releases the lock it took.
		await expect(SqliteConversationLog.open({ ...log.ref, sessionGeneration: "other" })).rejects.toThrow(
			/Session not found/,
		);
		const reopened = await openLog(log);
		await expect(SqliteConversationLog.open(log.ref)).rejects.toBeInstanceOf(ConversationLockedError);
		await reopened.close();
		const acquisition = ConversationLock.tryAcquire(sessionDirectory, log.conversationId);
		expect(acquisition.status).toBe("acquired");
		if (acquisition.status === "acquired") acquisition.lock.close();
	});

	it("rolls back entries the session store does not hold and stays writable", async () => {
		const log = await createLog();
		const forked = { ...customDraft("a", null), type: "forked_from", visibility: "host", payload: {} };
		for (const entries of [
			[forked],
			[{ ...customDraft("a", null), visibility: "host" }],
			[customDraft("a", "missing-parent")],
			[{ ...customDraft("a", null), payload: { customType: "test", id: "b" } }],
		] as ConversationLogEntryDraft[][]) {
			expect((await log.append({ expectedOrdinal: 0, commitId: commitIdFor(log, "c1"), entries })).status).toBe(
				"rolled_back",
			);
		}
		expect(log.head()).toBe(0);
		expect(
			await log.append({ expectedOrdinal: 0, commitId: commitIdFor(log, "c1"), entries: [customDraft("a", null)] }),
		).toEqual({ status: "committed", first: 1, last: 1 });
	});

	it("stores the client inputs the kernel writes: host messages and withdrawn inputs", async () => {
		const log = await createLog();
		const conversation = await Conversation.open({
			log,
			stream: () => {
				throw new Error("No request is expected");
			},
			resolveModel: () => undefined,
		});
		const notice = { role: "custom" as const, customType: "notice", content: "wake", display: true, timestamp: 1 };
		const host = await conversation.queueMessages("followUp", [notice]);
		const client = await conversation.followUp({ clientMessageId: "client-1", message: "later" });
		await conversation.clearQueue();
		expect(await host.completion).toEqual({ state: "withdrawn" });
		expect(await client.completion).toEqual({ state: "withdrawn" });
		await conversation.close();

		const reopened = await openLog(log);
		const projected = new Map(
			reopened.takeOpenedSnapshot().clientInputs.map((input) => [input.clientMessageId, input]),
		);
		expect(projected.get(host.clientMessageId)).toMatchObject({
			command: "follow_up",
			origin: "host",
			queuedInput: { delivery: "follow_up", message: "", images: [], messages: [notice] },
			state: "withdrawn",
		});
		expect(projected.get("client-1")).toMatchObject({ origin: null, state: "withdrawn" });
		const folded = fold((await reopened.read(0, 100)).entries).clientInputs.inputs;
		expect(folded.get(host.clientMessageId)).toMatchObject({ origin: "host", state: "withdrawn" });
		expect(folded.get("client-1")?.state).toBe("withdrawn");

		// Nothing moves a withdrawn input, and only a host input queues messages.
		const head = reopened.head();
		const rejection = async (name: string, entries: ConversationLogEntryDraft[]): Promise<string> => {
			const result = await reopened.append({
				expectedOrdinal: head,
				commitId: commitIdFor(reopened, name),
				entries,
			});
			return result.status === "rolled_back" ? result.error.message : result.status;
		};
		const hostDraft = (id: string, type: string, payload: unknown): ConversationLogEntryDraft =>
			({
				id,
				parentId: null,
				type,
				timestamp: "2026-01-01T00:00:00.000Z",
				visibility: "host",
				payload,
			}) as ConversationLogEntryDraft;
		const receiptId = folded.get("client-1")?.receiptId;
		expect(
			await rejection("c1", [
				hostDraft("after", "client_input_state", { receiptId, clientMessageId: "client-1", state: "started" }),
			]),
		).toMatch("follows a terminal state");
		const [receipt] = drafts(EMPTY_DRAFT_LOG, [{ kind: "receipt", command: "steer", behavior: null, text: "" }]);
		const queuedInput = { delivery: "steer", message: "", images: [], messages: [notice] };
		expect(
			await rejection("c2", [
				{
					...receipt,
					id: "client-2-receipt",
					payload: { ...(receipt?.payload as object), clientMessageId: "client-2" },
				} as ConversationLogEntryDraft,
				hostDraft("client-2-queued", "client_input_queued", {
					receiptId: "client-2-receipt",
					clientMessageId: "client-2",
					queuedInput,
				}),
			]),
		).toMatch("only a host input may");
		expect(reopened.head()).toBe(head);
	});

	it("counts withdrawn client inputs as settled toward the outstanding limit", async () => {
		const log = await createLog();
		const receipts = Array.from(
			{ length: CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES },
			(_, index): DraftOp => ({
				kind: "receipt",
				command: "steer",
				behavior: null,
				text: `input ${index}`,
			}),
		);
		const admitted = buildDrafts(EMPTY_DRAFT_LOG, receipts);
		let head = 0;
		const append = async (name: string, entries: ConversationLogEntryDraft[]) => {
			const result = await log.append({ expectedOrdinal: head, commitId: commitIdFor(log, name), entries });
			if (result.status === "committed") head = result.last;
			return result.status;
		};
		expect(await append("admit", admitted.drafts)).toBe("committed");
		const oneMore = buildDrafts(admitted.state, [
			{ kind: "receipt", command: "steer", behavior: null, text: "over" },
		]);
		expect(await append("over-limit", oneMore.drafts)).toBe("rolled_back");
		const withdrawals = Array.from(
			{ length: CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES },
			(): DraftOp => ({ kind: "transition", pick: 0, choice: 3, error: null }),
		);
		const withdrawn = buildDrafts(admitted.state, withdrawals);
		expect(withdrawn.state.inputs.every((input) => input.state === "withdrawn")).toBe(true);
		expect(await append("withdraw", withdrawn.drafts)).toBe("committed");
		const next = buildDrafts(withdrawn.state, [{ kind: "receipt", command: "steer", behavior: null, text: "next" }]);
		expect(await append("after-withdrawal", next.drafts)).toBe("committed");
	});

	it("loses the log on a fence conflict with another writer", async () => {
		const stale = await createLog();
		// An OS lock gives no loss signal: lose the stale writer's lock so another writer can open the log.
		(Reflect.get(stale, "lock") as ConversationLock).close();
		const writer = await openLog(stale);
		await writer.append({
			expectedOrdinal: 0,
			commitId: commitIdFor(writer, "c1"),
			entries: [customDraft("a", null)],
		});
		const rejected = stale.append({
			expectedOrdinal: 0,
			commitId: commitIdFor(stale, "c2"),
			entries: [customDraft("b", null)],
		});
		await expect(rejected).rejects.toBeInstanceOf(ConversationLogLostError);
		const lost = await stale.lost;
		expect(lost.reason).toBe("fence_conflict");
		await expect(rejected).rejects.toBe(lost);
		expect(stale.head()).toBe(0);
		expect((await writer.read(0, 10)).entries.map((entry) => entry.id)).toEqual(["a"]);
	});

	it("loses the log with reason storage when its session is deleted", async () => {
		const log = await createLog();
		const reader = await createLog();
		const client = await sharedClient();
		for (const deleted of [log, reader]) {
			await deleted.append({
				expectedOrdinal: 0,
				commitId: commitIdFor(deleted, "c1"),
				entries: [customDraft("a", null)],
			});
			expect(
				await client.deleteSession({
					sessionId: deleted.ref.sessionId,
					sessionGeneration: deleted.ref.sessionGeneration,
					expectedOrdinal: 1,
				}),
			).toEqual({ status: "deleted" });
		}
		await expect(
			log.append({ expectedOrdinal: 1, commitId: commitIdFor(log, "c2"), entries: [customDraft("b", "a")] }),
		).rejects.toMatchObject({ reason: "storage" });
		expect((await log.lost).reason).toBe("storage");
		await expect(reader.read(0, 10)).rejects.toMatchObject({ reason: "storage" });
		expect((await reader.lost).reason).toBe("storage");
	});

	it("loses the log with reason closed on close", async () => {
		const log = await createLog();
		await log.close();
		const lost = await log.lost;
		expect(lost.reason).toBe("closed");
		await expect(
			log.append({ expectedOrdinal: 0, commitId: commitIdFor(log, "c1"), entries: [customDraft("a", null)] }),
		).rejects.toBe(lost);
		await expect(log.read(0, 1)).rejects.toBe(lost);
		await log.close();
		expect((await log.lost).reason).toBe("closed");
	});

	describe("when the store worker crashes during a commit", () => {
		it("resolves a commit that became durable before the crash as committed", async () => {
			const log = await createLog();
			const client = await sharedClient();
			const applyTransaction = client.applyTransaction.bind(client);
			vi.spyOn(client, "applyTransaction").mockImplementationOnce(async (input) => {
				await applyTransaction(input);
				await crashWorker(client);
				throw new SessionStoreError("worker_failed", "Session store worker exited unexpectedly with code 1");
			});
			const { drafts: batch, state } = buildDrafts(EMPTY_DRAFT_LOG, [
				{ kind: "user", text: "durable", array: false },
				{ kind: "name", name: "Named" },
			]);
			expect(await log.append({ expectedOrdinal: 0, commitId: commitIdFor(log, "c1"), entries: batch })).toEqual({
				status: "committed",
				first: 1,
				last: 2,
			});
			expect(log.head()).toBe(2);
			// The log replaced the crashed client and keeps its derived state.
			const next = drafts(state, [{ kind: "user", text: "after", array: false }]);
			expect(await log.append({ expectedOrdinal: 2, commitId: commitIdFor(log, "c2"), entries: next })).toEqual({
				status: "committed",
				first: 3,
				last: 3,
			});
			await log.close();
			const reopened = await openLog(log);
			expect((await reopened.read(0, 10)).entries.map((entry) => entry.id)).toEqual(["e-1", "e-2", "e-3"]);
		});

		it("resolves a commit the crash prevented as rolled back and stays writable", async () => {
			const log = await createLog();
			const client = await sharedClient();
			const applyTransaction = client.applyTransaction.bind(client);
			vi.spyOn(client, "applyTransaction").mockImplementationOnce(async (input) => {
				await crashWorker(client);
				return applyTransaction(input);
			});
			const batch = drafts(EMPTY_DRAFT_LOG, [{ kind: "user", text: "lost in the crash", array: false }]);
			const result = await log.append({ expectedOrdinal: 0, commitId: commitIdFor(log, "c1"), entries: batch });
			expect(result.status).toBe("rolled_back");
			expect(log.head()).toBe(0);
			expect(await log.read(0, 10)).toEqual({ entries: [], lastOrdinal: 0 });
			expect(await log.append({ expectedOrdinal: 0, commitId: commitIdFor(log, "c1"), entries: batch })).toEqual({
				status: "committed",
				first: 1,
				last: 1,
			});
		});

		it("loses the log with reason uncertain_commit when the outcome cannot be determined", async () => {
			const log = await createLog();
			const client = await sharedClient();
			vi.spyOn(client, "applyTransaction").mockImplementationOnce(async () => {
				await crashWorker(client);
				throw new SessionStoreError("worker_failed", "Session store worker exited unexpectedly with code 1");
			});
			vi.spyOn(SQLiteSessionStoreClient.prototype, "reconcileCommit").mockRejectedValue(
				new SessionStoreError("store_io_error", "disk I/O error"),
			);
			const batch = drafts(EMPTY_DRAFT_LOG, [{ kind: "user", text: "unknown", array: false }]);
			const rejected = log.append({ expectedOrdinal: 0, commitId: commitIdFor(log, "c1"), entries: batch });
			await expect(rejected).rejects.toBeInstanceOf(ConversationLogLostError);
			const lost = await log.lost;
			expect(lost.reason).toBe("uncertain_commit");
			await expect(rejected).rejects.toBe(lost);
			await expect(
				log.append({ expectedOrdinal: 0, commitId: commitIdFor(log, "c2"), entries: batch }),
			).rejects.toBe(lost);
		});

		it("retries a read through a replacement client", async () => {
			const log = await createLog();
			await log.append({ expectedOrdinal: 0, commitId: commitIdFor(log, "c1"), entries: [customDraft("a", null)] });
			await crashWorker(await sharedClient());
			expect((await log.read(0, 10)).entries.map((entry) => entry.id)).toEqual(["a"]);
		});
	});
});
