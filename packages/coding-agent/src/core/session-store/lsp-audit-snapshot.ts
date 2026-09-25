import type * as crypto from "node:crypto";
import type * as fs from "node:fs";
import type * as sqlite from "node:sqlite";
import type * as url from "node:url";
import type * as threads from "node:worker_threads";

export interface AuditSnapshotOptions {
	path: string;
	schemaSql: string;
	maxSessions: number;
	maxEntries: number;
	maxBytes: number;
	maxEntryBytes: number;
}

export interface AuditSession {
	id: string;
	cwd: string;
	createdAt: string;
	origin: string | null;
}

export interface AuditEntry {
	sessionId: string;
	ordinal: number;
	timestamp: string;
	role: string | null;
	toolName: string | null;
	toolCallId: string | null;
	lsp: string | null;
	calls: string[];
}

export interface AuditSnapshot {
	status: "ok" | "missing" | "busy" | "unsupported" | "corrupt" | "unreadable";
	sessions: AuditSession[];
	entries: AuditEntry[];
	scannedEntries: number;
	scannedBytes: number;
	oversizedEntries: number;
	limited: boolean;
}

/**
 * Self-contained worker body: stringified so npm bundles and SEA need no new
 * worker asset. Only Node built-ins are required inside this isolated reader.
 * Never import the normal store worker/initializer here.
 */
export function runLspAuditSnapshot(loadBuiltin: (name: string) => unknown): void {
	// Parameter injection keeps ESM bundlers from rewriting require to a
	// module-scoped helper that would not exist in the stringified worker.
	const { DatabaseSync } = loadBuiltin("node:sqlite") as typeof sqlite;
	const { createHash } = loadBuiltin("node:crypto") as typeof crypto;
	const { statSync, existsSync } = loadBuiltin("node:fs") as typeof fs;
	const { pathToFileURL } = loadBuiltin("node:url") as typeof url;
	const { workerData, parentPort } = loadBuiltin("node:worker_threads") as typeof threads;
	const options = workerData as AuditSnapshotOptions;
	const result: AuditSnapshot = {
		status: "ok",
		sessions: [],
		entries: [],
		scannedEntries: 0,
		scannedBytes: 0,
		oversizedEntries: 0,
		limited: false,
	};
	let db: InstanceType<typeof DatabaseSync> | undefined;
	try {
		if (!existsSync(options.path)) {
			result.status = "missing";
			return;
		}
		const before = statSync(options.path);
		const hasWal = existsSync(`${options.path}-wal`);
		const hasShm = existsSync(`${options.path}-shm`);
		if (hasWal !== hasShm || existsSync(`${options.path}-journal`)) {
			result.status = "busy";
			return;
		}
		// A closed WAL database has no sidecars. Immutable mode avoids SQLite
		// creating them on a read-only open. Reject this snapshot if a writer
		// appears or the database changes while reading. Active WAL is never
		// opened immutable: its committed frames must participate in the read.
		const location = pathToFileURL(options.path);
		location.search = hasWal ? "?mode=ro" : "?mode=ro&immutable=1";
		db = new DatabaseSync(location, { readOnly: true, timeout: 50, allowExtension: false });
		db.exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF; BEGIN DEFERRED TRANSACTION");
		if (db.prepare("PRAGMA user_version").get()?.user_version !== 2) {
			result.status = "unsupported";
			return;
		}
		const schemaQuery =
			"SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name LIMIT 128";
		const schema = db.prepare(schemaQuery).all();
		const expected = new DatabaseSync(":memory:");
		try {
			expected.exec(options.schemaSql);
			if (JSON.stringify(schema) !== JSON.stringify(expected.prepare(schemaQuery).all())) {
				result.status = "unsupported";
				return;
			}
		} finally {
			expected.close();
		}
		const digest = `sha256:${createHash("sha256")
			.update(
				JSON.stringify(
					schema.map((row) => ({ name: row.name, sql: row.sql, tableName: row.tableName, type: row.type })),
				),
			)
			.digest("hex")}`;
		const metadata = new Map(
			db
				.prepare("SELECT key, substr(value_json, 1, 1024) AS value_json FROM store_metadata LIMIT 6")
				.all()
				.map((row) => [String(row.key), JSON.parse(String(row.value_json)) as unknown]),
		);
		const storeId = metadata.get("store_id");
		const createdAt = metadata.get("created_at");
		if (
			metadata.size !== 5 ||
			metadata.get("schema_id") !== "volt-session-store-v2" ||
			metadata.get("schema_version") !== 2 ||
			metadata.get("schema_digest") !== digest ||
			typeof storeId !== "string" ||
			storeId.length === 0 ||
			storeId.length > 512 ||
			storeId.includes("\0") ||
			typeof createdAt !== "string" ||
			!Number.isFinite(Date.parse(createdAt))
		) {
			result.status = "unsupported";
			return;
		}
		const sessions = db
			.prepare(
				"SELECT id, substr(cwd, 1, 8192) AS cwd, created_at AS createdAt, origin FROM sessions ORDER BY id LIMIT ?",
			)
			.all(options.maxSessions + 1);
		result.limited = sessions.length > options.maxSessions;
		result.sessions = sessions.slice(0, options.maxSessions) as unknown as AuditSession[];
		const lengths = db.prepare(
			"SELECT ordinal, length(CAST(payload_json AS BLOB)) AS bytes FROM entries WHERE session_id = ? AND ordinal > ? ORDER BY ordinal LIMIT 256",
		);
		const entry = db.prepare(`SELECT session_id AS sessionId, ordinal, timestamp,
			json_extract(payload_json, '$.message.role') AS role,
			json_extract(payload_json, '$.message.toolName') AS toolName,
			json_extract(payload_json, '$.message.toolCallId') AS toolCallId,
			CASE WHEN length(json_extract(payload_json, '$.message.details.lsp')) <= 4096
			THEN json_extract(payload_json, '$.message.details.lsp') END AS lsp,
			CASE WHEN json_extract(payload_json, '$.message.role') = 'assistant' THEN
			(SELECT json_group_array(json_extract(value, '$.name')) FROM json_each(payload_json, '$.message.content')
			 WHERE json_extract(value, '$.type') = 'toolCall') ELSE '[]' END AS calls
			FROM entries WHERE session_id = ? AND ordinal = ?`);
		outer: for (const session of result.sessions) {
			let ordinal = 0;
			while (true) {
				const batch = lengths.all(session.id, ordinal);
				if (batch.length === 0) break;
				for (const row of batch) {
					if (
						result.scannedEntries >= options.maxEntries ||
						result.scannedBytes + Number(row.bytes) > options.maxBytes
					) {
						result.limited = true;
						break outer;
					}
					ordinal = Number(row.ordinal);
					result.scannedEntries++;
					if (Number(row.bytes) > options.maxEntryBytes) {
						result.oversizedEntries++;
						continue;
					}
					result.scannedBytes += Number(row.bytes);
					const value = entry.get(session.id, ordinal);
					if (!value) continue;
					if (value.role === "toolResult" || value.role === "assistant" || value.role === "bashExecution") {
						result.entries.push({ ...value, calls: JSON.parse(String(value.calls)) } as unknown as AuditEntry);
					}
				}
			}
		}
		if (!hasWal) {
			const after = statSync(options.path);
			if (
				existsSync(`${options.path}-wal`) ||
				existsSync(`${options.path}-shm`) ||
				existsSync(`${options.path}-journal`) ||
				before.size !== after.size ||
				before.mtimeMs !== after.mtimeMs ||
				before.ino !== after.ino
			)
				result.status = "busy";
		}
	} catch (error) {
		const extendedCode = (error as { errcode?: number }).errcode;
		const code = typeof extendedCode === "number" ? extendedCode & 0xff : undefined;
		result.status = code === 5 || code === 6 ? "busy" : code === 11 || code === 26 ? "corrupt" : "unreadable";
	} finally {
		if (db?.isTransaction) db.exec("ROLLBACK");
		db?.close();
		if (result.status !== "ok") {
			result.sessions = [];
			result.entries = [];
		}
		parentPort?.postMessage(result);
	}
}
