import chalk from "chalk";
import { stripTerminalControls } from "../core/ui/ansi-tokens.ts";
import { parseGitUrl } from "../utils/git.ts";
import type { StoreCatalogPackage, StoreResourceType } from "./catalog.ts";
import type { StorePackageInspection, StoreVoltField } from "./inspector.ts";
import type { StoreInstallPlan } from "./install-plan.ts";
import type { StoreResolvedSource } from "./resolver.ts";

const RESOURCE_TYPES: StoreResourceType[] = ["extensions", "skills", "prompts", "themes"];

/**
 * Text from a catalog or an inspected package, safe to print on one line: a
 * package is shown before the user agrees to install it, so it must not write
 * terminal sequences or forge lines of the plan.
 */
function printable(text: string): string {
	return stripTerminalControls(text).replaceAll("\n", " ");
}

function formatList(values: readonly string[] | undefined): string {
	return values && values.length > 0 ? values.map(printable).join(", ") : "none";
}

export function formatStoreSourceSummary(source: string): string {
	const gitSource = parseGitUrl(source);
	if (gitSource) {
		const ref = gitSource.ref
			? ` @ ${/^[0-9a-f]{40}$/i.test(gitSource.ref) ? gitSource.ref.slice(0, 12) : gitSource.ref}`
			: "";
		return `git ${gitSource.host}/${gitSource.path}${ref}`;
	}

	if (source.startsWith("npm:")) {
		const spec = source.slice("npm:".length).trim();
		return spec ? `npm ${spec}` : source;
	}

	return source;
}

export function formatStoreInstallPlanTarget(plan: StoreInstallPlan): string {
	const catalogPackage = plan.resolved.catalogPackage;
	if (catalogPackage) {
		return `${catalogPackage.id} - ${printable(catalogPackage.name)}`;
	}
	return formatStoreSourceSummary(plan.resolved.source);
}

export function formatStoreProgressMessage(source: string, message: string): string {
	return source ? message.split(source).join(formatStoreSourceSummary(source)) : message;
}

function renderRecord(title: string, values: Record<string, string>): string[] {
	const entries = Object.entries(values);
	if (entries.length === 0) {
		return [`${title}: none`];
	}
	return [`${title}:`, ...entries.map(([name, version]) => `  - ${printable(name)}: ${printable(version)}`)];
}

function renderVoltField(volt: StoreVoltField | undefined): string[] {
	if (!volt) {
		return ["Volt manifest: none"];
	}
	const lines = ["Volt manifest:"];
	const manifest = volt.manifest;
	if (manifest) {
		lines.push(`  id: ${manifest.id}`);
		lines.push(`  display name: ${printable(manifest.displayName)}`);
		if (manifest.description) lines.push(`  description: ${printable(manifest.description)}`);
		lines.push(`  entry: ${printable(manifest.entry ?? "none")}`);
		lines.push(`  permissions: ${formatList(manifest.permissions)}`);
		if (manifest.settings) lines.push(`  settings: ${formatList(Object.keys(manifest.settings.properties))}`);
	} else {
		lines.push("  extension: none");
	}
	for (const resourceType of ["skills", "prompts", "themes"] as const) {
		const entries = volt[resourceType];
		if (entries !== undefined) {
			lines.push(`  ${resourceType}: ${formatList(entries)}`);
		}
	}
	return lines;
}

/** The catalog's review record and declared permissions for a catalog package. */
function renderCatalogReview(pkg: StoreCatalogPackage): string[] {
	return [
		`Permissions: ${formatList(pkg.permissions)}`,
		`Reviewed: ${pkg.review.commit.slice(0, 12)} by ${printable(pkg.review.reviewer)} on ${pkg.review.date}`,
		`Review notes: ${printable(pkg.review.notes)}`,
	];
}

function renderPackageMetadata(inspection: StorePackageInspection): string[] {
	return [
		`Name: ${printable(inspection.packageName ?? "unknown")}`,
		`Version: ${printable(inspection.packageVersion ?? "unknown")}`,
		`Description: ${printable(inspection.packageDescription ?? "unknown")}`,
		`License: ${printable(inspection.packageLicense ?? "unknown")}`,
		`Repository: ${printable(inspection.packageRepository ?? "unknown")}`,
	];
}

function renderDiscoveredResources(inspection: StorePackageInspection): string[] {
	const lines = ["Discovered resources:"];
	for (const resourceType of RESOURCE_TYPES) {
		lines.push(`  ${resourceType}: ${formatList(inspection.discoveredResources[resourceType])}`);
	}
	return lines;
}

function renderWarnings(warnings: readonly string[]): string[] {
	if (warnings.length === 0) {
		return [];
	}
	return ["Warnings:", ...warnings.map((warning) => `  - ${printable(warning)}`)];
}

export function renderCatalogSearch(packages: readonly StoreCatalogPackage[], query?: string): string {
	if (packages.length === 0) {
		return query?.trim() ? `No store packages found for "${query.trim()}".` : "No store packages found.";
	}

	const lines = [chalk.bold("Store packages:")];
	for (const pkg of packages) {
		const categories = pkg.categories.length > 0 ? ` [${pkg.categories.join(", ")}]` : "";
		lines.push(`${pkg.id} - ${printable(pkg.name)} ${pkg.version}${categories}`);
		lines.push(chalk.dim(`  ${printable(pkg.description)}`));
		lines.push(chalk.dim(`  Permissions: ${formatList(pkg.permissions)}`));
		lines.push(chalk.dim(`  Source: ${formatStoreSourceSummary(pkg.source)}`));
	}
	return lines.join("\n");
}

export function renderStoreShow(resolved: StoreResolvedSource, inspection: StorePackageInspection): string {
	const lines: string[] = [];
	const catalogPackage = resolved.catalogPackage;
	if (catalogPackage) {
		lines.push(chalk.bold(printable(catalogPackage.name)));
		lines.push(`ID: ${catalogPackage.id}`);
		lines.push(`Description: ${printable(catalogPackage.description)}`);
		lines.push(`Version: ${catalogPackage.version}`);
		lines.push(`Source: ${formatStoreSourceSummary(catalogPackage.source)}`);
		lines.push(...renderCatalogReview(catalogPackage));
		lines.push(`Repo: ${printable(catalogPackage.repo)}`);
		lines.push(`Author: ${printable(catalogPackage.author)}`);
		lines.push(`License: ${printable(catalogPackage.license)}`);
		lines.push(`Catalog resources: ${formatList(catalogPackage.resources)}`);
		if (catalogPackage.compatibility?.volt) {
			lines.push(`Volt compatibility: ${printable(catalogPackage.compatibility.volt)}`);
		}
		lines.push("");
	} else {
		lines.push(chalk.bold(printable(resolved.input)));
		lines.push(`Source: ${formatStoreSourceSummary(resolved.source)}`);
		lines.push("");
	}

	lines.push(chalk.bold("Package metadata"));
	lines.push(...renderPackageMetadata(inspection));
	lines.push(...renderVoltField(inspection.volt));
	lines.push(...renderDiscoveredResources(inspection));
	lines.push(...renderRecord("Dependencies", inspection.dependencies));
	lines.push(...renderRecord("Peer dependencies", inspection.peerDependencies));
	lines.push(...renderRecord("Optional dependencies", inspection.optionalDependencies));
	lines.push(...renderRecord("Scripts", inspection.scripts));
	lines.push(...renderWarnings([...resolved.warnings, ...inspection.warnings]));
	return lines.join("\n");
}

export function renderStoreInstallPlan(plan: StoreInstallPlan): string {
	const target = formatStoreInstallPlanTarget(plan);
	const source = formatStoreSourceSummary(plan.source);
	const catalogPackage = plan.resolved.catalogPackage;
	const lines = [
		chalk.bold("Store install plan"),
		...(target !== source ? [`Package: ${target}`] : []),
		`Source: ${source}`,
		...(catalogPackage ? renderCatalogReview(catalogPackage) : []),
		`Scope: ${plan.scope}`,
		`Tracking: ${plan.tracking ? "yes" : "no"}`,
		`Script policy: ${plan.scriptPolicy}`,
		`Compatibility: ${plan.compatibility}`,
		"",
		chalk.bold("Package metadata"),
		...renderPackageMetadata(plan.inspection),
		...renderVoltField(plan.inspection.volt),
		...renderDiscoveredResources(plan.inspection),
		...renderRecord("Dependencies", plan.inspection.dependencies),
		...renderRecord("Peer dependencies", plan.inspection.peerDependencies),
		...renderRecord("Optional dependencies", plan.inspection.optionalDependencies),
		...renderRecord("Scripts", plan.inspection.scripts),
		...renderWarnings(plan.warnings),
	];
	return lines.join("\n");
}
