import { readPackageManifest } from "../core/extensions/manifest.ts";
import type { ConfiguredPackage } from "../core/package-manager.ts";
import { isPinnedRefOf, parseGitUrl } from "../utils/git.ts";
import { isLocalPath, resolvePath } from "../utils/paths.ts";
import type { StoreInstallScope } from "./install-plan.ts";

export interface StoreScopeTarget {
	source: string;
	scope: StoreInstallScope;
	actionSource?: string;
}

/** `both-scopes`: the source names a package in each scope. `several-refs`: it names a repository configured at several pinned refs in the scope. */
export type StoreTargetConflict = "both-scopes" | "several-refs";

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
 * Whether configured package `pkg` is a pinned ref of the repository that
 * `source`, a git source without a ref, names, in a scope of `packages` that
 * does not configure `source` itself. Each pinned ref is its own package, so
 * the repository names its pinned ref there, as the package manager resolves it.
 */
function isRepositoryRef(
	packageManager: StoreTargetPackageManager,
	packages: ConfiguredPackage[],
	pkg: Pick<ConfiguredPackage, "source" | "scope">,
	source: string,
): boolean {
	const repository = parseGitUrl(source);
	const configured = parseGitUrl(pkg.source);
	if (repository === null || configured === null || !isPinnedRefOf(configured, repository)) return false;
	const identity = packageManager.getPackageIdentity(source, pkg.scope);
	return !packages.some(
		(other) => other.scope === pkg.scope && packageManager.getPackageIdentity(other.source, other.scope) === identity,
	);
}

/** Whether `matches`, from one scope, are several pinned refs of the repository `source` names without a ref. */
function hasSeveralRefs(
	packageManager: StoreTargetPackageManager,
	source: string,
	matches: StoreScopeTarget[],
): boolean {
	const repository = parseGitUrl(source);
	if (repository === null || repository.ref) return false;
	return new Set(matches.map((match) => packageManager.getPackageIdentity(match.source, match.scope))).size > 1;
}

/**
 * The configured packages `source` names, by identity in their scope, or, for
 * a git source without a ref, the repository's pinned refs in a scope that
 * does not configure it. With `catalogId`, `source` is that catalog package's
 * pin, and the package installed at another revision of it matches too.
 */
export function getMatchingStorePackageScopes(
	packageManager: StoreTargetPackageManager,
	source: string,
	catalogId?: string,
): StoreScopeTarget[] {
	const inputIdentity = packageManager.getPackageIdentity(source);
	const packages = packageManager.listConfiguredPackages();
	return packages
		.filter((pkg) => {
			const configuredIdentity = packageManager.getPackageIdentity(pkg.source, pkg.scope);
			const scopedInputIdentity = packageManager.getPackageIdentity(source, pkg.scope);
			return (
				configuredIdentity === inputIdentity ||
				configuredIdentity === scopedInputIdentity ||
				isRepositoryRef(packageManager, packages, pkg, source) ||
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
		const projectMatches = matches.filter((match) => match.scope === "project");
		if (hasSeveralRefs(packageManager, source, projectMatches)) return { conflict: "several-refs" };
		return { target: projectMatches[0] };
	}
	const scopes = new Set(matches.map((match) => match.scope));
	if (scopes.has("user") && scopes.has("project")) {
		return { conflict: "both-scopes" };
	}
	if (hasSeveralRefs(packageManager, source, matches)) return { conflict: "several-refs" };
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
		const projectMatches = matches.filter((match) => match.scope === "project");
		if (hasSeveralRefs(packageManager, source, projectMatches)) return { conflict: "several-refs" };
		return { target: projectMatches[0] };
	}
	const scopes = new Set(matches.map((match) => match.scope));
	if (scopes.has("user") && scopes.has("project")) {
		return { conflict: "both-scopes" };
	}
	if (hasSeveralRefs(packageManager, source, matches)) return { conflict: "several-refs" };
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

/**
 * Whether an update of `source` touched configured package `pkg`: the same
 * package, by its identity in `pkg`'s scope, or the pinned ref a git source
 * without a ref updates there.
 */
export function storeUpdateTouches(
	packageManager: StoreTargetPackageManager,
	pkg: Pick<ConfiguredPackage, "source" | "scope">,
	source: string,
): boolean {
	return (
		packageManager.getPackageIdentity(pkg.source, pkg.scope) ===
			packageManager.getPackageIdentity(source, pkg.scope) ||
		isRepositoryRef(packageManager, packageManager.listConfiguredPackages(), pkg, source)
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
