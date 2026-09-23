import { SessionStoreError } from "./types.ts";

// Primary SQLite result codes: https://sqlite.org/rescode.html
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;
const SQLITE_IOERR = 10;
const SQLITE_FULL = 13;
const SQLITE_CANTOPEN = 14;

/**
 * Map environmental store failures to stable operational codes. node:sqlite
 * reports every SQLite failure as `ERR_SQLITE_ERROR` with the extended result
 * code in `errcode`; file-system failures carry their errno name in `code`.
 */
export function classifyOperationalStoreError(error: unknown): SessionStoreError | undefined {
	if (!error || typeof error !== "object") return undefined;
	const { code, errcode } = error as { code?: unknown; errcode?: unknown };
	const sqliteCode = code === "ERR_SQLITE_ERROR" && typeof errcode === "number" ? errcode & 0xff : undefined;
	if (sqliteCode === SQLITE_BUSY || sqliteCode === SQLITE_LOCKED) {
		return new SessionStoreError("store_busy", "SQLite session store is busy", { cause: error });
	}
	if (sqliteCode === SQLITE_FULL || code === "ENOSPC" || code === "EDQUOT") {
		return new SessionStoreError("store_full", "SQLite session store is full", { cause: error });
	}
	if (
		sqliteCode === SQLITE_IOERR ||
		sqliteCode === SQLITE_CANTOPEN ||
		sqliteCode === SQLITE_READONLY ||
		code === "EIO" ||
		code === "EMFILE" ||
		code === "ENFILE"
	) {
		return new SessionStoreError("store_io_error", "SQLite session store I/O failed", { cause: error });
	}
	return undefined;
}
