import { describe, expect, it } from "vitest";
import type { ConfiguredPackage } from "../src/core/package-manager.ts";
import {
	chooseStoreRemoveTarget,
	chooseStoreUpdateTarget,
	getMatchingStorePackageScopes,
	type StoreTargetPackageManager,
} from "../src/store/targets.ts";

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
});
