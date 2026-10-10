/**
 * The worker's settings watcher: a `settings.json` another process writes
 * reloads the conversation's settings and tells its clients once; the lock
 * the reload itself takes (`settings.json.lock`) is not a change, so one
 * reload never starts the next.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { watchConversationSettings } from "../src/daemon/worker/settings-watcher.ts";
import { createFakeConversation } from "./utilities/fake-conversation-host.ts";

let agentDir: string;
let projectCwd: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "volt-settings-watcher-agent-"));
	projectCwd = mkdtempSync(join(tmpdir(), "volt-settings-watcher-project-"));
	mkdirSync(join(projectCwd, ".volt"));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(projectCwd, { recursive: true, force: true });
});

it("reloads settings another process writes, and not again for the lock the reload takes", async () => {
	const settingsManager = SettingsManager.create(projectCwd, agentDir, { projectTrusted: true });
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const reload = vi.spyOn(settingsManager, "reload");
	const { conversation } = createFakeConversation(
		{ sessionId: "s-1", settingsManager, modelRegistry },
		{ services: { agentDir, projectCwd } },
	);
	const onChanged = vi.fn();
	const stop = watchConversationSettings(conversation, onChanged, () => true);
	try {
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(reload).not.toHaveBeenCalled();

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "light" }));
		await vi.waitFor(() => expect(onChanged).toHaveBeenCalledWith("settings"), { timeout: 5000 });
		expect(settingsManager.getTheme()).toBe("light");

		// The reload locked settings.json and auth.json; those lock files coming and going start nothing.
		await new Promise((resolve) => setTimeout(resolve, 400));
		const settled = reload.mock.calls.length;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(reload).toHaveBeenCalledTimes(settled);
		expect(onChanged).toHaveBeenCalledTimes(settled);
	} finally {
		stop();
	}
});
