import type { ConfiguredPackage } from "../core/package-manager.ts";
import { parseGitUrl } from "../utils/git.ts";
import { isLocalPath, resolvePath } from "../utils/paths.ts";
import type { StoreInstallScope } from "./install-plan.ts";

export interface StoreScopeTarget {
	source: string;
	scope: StoreInstallScope;
	actionSource?: string;
}

export type StoreTargetConflict = "both-scopes";

export interface StoreTargetSelection {
	target?: StoreScopeTarget;
	conflict?: StoreTargetConflict;
}

export interface StoreTargetPackageManager {
	getPackageIdentity(source: string, scope?: "user" | "project"): string;
	listConfiguredPackages(): ConfiguredPackage[];
}

export function getMatchingStorePackageScopes(
	packageManager: StoreTargetPackageManager,
	source: string,
): StoreScopeTarget[] {
	const inputIdentity = packageManager.getPackageIdentity(source);
	return packageManager
		.listConfiguredPackages()
		.filter((pkg) => {
			const configuredIdentity = packageManager.getPackageIdentity(pkg.source, pkg.scope);
			const scopedInputIdentity = packageManager.getPackageIdentity(source, pkg.scope);
			return configuredIdentity === inputIdentity || configuredIdentity === scopedInputIdentity;
		})
		.map((pkg) => ({
			source: pkg.source,
			scope: pkg.scope,
			...(pkg.actionSource !== pkg.source ? { actionSource: pkg.actionSource } : {}),
		}));
}

export function chooseStoreRemoveTarget(
	packageManager: StoreTargetPackageManager,
	source: string,
	local: boolean,
): StoreTargetSelection {
	const matches = getMatchingStorePackageScopes(packageManager, source);
	if (local) {
		return { target: matches.find((match) => match.scope === "project") };
	}
	const scopes = new Set(matches.map((match) => match.scope));
	if (scopes.has("user") && scopes.has("project")) {
		return { conflict: "both-scopes" };
	}
	return { target: matches[0] };
}

export function chooseStoreUpdateTarget(
	packageManager: StoreTargetPackageManager,
	source: string,
	local = false,
): StoreTargetSelection {
	const matches = getMatchingStorePackageScopes(packageManager, source);
	if (local) {
		return { target: matches.find((match) => match.scope === "project") };
	}
	const scopes = new Set(matches.map((match) => match.scope));
	if (scopes.has("user") && scopes.has("project")) {
		return { conflict: "both-scopes" };
	}
	return { target: matches[0] };
}

/** Whether the installed target is already the source an update resolves to. A catalog update otherwise installs the new pin. */
export function storeTargetMatchesUpdateSource(target: StoreScopeTarget, source: string): boolean {
	return target.source === source || target.actionSource === source;
}

/** Whether an update of `source` touched configured package `pkg`: the same package, by its identity in `pkg`'s scope. */
export function storeUpdateTouches(
	packageManager: StoreTargetPackageManager,
	pkg: Pick<ConfiguredPackage, "source" | "scope">,
	source: string,
): boolean {
	return (
		packageManager.getPackageIdentity(pkg.source, pkg.scope) === packageManager.getPackageIdentity(source, pkg.scope)
	);
}

/**
 * The source a package just installed from `source` is found by for its
 * permission review: a local path as it resolves from `cwd`, where it was
 * installed from, not from the scope's settings directory.
 */
export function storeReviewSource(source: string, cwd: string): string {
	return isLocalPath(source) ? resolvePath(source, cwd, { trim: true }) : source;
}

/** Whether `source` pins a git commit: reinstalling it installs the same revision, with the same permissions. */
export function storeSourcePinsCommit(source: string): boolean {
	return /^[0-9a-f]{40}$/i.test(parseGitUrl(source)?.ref ?? "");
}
