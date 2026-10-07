/**
 * The conversations a worker hosts, created as the CLI creates its own: a
 * phone-opened worker's with the phone's tool policy (D9) and the project
 * trust the daemon read for it, a TUI-opened worker's from the TUI's
 * spawn-only and session-level options (Phase 7 plan §1, "Spawn"), which the
 * in-process modes' factory in `main.ts` builds from the same CLI arguments
 * (`cli/agent-options.ts`).
 *
 * A TUI-opened conversation decides its project trust here, as the CLI's
 * in-process host decided it (P7-8b): the TUI's `--approve`/`--no-approve`
 * for the project its conversation opened in; else a decision made for the
 * project before (in the conversation's group, or for the group's top-level
 * conversation in its opener's earlier conversations in this worker, the
 * TUI's session); else trusted when nothing in the project needs trust,
 * untrusted in a managed worktree whose parent checkout is unknown; else
 * resolved as its resources load: the user/global and `-e` extensions'
 * `project_trust` hooks first, then the saved decision, then
 * `defaultProjectTrust`, then the trust prompt. The top-level conversation's
 * dialogs ask the TUI whose open it is, through the daemon; a conversation a
 * client's move opens here asks that client, if local, and its decision
 * stays that conversation's; others ask nobody. A prompt closed without an
 * answer decides nothing: the conversation runs untrusted, and the next one
 * asks again. A top-level conversation whose TUI left before it answered
 * does not open.
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
import type { ProjectTrustContext } from "../../core/extensions/index.ts";
import { GitContextProviderPool } from "../../core/git-context-provider-pool.ts";
import { ConversationHost } from "../../core/host/conversation-host.ts";
import type { ConversationFactory, HostedConversation } from "../../core/host/hosted-conversation.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "../../core/http-dispatcher.ts";
import { LspServerPool } from "../../core/lsp/server-pool.ts";
import { resolveModelScope } from "../../core/model-resolver.ts";
import { decideProjectTrust, projectTrustPath, resolveConversationProjectTrust } from "../../core/project-trust.ts";
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
import { resolvePath } from "../../utils/paths.ts";
import type { WorkerAgentConfig, WorkerSessionOptions } from "../control-protocol.ts";
import {
	createSessionManagerTargetStore,
	type IrohRemoteSessionTarget,
	type ResolvedSessionTargetWithManager,
	resolveIrohRemoteSessionTarget,
} from "../session-target.ts";
import type { SessionWorktreeDaemon } from "../session-worktree.ts";

/** What a TUI opened its worker with: every conversation the worker creates is built from it. */
export interface WorkerCliOptions {
	readonly config: WorkerAgentConfig;
	readonly sessionOptions: WorkerSessionOptions;
	readonly modelScopePatterns?: readonly string[];
	/** How the conversations decide project trust where no override applies. */
	readonly trust: WorkerTrustOptions;
}

/** Where a TUI-opened conversation's project trust prompts go, and what its opener decided before. */
export interface WorkerTrustOptions {
	/** The top-level conversation's prompts in `cwd`: asked of the TUI whose open it is. */
	readonly opener: (cwd: string) => ProjectTrustContext;
	/** The project trust decided for the opener's earlier conversations in this worker, by project; written here. */
	readonly session: Map<string, boolean>;
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
	/** Whether the project in `cwd` is trusted now for the host's conversations: as decided for it, else as it holds nothing that needs trust or its saved decision. */
	readonly projectTrusted: (cwd: string) => boolean;
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
	/**
	 * The project trust decided for this host's conversations, by project: the TUI's override for the
	 * project its conversation opened in, never elsewhere, and each decision made here.
	 */
	const decisions = new Map<string, boolean>();
	const overrideProject = cli?.config.trust === undefined ? undefined : projectTrustPath(agentDir, options.cwd);
	if (overrideProject !== undefined && cli?.config.trust !== undefined)
		decisions.set(overrideProject, cli.config.trust);
	/** Whether the host opened its top-level conversation: the first conversation this factory creates. */
	let topOpened = false;
	const createRuntime: ConversationFactory = async (runtimeOptions) => {
		const top = !topOpened;
		topOpened = true;
		const profile = Object.hasOwn(runtimeOptions, "profile") ? runtimeOptions.profile : options.profile;
		// A TUI's conversation reads its settings and resources where it runs, as the CLI's do.
		const settingsCwd = cli === undefined ? projectCwd : runtimeOptions.cwd;
		const trust: ConversationTrust =
			cli === undefined
				? { trusted: projectTrusted }
				: conversationTrust(
						runtimeOptions.agentDir,
						runtimeOptions.cwd,
						decisions,
						top ? cli.trust.session : undefined,
					);
		const settingsManager = SettingsManager.create(settingsCwd, runtimeOptions.agentDir, {
			profile,
			projectTrusted: trust.trusted,
		});
		const projectTrustDiagnostics: AgentSessionDiagnostic[] = [];
		const trustPath = trust.resolve;
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
			...(cli === undefined || trustPath === undefined
				? {}
				: {
						resourceLoaderReloadOptions: {
							resolveProjectTrust: async ({ extensionsResult }) => {
								const opener = top && runtimeOptions.projectTrustContext === undefined;
								const projectTrustContext =
									runtimeOptions.projectTrustContext ??
									(opener ? cli.trust.opener(trustPath) : trustContextWithoutUI(trustPath));
								const decided = await decideProjectTrust({
									cwd: trustPath,
									resourcesCwd: runtimeOptions.cwd,
									trustStore: new ProjectTrustStore(runtimeOptions.agentDir),
									defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
									extensionsResult,
									projectTrustContext,
									onExtensionError: (message) => projectTrustDiagnostics.push({ type: "warning", message }),
								});
								// The TUI whose open this is left before it answered: nothing opens, and its next open asks again.
								if (decided === undefined && opener && !projectTrustContext.hasUI) {
									throw new Error(
										"The terminal that opened the conversation left before it answered the trust prompt",
									);
								}
								// What a client asked as its move opened a conversation decided answers for that conversation
								// only: the group's other clients (another TUI, a phone) inherit no answer they did not give.
								if (decided !== undefined && (top || runtimeOptions.projectTrustContext === undefined)) {
									decisions.set(trustPath, decided);
									if (top) cli.trust.session.set(trustPath, decided);
								}
								return decided ?? false;
							},
						},
					}),
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
			const diagnostics: AgentSessionDiagnostic[] = [...projectTrustDiagnostics, ...services.diagnostics];
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
		runtime = {
			host,
			conversation: opened.conversation,
			projectTrusted: (cwd) => resolveConversationProjectTrust(agentDir, cwd, decisions),
		};
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

/** The project trust a conversation opens with; with `resolve`, untrusted until its resources load and decide it for that project. */
interface ConversationTrust {
	readonly trusted: boolean;
	readonly resolve?: string;
}

/**
 * The project trust a TUI-opened conversation in `cwd` opens with: a
 * decision made for its project (`decisions`, else the opener's `session`
 * for a top-level conversation, which joins `decisions`), trusted when
 * nothing in it needs trust, untrusted in a managed worktree whose parent
 * checkout is unknown; else resolved as its resources load.
 */
function conversationTrust(
	agentDir: string,
	cwd: string,
	decisions: Map<string, boolean>,
	session: ReadonlyMap<string, boolean> | undefined,
): ConversationTrust {
	const trustPath = projectTrustPath(agentDir, cwd);
	const known = trustPath === undefined ? undefined : (decisions.get(trustPath) ?? session?.get(trustPath));
	if (trustPath !== undefined && known !== undefined) {
		decisions.set(trustPath, known);
		return { trusted: known };
	}
	if (!hasTrustRequiringProjectResources(cwd)) return { trusted: true };
	return trustPath === undefined ? { trusted: false } : { trusted: false, resolve: trustPath };
}

/** The trust prompts of a conversation no client asked for (a subagent's, a remote client's move): nobody answers. */
function trustContextWithoutUI(cwd: string): ProjectTrustContext {
	return {
		cwd,
		mode: "rpc",
		hasUI: false,
		ui: {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: () => {},
		},
	};
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
