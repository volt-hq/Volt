import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOCK_OWNER_FILE = "owner.json";
const EMPTY_LOCK_STALE_MS = 10_000;

export interface DaemonLockOwner {
	pid: number;
	startedAtMs: number;
	token: string;
}

export interface DaemonLock {
	owner: DaemonLockOwner;
	release(): void;
}

export type AcquireDaemonLockResult =
	| { ok: true; lock: DaemonLock }
	| { ok: false; owner?: DaemonLockOwner; reason: "held" | "contended" };

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function ownerPath(lockDirPath: string): string {
	return join(lockDirPath, LOCK_OWNER_FILE);
}

function processExists(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isErrnoException(error) && error.code === "EPERM";
	}
}

export function readDaemonLockOwner(lockDirPath: string): DaemonLockOwner | undefined {
	try {
		const parsed = JSON.parse(readFileSync(ownerPath(lockDirPath), "utf8")) as Partial<DaemonLockOwner>;
		if (
			typeof parsed.pid !== "number" ||
			typeof parsed.startedAtMs !== "number" ||
			typeof parsed.token !== "string"
		) {
			return undefined;
		}
		return { pid: parsed.pid, startedAtMs: parsed.startedAtMs, token: parsed.token };
	} catch {
		return undefined;
	}
}

function emptyLockLooksFresh(lockDirPath: string, nowMs: number): boolean {
	try {
		return nowMs - statSync(lockDirPath).mtimeMs < EMPTY_LOCK_STALE_MS;
	} catch {
		return false;
	}
}

function releaseDaemonLock(lockDirPath: string, token: string): void {
	const owner = readDaemonLockOwner(lockDirPath);
	if (owner?.token === token) {
		rmSync(lockDirPath, { recursive: true, force: true });
	}
}

export function acquireDaemonLock(lockDirPath: string, startedAtMs: number): AcquireDaemonLockResult {
	const owner: DaemonLockOwner = { pid: process.pid, startedAtMs, token: randomUUID() };
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			mkdirSync(lockDirPath, { mode: 0o700 });
			writeFileSync(ownerPath(lockDirPath), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
			return {
				ok: true,
				lock: {
					owner,
					release() {
						releaseDaemonLock(lockDirPath, owner.token);
					},
				},
			};
		} catch (error) {
			if (!isErrnoException(error) || error.code !== "EEXIST") {
				throw error;
			}
			const existingOwner = readDaemonLockOwner(lockDirPath);
			if (existingOwner && processExists(existingOwner.pid)) {
				return { ok: false, owner: existingOwner, reason: "held" };
			}
			if (!existingOwner && emptyLockLooksFresh(lockDirPath, Date.now())) {
				return { ok: false, reason: "contended" };
			}
			rmSync(lockDirPath, { recursive: true, force: true });
		}
	}
	return { ok: false, reason: "contended" };
}
