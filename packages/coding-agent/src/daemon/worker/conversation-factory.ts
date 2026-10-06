/**
 * The conversations a worker hosts, created as the CLI creates its own: a
 * phone-opened worker's with the phone's tool policy (D9), a TUI-opened
 * worker's from the TUI's spawn-only and session-level options (Phase 7 plan
 * §1, "Spawn"), which the in-process modes' factory in `main.ts` builds from
 * the same CLI arguments (`cli/agent-options.ts`).
 */

import { join } from "node:path";
import { buildSessionOptions } from "../../cli/agent-options.ts";
import { ENV_AGENT_DIR, getAgentDir } from "../../config.ts";
import {
	type AgentSessionDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "../../core/agent-session-services.ts";
import { formatNoModelsAvailableMessage } from "../../core/auth-guidance.ts";
import { AuthStorage } from "../../core/auth-storage.ts";
import { GitContextProviderPool } from "../../core/git-context-provider-pool.ts";
import { ConversationHost } from "../../core/host/conversation-host.ts";
import type { ConversationFactory, HostedConversation } from "../../core/host/hosted-conversation.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import { LspServerPool } from "../../core/lsp/server-pool.ts";
import { resolveModelScope } from "../../core/model-resolver.ts";
import {
	type IrohRemoteRuntimeToolPolicy,
	parseIrohRemoteAllowTools,
	usesDefaultIrohRemoteAllowTools,
} from "../../core/remote/iroh/index.ts";
import { getDefaultSessionDir, type SessionManager, type SessionReference } from "../../core/session-manager.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import {
	SubagentManager,
	type SubagentRuntimeCreatedEvent,
	type SubagentRuntimeRegistration,
} from "../../core/subagents/index.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../core/trust-manager.ts";
import { runMigrations } from "../../migrations.ts";
import { canonicalizePath, resolvePath } from "../../utils/paths.ts";
import type { WorkerAgentConfig, WorkerSessionOptions } from "../control-protocol.ts";
import {
	createSessionManagerTargetStore,
	type IrohRemoteSessionTarget,
	type ResolvedSessionTargetWithManager,
	resolveIrohRemoteSessionTarget,
} from "../session-target.ts";
import type { SessionWorktreeDaemon } from "../session-worktree.ts";
import { isPathUnderWorktreesRoot, resolveWorktreeParentCheckout } from "../worktree-manager.ts";

/** What a TUI opened its worker with: every conversation the worker creates is built from it. */
export interface WorkerCliOptions {
	readonly config: WorkerAgentConfig;
	readonly sessionOptions: WorkerSessionOptions;
	readonly modelScopePatterns?: readonly string[];
}

/**
 * Where a conversation in `cwd` takes its project trust from: the parent
 * checkout of a managed worktree, and none for one whose parent is unknown
 * (worktrees-design §5.2.1).
 */
function projectTrustPath(agentDir: string, cwd: string): string | undefined {
	const path =
		resolveWorktreeParentCheckout(agentDir, cwd) ?? (isPathUnderWorktreesRoot(agentDir, cwd) ? undefined : cwd);
	return path === undefined ? undefined : canonicalizePath(resolvePath(path));
}

/**
 * The project trust of a conversation in `cwd`: the decision its opener (a
 * TUI) made for the project it opened in, `decided`, applies to that project
 * only; elsewhere, and without one, a project without resources that need
 * trust is trusted, and one with them is trusted only by its saved decision.
 * Read again whenever it matters: a project that had nothing to trust may
 * gain it.
 */
export function resolveWorkerProjectTrust(
	agentDir: string,
	cwd: string,
	decided: { readonly cwd: string; readonly trusted: boolean } | undefined,
): boolean {
	const trustPath = projectTrustPath(agentDir, cwd);
	if (decided !== undefined && trustPath !== undefined && trustPath === projectTrustPath(agentDir, decided.cwd)) {
		return decided.trusted;
	}
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	return trustPath !== undefined && new ProjectTrustStore(agentDir).get(trustPath) === true;
}

export interface IrohRemoteAgentRuntimeOptions {
	/** Legacy unresolved grant used by direct callers. Daemon runtimes pass toolPolicy instead. */
	allowTools?: string;
	/** Pre-composed client/workspace/daemon policy. Preserves an explicit deny-all. */
	toolPolicy?: IrohRemoteRuntimeToolPolicy;
	agentDir?: string;
	conversationTarget?: IrohRemoteAgentRuntimeConversationTarget;
	/** Runtime working directory for tools/session state. */
	cwd: string;
	/** Project/config root for .volt resources. Defaults to cwd. */
	projectCwd?: string;
	/** Host-owned workspace display name for Git context. */
	workspaceName?: string;
	/** Trusted managed-worktree base ref for Git context. */
	baseRef?: string;
	onSubagentRuntimeCreated?: (
		event: IrohRemoteSubagentRuntimeCreatedEvent,
	) => SubagentRuntimeRegistration | Promise<SubagentRuntimeRegistration> | Promise<void> | void;
	profile?: string;
	projectTrusted?: boolean;
	/**
	 * Pre-resolved session target (daemon path); skips internal target resolution.
	 * The runtime factory consumes its manager and preserves every committed row on failure.
	 */
	resolvedSessionTarget?: ResolvedSessionTargetWithManager<SessionManager>;
	resumeSessionId?: string;
	sessionDir?: string;
	/** Validate the resolved session cwd before services/tools are created. */
	validateCwd?: (cwd: string) => Promise<void> | void;
	/** The worker's route to its daemon for managed checkouts. */
	worktreeDaemon?: SessionWorktreeDaemon;
	/** A TUI-opened worker's options, in place of a phone's `toolPolicy`. */
	cli?: WorkerCliOptions;
}

export interface IrohRemoteSubagentRuntimeCreatedEvent extends SubagentRuntimeCreatedEvent {
	parentSessionId: string;
	parentSessionRef?: SessionReference;
}

export type IrohRemoteAgentRuntimeConversationTarget =
	| {
			target: "last";
			resumeSessionId?: string;
	  }
	| {
			target: "new";
			sessionId?: string;
	  }
	| {
			target: "session";
			sessionId: string;
	  };

export type IrohRemoteAgentRuntimeSessionSelection =
	| {
			kind: "created";
			sessionRef?: SessionReference;
			sessionId: string;
	  }
	| {
			kind: "created_after_missing";
			requestedSessionId: string;
			sessionRef?: SessionReference;
			sessionId: string;
	  }
	| {
			kind: "resumed";
			requestedSessionId: string;
			sessionRef?: SessionReference;
			sessionId: string;
	  };

/**
 * A conversation the daemon hosts, in the host it opened in. The host keeps
 * its conversations open until the daemon closes them; conversations a phone's
 * structural intents open come from the same host.
 */
export interface IrohRemoteAgentRuntime {
	readonly host: ConversationHost;
	readonly conversation: HostedConversation;
}

export interface IrohRemoteAgentRuntimeResult {
	runtime: IrohRemoteAgentRuntime;
	sessionSelection: IrohRemoteAgentRuntimeSessionSelection;
}

export async function createIrohRemoteAgentRuntime(
	options: IrohRemoteAgentRuntimeOptions,
): Promise<IrohRemoteAgentRuntime> {
	return (await createIrohRemoteAgentRuntimeWithSessionSelection(options)).runtime;
}

export async function createIrohRemoteAgentRuntimeWithSessionSelection(
	options: IrohRemoteAgentRuntimeOptions,
): Promise<IrohRemoteAgentRuntimeResult> {
	const suppliedSessionManager = options.resolvedSessionTarget?.sessionManager;
	const { agentDir, projectCwd, authStorage, tools, allowUnlistedExtensionTools, projectTrusted } =
		await (async () => {
			try {
				const agentDir = resolvePath(options.agentDir ?? getAgentDir());
				const projectCwd = resolvePath(options.projectCwd ?? options.cwd);
				runIrohRemoteStartupMigrations(projectCwd, agentDir);
				const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
				const tools = options.toolPolicy
					? [...options.toolPolicy.tools]
					: parseIrohRemoteAllowTools(options.allowTools);
				const allowUnlistedExtensionTools =
					options.toolPolicy?.allowUnlistedExtensionTools ?? usesDefaultIrohRemoteAllowTools(options.allowTools);
				return {
					agentDir,
					projectCwd,
					authStorage,
					tools,
					allowUnlistedExtensionTools,
					projectTrusted: options.projectTrusted ?? false,
				};
			} catch (error) {
				return cleanupFailedIrohRemoteAgentRuntime(error, undefined, suppliedSessionManager);
			}
		})();

	// Sessions of this attach (root, subagents, replacements) share language servers and,
	// per cwd, Git context tracking.
	const lspServerPool = new LspServerPool();
	const gitContextProviderPool = new GitContextProviderPool();
	const cli = options.cli;
	// The TUI's decision is for the project its first conversation opened in.
	const decidedTrust = cli?.config.trust === undefined ? undefined : { cwd: options.cwd, trusted: cli.config.trust };
	const createRuntime: ConversationFactory = async (runtimeOptions) => {
		const profile = Object.hasOwn(runtimeOptions, "profile") ? runtimeOptions.profile : options.profile;
		// A TUI's conversation reads its settings and resources where it runs, as the CLI's do.
		const settingsCwd = cli === undefined ? projectCwd : runtimeOptions.cwd;
		const settingsManager = SettingsManager.create(settingsCwd, runtimeOptions.agentDir, {
			profile,
			projectTrusted:
				cli === undefined
					? projectTrusted
					: resolveWorkerProjectTrust(runtimeOptions.agentDir, runtimeOptions.cwd, decidedTrust),
		});
		applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
		configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
		const services = await createAgentSessionServices({
			authStorage,
			cwd: runtimeOptions.cwd,
			projectCwd: settingsCwd,
			agentDir: runtimeOptions.agentDir,
			settingsManager,
			workspaceName: runtimeOptions.workspaceName ?? options.workspaceName,
			baseRef: runtimeOptions.baseRef ?? options.baseRef,
			gitContextProviderPool,
			...(cli === undefined
				? {}
				: {
						// `registerFlag` values from the TUI's arguments.
						extensionFlagValues: new Map(Object.entries(cli.config.flags ?? {})),
						resourceLoaderOptions: {
							additionalExtensionPaths: cli.config.extensions,
							additionalSkillPaths: cli.config.skills,
							additionalPromptTemplatePaths: cli.config.promptTemplates,
							additionalThemePaths: cli.config.themes,
							noExtensions: cli.config.noExtensions,
							noSkills: cli.config.noSkills,
							noPromptTemplates: cli.config.noPromptTemplates,
							noThemes: cli.config.noThemes,
							noContextFiles: cli.config.noContextFiles,
							systemPrompt: cli.config.systemPrompt,
							appendSystemPrompt: cli.config.appendSystemPrompt,
						},
					}),
		});
		const subagentManager = new SubagentManager({
			createRuntime,
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			workspaceName: services.workspaceName,
			baseRef: services.baseRef,
			resourceLoader: services.resourceLoader,
			parentSessionManager: runtimeOptions.sessionManager,
			...(runtimeOptions.subagentContext ? { subagentContext: runtimeOptions.subagentContext } : {}),
			retainRuntimeOnDispose: options.onSubagentRuntimeCreated !== undefined,
			...(options.worktreeDaemon === undefined ? {} : { worktreeDaemon: options.worktreeDaemon }),
			onRuntimeCreated: options.onSubagentRuntimeCreated
				? (event) =>
						options.onSubagentRuntimeCreated?.({
							...event,
							parentSessionId: runtimeOptions.sessionManager.getSessionId(),
							...(runtimeOptions.sessionManager.getSessionRef() === undefined
								? {}
								: { parentSessionRef: runtimeOptions.sessionManager.getSessionRef() }),
						})
				: undefined,
		});
		try {
			const diagnostics: AgentSessionDiagnostic[] = [...services.diagnostics];
			let created: Awaited<ReturnType<typeof createAgentSessionFromServices>>;
			if (cli === undefined) {
				created = await createAgentSessionFromServices({
					services,
					sessionManager: runtimeOptions.sessionManager,
					sessionStartEvent: runtimeOptions.sessionStartEvent,
					tools,
					allowUnlistedExtensionTools,
					subagentToolManager: subagentManager,
					lspServerPool,
				});
			} else {
				const { modelRegistry, resourceLoader } = services;
				if (cli.config.lsp) settingsManager.applyOverrides({ lsp: { enabled: true } });
				// As the CLI fails to start, an extension that does not load fails the open.
				diagnostics.push(
					...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
						type: "error" as const,
						message: `Failed to load extension "${path}": ${error}`,
					})),
				);
				const modelPatterns = cli.modelScopePatterns ?? settingsManager.getEnabledModels();
				const scopedModels =
					modelPatterns && modelPatterns.length > 0
						? await resolveModelScope([...modelPatterns], modelRegistry)
						: [];
				const { sessionStartEvent, sessionManager } = runtimeOptions;
				const hasExistingSession = sessionStartEvent?.reason !== "new" && sessionManager.getBranch().length > 0;
				const built = buildSessionOptions(
					{ ...cli.config, ...cli.sessionOptions },
					scopedModels,
					hasExistingSession,
					modelRegistry,
					settingsManager,
				);
				diagnostics.push(...built.diagnostics);
				const sessionOptions = built.options;
				if (cli.config.apiKey !== undefined) {
					if (sessionOptions.model) authStorage.setRuntimeApiKey(sessionOptions.model.provider, cli.config.apiKey);
					else {
						diagnostics.push({
							type: "error",
							message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
						});
					}
				}
				created = await createAgentSessionFromServices({
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
					subagentToolManager: subagentManager,
					lspServerPool,
				});
			}
			return {
				...created,
				services,
				diagnostics,
			};
		} catch (error) {
			const cleanupErrors: unknown[] = [];
			try {
				await subagentManager.dispose();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			try {
				services.releaseGitContextProvider();
			} catch (cleanupError) {
				cleanupErrors.push(cleanupError);
			}
			if (cleanupErrors.length > 0) {
				throw new AggregateError(
					[error, ...cleanupErrors],
					"Remote agent session creation failed and its untransferred services could not be disposed",
				);
			}
			throw error;
		}
	};

	let sessionTarget: Awaited<ReturnType<typeof createIrohRemoteSessionManager>>;
	try {
		sessionTarget = await createIrohRemoteSessionManager(options, agentDir);
	} catch (error) {
		return cleanupFailedIrohRemoteAgentRuntime(error, undefined, suppliedSessionManager);
	}
	let runtime: IrohRemoteAgentRuntime | undefined;
	let managerTransferred = false;
	try {
		const runtimeCwd = sessionTarget.sessionManager.getCwd();
		await options.validateCwd?.(runtimeCwd);
		managerTransferred = true;
		// Phones attach as clients; the daemon closes each conversation itself.
		const host = new ConversationHost({
			factory: createRuntime,
			agentDir,
			extensionMode: "rpc",
			whenUnattached: "keep",
			...(options.worktreeDaemon === undefined ? {} : { worktreeDaemon: options.worktreeDaemon }),
		});
		const opened = await host.open(
			{ kind: "adopt", sessionManager: sessionTarget.sessionManager, cwd: runtimeCwd },
			{ profile: options.profile },
		);
		if (opened.cancelled) throw new Error("Remote conversation open was cancelled");
		runtime = { host, conversation: opened.conversation };
		const errors = opened.conversation.diagnostics.filter((diagnostic) => diagnostic.type === "error");
		if (errors.length > 0) {
			throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
		}
		// A TUI opens without a model, as the CLI starts without one: its user logs in first.
		if (cli === undefined && !opened.conversation.session.model) {
			throw new Error(formatNoModelsAvailableMessage());
		}
		return { runtime, sessionSelection: sessionTarget.selection };
	} catch (error) {
		return cleanupFailedIrohRemoteAgentRuntime(
			error,
			runtime,
			managerTransferred ? undefined : sessionTarget.sessionManager,
		);
	}
}

async function cleanupFailedIrohRemoteAgentRuntime(
	error: unknown,
	runtime: IrohRemoteAgentRuntime | undefined,
	ownedSessionManager: SessionManager | undefined,
): Promise<never> {
	const cleanupErrors: unknown[] = [];
	if (runtime) {
		try {
			await runtime.host.close(runtime.conversation);
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
	} else if (ownedSessionManager) {
		try {
			await ownedSessionManager.closePersistence();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
	}
	if (cleanupErrors.length === 0) throw error;

	const aggregate = new AggregateError(
		[error, ...cleanupErrors],
		error instanceof Error ? error.message : String(error),
	);
	if (typeof error === "object" && error !== null) {
		const metadata = error as {
			outcome?: unknown;
			retryAfterMs?: unknown;
			sessionId?: unknown;
			workspace?: unknown;
		};
		Object.assign(aggregate, {
			...(typeof metadata.outcome === "string" ? { outcome: metadata.outcome } : {}),
			...(typeof metadata.retryAfterMs === "number" ? { retryAfterMs: metadata.retryAfterMs } : {}),
			...(typeof metadata.sessionId === "string" ? { sessionId: metadata.sessionId } : {}),
			...(typeof metadata.workspace === "string" ? { workspace: metadata.workspace } : {}),
		});
	}
	throw aggregate;
}

async function createIrohRemoteSessionManager(
	options: IrohRemoteAgentRuntimeOptions,
	agentDir: string,
): Promise<{ sessionManager: SessionManager; selection: IrohRemoteAgentRuntimeSessionSelection }> {
	const resolved =
		options.resolvedSessionTarget ??
		(await resolveIrohRemoteSessionTarget(
			getSessionTarget(options),
			{ name: "", path: options.cwd },
			createSessionManagerTargetStore(
				options.cwd,
				options.sessionDir ?? getDefaultSessionDir(options.projectCwd ?? options.cwd, agentDir),
				{ listAll: true, preserveSessionCwd: true },
			),
		));
	return {
		sessionManager: resolved.sessionManager,
		selection: toSessionSelection(resolved),
	};
}

function toSessionSelection(
	resolved: ResolvedSessionTargetWithManager<SessionManager>,
): IrohRemoteAgentRuntimeSessionSelection {
	if (resolved.selection === "created") {
		return {
			kind: "created",
			...(resolved.sessionRef === undefined ? {} : { sessionRef: resolved.sessionRef }),
			sessionId: resolved.sessionId,
		};
	}
	return {
		kind: resolved.selection,
		requestedSessionId: resolved.requestedSessionId ?? resolved.sessionId,
		...(resolved.sessionRef === undefined ? {} : { sessionRef: resolved.sessionRef }),
		sessionId: resolved.sessionId,
	};
}

function getSessionTarget(options: IrohRemoteAgentRuntimeOptions): IrohRemoteSessionTarget {
	const target = getConversationTarget(options);
	if (target.target === "last") {
		return target.resumeSessionId === undefined
			? { kind: "last" }
			: { kind: "last", resumeSessionId: target.resumeSessionId };
	}
	if (target.target === "session") {
		return { kind: "session", sessionId: target.sessionId };
	}
	return target.sessionId === undefined ? { kind: "last" } : { kind: "new", sessionId: target.sessionId };
}

function getConversationTarget(options: IrohRemoteAgentRuntimeOptions): IrohRemoteAgentRuntimeConversationTarget {
	if (options.conversationTarget !== undefined) {
		return options.conversationTarget;
	}
	if (options.resumeSessionId !== undefined) {
		return { target: "last", resumeSessionId: options.resumeSessionId };
	}
	return { target: "new" };
}

function runIrohRemoteStartupMigrations(cwd: string, agentDir: string): void {
	const previousAgentDir = process.env[ENV_AGENT_DIR];
	const previousLog = console.log;
	try {
		process.env[ENV_AGENT_DIR] = agentDir;
		console.log = (...data: Parameters<typeof console.log>) => console.error(...data);
		runMigrations(cwd);
	} finally {
		console.log = previousLog;
		if (previousAgentDir === undefined) {
			delete process.env[ENV_AGENT_DIR];
		} else {
			process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	}
}
