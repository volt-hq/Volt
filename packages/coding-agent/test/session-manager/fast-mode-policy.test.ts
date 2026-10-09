import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fold } from "@hansjm10/volt-agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toLogEntry } from "../../src/core/conversation-log/entry-codec.ts";
import { type CommittedSessionEntry, SessionManager } from "../../src/core/session-manager.ts";
import { createSessionManagerTestOwner } from "../session-manager-owner.ts";

const tempDirs: string[] = [];
const managerOwner = createSessionManagerTestOwner();

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-fast-mode-policy-"));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => managerOwner.start());

afterEach(async () => {
	vi.unstubAllEnvs();
	await managerOwner.drain();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SessionManager Fast mode policy", () => {
	it("reduces Fast independently from thinking and model changes", async () => {
		const manager = SessionManager.inMemory();
		await manager.logWriter.appendThinkingLevelChange("high");
		expect(manager.getConversationState().context.fastMode).toBe(false);

		await manager.logWriter.appendFastModeChange(true);
		expect(manager.getConversationState().context).toMatchObject({
			thinkingLevel: "high",
			fastMode: true,
		});

		await manager.logWriter.appendModelChange("openai-codex", "gpt-codex");
		await manager.logWriter.appendThinkingLevelChange("medium");
		expect(manager.getConversationState().context).toMatchObject({
			thinkingLevel: "medium",
			model: { provider: "openai-codex", modelId: "gpt-codex" },
			fastMode: true,
		});
	});

	it("keeps sibling branch states independent", async () => {
		const manager = SessionManager.inMemory();
		await manager.logWriter.appendThinkingLevelChange("high");
		const baseId = manager.getLeafId()!;
		await manager.logWriter.appendFastModeChange(true);
		const enabledId = manager.getLeafId()!;

		await manager.logWriter.branch(baseId);
		await manager.logWriter.appendFastModeChange(false);
		const disabledId = manager.getLeafId()!;

		// Each branch folds to its own Fast mode, whichever is active.
		const branchFastMode = (leafId: string): boolean =>
			fold(
				manager
					.getBranch(leafId)
					.map((entry, index) => toLogEntry({ ...entry, ordinal: index + 1 } as CommittedSessionEntry)),
			).context.fastMode;
		expect(branchFastMode(enabledId)).toBe(true);
		expect(branchFastMode(disabledId)).toBe(false);
	});

	it("durably stores first-turn Fast state without exposing an empty session in normal lists", async () => {
		const dir = createTempDir();
		const manager = await SessionManager.create(dir, dir);
		await manager.logWriter.appendThinkingLevelChange("high");
		await manager.logWriter.appendFastModeChange(true);
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");

		const reopened = await SessionManager.openReadOnly(ref);
		expect(reopened.getConversationState().context.fastMode).toBe(true);
		expect(await SessionManager.list(dir, dir)).toEqual([]);
		expect(await SessionManager.list(dir, dir, undefined, { includeMessageFreeDurable: true })).toMatchObject([
			{ id: manager.getSessionId(), ref },
		]);

		const continued = await SessionManager.continueRecent(dir, dir);
		expect(continued.getSessionId()).not.toBe(manager.getSessionId());
	});

	it("durably stores a message-free branched session with Fast state", async () => {
		const dir = createTempDir();
		const manager = await SessionManager.create(dir, dir);
		await manager.logWriter.appendThinkingLevelChange("high");
		await manager.logWriter.appendFastModeChange(true);
		const fastEntryId = manager.getLeafId()!;

		const branched = await SessionManager.createBranched(manager, fastEntryId);
		const branchedRef = branched.getSessionRef();
		if (!branchedRef) throw new Error("Expected a persisted branched reference");

		const reopened = await SessionManager.openReadOnly(branchedRef);
		expect(reopened.getSessionId()).toBe(branched.getSessionId());
		expect(reopened.getConversationState().context).toMatchObject({
			thinkingLevel: "high",
			fastMode: true,
		});
	});

	it("round-trips both Fast policy states through SQLite", async () => {
		const dir = createTempDir();
		const manager = await SessionManager.create(dir, dir);
		await manager.logWriter.appendFastModeChange(true);
		await manager.logWriter.appendFastModeChange(false);
		const ref = manager.getSessionRef();
		if (!ref) throw new Error("Expected a persisted session reference");

		expect((await SessionManager.openReadOnly(ref)).getConversationState().context.fastMode).toBe(false);
	});

	it("honors options passed as the second listAll argument", async () => {
		const agentDir = createTempDir();
		const cwd = join(agentDir, "workspace");
		vi.stubEnv("VOLT_CODING_AGENT_DIR", agentDir);
		// In the default store, which listAll reads without a directory.
		const manager = await SessionManager.create(cwd);
		await manager.logWriter.appendFastModeChange(true);

		expect(await SessionManager.listAll()).toEqual([]);
		expect(await SessionManager.listAll(undefined, { includeMessageFreeDurable: true })).toMatchObject([
			{ id: manager.getSessionId(), ref: manager.getSessionRef() },
		]);
	});
});
