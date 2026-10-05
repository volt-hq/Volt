import { Markdown, type MarkdownTheme, sanitizeText } from "@hansjm10/volt-tui";
import chalk from "chalk";
import { selectConfig } from "./cli/config-selector.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import {
	APP_NAME,
	createGlobalPackageLocator,
	detectInstallMethod,
	getAgentDir,
	getPackageDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	VERSION,
} from "./config.ts";
import {
	ExtensionPermissionStore,
	type PackagePermissionOutcome,
	permissionRequestLines,
	reviewPackagePermissions,
} from "./core/extensions/permissions.ts";
import type { ExtensionDefinition } from "./core/extensions/types.ts";
import { DefaultPackageManager } from "./core/package-manager.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import { DefaultResourceLoader } from "./core/resource-loader.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { daemonStop, promptConfirm } from "./daemon/cli.ts";
import { isDaemonServiceInstalled, isDaemonServiceProcess } from "./daemon/service-install.ts";
import {
	type DaemonStarter,
	findRunningDaemon,
	refreshInstalledDaemonService,
	startInstalledDaemon,
} from "./daemon/spawn.ts";
import { spawnProcess } from "./utils/child-process.ts";
import {
	cleanupSelfUpdateQuarantine,
	NativeAddonRestoreError,
	quarantineNativeAddons,
} from "./utils/self-update-native-quarantine.ts";
import { getLatestVoltRelease, isNewerPackageVersion } from "./utils/version-check.ts";

export type PackageCommand = "install" | "remove" | "update" | "list";

type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string };

const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => chalk.bold(chalk.yellow(text)),
	link: (text) => chalk.cyan(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.dim(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.dim(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.yellow(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	updateTarget?: UpdateTarget;
	local: boolean;
	force: boolean;
	projectTrustOverride?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

export function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l] [--approve|--no-approve]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l] [--approve|--no-approve]`;
		case "update":
			return `${APP_NAME} update [source|self|volt] [--self] [--extensions] [--extension <source>] [--approve|--no-approve] [--force]`;
		case "list":
			return `${APP_NAME} list [--approve|--no-approve]`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local       Install project-locally (.volt/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local       Remove from project settings (.volt/settings.json)
  -a, --approve     Trust project-local files for this command
  -na, --no-approve Ignore project-local files for this command

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update volt and installed packages.

Options:
  --self                  Update volt only
  --extensions            Update installed packages only
  --extension <source>    Update one package only
  -a, --approve           Trust project-local files for this command
  -na, --no-approve       Ignore project-local files for this command
  --force                 Reinstall volt even if the current version is latest

Short forms:
  ${APP_NAME} update                Update volt and all extensions
  ${APP_NAME} update <source>       Update one package
  ${APP_NAME} update volt             Update volt only (self works as alias to volt)
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.

Options:
  -a, --approve      Trust project-local files for this command
  -na, --no-approve  Ignore project-local files for this command
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let force = false;
	let projectTrustOverride: boolean | undefined;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let selfFlag = false;
	let extensionsFlag = false;
	let extensionFlagSource: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extensions") {
			if (command === "update") {
				extensionsFlag = true;
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

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extension") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (extensionFlagSource) {
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				index++;
			} else {
				extensionFlagSource = value;
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	let updateTarget: UpdateTarget | undefined;
	if (command === "update") {
		if (extensionFlagSource) {
			if (selfFlag || extensionsFlag) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with --self or --extensions";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
			}
			updateTarget = { type: "extensions", source: extensionFlagSource };
		} else if (source) {
			const sourceIsSelf = source === "self" || source === "volt";
			if (sourceIsSelf) {
				updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
			} else {
				if (extensionsFlag || selfFlag) {
					conflictingOptions =
						conflictingOptions ?? "positional update targets cannot be combined with --self or --extensions";
				}
				updateTarget = { type: "extensions", source };
			}
		} else if (selfFlag && extensionsFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag) {
			updateTarget = { type: "self" };
		} else if (extensionsFlag) {
			updateTarget = { type: "extensions" };
		} else {
			updateTarget = { type: "all" };
		}
	}

	return {
		command,
		source,
		updateTarget,
		local,
		force,
		projectTrustOverride,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

function printSelfUpdateUnavailable(npmCommand?: string[], updatePackageSpec = PACKAGE_NAME): void {
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageSpec));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(`Location of volt executable: ${entrypoint}`);
	}
}

/** The update failed, but the rollback step reinstalled the previous version. */
class SelfUpdateRestoredError extends Error {}

/** Preparing the update failed before the package manager ran, so nothing was installed. */
class SelfUpdateNotStartedError extends Error {}

function printSelfUpdateFailure(error: unknown, command: SelfUpdateCommand): void {
	const message = error instanceof Error ? error.message : "Unknown package command error";
	console.error(chalk.red(`Error: ${message}`));
	if (error instanceof NativeAddonRestoreError) {
		console.error(
			chalk.yellow(
				`Nothing was installed, but this ${APP_NAME} installation now has a missing or incomplete native addon.`,
			),
		);
		console.error(
			chalk.dim(
				`Copy ${error.quarantinePath} to ${error.addonPath} and delete ${error.quarantineRunDir}, then update with: ${command.display}`,
			),
		);
		return;
	}
	if (error instanceof SelfUpdateNotStartedError) {
		console.error(chalk.yellow(`Nothing was installed, so this ${APP_NAME} installation is unchanged.`));
		console.error(
			chalk.dim(`Close every ${APP_NAME} process, including voltd, then update with: ${command.display}`),
		);
		return;
	}
	if (error instanceof SelfUpdateRestoredError) {
		console.error(chalk.dim(`If this keeps failing, run this command yourself: ${command.display}`));
		return;
	}
	console.error(chalk.yellow(`The update did not finish, so this ${APP_NAME} installation may be incomplete.`));
	console.error(
		chalk.dim(
			`If ${APP_NAME} still starts, run \`${APP_NAME} update --self\` again. Otherwise close every ${APP_NAME} process, including voltd, then reinstall with: ${command.display}`,
		),
	);
}

function printSelfUpdateNote(note: string): void {
	const trimmedNote = note.trim();
	if (!trimmedNote) {
		return;
	}

	console.log();
	console.log(chalk.bold(chalk.yellow("Update note")));
	try {
		const width = Math.max(20, process.stdout.columns ?? 80);
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			.render(width)
			.lines.map((line) => line.trimEnd());
		console.log(renderedLines.join("\n"));
	} catch {
		console.log(trimmedNote);
	}
	console.log();
}

interface SelfUpdatePlan {
	packageName: string;
	packageSpec: string;
	shouldRun: boolean;
	note?: string;
}

const LATEST_SELF_UPDATE_PACKAGE_SPEC = `${PACKAGE_NAME}@latest`;
const HOSTED_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function normalizeHostedPackageName(packageName: string | undefined): string | undefined {
	if (packageName === undefined) return undefined;
	const normalized = packageName.trim();
	if (normalized.length > 214 || !HOSTED_PACKAGE_NAME_RE.test(normalized)) {
		throw new Error(`Hosted update packageName is not a bare npm package identity: ${packageName}`);
	}
	return normalized;
}

async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	if (force) {
		return { packageName: PACKAGE_NAME, packageSpec: LATEST_SELF_UPDATE_PACKAGE_SPEC, shouldRun: true };
	}

	try {
		const latestRelease = await getLatestVoltRelease(VERSION);
		const hostedPackageName = normalizeHostedPackageName(latestRelease?.packageName);
		const targetPackageName = hostedPackageName ?? PACKAGE_NAME;
		const packageSpec = `${targetPackageName}@latest`;
		if (
			!latestRelease ||
			(hostedPackageName !== undefined && hostedPackageName !== PACKAGE_NAME) ||
			isNewerPackageVersion(latestRelease.version, VERSION)
		) {
			return {
				packageName: targetPackageName,
				packageSpec,
				shouldRun: true,
				...(latestRelease?.note ? { note: latestRelease.note } : {}),
			};
		}
	} catch {
		return { packageName: PACKAGE_NAME, packageSpec: LATEST_SELF_UPDATE_PACKAGE_SPEC, shouldRun: true };
	}

	console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
	return { packageName: PACKAGE_NAME, packageSpec: LATEST_SELF_UPDATE_PACKAGE_SPEC, shouldRun: false };
}

async function runSelfUpdateStep(step: Pick<SelfUpdateCommand, "command" | "args" | "display">): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawnProcess(step.command, step.args, {
			stdio: "inherit",
		});
		child.on("error", (error) => {
			reject(error);
		});
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve();
			} else if (signal) {
				reject(new Error(`${step.display} terminated by signal ${signal}`));
			} else {
				reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
			}
		});
	});
}

function selfUpdateErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(chalk.dim(`Updating ${APP_NAME} with ${command.display}...`));
	let completedSteps = 0;
	for (const step of command.steps ?? [command]) {
		try {
			await runSelfUpdateStep(step);
			completedSteps++;
		} catch (updateError) {
			if (!command.rollbackStep || completedSteps === 0) throw updateError;
			try {
				await runSelfUpdateStep(command.rollbackStep);
			} catch (rollbackError) {
				throw new Error(
					`${selfUpdateErrorMessage(updateError)}; rollback command ${command.rollbackStep.display} also failed: ${selfUpdateErrorMessage(rollbackError)}`,
				);
			}
			throw new SelfUpdateRestoredError(
				`${selfUpdateErrorMessage(updateError)}; restored the previous ${APP_NAME} version with ${command.rollbackStep.display}`,
			);
		}
	}
}

/**
 * Other volt processes can hold this installation's native addons open, which can make npm
 * fail halfway and leave volt unusable. Move them out of the package before npm runs.
 */
function prepareNpmSelfUpdate(packageDir: string): void {
	cleanupSelfUpdateQuarantine(packageDir);
	try {
		quarantineNativeAddons(packageDir);
	} catch (error) {
		// The installation changed, so it must not be reported as unchanged.
		if (error instanceof NativeAddonRestoreError) throw error;
		throw new SelfUpdateNotStartedError(selfUpdateErrorMessage(error), { cause: error });
	}
}

export function parseProjectTrustOverride(args: readonly string[]): boolean | undefined {
	let trustOverride: boolean | undefined;
	for (const arg of args) {
		if (arg === "--approve" || arg === "-a") {
			trustOverride = true;
		} else if (arg === "--no-approve" || arg === "-na") {
			trustOverride = false;
		}
	}
	return trustOverride;
}

export interface PackageCommandRuntimeOptions {
	extensionFactories?: ExtensionDefinition[];
	profile?: string;
}

export interface CommandSettingsResult {
	settingsManager: SettingsManager;
	projectTrustWarnings: string[];
}

export function getCommandAppMode(): AppMode {
	return process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
}

export function reportProjectTrustWarnings(warnings: readonly string[]): void {
	for (const warning of warnings) {
		console.error(chalk.yellow(`Warning: ${warning}`));
	}
}

function normalizeCommandProfile(profile: string | undefined): string | undefined {
	const trimmed = profile?.trim();
	return trimmed ? trimmed : undefined;
}

function resolveCommandProfile(profile: string | undefined): string | undefined {
	return normalizeCommandProfile(profile ?? process.env.VOLT_PROFILE);
}

export async function createCommandSettingsManager(options: {
	cwd: string;
	agentDir: string;
	projectTrustOverride?: boolean;
	useSavedProjectTrustOnly?: boolean;
	extensionFactories?: ExtensionDefinition[];
	loadProjectTrustExtensions?: boolean;
	profile?: string;
}): Promise<CommandSettingsResult> {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
		projectTrusted: false,
		profile: resolveCommandProfile(options.profile),
	});
	const projectTrustWarnings: string[] = [];
	const trustStore = new ProjectTrustStore(options.agentDir);
	if (options.useSavedProjectTrustOnly) {
		const savedProjectTrusted = trustStore.get(options.cwd) === true;
		settingsManager.setProjectTrusted(options.projectTrustOverride ?? savedProjectTrusted);
		return { settingsManager, projectTrustWarnings };
	}

	const appMode = getCommandAppMode();
	const shouldLoadProjectTrustExtensions = options.loadProjectTrustExtensions ?? true;
	const extensionsResult =
		shouldLoadProjectTrustExtensions &&
		options.projectTrustOverride === undefined &&
		hasTrustRequiringProjectResources(options.cwd)
			? await new DefaultResourceLoader({
					cwd: options.cwd,
					agentDir: options.agentDir,
					settingsManager,
					extensionFactories: options.extensionFactories,
				}).loadProjectTrustExtensions()
			: undefined;
	for (const error of extensionsResult?.errors ?? []) {
		projectTrustWarnings.push(`Failed to load extension "${error.path}": ${error.error}`);
	}

	const projectTrusted = await resolveProjectTrusted({
		cwd: options.cwd,
		trustStore,
		trustOverride: options.projectTrustOverride,
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		extensionsResult,
		projectTrustContext: createProjectTrustContext({
			cwd: options.cwd,
			mode: appMode,
			settingsManager,
			hasUI: appMode === "interactive",
		}),
		onExtensionError: (message) => projectTrustWarnings.push(message),
	});
	settingsManager.setProjectTrusted(projectTrusted);
	return { settingsManager, projectTrustWarnings };
}

/**
 * Review the permissions of the package installed from `source` in `scope`:
 * in a terminal, show the ones not acknowledged yet and ask; otherwise show
 * them, unacknowledged. A manifest that cannot be read is reported and left
 * to fail when the extension loads.
 */
async function reviewInstalledPermissions(
	packageManager: DefaultPackageManager,
	agentDir: string,
	source: string,
	scope: "user" | "project",
	consequence: string,
): Promise<PackagePermissionOutcome["status"] | "failed"> {
	const root = packageManager.getInstalledPath(source, scope);
	if (root === undefined) return "none";
	try {
		const outcome = await reviewPackagePermissions({
			store: new ExtensionPermissionStore(agentDir),
			root,
			source,
			...(getCommandAppMode() === "interactive"
				? {
						confirm: async (subject, added) => {
							console.log(permissionRequestLines(subject, added).join("\n"));
							return promptConfirm(`Acknowledge these permissions? ${consequence}`);
						},
					}
				: {}),
		});
		if (outcome.status === "unreviewed") {
			console.log(chalk.yellow(permissionRequestLines(outcome.subject, []).join("\n")));
			console.log(
				chalk.yellow(
					`These permissions are not acknowledged. Run "${APP_NAME} install ${source}" in a terminal to review them.`,
				),
			);
		}
		return outcome.status;
	} catch (error: unknown) {
		// The message can carry text from the package: print it inert.
		const message = sanitizeText(error instanceof Error ? error.message : String(error));
		console.error(chalk.yellow(`Could not review the permissions of ${source}: ${message}`));
		return "failed";
	}
}

export async function handleConfigCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: parseProjectTrustOverride(args),
		extensionFactories: runtimeOptions.extensionFactories,
		profile: runtimeOptions.profile,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	reportSettingsErrors(settingsManager, "config command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

export async function handlePackageCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const writesProjectPackageConfig = (options.command === "install" || options.command === "remove") && options.local;
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: options.projectTrustOverride,
		useSavedProjectTrustOnly: options.command === "update",
		extensionFactories: runtimeOptions.extensionFactories,
		profile: runtimeOptions.profile,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (!settingsManager.isProjectTrusted() && writesProjectPackageConfig) {
		console.error(chalk.red("Project is not trusted. Use --approve to modify local package config."));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "package command");
	const selfUpdateNpmCommand = settingsManager.getGlobalEffectiveSettings().npmCommand;

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install": {
				await packageManager.installAndPersist(source!, { local: options.local });
				const scope = options.local ? "project" : "user";
				const permissions = await reviewInstalledPermissions(
					packageManager,
					agentDir,
					source!,
					scope,
					"Declining removes the package.",
				);
				if (permissions === "declined" || permissions === "failed") {
					await packageManager.removeAndPersist(source!, { local: options.local });
					console.error(chalk.red(`Removed ${source}: its permissions were not acknowledged`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Installed ${source}`));
				return true;
			}

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update": {
				const target = options.updateTarget ?? { type: "all" };
				if (updateTargetIncludesExtensions(target)) {
					const updateSource = target.type === "extensions" ? target.source : undefined;
					await packageManager.update(updateSource);
					for (const pkg of packageManager.listConfiguredPackages()) {
						if (updateSource !== undefined && pkg.source !== updateSource && pkg.actionSource !== updateSource) {
							continue;
						}
						const permissions = await reviewInstalledPermissions(
							packageManager,
							agentDir,
							pkg.source,
							pkg.scope,
							"Declining leaves it installed with its permissions unacknowledged.",
						);
						if (permissions === "declined" || permissions === "failed") {
							console.error(
								chalk.yellow(
									`${pkg.source} asks for permissions you did not acknowledge; remove it with "${APP_NAME} remove ${pkg.source}"`,
								),
							);
						}
					}
					if (updateSource) {
						console.log(chalk.green(`Updated ${updateSource}`));
					} else {
						console.log(chalk.green("Updated packages"));
					}
				}
				if (updateTargetIncludesSelf(target)) {
					const selfUpdatePlan = await getSelfUpdatePlan(options.force);
					if (!selfUpdatePlan.shouldRun) {
						return true;
					}
					const installMethod = detectInstallMethod();
					if (process.platform === "win32" && installMethod !== "npm" && installMethod !== "pnpm") {
						console.error(
							chalk.red(`${APP_NAME} self-update on Windows is only supported for npm and pnpm installs.`),
						);
						console.error(chalk.dim(`Detected install method: ${installMethod}. Update ${APP_NAME} manually.`));
						process.exitCode = 1;
						return true;
					}
					const selfUpdateCommand = getSelfUpdateCommand(
						PACKAGE_NAME,
						selfUpdateNpmCommand,
						selfUpdatePlan.packageSpec,
					);
					if (!selfUpdateCommand) {
						printSelfUpdateUnavailable(selfUpdateNpmCommand, selfUpdatePlan.packageSpec);
						process.exitCode = 1;
						return true;
					}
					if (selfUpdatePlan.note) {
						printSelfUpdateNote(selfUpdatePlan.note);
					}
					// A running daemon holds this installation's native addons open, which can
					// make the package manager fail halfway and leave volt unusable.
					const runningDaemon = await findRunningDaemon(agentDir);
					let daemonRestart: { starter: DaemonStarter; startCommand: string } | undefined;
					if (runningDaemon) {
						// Decide before prompting: the manual steps depend on it, and the service pid
						// disappears once the daemon stops.
						const starter: DaemonStarter =
							runningDaemon.pid !== undefined && (await isDaemonServiceProcess(runningDaemon.pid))
								? "service"
								: "terminal";
						// Reinstalling the service rewrites its entrypoint, which the update may have moved.
						const startCommand = `${APP_NAME} daemon ${starter === "service" ? "install-service" : "start"}`;
						const daemonLabel = runningDaemon.pid === undefined ? "voltd" : `voltd (pid ${runningDaemon.pid})`;
						console.error(
							chalk.yellow(
								`${daemonLabel} is running and must stop while ${APP_NAME} updates. Running phone sessions will be interrupted.`,
							),
						);
						if (!(await promptConfirm(`Stop voltd, update ${APP_NAME}, and start voltd again?`))) {
							console.error(chalk.red(`${APP_NAME} was not updated because voltd is running.`));
							console.error(
								chalk.dim(
									`Run \`${APP_NAME} daemon stop\`, then \`${APP_NAME} update --self${options.force ? " --force" : ""}\`, then \`${startCommand}\`.`,
								),
							);
							process.exitCode = 1;
							return true;
						}
						daemonRestart = { starter, startCommand };
					}
					// The service records this installation's entrypoint, which the update can move.
					// Reinstalling the service to restart its daemon already rewrites it.
					const refreshService = daemonRestart?.starter !== "service" && isDaemonServiceInstalled();
					// Capture before updating: the update can move or remove this package directory.
					const locatePackage =
						daemonRestart || refreshService
							? createGlobalPackageLocator(PACKAGE_NAME, selfUpdateNpmCommand)
							: undefined;
					if (daemonRestart && !(await daemonStop(agentDir))) {
						console.error(chalk.red(`${APP_NAME} was not updated because voltd did not stop.`));
						process.exitCode = 1;
						return true;
					}
					let updated = false;
					const quarantinePackageDir = installMethod === "npm" ? getPackageDir() : undefined;
					try {
						if (quarantinePackageDir !== undefined) {
							prepareNpmSelfUpdate(quarantinePackageDir);
						}
						await runSelfUpdate(selfUpdateCommand);
						updated = true;
						console.log(chalk.green(`Updated ${APP_NAME}`));
					} catch (error: unknown) {
						printSelfUpdateFailure(error, selfUpdateCommand);
						process.exitCode = 1;
					}
					if (quarantinePackageDir !== undefined) {
						// Best effort: addons that other processes still hold stay until a later update.
						cleanupSelfUpdateQuarantine(quarantinePackageDir);
					}
					if (daemonRestart) {
						// Restart even after a failed update: the previous install may still be intact.
						const packageDir = locatePackage?.(updated ? selfUpdatePlan.packageName : PACKAGE_NAME);
						if (!packageDir) {
							console.error(chalk.red(`Could not find the installed ${APP_NAME} package to start voltd from.`));
						}
						if (!packageDir || !(await startInstalledDaemon(agentDir, packageDir, daemonRestart.starter))) {
							console.error(
								chalk.red(
									`voltd was stopped for the update and did not start again. Start it with \`${daemonRestart.startCommand}\`.`,
								),
							);
							process.exitCode = 1;
						}
					}
					if (updated && refreshService) {
						const packageDir = locatePackage?.(selfUpdatePlan.packageName);
						if (!packageDir) {
							console.error(
								chalk.red(`Could not find the installed ${APP_NAME} package to update the login service from.`),
							);
						}
						if (!packageDir || !(await refreshInstalledDaemonService(agentDir, packageDir))) {
							console.error(
								chalk.red(
									`The login service may still point at the previous installation. Update it with \`${APP_NAME} daemon install-service\`, which also starts voltd.`,
								),
							);
							process.exitCode = 1;
						}
					}
				}
				return true;
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
