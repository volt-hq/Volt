import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@hansjm10/volt-ai";
import type { RpcGitContext } from "@hansjm10/volt-protocol/git-context";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";

const STARTING_GIT_CONTEXT: RpcGitContext = {
	repository: "volt-app",
	head: {
		kind: "branch",
		name: "feature/work-organization",
		oid: "0123456789abcdef0123456789abcdef01234567",
	},
	upstream: null,
	base: null,
	status: {
		staged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
		unstaged: { added: 0, modified: 0, deleted: 0, renamed: 0 },
		untracked: 0,
		conflicted: 0,
		total: 0,
		clean: true,
	},
	operation: null,
	revision: 1,
	observedAt: "2026-08-29T00:00:00.000Z",
	stale: false,
};

function assistantMessage(text: string): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	} as Message;
}

describe("SessionManager starting Git context", () => {
	const tempDirs: string[] = [];
	const managerOwner = createSessionManagerTestOwner();

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "volt-session-start-git-"));
		tempDirs.push(dir);
		return dir;
	}

	beforeEach(() => managerOwner.start());

	afterEach(async () => {
		await managerOwner.drain();
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("persists only the first observation for a newly created session", async () => {
		const cwd = makeTempDir();
		const sessionDir = join(cwd, "sessions");
		const session = await SessionManager.create(cwd, sessionDir, { id: "starting-git-session" });

		expect(await session.logWriter.recordStartingGitContext(STARTING_GIT_CONTEXT)).toBe(true);
		expect(session.getStartingGitContext()).toEqual(STARTING_GIT_CONTEXT);
		expect(await session.logWriter.recordStartingGitContext(null)).toBe(false);

		await session.logWriter.appendMessage(assistantMessage("persist the session"));
		expect(session.getConversationState().context.messages).toHaveLength(1);

		const sessionRef = session.getSessionRef();
		if (!sessionRef) throw new Error("Expected a persisted session reference");
		// The reopened writer must refuse a later observation, so the first writer closes first.
		await session.closePersistence();
		const reopened = await SessionManager.open(sessionRef);
		expect(reopened.getStartingGitContext()).toEqual(STARTING_GIT_CONTEXT);
		expect(await reopened.logWriter.recordStartingGitContext(null)).toBe(false);

		const infos = await SessionManager.list(cwd, sessionDir);
		expect(infos).toHaveLength(1);
		expect(infos[0]?.startingGitContext).toEqual(STARTING_GIT_CONTEXT);
	});

	it("owns starting Git context across input and getter mutation", async () => {
		const cwd = makeTempDir();
		const sessionDir = join(cwd, "sessions");
		const session = await SessionManager.create(cwd, sessionDir, { id: "starting-git-ownership" });
		const supplied = structuredClone(STARTING_GIT_CONTEXT);

		const recorded = session.logWriter.recordStartingGitContext(supplied);
		supplied.repository = "mutated input";
		expect(await recorded).toBe(true);

		const committed = session.getStartingGitContext();
		if (!committed) throw new Error("Expected committed starting Git context");
		committed.repository = "mutated getter";
		await session.logWriter.appendSessionInfo("trigger another projection write");

		const reopened = await SessionManager.openReadOnly(session.getSessionRef()!);
		expect(reopened.getStartingGitContext()).toEqual(STARTING_GIT_CONTEXT);
	});
});
