import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { hardenSessionStoreFiles } from "../../src/core/session-store/artifacts.ts";
import { foreignOpenPreservesWalIndex } from "./wal-index-probe.ts";

const roots: string[] = [];
const databases: DatabaseSync[] = [];
function paths(): { database: string; target: string } {
	const root = mkdtempSync(join(tmpdir(), "volt-sidecar-"));
	roots.push(root);
	return { database: join(root, "sessions.sqlite"), target: join(root, "target") };
}

afterEach(() => {
	for (const database of databases.splice(0)) if (database.isOpen) database.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session store file hardening", () => {
	it("tightens the database and existing sidecars while allowing absent sidecars", () => {
		const { database } = paths();
		writeFileSync(database, "db", { mode: 0o644 });
		const identity = hardenSessionStoreFiles(database);
		expect(identity.ino).toBe(statSync(database).ino);
		writeFileSync(`${database}-wal`, "wal");
		writeFileSync(`${database}-shm`, "shm");
		chmodSync(`${database}-wal`, 0o644);
		hardenSessionStoreFiles(database);
		if (process.platform !== "win32") {
			for (const path of [database, `${database}-wal`, `${database}-shm`]) {
				expect(statSync(path).mode & 0o777).toBe(0o600);
			}
		}
		expect(readFileSync(`${database}-wal`, "utf8")).toBe("wal");
		rmSync(`${database}-wal`);
		expect(() => hardenSessionStoreFiles(database)).not.toThrow();
	});

	it("requires the database itself to exist", () => {
		const { database } = paths();
		expect(() => hardenSessionStoreFiles(database)).toThrow(expect.objectContaining({ code: "ENOENT" }));
	});

	it.skipIf(process.platform === "win32")("rejects both live and dangling symlinks without touching targets", () => {
		const { database, target } = paths();
		writeFileSync(database, "db");
		writeFileSync(target, "private target", { mode: 0o644 });
		symlinkSync(target, `${database}-wal`);
		expect(() => hardenSessionStoreFiles(database)).toThrow(/non-regular/);
		expect(readFileSync(target, "utf8")).toBe("private target");
		expect(statSync(target).mode & 0o777).toBe(0o644);
		rmSync(target);
		expect(() => hardenSessionStoreFiles(database)).toThrow(/non-regular/);
	});

	it("rejects multiply-linked sidecars without changing their contents", () => {
		const { database, target } = paths();
		writeFileSync(database, "db");
		writeFileSync(target, "target");
		linkSync(target, `${database}-wal`);
		expect(() => hardenSessionStoreFiles(database)).toThrow(/multiply-linked/);
		expect(readFileSync(target, "utf8")).toBe("target");
	});

	// SQLite's WAL locks are POSIX record locks: closing any descriptor for the
	// -shm file releases all of this process's locks on it. Windows locks are
	// per handle (and mandatory), so the hazard and this probe are POSIX-only.
	it.skipIf(process.platform === "win32")("probe reports an abandoned WAL index as reinitialized", () => {
		const { database } = paths();
		// Exit without closing so the sidecars outlive every connection.
		execFileSync(process.execPath, [
			"--disable-warning=ExperimentalWarning",
			"-e",
			'const { DatabaseSync } = require("node:sqlite"); const db = new DatabaseSync(process.argv[1]); db.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1)"); process.exit(0);',
			database,
		]);
		expect(existsSync(`${database}-shm`)).toBe(true);
		expect(foreignOpenPreservesWalIndex(database)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"keeps this process's live SQLite connection registered after hardening",
		() => {
			const { database } = paths();
			const live = new DatabaseSync(database);
			databases.push(live);
			live.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1)");
			expect(foreignOpenPreservesWalIndex(database)).toBe(true);

			hardenSessionStoreFiles(database);

			expect(foreignOpenPreservesWalIndex(database)).toBe(true);
			live.exec("INSERT INTO t VALUES (2)");
			expect(live.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
		},
	);
});
