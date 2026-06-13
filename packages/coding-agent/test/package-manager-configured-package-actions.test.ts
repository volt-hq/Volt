import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("configured package actions", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pm-configured-actions-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("exposes an actionable source for settings-relative project-local packages", async () => {
		const packageDir = join(tempDir, "pkg");
		mkdirSync(packageDir, { recursive: true });

		await packageManager.installAndPersist(packageDir, { local: true });

		const [configured] = packageManager.listConfiguredPackages();
		expect(configured).toBeDefined();
		expect(configured.source).toBe(relative(join(tempDir, CONFIG_DIR_NAME), packageDir));
		expect(configured.actionSource).toBe(packageDir);

		await expect(packageManager.update(configured.actionSource, { scripts: "never" })).resolves.toBeUndefined();
		await expect(packageManager.removeAndPersist(configured.actionSource, { local: true })).resolves.toBe(true);
		expect(settingsManager.getProjectSettings().packages).toEqual([]);
	});
});
