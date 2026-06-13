import type { ConfiguredPackage } from "../core/package-manager.ts";
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
