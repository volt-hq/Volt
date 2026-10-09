import { lstatSync } from "node:fs";
import { resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { ensurePrivateDirectorySync, writePrivateNewFileSync } from "../../utils/private-files.ts";
import { decodeStoredSessionEntry, parsePersistedSessionEntry, sessionEntryEnvelope } from "../session-entry-codec.ts";
import type { SessionEntry } from "../session-manager.ts";
import { fuzzyMatchSessionText } from "../session-search.ts";
import { hardenSessionStoreFiles } from "./artifacts.ts";
import {
	digestSessionStoreTransactionPayload,
	parseCanonicalSessionStoreJson,
	stringifyCanonicalSessionStoreJson,
} from "./canonical-json.ts";
import {
	CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES,
	createSessionStoreTransactionValidationState,
	validateSessionStoreTransactionProjections,
} from "./projection.ts";
import {
	parseSessionStoreOperationResult,
	parseSessionStoreWorkerData,
	parseSessionStoreWorkerOperation,
	parseSessionStoreWorkerRequestEnvelope,
	type SessionStoreWorkerOperation,
	type SessionStoreWorkerResponseEnvelope,
} from "./protocol.ts";
import { initializeSessionStoreSchema, sessionCwdKey } from "./schema-migration.ts";
import { classifyOperationalStoreError } from "./sqlite-errors.ts";
import {
	SESSION_STORE_BUSY_TIMEOUT_MS,
	SESSION_STORE_DATABASE_FILENAME,
	SESSION_STORE_SCHEMA_VERSION,
	type SessionStoreApplyTransactionInput,
	type SessionStoreClientInput,
	type SessionStoreCommitEvidence,
	type SessionStoreCommitReconciliation,
	type SessionStoreCreateSessionInput,
	type SessionStoreDeleteSessionInput,
	type SessionStoreDeleteSessionResult,
	type SessionStoreEntry,
	SessionStoreError,
	type SessionStoreForeignKeyVerificationResult,
	type SessionStoreInfo,
	type SessionStoreReadEntriesInput,
	type SessionStoreReadEntriesResult,
	type SessionStoreReviewDiscussionChild,
	type SessionStoreReviewRun,
	type SessionStoreSearchChunk,
	type SessionStoreSearchResult,
	type SessionStoreSessionIdentity,
	type SessionStoreSessionSummary,
	type SessionStoreSnapshot,
	type SessionStoreTransactionResult,
} from "./types.ts";

const data = parseSessionStoreWorkerData(workerData);
const sessionDirectory = resolve(data.sessionDirectory);
const databasePath = resolve(sessionDirectory, SESSION_STORE_DATABASE_FILENAME);
const port = parentPort;
if (!port) throw new Error("Session store worker requires a parent port");

let database: DatabaseSync | undefined;
let storeId: string | undefined;
let closed = false;

function sqlString(row: Record<string, unknown>, key: string): string {
	const value = row[key];
	if (typeof value !== "string") throw new Error(`Invalid SQLite ${key} column`);
	return value;
}

function sqlNullableString(row: Record<string, unknown>, key: string): string | null {
	const value = row[key];
	if (value === null) return null;
	if (typeof value !== "string") throw new Error(`Invalid SQLite ${key} column`);
	return value;
}

function sqlInteger(row: Record<string, unknown>, key: string): number {
	const value = row[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid SQLite ${key} column`);
	return value;
}

function sqlNullableInteger(row: Record<string, unknown>, key: string): number | null {
	const value = row[key];
	if (value === null) return null;
	if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`Invalid SQLite ${key} column`);
	return value;
}

function sqlBoolean(row: Record<string, unknown>, key: string): boolean {
	const value = sqlInteger(row, key);
	if (value !== 0 && value !== 1) throw new Error(`Invalid SQLite ${key} boolean column`);
	return value === 1;
}

function hardenStoreArtifacts(): void {
	hardenSessionStoreFiles(databasePath);
}

function pragmaInteger(db: DatabaseSync, sql: string, key: string): number {
	const row = db.prepare(sql).get();
	if (!row) throw new Error(`SQLite did not return ${key}`);
	return sqlInteger(row, key);
}

function pragmaString(db: DatabaseSync, sql: string, key: string): string {
	const row = db.prepare(sql).get();
	if (!row) throw new Error(`SQLite did not return ${key}`);
	return sqlString(row, key);
}

function withTransaction<T>(db: DatabaseSync, action: () => T): T {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = action();
		db.exec("COMMIT");
		hardenStoreArtifacts();
		return result;
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}

function withDeferredReadTransaction<T>(db: DatabaseSync, action: () => T): T {
	db.exec("BEGIN DEFERRED TRANSACTION");
	try {
		const result = action();
		db.exec("COMMIT");
		return result;
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}

function openDatabase(): SessionStoreInfo {
	if (closed) throw new SessionStoreError("closed", "Session store is closed");
	if (database) return storeInfo();

	ensurePrivateDirectorySync(sessionDirectory);
	try {
		writePrivateNewFileSync(databasePath, new Uint8Array());
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	const preOpenStat = hardenSessionStoreFiles(databasePath);

	let opened: DatabaseSync | undefined;
	try {
		opened = new DatabaseSync(databasePath, {
			enableForeignKeyConstraints: true,
			enableDoubleQuotedStringLiterals: false,
			allowExtension: false,
			timeout: SESSION_STORE_BUSY_TIMEOUT_MS,
			readBigInts: false,
			returnArrays: false,
			allowBareNamedParameters: false,
			allowUnknownNamedParameters: false,
		});
		const postOpenStat = lstatSync(databasePath);
		if (
			postOpenStat.isSymbolicLink() ||
			!postOpenStat.isFile() ||
			postOpenStat.nlink !== 1 ||
			postOpenStat.dev !== preOpenStat.dev ||
			postOpenStat.ino !== preOpenStat.ino
		) {
			throw new SessionStoreError("store_initialization_failed", "Session store path changed while opening");
		}
		opened.exec("PRAGMA trusted_schema = OFF");
		opened.exec("PRAGMA foreign_keys = ON");
		opened.exec(`PRAGMA busy_timeout = ${SESSION_STORE_BUSY_TIMEOUT_MS}`);
		const journalMode = pragmaString(opened, "PRAGMA journal_mode = WAL", "journal_mode").toLowerCase();
		if (journalMode !== "wal") throw new Error(`SQLite refused WAL journal mode: ${journalMode}`);
		opened.exec("PRAGMA synchronous = FULL");
		opened.exec("PRAGMA temp_store = MEMORY");
		opened.exec("PRAGMA secure_delete = ON");

		storeId = initializeSessionStoreSchema(opened);
		database = opened;
		hardenStoreArtifacts();
		return storeInfo();
	} catch (error) {
		if (opened?.isOpen) opened.close();
		if (error instanceof SessionStoreError) throw error;
		const operationalError = classifyOperationalStoreError(error);
		if (operationalError) throw operationalError;
		throw new SessionStoreError("store_initialization_failed", "Could not initialize SQLite session store", {
			cause: error,
		});
	}
}

function requireDatabase(): DatabaseSync {
	if (closed) throw new SessionStoreError("closed", "Session store is closed");
	if (!database) openDatabase();
	if (!database) throw new SessionStoreError("store_initialization_failed", "Session store did not initialize");
	hardenStoreArtifacts();
	return database;
}

function verifyForeignKeys(): SessionStoreForeignKeyVerificationResult {
	const row = requireDatabase().prepare("PRAGMA foreign_key_check").get();
	if (!row) return { status: "valid" };
	return {
		status: "violation",
		table: sqlString(row, "table"),
		rowId: sqlNullableInteger(row, "rowid"),
		parentTable: sqlString(row, "parent"),
		constraintIndex: sqlInteger(row, "fkid"),
	};
}

function storeInfo(): SessionStoreInfo {
	const db = database;
	if (!db || !storeId) throw new SessionStoreError("store_initialization_failed", "Session store is not initialized");
	const journalMode = pragmaString(db, "PRAGMA journal_mode", "journal_mode").toLowerCase();
	const foreignKeys = pragmaInteger(db, "PRAGMA foreign_keys", "foreign_keys");
	const trustedSchema = pragmaInteger(db, "PRAGMA trusted_schema", "trusted_schema");
	const busyTimeout = pragmaInteger(db, "PRAGMA busy_timeout", "timeout");
	if (
		journalMode !== "wal" ||
		foreignKeys !== 1 ||
		trustedSchema !== 0 ||
		busyTimeout !== SESSION_STORE_BUSY_TIMEOUT_MS
	) {
		throw new SessionStoreError("store_schema_mismatch", "Required SQLite session store pragmas are not active");
	}
	return {
		storeId,
		databasePath,
		schemaVersion: SESSION_STORE_SCHEMA_VERSION,
		journalMode: "wal",
		foreignKeys: true,
		trustedSchema: false,
		busyTimeoutMs: SESSION_STORE_BUSY_TIMEOUT_MS,
	};
}

const SUMMARY_COLUMNS = `
	id,
	session_generation AS sessionGeneration,
	format_version AS formatVersion,
	cwd,
	(SELECT cwd_key FROM session_cwd_index WHERE session_cwd_index.session_id = sessions.id) AS cwdKey,
	created_at AS createdAt,
	updated_at AS updatedAt,
	parent_session_directory AS parentSessionDirectory,
	parent_store_id AS parentStoreId,
	parent_session_id AS parentSessionId,
	parent_session_generation AS parentSessionGeneration,
	origin,
	starting_git_context_recorded AS startingGitContextRecorded,
	starting_git_context_json AS startingGitContextJson,
	name,
	visible,
	(SELECT COALESCE(MAX(ordinal), 0) FROM entries WHERE entries.session_id = sessions.id) AS lastOrdinal,
	leaf_entry_id AS leafId,
	message_count AS messageCount,
	first_message AS firstMessage
`;

const SUMMARY_RESULT_COLUMNS = `
	id,
	sessionGeneration,
	formatVersion,
	cwd,
	cwdKey,
	createdAt,
	updatedAt,
	parentSessionDirectory,
	parentStoreId,
	parentSessionId,
	parentSessionGeneration,
	origin,
	startingGitContextRecorded,
	startingGitContextJson,
	name,
	visible,
	lastOrdinal,
	leafId,
	messageCount,
	firstMessage
`;

function summaryFromRow(row: Record<string, unknown>): SessionStoreSessionSummary {
	const origin = sqlNullableString(row, "origin");
	if (origin !== null && origin !== "subagent") throw new Error("Invalid SQLite origin column");
	const visible = sqlInteger(row, "visible");
	if (visible !== 0 && visible !== 1) throw new Error("Invalid SQLite visible column");
	const startingGitContextRecorded = sqlInteger(row, "startingGitContextRecorded");
	if (startingGitContextRecorded !== 0 && startingGitContextRecorded !== 1) {
		throw new Error("Invalid SQLite startingGitContextRecorded column");
	}
	const startingGitContextJson = sqlNullableString(row, "startingGitContextJson");
	if (startingGitContextRecorded === 0 && startingGitContextJson !== null) {
		throw new Error("Unrecorded starting Git context must be null");
	}
	return {
		id: sqlString(row, "id"),
		sessionGeneration: sqlString(row, "sessionGeneration"),
		formatVersion: sqlInteger(row, "formatVersion"),
		cwd: sqlString(row, "cwd"),
		cwdKey: sqlString(row, "cwdKey"),
		createdAt: sqlString(row, "createdAt"),
		updatedAt: sqlString(row, "updatedAt"),
		parentSessionDirectory: sqlNullableString(row, "parentSessionDirectory"),
		parentStoreId: sqlNullableString(row, "parentStoreId"),
		parentSessionId: sqlNullableString(row, "parentSessionId"),
		parentSessionGeneration: sqlNullableString(row, "parentSessionGeneration"),
		origin,
		startingGitContextRecorded: sqlBoolean(row, "startingGitContextRecorded"),
		startingGitContext:
			startingGitContextJson === null
				? null
				: parseCanonicalSessionStoreJson(startingGitContextJson, "Stored starting Git context"),
		name: sqlNullableString(row, "name"),
		visible: sqlBoolean(row, "visible"),
		lastOrdinal: sqlInteger(row, "lastOrdinal"),
		leafId: sqlNullableString(row, "leafId"),
		messageCount: sqlInteger(row, "messageCount"),
		firstMessage: sqlString(row, "firstMessage"),
	};
}

function findSummaryRow(
	db: DatabaseSync,
	sessionId: string,
	sessionGeneration?: string,
): Record<string, unknown> | undefined {
	return sessionGeneration === undefined
		? db.prepare(`SELECT ${SUMMARY_COLUMNS} FROM sessions WHERE id = ?`).get(sessionId)
		: db
				.prepare(`SELECT ${SUMMARY_COLUMNS} FROM sessions WHERE id = ? AND session_generation = ?`)
				.get(sessionId, sessionGeneration);
}

function findSummary(
	db: DatabaseSync,
	sessionId: string,
	sessionGeneration?: string,
): SessionStoreSessionSummary | null {
	const row = findSummaryRow(db, sessionId, sessionGeneration);
	return row ? summaryFromRow(row) : null;
}

function insertSession(db: DatabaseSync, input: SessionStoreCreateSessionInput): void {
	try {
		db.prepare(
			`INSERT INTO sessions (
				id, session_generation, format_version, cwd, created_at, updated_at,
				parent_session_directory, parent_store_id, parent_session_id, parent_session_generation,
				origin, visible
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		).run(
			input.id,
			input.sessionGeneration,
			input.formatVersion,
			input.cwd,
			input.createdAt,
			input.createdAt,
			input.parentSessionDirectory,
			input.parentStoreId,
			input.parentSessionId,
			input.parentSessionGeneration,
			input.origin,
		);
	} catch (error) {
		if (findSummary(db, input.id)) {
			throw new SessionStoreError("session_already_exists", `Session ${JSON.stringify(input.id)} already exists`, {
				cause: error,
			});
		}
		throw error;
	}
}

const REVIEW_DISCUSSION_CHILD_COLUMNS = `discussion_id AS discussionId, run_id AS runId, finding_id AS findingId,
	session_id AS sourceSessionId, session_generation AS sourceSessionGeneration,
	child_session_id AS childSessionId, child_session_generation AS childSessionGeneration, ordinal`;

function reviewDiscussionChildFromRow(row: Record<string, unknown>): SessionStoreReviewDiscussionChild {
	return {
		discussionId: sqlString(row, "discussionId"),
		runId: sqlString(row, "runId"),
		findingId: sqlString(row, "findingId"),
		source: {
			sessionId: sqlString(row, "sourceSessionId"),
			sessionGeneration: sqlString(row, "sourceSessionGeneration"),
		},
		child: {
			sessionId: sqlString(row, "childSessionId"),
			sessionGeneration: sqlString(row, "childSessionGeneration"),
		},
		ordinal: sqlInteger(row, "ordinal"),
	};
}

function findReviewRun(db: DatabaseSync, runId: string): SessionStoreReviewRun | null {
	const row = db
		.prepare(
			`SELECT session_id AS sessionId, session_generation AS sessionGeneration,
				general_session_id AS generalSessionId, general_session_generation AS generalSessionGeneration
			FROM review_run_index WHERE run_id = ?`,
		)
		.get(runId);
	return row
		? {
				runId,
				source: { sessionId: sqlString(row, "sessionId"), sessionGeneration: sqlString(row, "sessionGeneration") },
				general: {
					sessionId: sqlString(row, "generalSessionId"),
					sessionGeneration: sqlString(row, "generalSessionGeneration"),
				},
			}
		: null;
}

function findReviewDiscussion(db: DatabaseSync, discussionId: string): SessionStoreReviewDiscussionChild | null {
	const row = db
		.prepare(
			`SELECT ${REVIEW_DISCUSSION_CHILD_COLUMNS} FROM review_discussion_index
			WHERE discussion_id = ? ORDER BY ordinal DESC LIMIT 1`,
		)
		.get(discussionId);
	return row ? reviewDiscussionChildFromRow(row) : null;
}

function findReviewDiscussionChild(
	db: DatabaseSync,
	child: SessionStoreSessionIdentity,
): SessionStoreReviewDiscussionChild | null {
	const row = db
		.prepare(
			`SELECT ${REVIEW_DISCUSSION_CHILD_COLUMNS} FROM review_discussion_index
			WHERE child_session_id = ? AND child_session_generation = ?`,
		)
		.get(child.sessionId, child.sessionGeneration);
	return row ? reviewDiscussionChildFromRow(row) : null;
}

function reviewIndexError(message: string): SessionStoreError {
	return new SessionStoreError("constraint_failed", message);
}

/** That review run `runId` is anchored by exactly `source`, per the run index. */
function requireReviewAnchor(db: DatabaseSync, runId: string, source: SessionStoreSessionIdentity): void {
	const run = findReviewRun(db, runId);
	if (run?.source.sessionId !== source.sessionId || run.source.sessionGeneration !== source.sessionGeneration) {
		throw reviewIndexError(`Review run ${JSON.stringify(runId)} is not anchored by the named source`);
	}
}

/**
 * Maintain the review indexes for the review records one transaction appends
 * to session `self`, and refuse records that do not fit the other logs: a run
 * anchored twice, a General or discussion of a run this log does not anchor,
 * an alias or discussion link to a source that does not anchor the run, a
 * second discussion of a finding, a reset of a discussion another log owns,
 * or a child already used by a discussion. The indexes are derived from the
 * logs and grant no authority; these checks keep the logs consistent with
 * each other for every writer.
 */
function indexReviewEntries(
	db: DatabaseSync,
	self: SessionStoreSessionIdentity,
	entries: readonly SessionEntry[],
): void {
	const insertChild = db.prepare(
		`INSERT INTO review_discussion_index (discussion_id, ordinal, run_id, finding_id, session_id, session_generation,
			child_session_id, child_session_generation, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const assertNewChild = (child: SessionStoreSessionIdentity): void => {
		if (
			(child.sessionId === self.sessionId && child.sessionGeneration === self.sessionGeneration) ||
			findReviewDiscussionChild(db, child)
		) {
			throw reviewIndexError("A review discussion child must be a new conversation");
		}
	};
	for (const entry of entries) {
		switch (entry.type) {
			case "work_started":
				if (entry.kind !== "review") break;
				if (findReviewRun(db, entry.workId)) {
					throw reviewIndexError(`Review run ${JSON.stringify(entry.workId)} is already anchored`);
				}
				db.prepare(
					`INSERT INTO review_run_index (run_id, session_id, session_generation, general_session_id,
						general_session_generation) VALUES (?, ?, ?, ?, ?)`,
				).run(entry.workId, self.sessionId, self.sessionGeneration, self.sessionId, self.sessionGeneration);
				break;
			case "review_general": {
				requireReviewAnchor(db, entry.runId, self);
				const general = findSummary(db, entry.general.sessionId, entry.general.sessionGeneration);
				const source = findSummary(db, self.sessionId, self.sessionGeneration);
				if (
					!general ||
					!source ||
					sessionCwdKey(general.cwd) !== sessionCwdKey(source.cwd) ||
					findReviewDiscussionChild(db, entry.general)
				) {
					throw reviewIndexError("A review General must be a conversation in its source's cwd, not a discussion");
				}
				db.prepare(
					"UPDATE review_run_index SET general_session_id = ?, general_session_generation = ? WHERE run_id = ?",
				).run(entry.general.sessionId, entry.general.sessionGeneration, entry.runId);
				break;
			}
			case "review_alias":
			case "review_discussion_link":
				if (entry.source.sessionId === self.sessionId) {
					throw reviewIndexError("A review record cannot name its own conversation as the source");
				}
				requireReviewAnchor(db, entry.runId, entry.source);
				break;
			case "review_discussion":
				requireReviewAnchor(db, entry.runId, self);
				if (
					db
						.prepare(
							"SELECT 1 FROM review_discussion_index WHERE discussion_id = ? OR (run_id = ? AND finding_id = ?)",
						)
						.get(entry.discussionId, entry.runId, entry.findingId)
				) {
					throw reviewIndexError("The review discussion or its finding's discussion already exists");
				}
				assertNewChild(entry.child);
				insertChild.run(
					entry.discussionId,
					1,
					entry.runId,
					entry.findingId,
					self.sessionId,
					self.sessionGeneration,
					entry.child.sessionId,
					entry.child.sessionGeneration,
					entry.requestId,
				);
				break;
			case "review_discussion_reset": {
				const current = findReviewDiscussion(db, entry.discussionId);
				if (
					current?.source.sessionId !== self.sessionId ||
					current.source.sessionGeneration !== self.sessionGeneration
				) {
					throw reviewIndexError("Only a review discussion's source can reset it");
				}
				if (
					db
						.prepare("SELECT 1 FROM review_discussion_index WHERE discussion_id = ? AND request_id = ?")
						.get(entry.discussionId, entry.requestId)
				) {
					throw reviewIndexError("The review discussion reset request was already recorded");
				}
				assertNewChild(entry.child);
				insertChild.run(
					entry.discussionId,
					current.ordinal + 1,
					current.runId,
					current.findingId,
					self.sessionId,
					self.sessionGeneration,
					entry.child.sessionId,
					entry.child.sessionGeneration,
					entry.requestId,
				);
				break;
			}
		}
	}
}

function createSession(input: SessionStoreCreateSessionInput): SessionStoreSessionSummary {
	const db = requireDatabase();
	const cwdKey = sessionCwdKey(input.cwd);
	return withTransaction(db, () => {
		insertSession(db, input);
		db.prepare("INSERT INTO session_cwd_index (session_id, cwd_key) VALUES (?, ?)").run(input.id, cwdKey);
		const summary = findSummary(db, input.id, input.sessionGeneration);
		if (!summary) throw new Error("Inserted session row could not be read");
		return summary;
	});
}

/**
 * A condition on `sessions.id` keeping the sessions whose indexed cwd is
 * `cwd`'s canonical one, and is one of `cwdRoots` or inside one. A key under
 * a root starts with the root and a separator, so it sorts between that prefix
 * and the prefix with its separator incremented: `/repo` never covers
 * `/repo-other`.
 */
function cwdCondition(
	cwd: string | null,
	cwdRoots: readonly string[] | null,
): { readonly sql: string; readonly params: string[] } {
	const conditions: string[] = [];
	const params: string[] = [];
	if (cwd !== null) {
		conditions.push("sessions.id IN (SELECT session_id FROM session_cwd_index WHERE cwd_key = ?)");
		params.push(sessionCwdKey(cwd));
	}
	if (cwdRoots !== null) {
		const ranges: string[] = [];
		for (const root of new Set(cwdRoots.map(sessionCwdKey))) {
			const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
			const end = `${prefix.slice(0, -1)}${String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)}`;
			ranges.push("(cwd_key = ? OR (cwd_key >= ? AND cwd_key < ?))");
			params.push(root, prefix, end);
		}
		conditions.push(
			ranges.length === 0
				? "0"
				: `sessions.id IN (SELECT session_id FROM session_cwd_index WHERE ${ranges.join(" OR ")})`,
		);
	}
	return { sql: conditions.length === 0 ? "1" : conditions.join(" AND "), params };
}

function listSessions(
	includeHidden: boolean,
	cwd: string | null,
	cwdRoots: readonly string[] | null,
): SessionStoreSessionSummary[] {
	const db = requireDatabase();
	const filter = cwdCondition(cwd, cwdRoots);
	return db
		.prepare(
			`SELECT ${SUMMARY_COLUMNS} FROM sessions
			WHERE ${includeHidden ? "1" : "visible = 1"} AND ${filter.sql}
			ORDER BY updated_at DESC, id`,
		)
		.all(...filter.params)
		.map(summaryFromRow);
}

function findContinuationSession(cwd: string | null): SessionStoreSessionSummary | null {
	const db = requireDatabase();
	const filter = cwdCondition(cwd, null);
	const statement = db.prepare(
		`WITH continuation_candidates AS (
			SELECT
				${SUMMARY_COLUMNS},
				EXISTS (
					SELECT 1
					FROM client_inputs
					WHERE client_inputs.session_id = sessions.id
						AND client_inputs.state IN ('accepted', 'started')
				) AS hasPendingInput,
				(
					SELECT entries.timestamp
					FROM entries
					WHERE entries.session_id = sessions.id
						AND entries.entry_type IN (
							'client_input_receipt',
							'client_input_queued',
							'client_input_state'
						)
					ORDER BY entries.ordinal DESC
					LIMIT 1
				) AS pendingInputAt
			FROM sessions
			WHERE ${filter.sql}
		)
		SELECT ${SUMMARY_RESULT_COLUMNS}
		FROM continuation_candidates
		WHERE visible = 1 OR hasPendingInput = 1
		ORDER BY
			CASE
				WHEN hasPendingInput = 1 AND pendingInputAt > updatedAt THEN pendingInputAt
				ELSE updatedAt
			END DESC,
			id
		LIMIT 1`,
	);
	const row = statement.get(...filter.params);
	return row ? summaryFromRow(row) : null;
}

interface ParsedSearchQuery {
	readonly mode: "tokens" | "regex";
	readonly tokens: readonly { readonly kind: "fuzzy" | "phrase"; readonly value: string }[];
	readonly regex: RegExp | null;
	readonly invalid: boolean;
}

function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) return { mode: "tokens", tokens: [], regex: null, invalid: false };
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) return { mode: "regex", tokens: [], regex: null, invalid: true };
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i"), invalid: false };
		} catch {
			return { mode: "regex", tokens: [], regex: null, invalid: true };
		}
	}

	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buffer = "";
	let inQuote = false;
	const flush = (kind: "fuzzy" | "phrase"): void => {
		const value = buffer.trim();
		buffer = "";
		if (value) tokens.push({ kind, value });
	};
	for (const character of trimmed) {
		if (character === '"') {
			flush(inQuote ? "phrase" : "fuzzy");
			inQuote = !inQuote;
		} else if (!inQuote && /\s/u.test(character)) {
			flush("fuzzy");
		} else {
			buffer += character;
		}
	}
	if (inQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/u)
				.map((value) => value.trim())
				.filter((value) => value.length > 0)
				.map((value) => ({ kind: "fuzzy" as const, value })),
			regex: null,
			invalid: false,
		};
	}
	flush("fuzzy");
	return { mode: "tokens", tokens, regex: null, invalid: false };
}

function matchSearchText(text: string, parsed: ParsedSearchQuery): { matches: boolean; score: number } {
	if (parsed.invalid) return { matches: false, score: 0 };
	if (parsed.mode === "regex") {
		if (!parsed.regex) return { matches: false, score: 0 };
		const index = text.search(parsed.regex);
		return index < 0 ? { matches: false, score: 0 } : { matches: true, score: index * 0.1 };
	}
	if (parsed.tokens.length === 0) return { matches: true, score: 0 };

	let score = 0;
	let normalizedText: string | undefined;
	for (const token of parsed.tokens) {
		if (token.kind === "fuzzy") {
			const match = fuzzyMatchSessionText(token.value, text);
			if (!match.matches) return { matches: false, score: 0 };
			score += match.score;
			continue;
		}
		normalizedText ??= text.toLowerCase().replace(/\s+/gu, " ").trim();
		const phrase = token.value.toLowerCase().replace(/\s+/gu, " ").trim();
		if (!phrase) continue;
		const index = normalizedText.indexOf(phrase);
		if (index < 0) return { matches: false, score: 0 };
		score += index * 0.1;
	}
	return { matches: true, score };
}

/**
 * Deep search preserves the established matcher while retaining chunks for at
 * most one session document. Latency still scales with searchable bytes and
 * query complexity; JavaScript RegExp execution has no general time bound.
 */
function searchSessions(
	query: string,
	includeHidden: boolean,
	cwd: string | null,
	cwdRoots: readonly string[] | null,
): SessionStoreSearchResult[] {
	const db = requireDatabase();
	return withDeferredReadTransaction(db, () => {
		const sessions = listSessions(includeHidden, cwd, cwdRoots);
		const parsed = parseSearchQuery(query);
		if (parsed.invalid || sessions.length === 0) return [];

		const chunksForSession = db.prepare(
			`SELECT text FROM search_chunks
			WHERE session_id = ?
			ORDER BY chunk_index`,
		);
		const results: SessionStoreSearchResult[] = [];
		for (const session of sessions) {
			const chunks: string[] = [];
			for (const row of chunksForSession.iterate(session.id)) chunks.push(sqlString(row, "text"));
			const extractedText = chunks.join(" ");
			const match = matchSearchText(`${session.id} ${session.name ?? ""} ${extractedText} ${session.cwd}`, parsed);
			if (match.matches) results.push({ summary: session, score: match.score });
		}
		results.sort((left, right) => {
			if (left.score !== right.score) return left.score - right.score;
			return Date.parse(right.summary.updatedAt) - Date.parse(left.summary.updatedAt);
		});
		return results;
	});
}

function entryFromRow(row: Record<string, unknown>): SessionStoreEntry {
	const stored: SessionStoreEntry = {
		id: sqlString(row, "id"),
		parentId: sqlNullableString(row, "parentId"),
		type: sqlString(row, "type"),
		timestamp: sqlString(row, "timestamp"),
		ordinal: sqlInteger(row, "ordinal"),
		isHostOnly: sqlBoolean(row, "isHostOnly"),
		payload: parseCanonicalSessionStoreJson(sqlString(row, "payloadJson"), "Stored session entry payload"),
	};
	decodeStoredSessionEntry(stored);
	return stored;
}

function clientInputFromRow(row: Record<string, unknown>): SessionStoreClientInput {
	const command = sqlString(row, "command");
	if (command !== "prompt" && command !== "steer" && command !== "follow_up") {
		throw new Error("Invalid SQLite client input command");
	}
	const state = sqlString(row, "state");
	if (
		state !== "accepted" &&
		state !== "started" &&
		state !== "completed" &&
		state !== "failed" &&
		state !== "withdrawn"
	) {
		throw new Error("Invalid SQLite client input state");
	}
	const origin = sqlNullableString(row, "origin");
	if (origin !== null && origin !== "host") throw new Error("Invalid SQLite client input origin");
	const queuedInputJson = sqlNullableString(row, "queuedInputJson");
	return {
		clientMessageId: sqlString(row, "clientMessageId"),
		receiptEntryId: sqlString(row, "receiptEntryId"),
		command,
		origin,
		semanticDigest: sqlString(row, "semanticDigest"),
		input: parseCanonicalSessionStoreJson(sqlString(row, "inputJson"), "Stored client input"),
		queuedEntryId: sqlNullableString(row, "queuedEntryId"),
		queuedInput:
			queuedInputJson === null
				? null
				: parseCanonicalSessionStoreJson(queuedInputJson, "Stored queued client input"),
		state,
		error: sqlNullableString(row, "error"),
		canonicalEntryId: sqlNullableString(row, "canonicalEntryId"),
	};
}

function chunkFromRow(row: Record<string, unknown>): SessionStoreSearchChunk {
	return {
		chunkIndex: sqlInteger(row, "chunkIndex"),
		entryId: sqlNullableString(row, "entryId"),
		text: sqlString(row, "text"),
	};
}

/** Bad projection data is an integrity failure; a busy, full, or failing store is not. */
function projectionIntegrityError(
	component: "summary" | "client_inputs" | "search_chunks",
	cause: unknown,
): SessionStoreError {
	const operationalError = classifyOperationalStoreError(cause);
	if (operationalError) return operationalError;
	return new SessionStoreError(
		"session_store_projection_integrity",
		`Session store ${component} projection does not match canonical entries`,
		{ cause },
	);
}

const ENTRY_COLUMNS = `entry_id AS id, parent_entry_id AS parentId, entry_type AS type, timestamp, ordinal,
	is_host_only AS isHostOnly, payload_json AS payloadJson`;

function storedEntriesFromRows(rows: readonly Record<string, unknown>[]): SessionStoreEntry[] {
	try {
		return rows.map(entryFromRow);
	} catch (error) {
		throw new SessionStoreError(
			"session_store_entry_integrity",
			"Session store canonical entries are invalid or inconsistent",
			{ cause: error },
		);
	}
}

function loadSession(sessionId: string, sessionGeneration: string): SessionStoreSnapshot | null {
	const db = requireDatabase();
	return withDeferredReadTransaction(db, () => {
		const summaryRow = findSummaryRow(db, sessionId, sessionGeneration);
		if (!summaryRow) return null;
		let session: SessionStoreSessionSummary;
		try {
			session = summaryFromRow(summaryRow);
			parseSessionStoreOperationResult("find_session", session);
		} catch (error) {
			throw projectionIntegrityError("summary", error);
		}
		const entries = storedEntriesFromRows(
			db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE session_id = ? ORDER BY ordinal`).all(sessionId),
		);
		let clientInputs: SessionStoreClientInput[];
		try {
			clientInputs = db
				.prepare(
					`SELECT client_message_id AS clientMessageId, receipt_entry_id AS receiptEntryId, command, origin,
					semantic_digest AS semanticDigest, input_json AS inputJson, queued_entry_id AS queuedEntryId,
					queued_input_json AS queuedInputJson, state, error, canonical_entry_id AS canonicalEntryId
				FROM client_inputs WHERE session_id = ? ORDER BY client_message_id`,
				)
				.all(sessionId)
				.map(clientInputFromRow);
		} catch (error) {
			throw projectionIntegrityError("client_inputs", error);
		}
		let searchChunks: SessionStoreSearchChunk[];
		try {
			searchChunks = db
				.prepare(
					`SELECT chunk_index AS chunkIndex, entry_id AS entryId, text
				FROM search_chunks WHERE session_id = ? ORDER BY chunk_index`,
				)
				.all(sessionId)
				.map(chunkFromRow);
		} catch (error) {
			throw projectionIntegrityError("search_chunks", error);
		}
		return { session, entries, clientInputs, searchChunks };
	});
}

/** One bounded page over the (session_id, ordinal) unique index, read in one snapshot with its end. */
function readEntries(input: SessionStoreReadEntriesInput): SessionStoreReadEntriesResult | null {
	const db = requireDatabase();
	return withDeferredReadTransaction(db, () => {
		const summaryRow = findSummaryRow(db, input.sessionId, input.sessionGeneration);
		if (!summaryRow) return null;
		const entries = storedEntriesFromRows(
			db
				.prepare(
					`SELECT ${ENTRY_COLUMNS} FROM entries WHERE session_id = ? AND ordinal > ? ORDER BY ordinal LIMIT ?`,
				)
				.all(input.sessionId, input.afterOrdinal, input.limit),
		);
		return { entries, lastOrdinal: sqlInteger(summaryRow, "lastOrdinal") };
	});
}

function evidenceFromRow(row: Record<string, unknown>): SessionStoreCommitEvidence {
	return {
		sessionId: sqlString(row, "sessionId"),
		sessionGeneration: sqlString(row, "sessionGeneration"),
		commitId: sqlString(row, "commitId"),
		digest: sqlString(row, "digest"),
		beforeOrdinal: sqlInteger(row, "beforeOrdinal"),
		afterOrdinal: sqlInteger(row, "afterOrdinal"),
		committedAt: sqlString(row, "committedAt"),
	};
}

function findCommit(db: DatabaseSync, commitId: string): SessionStoreCommitEvidence | null {
	const row = db
		.prepare(
			`SELECT commit_id AS commitId, session_id AS sessionId, session_generation AS sessionGeneration,
				digest, before_ordinal AS beforeOrdinal, after_ordinal AS afterOrdinal, committed_at AS committedAt
			FROM transaction_commits WHERE commit_id = ?`,
		)
		.get(commitId);
	return row ? evidenceFromRow(row) : null;
}

function reconcileCommit(input: {
	readonly sessionId: string;
	readonly sessionGeneration: string;
	readonly commitId: string;
	readonly digest: string;
}): SessionStoreCommitReconciliation {
	const evidence = findCommit(requireDatabase(), input.commitId);
	if (!evidence) return { status: "not_found" };
	if (
		evidence.sessionId !== input.sessionId ||
		evidence.sessionGeneration !== input.sessionGeneration ||
		evidence.digest !== input.digest
	) {
		return { status: "mismatch" };
	}
	return { status: "committed", evidence };
}

function assertMatchingDigest(input: SessionStoreApplyTransactionInput): void {
	const actualDigest = digestSessionStoreTransactionPayload(input.payload);
	if (actualDigest !== input.digest) {
		throw new SessionStoreError(
			"commit_digest_mismatch",
			"Session store transaction digest does not match its payload",
		);
	}
}

interface StoredEntryRelation {
	readonly parentId: string | null;
	readonly isHostOnly: boolean;
}

function validateTransactionEntryReferences(
	db: DatabaseSync,
	sessionId: string,
	entries: SessionStoreApplyTransactionInput["payload"]["entries"],
): Array<SessionEntry & { ordinal: number }> {
	const validatedEntries: Array<SessionEntry & { ordinal: number }> = [];
	const relations = new Map<string, StoredEntryRelation>();
	const findStored = db.prepare(
		`SELECT parent_entry_id AS parentId, entry_type AS type, is_host_only AS isHostOnly
		FROM entries WHERE session_id = ? AND entry_id = ?`,
	);
	const relationFor = (entryId: string): StoredEntryRelation | undefined => {
		const pending = relations.get(entryId);
		if (pending) return pending;
		const row = findStored.get(sessionId, entryId);
		if (!row) return undefined;
		const relation = {
			parentId: sqlNullableString(row, "parentId"),
			isHostOnly: sqlBoolean(row, "isHostOnly"),
		};
		relations.set(entryId, relation);
		return relation;
	};
	let sawStartingGitContext =
		db
			.prepare("SELECT 1 AS present FROM entries WHERE session_id = ? AND entry_type = ? LIMIT 1")
			.get(sessionId, "session_start_git_context") !== undefined;

	for (const write of entries) {
		const entry = parsePersistedSessionEntry(write.entry);
		const envelope = sessionEntryEnvelope(entry);
		if (relationFor(envelope.id)) {
			throw new SessionStoreError("constraint_failed", `Entry ${JSON.stringify(envelope.id)} already exists`);
		}
		if (envelope.parentId !== null && !relationFor(envelope.parentId)) {
			throw new SessionStoreError(
				"constraint_failed",
				`Entry ${JSON.stringify(envelope.id)} has an invalid or forward parent`,
			);
		}
		if (entry.type === "compaction") {
			let currentId = entry.parentId;
			const visited = new Set<string>();
			while (currentId !== null && currentId !== entry.firstKeptEntryId) {
				if (visited.has(currentId)) {
					throw new SessionStoreError("constraint_failed", "Session entry parent chain contains a cycle");
				}
				visited.add(currentId);
				currentId = relationFor(currentId)?.parentId ?? null;
			}
			if (currentId !== entry.firstKeptEntryId) {
				throw new SessionStoreError(
					"constraint_failed",
					`Compaction entry ${JSON.stringify(entry.id)} has an invalid first-kept boundary`,
				);
			}
		}
		if (entry.type === "leaf" || entry.type === "label") {
			const targetId = entry.targetId;
			if (targetId !== null) {
				const target = relationFor(targetId);
				if (!target || target.isHostOnly) {
					throw new SessionStoreError(
						"constraint_failed",
						`${entry.type === "leaf" ? "Leaf" : "Label"} entry ${JSON.stringify(entry.id)} has an invalid target`,
					);
				}
			}
		}
		if (entry.type === "branch_summary" && entry.fromId !== (entry.parentId ?? "root")) {
			throw new SessionStoreError(
				"constraint_failed",
				`Branch summary entry ${JSON.stringify(entry.id)} has an invalid source`,
			);
		}
		if (entry.type === "session_start_git_context") {
			if (sawStartingGitContext) {
				throw new SessionStoreError("constraint_failed", "Session has more than one starting Git context entry");
			}
			sawStartingGitContext = true;
		}
		relations.set(envelope.id, {
			parentId: envelope.parentId,
			isHostOnly: envelope.isHostOnly,
		});
		validatedEntries.push(entry);
	}
	return validatedEntries;
}

function clientMessageIdForEntry(entry: SessionEntry): string | undefined {
	if (
		entry.type === "client_input_receipt" ||
		entry.type === "client_input_queued" ||
		entry.type === "client_input_state"
	) {
		return entry.clientMessageId;
	}
	return entry.type === "message" ? entry.clientMessageId : undefined;
}

function loadTransactionClientInputs(
	db: DatabaseSync,
	sessionId: string,
	entries: readonly SessionEntry[],
): SessionStoreClientInput[] {
	const selected = new Map<string, SessionStoreClientInput>();
	const selectColumns = `client_message_id AS clientMessageId, receipt_entry_id AS receiptEntryId, command, origin,
		semantic_digest AS semanticDigest, input_json AS inputJson, queued_entry_id AS queuedEntryId,
		queued_input_json AS queuedInputJson, state, error, canonical_entry_id AS canonicalEntryId`;
	const retain = (row: Record<string, unknown>): void => {
		const clientInput = clientInputFromRow(row);
		selected.set(clientInput.clientMessageId, clientInput);
	};
	for (const row of db
		.prepare(
			`SELECT ${selectColumns} FROM client_inputs
			WHERE session_id = ? AND state IN ('accepted', 'started')
			LIMIT ${CLIENT_INPUT_MAX_OUTSTANDING_ENTRIES + 1}`,
		)
		.all(sessionId)) {
		retain(row);
	}
	const findStored = db.prepare(
		`SELECT ${selectColumns} FROM client_inputs WHERE session_id = ? AND client_message_id = ?`,
	);
	const affectedClientIds = new Set(entries.map(clientMessageIdForEntry).filter((id) => id !== undefined));
	for (const clientMessageId of affectedClientIds) {
		if (selected.has(clientMessageId)) continue;
		const row = findStored.get(sessionId, clientMessageId);
		if (row) retain(row);
	}
	return [...selected.values()];
}

function nextSearchChunkIndex(db: DatabaseSync, sessionId: string): number {
	const row = db
		.prepare(
			"SELECT COALESCE(MAX(chunk_index), -1) AS maxChunkIndex, COUNT(*) AS chunkCount FROM search_chunks WHERE session_id = ?",
		)
		.get(sessionId);
	if (!row) throw new Error("Could not determine the current session search chunk index");
	const nextIndex = sqlInteger(row, "maxChunkIndex") + 1;
	if (nextIndex !== sqlInteger(row, "chunkCount")) {
		throw new Error("Stored session search chunk indexes are not contiguous");
	}
	return nextIndex;
}

function applyTransactionInCurrentTransaction(
	db: DatabaseSync,
	input: SessionStoreApplyTransactionInput,
): SessionStoreTransactionResult {
	const previousCommit = findCommit(db, input.commitId);
	if (previousCommit) {
		if (
			previousCommit.sessionId !== input.sessionId ||
			previousCommit.sessionGeneration !== input.sessionGeneration ||
			previousCommit.digest !== input.digest
		) {
			throw new SessionStoreError(
				"commit_identity_conflict",
				`Commit id ${JSON.stringify(input.commitId)} is already bound to a different transaction`,
			);
		}
		return { status: "committed", evidence: previousCommit };
	}

	const summaryRow = findSummaryRow(db, input.sessionId, input.sessionGeneration);
	if (!summaryRow) {
		throw new SessionStoreError("session_not_found", `Session ${JSON.stringify(input.sessionId)} does not exist`);
	}
	const summary = summaryFromRow(summaryRow);
	// The fence: the writer's committed head must still be the log's last ordinal.
	if (summary.lastOrdinal !== input.expectedOrdinal) {
		return { status: "conflict", actualOrdinal: summary.lastOrdinal };
	}
	const canonicalEntries = validateTransactionEntryReferences(db, input.sessionId, input.payload.entries);
	const firstNewOrdinal = summary.lastOrdinal + 1;
	const transitionState = createSessionStoreTransactionValidationState(
		summary.createdAt,
		loadTransactionClientInputs(db, input.sessionId, canonicalEntries),
		firstNewOrdinal,
		nextSearchChunkIndex(db, input.sessionId),
	);
	validateSessionStoreTransactionProjections(
		transitionState,
		canonicalEntries,
		input.payload.clientInputs,
		input.payload.searchChunks,
	);
	let insertionOrdinal = firstNewOrdinal;
	const insertEntry = db.prepare(
		`INSERT INTO entries (
			session_id, entry_id, ordinal, parent_entry_id, entry_type, timestamp, is_host_only, payload_json
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	);
	for (const entry of canonicalEntries) {
		const envelope = sessionEntryEnvelope(entry);
		if (envelope.ordinal !== insertionOrdinal) {
			throw new SessionStoreError(
				"constraint_failed",
				`Entry ${JSON.stringify(envelope.id)} has a non-contiguous ordinal`,
			);
		}
		insertEntry.run(
			input.sessionId,
			envelope.id,
			envelope.ordinal,
			envelope.parentId,
			envelope.type,
			envelope.timestamp,
			envelope.isHostOnly ? 1 : 0,
			stringifyCanonicalSessionStoreJson(entry, `Entry ${envelope.id} payload`),
		);
		insertionOrdinal += 1;
	}
	indexReviewEntries(db, { sessionId: input.sessionId, sessionGeneration: input.sessionGeneration }, canonicalEntries);

	const upsertClientInput = db.prepare(
		`INSERT INTO client_inputs (
			session_id, client_message_id, receipt_entry_id, command, origin, semantic_digest, input_json,
			queued_entry_id, queued_input_json, state, error, canonical_entry_id
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (session_id, client_message_id) DO UPDATE SET
			receipt_entry_id = excluded.receipt_entry_id,
			command = excluded.command,
			origin = excluded.origin,
			semantic_digest = excluded.semantic_digest,
			input_json = excluded.input_json,
			queued_entry_id = excluded.queued_entry_id,
			queued_input_json = excluded.queued_input_json,
			state = excluded.state,
			error = excluded.error,
			canonical_entry_id = excluded.canonical_entry_id`,
	);
	for (const clientInput of input.payload.clientInputs) {
		upsertClientInput.run(
			input.sessionId,
			clientInput.clientMessageId,
			clientInput.receiptEntryId,
			clientInput.command,
			clientInput.origin,
			clientInput.semanticDigest,
			stringifyCanonicalSessionStoreJson(clientInput.input, "Client input"),
			clientInput.queuedEntryId,
			clientInput.queuedInput === null
				? null
				: stringifyCanonicalSessionStoreJson(clientInput.queuedInput, "Queued client input"),
			clientInput.state,
			clientInput.error,
			clientInput.canonicalEntryId,
		);
	}

	const insertChunk = db.prepare(
		"INSERT INTO search_chunks (session_id, chunk_index, entry_id, text) VALUES (?, ?, ?, ?)",
	);
	for (const chunk of input.payload.searchChunks) {
		insertChunk.run(input.sessionId, chunk.chunkIndex, chunk.entryId, chunk.text);
	}

	if (
		input.payload.session.leafId !== null &&
		!db
			.prepare("SELECT 1 AS present FROM entries WHERE session_id = ? AND entry_id = ?")
			.get(input.sessionId, input.payload.session.leafId)
	) {
		throw new SessionStoreError("constraint_failed", "Session leaf must identify a stored entry");
	}

	const update = db
		.prepare(
			`UPDATE sessions SET
				updated_at = ?, starting_git_context_recorded = ?, starting_git_context_json = ?,
				name = ?, visible = ?, leaf_entry_id = ?, message_count = ?, first_message = ?
			WHERE id = ? AND session_generation = ?`,
		)
		.run(
			input.payload.session.updatedAt,
			input.payload.session.startingGitContextRecorded ? 1 : 0,
			input.payload.session.startingGitContext === null
				? null
				: stringifyCanonicalSessionStoreJson(input.payload.session.startingGitContext, "Starting Git context"),
			input.payload.session.name,
			input.payload.session.visible ? 1 : 0,
			input.payload.session.leafId,
			input.payload.session.messageCount,
			input.payload.session.firstMessage,
			input.sessionId,
			input.sessionGeneration,
		);
	if (update.changes !== 1) throw new SessionStoreError("constraint_failed", "Session changed during transaction");

	const evidence: SessionStoreCommitEvidence = {
		sessionId: input.sessionId,
		sessionGeneration: input.sessionGeneration,
		commitId: input.commitId,
		digest: input.digest,
		beforeOrdinal: summary.lastOrdinal,
		afterOrdinal: insertionOrdinal - 1,
		committedAt: new Date().toISOString(),
	};
	db.prepare(
		`INSERT INTO transaction_commits (
			commit_id, session_id, session_generation, digest, before_ordinal, after_ordinal, committed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		evidence.commitId,
		evidence.sessionId,
		evidence.sessionGeneration,
		evidence.digest,
		evidence.beforeOrdinal,
		evidence.afterOrdinal,
		evidence.committedAt,
	);
	return { status: "committed", evidence };
}

function applyTransaction(input: SessionStoreApplyTransactionInput): SessionStoreTransactionResult {
	assertMatchingDigest(input);
	const db = requireDatabase();
	try {
		return withTransaction(db, () => applyTransactionInCurrentTransaction(db, input));
	} catch (error) {
		if (error instanceof SessionStoreError) throw error;
		const operationalError = classifyOperationalStoreError(error);
		if (operationalError) throw operationalError;
		throw new SessionStoreError("constraint_failed", "SQLite rejected the session transaction", { cause: error });
	}
}

function deleteSession(input: SessionStoreDeleteSessionInput): SessionStoreDeleteSessionResult {
	const db = requireDatabase();
	return withTransaction(db, () => {
		const summary = findSummary(db, input.sessionId, input.sessionGeneration);
		if (!summary) return { status: "not_found" };
		if (summary.lastOrdinal !== input.expectedOrdinal) {
			return { status: "conflict", actualOrdinal: summary.lastOrdinal };
		}
		const result = db
			.prepare("DELETE FROM sessions WHERE id = ? AND session_generation = ?")
			.run(input.sessionId, input.sessionGeneration);
		if (result.changes !== 1) {
			throw new SessionStoreError("constraint_failed", "Session changed during conditional deletion");
		}
		return { status: "deleted" };
	});
}

function closeDatabase(): null {
	if (closed) return null;
	closed = true;
	if (database?.isOpen) database.close();
	database = undefined;
	storeId = undefined;
	hardenStoreArtifacts();
	return null;
}

function execute(operation: SessionStoreWorkerOperation): unknown {
	switch (operation.kind) {
		case "find_review_run":
			return withDeferredReadTransaction(requireDatabase(), () => findReviewRun(requireDatabase(), operation.runId));
		case "find_review_discussion":
			return withDeferredReadTransaction(requireDatabase(), () =>
				findReviewDiscussion(requireDatabase(), operation.discussionId),
			);
		case "find_review_discussion_child":
			return withDeferredReadTransaction(requireDatabase(), () =>
				findReviewDiscussionChild(requireDatabase(), operation.child),
			);
		case "initialize":
			return openDatabase();
		case "verify_foreign_keys":
			return verifyForeignKeys();
		case "create_session":
			return createSession(operation.input);
		case "load_session":
			return loadSession(operation.sessionId, operation.sessionGeneration);
		case "read_entries":
			return readEntries(operation.input);
		case "find_continuation_session":
			return findContinuationSession(operation.cwd);
		case "list_sessions":
			return listSessions(operation.includeHidden, operation.cwd, operation.cwdRoots);
		case "search_sessions":
			return searchSessions(operation.query, operation.includeHidden, operation.cwd, operation.cwdRoots);
		case "find_session":
			return findSummary(requireDatabase(), operation.sessionId, operation.sessionGeneration);
		case "find_session_by_id":
			return findSummary(requireDatabase(), operation.sessionId);
		case "apply_transaction":
			return applyTransaction(operation.input);
		case "reconcile_commit":
			return reconcileCommit(operation.input);
		case "delete_session":
			return deleteSession(operation.input);
		case "close":
			return closeDatabase();
	}
}

function errorResponse(requestId: number, error: unknown): SessionStoreWorkerResponseEnvelope {
	const storeError = error instanceof SessionStoreError ? error : classifyOperationalStoreError(error);
	if (storeError) {
		return { requestId, ok: false, error: { code: storeError.code, message: storeError.message } };
	}
	return {
		requestId,
		ok: false,
		error: {
			code: error instanceof TypeError ? "invalid_request" : "worker_failed",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}

port.on("message", (message: unknown) => {
	let requestId = 1;
	try {
		const envelope = parseSessionStoreWorkerRequestEnvelope(message);
		requestId = envelope.requestId;
		const operationValue: unknown = JSON.parse(envelope.operationJson);
		const operation = parseSessionStoreWorkerOperation(operationValue);
		const result = execute(operation);
		const validatedResult = parseSessionStoreOperationResult(operation.kind, result);
		const response: SessionStoreWorkerResponseEnvelope = {
			requestId,
			ok: true,
			resultJson: stringifyCanonicalSessionStoreJson(validatedResult, "Session store worker result"),
		};
		port.postMessage(response);
	} catch (error) {
		port.postMessage(errorResponse(requestId, error));
	}
});
