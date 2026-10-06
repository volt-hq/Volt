import { createInterface } from "node:readline";
import type { ExtensionPermission } from "@hansjm10/volt-protocol";
import { sanitizeText } from "@hansjm10/volt-tui";
import chalk from "chalk";
import { APP_NAME, getAgentDir } from "../config.ts";
import { type PackagePermissions, readPackagePermissions } from "../core/extensions/permissions.ts";
import type { ExtensionDefinition } from "../core/extensions/types.ts";
import type { PackageInstallScriptPolicy } from "../core/package-manager.ts";
import { DefaultPackageManager } from "../core/package-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import {
	createCommandSettingsManager,
	getCommandAppMode,
	parseProjectTrustOverride,
	reportProjectTrustWarnings,
	reportSettingsErrors,
	reviewInstalledPermissions,
} from "../package-manager-cli.ts";
import {
	findCatalogPackage,
	loadDefaultStoreCatalog,
	STORE_CATALOG_SCHEMA_VERSION,
	type StoreCatalog,
	searchCatalogPackages,
} from "./catalog.ts";
import { inspectStorePackage, type StorePackageInspection } from "./inspector.ts";
import {
	buildStoreInstallPlan,
	type StoreInstallPlan,
	type StoreInstallScope,
	type StoreInstallScriptPolicy,
} from "./install-plan.ts";
import {
	formatStoreInstallPlanTarget,
	formatStoreProgressMessage,
	formatStoreSourceSummary,
	renderCatalogSearch,
	renderStoreInstallPlan,
	renderStoreShow,
} from "./render.ts";
import { resolveStoreSource } from "./resolver.ts";
import {
	chooseStoreRemoveTarget,
	chooseStoreUpdateTarget,
	type StoreScopeTarget,
	storeReviewSource,
	storeSourcePinsCommit,
	storeTargetMatchesUpdateSource,
	storeUpdateTouches,
} from "./targets.ts";

type StoreCommand = "search" | "show" | "install" | "remove" | "update";

interface StoreCommandOptions {
	command: StoreCommand;
	input?: string;
	query?: string;
	local: boolean;
	yes: boolean;
	track: boolean;
	scriptPolicy: StoreInstallScriptPolicy;
	ref?: string;
	projectTrustOverride?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

export interface StoreCommandRuntimeOptions {
	extensionFactories?: ExtensionDefinition[];
	profile?: string;
}

function getStoreCommandUsage(command?: StoreCommand): string {
	switch (command) {
		case "search":
			return `${APP_NAME} store search [query] [--approve|--no-approve]`;
		case "show":
			return `${APP_NAME} store show <id|source> [--approve|--no-approve]`;
		case "install":
			return `${APP_NAME} store install <id|source> [-l] [--ref <ref>] [--track] [--scripts ask|never|allow] [--yes] [--approve|--no-approve]`;
		case "remove":
			return `${APP_NAME} store remove <id|source> [-l] [--yes] [--approve|--no-approve]`;
		case "update":
			return `${APP_NAME} store update [id|source] [-l] [--yes] [--approve|--no-approve]`;
		default:
			return `${APP_NAME} store <search|show|install|remove|update>`;
	}
}

function printStoreHelp(command?: StoreCommand): void {
	if (!command) {
		console.log(`${chalk.bold("Usage:")}
  ${getStoreCommandUsage()}

Commands:
  search [query]       Search catalog packages
  show <id|source>     Show catalog and package metadata
  install <id|source>  Inspect, plan, and install a package
  remove <id|source>   Remove an installed package by catalog ID or source
  update [id|source]   Update installed packages or upgrade from a catalog entry
`);
		return;
	}

	console.log(`${chalk.bold("Usage:")}
  ${getStoreCommandUsage(command)}
`);
}

function parseStoreCommand(args: string[]): StoreCommandOptions | undefined {
	if (args[0] !== "store") {
		return undefined;
	}
	const rawCommand = args[1];
	if (!rawCommand || rawCommand === "-h" || rawCommand === "--help") {
		return {
			command: "search",
			local: false,
			yes: false,
			track: false,
			scriptPolicy: "never",
			projectTrustOverride: parseProjectTrustOverride(args),
			help: true,
		};
	}
	if (
		rawCommand !== "search" &&
		rawCommand !== "show" &&
		rawCommand !== "install" &&
		rawCommand !== "remove" &&
		rawCommand !== "update"
	) {
		return {
			command: "search",
			local: false,
			yes: false,
			track: false,
			scriptPolicy: "never",
			projectTrustOverride: parseProjectTrustOverride(args),
			help: false,
			invalidArgument: rawCommand,
		};
	}

	const command = rawCommand;
	const rest = args.slice(2);
	let local = false;
	let yes = false;
	let track = false;
	let scriptPolicy: StoreInstallScriptPolicy = "never";
	let ref: string | undefined;
	let help = false;
	let projectTrustOverride: boolean | undefined;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	const positionals: string[] = [];

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}
		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove" || command === "update") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}
		if (arg === "--yes" || arg === "-y") {
			if (command === "install" || command === "remove" || command === "update") {
				yes = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}
		if (arg === "--track") {
			if (command === "install") {
				track = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}
		if (arg === "--approve" || arg === "-a") {
			projectTrustOverride = true;
			continue;
		}
		if (arg === "--no-approve" || arg === "-na") {
			projectTrustOverride = false;
			continue;
		}
		if (arg === "--ref") {
			if (command !== "install") {
				invalidOption = invalidOption ?? arg;
				continue;
			}
			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (ref !== undefined) {
				conflictingOptions = conflictingOptions ?? "--ref can only be provided once";
				index++;
			} else {
				ref = value;
				index++;
			}
			continue;
		}
		if (arg === "--scripts") {
			if (command !== "install") {
				invalidOption = invalidOption ?? arg;
				continue;
			}
			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (value !== "ask" && value !== "never" && value !== "allow") {
				conflictingOptions = conflictingOptions ?? "--scripts must be ask, never, or allow";
				index++;
			} else {
				scriptPolicy = value;
				index++;
			}
			continue;
		}
		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}
		positionals.push(arg);
	}

	if (command === "search") {
		if (positionals.length > 1) {
			invalidArgument = invalidArgument ?? positionals[1];
		}
		return {
			command,
			query: positionals[0],
			local,
			yes,
			track,
			scriptPolicy,
			projectTrustOverride,
			help,
			invalidOption,
			invalidArgument,
			missingOptionValue,
			conflictingOptions,
		};
	}

	if (command === "update") {
		if (positionals.length > 1) {
			invalidArgument = invalidArgument ?? positionals[1];
		}
		return {
			command,
			input: positionals[0],
			local,
			yes,
			track,
			scriptPolicy,
			projectTrustOverride,
			help,
			invalidOption,
			invalidArgument,
			missingOptionValue,
			conflictingOptions,
		};
	}

	if (positionals.length > 1) {
		invalidArgument = invalidArgument ?? positionals[1];
	}

	return {
		command,
		input: positionals[0],
		local,
		yes,
		track,
		scriptPolicy,
		...(ref !== undefined ? { ref } : {}),
		projectTrustOverride,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			const normalized = answer.trim().toLowerCase();
			resolve(normalized === "y" || normalized === "yes");
		});
	});
}

function reportCatalogWarnings(warnings: readonly string[]): void {
	for (const warning of warnings) {
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

async function loadCatalog(agentDir: string, options: { required: boolean }): Promise<StoreCatalog | undefined> {
	try {
		const result = await loadDefaultStoreCatalog({ agentDir });
		reportCatalogWarnings(result.warnings);
		return result.catalog;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (!options.required) {
			console.error(chalk.yellow(`Warning: ${message}; continuing without catalog metadata.`));
			return { schemaVersion: STORE_CATALOG_SCHEMA_VERSION, packages: [] };
		}
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return undefined;
	}
}

function hasDirectScripts(plan: StoreInstallPlan): boolean {
	return Object.keys(plan.inspection.scripts).length > 0;
}

async function resolveScriptPolicyForInstall(plan: StoreInstallPlan): Promise<PackageInstallScriptPolicy | undefined> {
	if (plan.scriptPolicy === "allow") {
		return "allow";
	}
	if (plan.scriptPolicy === "never" || !hasDirectScripts(plan)) {
		return "never";
	}
	if (getCommandAppMode() !== "interactive") {
		console.error(chalk.red("Package scripts require interactive confirmation or --scripts allow."));
		process.exitCode = 1;
		return undefined;
	}
	const allow = await promptConfirm("Allow package lifecycle scripts for this install?");
	return allow ? "allow" : "never";
}

function preflightNonInteractiveMutation(options: { yes: boolean; action: string }): boolean {
	if (options.yes || getCommandAppMode() === "interactive") {
		return true;
	}
	console.error(chalk.red(`Non-interactive ${options.action} requires --yes.`));
	process.exitCode = 1;
	return false;
}

async function confirmMutation(options: { yes: boolean; action: string }): Promise<boolean> {
	if (!preflightNonInteractiveMutation(options)) {
		return false;
	}
	if (options.yes) {
		return true;
	}
	const confirmed = await promptConfirm(`Proceed with store ${options.action}?`);
	if (!confirmed) {
		console.log(chalk.dim("Aborted."));
	}
	return confirmed;
}

/** What the package installed for `target` declares, read from its package.json; undefined when that cannot be read. */
function installedPermissions(
	packageManager: DefaultPackageManager,
	target: StoreScopeTarget,
): PackagePermissions | undefined {
	const root = packageManager.getInstalledPath(target.source, target.scope);
	if (root === undefined) return undefined;
	try {
		return readPackagePermissions(root, target.source);
	} catch {
		return undefined;
	}
}

/**
 * Why an update without a terminal keeps `target` at its installed pin: the
 * new pin's manifest (read before installing, from the inspection) cannot be
 * read, or declares permissions the installed pin does not. Undefined when
 * the update may go ahead; its permissions are then reviewed once installed.
 */
function nonInteractiveUpdateRefusal(
	packageManager: DefaultPackageManager,
	target: StoreScopeTarget,
	inspection: StorePackageInspection,
	input: string,
): string | undefined {
	const manifest = inspection.volt?.manifest;
	if (manifest === undefined) return "its extension manifest at the new pin could not be read";
	const installed = installedPermissions(packageManager, target);
	const kept: readonly ExtensionPermission[] = installed?.id === manifest.id ? installed.permissions : [];
	const added = (manifest.permissions ?? []).filter((permission) => !kept.includes(permission));
	return added.length === 0
		? undefined
		: `the new pin adds permissions (${added.join(", ")}); run "${APP_NAME} store update ${input}" in a terminal to review them`;
}

/**
 * Review the permissions of every configured package an update touched:
 * the package `source` names (matched as the update matched it), or all;
 * project ones only with `local`. A package whose permissions were declined
 * or could not be reviewed fails the command.
 */
async function reviewUpdatedPermissions(
	packageManager: DefaultPackageManager,
	agentDir: string,
	options: { readonly source?: string; readonly local: boolean },
): Promise<void> {
	for (const pkg of packageManager.listConfiguredPackages()) {
		if (options.local && pkg.scope !== "project") continue;
		if (options.source !== undefined && !storeUpdateTouches(packageManager, pkg, options.source)) continue;
		const status = await reviewInstalledPermissions(
			packageManager,
			agentDir,
			pkg.source,
			pkg.scope,
			"Declining leaves it installed with its permissions unacknowledged.",
			`${APP_NAME} store update ${pkg.source}`,
		);
		if (status === "declined" || status === "failed") {
			console.error(
				chalk.yellow(
					`${formatStoreSourceSummary(pkg.source)} asks for permissions you did not acknowledge; remove it with "${APP_NAME} store remove ${pkg.source}"`,
				),
			);
			process.exitCode = 1;
		}
	}
}

async function runSearch(options: StoreCommandOptions, agentDir: string): Promise<boolean> {
	const catalog = await loadCatalog(agentDir, { required: true });
	if (!catalog) {
		return true;
	}
	console.log(renderCatalogSearch(searchCatalogPackages(catalog, options.query), options.query));
	return true;
}

async function runShow(
	options: StoreCommandOptions,
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
): Promise<boolean> {
	const input = options.input;
	if (!input) {
		console.error(chalk.red("Missing store show source."));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage("show")}`));
		process.exitCode = 1;
		return true;
	}
	const catalog = await loadCatalog(agentDir, { required: false });
	if (!catalog) {
		return true;
	}
	const resolved = await resolveStoreSource({ input, catalog, pinGit: false });
	const inspection = await inspectStorePackage({
		source: resolved.source,
		cwd,
		npmCommand: settingsManager.getNpmCommand(),
	});
	console.log(renderStoreShow(resolved, inspection));
	return true;
}

async function runInstall(
	options: StoreCommandOptions,
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	packageManager: DefaultPackageManager,
): Promise<boolean> {
	const input = options.input;
	if (!input) {
		console.error(chalk.red("Missing store install source."));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage("install")}`));
		process.exitCode = 1;
		return true;
	}
	if (!preflightNonInteractiveMutation({ yes: options.yes, action: "install" })) {
		return true;
	}
	const catalog = await loadCatalog(agentDir, { required: false });
	if (!catalog) {
		return true;
	}
	const resolved = await resolveStoreSource({
		input,
		catalog,
		track: options.track,
		ref: options.ref,
		pinGit: true,
	});
	const inspection = await inspectStorePackage({
		source: resolved.source,
		cwd,
		npmCommand: settingsManager.getNpmCommand(),
	});
	const scope: StoreInstallScope = options.local ? "project" : "user";
	const plan = buildStoreInstallPlan({
		resolved,
		inspection,
		scope,
		scriptPolicy: options.scriptPolicy,
	});
	console.log(renderStoreInstallPlan(plan));

	if (!(await confirmMutation({ yes: options.yes, action: "install" }))) {
		return true;
	}
	const scripts = await resolveScriptPolicyForInstall(plan);
	if (!scripts) {
		return true;
	}

	await packageManager.installAndPersist(plan.source, { local: options.local, scripts });
	await settingsManager.flush();
	const settingsErrors = settingsManager.drainErrors();
	if (settingsErrors.length > 0) {
		const installedPath = packageManager.getInstalledPath(plan.source, scope);
		for (const { scope: errorScope, error } of settingsErrors) {
			console.error(chalk.yellow(`Warning (${errorScope} settings): ${error.message}`));
		}
		if (installedPath) {
			console.error(chalk.yellow(`Package was installed at ${installedPath}, but settings persistence failed.`));
		}
		process.exitCode = 1;
		return true;
	}

	const permissions = await reviewInstalledPermissions(
		packageManager,
		agentDir,
		storeReviewSource(plan.source, cwd),
		scope,
		"Declining removes the package.",
		`${APP_NAME} store install ${input}`,
	);
	// A package just installed that cannot be found cannot be reviewed: it must not stay to run unreviewed.
	if (permissions === "missing")
		console.error(chalk.red("Could not find the installed package to review its permissions"));
	if (permissions === "declined" || permissions === "failed" || permissions === "missing") {
		await packageManager.removeAndPersist(plan.source, { local: options.local });
		await settingsManager.flush();
		console.error(chalk.red(`Removed ${formatStoreInstallPlanTarget(plan)}: its permissions were not acknowledged`));
		process.exitCode = 1;
		return true;
	}

	console.log(chalk.green(`Installed ${formatStoreInstallPlanTarget(plan)}`));
	return true;
}

async function runRemove(
	options: StoreCommandOptions,
	agentDir: string,
	settingsManager: SettingsManager,
	packageManager: DefaultPackageManager,
): Promise<boolean> {
	const input = options.input;
	if (!input) {
		console.error(chalk.red("Missing store remove source."));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage("remove")}`));
		process.exitCode = 1;
		return true;
	}
	if (!preflightNonInteractiveMutation({ yes: options.yes, action: "remove" })) {
		return true;
	}
	const catalog = await loadCatalog(agentDir, { required: false });
	if (!catalog) {
		return true;
	}
	const resolved = await resolveStoreSource({ input, catalog, pinGit: false });
	const selection = chooseStoreRemoveTarget(packageManager, resolved.source, options.local);
	if (selection.conflict === "both-scopes") {
		console.error(chalk.red("Package is installed in both user and project scopes. Use -l to remove project scope."));
		process.exitCode = 1;
		return true;
	}
	const target = selection.target;
	if (!target) {
		if (process.exitCode === undefined) {
			console.error(chalk.red(`No matching package found for ${input}`));
			process.exitCode = 1;
		}
		return true;
	}

	console.log(`Removing ${formatStoreSourceSummary(target.source)} from ${target.scope} scope.`);
	if (!(await confirmMutation({ yes: options.yes, action: "remove" }))) {
		return true;
	}
	const removed = await packageManager.removeAndPersist(target.actionSource ?? target.source, {
		local: target.scope === "project",
	});
	await settingsManager.flush();
	const settingsErrors = settingsManager.drainErrors();
	if (settingsErrors.length > 0) {
		for (const { scope: errorScope, error } of settingsErrors) {
			console.error(chalk.yellow(`Warning (${errorScope} settings): ${error.message}`));
		}
		process.exitCode = 1;
		return true;
	}
	if (!removed) {
		console.error(chalk.red(`No matching package found for ${input}`));
		process.exitCode = 1;
		return true;
	}
	console.log(chalk.green(`Removed ${formatStoreSourceSummary(target.source)}`));
	return true;
}

async function runUpdate(
	options: StoreCommandOptions,
	cwd: string,
	agentDir: string,
	settingsManager: SettingsManager,
	packageManager: DefaultPackageManager,
): Promise<boolean> {
	const input = options.input;
	if (!input) {
		if (!(await confirmMutation({ yes: options.yes, action: "update" }))) {
			return true;
		}
		await packageManager.update(undefined, options.local ? { local: true, scripts: "never" } : { scripts: "never" });
		await reviewUpdatedPermissions(packageManager, agentDir, { local: options.local });
		console.log(chalk.green("Updated packages"));
		return true;
	}

	if (!preflightNonInteractiveMutation({ yes: options.yes, action: "update" })) {
		return true;
	}
	const catalog = await loadCatalog(agentDir, { required: false });
	if (!catalog) {
		return true;
	}
	const catalogPackage = findCatalogPackage(catalog, input);
	if (!catalogPackage) {
		if (!(await confirmMutation({ yes: options.yes, action: "update" }))) {
			return true;
		}
		await packageManager.update(input, options.local ? { local: true, scripts: "never" } : { scripts: "never" });
		await reviewUpdatedPermissions(packageManager, agentDir, { source: input, local: options.local });
		console.log(chalk.green(`Updated ${formatStoreSourceSummary(input)}`));
		return true;
	}

	const resolved = await resolveStoreSource({ input, catalog, pinGit: true });
	const selection = chooseStoreUpdateTarget(packageManager, resolved.source, options.local);
	if (selection.conflict === "both-scopes") {
		console.error(chalk.red("Package is installed in both user and project scopes. Use -l to update project scope."));
		process.exitCode = 1;
		return true;
	}
	const target = selection.target;
	if (!target) {
		if (process.exitCode === undefined) {
			console.error(chalk.red(`No matching installed package found for catalog ID ${input}`));
			process.exitCode = 1;
		}
		return true;
	}

	if (storeTargetMatchesUpdateSource(target, resolved.source)) {
		if (!(await confirmMutation({ yes: options.yes, action: "update" }))) {
			return true;
		}
		const updateSource = target.actionSource ?? target.source;
		await packageManager.update(updateSource, {
			local: target.scope === "project",
			scripts: "never",
		});
		await reviewUpdatedPermissions(packageManager, agentDir, {
			source: updateSource,
			local: target.scope === "project",
		});
		console.log(chalk.green(`Updated ${formatStoreSourceSummary(target.source)}`));
		return true;
	}

	const inspection = await inspectStorePackage({
		source: resolved.source,
		cwd,
		npmCommand: settingsManager.getNpmCommand(),
	});
	const plan = buildStoreInstallPlan({
		resolved,
		inspection,
		scope: target.scope,
		scriptPolicy: "never",
	});
	console.log(renderStoreInstallPlan(plan));
	const currentLabel = formatStoreSourceSummary(target.source);
	// Without a terminal to ask, an update that would need new permissions keeps the reviewed pin installed.
	const refusal =
		getCommandAppMode() === "interactive"
			? undefined
			: nonInteractiveUpdateRefusal(packageManager, target, inspection, input);
	if (refusal !== undefined) {
		console.error(chalk.yellow(`Kept ${currentLabel}: ${refusal}`));
		process.exitCode = 1;
		return true;
	}
	if (!(await confirmMutation({ yes: options.yes, action: "update" }))) {
		return true;
	}
	const local = target.scope === "project";
	await packageManager.installAndPersist(plan.source, { local, scripts: "never" });
	await settingsManager.flush();
	const settingsErrors = settingsManager.drainErrors();
	if (settingsErrors.length > 0) {
		const installedPath = packageManager.getInstalledPath(plan.source, target.scope);
		for (const { scope: errorScope, error } of settingsErrors) {
			console.error(chalk.yellow(`Warning (${errorScope} settings): ${error.message}`));
		}
		if (installedPath) {
			console.error(chalk.yellow(`Package was installed at ${installedPath}, but settings persistence failed.`));
		}
		process.exitCode = 1;
		return true;
	}
	const permissions = await reviewInstalledPermissions(
		packageManager,
		agentDir,
		plan.source,
		target.scope,
		`Declining keeps ${currentLabel}.`,
		`${APP_NAME} store update ${input}`,
	);
	if (permissions === "missing")
		console.error(chalk.red("Could not find the installed package to review its permissions"));
	if (permissions === "declined" || permissions === "failed" || permissions === "missing") {
		process.exitCode = 1;
		// The declined revision must not stay installed: without the previous one, the package goes.
		const removeDeclined = async (reason: string): Promise<void> => {
			await packageManager.removeAndPersist(plan.source, { local });
			await settingsManager.flush();
			console.error(chalk.red(`Removed ${currentLabel}: ${reason}`));
		};
		// Back to the installed pin: the update's permissions were not acknowledged.
		try {
			await packageManager.installAndPersist(target.source, { local, scripts: "never" });
			await settingsManager.flush();
		} catch (error: unknown) {
			const message = sanitizeText(error instanceof Error ? error.message : String(error));
			console.error(chalk.red(`Could not reinstall ${currentLabel}: ${message}`));
			await removeDeclined("the update's permissions were not acknowledged");
			return true;
		}
		// A source without a commit pin reinstalls at its newest revision, which has its own permissions:
		// declining them too removes the package.
		if (!storeSourcePinsCommit(target.source)) {
			const rollback = await reviewInstalledPermissions(
				packageManager,
				agentDir,
				target.source,
				target.scope,
				"Declining removes the package.",
				`${APP_NAME} store update ${input}`,
			);
			if (rollback === "missing") {
				console.error(chalk.red("Could not find the installed package to review its permissions"));
			}
			if (rollback === "declined" || rollback === "failed" || rollback === "missing" || rollback === "unreviewed") {
				await removeDeclined("the reinstalled revision's permissions were not acknowledged");
				return true;
			}
		}
		console.error(chalk.red(`Kept ${currentLabel}: the update's permissions were not acknowledged`));
		return true;
	}
	console.log(chalk.green(`Updated ${currentLabel} to ${formatStoreInstallPlanTarget(plan)}`));
	return true;
}

export async function handleStoreCommand(
	args: string[],
	runtimeOptions: StoreCommandRuntimeOptions = {},
): Promise<boolean> {
	const options = parseStoreCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printStoreHelp(args[1] as StoreCommand | undefined);
		return true;
	}
	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "store ${options.command}".`));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}
	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}
	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}
	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getStoreCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();

	try {
		if (options.command === "search") {
			return await runSearch(options, agentDir);
		}
		if (options.command === "show" && !options.input) {
			console.error(chalk.red("Missing store show source."));
			console.error(chalk.dim(`Usage: ${getStoreCommandUsage("show")}`));
			process.exitCode = 1;
			return true;
		}
		if (options.command === "install" && !options.input) {
			console.error(chalk.red("Missing store install source."));
			console.error(chalk.dim(`Usage: ${getStoreCommandUsage("install")}`));
			process.exitCode = 1;
			return true;
		}
		if (options.command === "remove" && !options.input) {
			console.error(chalk.red("Missing store remove source."));
			console.error(chalk.dim(`Usage: ${getStoreCommandUsage("remove")}`));
			process.exitCode = 1;
			return true;
		}
		if (
			(options.command === "install" || options.command === "remove" || options.command === "update") &&
			!preflightNonInteractiveMutation({ yes: options.yes, action: options.command })
		) {
			return true;
		}

		const writesProjectPackageConfig =
			options.local &&
			(options.command === "install" || options.command === "remove" || options.command === "update");
		const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
			cwd,
			agentDir,
			projectTrustOverride: options.projectTrustOverride,
			extensionFactories: runtimeOptions.extensionFactories,
			loadProjectTrustExtensions: false,
			profile: runtimeOptions.profile,
		});
		reportProjectTrustWarnings(projectTrustWarnings);
		if (!settingsManager.isProjectTrusted() && writesProjectPackageConfig) {
			console.error(chalk.red("Project is not trusted. Use --approve to modify local package config."));
			process.exitCode = 1;
			return true;
		}
		reportSettingsErrors(settingsManager, "store command");

		const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
		packageManager.setProgressCallback((event) => {
			if (event.type === "start" && event.message) {
				process.stdout.write(chalk.dim(`${formatStoreProgressMessage(event.source, event.message)}\n`));
			}
		});

		switch (options.command) {
			case "show":
				return await runShow(options, cwd, agentDir, settingsManager);
			case "install":
				return await runInstall(options, cwd, agentDir, settingsManager, packageManager);
			case "remove":
				return await runRemove(options, agentDir, settingsManager, packageManager);
			case "update":
				return await runUpdate(options, cwd, agentDir, settingsManager, packageManager);
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown store command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
