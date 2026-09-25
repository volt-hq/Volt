import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { classifyOperationalStoreError } from "../../src/core/session-store/sqlite-errors.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];

function databasePath(name = "store.sqlite"): string {
	const root = mkdtempSync(join(tmpdir(), "volt-sqlite-errors-"));
	roots.push(root);
	return join(root, name);
}

function open(path: string, options: ConstructorParameters<typeof DatabaseSync>[1] = {}): DatabaseSync {
	const database = new DatabaseSync(path, options);
	databases.push(database);
	return database;
}

function thrownBy(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("Expected the SQLite operation to fail");
}

afterEach(() => {
	for (const database of databases.splice(0)) if (database.isOpen) database.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("classifyOperationalStoreError", () => {
	it("classifies a real SQLite busy error as store_busy", () => {
		const path = databasePath();
		const holder = open(path);
		holder.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x)");
		holder.exec("BEGIN IMMEDIATE");
		const contender = open(path, { timeout: 0 });
		expect(classifyOperationalStoreError(thrownBy(() => contender.exec("BEGIN IMMEDIATE")))?.code).toBe("store_busy");
	});

	it("classifies a real SQLite table lock as store_busy", () => {
		const database = open(":memory:");
		database.exec("CREATE TABLE t (x); INSERT INTO t VALUES (1), (2)");
		const rows = database.prepare("SELECT x FROM t").iterate();
		rows.next();
		expect(classifyOperationalStoreError(thrownBy(() => database.exec("DROP TABLE t")))?.code).toBe("store_busy");
	});

	it("classifies a real SQLite full database as store_full", () => {
		const database = open(databasePath());
		database.exec("PRAGMA max_page_count = 2; CREATE TABLE t (x)");
		const error = thrownBy(() => database.prepare("INSERT INTO t VALUES (?)").run("x".repeat(100_000)));
		expect(classifyOperationalStoreError(error)?.code).toBe("store_full");
	});

	it("classifies real read-only and unopenable databases as store_io_error", () => {
		const path = databasePath();
		open(path).exec("CREATE TABLE t (x)");
		const readOnly = open(path, { readOnly: true });
		expect(classifyOperationalStoreError(thrownBy(() => readOnly.exec("INSERT INTO t VALUES (1)")))?.code).toBe(
			"store_io_error",
		);
		const missing = join(path, "..", "missing", "store.sqlite");
		expect(classifyOperationalStoreError(thrownBy(() => open(missing)))?.code).toBe("store_io_error");
	});

	// Windows cannot rename a database file that SQLite holds open.
	it.skipIf(process.platform === "win32")("classifies extended SQLite result codes by their primary code", () => {
		const path = databasePath();
		const database = open(path);
		database.exec("CREATE TABLE t (x)");
		renameSync(path, `${path}.moved`);
		const error = thrownBy(() => database.exec("INSERT INTO t VALUES (1)"));
		expect(error).toMatchObject({ errcode: 1032 });
		expect(classifyOperationalStoreError(error)?.code).toBe("store_io_error");
	});

	it("classifies file-system exhaustion and I/O failures", () => {
		const fsError = (code: string) => Object.assign(new Error(code), { code });
		expect(classifyOperationalStoreError(fsError("ENOSPC"))?.code).toBe("store_full");
		expect(classifyOperationalStoreError(fsError("EDQUOT"))?.code).toBe("store_full");
		for (const code of ["EIO", "EMFILE", "ENFILE"]) {
			expect(classifyOperationalStoreError(fsError(code))?.code).toBe("store_io_error");
		}
	});

	it("leaves constraint violations and non-SQLite errors unclassified", () => {
		const database = open(":memory:");
		database.exec("CREATE TABLE t (x PRIMARY KEY); INSERT INTO t VALUES (1)");
		expect(classifyOperationalStoreError(thrownBy(() => database.exec("INSERT INTO t VALUES (1)")))).toBeUndefined();
		expect(classifyOperationalStoreError(Object.assign(new Error("busy"), { errcode: 5 }))).toBeUndefined();
		expect(classifyOperationalStoreError(new TypeError("bad input"))).toBeUndefined();
		expect(classifyOperationalStoreError("database is locked")).toBeUndefined();
	});

	it("keeps the original failure as the cause", () => {
		const cause = Object.assign(new Error("disk full"), { code: "ENOSPC" });
		expect(classifyOperationalStoreError(cause)?.cause).toBe(cause);
	});
});
