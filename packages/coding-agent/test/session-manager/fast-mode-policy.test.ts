import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionContext, SessionManager } from "../../src/core/session-manager.ts";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-fast-mode-policy-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("SessionManager Fast mode policy", () => {
	it("reduces explicit thinking, Fast, and model changes into one branch policy", () => {
		const manager = SessionManager.inMemory();
		manager.appendThinkingLevelChange("high");
		expect(manager.buildSessionContext().fastMode).toEqual({ enabled: false, baseThinkingLevel: "high" });

		manager.appendFastModeChange({ enabled: true, baseThinkingLevel: "high" });
		expect(manager.buildSessionContext()).toMatchObject({
			thinkingLevel: "high",
			fastMode: { enabled: true, baseThinkingLevel: "high" },
		});

		manager.appendModelChange("openai-codex", "gpt-codex");
		expect(manager.buildSessionContext().fastMode).toEqual({ enabled: false, baseThinkingLevel: "high" });

		manager.appendFastModeChange({ enabled: true, baseThinkingLevel: "high" });
		manager.appendThinkingLevelChange("medium");
		expect(manager.buildSessionContext().fastMode).toEqual({ enabled: false, baseThinkingLevel: "medium" });
	});

	it("keeps sibling branch policies independent", () => {
		const manager = SessionManager.inMemory();
		const baseId = manager.appendThinkingLevelChange("high");
		const enabledId = manager.appendFastModeChange({ enabled: true, baseThinkingLevel: "high" });

		manager.branch(baseId);
		const disabledId = manager.appendFastModeChange({ enabled: false, baseThinkingLevel: "medium" });

		expect(buildSessionContext(manager.getEntries(), enabledId).fastMode).toEqual({
			enabled: true,
			baseThinkingLevel: "high",
		});
		expect(buildSessionContext(manager.getEntries(), disabledId).fastMode).toEqual({
			enabled: false,
			baseThinkingLevel: "medium",
		});
	});

	it("durably writes a first-turn Fast policy without exposing an empty session in normal lists", async () => {
		const dir = createTempDir();
		const manager = SessionManager.create(dir, dir);
		manager.appendThinkingLevelChange("high");
		manager.appendFastModeChange({ enabled: true, baseThinkingLevel: "high" });
		const sessionFile = manager.getSessionFile();

		expect(sessionFile).toBeDefined();
		expect(existsSync(sessionFile!)).toBe(true);
		const reopened = SessionManager.open(sessionFile!, dir);
		expect(reopened.buildSessionContext().fastMode).toEqual({ enabled: true, baseThinkingLevel: "high" });
		expect(await SessionManager.list(dir, dir)).toEqual([]);
		expect(
			await SessionManager.list(dir, dir, undefined, {
				includeMessageFreeDurable: true,
			}),
		).toMatchObject([{ id: manager.getSessionId(), path: sessionFile }]);
		expect(SessionManager.continueRecent(dir, dir).getSessionId()).toBe(manager.getSessionId());
	});
});
