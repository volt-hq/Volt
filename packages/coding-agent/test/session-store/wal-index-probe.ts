import { execFileSync } from "node:child_process";

/**
 * Reports whether a connection opened by another process keeps the existing
 * WAL index, i.e. whether some live connection still holds SQLite's shared-memory
 * locks on `databasePath`.
 *
 * The first connection to a quiescent WAL database truncates and rebuilds
 * `-shm`, while bytes 120..127 are reserved lock slots that SQLite never reads
 * or writes (https://www.sqlite.org/walformat.html). A marker placed there
 * therefore survives a foreign open only if the index was not reinitialized.
 *
 * Every file access happens in a child process: opening and closing `-shm` in
 * the caller would itself release the caller's POSIX record locks.
 */
export function foreignOpenPreservesWalIndex(databasePath: string): boolean {
	const script = `
const { closeSync, openSync, readSync, writeSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const [databasePath] = process.argv.slice(1);
const shmPath = databasePath + "-shm";
const MARKER_OFFSET = 121;
const MARKER = 0xa5;
let fd = openSync(shmPath, "r+");
try { writeSync(fd, Buffer.from([MARKER]), 0, 1, MARKER_OFFSET); } finally { closeSync(fd); }
const marker = Buffer.alloc(1);
const db = new DatabaseSync(databasePath, { timeout: 5000 });
try {
	db.prepare("SELECT count(*) AS n FROM sqlite_schema").get();
	// Read before closing: a sole connection deletes -shm when it closes.
	fd = openSync(shmPath, "r");
	try { readSync(fd, marker, 0, 1, MARKER_OFFSET); } finally { closeSync(fd); }
} finally {
	db.close();
}
process.stdout.write(marker[0] === MARKER ? "preserved" : "reinitialized");
`;
	const result = execFileSync(
		process.execPath,
		["--disable-warning=ExperimentalWarning", "-e", script, databasePath],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (result !== "preserved" && result !== "reinitialized") {
		throw new Error(`Unexpected WAL index probe output: ${JSON.stringify(result)}`);
	}
	return result === "preserved";
}
