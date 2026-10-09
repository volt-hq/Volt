/**
 * Where the interactive TUI starts (Phase 7 slice 8): the conversation it
 * opens in a daemon worker, resolved read-only from its arguments. The TUI
 * never opens a stored log for writing; a JSONL file it starts from is
 * imported into the store first.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import * as startupUi from "../src/cli/startup-ui.ts";
import { resolveTuiStartupTarget, type TuiStartupContext } from "../src/cli/tui-startup.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { exportSessionToJsonl } from "../src/core/session/session-info.ts";
import { getDefaultSessionDirPath, SessionManager, type SessionReference } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let root: string;
let agentDir: string;
let project: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "volt-tui-startup-"));
	agentDir = join(root, "agent");
	project = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(project, { recursive: true });
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function context(overrides: Partial<TuiStartupContext> = {}): TuiStartupContext {
	return {
		cwd: project,
		sessionDir: undefined,
		agentDir,
		settingsManager: SettingsManager.inMemory(),
		confirm: async () => false,
		...overrides,
	};
}

/** A stored session of `cwd` with one user message. */
async function storedSession(cwd: string, sessionDir = getDefaultSessionDirPath()): Promise<SessionReference> {
	const manager = await SessionManager.create(cwd, sessionDir);
	await manager.logWriter.appendMessage({ role: "user", content: `stored in ${cwd}`, timestamp: 1 });
	const ref = manager.getSessionRef();
	await manager.closePersistence();
	if (ref === undefined) throw new Error("The session was not stored");
	return ref;
}

describe("the TUI's startup conversation", () => {
	it("is new by default (in its session directory), or new in memory with --no-session", async () => {
		const sessionDir = join(root, "custom-sessions");
		expect(await resolveTuiStartupTarget(parseArgs([]), context({ sessionDir }))).toEqual({
			target: { kind: "new", sessionDir },
			cwd: project,
		});
		expect(await resolveTuiStartupTarget(parseArgs(["--no-session"]), context())).toEqual({
			target: { kind: "new" },
			cwd: project,
		});
		expect(
			await resolveTuiStartupTarget(parseArgs(["--session-id", "0190f000-0000-7000-8000-000000000001"]), context()),
		).toEqual({
			target: { kind: "new", sessionId: "0190f000-0000-7000-8000-000000000001" },
			cwd: project,
		});
	});

	it("resumes a stored session read-only: -c, --session, and --session-id of an existing one", async () => {
		const ref = await storedSession(project);
		const open = vi.spyOn(SessionManager, "open");
		const resumed = {
			target: { kind: "session", sessionId: ref.sessionId, sessionDir: ref.sessionDirectory },
			cwd: project,
		};
		expect(await resolveTuiStartupTarget(parseArgs(["-c"]), context())).toEqual(resumed);
		expect(await resolveTuiStartupTarget(parseArgs(["--session", ref.sessionId]), context())).toEqual(resumed);
		expect(await resolveTuiStartupTarget(parseArgs(["--session-id", ref.sessionId]), context())).toEqual(resumed);
		expect(open).not.toHaveBeenCalled();
	});

	it("forks a session by id, and offers a fork of another project's session", async () => {
		const elsewhere = join(root, "elsewhere");
		mkdirSync(elsewhere);
		const ref = await storedSession(elsewhere);
		const forked = {
			target: { kind: "fork", source: { sessionId: ref.sessionId, sessionDir: ref.sessionDirectory } },
			cwd: project,
		};
		expect(await resolveTuiStartupTarget(parseArgs(["--fork", ref.sessionId]), context())).toEqual(forked);
		vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await resolveTuiStartupTarget(parseArgs(["--session", ref.sessionId]), context())).toEqual({ exit: 0 });
		expect(
			await resolveTuiStartupTarget(parseArgs(["--session", ref.sessionId]), context({ confirm: async () => true })),
		).toEqual(forked);
		expect(await resolveTuiStartupTarget(parseArgs(["--session", "missing-id"]), context())).toEqual({
			exit: 1,
			message: "No session found matching 'missing-id'",
		});
	});

	it("imports a JSONL file it starts from, then opens the imported session", async () => {
		const ref = await storedSession(project);
		const source = await SessionManager.open(ref);
		const file = exportSessionToJsonl(source, join(root, "export.jsonl"));
		await source.closePersistence();
		const sessionDir = join(root, "imported-sessions");

		const resumed = await resolveTuiStartupTarget(parseArgs(["--session", file]), context({ sessionDir }));
		if ("exit" in resumed) throw new Error("The import did not start");
		expect(resumed).toMatchObject({ target: { kind: "session", sessionDir }, cwd: project });
		const imported = await SessionManager.findForResume(
			sessionDir,
			(resumed.target as { sessionId: string }).sessionId,
		);
		expect(imported?.sessionId).not.toBe(ref.sessionId);

		const forkId = "0190f000-0000-7000-8000-0000000000f0";
		const forked = await resolveTuiStartupTarget(
			parseArgs(["--fork", file, "--session-id", forkId]),
			context({ sessionDir }),
		);
		expect(forked).toEqual({ target: { kind: "session", sessionId: forkId, sessionDir }, cwd: project });
		// Imported and closed: a worker can open it.
		const reopened = await SessionManager.open((await SessionManager.findForResume(sessionDir, forkId))!);
		await reopened.closePersistence();
	});

	it("asks to continue a session whose working directory is gone in the TUI's, and starts nothing when cancelled", async () => {
		// Started through a link to the project: indexed there, its stored cwd is the link, which is then removed.
		const gone = join(root, "gone");
		symlinkSync(project, gone, "dir");
		const ref = await storedSession(gone);
		unlinkSync(gone);
		const selector = vi.spyOn(startupUi, "showStartupSelector").mockResolvedValueOnce(undefined);
		expect(await resolveTuiStartupTarget(parseArgs(["-c"]), context())).toEqual({ exit: 0 });
		selector.mockResolvedValueOnce(project as never);
		expect(await resolveTuiStartupTarget(parseArgs(["-c"]), context())).toEqual({
			target: { kind: "session", sessionId: ref.sessionId, sessionDir: ref.sessionDirectory, cwdOverride: project },
			cwd: project,
		});
	});
});
