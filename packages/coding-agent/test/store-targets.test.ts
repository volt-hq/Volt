import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredPackage } from "../src/core/package-manager.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	chooseStoreRemoveTarget,
	chooseStoreUpdateTarget,
	findStoreCatalogRevision,
	getMatchingStorePackageScopes,
	type StoreTargetPackageManager,
	storeUpdateTouches,
} from "../src/store/targets.ts";
import { NEXT_TEST_STORE_COMMIT, TEST_STORE_COMMIT, testStoreSource } from "./store-catalog-fixtures.ts";

function createManager(packages: ConfiguredPackage[]): StoreTargetPackageManager {
	return {
		getPackageIdentity(source) {
			return source;
		},
		listConfiguredPackages() {
			return packages;
		},
	};
}

describe("store target selection", () => {
	it("finds matching configured package scopes", () => {
		const manager = createManager([
			{ source: "npm:one@1.0.0", actionSource: "npm:one@1.0.0", scope: "user", filtered: false },
			{ source: "npm:two@1.0.0", actionSource: "npm:two@1.0.0", scope: "project", filtered: false },
		]);

		expect(getMatchingStorePackageScopes(manager, "npm:two@1.0.0")).toEqual([
			{ source: "npm:two@1.0.0", scope: "project" },
		]);
	});

	it("selects project scope for local remove and update", () => {
		const manager = createManager([
			{ source: "npm:pkg@1.0.0", actionSource: "npm:pkg@1.0.0", scope: "user", filtered: false },
			{ source: "npm:pkg@1.0.0", actionSource: "npm:pkg@1.0.0", scope: "project", filtered: false },
		]);

		const projectTarget = { target: { source: "npm:pkg@1.0.0", scope: "project" } };
		expect(chooseStoreRemoveTarget(manager, "npm:pkg@1.0.0", true)).toEqual(projectTarget);
		expect(chooseStoreUpdateTarget(manager, "npm:pkg@1.0.0", true)).toEqual(projectTarget);
	});

	it("matches settings-relative local project sources", () => {
		const packagePath = "/repo/project/pkg";
		const manager: StoreTargetPackageManager = {
			getPackageIdentity(source, scope) {
				if (source === packagePath) {
					return `local:${packagePath}`;
				}
				if (source === "../pkg" && scope === "project") {
					return `local:${packagePath}`;
				}
				if (source === "../pkg") {
					return "local:/repo/pkg";
				}
				return `local:${scope ?? "cwd"}:${source}`;
			},
			listConfiguredPackages() {
				return [{ source: "../pkg", actionSource: packagePath, scope: "project", filtered: false }];
			},
		};
		const projectTarget = { target: { source: "../pkg", actionSource: packagePath, scope: "project" } };

		expect(chooseStoreRemoveTarget(manager, "../pkg", true)).toEqual(projectTarget);
		expect(chooseStoreUpdateTarget(manager, "../pkg", true)).toEqual(projectTarget);
	});

	it("reports ambiguous user/project targets", () => {
		const manager = createManager([
			{ source: "npm:pkg@1.0.0", actionSource: "npm:pkg@1.0.0", scope: "user", filtered: false },
			{ source: "npm:pkg@1.0.0", actionSource: "npm:pkg@1.0.0", scope: "project", filtered: false },
		]);

		expect(chooseStoreRemoveTarget(manager, "npm:pkg@1.0.0", false)).toEqual({ conflict: "both-scopes" });
		expect(chooseStoreUpdateTarget(manager, "npm:pkg@1.0.0", false)).toEqual({ conflict: "both-scopes" });
	});

	describe("catalog packages sharing one repository", () => {
		const tempDirs: string[] = [];

		afterEach(() => {
			for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
		});

		/** A package manager whose user settings configure `sources`, each checked out declaring the manifest id it maps to. */
		function createStoreManager(sources: Record<string, string>): DefaultPackageManager {
			const agentDir = mkdtempSync(join(tmpdir(), "volt-store-targets-"));
			tempDirs.push(agentDir);
			const settingsManager = SettingsManager.inMemory({ packages: Object.keys(sources) });
			const packageManager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager });
			for (const [source, id] of Object.entries(sources)) {
				const root = checkoutPath(agentDir, source);
				mkdirSync(root, { recursive: true });
				writeFileSync(
					join(root, "package.json"),
					JSON.stringify({ volt: { id, displayName: id, entry: "index.js" } }),
				);
				writeFileSync(join(root, "index.js"), "export default function () {}\n");
			}
			return packageManager;
		}

		/** Where `source`, the store repository unpinned or at a commit, is checked out. */
		function checkoutPath(agentDir: string, source: string): string {
			const commit = /@([0-9a-f]{40})$/.exec(source)?.[1];
			return join(agentDir, "git", "github.com", "volt-hq", commit === undefined ? "Volt" : `Volt@${commit}`);
		}

		const reviewLoopCommit = "fedcba9876543210fedcba9876543210fedcba98";

		it("finds a catalog package at an older pin by its manifest id, not the other packages of its repository", () => {
			const manager = createStoreManager({
				[testStoreSource()]: "rtk",
				[testStoreSource(reviewLoopCommit)]: "review-loop",
			});
			const pin = testStoreSource(NEXT_TEST_STORE_COMMIT);

			expect(getMatchingStorePackageScopes(manager, pin)).toEqual([]);
			expect(chooseStoreUpdateTarget(manager, pin, false, "rtk")).toEqual({
				target: { source: testStoreSource(), scope: "user" },
			});
			expect(chooseStoreRemoveTarget(manager, pin, false, "review-loop")).toEqual({
				target: { source: testStoreSource(reviewLoopCommit), scope: "user" },
			});
			expect(findStoreCatalogRevision(manager, pin, "rtk", "user")).toEqual({
				source: testStoreSource(),
				scope: "user",
			});
			expect(findStoreCatalogRevision(manager, pin, "rtk", "project")).toBeUndefined();
		});

		it("finds a tracking install of the catalog package's repository", () => {
			const manager = createStoreManager({ "git:https://github.com/volt-hq/Volt": "rtk" });

			expect(chooseStoreUpdateTarget(manager, testStoreSource(), false, "rtk")).toEqual({
				target: { source: "git:https://github.com/volt-hq/Volt", scope: "user" },
			});
			expect(chooseStoreUpdateTarget(manager, testStoreSource(), false, "review-loop")).toEqual({});
		});

		it("does not report the catalog pin itself as another revision", () => {
			const manager = createStoreManager({ [`git:git@github.com:volt-hq/Volt@${TEST_STORE_COMMIT}`]: "rtk" });

			expect(findStoreCatalogRevision(manager, testStoreSource(), "rtk", "user")).toBeUndefined();
			expect(chooseStoreUpdateTarget(manager, testStoreSource(), false, "rtk")).toEqual({
				target: { source: `git:git@github.com:volt-hq/Volt@${TEST_STORE_COMMIT}`, scope: "user" },
			});
		});
	});

	describe("git sources without a ref", () => {
		const repository = "git:github.com/foo/bar";
		const pinned = `git:https://github.com/foo/bar@${TEST_STORE_COMMIT}`;
		let tempDir: string | undefined;

		afterEach(() => {
			if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
			tempDir = undefined;
		});

		function createRepositoryManager(user: string[], project: string[] = []): DefaultPackageManager {
			tempDir = mkdtempSync(join(tmpdir(), "volt-store-targets-"));
			const settingsManager = SettingsManager.inMemory({ packages: user });
			settingsManager.setProjectPackages(project);
			return new DefaultPackageManager({ cwd: tempDir, agentDir: tempDir, settingsManager });
		}

		it("names the repository's pinned ref, as `store install` configures it", () => {
			const manager = createRepositoryManager([pinned]);

			expect(chooseStoreRemoveTarget(manager, repository, false)).toEqual({
				target: { source: pinned, scope: "user" },
			});
			expect(storeUpdateTouches(manager, { source: pinned, scope: "user" }, repository)).toBe(true);
		});

		it("refuses to pick one of several pinned refs in a scope", () => {
			const refs = [`${repository}@v1`, `${repository}@v2`];

			expect(chooseStoreRemoveTarget(createRepositoryManager(refs), repository, false)).toEqual({
				conflict: "several-refs",
			});
			expect(chooseStoreRemoveTarget(createRepositoryManager([], refs), repository, true)).toEqual({
				conflict: "several-refs",
			});
			expect(chooseStoreRemoveTarget(createRepositoryManager([], refs), `${repository}@v2`, true)).toEqual({
				target: { source: `${repository}@v2`, scope: "project" },
			});
		});

		it("names the unpinned entry, not the pinned refs, in a scope that configures it", () => {
			const manager = createRepositoryManager([repository, `${repository}@v1`]);

			expect(chooseStoreRemoveTarget(manager, repository, false)).toEqual({
				target: { source: repository, scope: "user" },
			});
			expect(storeUpdateTouches(manager, { source: `${repository}@v1`, scope: "user" }, repository)).toBe(false);
		});
	});
});
