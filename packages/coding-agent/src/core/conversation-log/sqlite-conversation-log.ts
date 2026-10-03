/**
 * The coding-agent {@link ConversationLog} over the SQLite session store
 * (RFC §4.1). One session row is one log; its entries are the store's entries
 * and its ordinals are the store's ordinals.
 *
 * An append is one `apply_transaction`, fenced on `expectedOrdinal` and keyed
 * by its `commitId` and payload digest. The log keeps the derived session state
 * (the reducer the store validates against) so it can compute each
 * transaction's session row projection, client inputs, and search chunks from
 * the appended entries alone. Commit ids share one namespace per store, so
 * writers use unique ones; an id the store already bound to a different
 * transaction rolls back.
 *
 * A failed commit request is resolved before the append settles: the log waits
 * for a failed worker to exit, then asks the store for the commit's evidence and
 * the log head. With a single writer that answer is final; anything it cannot
 * resolve loses the log (`uncertain_commit`). A fence conflict, or a session
 * that no longer exists, also loses the log; neither is reported as an append
 * result.
 */

import { randomUUID } from "node:crypto";
import {
	CONVERSATION_LOG_READ_LIMIT_MAX,
	type ConversationLog,
	type ConversationLogAppend,
	type ConversationLogAppendResult,
	type ConversationLogEntry,
	type ConversationLogEntryDraft,
	type ConversationLogLossReason,
	ConversationLogLostError,
	type ConversationLogPage,
	uuidv7,
} from "@hansjm10/volt-agent-core";
import { LOG_ENTRY_ENVELOPE_KEYS, type LogEntryType, type LogEntryVisibility } from "@hansjm10/volt-protocol/entries";
import { resolvePath } from "../../utils/paths.ts";
import { decodeStoredSessionEntry, parsePersistedSessionEntry, parseSessionReference } from "../session-entry-codec.ts";
import { SESSION_ENTRY_TYPES } from "../session-entry-types.ts";
import {
	assertValidSessionId,
	CURRENT_SESSION_VERSION,
	type SessionEntry,
	type SessionHeader,
	type SessionOrigin,
	type SessionReference,
} from "../session-manager.ts";
import {
	acquireSharedSQLiteSessionStore,
	digestSessionStoreTransactionPayload,
	type SessionStoreApplyTransactionInput,
	type SessionStoreCommitReconciliation,
	type SessionStoreJsonValue,
	type SessionStoreSnapshot,
	type SessionStoreTransactionPayload,
	type SessionStoreTransactionResult,
	type SQLiteSessionStoreClient,
	type SQLiteSessionStoreLease,
} from "../session-store/index.ts";
import {
	applySessionEntry,
	cloneSessionDerivedState,
	replaySessionEntries,
	type SessionDerivedState,
	sessionStoreClientInputsForEntries,
	sessionStoreProjection,
	sessionStoreSearchChunksForEntries,
	verifySessionStoreProjections,
} from "../session-store/projection.ts";

type StoredEntry = SessionEntry & { ordinal: number };

type CommittedResult = ConversationLogAppendResult & { readonly status: "committed" };

interface CommitRecord {
	readonly expectedOrdinal: number;
	readonly entries: readonly ConversationLogEntryDraft[];
	readonly result: CommittedResult;
}

interface PreparedCommit {
	readonly input: SessionStoreApplyTransactionInput;
	readonly state: SessionDerivedState;
	readonly last: number;
}

interface EntryShape {
	readonly visibility: LogEntryVisibility;
	/** Fields stored beside the envelope that are not payload (the message entry's `clientMessageId`). */
	readonly extensions: ReadonlySet<string>;
}

export interface SqliteConversationLogCreateOptions {
	/** The session store directory. */
	readonly sessionDirectory: string;
	readonly cwd: string;
	/** The session id; a new UUIDv7 when omitted. */
	readonly id?: string;
	readonly parentSession?: SessionReference;
	readonly origin?: SessionOrigin;
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set(LOG_ENTRY_ENVELOPE_KEYS);
const STORED_ENVELOPE_KEYS: ReadonlySet<string> = new Set(["type", "id", "parentId", "timestamp", "ordinal"]);
const ENTRY_SHAPES: ReadonlyMap<string, EntryShape> = new Map(
	Object.values(SESSION_ENTRY_TYPES).map((definition: LogEntryType) => [
		definition.type,
		{
			visibility: definition.visibility,
			extensions: new Set(Object.keys(definition.schema.properties).filter((key) => !ENVELOPE_KEYS.has(key))),
		},
	]),
);

function entryShape(type: string): EntryShape {
	const shape = ENTRY_SHAPES.get(type);
	if (!shape) throw new Error(`Entry type ${JSON.stringify(type)} is not stored in session logs`);
	return shape;
}

/** The stored form of a draft: its envelope and extension fields flattened beside its payload fields. */
function storedEntry(draft: ConversationLogEntryDraft, ordinal: number): StoredEntry {
	const shape = entryShape(draft.type);
	const { id, parentId, type, timestamp, visibility, payload, ...extensions } = draft;
	if (visibility !== shape.visibility) {
		throw new Error(`Entry type ${JSON.stringify(type)} has ${shape.visibility} visibility`);
	}
	for (const key of Object.keys(extensions)) {
		if (!shape.extensions.has(key)) throw new Error(`Entry field ${JSON.stringify(key)} is not part of ${type}`);
	}
	const fields: unknown = payload;
	if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
		throw new Error(`Entry ${JSON.stringify(id)} payload must be an object`);
	}
	for (const key of Object.keys(fields)) {
		if (ENVELOPE_KEYS.has(key) || shape.extensions.has(key)) {
			throw new Error(`Entry ${JSON.stringify(id)} payload field ${JSON.stringify(key)} is an envelope field`);
		}
	}
	return parsePersistedSessionEntry({ ...fields, ...extensions, type, id, parentId, timestamp, ordinal });
}

/** The log form of a stored entry: its envelope, its fixed visibility, and its payload. */
function logEntry(entry: StoredEntry): ConversationLogEntry {
	const shape = entryShape(entry.type);
	const payload: Record<string, unknown> = {};
	const extensions: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(entry)) {
		if (STORED_ENVELOPE_KEYS.has(key)) continue;
		if (shape.extensions.has(key)) extensions[key] = value;
		else payload[key] = value;
	}
	return {
		ordinal: entry.ordinal,
		id: entry.id,
		parentId: entry.parentId,
		type: entry.type,
		timestamp: entry.timestamp,
		visibility: shape.visibility,
		payload,
		...extensions,
	};
}

/** Structural equality of JSON data; object key order does not matter. */
function sameJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
	const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => Object.hasOwn(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]))
	);
}

function rolledBack(error: unknown): ConversationLogAppendResult {
	return { status: "rolled_back", error: error instanceof Error ? error : new Error(String(error)) };
}

/** Rebuild the derived session state from a snapshot and check it against the stored projections. */
function replaySnapshot(snapshot: SessionStoreSnapshot): SessionDerivedState {
	const summary = snapshot.session;
	if (summary.formatVersion !== CURRENT_SESSION_VERSION) {
		throw new Error(`Session entry version must be ${CURRENT_SESSION_VERSION}`);
	}
	const header: SessionHeader = {
		type: "session",
		version: summary.formatVersion,
		id: summary.id,
		timestamp: summary.createdAt,
		cwd: summary.cwd,
	};
	const state = replaySessionEntries(
		header,
		snapshot.entries.map((entry) => decodeStoredSessionEntry(entry)),
	);
	verifySessionStoreProjections(state, snapshot);
	return state;
}

async function releaseAfterFailure(lease: SQLiteSessionStoreLease, error: unknown): Promise<never> {
	try {
		await lease.release();
	} catch (releaseError) {
		throw new AggregateError(
			[error, releaseError],
			"Opening the conversation log failed and its store lease could not be released",
		);
	}
	throw error;
}

export class SqliteConversationLog implements ConversationLog {
	readonly conversationId: string;
	/** The session this log writes. */
	readonly ref: SessionReference;
	readonly lost: Promise<ConversationLogLostError>;
	private lease: SQLiteSessionStoreLease;
	/** Derived state through the head; the next transaction's projections are computed from it. */
	private state: SessionDerivedState;
	private committedOrdinal: number;
	private readonly commits = new Map<string, CommitRecord>();
	/** Appends run one at a time, in call order. */
	private appends: Promise<unknown> = Promise.resolve();
	/** Settles once a replaced client's worker has exited and its lease is released. */
	private retiring: Promise<void> = Promise.resolve();
	private released: Promise<void> | undefined;
	private lostError: ConversationLogLostError | undefined;
	private resolveLost: (error: ConversationLogLostError) => void = () => {};

	private constructor(ref: SessionReference, lease: SQLiteSessionStoreLease, state: SessionDerivedState) {
		this.conversationId = ref.sessionId;
		this.ref = ref;
		this.lease = lease;
		this.state = state;
		this.committedOrdinal = state.nextOrdinal - 1;
		this.lost = new Promise((resolve) => {
			this.resolveLost = resolve;
		});
	}

	/** Create a new hidden session in a store and open its empty log. */
	static async create(options: SqliteConversationLogCreateOptions): Promise<SqliteConversationLog> {
		const id = options.id ?? uuidv7();
		assertValidSessionId(id);
		const parent =
			options.parentSession === undefined
				? undefined
				: parseSessionReference(options.parentSession, "Parent session reference");
		const sessionDirectory = resolvePath(options.sessionDirectory);
		const lease = await acquireSharedSQLiteSessionStore(sessionDirectory);
		try {
			const summary = await lease.client.createHiddenSession({
				id,
				sessionGeneration: randomUUID(),
				formatVersion: CURRENT_SESSION_VERSION,
				cwd: resolvePath(options.cwd),
				createdAt: new Date().toISOString(),
				parentSessionDirectory: parent?.sessionDirectory ?? null,
				parentStoreId: parent?.storeId ?? null,
				parentSessionId: parent?.sessionId ?? null,
				parentSessionGeneration: parent?.sessionGeneration ?? null,
				origin: options.origin ?? null,
			});
			const ref = Object.freeze({
				sessionDirectory,
				storeId: lease.client.info.storeId,
				sessionId: summary.id,
				sessionGeneration: summary.sessionGeneration,
			});
			return await SqliteConversationLog.load(lease, ref);
		} catch (error) {
			return await releaseAfterFailure(lease, error);
		}
	}

	/** Open the log of an existing session. */
	static async open(ref: SessionReference): Promise<SqliteConversationLog> {
		const canonical = parseSessionReference(ref);
		const sessionDirectory = resolvePath(canonical.sessionDirectory);
		const lease = await acquireSharedSQLiteSessionStore(sessionDirectory);
		try {
			return await SqliteConversationLog.load(lease, Object.freeze({ ...canonical, sessionDirectory }));
		} catch (error) {
			return await releaseAfterFailure(lease, error);
		}
	}

	private static async load(lease: SQLiteSessionStoreLease, ref: SessionReference): Promise<SqliteConversationLog> {
		if (lease.client.info.storeId !== ref.storeId) throw new Error("Session reference belongs to a different store");
		const snapshot = await lease.client.loadSession(ref.sessionId, ref.sessionGeneration);
		if (!snapshot) throw new Error(`Session not found: ${ref.sessionId}`);
		return new SqliteConversationLog(ref, lease, replaySnapshot(snapshot));
	}

	head(): number {
		return this.committedOrdinal;
	}

	async append(batch: ConversationLogAppend): Promise<ConversationLogAppendResult> {
		const request: ConversationLogAppend = {
			expectedOrdinal: batch.expectedOrdinal,
			commitId: batch.commitId,
			entries: structuredClone(batch.entries),
		};
		const result = this.appends.then(() => this.commit(request));
		this.appends = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async read(afterOrdinal: number, limit: number): Promise<ConversationLogPage> {
		this.assertOpen();
		if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
			throw new RangeError("afterOrdinal must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONVERSATION_LOG_READ_LIMIT_MAX) {
			throw new RangeError(`limit must be an integer from 1 to ${CONVERSATION_LOG_READ_LIMIT_MAX}`);
		}
		const input = {
			sessionId: this.ref.sessionId,
			sessionGeneration: this.ref.sessionGeneration,
			afterOrdinal,
			limit,
		};
		const client = this.lease.client;
		const page = await client.readEntries(input).catch(async (error: unknown) => {
			// A read changes nothing: retry it once if the client's worker failed and was replaced.
			const replacement = await this.replaceFailedClient().catch(() => client);
			if (replacement === client) throw error;
			return replacement.readEntries(input);
		});
		if (page === null) throw this.lose("storage", `Session ${JSON.stringify(this.ref.sessionId)} no longer exists`);
		return {
			entries: page.entries.map((entry) => logEntry(decodeStoredSessionEntry(entry))),
			lastOrdinal: page.lastOrdinal,
		};
	}

	async close(): Promise<void> {
		if (!this.lostError) this.lose("closed", "The conversation log was closed");
		this.released ??= (async () => {
			await this.appends;
			await this.retiring;
			await this.lease.release();
		})();
		return this.released;
	}

	private async commit(batch: ConversationLogAppend): Promise<ConversationLogAppendResult> {
		this.assertOpen();
		const previous = this.commits.get(batch.commitId);
		if (previous) {
			if (previous.expectedOrdinal === batch.expectedOrdinal && sameJson(previous.entries, batch.entries)) {
				return previous.result;
			}
			return rolledBack(`Commit ${JSON.stringify(batch.commitId)} was already used for a different batch`);
		}
		const head = this.committedOrdinal;
		if (batch.expectedOrdinal !== head) {
			throw this.lose(
				"fence_conflict",
				`Expected log ordinal ${String(batch.expectedOrdinal)}, but the log head is ${head}`,
			);
		}
		if (batch.commitId.length === 0) return rolledBack("A commit id must be non-empty");
		if (batch.entries.length === 0) return rolledBack("A commit must append at least one entry");
		let prepared: PreparedCommit;
		try {
			prepared = this.prepare(batch);
		} catch (error) {
			return rolledBack(error);
		}
		const result = await this.apply(prepared);
		if (result.status === "committed") {
			this.state = prepared.state;
			this.committedOrdinal = result.last;
			this.commits.set(batch.commitId, { expectedOrdinal: batch.expectedOrdinal, entries: batch.entries, result });
		}
		return result;
	}

	/** Validate the batch and compute its transaction: the entries plus the projections they derive. */
	private prepare(batch: ConversationLogAppend): PreparedCommit {
		const entries = batch.entries.map((draft, index) => storedEntry(draft, batch.expectedOrdinal + index + 1));
		const state = cloneSessionDerivedState(this.state);
		for (const entry of entries) applySessionEntry(state, entry);
		const payload: SessionStoreTransactionPayload = {
			session: sessionStoreProjection(state),
			entries: entries.map((entry) => ({ entry: entry as unknown as SessionStoreJsonValue })),
			clientInputs: sessionStoreClientInputsForEntries(state, entries),
			searchChunks: sessionStoreSearchChunksForEntries(state, entries),
		};
		return {
			input: {
				sessionId: this.ref.sessionId,
				sessionGeneration: this.ref.sessionGeneration,
				expectedOrdinal: batch.expectedOrdinal,
				commitId: batch.commitId,
				digest: digestSessionStoreTransactionPayload(payload),
				payload,
			},
			state,
			last: batch.expectedOrdinal + entries.length,
		};
	}

	private async apply(prepared: PreparedCommit): Promise<ConversationLogAppendResult> {
		const { input, last } = prepared;
		let outcome: SessionStoreTransactionResult;
		try {
			outcome = await this.lease.client.applyTransaction(input);
		} catch (error) {
			return this.reconcile(prepared, error);
		}
		if (outcome.status === "conflict") {
			throw this.lose(
				"fence_conflict",
				`Expected log ordinal ${input.expectedOrdinal}, but the log head is ${outcome.actualOrdinal}`,
			);
		}
		// The digest covers the entries and their ordinals, so committed evidence is for exactly this batch.
		return { status: "committed", first: input.expectedOrdinal + 1, last };
	}

	/**
	 * Settle a commit whose request failed: once no worker can still be running
	 * it, the commit's evidence and the log head decide the outcome.
	 */
	private async reconcile(prepared: PreparedCommit, cause: unknown): Promise<ConversationLogAppendResult> {
		const { input, last } = prepared;
		const identity = { sessionId: input.sessionId, sessionGeneration: input.sessionGeneration };
		let reconciliation: SessionStoreCommitReconciliation;
		let head: number | undefined;
		try {
			const client = await this.replaceFailedClient();
			reconciliation = await client.reconcileCommit({ ...identity, commitId: input.commitId, digest: input.digest });
			head = (await client.findSessionSummary(identity.sessionId, identity.sessionGeneration))?.lastOrdinal;
		} catch (error) {
			throw this.lose(
				"uncertain_commit",
				`The outcome of commit ${JSON.stringify(input.commitId)} could not be determined`,
				new AggregateError([cause, error], "The commit request and its reconciliation failed"),
			);
		}
		if (head === undefined) {
			throw this.lose("storage", `Session ${JSON.stringify(identity.sessionId)} no longer exists`, cause);
		}
		if (reconciliation.status === "committed") {
			if (head !== last) {
				throw this.lose(
					"fence_conflict",
					`The log head moved from ${last} to ${head} after commit ${JSON.stringify(input.commitId)}`,
					cause,
				);
			}
			return { status: "committed", first: input.expectedOrdinal + 1, last };
		}
		if (head !== input.expectedOrdinal) {
			throw this.lose(
				"fence_conflict",
				`Expected log ordinal ${input.expectedOrdinal}, but the log head is ${head}`,
				cause,
			);
		}
		return rolledBack(cause);
	}

	/**
	 * The store client to use after a failed request. A client whose worker
	 * failed has left the shared registry; it is replaced, and its worker must
	 * exit first, since until then the request it was running can still commit.
	 */
	private async replaceFailedClient(): Promise<SQLiteSessionStoreClient> {
		const fresh = await acquireSharedSQLiteSessionStore(this.ref.sessionDirectory);
		const current = this.lease;
		// After close() starts releasing, the lease must not change.
		if (this.released || fresh.client === current.client) {
			await fresh.release();
		} else if (fresh.client.info.storeId !== this.ref.storeId) {
			await fresh.release();
			throw new Error("The session store identity changed");
		} else {
			this.lease = fresh;
			this.retiring = current.client.close().then(() => current.release());
		}
		await this.retiring;
		return this.lease.client;
	}

	private assertOpen(): void {
		if (this.lostError) throw this.lostError;
	}

	private lose(reason: ConversationLogLossReason, message: string, cause?: unknown): ConversationLogLostError {
		if (this.lostError) return this.lostError;
		const error = new ConversationLogLostError(reason, message, cause);
		this.lostError = error;
		this.resolveLost(error);
		return error;
	}
}
