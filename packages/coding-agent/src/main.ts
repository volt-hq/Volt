/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { createInterface } from "node:readline";
import type { ImageContent } from "@hansjm10/volt-ai";
import chalk from "chalk";
import { buildSessionOptions, createWorkerSpawnOptions, resolveCliPaths } from "./cli/agent-options.ts";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { selectSession } from "./cli/session-picker.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup } from "./cli/startup-ui.ts";
import { decideTuiProjectTrust, resolveTuiStartupTarget } from "./cli/tui-startup.ts";
import { ENV_SESSION_DIR, expandTildePath, getAgentDir, getPackageDir, VERSION } from "./config.ts";
import {
	type AgentSessionDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.ts";
import { AuthStorage } from "./core/auth-storage.ts";
import { ConversationLockedError } from "./core/conversation-log/conversation-lock.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import type { ExtensionDefinition, ExtensionMode } from "./core/extensions/types.ts";
import { GitContextProviderPool } from "./core/git-context-provider-pool.ts";
import { ConversationHost } from "./core/host/conversation-host.ts";
import type { ConversationFactory } from "./core/host/hosted-conversation.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { LspServerPool } from "./core/lsp/server-pool.ts";
import { resolveModelScope } from "./core/model-resolver.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { type AppMode, resolveConversationProjectTrust, resolveProjectTrusted } from "./core/project-trust.ts";
import { getMissingSessionCwdIssue, MissingSessionCwdError } from "./core/session-cwd.ts";
import { findLocalSessionByExactId, type ResolvedSession, resolveSessionArgument } from "./core/session-lookup.ts";
import { assertValidSessionId, SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { SubagentManager } from "./core/subagents/index.ts";
import { initTheme, stopThemeWatcher } from "./core/theme/runtime.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { handleDaemonCommand } from "./daemon/cli.ts";
import { handleRemoteControlCommand } from "./daemon/remote-cli.ts";
import { closeLocalSessionManager, restoreLocalSessionWorktree } from "./daemon/session-worktree.ts";
import { isPathUnderWorktreesRoot, resolveWorktreeParentCheckout } from "./daemon/worktree-manager.ts";
import { handleMcpCommand } from "./mcp-cli.ts";
import { runMigrations, showDeprecationWarnings } from "./migrations.ts";
import { InteractiveMode, runPrintMode, runRpcMode } from "./modes/index.ts";
import { DaemonConnector } from "./modes/interactive/daemon-connector.ts";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { handleStoreCommand } from "./store/store-cli.ts";
import { normalizePath } from "./utils/paths.ts";
import { cleanupSelfUpdateQuarantine } from "./utils/self-update-native-quarantine.ts";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(settingsManager: SettingsManager, context: string): AgentSessionDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveRequestedProfile(parsed: Args): string | undefined {
	const profile = parsed.profile ?? process.env.VOLT_PROFILE;
	const trimmed = profile?.trim();
	return trimmed ? trimmed : undefined;
}

function stripCommandProfileArgs(args: readonly string[]): { args: string[]; profile?: string; error?: string } {
	const commandArgs: string[] = [];
	let profile: string | undefined;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--profile") {
			const value = args[index + 1];
			if (value === undefined || value.startsWith("-")) {
				return { args: [...args], error: "--profile requires a value" };
			}
			profile = value;
			index++;
			continue;
		}
		commandArgs.push(arg);
	}

	return { args: commandArgs, profile };
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc"> {
	return appMode === "json" ? "json" : "text";
}

/** The mode the CLI's conversations bind their extensions in (`ctx.mode`): the TUI's host is an RPC host of its client. */
function toExtensionMode(appMode: AppMode): ExtensionMode {
	return appMode === "interactive" || appMode === "rpc" ? "rpc" : appMode === "json" ? "json" : "print";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function validateSessionIdFlags(parsed: Args): void {
	if (parsed.sessionId === undefined) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --session-id cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}

	try {
		assertValidSessionId(parsed.sessionId);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function forkSessionOrExit(
	source: Extract<ResolvedSession, { type: "path" | "local" | "global" }>,
	cwd: string,
	sessionDir?: string,
	sessionId?: string,
): Promise<SessionManager> {
	try {
		return source.type === "path"
			? await SessionManager.importFromJsonl(source.path, cwd, sessionDir, { id: sessionId })
			: await SessionManager.forkFrom(source.ref, cwd, sessionDir, { id: sessionId });
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	if (parsed.noSession || parsed.help || parsed.listModels !== undefined) {
		return SessionManager.inMemory(cwd);
	}

	if (parsed.fork) {
		if (parsed.sessionId) {
			const existingTarget = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
			if (existingTarget) {
				console.error(chalk.red(`Session already exists with id '${parsed.sessionId}'`));
				process.exit(1);
			}
		}

		const resolved = await resolveSessionArgument(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved, cwd, sessionDir, parsed.sessionId);

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionArgument(parsed.session, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
				return SessionManager.importFromJsonl(resolved.path, undefined, sessionDir);

			case "local":
				return SessionManager.open(resolved.ref);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved, cwd, sessionDir);
			}

			case "not_found":
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedRef = await selectSession(
				(onProgress, query) =>
					query ? SessionManager.search(cwd, query, sessionDir) : SessionManager.list(cwd, sessionDir, onProgress),
				(onProgress, query) =>
					query ? SessionManager.searchAll(query, sessionDir) : SessionManager.listAll(sessionDir, onProgress),
			);
			if (!selectedRef) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedRef);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		const latest = await SessionManager.findContinuation(cwd, sessionDir);
		return latest ? SessionManager.open(latest) : SessionManager.create(cwd, sessionDir);
	}

	if (parsed.sessionId) {
		const existingSession = await findLocalSessionByExactId(parsed.sessionId, cwd, sessionDir);
		if (existingSession) {
			return SessionManager.open(existingSession.ref);
		}
	}

	return SessionManager.create(cwd, sessionDir, { id: parsed.sessionId });
}

async function throwAfterClosingSessionManager(
	manager: SessionManager,
	error: unknown,
	message: string,
): Promise<never> {
	try {
		await closeLocalSessionManager(manager);
	} catch (closeError) {
		throw new AggregateError([error, closeError], message);
	}
	throw error;
}

class CliSessionManagerOwner {
	private manager: SessionManager | undefined;

	constructor(manager: SessionManager) {
		this.manager = manager;
	}

	get current(): SessionManager {
		if (!this.manager) throw new Error("CLI session manager ownership has already transferred");
		return this.manager;
	}

	private release(): SessionManager | undefined {
		const manager = this.manager;
		this.manager = undefined;
		return manager;
	}

	async close(): Promise<void> {
		const manager = this.release();
		if (manager) await closeLocalSessionManager(manager);
	}

	async fail(error: unknown, message: string): Promise<never> {
		const manager = this.release();
		if (!manager) throw error;
		return throwAfterClosingSessionManager(manager, error, message);
	}

	transfer(): SessionManager {
		const manager = this.release();
		if (!manager) throw new Error("CLI session manager ownership has already transferred");
		return manager;
	}
}

/** Run `operation`, then close the host's conversations unless the operation handed them to a mode. */
async function runWithOwnedConversationHost(
	host: ConversationHost,
	operation: (transferRuntime: () => void) => Promise<void>,
): Promise<void> {
	let runtimeOwned = true;
	let operationError: unknown;
	let operationFailed = false;
	try {
		await operation(() => {
			runtimeOwned = false;
		});
	} catch (error) {
		operationFailed = true;
		operationError = error;
	}

	let cleanupError: unknown;
	let cleanupFailed = false;
	if (runtimeOwned) {
		try {
			await host.dispose();
		} catch (error) {
			cleanupFailed = true;
			cleanupError = error;
		}
	}
	if (operationFailed && cleanupFailed) {
		throw new AggregateError([operationError, cleanupError], "CLI runtime setup failed and cleanup did not complete");
	}
	if (operationFailed) throw operationError;
	if (cleanupFailed) throw cleanupError;
}

interface InteractiveStartupContext {
	readonly cwd: string;
	readonly agentDir: string;
	readonly sessionDir: string | undefined;
	readonly startupSettingsManager: SettingsManager;
	readonly requestedProfile: string | undefined;
	readonly requestedSessionName: string | undefined;
	readonly migratedProviders: string[];
	readonly deprecationWarnings: string[];
	readonly extensionFactories: ExtensionDefinition[] | undefined;
}

/**
 * Run the interactive TUI as a client of a daemon worker (Phase 7 plan §9
 * row 8): resolve the conversation it opens and decide its project trust
 * read-only, then attach through the daemon connector, which starts the
 * daemon when none runs. The TUI renders and takes typing before its worker
 * is ready.
 */
async function runInteractive(parsed: Args, context: InteractiveStartupContext): Promise<void> {
	const { cwd, agentDir, sessionDir, startupSettingsManager, requestedProfile } = context;
	if (context.extensionFactories !== undefined && context.extensionFactories.length > 0) {
		console.error(
			chalk.red(
				"Error: extension factories run in this process; an interactive TUI runs its conversations in daemon workers. Build InteractiveMode over an InProcessConnector instead.",
			),
		);
		process.exitCode = 1;
		return;
	}
	const startup = await resolveTuiStartupTarget(parsed, {
		cwd,
		sessionDir,
		agentDir,
		settingsManager: startupSettingsManager,
		confirm: promptConfirm,
	});
	if ("exit" in startup) {
		if (startup.message !== undefined) console.error(chalk.red(`Error: ${startup.message}`));
		process.exitCode = startup.exit;
		return;
	}
	time("resolveStartupTarget");
	const decided = await decideTuiProjectTrust(parsed, startup.cwd, agentDir, startupSettingsManager);
	const projectTrusted = resolveConversationProjectTrust(agentDir, startup.cwd, decided);
	time("decideProjectTrust");
	const displaySettings = SettingsManager.create(startup.cwd, agentDir, { projectTrusted, profile: requestedProfile });
	reportDiagnostics(collectSettingsDiagnostics(displaySettings, "interactive startup"));
	const { initialMessage, initialImages } = await prepareInitialMessage(parsed, displaySettings.getImageAutoResize());
	if (context.deprecationWarnings.length > 0) await showDeprecationWarnings(context.deprecationWarnings);
	const connector = new DaemonConnector({
		agentDir,
		startup,
		spawn: createWorkerSpawnOptions(parsed, {
			cwd,
			env: process.env,
			...(decided === undefined ? {} : { trust: decided.trusted }),
			...(requestedProfile === undefined ? {} : { profile: requestedProfile }),
		}),
		...(sessionDir === undefined ? {} : { sessionDir }),
	});
	const interactiveMode = new InteractiveMode(connector, {
		migratedProviders: context.migratedProviders,
		// The TUI reads its own settings where its conversation starts, with the trust it decided.
		settingsScope: {
			cwd: startup.cwd,
			projectTrusted,
			...(requestedProfile === undefined ? {} : { profile: requestedProfile }),
		},
		// Its host runs in a worker: the TUI keeps to its own decision for its display settings.
		projectTrust: decided ?? { cwd: startup.cwd, trusted: projectTrusted },
		autoTrustOnReloadCwd:
			parsed.projectTrustOverride === undefined && !hasTrustRequiringProjectResources(startup.cwd)
				? startup.cwd
				: undefined,
		initialMessage,
		initialImages,
		initialMessages: parsed.messages,
		...(context.requestedSessionName === undefined ? {} : { sessionName: context.requestedSessionName }),
		verbose: parsed.verbose,
		...(parsed.tuiMode !== undefined ? { tuiMode: parsed.tuiMode } : {}),
	});
	if (isTruthyEnvFlag(process.env.VOLT_STARTUP_BENCHMARK)) {
		// Startup ends once the TUI shows its conversation: attached to its worker, caught up with its log.
		await interactiveMode.init();
		time("interactiveMode.init");
		printTimings();
		interactiveMode.stop();
		await connector.dispose();
		stopThemeWatcher();
		if (process.stdout.writableLength > 0) {
			await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
		}
		if (process.stderr.writableLength > 0) {
			await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
		}
		return;
	}
	printTimings();
	await interactiveMode.run();
}

export interface MainOptions {
	extensionFactories?: ExtensionDefinition[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.VOLT_OFFLINE);
	if (offlineMode) {
		process.env.VOLT_OFFLINE = "1";
		process.env.VOLT_SKIP_VERSION_CHECK = "1";
	}

	cleanupSelfUpdateQuarantine(getPackageDir());

	const commandProfileArgs = stripCommandProfileArgs(args);
	if (commandProfileArgs.error) {
		console.error(chalk.red(`Error: ${commandProfileArgs.error}`));
		process.exitCode = 1;
		return;
	}
	const commandRuntimeOptions = {
		extensionFactories: options?.extensionFactories,
		profile:
			commandProfileArgs.profile !== undefined
				? commandProfileArgs.profile.trim() || undefined
				: process.env.VOLT_PROFILE?.trim() || undefined,
	};

	if (await handleDaemonCommand(commandProfileArgs.args)) {
		return;
	}

	if (await handleRemoteControlCommand(commandProfileArgs.args)) {
		return;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, {
		projectTrusted: false,
		profile: commandProfileArgs.profile,
	});
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	if (await handleStoreCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		return;
	}

	if (await handlePackageCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && commandProfileArgs.args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `volt update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	if (await handleConfigCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		return;
	}

	if (await handleMcpCommand(commandProfileArgs.args, commandRuntimeOptions)) {
		return;
	}

	const parsed = parseArgs(args);
	const requestedProfile = resolveRequestedProfile(parsed);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	const appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);
	validateSessionIdFlags(parsed);
	const requestedSessionName = parsed.name?.trim();
	if (parsed.name !== undefined && !requestedSessionName) {
		console.error(chalk.red("Error: --name requires a non-empty value"));
		process.exit(1);
	}

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(cwd, agentDir, { profile: requestedProfile });
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const envSessionDir = process.env[ENV_SESSION_DIR];
	const sessionDir =
		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
		startupSettingsManager.getSessionDir();
	// The interactive TUI is a client of a daemon worker: it opens no session itself.
	if (appMode === "interactive" && !parsed.help && parsed.listModels === undefined) {
		await runInteractive(parsed, {
			cwd,
			agentDir,
			sessionDir,
			startupSettingsManager,
			requestedProfile,
			requestedSessionName,
			migratedProviders,
			deprecationWarnings,
			extensionFactories: options?.extensionFactories,
		});
		return;
	}
	let initialSessionManager: SessionManager;
	try {
		initialSessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	} catch (error) {
		// Another process has the session open for writing.
		if (!(error instanceof ConversationLockedError)) throw error;
		console.error(chalk.red(`Error: ${error.message}`));
		process.exit(1);
	}
	// From this point until the host opens the startup conversation, this is the sole
	// owner/finalizer for the acquired manager; transfer relinquishes it to the host's open.
	const sessionManagerOwner = new CliSessionManagerOwner(initialSessionManager);
	let missingSessionCwdIssue: ReturnType<typeof getMissingSessionCwdIssue>;
	try {
		await restoreLocalSessionWorktree(sessionManagerOwner.current, agentDir);
		missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManagerOwner.current, cwd);
	} catch (error) {
		return await sessionManagerOwner.fail(error, "Session cwd validation failed and its manager could not be closed");
	}
	if (missingSessionCwdIssue) {
		const error = new MissingSessionCwdError(missingSessionCwdIssue);
		try {
			await sessionManagerOwner.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], "Invalid session cwd and manager close both failed");
		}
		console.error(chalk.red(error.message));
		process.exitCode = 1;
		return;
	}
	if (requestedSessionName) {
		try {
			await sessionManagerOwner.current.logWriter.appendSessionInfo(requestedSessionName);
		} catch (error) {
			return await sessionManagerOwner.fail(error, "Session naming failed and its manager could not be closed");
		}
	}
	time("createSessionManager");

	let trustStore: ProjectTrustStore;
	let sessionCwd: string;
	let trustPromptMode: AppMode;
	let resolvedExtensionPaths: string[] | undefined;
	let resolvedSkillPaths: string[] | undefined;
	let resolvedPromptTemplatePaths: string[] | undefined;
	let resolvedThemePaths: string[] | undefined;
	let authStorage: AuthStorage;
	try {
		trustStore = new ProjectTrustStore(agentDir);
		sessionCwd = sessionManagerOwner.current.getCwd();
		trustPromptMode = parsed.help || parsed.listModels !== undefined ? "print" : appMode;
		resolvedExtensionPaths = resolveCliPaths(cwd, parsed.extensions);
		resolvedSkillPaths = resolveCliPaths(cwd, parsed.skills);
		resolvedPromptTemplatePaths = resolveCliPaths(cwd, parsed.promptTemplates);
		resolvedThemePaths = resolveCliPaths(cwd, parsed.themes);
		authStorage = AuthStorage.create();
	} catch (error) {
		return await sessionManagerOwner.fail(
			error,
			"Session startup preparation failed and its manager could not be closed",
		);
	}
	const projectTrustByCwd = new Map<string, boolean>();
	// Every session this factory creates (root, subagents, replacements) shares language servers
	// and, per cwd, Git context tracking.
	const lspServerPool = new LspServerPool();
	const gitContextProviderPool = new GitContextProviderPool();
	const createRuntime: ConversationFactory = async (runtimeOptions) => {
		const { cwd, agentDir, sessionManager, sessionStartEvent, projectTrustContext, subagentContext } = runtimeOptions;
		const runtimeProfile = Object.hasOwn(runtimeOptions, "profile") ? runtimeOptions.profile : requestedProfile;
		const isInitialRuntime = sessionStartEvent === undefined;
		const projectTrustDiagnostics: AgentSessionDiagnostic[] = [];
		// Daemon-managed worktree checkouts pin trust to the PARENT checkout:
		// prompts and trust.json entries always target the parent workspace path,
		// never a path under ~/.volt/agent/worktrees (worktrees-design §5.2.1).
		// When the parent cannot be resolved, the worktree runs untrusted rather
		// than prompting for (or persisting) the worktree path.
		const worktreeParentPath = resolveWorktreeParentCheckout(agentDir, cwd);
		const trustPath = worktreeParentPath ?? (isPathUnderWorktreesRoot(agentDir, cwd) ? undefined : cwd);
		const cachedProjectTrust = trustPath === undefined ? undefined : projectTrustByCwd.get(trustPath);
		const hasTrustRequiringResources = hasTrustRequiringProjectResources(cwd);
		const shouldResolveProjectTrust =
			parsed.projectTrustOverride === undefined &&
			cachedProjectTrust === undefined &&
			hasTrustRequiringResources &&
			trustPath !== undefined;
		const projectTrusted = shouldResolveProjectTrust
			? false
			: (cachedProjectTrust ??
				parsed.projectTrustOverride ??
				(!hasTrustRequiringResources || (trustPath !== undefined && trustStore.get(trustPath) === true)));
		const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, {
			projectTrusted,
			profile: runtimeProfile,
		});
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage,
			settingsManager: runtimeSettingsManager,
			workspaceName: runtimeOptions.workspaceName,
			baseRef: runtimeOptions.baseRef,
			gitContextProviderPool,
			extensionFlagValues: parsed.unknownFlags,
			resourceLoaderReloadOptions:
				shouldResolveProjectTrust && trustPath !== undefined
					? {
							resolveProjectTrust: async ({ extensionsResult }) => {
								const trusted = await resolveProjectTrusted({
									cwd: trustPath,
									trustStore,
									trustOverride: parsed.projectTrustOverride,
									defaultProjectTrust: startupSettingsManager.getDefaultProjectTrust(),
									extensionsResult,
									projectTrustContext:
										projectTrustContext ??
										createProjectTrustContext({
											cwd: trustPath,
											mode: isInitialRuntime ? trustPromptMode : appMode,
											settingsManager: startupSettingsManager,
											hasUI: isInitialRuntime && trustPromptMode === "interactive",
										}),
									onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
								});
								projectTrustByCwd.set(trustPath, trusted);
								return trusted;
							},
						}
					: undefined,
			resourceLoaderOptions: {
				additionalExtensionPaths: resolvedExtensionPaths,
				additionalSkillPaths: resolvedSkillPaths,
				additionalPromptTemplatePaths: resolvedPromptTemplatePaths,
				additionalThemePaths: resolvedThemePaths,
				noExtensions: parsed.noExtensions,
				noSkills: parsed.noSkills,
				noPromptTemplates: parsed.noPromptTemplates,
				noThemes: parsed.noThemes,
				noContextFiles: parsed.noContextFiles,
				systemPrompt: parsed.systemPrompt,
				appendSystemPrompt: parsed.appendSystemPrompt,
				extensionFactories: options?.extensionFactories,
			},
		});
		let subagentManager: SubagentManager | undefined;
		try {
			const { settingsManager, modelRegistry, resourceLoader } = services;
			if (parsed.lsp) {
				settingsManager.applyOverrides({ lsp: { enabled: true } });
			}
			const diagnostics: AgentSessionDiagnostic[] = [
				...projectTrustDiagnostics,
				...services.diagnostics,
				...collectSettingsDiagnostics(settingsManager, "runtime creation"),
				...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
					type: "error" as const,
					message: `Failed to load extension "${path}": ${error}`,
				})),
			];

			const modelPatterns = parsed.models ?? settingsManager.getEnabledModels();
			const scopedModels =
				modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
			const hasExistingSession = sessionStartEvent?.reason !== "new" && sessionManager.getBranch().length > 0;
			const { options: sessionOptions, diagnostics: sessionOptionDiagnostics } = buildSessionOptions(
				parsed,
				scopedModels,
				hasExistingSession,
				modelRegistry,
				settingsManager,
			);
			diagnostics.push(...sessionOptionDiagnostics);

			if (parsed.apiKey) {
				if (!sessionOptions.model) {
					diagnostics.push({
						type: "error",
						message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
					});
				} else {
					authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsed.apiKey);
				}
			}

			subagentManager = new SubagentManager({
				createRuntime,
				cwd,
				agentDir,
				workspaceName: services.workspaceName,
				baseRef: services.baseRef,
				resourceLoader,
				parentSessionManager: sessionManager,
				...(subagentContext ? { subagentContext } : {}),
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: sessionOptions.model,
				thinkingLevel: sessionOptions.thinkingLevel,
				agentMode: sessionStartEvent ? undefined : sessionOptions.agentMode,
				scopedModels: sessionOptions.scopedModels,
				tools: sessionOptions.tools,
				allowUnlistedExtensionTools: sessionOptions.allowUnlistedExtensionTools,
				excludeTools: sessionOptions.excludeTools,
				noTools: sessionOptions.noTools,
				customTools: sessionOptions.customTools,
				subagentToolManager: subagentManager,
				lspServerPool,
			});

			return {
				...created,
				services,
				diagnostics,
			};
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			if (subagentManager) {
				try {
					await subagentManager.dispose();
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			}
			try {
				services.releaseGitContextProvider();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			if (cleanupErrors.length > 0) {
				throw new AggregateError(
					[error, ...cleanupErrors],
					"Agent session creation failed and untransferred CLI services could not be disposed",
				);
			}
			throw error;
		}
	};
	time("createRuntime");
	const host = new ConversationHost({ factory: createRuntime, agentDir, extensionMode: toExtensionMode(appMode) });
	const opened = await host.open({ kind: "adopt", sessionManager: sessionManagerOwner.transfer(), cwd: sessionCwd });
	if (opened.cancelled) throw new Error("Startup session open was cancelled");
	const conversation = opened.conversation;
	time("openStartupConversation");
	await runWithOwnedConversationHost(host, async (transferRuntime) => {
		const { services, session } = conversation;
		const { settingsManager, modelRegistry, resourceLoader } = services;
		applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
		configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());

		if (parsed.help) {
			const extensionFlags = resourceLoader
				.getExtensions()
				.extensions.flatMap((extension) => Array.from(extension.flags.values()));
			printHelp(extensionFlags);
			return;
		}

		if (parsed.listModels !== undefined) {
			const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
			await listModels(modelRegistry, searchPattern);
			return;
		}

		// Read piped stdin content (if any) - skip for RPC mode which uses stdin for JSON-RPC.
		const stdinContent = appMode !== "rpc" ? await readPipedStdin() : undefined;
		time("readPipedStdin");

		const { initialMessage, initialImages } = await prepareInitialMessage(
			parsed,
			settingsManager.getImageAutoResize(),
			stdinContent,
		);
		time("prepareInitialMessage");
		initTheme(settingsManager.getTheme(), false);
		time("initTheme");

		reportDiagnostics(conversation.diagnostics);
		if (conversation.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			process.exitCode = 1;
			return;
		}
		time("createAgentSession");

		if (!session.model) {
			console.error(chalk.red(formatNoModelsAvailableMessage()));
			process.exitCode = 1;
			return;
		}

		if (isTruthyEnvFlag(process.env.VOLT_STARTUP_BENCHMARK)) {
			console.error(chalk.red("Error: VOLT_STARTUP_BENCHMARK only supports interactive mode"));
			process.exitCode = 1;
			return;
		}

		printTimings();
		transferRuntime();
		if (appMode === "rpc") {
			await runRpcMode(host, conversation, {
				onReady: () => {
					void conversation.startRecoveredClientInputs().catch(() => undefined);
				},
				...(parsed.models === undefined ? {} : { modelScopePatterns: parsed.models }),
			});
			return;
		}
		const exitCode = await runPrintMode(host, conversation, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
	});
}
