import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientInputSemanticDigest, SessionManager } from "../../src/core/session-manager.ts";
import {
	digestSessionStoreTransactionPayload,
	stringifyCanonicalSessionStoreJson,
} from "../../src/core/session-store/canonical-json.ts";
import {
	type SessionStoreApplyTransactionInput,
	type SessionStoreTransactionPayload,
	SQLiteSessionStoreClient,
} from "../../src/core/session-store/index.ts";
import {
	SESSION_STORE_CLIENT_INPUTS_SCHEMA_SQL,
	SESSION_STORE_CWD_INDEX_SCHEMA_SQL,
	SESSION_STORE_REVIEW_INDEX_SCHEMA_SQL,
	SESSION_STORE_SCHEMA_SQL,
	SESSION_STORE_TRANSACTION_COMMITS_SCHEMA_SQL,
} from "../../src/core/session-store/schema.ts";
import {
	initializeSessionStoreSchema,
	SESSION_STORE_V4_CLIENT_INPUT_UPGRADE_SQL,
	SESSION_STORE_V5_REVIEW_UPGRADE_SQL,
} from "../../src/core/session-store/schema-migration.ts";
import { SESSION_STORE_V1_SCHEMA_SQL } from "../../src/core/session-store/schema-v1.ts";
import { SESSION_STORE_V2_SCHEMA_SQL } from "../../src/core/session-store/schema-v2.ts";
import { SESSION_STORE_V3_SCHEMA_SQL } from "../../src/core/session-store/schema-v3.ts";
import { SESSION_STORE_V4_SCHEMA_SQL } from "../../src/core/session-store/schema-v4.ts";
import { SESSION_STORE_V5_SCHEMA_SQL } from "../../src/core/session-store/schema-v5.ts";

const NOW = "2026-09-05T12:00:00.000Z";
const VERSIONS = [1, 2, 3, 4, 5] as const;
type LegacyVersion = (typeof VERSIONS)[number];
const LEGACY_SCHEMA_SQL: Record<LegacyVersion, string> = {
	1: SESSION_STORE_V1_SCHEMA_SQL,
	2: SESSION_STORE_V2_SCHEMA_SQL,
	3: SESSION_STORE_V3_SCHEMA_SQL,
	4: SESSION_STORE_V4_SCHEMA_SQL,
	5: SESSION_STORE_V5_SCHEMA_SQL,
};
/** Versions with the v2 review tables v5 dropped. */
const hasReviewTables = (version: LegacyVersion): boolean => version >= 2 && version <= 4;
/** The tables v2 added for review state and v5 dropped. */
const REVIEW_TABLES = ["review_anchors", "review_anchor_aliases", "review_discussions", "review_discussion_children"];
const [CLIENT_INPUT_COPY, CLIENT_INPUT_DROP, , CLIENT_INPUT_RESTORE, CLIENT_INPUT_COPY_DROP] =
	SESSION_STORE_V4_CLIENT_INPUT_UPGRADE_SQL;
const [DROP_CHILDREN, DROP_DISCUSSIONS, DROP_ALIASES, DROP_ANCHORS] = SESSION_STORE_V5_REVIEW_UPGRADE_SQL;
const COMMIT_DIGEST = `sha256:${"a".repeat(64)}`;
const roots: string[] = [];
const clients: SQLiteSessionStoreClient[] = [];
const canonical = (value: unknown): string => stringifyCanonicalSessionStoreJson(value, "Fixture");

function directory(): string {
	const root = mkdtempSync(join(tmpdir(), "volt-store-migration-"));
	roots.push(root);
	return join(root, "sessions");
}

function schemaObjects(db: DatabaseSync): Record<string, unknown>[] {
	return db
		.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`)
		.all()
		.map((row) => ({ ...row }));
}

function freshSchemaObjects(): Record<string, unknown>[] {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(SESSION_STORE_SCHEMA_SQL);
		return schemaObjects(db);
	} finally {
		db.close();
	}
}

/**
 * Seeds an exact pre-v6 store with one accepted client input, and from v2
 * to v4 a review run with an alias and a discussion whose child is a session
 * of the store. Pre-v3 sessions carry revisions and revision-keyed commit
 * evidence; pre-v4 client inputs have no origin.
 */
function seed(dir: string, version: LegacyVersion, ddl = LEGACY_SCHEMA_SQL[version]): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = join(dir, "sessions.sqlite");
	const db = new DatabaseSync(path);
	try {
		db.exec(ddl);
		const digest = `sha256:${createHash("sha256")
			.update(canonical(schemaObjects(db)))
			.digest("hex")}`;
		db.exec("BEGIN");
		for (const [key, value] of Object.entries({
			schema_id: `volt-session-store-v${version}`,
			schema_digest: digest,
			schema_version: version,
			store_id: "original-store",
			created_at: NOW,
		})) {
			db.prepare("INSERT INTO store_metadata VALUES (?, ?)").run(key, canonical(value));
		}
		const revision = version >= 3 ? { column: "", value: "" } : { column: " revision,", value: " 1," };
		db.prepare(`INSERT INTO sessions (id, session_generation, format_version, cwd, created_at, updated_at,
			visible,${revision.column} leaf_entry_id, message_count, first_message) VALUES (?, ?, 5, ?, ?, ?, 1,${revision.value} 'message', 1, 'preserved')`).run(
			"source",
			"source-generation",
			dir,
			NOW,
			NOW,
		);
		db.prepare(`INSERT INTO sessions (id, session_generation, format_version, cwd, created_at, updated_at,
			parent_session_directory, parent_store_id, parent_session_id, parent_session_generation)
			VALUES ('related', 'related-generation', 5, ?, ?, ?, ?, 'original-store', 'source', 'source-generation')`).run(
			dir,
			NOW,
			NOW,
			dir,
		);
		const input = { message: "pending", images: [] };
		const semanticDigest = createClientInputSemanticDigest("steer", input);
		const receipt = {
			type: "client_input_receipt",
			id: "receipt",
			ordinal: 1,
			parentId: null,
			timestamp: NOW,
			clientMessageId: "client",
			command: "steer",
			semanticDigest,
			input,
		};
		const message = {
			type: "message",
			id: "message",
			ordinal: 2,
			parentId: null,
			timestamp: NOW,
			message: { role: "user", content: "preserved", timestamp: Date.parse(NOW) },
		};
		db.prepare("INSERT INTO entries VALUES ('source', 'receipt', 1, NULL, 'client_input_receipt', ?, 1, ?)").run(
			NOW,
			canonical(receipt),
		);
		db.prepare("INSERT INTO entries VALUES ('source', 'message', 2, NULL, 'message', ?, 0, ?)").run(
			NOW,
			canonical(message),
		);
		db.prepare(
			version >= 4
				? "INSERT INTO client_inputs VALUES ('source', 'client', 'receipt', 'steer', NULL, ?, ?, NULL, NULL, 'accepted', NULL, NULL)"
				: "INSERT INTO client_inputs VALUES ('source', 'client', 'receipt', 'steer', ?, ?, NULL, NULL, 'accepted', NULL, NULL)",
		).run(semanticDigest, canonical(input));
		db.exec("INSERT INTO search_chunks VALUES ('source', 0, 'message', 'preserved')");
		db.prepare("INSERT INTO transaction_commits VALUES ('commit', 'source', 'source-generation', ?, 0, 1, ?)").run(
			COMMIT_DIGEST,
			NOW,
		);
		if (hasReviewTables(version)) {
			db.prepare(`INSERT INTO review_anchors (run_id, source_session_id, source_session_generation, cwd,
				general_session_id, general_session_generation, general_revision, created_at)
				VALUES ('run', 'source', 'source-generation', ?, 'source', 'source-generation', 0, ?)`).run(dir, NOW);
			db.exec("INSERT INTO review_anchor_aliases VALUES ('run', 'related', 'related-generation')");
			db.prepare(`INSERT INTO sessions (id, session_generation, format_version, cwd, created_at, updated_at)
				VALUES ('child', 'child-generation', 5, ?, ?, ?)`).run(dir, NOW, NOW);
			db.prepare("INSERT INTO review_discussions VALUES ('discussion', 'run', 'finding', '{}', ?, 1)").run(NOW);
			db.prepare(`INSERT INTO review_discussion_children VALUES ('discussion', 1, 'child', 'child-generation',
				'create', '{}', 'kickoff', ?)`).run(NOW);
		}
		db.exec("COMMIT");
		db.exec(`PRAGMA user_version = ${version}`);
	} finally {
		db.close();
	}
	return path;
}

function tableRows(db: DatabaseSync): Record<string, unknown[]> {
	return Object.fromEntries(
		schemaObjects(db)
			.filter((object) => object.type === "table" && object.name !== "store_metadata")
			.map(({ name }) => [String(name), db.prepare(`SELECT * FROM ${String(name)}`).all()]),
	);
}

function dump(db: DatabaseSync): unknown {
	return {
		version: db.prepare("PRAGMA user_version").get(),
		objects: schemaObjects(db),
		metadata: db.prepare("SELECT * FROM store_metadata ORDER BY key").all(),
		tables: tableRows(db),
	};
}

function transaction(
	expectedOrdinal: number,
	commitId: string,
	payload: SessionStoreTransactionPayload,
): SessionStoreApplyTransactionInput {
	return {
		sessionId: "source",
		sessionGeneration: "source-generation",
		expectedOrdinal,
		commitId,
		digest: digestSessionStoreTransactionPayload(payload),
		payload,
	};
}

/** Withdraw the seeded accepted input, a state only v4 stores hold. */
function withdrawTransaction(expectedOrdinal: number): SessionStoreApplyTransactionInput {
	const input = { message: "pending", images: [] };
	return transaction(expectedOrdinal, "withdrawn", {
		session: {
			updatedAt: NOW,
			startingGitContextRecorded: false,
			startingGitContext: null,
			name: "after upgrade",
			visible: true,
			leafId: "session-info",
			messageCount: 1,
			firstMessage: "preserved",
		},
		entries: [
			{
				entry: {
					type: "client_input_state",
					id: "withdrawn",
					parentId: "session-info",
					timestamp: NOW,
					ordinal: expectedOrdinal + 1,
					receiptId: "receipt",
					clientMessageId: "client",
					state: "withdrawn",
				},
			},
		],
		clientInputs: [
			{
				clientMessageId: "client",
				receiptEntryId: "receipt",
				command: "steer",
				origin: null,
				semanticDigest: createClientInputSemanticDigest("steer", input),
				input,
				queuedEntryId: null,
				queuedInput: null,
				state: "withdrawn",
				error: null,
				canonicalEntryId: null,
			},
		],
		searchChunks: [],
	});
}

function sessionInfoTransaction(expectedOrdinal: number, commitId: string): SessionStoreApplyTransactionInput {
	const payload: SessionStoreTransactionPayload = {
		session: {
			updatedAt: NOW,
			startingGitContextRecorded: false,
			startingGitContext: null,
			name: "after upgrade",
			visible: true,
			leafId: "session-info",
			messageCount: 1,
			firstMessage: "preserved",
		},
		entries: [
			{
				entry: {
					type: "session_info",
					id: "session-info",
					parentId: "message",
					timestamp: NOW,
					ordinal: 3,
					name: "after upgrade",
				},
			},
		],
		clientInputs: [],
		searchChunks: [],
	};
	return transaction(expectedOrdinal, commitId, payload);
}

async function open(dir: string): Promise<SQLiteSessionStoreClient> {
	const client = await SQLiteSessionStoreClient.open(dir);
	clients.push(client);
	return client;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("exact v1 to v5 to v6 session store migration", () => {
	it.each(VERSIONS)(
		"upgrades v%i in place, dropping revisions and the review tables without carrying their rows, indexing every cwd",
		async (version) => {
			const dir = directory();
			const path = seed(dir, version);
			const beforeDb = new DatabaseSync(path);
			const before = tableRows(beforeDb);
			beforeDb.close();
			const client = await open(dir);
			expect(client.info).toMatchObject({ storeId: "original-store", schemaVersion: 6 });
			const db = new DatabaseSync(path);
			try {
				const after = tableRows(db);
				const kept = Object.keys(before).filter((table) => !REVIEW_TABLES.includes(table));
				expect(Object.fromEntries(kept.map((table) => [table, after[table]]))).toEqual({
					...Object.fromEntries(kept.map((table) => [table, before[table]])),
					...(version >= 3
						? {}
						: {
								sessions: before.sessions!.map((row) => {
									const { revision: _revision, ...rest } = row as Record<string, unknown>;
									return rest;
								}),
								transaction_commits: [],
							}),
					...(version >= 4
						? {}
						: {
								client_inputs: before.client_inputs!.map((row) => ({
									...(row as Record<string, unknown>),
									origin: null,
								})),
							}),
				});
				// No review row survives in any form: the derived indexes start empty.
				for (const table of REVIEW_TABLES) expect(after[table]).toBeUndefined();
				expect(after.review_run_index).toEqual([]);
				expect(after.review_discussion_index).toEqual([]);
				// Every session's cwd is indexed by its real path.
				expect(after.session_cwd_index).toEqual(
					(before.sessions as Array<{ id: string }>)
						.map(({ id }) => ({ session_id: id, cwd_key: realpathSync.native(dir) }))
						.sort((left, right) => left.session_id.localeCompare(right.session_id)),
				);
				expect(schemaObjects(db)).toEqual(freshSchemaObjects());
				expect(db.prepare("SELECT value_json FROM store_metadata WHERE key = 'created_at'").get()?.value_json).toBe(
					canonical(NOW),
				);
				expect(db.prepare("SELECT value_json FROM store_metadata WHERE key = 'schema_id'").get()?.value_json).toBe(
					canonical("volt-session-store-v6"),
				);
				expect(db.prepare("PRAGMA integrity_check").get()?.integrity_check).toBe("ok");
				expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
				expect(db.prepare("SELECT name FROM temp.sqlite_schema").all()).toEqual([]);
			} finally {
				db.close();
			}
			expect(await client.loadSession("source", "source-generation")).toMatchObject({
				session: { id: "source", sessionGeneration: "source-generation", lastOrdinal: 2 },
				entries: [{ id: "receipt" }, { id: "message" }],
				clientInputs: [{ clientMessageId: "client", origin: null, state: "accepted" }],
			});
			const evidence = await client.reconcileCommit({
				sessionId: "source",
				sessionGeneration: "source-generation",
				commitId: "commit",
				digest: COMMIT_DIGEST,
			});
			// Ordinal-keyed v3 evidence survives; revision-keyed evidence has no ordinal form.
			expect(evidence.status).toBe(version >= 3 ? "committed" : "not_found");
			expect(await client.applyTransaction(sessionInfoTransaction(1, "stale"))).toEqual({
				status: "conflict",
				actualOrdinal: 2,
			});
			expect(await client.applyTransaction(sessionInfoTransaction(2, "upgraded"))).toMatchObject({
				status: "committed",
				evidence: { commitId: "upgraded", beforeOrdinal: 2, afterOrdinal: 3 },
			});
			expect(await client.applyTransaction(withdrawTransaction(3))).toMatchObject({ status: "committed" });
			expect((await client.loadSession("source", "source-generation"))?.clientInputs).toMatchObject([
				{ clientMessageId: "client", origin: null, state: "withdrawn" },
			]);
			// The pre-v5 run is an unanchored report: no anchor, alias, or discussion linkage remains.
			expect(await client.findReviewRun("run")).toBeNull();
			expect(await client.findReviewDiscussion("discussion")).toBeNull();
			expect(
				await client.findReviewDiscussionChild({ sessionId: "child", sessionGeneration: "child-generation" }),
			).toBeNull();
			const manager = await SessionManager.open({
				sessionDirectory: dir,
				storeId: "original-store",
				sessionId: "related",
				sessionGeneration: "related-generation",
			});
			try {
				expect(manager.getHeader()?.parentSession).toMatchObject({
					storeId: "original-store",
					sessionId: "source",
					sessionGeneration: "source-generation",
				});
				expect(manager.getReviewState().aliases.size).toBe(0);
			} finally {
				await manager.closePersistence();
			}
			if (hasReviewTables(version)) {
				const child = await SessionManager.open({
					sessionDirectory: dir,
					storeId: "original-store",
					sessionId: "child",
					sessionGeneration: "child-generation",
				});
				try {
					expect(child.getReviewDiscussion()).toBeNull();
				} finally {
					await child.closePersistence();
				}
			}
			await client.close();
			const reopened = await open(dir);
			expect(reopened.info.storeId).toBe("original-store");
			expect(await reopened.loadSession("source", "source-generation")).toMatchObject({
				session: { lastOrdinal: 4, name: "after upgrade" },
			});
		},
	);

	it("creates fresh v6 stores and leaves repeat opens unchanged", async () => {
		const dir = directory();
		const client = await open(dir);
		expect(client.info.schemaVersion).toBe(6);
		await client.close();
		const db = new DatabaseSync(client.info.databasePath);
		const before = dump(db);
		db.close();
		const next = await open(dir);
		expect(next.info.storeId).toBe(client.info.storeId);
		const after = new DatabaseSync(next.info.databasePath);
		try {
			expect(dump(after)).toEqual(before);
		} finally {
			after.close();
		}
	});

	it.each(VERSIONS)("converges across simultaneous independent worker upgrades from v%i", async (version) => {
		const dir = directory();
		seed(dir, version);
		const results = await Promise.allSettled(Array.from({ length: 8 }, () => open(dir)));
		// Settle every opener before cleanup, including when one reports an error.
		expect(results.filter((result) => result.status === "rejected")).toEqual([]);
		const opened = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
		expect(new Set(opened.map((client) => client.info.storeId))).toEqual(new Set(["original-store"]));
		expect(opened.every((client) => client.info.schemaVersion === 6)).toBe(true);
		for (const client of opened)
			expect((await client.loadSession("source", "source-generation"))?.entries).toHaveLength(2);
	});

	it.each([
		[1, "revision drop", "ALTER TABLE sessions DROP COLUMN revision"],
		[1, "client input restore", CLIENT_INPUT_RESTORE],
		[1, "review index DDL", SESSION_STORE_REVIEW_INDEX_SCHEMA_SQL],
		[1, "version", "PRAGMA user_version = 6"],
		[1, "commit", "COMMIT"],
		[2, "revision drop", "ALTER TABLE sessions DROP COLUMN revision"],
		[2, "evidence drop", "DROP TABLE transaction_commits"],
		[2, "evidence DDL", SESSION_STORE_TRANSACTION_COMMITS_SCHEMA_SQL],
		[2, "client input restore", CLIENT_INPUT_RESTORE],
		[2, "review anchor drop", DROP_ANCHORS],
		[2, "version", "PRAGMA user_version = 6"],
		[2, "commit", "COMMIT"],
		[3, "client input copy", CLIENT_INPUT_COPY],
		[3, "client input drop", CLIENT_INPUT_DROP],
		[3, "client input DDL", SESSION_STORE_CLIENT_INPUTS_SCHEMA_SQL],
		[3, "client input restore", CLIENT_INPUT_RESTORE],
		[3, "client input copy drop", CLIENT_INPUT_COPY_DROP],
		[3, "review discussion drop", DROP_DISCUSSIONS],
		[3, "version", "PRAGMA user_version = 6"],
		[3, "commit", "COMMIT"],
		[4, "review child drop", DROP_CHILDREN],
		[4, "review discussion drop", DROP_DISCUSSIONS],
		[4, "review alias drop", DROP_ALIASES],
		[4, "review anchor drop", DROP_ANCHORS],
		[4, "review index DDL", SESSION_STORE_REVIEW_INDEX_SCHEMA_SQL],
		[4, "cwd index DDL", SESSION_STORE_CWD_INDEX_SCHEMA_SQL],
		[4, "version", "PRAGMA user_version = 6"],
		[4, "commit", "COMMIT"],
		[5, "cwd index DDL", SESSION_STORE_CWD_INDEX_SCHEMA_SQL],
		[5, "version", "PRAGMA user_version = 6"],
		[5, "commit", "COMMIT"],
	] as const)("rolls back a v%i %s failure completely and permits a clean retry", (version, _phase, failingSql) => {
		const path = seed(directory(), version);
		const db = new DatabaseSync(path);
		try {
			db.exec("PRAGMA foreign_keys = ON");
			const before = dump(db);
			const exec = db.exec.bind(db);
			const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
				if (sql === "COMMIT" && failingSql === "COMMIT") throw new Error("injected commit failure");
				exec(sql);
				if (sql === failingSql) throw new Error("injected upgrade failure");
			});
			expect(() => initializeSessionStoreSchema(db)).toThrow(/injected/);
			expect(db.isTransaction).toBe(false);
			expect(dump(db)).toEqual(before);
			spy.mockRestore();
			expect(initializeSessionStoreSchema(db)).toBe("original-store");
			expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(6);
		} finally {
			db.close();
		}
	});

	it.each(VERSIONS)("rolls back failed v6 postvalidation including metadata and retries from v%i", (version) => {
		const db = new DatabaseSync(seed(directory(), version));
		try {
			const before = dump(db);
			const exec = db.exec.bind(db);
			const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
				exec(sql);
				if (sql === "PRAGMA user_version = 6") exec("CREATE VIEW unexpected_post_upgrade AS SELECT 1");
			});
			expect(() => initializeSessionStoreSchema(db)).toThrow(/exact supported schema/);
			expect(db.isTransaction).toBe(false);
			expect(dump(db)).toEqual(before);
			spy.mockRestore();
			expect(initializeSessionStoreSchema(db)).toBe("original-store");
		} finally {
			db.close();
		}
	});

	it.each(
		VERSIONS.flatMap((version) =>
			[
				"DROP INDEX entries_parent_idx",
				"CREATE TRIGGER unexpected AFTER UPDATE ON sessions BEGIN SELECT 1; END",
				"CREATE VIEW unexpected AS SELECT 1",
				"UPDATE store_metadata SET value_json = '\"tampered\"' WHERE key = 'schema_digest'",
				"UPDATE store_metadata SET value_json = '\"other\"' WHERE key = 'schema_id'",
				"INSERT INTO store_metadata VALUES ('extra', 'true')",
				"UPDATE store_metadata SET value_json = ' 1' WHERE key = 'schema_version'",
				"PRAGMA user_version = 7",
				"PRAGMA foreign_keys = OFF; INSERT INTO search_chunks VALUES ('missing', 0, NULL, 'orphan')",
				"PRAGMA ignore_check_constraints = ON; UPDATE sessions SET format_version = 0",
				// A partial or altered review or cwd index schema is not an exact one either.
				...(hasReviewTables(version)
					? [
							"DROP TABLE review_anchor_aliases",
							"DROP INDEX review_discussions_run_idx",
							"CREATE TABLE review_run_index (run_id TEXT PRIMARY KEY) STRICT",
						]
					: []),
				...(version === 5
					? [
							"DROP INDEX review_run_index_session_idx",
							"CREATE TABLE session_cwd_index (session_id TEXT PRIMARY KEY, cwd_key TEXT NOT NULL) STRICT",
						]
					: []),
			].map((sql) => [version, sql] as const),
		),
	)("rejects v%i tampering without partial upgrade: %s", async (version, sql) => {
		const dir = directory();
		const path = seed(dir, version);
		const db = new DatabaseSync(path);
		db.exec(sql);
		const before = dump(db);
		db.close();
		await expect(SQLiteSessionStoreClient.open(dir)).rejects.toMatchObject({ code: "store_schema_mismatch" });
		const after = new DatabaseSync(path);
		try {
			expect(dump(after)).toEqual(before);
		} finally {
			after.close();
		}
	});

	it("indexes a session whose cwd no longer exists by its resolved path", async () => {
		const dir = directory();
		const path = seed(dir, 5);
		const db = new DatabaseSync(path);
		try {
			db.prepare(`INSERT INTO sessions (id, session_generation, format_version, cwd, created_at, updated_at)
				VALUES ('gone', 'gone-generation', 5, ?, ?, ?)`).run(join(dir, "missing", "..", "removed"), NOW, NOW);
		} finally {
			db.close();
		}
		const client = await open(dir);
		expect((await client.findSessionSummaryById("gone"))?.cwdKey).toBe(join(realpathSync.native(dir), "removed"));
		expect((await client.findSessionSummaryById("source"))?.cwdKey).toBe(realpathSync.native(dir));
	});

	it("rejects a v6 store whose cwd index was altered", async () => {
		const dir = directory();
		const client = await open(dir);
		await client.close();
		const db = new DatabaseSync(client.info.databasePath);
		db.exec("DROP INDEX session_cwd_index_key_idx");
		db.close();
		await expect(SQLiteSessionStoreClient.open(dir)).rejects.toMatchObject({ code: "store_schema_mismatch" });
	});

	it.each(VERSIONS)("rejects weakened v%i DDL even when its metadata digest is recomputed", async (version) => {
		const dir = directory();
		seed(dir, version, LEGACY_SCHEMA_SQL[version].replace("format_version >= 1", "format_version >= 0"));
		await expect(SQLiteSessionStoreClient.open(dir)).rejects.toMatchObject({ code: "store_schema_mismatch" });
	});
});
