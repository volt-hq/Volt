import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { parseCanonicalSessionStoreJson, stringifyCanonicalSessionStoreJson } from "./canonical-json.ts";
import {
	SESSION_STORE_CLIENT_INPUTS_SCHEMA_SQL,
	SESSION_STORE_REVIEW_INDEX_SCHEMA_SQL,
	SESSION_STORE_SCHEMA_ID,
	SESSION_STORE_SCHEMA_SQL,
	SESSION_STORE_TRANSACTION_COMMITS_SCHEMA_SQL,
} from "./schema.ts";
import { SESSION_STORE_V1_SCHEMA_ID, SESSION_STORE_V1_SCHEMA_SQL } from "./schema-v1.ts";
import { SESSION_STORE_V2_SCHEMA_ID, SESSION_STORE_V2_SCHEMA_SQL } from "./schema-v2.ts";
import { SESSION_STORE_V3_SCHEMA_ID, SESSION_STORE_V3_SCHEMA_SQL } from "./schema-v3.ts";
import { SESSION_STORE_V4_SCHEMA_ID, SESSION_STORE_V4_SCHEMA_SQL } from "./schema-v4.ts";
import { SESSION_STORE_SCHEMA_VERSION, SessionStoreError } from "./types.ts";

/** The v3 client input columns, copied into the rebuilt v4 table (which adds `origin`). */
const V3_CLIENT_INPUT_COLUMNS =
	"session_id, client_message_id, receipt_entry_id, command, semantic_digest, input_json, queued_entry_id, queued_input_json, state, error, canonical_entry_id";

/** The v4 client input table steps, in order. SQLite cannot alter a CHECK constraint, so the table is rebuilt. */
export const SESSION_STORE_V4_CLIENT_INPUT_UPGRADE_SQL = [
	`CREATE TEMP TABLE client_inputs_v3 AS SELECT ${V3_CLIENT_INPUT_COLUMNS} FROM main.client_inputs`,
	"DROP TABLE main.client_inputs",
	SESSION_STORE_CLIENT_INPUTS_SCHEMA_SQL,
	`INSERT INTO main.client_inputs (${V3_CLIENT_INPUT_COLUMNS}) SELECT ${V3_CLIENT_INPUT_COLUMNS} FROM temp.client_inputs_v3`,
	"DROP TABLE temp.client_inputs_v3",
] as const;

/**
 * The review tables v2 added, dropped by the v5 upgrade in this order (a
 * table before the tables it references). Their rows are carried nowhere:
 * review state is now log entries, and runs from before v5 stay unanchored
 * reports. The v5 review indexes start empty.
 */
export const SESSION_STORE_V5_REVIEW_UPGRADE_SQL = [
	"DROP TABLE main.review_discussion_children",
	"DROP TABLE main.review_discussions",
	"DROP TABLE main.review_anchor_aliases",
	"DROP TABLE main.review_anchors",
] as const;

function schemaDigest(db: DatabaseSync): string {
	const objects = db
		.prepare(`SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name`)
		.all();
	// SQLite rows have null prototypes; canonical JSON accepts only ordinary objects.
	const canonical = stringifyCanonicalSessionStoreJson(
		objects.map((row) => ({ ...row })),
		"Schema objects",
	);
	return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

function expectedDigest(sql: string): string {
	const db = new DatabaseSync(":memory:");
	try {
		db.exec(sql);
		return schemaDigest(db);
	} finally {
		db.close();
	}
}

const SCHEMAS = {
	1: { schemaId: SESSION_STORE_V1_SCHEMA_ID, digest: expectedDigest(SESSION_STORE_V1_SCHEMA_SQL) },
	2: { schemaId: SESSION_STORE_V2_SCHEMA_ID, digest: expectedDigest(SESSION_STORE_V2_SCHEMA_SQL) },
	3: { schemaId: SESSION_STORE_V3_SCHEMA_ID, digest: expectedDigest(SESSION_STORE_V3_SCHEMA_SQL) },
	4: { schemaId: SESSION_STORE_V4_SCHEMA_ID, digest: expectedDigest(SESSION_STORE_V4_SCHEMA_SQL) },
	5: { schemaId: SESSION_STORE_SCHEMA_ID, digest: expectedDigest(SESSION_STORE_SCHEMA_SQL) },
} as const;

function mismatch(message: string): never {
	throw new SessionStoreError("store_schema_mismatch", message);
}

function validateSchema(db: DatabaseSync, version: keyof typeof SCHEMAS): string {
	const { digest, schemaId } = SCHEMAS[version];
	if (db.prepare("PRAGMA user_version").get()?.user_version !== version || schemaDigest(db) !== digest) {
		mismatch("Session store DDL, views, triggers or version do not match the exact supported schema");
	}
	const metadata = new Map(
		db
			.prepare("SELECT key, value_json FROM store_metadata ORDER BY key")
			.all()
			.map((row) => {
				if (typeof row.key !== "string" || typeof row.value_json !== "string") mismatch("Invalid store metadata");
				try {
					return [row.key, parseCanonicalSessionStoreJson(row.value_json, "Store metadata")] as const;
				} catch {
					return mismatch("Store metadata must be canonical JSON");
				}
			}),
	);
	const storeId = metadata.get("store_id");
	const createdAt = metadata.get("created_at");
	if (
		metadata.size !== 5 ||
		metadata.get("schema_id") !== schemaId ||
		metadata.get("schema_digest") !== digest ||
		metadata.get("schema_version") !== version ||
		typeof storeId !== "string" ||
		storeId.length === 0 ||
		storeId.length > 512 ||
		storeId.includes("\0") ||
		typeof createdAt !== "string" ||
		!Number.isFinite(Date.parse(createdAt)) ||
		new Date(createdAt).toISOString() !== createdAt
	) {
		mismatch("Session store metadata does not match its schema version");
	}
	return storeId;
}

function validateIntegrity(db: DatabaseSync): void {
	const checks = db.prepare("PRAGMA integrity_check").all();
	if (checks.length !== 1 || checks[0]?.integrity_check !== "ok" || db.prepare("PRAGMA foreign_key_check").get()) {
		mismatch("Session store integrity verification failed");
	}
}

/** Only the exact frozen v1 to v4 schemas can upgrade. All DDL and metadata commit together. */
export function initializeSessionStoreSchema(db: DatabaseSync): string {
	// Re-read after the write lock: another opener may have initialized/upgraded while we waited.
	db.exec("BEGIN IMMEDIATE");
	try {
		const version = db.prepare("PRAGMA user_version").get()?.user_version;
		if (version === 0) {
			if (db.prepare("SELECT 1 FROM main.sqlite_schema LIMIT 1").get()) {
				mismatch("Refusing to initialize an unversioned non-empty session store");
			}
			db.exec(SESSION_STORE_SCHEMA_SQL);
			const insert = db.prepare("INSERT INTO store_metadata (key, value_json) VALUES (?, ?)");
			for (const [key, value] of Object.entries({
				schema_id: SESSION_STORE_SCHEMA_ID,
				schema_digest: SCHEMAS[5].digest,
				store_id: randomUUID(),
				schema_version: SESSION_STORE_SCHEMA_VERSION,
				created_at: new Date().toISOString(),
			}))
				insert.run(key, stringifyCanonicalSessionStoreJson(value, "Store metadata"));
			db.exec(`PRAGMA user_version = ${SESSION_STORE_SCHEMA_VERSION}`);
		} else if (version === 1 || version === 2 || version === 3 || version === 4) {
			validateSchema(db, version);
			validateIntegrity(db);
			if (version === 1 || version === 2) {
				// v3 fences on entry ordinals. Revision-keyed commit evidence has no ordinal form; it only
				// reconciles a live writer's uncertain commit, and no pre-v3 writer can commit after this.
				db.exec("ALTER TABLE sessions DROP COLUMN revision");
				db.exec("DROP TABLE transaction_commits");
				db.exec(SESSION_STORE_TRANSACTION_COMMITS_SCHEMA_SQL);
			}
			// v4 client inputs record the receipt's origin and the terminal `withdrawn` state.
			if (version !== 4) for (const sql of SESSION_STORE_V4_CLIENT_INPUT_UPGRADE_SQL) db.exec(sql);
			// v5 keeps review state in the logs; v1 never had the review tables.
			if (version !== 1) for (const sql of SESSION_STORE_V5_REVIEW_UPGRADE_SQL) db.exec(sql);
			db.exec(SESSION_STORE_REVIEW_INDEX_SCHEMA_SQL);
			const update = db.prepare("UPDATE store_metadata SET value_json = ? WHERE key = ?");
			update.run(stringifyCanonicalSessionStoreJson(SESSION_STORE_SCHEMA_ID, "Schema id"), "schema_id");
			update.run(stringifyCanonicalSessionStoreJson(SCHEMAS[5].digest, "Schema digest"), "schema_digest");
			update.run(
				stringifyCanonicalSessionStoreJson(SESSION_STORE_SCHEMA_VERSION, "Schema version"),
				"schema_version",
			);
			db.exec(`PRAGMA user_version = ${SESSION_STORE_SCHEMA_VERSION}`);
			validateIntegrity(db);
		} else if (version !== SESSION_STORE_SCHEMA_VERSION) {
			mismatch(`Session store schema version ${String(version)} is unsupported`);
		}
		const storeId = validateSchema(db, SESSION_STORE_SCHEMA_VERSION);
		db.exec("COMMIT");
		return storeId;
	} catch (error) {
		if (db.isTransaction) db.exec("ROLLBACK");
		throw error;
	}
}
