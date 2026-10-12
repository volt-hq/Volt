import { readPackageManifest } from "../core/extensions/manifest.ts";
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

/**
 * Whether configured package `pkg` is catalog package `catalogId` at any
 * revision: a git source of the repository `source` (the catalog pin) names,
 * whose installed package declares the manifest id `catalogId`. Catalog
 * packages can share a repository, and each pinned commit is its own package,
 * so neither the repository nor the identity finds an older pin.
 */
function isCatalogPackageRevision(pkg: ConfiguredPackage, source: string, catalogId: string): boolean {
	const configured = parseGitUrl(pkg.source);
	const pin = parseGitUrl(source);
	if (configured === null || pin === null || configured.host !== pin.host || configured.path !== pin.path) {
		return false;
	}
	if (pkg.installedPath === undefined) return false;
	try {
		return readPackageManifest(pkg.installedPath)?.manifest.id === catalogId;
	} catch {
		return false;
	}
}

/**
 * The configured packages `source` names, by identity in their scope. With
 * `catalogId`, `source` is that catalog package's pin, and the package
 * installed at another revision of it matches too.
 */
export function getMatchingStorePackageScopes(
	packageManager: StoreTargetPackageManager,
	source: string,
	catalogId?: string,
): StoreScopeTarget[] {
	const inputIdentity = packageManager.getPackageIdentity(source);
	return packageManager
		.listConfiguredPackages()
		.filter((pkg) => {
			const configuredIdentity = packageManager.getPackageIdentity(pkg.source, pkg.scope);
			const scopedInputIdentity = packageManager.getPackageIdentity(source, pkg.scope);
			return (
				configuredIdentity === inputIdentity ||
				configuredIdentity === scopedInputIdentity ||
				(catalogId !== undefined && isCatalogPackageRevision(pkg, source, catalogId))
			);
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
	catalogId?: string,
): StoreTargetSelection {
	const matches = getMatchingStorePackageScopes(packageManager, source, catalogId);
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
	catalogId?: string,
): StoreTargetSelection {
	const matches = getMatchingStorePackageScopes(packageManager, source, catalogId);
	if (local) {
		return { target: matches.find((match) => match.scope === "project") };
	}
	const scopes = new Set(matches.map((match) => match.scope));
	if (scopes.has("user") && scopes.has("project")) {
		return { conflict: "both-scopes" };
	}
	return { target: matches[0] };
}

/**
 * Catalog package `catalogId` installed in `scope` at another revision than
 * its pin `source`. Installing the pin beside it would configure the package
 * twice: the store updates it instead.
 */
export function findStoreCatalogRevision(
	packageManager: StoreTargetPackageManager,
	source: string,
	catalogId: string,
	scope: StoreInstallScope,
): StoreScopeTarget | undefined {
	return getMatchingStorePackageScopes(packageManager, source, catalogId).find(
		(match) => match.scope === scope && !storeUpdateTouches(packageManager, match, source),
	);
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
