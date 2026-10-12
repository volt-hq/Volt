import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultPackageManager } from "../../../src/core/package-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";

const REPO_URL = "https://github.com/volt-hq/Volt";

function git(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	}
	return result.stdout.trim();
}

/** Commit, on its own orphan branch of `repo`, a package declaring extension `id`; returns the commit. */
function commitPackage(repo: string, id: string): string {
	git(["checkout", "--orphan", `store/${id}`], repo);
	git(["rm", "-rf", "--ignore-unmatch", "."], repo);
	writeFileSync(
		join(repo, "package.json"),
		JSON.stringify({ name: `volt-${id}`, version: "0.1.0", volt: { id, displayName: id, entry: "index.js" } }),
	);
	writeFileSync(join(repo, "index.js"), "export default function () {}\n");
	git(["add", "."], repo);
	git(["commit", "-m", id], repo);
	return git(["rev-parse", "HEAD"], repo);
}

function manifestId(root: string | undefined): string | undefined {
	if (root === undefined) return undefined;
	return (JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as { volt: { id: string } }).volt.id;
}

describe("issue #659 git packages from one repository at different pinned refs", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;
	let rtk: string;
	let reviewLoop: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "volt-659-"));
		agentDir = join(tempDir, "agent");
		const repo = join(tempDir, "remote");
		mkdirSync(agentDir);
		mkdirSync(repo);
		git(["init", "--initial-branch=main"], repo);
		git(["config", "--local", "user.email", "test@test.com"], repo);
		git(["config", "--local", "user.name", "Test"], repo);
		rtk = `git:${REPO_URL}@${commitPackage(repo, "rtk")}`;
		reviewLoop = `git:${REPO_URL}@${commitPackage(repo, "review-loop")}`;

		// Clones of the store repository read the local one.
		vi.stubEnv("GIT_CONFIG_COUNT", "2");
		vi.stubEnv("GIT_CONFIG_KEY_0", `url.${repo}.insteadOf`);
		vi.stubEnv("GIT_CONFIG_VALUE_0", REPO_URL);
		vi.stubEnv("GIT_CONFIG_KEY_1", "advice.detachedHead");
		vi.stubEnv("GIT_CONFIG_VALUE_1", "false");

		// A package's dependency install runs a command that does nothing.
		settingsManager = SettingsManager.inMemory({ npmCommand: [process.execPath, "-e", ""] });
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("installs each pin as its own package, in its own checkout", async () => {
		await packageManager.installAndPersist(rtk, { scripts: "never" });
		await packageManager.installAndPersist(reviewLoop, { scripts: "never" });

		expect(settingsManager.getGlobalSettings().packages).toEqual([
			{ source: rtk, scripts: "never" },
			{ source: reviewLoop, scripts: "never" },
		]);
		expect(packageManager.getPackageIdentity(rtk)).not.toBe(packageManager.getPackageIdentity(reviewLoop));
		const rtkRoot = packageManager.getInstalledPath(rtk, "user");
		const reviewLoopRoot = packageManager.getInstalledPath(reviewLoop, "user");
		expect(rtkRoot).not.toBe(reviewLoopRoot);
		expect(manifestId(rtkRoot)).toBe("rtk");
		expect(manifestId(reviewLoopRoot)).toBe("review-loop");

		const resolved = await packageManager.resolve();
		expect(resolved.extensions.map((extension) => extension.path).sort()).toEqual([rtkRoot, reviewLoopRoot].sort());

		await packageManager.removeAndPersist(rtk);
		expect(settingsManager.getGlobalSettings().packages).toEqual([{ source: reviewLoop, scripts: "never" }]);
		expect(existsSync(rtkRoot!)).toBe(false);
		expect(manifestId(reviewLoopRoot)).toBe("review-loop");
	});

	it("updates and removes the one pinned ref of a repository by the repository's source", async () => {
		const repository = "git:github.com/volt-hq/Volt";
		await packageManager.installAndPersist(rtk, { scripts: "never" });
		const rtkRoot = packageManager.getInstalledPath(rtk, "user");

		await expect(packageManager.update(repository)).resolves.toBeUndefined();
		expect(packageManager.resolveRemoveSource(repository)).toBe(rtk);
		await expect(packageManager.removeAndPersist(packageManager.resolveRemoveSource(repository))).resolves.toBe(true);

		expect(settingsManager.getGlobalSettings().packages).toEqual([]);
		expect(existsSync(rtkRoot!)).toBe(false);
	});

	it("refuses to pick one of several pinned refs by the repository's source", async () => {
		const repository = "git:github.com/volt-hq/Volt";
		await packageManager.installAndPersist(rtk, { scripts: "never" });
		await packageManager.installAndPersist(reviewLoop, { scripts: "never" });

		await expect(packageManager.update(repository)).rejects.toThrow("is configured at several refs");
		expect(() => packageManager.resolveRemoveSource(repository)).toThrow("is configured at several refs");

		expect(settingsManager.getGlobalSettings().packages).toEqual([
			{ source: rtk, scripts: "never" },
			{ source: reviewLoop, scripts: "never" },
		]);
		expect(manifestId(packageManager.getInstalledPath(rtk, "user"))).toBe("rtk");
		expect(manifestId(packageManager.getInstalledPath(reviewLoop, "user"))).toBe("review-loop");
	});

	it("removes a repository source the settings no longer configure as given, not as its pinned ref", async () => {
		await packageManager.installAndPersist(rtk, { scripts: "never" });

		await expect(packageManager.removeAndPersist("git:github.com/volt-hq/Volt")).resolves.toBe(false);

		expect(settingsManager.getGlobalSettings().packages).toEqual([{ source: rtk, scripts: "never" }]);
		expect(manifestId(packageManager.getInstalledPath(rtk, "user"))).toBe("rtk");
	});
});
