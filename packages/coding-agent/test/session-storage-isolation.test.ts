import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../src/config.ts";
import { findLocalSessionByExactId, findSessionByExactId, resolveSessionArgument } from "../src/core/session-lookup.ts";
import {
	getDefaultSessionDir,
	getDefaultSessionDirPath,
	type SessionInfo,
	SessionManager,
} from "../src/core/session-manager.ts";
import { SESSION_STORE_DATABASE_FILENAME } from "../src/core/session-store/index.ts";

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.closePersistence();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("keeps default persisted session storage inside the Vitest agent sandbox", async () => {
	const agentDir = process.env[ENV_AGENT_DIR];
	expect(agentDir).toBeTruthy();
	if (!agentDir) throw new Error("Vitest did not configure an isolated agent directory");
	expect(process.env[ENV_SESSION_DIR]).toBe("");
	if (process.platform !== "win32") expect(statSync(agentDir).mode & 0o777).toBe(0o700);

	const cwd = mkdtempSync(join(tmpdir(), "volt-session-storage-isolation-"));
	let manager: SessionManager | undefined;
	try {
		manager = await SessionManager.create(cwd);
		const reference = manager.getSessionRef();
		if (!reference) throw new Error("Expected a persisted session reference");

		const expectedSessionDir = getDefaultSessionDirPath(agentDir);
		const relativeSessionDir = relative(agentDir, reference.sessionDirectory);
		expect(relativeSessionDir).not.toBe("");
		expect(relativeSessionDir.startsWith("..")).toBe(false);
		expect(isAbsolute(relativeSessionDir)).toBe(false);
		expect(reference.sessionDirectory).toBe(expectedSessionDir);
		expect(existsSync(join(expectedSessionDir, SESSION_STORE_DATABASE_FILENAME))).toBe(true);
	} finally {
		try {
			await manager?.closePersistence();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	}
});

describe("the default session store", () => {
	/** An agent directory of its own, and `repo`, `repo/sub`, a sibling `repo-other`, and `alias` -> `repo`. */
	function setup() {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-default-store-")));
		roots.push(root);
		const agentDir = join(root, "agent");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const repo = join(root, "repo");
		const sub = join(repo, "sub");
		const sibling = join(root, "repo-other");
		for (const directory of [sub, sibling]) mkdirSync(directory, { recursive: true });
		const alias = join(root, "alias");
		symlinkSync(repo, alias, "dir");
		return { agentDir, repo, sub, sibling, alias };
	}

	async function visibleSession(cwd: string, message: string, sessionDir?: string): Promise<SessionManager> {
		const manager = await SessionManager.create(cwd, sessionDir);
		managers.push(manager);
		await manager.logWriter.appendMessage({ role: "user", content: message, timestamp: Date.now() });
		return manager;
	}

	const ids = (sessions: readonly SessionInfo[]): string[] => sessions.map((session) => session.id).sort();

	it("holds every directory's sessions in one store; Current Folder is the exact canonical directory", async () => {
		const { agentDir, repo, sub, sibling, alias } = setup();
		const inRepo = await visibleSession(repo, "repo needle");
		const inSub = await visibleSession(sub, "sub needle");
		const inSibling = await visibleSession(sibling, "sibling needle");
		const viaAlias = await visibleSession(alias, "alias needle");

		const store = join(agentDir, "sessions");
		expect(getDefaultSessionDir()).toBe(store);
		for (const manager of [inRepo, inSub, inSibling, viaAlias]) {
			expect(manager.getSessionRef()?.sessionDirectory).toBe(store);
			expect(manager.usesDefaultSessionDir()).toBe(true);
		}
		// One database, no per-directory stores.
		expect(
			readdirSync(store, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map(({ name }) => name),
		).toEqual(["locks"]);

		const repoSessions = [inRepo.getSessionId(), viaAlias.getSessionId()].sort();
		expect(ids(await SessionManager.list(repo))).toEqual(repoSessions);
		expect(ids(await SessionManager.list(alias))).toEqual(repoSessions);
		expect(ids(await SessionManager.list(sub))).toEqual([inSub.getSessionId()]);
		expect(ids(await SessionManager.search(repo, "needle"))).toEqual(repoSessions);
		expect([inRepo.getSessionId(), viaAlias.getSessionId()]).toContain(
			(await SessionManager.findContinuation(repo))?.sessionId,
		);
		expect((await SessionManager.findContinuation(sibling))?.sessionId).toBe(inSibling.getSessionId());

		const everyone = [inRepo, inSub, inSibling, viaAlias].map((manager) => manager.getSessionId()).sort();
		expect(ids(await SessionManager.listAll())).toEqual(everyone);
		expect(ids(await SessionManager.searchAll("needle"))).toEqual(everyone);
	});

	it("finds a session by id in the default store, as this directory's or another's", async () => {
		const { repo, sub } = setup();
		const inSub = await visibleSession(sub, "sub");
		const id = inSub.getSessionId();

		expect(await findSessionByExactId(id)).toMatchObject({ ref: inSub.getSessionRef(), cwd: sub });
		expect(await findLocalSessionByExactId(id, sub)).toEqual({ type: "local", ref: inSub.getSessionRef() });
		expect(await findLocalSessionByExactId(id, repo)).toBeUndefined();
		expect(await resolveSessionArgument(id, sub)).toEqual({ type: "local", ref: inSub.getSessionRef() });
		expect(await resolveSessionArgument(id, repo)).toEqual({ type: "global", ref: inSub.getSessionRef(), cwd: sub });
		expect(await resolveSessionArgument(id.slice(0, 12), repo)).toMatchObject({ type: "global", cwd: sub });
	});

	it("keeps a custom store's sessions to that store", async () => {
		const { repo } = setup();
		const custom = join(repo, "..", "custom-sessions");
		const inCustom = await visibleSession(repo, "custom", custom);
		const inDefault = await visibleSession(repo, "default");

		expect(inCustom.usesDefaultSessionDir()).toBe(false);
		expect(ids(await SessionManager.list(repo, custom))).toEqual([inCustom.getSessionId()]);
		expect(ids(await SessionManager.list(repo))).toEqual([inDefault.getSessionId()]);
		expect(ids(await SessionManager.listAll(custom))).toEqual([inCustom.getSessionId()]);
		expect(await findSessionByExactId(inCustom.getSessionId())).toBeUndefined();
		expect(await findSessionByExactId(inCustom.getSessionId(), custom)).toMatchObject({ cwd: repo });
		// A directory searched before the default store.
		expect(await findSessionByExactId(inCustom.getSessionId(), undefined, [custom])).toMatchObject({ cwd: repo });
	});
});
