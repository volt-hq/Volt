/**
 * Server-level LSP state for one project and server configuration.
 *
 * A core owns language server clients, startup ownership, start-failure
 * breakers, reviewed installs, launch caches, activity accounting, and
 * tracing. Per-session concerns (diagnostic delivery history, failure
 * reporting, host interaction, install policy) live in LspManager views; one
 * core can back several views through LspServerPool.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnProcess, spawnProcessSync } from "../../utils/child-process.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import { getSubprocessEnv } from "../../utils/process-env.ts";
import type { HostInteraction } from "../host-interaction.ts";
import { LspClient } from "./client.ts";
import { type LspLaunchDescriptor, resolveLspLaunch } from "./command-resolver.ts";
import type { LspInstallRecipe, ResolvedLspConfig, ResolvedLspServerConfig } from "./config.ts";
import { isManagedLspObservation } from "./managed-observation.ts";
import type { LspServerStatus } from "./manager.ts";
import { LspOperationError, type LspResult, lspErrorResult, lspResult, waitForLsp } from "./outcome.ts";
import { type LspLocatedExecutable, type LspToolchainLocator, toolchainLocatorFor } from "./toolchain-locator.ts";
import { LspTracer } from "./trace.ts";
import { type LspVersionProbe, LspVersionProbes } from "./version-probe.ts";
import type { LspWorkspaceEdit } from "./workspace-edit.ts";
import {
	applyWorkspaceEdit as applyWorkspaceEditToDisk,
	type WorkspaceEditApplyResult,
	type WorkspaceEditDocumentSnapshot,
} from "./workspace-edit-applier.ts";

export interface LspInstallCommandOptions {
	cwd: string;
	signal?: AbortSignal;
	onChunk?: (chunk: string) => void;
}

export interface LspInstallCommandResult {
	exitCode: number | null;
	output: string;
}

export type LspInstallRunner = (
	command: readonly string[],
	options: LspInstallCommandOptions,
) => Promise<LspInstallCommandResult>;

/** Shared start-failure breaker state for one (server, root) record. */
export interface ServerFailureState {
	count: number;
	lastError: string;
	/** Reviewed recipe that could repair the most recent failure, if it was install-eligible. */
	installRecipe?: LspInstallRecipe;
}

/** One recorded start failure. Views report the first event per failure state once. */
export interface LspStartFailureEvent {
	readonly state: ServerFailureState;
	readonly actionable: string;
}

/** A failure outcome: plain text shown every time, or a start failure each view reports once. */
export type LspFailureNotice = { readonly message: string } | { readonly event: LspStartFailureEvent };

interface ManagedLspStartup {
	promise: Promise<void>;
	failure?: LspFailureNotice;
}

export interface LspInstallAttemptResult {
	retry: boolean;
	message?: string;
	cancelled?: boolean;
	/** Successful installer; readiness is verified separately for each server root. */
	requestId?: string;
	failure?: LspResult;
}

/** Roots admitted while one recipe-scoped installer is pending. */
interface LspInstallAttempt {
	roots: Map<string, ResolvedLspServerConfig>;
	promise: Promise<Map<string, LspInstallAttemptResult>>;
}

/** The view that started an install: prompts and progress go through its current host. */
export interface LspInstallInitiator {
	host(): HostInteraction | undefined;
	installAllowed(): boolean;
}

/** Per-session view notified when shared server state changes underneath it. */
export interface LspServerCoreSubscriber {
	/** The client for key was removed or replaced; its documents and publications are gone. */
	clientReplaced(key: string): void;
	/** The current client for key closed a tracked document. */
	documentClosed(key: string, path: string): void;
	/** All clients stopped and server state was reset. */
	restarted(): void;
	/** Start-failure breakers and install prompts were reset; healthy clients kept running. */
	failuresReset(): void;
}

export interface LspServerCoreOptions {
	/** Project root and base for commands/traces. Canonicalized. */
	projectCwd: string;
	config: ResolvedLspConfig;
	installRunner?: LspInstallRunner;
}

export const MAX_START_ATTEMPTS = 3;
const LSP_INSTALL_REQUEST_TIMEOUT_MS = 10 * 60_000;
const MAX_INSTALL_OUTPUT_CHARS = 12000;

export function isPathAtOrInside(parentPath: string, candidatePath: string): boolean {
	const relativePath = relative(parentPath, candidatePath);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/** Resolve a path against base and canonicalize its existing prefix, keeping a missing suffix. */
export async function canonicalizeLspPath(
	inputPath: string,
	base: string,
): Promise<{ path: string } | { error: string }> {
	const lexicalPath = resolvePath(inputPath, base);
	let probe = lexicalPath;
	const missingSuffix: string[] = [];
	let canonicalPath: string;
	while (true) {
		try {
			canonicalPath = resolve(await realpath(probe), ...missingSuffix);
			break;
		} catch (error) {
			if (!isMissingPathError(error)) {
				return {
					error: `Could not resolve LSP path ${lexicalPath}: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			try {
				if ((await lstat(probe)).isSymbolicLink()) {
					return {
						error: `Could not resolve LSP path through a dangling symlink: ${lexicalPath}`,
					};
				}
			} catch (lstatError) {
				if (!isMissingPathError(lstatError)) {
					return {
						error: `Could not resolve LSP path ${lexicalPath}: ${lstatError instanceof Error ? lstatError.message : String(lstatError)}`,
					};
				}
			}
			const parent = dirname(probe);
			if (parent === probe) {
				return { error: `Could not resolve LSP path ${lexicalPath}` };
			}
			missingSuffix.unshift(probe.slice(parent.length + (parent.endsWith("/") || parent.endsWith("\\") ? 0 : 1)));
			probe = parent;
		}
	}
	return { path: canonicalPath };
}

export function lspServerKey(serverName: string, root: string): string {
	return `${serverName}\u0000${root}`;
}

export function installRecipeIdentity(recipe: LspInstallRecipe): string {
	return `${recipe.binary}\u0000${recipe.command.join("\u0000")}`;
}

/**
 * The reviewed recipe, targeted at the toolchain a locator checked. Undefined when
 * the locator found the server missing but no reviewed install can repair it.
 */
export function effectiveInstallRecipe(
	server: ResolvedLspServerConfig,
	launch: LspLaunchDescriptor | undefined,
): LspInstallRecipe | undefined {
	const recipe = server.installRecipe;
	const toolchain = launch?.toolchain;
	if (!recipe || toolchain?.status !== "missing") return recipe;
	if (!toolchain.installArgs) return undefined;
	const displayCommand = [recipe.displayCommand, ...toolchain.installArgs].join(" ");
	return {
		...recipe,
		command: [...recipe.command, ...toolchain.installArgs],
		displayCommand,
		installHint: `Install with: ${displayCommand}`,
	};
}

function appendBoundedOutput(current: string, chunk: string): string {
	const next = current + chunk;
	if (next.length <= MAX_INSTALL_OUTPUT_CHARS) {
		return next;
	}
	return next.slice(next.length - MAX_INSTALL_OUTPUT_CHARS);
}

function commandToDisplay(command: readonly string[]): string {
	return command.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function terminateProcessTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	try {
		if (process.platform === "win32") {
			spawnProcessSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				encoding: "utf-8",
				stdio: "ignore",
			});
		} else {
			child.kill("SIGKILL");
		}
	} catch {
		// Process already exited.
	}
}

export function runDefaultLspInstallCommand(
	command: readonly string[],
	options: LspInstallCommandOptions,
): Promise<LspInstallCommandResult> {
	if (command.length === 0) {
		return Promise.reject(new Error("LSP install command cannot be empty"));
	}
	if (options.signal?.aborted) {
		return Promise.reject(new Error("LSP server install aborted"));
	}

	return new Promise((resolve, reject) => {
		let output = "";
		let settled = false;
		const child = spawnProcess(command[0], [...command.slice(1)], {
			cwd: options.cwd,
			env: getSubprocessEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});

		const cleanup = (): void => {
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (result: LspInstallCommandResult): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			resolve(result);
		};
		const fail = (error: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			reject(error);
		};
		function onAbort(): void {
			terminateProcessTree(child);
			fail(new Error("LSP server install aborted"));
		}

		child.stdout?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			output = appendBoundedOutput(output, text);
			options.onChunk?.(text);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf-8");
			output = appendBoundedOutput(output, text);
			options.onChunk?.(text);
		});
		child.once("error", (error) => {
			fail(new Error(`Failed to run LSP install command "${commandToDisplay(command)}": ${error.message}`));
		});
		child.once("close", (code) => {
			finish({ exitCode: code, output });
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export class MissingLspExecutableError extends Error {
	readonly key: string;
	readonly launch: LspLaunchDescriptor;
	readonly reason: string;

	constructor(
		serverName: string,
		key: string,
		launch: LspLaunchDescriptor,
		projectCwd: string,
		probe?: LspVersionProbe,
	) {
		const sourceContext =
			launch.source === "path"
				? `in the inherited PATH (relative entries based at ${projectCwd})`
				: launch.source === "project-relative"
					? `relative to project workspace ${projectCwd}`
					: "at the configured absolute path";
		super(
			probe
				? `Cannot start native TypeScript LSP: ${launch.resolvedExecutable} reports ${probe.version ?? "an unknown version"}; TypeScript >=7 is required (${probe.reason}).`
				: launch.toolchain?.status === "missing"
					? `Failed to start LSP server "${serverName}": ${launch.toolchain.detail}`
					: `Failed to start LSP server "${serverName}": ${launch.requestedExecutable} was not found ${sourceContext} (ENOENT)`,
		);
		this.key = key;
		this.launch = launch;
		this.reason = probe?.reason ?? "missing-executable";
	}
}

export class UnusableLspExecutableError extends Error {
	readonly key: string;
	readonly launch: LspLaunchDescriptor;

	constructor(serverName: string, key: string, launch: LspLaunchDescriptor) {
		super(
			`Failed to start LSP server "${serverName}": ${launch.requestedExecutable} is present but not executable: ${launch.unusableExecutable ?? launch.requestedExecutable} (EACCES)`,
		);
		this.key = key;
		this.launch = launch;
	}
}

/**
 * Shared language-server state. Fields are package-internal: LspManager views
 * read and update them directly; nothing outside core/lsp should.
 */
export class LspServerCore {
	readonly projectCwd: string;
	readonly config: ResolvedLspConfig;
	readonly clients = new Map<string, LspClient>();
	readonly launches = new Map<string, LspLaunchDescriptor>();
	readonly startAttempts = new Map<string, number>();
	readonly startFailures = new Map<string, ServerFailureState>();
	readonly versions = new Map<string, string>();
	readonly startupEvidence = new Map<string, Pick<LspServerStatus, "serverInfo" | "capabilities" | "startupStderr">>();
	readonly metrics = new Map<
		string,
		{
			operations: number;
			failures: number;
			totalDurationMs: number;
			lastDurationMs: number;
			lastSuccess?: string;
			lastFailure?: string;
			requestError?: string;
		}
	>();
	readonly activeOperations = new Map<string, number>();
	readonly lastUsedAt = new Map<string, number>();
	readonly operationContext = new AsyncLocalStorage<{
		coldStartMs: number;
		managedReads: Map<LspClient, () => void>;
	}>();
	readonly installAttempts = new Map<string, LspInstallAttempt>();
	readonly installPromptsUsed = new Set<string>();
	readonly commandApplyContexts = new Map<
		LspClient,
		{ snapshots: WorkspaceEditDocumentSnapshot[]; summaries: string[]; failure?: string }
	>();
	installAbortController = new AbortController();
	/** One completion/accounting owner per client, independent of operation waiters. */
	private startups = new WeakMap<LspClient, ManagedLspStartup>();
	private versionProbes = new LspVersionProbes();
	/** Toolchain-located executables per server root; cleared on restart and after installs. */
	private toolchainLocations = new Map<string, LspLocatedExecutable>();
	private installRunner: LspInstallRunner;
	private commandQueues = new Map<LspClient, Promise<void>>();
	private subscribers = new Set<LspServerCoreSubscriber>();
	private idleTimer: NodeJS.Timeout | undefined;
	private tracer: LspTracer | undefined;
	private disposed = false;

	constructor(options: LspServerCoreOptions) {
		this.projectCwd = canonicalizePath(resolvePath(options.projectCwd));
		this.config = options.config;
		this.installRunner = options.installRunner ?? runDefaultLspInstallCommand;
		if (this.config.traceFile) {
			this.tracer = new LspTracer(resolvePath(this.config.traceFile, this.projectCwd));
		}
		if (this.config.enabled && this.config.idleShutdownMs > 0) {
			const checkIntervalMs = Math.max(250, Math.min(this.config.idleShutdownMs / 2, 60000));
			this.idleTimer = setInterval(() => this.shutdownIdleClients(), checkIntervalMs);
			this.idleTimer.unref();
		}
	}

	get isDisposed(): boolean {
		return this.disposed;
	}

	get subscriberCount(): number {
		return this.subscribers.size;
	}

	subscribe(subscriber: LspServerCoreSubscriber): () => void {
		this.subscribers.add(subscriber);
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	private notify(event: (subscriber: LspServerCoreSubscriber) => void): void {
		for (const subscriber of [...this.subscribers]) event(subscriber);
	}

	getClient(server: ResolvedLspServerConfig, root: string): LspClient {
		const key = lspServerKey(server.name, root);
		this.lastUsedAt.set(key, Date.now());
		const existing = this.clients.get(key);
		// A terminated process may still be draining startup stderr. Join its
		// owned completion rather than replacing it before failure accounting.
		if (existing?.isAlive || existing?.isStarting) {
			return existing;
		}
		existing?.dispose();
		this.clients.delete(key);
		this.notify((subscriber) => subscriber.clientReplaced(key));

		const locator = server.usesBuiltInCommand ? toolchainLocatorFor(server.command[0]) : undefined;
		const launch = resolveLspLaunch(server.command, {
			projectCwd: this.projectCwd,
			...(locator ? { toolchain: { locator: this.cachedToolchainLocator(key, locator), root } } : {}),
		});
		this.launches.set(key, launch);
		const attempt = (this.startAttempts.get(key) ?? 0) + 1;
		this.startAttempts.set(key, attempt);
		if (!launch.resolvedExecutable) {
			if (launch.unusableExecutable) {
				throw new UnusableLspExecutableError(server.name, key, launch);
			}
			throw new MissingLspExecutableError(server.name, key, launch, this.projectCwd);
		}

		if (server.name === "typescript" && server.usesBuiltInCommand) {
			const startedAt = performance.now();
			const probe = this.versionProbes.probe(launch, this.projectCwd);
			const context = this.operationContext.getStore();
			if (context) context.coldStartMs += performance.now() - startedAt;
			if (probe.version) this.versions.set(key, probe.version);
			if (!probe.compatible) throw new MissingLspExecutableError(server.name, key, launch, this.projectCwd, probe);
		}

		let clientRef!: LspClient;
		const client = new LspClient({
			serverName: server.name,
			command: launch.command,
			rootDir: root,
			environment: launch.environment,
			launchContext: {
				configuredCommand: launch.configuredCommand,
				source: launch.source,
				workspaceRoot: this.projectCwd,
				attempt,
			},
			initializationOptions: server.initializationOptions,
			settings: server.settings,
			tracer: this.tracer,
			onDocumentClosed: (path) => {
				if (this.clients.get(key) === clientRef) this.notify((subscriber) => subscriber.documentClosed(key, path));
			},
			resolveTrackedDocumentPath: async (absolutePath) => {
				const canonical = await canonicalizeLspPath(absolutePath, this.projectCwd);
				return "error" in canonical ? undefined : canonical.path;
			},
			onApplyEditRejected: (failureReason) => {
				const context = this.commandApplyContexts.get(clientRef);
				if (context) context.failure = failureReason;
			},
			onApplyEdit: async (edit) => {
				const context = this.commandApplyContexts.get(clientRef);
				const snapshots = context?.snapshots ?? clientRef.captureWorkspaceEditSnapshots();
				const result = await this.applyWorkspaceEdit(clientRef, edit as LspWorkspaceEdit, snapshots);
				if (context && !result.applied)
					context.failure = result.failureReason ?? "Server-initiated workspace edit failed";
				if (context && result.applied) {
					context.snapshots = clientRef.captureWorkspaceEditSnapshots();
				}
				if (context && result.summary) {
					context.summaries.push(result.summary);
				}
				return {
					applied: result.applied,
					failureReason: result.failureReason,
					failedChange: result.failedChange,
				};
			},
		});
		clientRef = client;
		this.clients.set(key, client);
		return client;
	}

	/** Reuse a located executable while it stays launchable and PATH still misses; misses are never cached. */
	private cachedToolchainLocator(key: string, locator: LspToolchainLocator): LspToolchainLocator {
		return {
			binary: locator.binary,
			locate: (context) => {
				const cached = this.toolchainLocations.get(key);
				if (cached && !context.pathExecutable && context.findExecutable(cached.executable) === cached.executable)
					return cached;
				const result = locator.locate(context);
				if (result.status === "found") this.toolchainLocations.set(key, result);
				else this.toolchainLocations.delete(key);
				return result;
			},
		};
	}

	async ensureStarted(
		server: ResolvedLspServerConfig,
		key: string,
		client: LspClient,
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted) throw new LspOperationError("cancelled", "aborted", "LSP operation aborted");
		const operation = this.operationContext.getStore();
		if (isManagedLspObservation() && operation && !operation.managedReads.has(client)) {
			operation.managedReads.set(client, client.acquireManagedRead());
		}
		if (client.isReady) return;
		const startedAt = performance.now();
		let startup = this.startups.get(client);
		if (!startup) {
			const owned: ManagedLspStartup = { promise: client.start() };
			this.startups.set(client, owned);
			owned.promise = owned.promise.then(
				() => {
					if (this.disposed || this.clients.get(key) !== client) return;
					this.captureStartupEvidence(key, client);
					this.startFailures.delete(key);
					// Idle time starts at completion, not at the cancelled caller's last use.
					this.lastUsedAt.set(key, Date.now());
				},
				async (error: unknown) => {
					if (!this.disposed && this.clients.get(key) === client) {
						this.captureStartupEvidence(key, client);
						owned.failure = await this.handleClientError(server, key, client, error);
					} else {
						// Restart/disposal revoked ownership. Never account against a replacement client.
						owned.failure = { message: error instanceof Error ? error.message : String(error) };
					}
					throw error;
				},
			);
			// This core-owned chain must settle even when every operation has cancelled.
			void owned.promise.catch(() => {});
			startup = owned;
		}
		// A cancelled waiter must not release read-only startup ownership while the
		// shared handshake can still issue server-to-host requests.
		if (isManagedLspObservation()) {
			const release = client.acquireManagedRead();
			void startup.promise.then(release, release);
		}
		try {
			await waitForLsp(startup.promise, signal);
		} finally {
			const context = this.operationContext.getStore();
			if (context) context.coldStartMs += performance.now() - startedAt;
		}
	}

	private captureStartupEvidence(key: string, client: LspClient): void {
		this.startupEvidence.set(key, {
			...(client.getServerInfo() ? { serverInfo: client.getServerInfo() } : {}),
			...(client.getCapabilities()
				? {
						capabilities: Object.keys(client.getCapabilities()!).filter((capability) =>
							Boolean(client.getCapabilities()![capability]),
						),
					}
				: {}),
			...(client.getStartupStderr() ? { startupStderr: client.getStartupStderr() } : {}),
		});
	}

	/** Classify a client failure and account a failed start against the breaker. */
	async handleClientError(
		server: ResolvedLspServerConfig,
		key: string,
		client: LspClient,
		error: unknown,
	): Promise<LspFailureNotice> {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof LspOperationError && error.outcome === "cancelled") return { message };
		const startupFailure = this.startups.get(client)?.failure;
		if (startupFailure) return startupFailure;
		if (client.isAlive && !client.startFailed) {
			// Request-level failure on a started, healthy server: report it without
			// counting toward the start-failure breaker.
			return { message: `lsp(${server.name}): ${message}` };
		}

		if (this.clients.get(key) !== client) return { message: this.startFailures.get(key)?.lastError ?? message };
		this.removeFailedClient(key, client);
		return { event: this.recordStartFailure(server, key, message) };
	}

	removeFailedClient(key: string, client: LspClient): void {
		// Remove and dispose the failed client (this also kills a process stuck
		// in the handshake) so the next call attempts a genuinely fresh start.
		if (this.clients.get(key) === client) {
			this.clients.delete(key);
			this.notify((subscriber) => subscriber.clientReplaced(key));
		}
		client.dispose();
	}

	recordStartFailure(
		server: ResolvedLspServerConfig,
		key: string,
		message: string,
		extraMessage?: string,
		installRecipe?: LspInstallRecipe,
	): LspStartFailureEvent {
		const launch = this.launches.get(key);
		const commandContext = launch?.resolvedExecutable
			? `Resolved executable: ${launch.resolvedExecutable}`
			: launch?.unusableExecutable
				? `Unusable executable: ${launch.unusableExecutable}`
				: `Unresolved command: ${launch?.requestedExecutable ?? server.command[0]}`;
		const sourceContext = launch ? `Launch source: ${launch.source}` : undefined;
		const repairContext = `Project workspace: ${this.projectCwd}; ${commandContext}${sourceContext ? `; ${sourceContext}` : ""}`;
		const hint =
			launch?.toolchain?.status === "missing"
				? effectiveInstallRecipe(server, launch)?.installHint
				: server.installHint;
		const explicitRepair =
			launch && !launch.bare
				? "Automatic install is unavailable for explicit paths; repair lsp.servers command configuration."
				: undefined;
		const actionable = [message, repairContext, hint, explicitRepair, extraMessage].filter(Boolean).join(". ");
		const failure = this.startFailures.get(key) ?? { count: 0, lastError: actionable };
		failure.count++;
		failure.lastError = actionable;
		failure.installRecipe = installRecipe;
		this.startFailures.set(key, failure);
		this.tracer?.log(server.name, "info", `startup failed: ${actionable}`);
		return { state: failure, actionable };
	}

	/**
	 * Join or start the recipe-scoped install for a missing server root. Returns
	 * undefined when no attempt is pending and the initiator cannot prompt or the
	 * reviewed prompt was already used.
	 */
	async installMissingServer(
		server: ResolvedLspServerConfig,
		recipe: LspInstallRecipe,
		key: string,
		initiator: LspInstallInitiator,
	): Promise<LspInstallAttemptResult | undefined> {
		const identity = installRecipeIdentity(recipe);
		let attempt = this.installAttempts.get(identity);
		if (!attempt) {
			const interaction = initiator.host();
			if (!interaction || this.installPromptsUsed.has(identity)) return undefined;

			const signal = this.installAbortController.signal;
			const roots = new Map<string, ResolvedLspServerConfig>();
			const promise = this.runInstallPrompt(server, recipe, identity, initiator, interaction, signal)
				.then(async (installResult) => {
					// Freeze the participating roots before verification. New requests use normal startup,
					// not a readiness result already being finalized for this host action.
					if (this.installAttempts.get(identity)?.promise === promise) this.installAttempts.delete(identity);
					if (this.disposed || signal.aborted) {
						// A successful installer leaves its host action open for readiness.
						// Finalize it even when cancellation wins before verification starts.
						if (installResult.requestId)
							await this.emitHostActionUpdate(initiator, {
								id: installResult.requestId,
								action: "lsp.install_server",
								status: "cancelled",
								message: "LSP install cancelled.",
								exitCode: 0,
							});
						installResult = { retry: false, cancelled: true, message: "LSP install cancelled." };
					}
					if (!installResult.retry || !installResult.requestId)
						return new Map([...roots.keys()].map((rootKey) => [rootKey, installResult]));

					this.versionProbes.clear();
					this.toolchainLocations.clear();
					const results = new Map(
						await Promise.all(
							[...roots].map(
								async ([rootKey, rootServer]) =>
									[rootKey, await this.verifyInstalledServer(rootServer, rootKey, signal)] as const,
							),
						),
					);
					const failures = [...results.values()].filter((result) => !result.retry);
					await this.emitHostActionUpdate(initiator, {
						id: installResult.requestId,
						action: "lsp.install_server",
						status: signal.aborted || this.disposed ? "cancelled" : failures.length ? "failed" : "completed",
						message: (failures.length ? failures : [...results.values()])
							.map((result) => result.message)
							.join("\n"),
						exitCode: 0,
					});
					return results;
				})
				.finally(() => {
					if (this.installAttempts.get(identity)?.promise === promise) this.installAttempts.delete(identity);
				});
			attempt = { roots, promise };
			this.installAttempts.set(identity, attempt);
		}
		attempt.roots.set(key, server);
		return (await attempt.promise).get(key)!;
	}

	/** Installation is recipe-scoped; initialization and failure accounting remain root-scoped. */
	private async verifyInstalledServer(
		server: ResolvedLspServerConfig,
		key: string,
		signal: AbortSignal,
	): Promise<LspInstallAttemptResult> {
		const root = key.split("\u0000")[1];
		let client: LspClient | undefined;
		try {
			if (signal.aborted || this.disposed) throw new Error("LSP readiness verification cancelled.");
			client = this.getClient(server, root);
			await this.ensureStarted(server, key, client, signal);
			if (signal.aborted || this.disposed || this.clients.get(key) !== client)
				throw new Error("LSP readiness verification cancelled.");
		} catch (error) {
			const cancelled = signal.aborted || this.disposed;
			const detail = error instanceof Error ? error.message : String(error);
			const recovery =
				error instanceof MissingLspExecutableError || error instanceof UnusableLspExecutableError
					? `Set lsp.servers.${server.name}.command to an explicit compatible executable path and run /reload.${server.name === "rust" ? " For rustup, start Volt with the directory containing the rust-analyzer, cargo, and rustc proxies on PATH; the rustup which binary cannot load Cargo workspaces without cargo on PATH." : ""} If the configured command becomes usable on the existing PATH, run /lsp restart. Reload/restart do not import PATH changes from another shell.`
					: `The executable resolved but initialization failed. Inspect /lsp for startup details, repair the server or project configuration, then run /lsp restart. If changing lsp.servers.${server.name}.command, run /reload.`;
			const message = cancelled
				? "LSP readiness verification cancelled."
				: `Install command succeeded, but ${server.name} language server is not ready at ${root}: ${detail}. ${recovery}`;
			if (!cancelled) {
				// ensureStarted owns handshake failure accounting; resolution failed before it could run.
				if (!client) this.recordStartFailure(server, key, message);
				const failure = this.startFailures.get(key);
				if (failure) failure.lastError = message;
			}
			const failure = cancelled
				? lspResult("cancelled", message, { reason: "aborted" })
				: error instanceof MissingLspExecutableError
					? lspResult("unavailable", message, { reason: error.reason })
					: error instanceof UnusableLspExecutableError
						? lspResult("unavailable", message, { reason: "unusable-executable" })
						: { ...lspErrorResult(error), text: message };
			return { retry: false, message, cancelled, failure };
		}
		return {
			retry: true,
			message: `${server.name} language server ready at ${root} (initialize succeeded). Retrying LSP request.`,
		};
	}

	private async runInstallPrompt(
		server: ResolvedLspServerConfig,
		recipe: LspInstallRecipe,
		identity: string,
		initiator: LspInstallInitiator,
		interaction: HostInteraction,
		signal?: AbortSignal,
	): Promise<LspInstallAttemptResult> {
		this.installPromptsUsed.add(identity);
		const requestId = `lsp-install-${randomUUID()}`;
		const decision = await interaction.requestAction(
			{
				id: requestId,
				action: "lsp.install_server",
				title: `Install ${server.name} language server?`,
				message:
					server.name === "typescript"
						? `The built-in TypeScript executable is missing or incompatible with native LSP. Install TypeScript 7.0.2? This replaces the global compiler. Alternatively set lsp.servers.typescript.command to an explicit compatible executable. Optional native dependencies are required; lifecycle scripts are disabled.`
						: `Volt tried to use LSP for ${server.name}, but ${recipe.binary} is not installed. Install it now and retry diagnostics?`,
				confirmLabel: "Install",
				cancelLabel: "Skip",
				commandPreview: recipe.displayCommand,
				blocking: true,
				destructive: server.name === "typescript",
				metadata: {
					server: server.name,
					binary: recipe.binary,
				},
				timeoutMs: LSP_INSTALL_REQUEST_TIMEOUT_MS,
			},
			{ signal },
		);

		if (decision.decision !== "approved") {
			return { retry: false, message: decision.message };
		}
		if (signal?.aborted || !initiator.installAllowed() || /^(1|true|yes)$/i.test(process.env.VOLT_OFFLINE ?? "")) {
			return { retry: false, message: "LSP install cancelled or restricted." };
		}

		await this.emitHostActionUpdate(initiator, {
			id: requestId,
			action: "lsp.install_server",
			status: "running",
			message: `Running ${recipe.displayCommand}, then verifying language server readiness.`,
		});
		let result: LspInstallCommandResult;
		try {
			result = await this.installRunner(recipe.command, { cwd: this.projectCwd, signal });
		} catch (error) {
			const message = `LSP install failed: ${error instanceof Error ? error.message : String(error)}`;
			await this.emitHostActionUpdate(initiator, {
				id: requestId,
				action: "lsp.install_server",
				status: signal?.aborted ? "cancelled" : "failed",
				message,
			});
			return { retry: false, message };
		}

		if (result.exitCode !== 0) {
			const output = result.output.trim();
			const summary = `LSP install command failed (${recipe.displayCommand}) with exit code ${result.exitCode ?? "unknown"}.`;
			const message = output ? `${summary} Output:\n${output}` : summary;
			await this.emitHostActionUpdate(initiator, {
				id: requestId,
				action: "lsp.install_server",
				status: "failed",
				message,
				exitCode: result.exitCode,
			});
			return { retry: false, message };
		}

		// The shared attempt owns readiness and cancellation updates after installer success.
		return { retry: true, requestId };
	}

	private async emitHostActionUpdate(
		initiator: LspInstallInitiator,
		update: Parameters<NonNullable<HostInteraction["updateAction"]>>[0],
	): Promise<void> {
		try {
			await initiator.host()?.updateAction?.(update);
		} catch {
			// Host action updates are advisory; do not fail the underlying LSP operation.
		}
	}

	async applyWorkspaceEdit(
		client: LspClient,
		edit: LspWorkspaceEdit,
		snapshots: readonly WorkspaceEditDocumentSnapshot[],
	): Promise<WorkspaceEditApplyResult> {
		const result = await applyWorkspaceEditToDisk({
			rootDir: this.projectCwd,
			edit,
			snapshots,
			canonicalizePath: async (absolutePath) => {
				const canonical = await canonicalizeLspPath(absolutePath, this.projectCwd);
				if ("error" in canonical) throw new Error(canonical.error);
				return canonical.path;
			},
		});
		await client.applyWorkspaceChanges(result.changes);
		return result;
	}

	async withClientCommandQueue<T>(client: LspClient, fn: () => Promise<T>): Promise<T> {
		const previous = this.commandQueues.get(client) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolveQueue) => {
			release = resolveQueue;
		});
		const queued = previous.then(() => current);
		this.commandQueues.set(client, queued);
		await previous;
		try {
			return await fn();
		} finally {
			release();
			if (this.commandQueues.get(client) === queued) {
				this.commandQueues.delete(client);
			}
		}
	}

	/** Path of the active trace file, if tracing is enabled. */
	getTraceFile(): string | undefined {
		return this.tracer?.filePath;
	}

	/** Enable or disable protocol tracing for current and future servers. */
	async setTraceFile(filePath: string | undefined): Promise<void> {
		const previousTracer = this.tracer;
		this.tracer = filePath ? new LspTracer(resolvePath(filePath, this.projectCwd)) : undefined;
		for (const client of this.clients.values()) {
			client.setTracer(this.tracer);
		}
		await previousTracer?.dispose();
	}

	/** Synchronously stop tracing during non-awaitable process teardown. */
	closeTraceSync(): void {
		const previousTracer = this.tracer;
		this.tracer = undefined;
		for (const client of this.clients.values()) {
			client.setTracer(undefined);
		}
		previousTracer?.disposeSync();
	}

	/** Dispose all running servers. They respawn lazily on next use. Returns the number stopped. */
	restart(): number {
		const count = this.clients.size;
		for (const client of this.clients.values()) {
			client.dispose();
		}
		this.clients.clear();
		this.commandQueues.clear();
		this.commandApplyContexts.clear();
		this.lastUsedAt.clear();
		this.launches.clear();
		this.startAttempts.clear();
		this.startFailures.clear();
		this.installPromptsUsed.clear();
		this.installAbortController.abort();
		this.installAbortController = new AbortController();
		this.installAttempts.clear();
		this.versionProbes.clear();
		this.toolchainLocations.clear();
		this.versions.clear();
		this.startupEvidence.clear();
		this.notify((subscriber) => subscriber.restarted());
		return count;
	}

	private shutdownIdleClients(): void {
		if (this.disposed) {
			return;
		}
		const now = Date.now();
		for (const [key, client] of [...this.clients.entries()]) {
			const lastUsed = this.lastUsedAt.get(key) ?? now;
			if (!client.isStarting && !this.activeOperations.get(key) && now - lastUsed >= this.config.idleShutdownMs) {
				client.dispose();
				this.clients.delete(key);
				this.notify((subscriber) => subscriber.clientReplaced(key));
				// Keep launch, timing and failure evidence after idle shutdown.
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.installAbortController.abort();
		this.installAttempts.clear();
		if (this.idleTimer) {
			clearInterval(this.idleTimer);
			this.idleTimer = undefined;
		}
		for (const client of this.clients.values()) {
			client.dispose();
		}
		this.clients.clear();
		this.commandQueues.clear();
		this.commandApplyContexts.clear();
		this.lastUsedAt.clear();
		this.launches.clear();
		this.startAttempts.clear();
		this.startFailures.clear();
		void this.tracer?.dispose();
		this.tracer = undefined;
	}
}

/** Ownership of one LspServerCore reference. Release is idempotent. */
export interface LspServerLease {
	readonly core: LspServerCore;
	release(): void;
}
