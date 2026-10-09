/**
 * Finding a stored session from the CLI's arguments, read-only: by exact id
 * (an indexed lookup in the session directory, or in the default store), by
 * id prefix, or a JSONL file path to import. Only the host that opens the
 * session opens its log.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import { sameFilesystemLocation } from "./host/session-summaries.ts";
import {
	assertValidSessionId,
	findSessionInfoById,
	getDefaultSessionDirPath,
	type SessionInfo,
	SessionManager,
	type SessionReference,
} from "./session-manager.ts";
import { SESSION_STORE_DATABASE_FILENAME } from "./session-store/index.ts";

/** A session argument resolved: a JSONL file to import, a session of this project or of another, or none. */
export type ResolvedSession =
	| { type: "path"; path: string }
	| { type: "local"; ref: SessionReference }
	| { type: "global"; ref: SessionReference; cwd: string }
	| { type: "not_found"; arg: string };

/** A stored session found by id: its reference and its stored working directory. */
export interface FoundSession {
	readonly ref: SessionReference;
	readonly cwd: string;
}

function canBeExactSessionId(value: string): boolean {
	try {
		assertValidSessionId(value);
		return true;
	} catch {
		return false;
	}
}

function hasSessionStore(sessionDirectory: string): boolean {
	return existsSync(join(resolvePath(sessionDirectory), SESSION_STORE_DATABASE_FILENAME));
}

async function findExactSessionInfoInStore(
	sessionDirectory: string,
	sessionId: string,
): Promise<SessionInfo | undefined> {
	const directory = resolvePath(sessionDirectory);
	if (!hasSessionStore(directory)) return undefined;
	return findSessionInfoById(directory, sessionId);
}

/**
 * The stored session `sessionId`: in `sessionDir` when given, else in the
 * directories in `first`, then in the default store. A store that cannot be
 * read is skipped; when none could be read, the lookup fails with their
 * errors.
 */
export async function findSessionByExactId(
	sessionId: string,
	sessionDir?: string,
	first: readonly string[] = [],
): Promise<FoundSession | undefined> {
	if (sessionDir) {
		const info = await findExactSessionInfoInStore(sessionDir, sessionId);
		return info ? { ref: info.ref, cwd: info.cwd } : undefined;
	}

	const storeErrors: unknown[] = [];
	let readableStores = 0;
	const searched = new Set<string>();
	const findInReadableStore = async (directory: string): Promise<SessionInfo | undefined> => {
		const key = canonicalizePath(resolvePath(directory));
		if (searched.has(key)) return undefined;
		searched.add(key);
		if (!hasSessionStore(directory)) return undefined;
		try {
			const info = await findSessionInfoById(directory, sessionId);
			readableStores++;
			return info;
		} catch (error) {
			storeErrors.push(error);
			return undefined;
		}
	};

	for (const directory of [...first, getDefaultSessionDirPath()]) {
		const info = await findInReadableStore(directory);
		if (info) return { ref: info.ref, cwd: info.cwd };
	}
	if (readableStores === 0 && storeErrors.length > 0) {
		throw new AggregateError(storeErrors, "Could not look up an exact session ID in any session store");
	}
	return undefined;
}

/** The stored session `sessionId` of exactly `cwd`: in `sessionDir`, or the default store. */
export async function findLocalSessionByExactId(
	sessionId: string,
	cwd: string,
	sessionDir?: string,
): Promise<{ type: "local"; ref: SessionReference } | undefined> {
	const directory = sessionDir ?? getDefaultSessionDirPath();
	const info = await findExactSessionInfoInStore(directory, sessionId);
	if (!info || (info.cwd && !sameFilesystemLocation(info.cwd, cwd))) return undefined;
	return { type: "local", ref: info.ref };
}

/**
 * Resolve a `--session`/`--fork` argument: a file path is a JSONL file to
 * import; an exact id is looked up by index; a prefix matches this
 * project's sessions first, then every project's.
 */
export async function resolveSessionArgument(
	sessionArg: string,
	cwd: string,
	sessionDir?: string,
): Promise<ResolvedSession> {
	// A file path is resolved before anything opens it.
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
		return { type: "path", path: resolvePath(sessionArg, cwd) };
	}

	// Exact IDs use indexed summary lookup; only the final owner opens the selected transcript.
	const exactMatch = canBeExactSessionId(sessionArg) ? await findSessionByExactId(sessionArg, sessionDir) : undefined;
	if (exactMatch) {
		return !exactMatch.cwd || sameFilesystemLocation(exactMatch.cwd, cwd)
			? { type: "local", ref: exactMatch.ref }
			: { type: "global", ref: exactMatch.ref, cwd: exactMatch.cwd };
	}

	// Prefix matching intentionally remains visible-session enumeration.
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localPrefixMatch = localSessions.find((session) => session.id.startsWith(sessionArg));
	if (localPrefixMatch) return { type: "local", ref: localPrefixMatch.ref };

	const allSessions = await SessionManager.listAll(sessionDir);
	const globalMatch = allSessions.find((session) => session.id.startsWith(sessionArg));
	if (globalMatch) return { type: "global", ref: globalMatch.ref, cwd: globalMatch.cwd };

	return { type: "not_found", arg: sessionArg };
}
