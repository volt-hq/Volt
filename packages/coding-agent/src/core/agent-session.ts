/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import type {
	AgentAbortSource,
	AgentEvent,
	AgentMessage,
	AgentTool,
	ConversationOperationKind,
	ConversationStreamOptions,
	PendingToolExecution,
	StreamFn,
	ThinkingLevel,
} from "@hansjm10/volt-agent-core";
import { AdmissionGate, Conversation, type ConversationLog } from "@hansjm10/volt-agent-core";
import type { ImageContent, Message, Model, PromptCacheRefresher, TextContent } from "@hansjm10/volt-ai";
import type { WorkNoticeDetails } from "@hansjm10/volt-protocol/entries";
import type { RpcGitContext } from "@hansjm10/volt-protocol/git-context";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import { BackgroundJobDiagnostics } from "./background-job-diagnostics.ts";
import type { BashResult } from "./bash-executor.ts";
import { cloneCanonicalData } from "./canonical-data.ts";
import type { CompactionResult } from "./compaction/index.ts";
import type {
	ContextUsage,
	ExtensionRunner,
	InputSource,
	ReplacedSessionContext,
	SessionStartEvent,
	ToolDefinition,
	ToolInfo,
} from "./extensions/index.ts";
import type { PolicyRegistration } from "./extensions/policy-registration.ts";
import type { ExtensionServicesLimits } from "./extensions/services-types.ts";
import { GitContextProvider } from "./git-context-provider.ts";
import { ClientScope } from "./host/client-scope.ts";
import { LiveState } from "./host/live-state.ts";
import type { LspServerStatus } from "./lsp/manager.ts";
import type { LspServerPool } from "./lsp/server-pool.ts";
import type { McpManager } from "./mcp/manager.ts";
import type { McpManagerEvent } from "./mcp/types.ts";
import { type CustomMessageInput, withoutClientMessageId } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { Personality } from "./personality.ts";
import type { AgentMode, PlanExecution, PlanningState, PlanState, PlanStepStatus } from "./planning.ts";
import type { PromptCacheStatus } from "./prompt-cache-status.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import { reviewWorkKind } from "./review-work.ts";
import { SessionBash } from "./session/bash.ts";
import { SessionClientInputs } from "./session/client-inputs.ts";
import { SessionCompaction } from "./session/compaction.ts";
import { SessionEvents } from "./session/events.ts";
import {
	type ExtensionClient,
	type ExtensionClientAttachment,
	SessionExtensionBinding,
} from "./session/extension-binding.ts";
import { SessionExtensionServices } from "./session/extension-services.ts";
import { HOST_ACTION_WORK_KIND, type HostActions, SessionHostActions } from "./session/host-actions.ts";
import { SessionJobs } from "./session/jobs.ts";
import { SessionLifecycle } from "./session/lifecycle.ts";
import { type DefaultPersistenceOptions, ModelSettings } from "./session/model-settings.ts";
import { type NavigateTreeOptions, type NavigateTreeResult, SessionNavigation } from "./session/navigation.ts";
import { SessionPlanning } from "./session/planning.ts";
import { SessionPromptCache } from "./session/prompt-cache.ts";
import { SessionPrompting } from "./session/prompting.ts";
import { SessionProviderStream } from "./session/provider-stream.ts";
import { SessionRetry } from "./session/retry-policy.ts";
import { exportSessionToJsonl, SessionInfo } from "./session/session-info.ts";
import { SessionToolRuntime } from "./session/tool-runtime.ts";
import {
	type NextActionPolicy,
	SessionTurnPolicy,
	type ToolCallDecision,
	type TurnToolCall,
} from "./session/turn-policy.ts";
import { PRODUCT_SESSION_ENTRY_TYPES } from "./session-entry-types.ts";
import type { SessionManager, SessionReference } from "./session-manager.ts";
import { ConversationSessionWriter, type SessionWriter } from "./session-writer.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { ToolProgressDiagnostics } from "./tool-progress-diagnostics.ts";
import type { BashOperations } from "./tools/bash.ts";
import type { SubagentToolManager } from "./tools/index.ts";
import type { JobSource } from "./tools/jobs.ts";
import type { PlanStepInput } from "./tools/planning.ts";
import { ExtensionKinds } from "./work/extension-kinds.ts";
import { WorkRegistry } from "./work/registry.ts";

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface ActiveAgentRun {
	/** Unix epoch milliseconds when the logical operation started, retained through recovery until settlement. */
	startedAt: number;
}

export interface ActiveCompaction {
	reason: CompactionReason;
	startedAt: number;
}

/**
 * One user input waiting in the conversation's durable queue: its client
 * input identity and its queued text. Input that arrived without an identity
 * (local TUI, SDK, and extension input) carries the one the session gave it.
 */
export interface AgentSessionQueuedMessage {
	readonly clientMessageId: string;
	readonly text: string;
}

/** A runtime message as providers see it: a client user message without its client input identity. */
function withoutClientIdentity(message: AgentMessage): AgentMessage {
	return message.role === "user" && "clientMessageId" in message ? withoutClientMessageId(message) : message;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_start" | "agent_end" }>
	| {
			type: "agent_start";
			/** Host-authoritative Unix epoch milliseconds for elapsed-time presentation. */
			startedAt: number;
	  }
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| {
			/**
			 * Emitted once tracked prompt work fully settles. When an agent run starts,
			 * this follows its final `agent_end` plus any automatic retries,
			 * overflow/threshold compaction, and queued-message continuations.
			 * Equivalent to `waitForIdle()` resolving for that work.
			 */
			type: "agent_settled";
	  }
	| {
			type: "queue_update";
			steering: readonly AgentSessionQueuedMessage[];
			followUp: readonly AgentSessionQueuedMessage[];
			/** Notices of finished work the next turn takes. */
			notices: readonly WorkNoticeDetails[];
	  }
	| {
			type: "client_input_outcome";
			clientMessageId: string;
			outcome: "failed";
			reason: "queue_cleared" | "dispatch_failed";
	  }
	| { type: "compaction_start"; reason: CompactionReason }
	| { type: "session_info_changed"; name?: string }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "planning_state_changed"; planning: PlanningState }
	| { type: "git_context_changed"; gitContext: RpcGitContext | null }
	| { type: "prompt_cache_changed"; promptCache: PromptCacheStatus | null }
	| { type: "fast_mode_changed"; enabled: boolean }
	| {
			type: "compaction_end";
			reason: CompactionReason;
			result?: CompactionResult;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| McpManagerEvent;

/** Passive observer of agent session events. Async implementations are observed but do not delay session work. */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

/**
 * A committed change to the conversation generation.
 *
 * Unlike SessionManager's low-level leaf notification, this fires only after
 * the active leaf and Agent message context describe the same branch.
 */
export interface ConversationGenerationChange {
	previousLeafId: string | null;
	nextLeafId: string | null;
}

export type ConversationGenerationListener = (change: ConversationGenerationChange) => void;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	/** The session the agent runs: its log becomes the conversation's log while the agent session is open. */
	sessionManager: SessionManager;
	/**
	 * The model to run: committed as a model change when the session's branch
	 * names another one. Model and thinking level otherwise come from the log.
	 */
	model?: Model<any>;
	/** The thinking level to run, committed when the branch has another one. */
	thinkingLevel?: ThinkingLevel;
	streamFn: StreamFn;
	/** No-output replay of `streamFn` requests; enables prompt-cache keepalive when the model supports it. */
	promptCacheRefresh?: PromptCacheRefresher;
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	streamOptions?: ConversationStreamOptions;
	/** Optional managed extension-services limits; may only tighten the host ceilings. */
	extensionServicesLimits?: Partial<ExtensionServicesLimits>;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	settingsManager: SettingsManager;
	gitContextProvider?: GitContextProvider;
	/** Called instead of disposing a supplied `gitContextProvider` on disposal (e.g. to release a pooled provider). */
	releaseGitContextProvider?: () => void;
	cwd: string;
	/** Project/config root and hard LSP workspace boundary. Defaults to cwd. */
	projectCwd?: string;
	/** Global config directory used for session-owned artifacts. Default: ~/.volt/agent */
	agentDir?: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition<any, any>[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: read, bash, edit, write, web_search, and subagent when a manager is supplied. */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Allow extension and SDK custom tools even when they are absent from allowedToolNames. */
	allowUnlistedExtensionTools?: boolean;
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Optional manager enabling the built-in subagent tool when selected. */
	subagentToolManager?: SubagentToolManager;
	/** Optional manager enabling the native MCP gateway tool when configured. */
	mcpManager?: McpManager;
	/** Factory used to rebuild the default MCP manager on session reload. */
	mcpManagerFactory?: () => Promise<McpManager | undefined> | McpManager | undefined;
	/** Language servers shared with other sessions of the same delegation tree. Private per session when omitted. */
	lspServerPool?: LspServerPool;
}

/** AgentSession runtime projection. A model is optional until one is selected. */
export interface AgentSessionState {
	readonly systemPrompt: string;
	readonly model: Model<any> | undefined;
	readonly thinkingLevel: ThinkingLevel;
	readonly tools: readonly AgentTool[];
	readonly messages: readonly AgentMessage[];
	readonly isStreaming: boolean;
	readonly streamingMessage: AgentMessage | undefined;
	readonly pendingToolCalls: ReadonlySet<string>;
	readonly pendingToolExecutions: ReadonlyMap<string, PendingToolExecution>;
	readonly errorMessage: string | undefined;
}

/** Options for AgentSession.prompt() */
export type PromptAdmissionOutcome = "admitted" | "completed";

export type PromptPreflightResult = { success: true; outcome: PromptAdmissionOutcome } | { success: false };

export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Stable remote-client identity persisted with the resulting user message. */
	clientMessageId?: string;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (result: PromptPreflightResult) => void;
	/**
	 * Internal mutation lease asserted at async preflight boundaries.
	 *
	 * Remote callers use this to prove the conversation generation they targeted
	 * is still current before prompt admission can mutate durable branch state.
	 */
	assertConversationGenerationCurrent?: () => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Lifetime session statistics for /session and RPC consumers. */
export interface SessionStats {
	sessionRef: SessionReference | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	/** Current retained model context, separate from lifetime token totals. */
	contextUsage?: ContextUsage;
}

export interface AgentSessionTurnPolicy {
	beforeToolCall?: (
		event: TurnToolCall,
		signal: AbortSignal,
	) => ToolCallDecision | undefined | Promise<ToolCallDecision | undefined>;
	nextAction?: NextActionPolicy;
}

/** @internal Preserves the primary constructor failure and every synchronous rollback failure. */
export class AgentSessionConstructionCleanupError extends AggregateError {}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly gitContextProvider: GitContextProvider;
	/**
	 * The conversation's live state: extension status, widgets, and title,
	 * dialogs, approvals, and MCP authorization flows, the run phase, and
	 * what streams, which every attached client sees. Its changes build on the
	 * log position. Disposing the session closes it.
	 */
	readonly liveState: LiveState = new LiveState({ head: () => this.sessionManager.getOrdinal() });
	private readonly _activityListeners = new Set<() => void>();
	private readonly _reloadListeners = new Set<() => void>();
	private readonly _releaseGitContextProvider: () => void;

	/** The conversation kernel this session runs on, over its session manager's log. */
	private _conversation!: Conversation<AgentTool>;
	/** The log the conversation writes, held from `takeLog` until the conversation closes it. */
	private _log: ConversationLog | undefined;
	/** Writes of this session's log through its conversation. */
	private _sessionWriter!: SessionWriter;
	private readonly _streamFn: StreamFn;
	private readonly _toolProgressDiagnostics: ToolProgressDiagnostics;
	private readonly _diagnostics: BackgroundJobDiagnostics;
	private readonly _providerStream: SessionProviderStream;
	private readonly _promptCache: SessionPromptCache;
	private readonly _modelSettings: ModelSettings;
	private readonly _retry: SessionRetry;
	private readonly _bash: SessionBash;
	private readonly _sessionInfo: SessionInfo;
	private readonly _lifecycle: SessionLifecycle;
	private readonly _tools: SessionToolRuntime;
	private readonly _extensions: SessionExtensionBinding;
	private readonly _turnPolicy: SessionTurnPolicy;
	private readonly _jobs: SessionJobs;
	private readonly _events: SessionEvents;
	private readonly _clientInputs: SessionClientInputs;
	private readonly _prompting: SessionPrompting;
	private readonly _planning: SessionPlanning;
	private readonly _compaction: SessionCompaction;
	private readonly _navigation: SessionNavigation;

	private readonly _convertToLlm: AgentSessionConfig["convertToLlm"];

	// Event subscription state
	private _unsubscribeConversation?: () => void;
	private _unsubscribeSessionEntries?: () => void;
	private _unsubscribeGitContext?: () => void;
	/** Nonexclusive admitted continuations that must settle before runtime resources close. */
	private readonly _admittedAncillaryWork = new Set<Promise<unknown>>();
	/** Prompt/preflight work is detached during replacement to avoid ctx.newSession self-joins. */
	private readonly _admittedPromptWork = new Set<Promise<unknown>>();
	private _activityRevision = 0;
	/** One admission authority for foreground operations, native tools, and background jobs. */
	private readonly _admissionGate = new AdmissionGate();
	/** Preflight continuations retain the same revision that fences low-level reservations. */
	private get _abortGeneration(): number {
		return this._admissionGate.revision;
	}
	private _abortPromise: Promise<void> | undefined;
	/** Whether the in-flight stop starts retained queued input once it settles; joined stops can only decline. */
	private _abortQueueDelivery: { requested: boolean } | undefined;

	/**
	 * The conversation's work (RFC §7): its kinds, the executors of the work
	 * this runtime runs, and the cancel, resume, and open paths every client
	 * shares. Work outlives individual turns; closing the session stops it.
	 */
	private readonly _work: WorkRegistry = new WorkRegistry({
		conversationId: () => this.sessionId,
		work: () => this._conversation.work,
		state: () => this.sessionManager.getConversationState(),
		live: () => this.liveState,
		turnId: () => this._turnId,
		runningChanged: () => {
			this._activityChanged();
			this._jobs.runtime.changed();
		},
	});
	/** Host actions (an LSP server install) wait in the live state for a client's approval, then run as `host_action` work. */
	private readonly _hostActions = new SessionHostActions({ liveState: this.liveState, work: () => this._work });
	/** The work kinds the extensions declare, registered while their runner generation is current. */
	private readonly _extensionKinds = new ExtensionKinds(() => this._work);

	// Extension system
	private _extensionServices!: SessionExtensionServices;
	/** Aborted when the session loses its log or is disposed; command handlers see it as `ctx.signal`. */
	private readonly _lifetimeAbort = new AbortController();
	/** The first loss of this session's log; nothing the session does afterwards can be saved. */
	private _lostError: Error | undefined;
	private readonly _lostDeferred = Promise.withResolvers<Error>();
	/** Aborted with the loss as its reason; in-flight tool executions are abandoned on it. */
	private readonly _lostAbort = new AbortController();
	/**
	 * Resolves once, when this session loses its log: its conversation could
	 * not confirm a commit and ended. The session has cancelled its work by
	 * then and accepts no more; its runtime ends. In-flight command handlers and
	 * extension tools are no longer awaited. Never rejects.
	 */
	readonly lost: Promise<Error> = this._lostDeferred.promise;

	private _resourceLoader: ResourceLoader;
	private _cwd: string;
	private _agentDir: string;
	private _disposed = false;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	/**
	 * Open an agent session over its session manager's log. The session's
	 * conversation becomes the log's only writer until the session is disposed;
	 * the session manager's writes go through it meanwhile. Model and thinking
	 * level come from the log; a configured model or thinking level the branch
	 * does not name is committed first.
	 */
	static async create(config: AgentSessionConfig): Promise<AgentSession> {
		const session = new AgentSession(config);
		await session._open(config);
		return session;
	}

	private constructor(config: AgentSessionConfig) {
		this.sessionManager = config.sessionManager;
		this._streamFn = config.streamFn;
		this._diagnostics = new BackgroundJobDiagnostics({
			agentDir: resolvePath(config.agentDir ?? getAgentDir()),
			sessionId: () => this.sessionId,
			parentSessionId: () => this.sessionManager.getHeader()?.parentSession?.sessionId,
			warn: () => {
				const message = "Could not retain optional background-job performance diagnostics.";
				const uiContext = this._extensions.uiContext;
				if (uiContext && this._extensions.mode === "tui") uiContext.notify(message, "warning");
				else console.error(message);
			},
		});
		this._toolProgressDiagnostics = new ToolProgressDiagnostics(
			resolvePath(config.agentDir ?? getAgentDir()),
			() => this.sessionId,
		);
		this._convertToLlm = config.convertToLlm;
		this.settingsManager = config.settingsManager;
		const ownsGitContextProvider = config.gitContextProvider === undefined;
		this.gitContextProvider = config.gitContextProvider ?? new GitContextProvider(config.cwd);
		this._releaseGitContextProvider =
			ownsGitContextProvider || config.releaseGitContextProvider === undefined
				? () => this.gitContextProvider.dispose()
				: config.releaseGitContextProvider;
		this._resourceLoader = config.resourceLoader;
		this._cwd = resolvePath(config.cwd);
		this._agentDir = resolvePath(config.agentDir ?? getAgentDir());
		this._modelRegistry = config.modelRegistry;
		this._planning = new SessionPlanning({
			sessionManager: this.sessionManager,
			hasRunningJobs: () => this._jobs.runtime.hasRunning,
			conversation: () => this._conversation,
			sessionWriter: () => this._sessionWriter,
			tools: () => this._tools,
			clientInputs: () => this._clientInputs,
			isDisposed: () => this._disposed,
			assertActive: () => this._assertActive(),
			assertNotDisposed: () => this._assertNotDisposed(),
			turnActive: () => this._turnActive,
			generation: () => this._generation(),
			isReviewDiscussion: () => this.isReviewDiscussion,
			trackAncillaryWork: (work) => this._trackAdmittedAncillaryWork(work),
			emit: (event) => this._events.emit(event),
		});
		this._modelSettings = new ModelSettings(
			{
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				modelRegistry: this._modelRegistry,
				conversation: () => this._conversation,
				extensionRunner: () => this.extensionRunner,
				assertActive: () => this._assertActive(),
				syncPlanningRuntime: () => this._tools.syncPlanningRuntime(),
				publishPromptCacheStatus: () => this._promptCache.publish(),
				emit: (event) => this._events.emit(event),
			},
			{ model: config.model, scopedModels: config.scopedModels, streamOptions: config.streamOptions },
		);
		this._promptCache = new SessionPromptCache({
			agentDir: resolvePath(config.agentDir ?? getAgentDir()),
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			conversation: () => this._conversation,
			sessionWriter: () => this._sessionWriter,
			model: () => this.model,
			cacheRetention: () => this._modelSettings.streamOptions.cacheRetention,
			// The phase the session last observed counts too: an operation that already ended still has
			// its start to report, so keepalive sees both edges in order.
			hasInFlightWork: () => this._events.phaseOperation !== null || this.isBusy || this._work.running().length > 0,
			isDisposed: () => this._disposed,
			emit: (event) => this._events.emit(event),
		});
		this._retry = new SessionRetry({
			settingsManager: this.settingsManager,
			conversation: () => this._conversation,
			model: () => this.model,
			overflowRecoveredOperationId: () => this._compaction.overflowRecoveredOperationId,
			emit: (event) => this._events.emit(event),
		});
		this._bash = new SessionBash({
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			gitContextProvider: this.gitContextProvider,
			admissionGate: this._admissionGate,
			conversation: () => this._conversation,
			sessionWriter: () => this._sessionWriter,
			assertActive: () => this._assertActive(),
			assertNotLost: () => this._assertNotLost(),
			isDisposed: () => this._disposed,
			hasSessionOperationBarrier: () => this._hasSessionOperationBarrier,
			turnActive: () => this._turnActive,
			activityChanged: () => this._activityChanged(),
		});
		this._sessionInfo = new SessionInfo({
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			modelRegistry: this._modelRegistry,
			sessionWriter: () => this._sessionWriter,
			assertActive: () => this._assertActive(),
			isDisposed: () => this._disposed,
			model: () => this.model,
			messages: () => this.messages,
			activeTools: () => this._conversation.activeTools,
			state: () => this.state,
			getToolDefinition: (name) => this.getToolDefinition(name),
			emit: (event) => this._events.emit(event),
		});
		this._lifecycle = this._createLifecycle();
		this._tools = new SessionToolRuntime(
			{
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				modelRegistry: this._modelRegistry,
				resourceLoader: this._resourceLoader,
				cwd: this._cwd,
				agentDir: this._agentDir,
				lostSignal: this._lostAbort.signal,
				planningController: this,
				liveState: this.liveState,
				hostActions: this._hostActions,
				conversation: () => this._conversation,
				extensions: () => this._extensions,
				extensionServices: () => this._extensionServices,
				jobs: () => this._jobs,
				isDisposed: () => this._disposed,
				assertActive: () => this._assertActive(),
				model: () => this.model,
				messages: () => this.messages,
				planningState: () => this._planning.current,
				operationGrantProfile: () => this._planning.operationGrantProfile(),
				isReviewDiscussion: () => this.isReviewDiscussion,
				emit: (event) => this._events.emit(event),
			},
			{
				customTools: config.customTools,
				projectCwd: resolvePath(config.projectCwd ?? this._cwd),
				allowedToolNames: config.allowedToolNames,
				allowUnlistedExtensionTools: config.allowUnlistedExtensionTools,
				excludedToolNames: config.excludedToolNames,
				baseToolsOverride: config.baseToolsOverride,
				lspServerPool: config.lspServerPool,
				subagentToolManager: config.subagentToolManager,
				mcpManager: config.mcpManager,
				mcpManagerFactory: config.mcpManagerFactory,
			},
		);
		this._extensions = new SessionExtensionBinding(
			{
				session: this,
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				modelRegistry: this._modelRegistry,
				modelSettings: this._modelSettings,
				resourceLoader: this._resourceLoader,
				cwd: this._cwd,
				lifetimeSignal: this._lifetimeAbort.signal,
				liveState: this.liveState,
				conversation: () => this._conversation,
				tools: () => this._tools,
				extensionServices: () => this._extensionServices,
				extensionKinds: () => this._extensionKinds,
				jobs: () => this._jobs,
				sessionWriter: () => this._sessionWriter,
				assertActive: () => this._assertActive(),
				hasActiveWork: () =>
					this._turnActive ||
					this.isBashRunning ||
					this.hasActiveSessionMutation ||
					this._work.running().length > 0,
				extensionCommandRunning: () => this._prompting.extensionCommandRunning,
				sendCustomMessage: (message, options, allowDuringPromptTransaction) =>
					this._prompting.sendCustomMessage(message, options, allowDuringPromptTransaction),
				trackAncillaryWork: (work) => this._trackAdmittedAncillaryWork(work),
			},
			{
				extensionRunnerRef: config.extensionRunnerRef,
				sessionStartEvent: config.sessionStartEvent ?? { type: "session_start", reason: "startup" },
			},
		);
		this._turnPolicy = new SessionTurnPolicy({
			sessionManager: this.sessionManager,
			retry: this._retry,
			conversation: () => this._conversation,
			extensionRunner: () => this.extensionRunner,
			extensionServices: () => this._extensionServices,
			tools: () => this._tools,
			jobs: () => this._jobs,
			isDisposed: () => this._disposed,
			isLost: () => this._lostError !== undefined,
			assertActive: () => this._assertActive(),
			assertNotLost: () => this._assertNotLost(),
			activeToolNames: () => this.getActiveToolNames(),
			operationGrantProfile: () => this._planning.operationGrantProfile(),
			planningState: () => this._planning.current,
			hasPlanResearch: () => this._planning.hasResearch(),
			recordPlanResearch: () => this._planning.recordResearch(),
			emitExtensionEvent: (event) => this._events.emitExtensionEvent(event),
			recordTurnFatalError: (error) => this._events.recordTurnFatalError(error),
			failDelivery: (clientMessageId, error) => this._events.failDelivery(clientMessageId, error),
			prepareDelivery: (delivery) => this._planning.prepareDelivery(delivery),
			compactionDecision: (cause, check) => this._compaction.decision(cause, check),
		});
		this._providerStream = new SessionProviderStream({
			diagnostics: this._diagnostics,
			toolProgressDiagnostics: this._toolProgressDiagnostics,
			providerStream: (model, context, options) => this._streamFn(model, context, options),
			conversation: () => this._conversation,
			activeRun: () => this._events.activeAgentRun,
			isCompacting: () => this._compaction.activeCompaction !== undefined,
		});
		this._jobs = new SessionJobs({
			admissionGate: this._admissionGate,
			work: () => this._work,
			conversation: () => this._conversation,
			extensionRunner: () => this.extensionRunner,
			turnPolicy: () => this._turnPolicy,
			assertActive: () => this._assertActive(),
			isDisposed: () => this._disposed,
			generation: () => this._generation(),
			hasSessionOperationBarrier: () => this._hasSessionOperationBarrier,
			isToolExecutionPending: (toolCallId) => this._events.pendingToolExecutions.has(toolCallId),
			isToolGranted: (name) =>
				!this._disposed &&
				this._planning.current.mode !== "plan" &&
				this._tools.isToolActive(name) &&
				this._tools.isTrustedBuiltin(name),
			recordDiagnostic: (event) => this._providerStream.recordDiagnostic(event),
		});
		this._work.register(this._jobs.runtime.kind());
		this._work.register(reviewWorkKind(() => this.sessionManager));
		this._work.register(HOST_ACTION_WORK_KIND);
		// The children of the session's subagent manager are its `subagent` work.
		const subagentKind = config.subagentToolManager?.workKind?.({
			work: () => this._work,
			allowedTools: () => this._tools.subagentAllowedTools(),
		});
		if (subagentKind) this._work.register(subagentKind);
		this._events = new SessionEvents({
			gitContextProvider: this.gitContextProvider,
			toolProgressDiagnostics: this._toolProgressDiagnostics,
			diagnostics: this._diagnostics,
			retry: this._retry,
			conversation: () => this._conversation,
			extensionRunner: () => this.extensionRunner,
			extensionServices: () => this._extensionServices,
			providerStream: () => this._providerStream,
			jobs: () => this._jobs,
			work: () => this._work,
			turnId: () => this._turnId,
			promptCache: () => this._promptCache,
			turnPolicy: () => this._turnPolicy,
			bash: () => this._bash,
			sessionInfo: () => this._sessionInfo,
			clientInputs: () => this._clientInputs,
			prompting: () => this._prompting,
			compaction: () => this._compaction,
			isDisposed: () => this._disposed,
			isLost: () => this._lostError !== undefined,
			assertActive: () => this._assertActive(),
			activityChanged: () => this._activityChanged(),
			bumpActivityRevision: () => {
				this._activityRevision++;
			},
			lose: (error) => this._lose(error),
			captureGenerationAssertion: () => this._captureConversationGenerationAssertion(),
		});
		this._clientInputs = new SessionClientInputs({
			admissionGate: this._admissionGate,
			conversation: () => this._conversation,
			events: () => this._events,
			isDisposed: () => this._disposed,
			isLost: () => this._lostError !== undefined,
			assertActive: () => this._assertActive(),
			isBusy: () => this.isBusy,
			isReviewDiscussion: () => this.isReviewDiscussion,
			abortGeneration: () => this._abortGeneration,
			trackAncillaryWork: (work) => this._trackAdmittedAncillaryWork(work),
			emit: (event) => this._events.emit(event),
		});
		this._prompting = new SessionPrompting({
			resourceLoader: this._resourceLoader,
			modelRegistry: this._modelRegistry,
			admissionGate: this._admissionGate,
			lifetimeSignal: this._lifetimeAbort.signal,
			lost: this.lost,
			conversation: () => this._conversation,
			extensionRunner: () => this.extensionRunner,
			extensionServices: () => this._extensionServices,
			tools: () => this._tools,
			bash: () => this._bash,
			lifecycle: () => this._lifecycle,
			clientInputs: () => this._clientInputs,
			events: () => this._events,
			sessionWriter: () => this._sessionWriter,
			isDisposed: () => this._disposed,
			assertActive: () => this._assertActive(),
			hasSessionOperationBarrier: () => this._hasSessionOperationBarrier,
			turnActive: () => this._turnActive,
			abortGeneration: () => this._abortGeneration,
			model: () => this.model,
			captureGenerationAssertion: (assertExternalAuthorityCurrent) =>
				this._captureConversationGenerationAssertion(assertExternalAuthorityCurrent),
			waitForIdle: () => this._waitForIdle(),
			activityChanged: () => this._activityChanged(),
			prompt: (text, options) => this.prompt(text, options),
			emit: (event) => this._events.emit(event),
		});
		this._compaction = new SessionCompaction({
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			modelSettings: this._modelSettings,
			agentDir: this._agentDir,
			convertToLlm: this._convertToLlm,
			conversation: () => this._conversation,
			extensionRunner: () => this.extensionRunner,
			extensions: () => this._extensions,
			planning: () => this._planning,
			isDisposed: () => this._disposed,
			assertNotDisposed: () => this._assertNotDisposed(),
			isBashRunning: () => this.isBashRunning,
			turnActive: () => this._turnActive,
			model: () => this.model,
			thinkingLevel: () => this.thinkingLevel,
			fastModeEnabled: () => this.fastModeEnabled,
			systemPrompt: () => this.systemPrompt,
			messages: () => this.messages,
			captureGenerationAssertion: (assertExternalAuthorityCurrent) =>
				this._captureConversationGenerationAssertion(assertExternalAuthorityCurrent),
			recordTurnFatalError: (error) => this._events.recordTurnFatalError(error),
			emit: (event) => this._events.emit(event),
		});
		this._navigation = new SessionNavigation({
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			modelSettings: this._modelSettings,
			hasRunningJobs: () => this._jobs.runtime.hasRunning,
			conversation: () => this._conversation,
			extensionRunner: () => this.extensionRunner,
			extensionServices: () => this._extensionServices,
			planning: () => this._planning,
			turnActive: () => this._turnActive,
			isBashRunning: () => this.isBashRunning,
			hasSessionOperationBarrier: () => this._hasSessionOperationBarrier,
			generation: () => this._generation(),
			model: () => this.model,
			thinkingLevel: () => this.thinkingLevel,
			fastModeEnabled: () => this.fastModeEnabled,
			emit: (event) => this._events.emit(event),
		});
	}

	/** Open the conversation over the session's log, then bind the runtime to it. */
	private async _open(config: AgentSessionConfig): Promise<void> {
		const ownsGitContextProvider = config.gitContextProvider === undefined;
		const gitContextSubscriptionFinalizers: Array<() => void> = [];
		try {
			if (ownsGitContextProvider) void this.gitContextProvider.refresh();
			this._tools.attachMcpManagerEvents();
			this._extensionServices = this._createExtensionServices(config.extensionServicesLimits);
			await this._modelSettings.applyInitialSelection(config.model, config.thinkingLevel);
			this._log = this.sessionManager.takeLog();
			this._conversation = await Conversation.open<AgentTool>({
				log: this._log,
				entryTypes: Object.values(PRODUCT_SESSION_ENTRY_TYPES),
				stream: (model, context, options) => this._providerStream.stream(model, context, options),
				resolveModel: (provider, modelId) => this._modelSettings.findModel(provider, modelId),
				...(config.promptCacheRefresh === undefined ? {} : { promptCacheRefresh: config.promptCacheRefresh }),
				summarizer: {
					compact: (request) => this._compaction.summarize(request),
					summarizeBranch: async (request) => await this._navigation.summarizeBranch(request),
				},
				systemPrompt: () => this._prompting.turnSystemPrompt(),
				convertToLlm: (messages) => this._convertToLlm(messages.map(withoutClientIdentity)),
				streamOptions: this._modelSettings.streamOptions,
				queueModes: {
					steer: config.steeringMode ?? "one-at-a-time",
					followUp: config.followUpMode ?? "one-at-a-time",
				},
				policy: this._turnPolicy.createPolicy(),
				admissionGate: this._admissionGate,
			});
			this._sessionWriter = this._createSessionWriter();
			void this.sessionManager.lost.then((error) => this._lose(error));
			void this._conversation.ended.then((end) => {
				if (end.reason !== "closed") this._lose(end.error);
			});
			this._unsubscribeConversation = this._conversation.subscribe(
				async (event) => await this._events.onConversationEvent(event),
			);
			this._unsubscribeSessionEntries = this.sessionManager.subscribeEntries((entry) => {
				if (entry.type === "planning_state_change") this._planning.onCommitted(entry.planning);
			});

			this._unsubscribeGitContext = () => {
				const cleanupErrors: unknown[] = [];
				for (const unsubscribe of gitContextSubscriptionFinalizers.splice(0).reverse()) {
					try {
						unsubscribe();
					} catch (error) {
						cleanupErrors.push(error);
					}
				}
				if (cleanupErrors.length === 1) throw cleanupErrors[0];
				if (cleanupErrors.length > 1) {
					throw new AggregateError(cleanupErrors, "Git context subscription cleanup did not complete");
				}
			};
			const sessionWriter = this._sessionWriter;
			gitContextSubscriptionFinalizers.push(
				this.gitContextProvider.subscribeObservations((observation) => {
					if (observation.status !== "definitive") return;
					// Git replacement delivery remains independent from metadata persistence.
					void sessionWriter.recordStartingGitContext(observation.gitContext).catch(() => {});
				}),
			);
			gitContextSubscriptionFinalizers.push(
				this.gitContextProvider.subscribe(
					(gitContext) => this._events.emit({ type: "git_context_changed", gitContext }),
					{ monitor: false },
				),
			);
			void this.gitContextProvider.refresh();

			// Work a previous runtime left open ends `interrupted`, unless it can resume.
			await this._work.reconcile();
			this._tools.build({
				activeToolNames: config.initialActiveToolNames,
				includeAllExtensionTools: true,
			});
			this._tools.startPlanningRuntime();
			this._clientInputs.publishQueue();
			await this._clientInputs.readmitRecovered();
			this._clientInputs.fenceRecovered();
		} catch (error) {
			this._disposed = true;
			void this._extensionServices?.close();
			void this._work.cancelAll("closed").catch(() => undefined);
			void this._diagnostics.close();
			void this._promptCache.close();
			const cleanupErrors: unknown[] = [];
			const cleanup = (finalize: () => void): void => {
				try {
					finalize();
				} catch (cleanupError) {
					cleanupErrors.push(cleanupError);
				}
			};

			this._extensions.releaseFailedOpen(cleanup);

			const lspManager = this._tools.takeLspManager();
			if (lspManager) cleanup(() => lspManager.dispose());
			this._unsubscribeGitContext = undefined;
			for (const unsubscribeGitContext of gitContextSubscriptionFinalizers.splice(0).reverse()) {
				cleanup(unsubscribeGitContext);
			}
			for (const unsubscribe of [this._unsubscribeConversation, this._unsubscribeSessionEntries]) {
				if (unsubscribe) cleanup(unsubscribe);
			}
			this._unsubscribeConversation = undefined;
			this._unsubscribeSessionEntries = undefined;
			const unsubscribeMcpManager = this._tools.takeMcpSubscription();
			if (unsubscribeMcpManager) cleanup(unsubscribeMcpManager);
			if (ownsGitContextProvider) cleanup(() => this.gitContextProvider.dispose());
			try {
				// Closing the conversation hands the log back to an in-memory manager and closes a persisted one.
				if (this._conversation) await this._conversation.close();
				else await this._log?.close();
			} catch (closeError) {
				cleanupErrors.push(closeError);
			}

			if (cleanupErrors.length > 0) {
				throw new AgentSessionConstructionCleanupError(
					[error, ...cleanupErrors],
					"Agent session construction cleanup did not complete",
				);
			}
			throw error;
		}
	}

	/** The session's writer while it is open: each write is a conversation intent. */
	private _createSessionWriter(): SessionWriter {
		const conversation = this._conversation;
		// Writes end with the session, and a write after the log is lost reports the loss. The
		// session's own teardown writes go to the conversation.
		const active = (): Conversation<AgentTool> => {
			this._assertNotLost();
			this._assertNotDisposed();
			return conversation;
		};
		return new ConversationSessionWriter(this.sessionManager, {
			append: async (entries) => await active().append(entries),
			setModel: async (provider, modelId) => {
				const model = this._modelSettings.findModel(provider, modelId);
				if (!model) throw new Error(`Model ${provider}/${modelId} is not available`);
				await active().setModel(model);
			},
			setThinkingLevel: async (thinkingLevel) => await active().setThinkingLevel(thinkingLevel),
			setFastMode: async (enabled) => await active().setFastMode(enabled),
			setPlanning: async (planning) => await active().setPlanning(planning),
			setName: async (name) => await active().setName(name),
			setLabel: async (targetId, label) => await active().setLabel(targetId, label),
		});
	}

	/**
	 * The writer of this session's log while the session is open: its writes
	 * are conversation intents. Writes are refused once the session is disposed.
	 */
	get sessionWriter(): SessionWriter {
		return this._sessionWriter;
	}

	/**
	 * The conversation's work (RFC §7): its kinds, the executors of the work
	 * this runtime runs, and the cancel, resume, and open paths every client
	 * shares. Code running in the session (its tools, the subagent manager,
	 * host actions) starts work through it; the host reconciles the work a
	 * previous runtime left when it opens the conversation, and closing the
	 * session stops every executor.
	 */
	get work(): WorkRegistry {
		return this._work;
	}

	/**
	 * Runs host actions, such as an LSP server install: `host_action` work
	 * that waits in the live state for a client's approval before it runs.
	 */
	get hostActions(): HostActions {
		return this._hostActions;
	}

	/** The running turn's operation id, if a turn runs: work started meanwhile belongs to it. */
	private get _turnId(): string | undefined {
		const operation = this._conversation?.operation;
		return operation?.kind === "turn" ? operation.id : undefined;
	}

	/**
	 * The session lost its log. Nothing it does afterwards can be saved, so it cancels its own
	 * work: the turn (with its retries and compaction), its work items, bash, and the
	 * lifetime signal command handlers observe. In-flight command handlers and extension tools
	 * stop being awaited, so `isBusy` clears once cooperative work settles and the runtime can
	 * end. Cancellation is deferred to a microtask so abort listeners never reenter a failing
	 * write.
	 */
	private _lose(error: Error): void {
		if (this._lostError) return;
		this._lostError = error;
		// First, so in-flight commands and tools are abandoned before reactions to the aborts below run.
		this._lostDeferred.resolve(error);
		this._lostAbort.abort(error);
		if (this._disposed) return;
		this._extensionServices.invalidate();
		this._clientInputs.lost(error);
		// Work persists through the lost log and cannot finish; the next open reconciles it.
		void this._work.cancelAll("closed").catch(() => undefined);
		queueMicrotask(() => {
			if (this._disposed) return;
			this._lifetimeAbort.abort(error);
			void this.abort("session_replacement").catch(() => undefined);
			this.abortBash();
			this._activityChanged();
		});
	}

	/** Actions and writes: rejected once the session is disposed or has lost its log. */
	private _assertActive(): void {
		this._assertNotDisposed();
		this._assertNotLost();
	}

	/** Reads keep working after the session lost its log, until it is disposed. */
	private _assertNotDisposed(): void {
		if (this._disposed) throw new Error("AgentSession is disposed");
	}

	private _assertNotLost(): void {
		if (this._lostError) throw this._lostError;
	}

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	/**
	 * Suspend admission of new work (turns, bash runs, background jobs, session
	 * mutations) until the returned release runs. A prompt still preparing its
	 * turn is refused; work already running continues.
	 */
	suspendAdmission(): () => void {
		this._assertActive();
		return this._admissionGate.suspend();
	}

	/** LSP status for the /lsp command. */
	getLspStatus(): { enabled: boolean; workspaceRoot?: string; servers: LspServerStatus[]; traceFile?: string } {
		return this._tools.lspStatus();
	}

	/** Enable or disable LSP protocol tracing at runtime. */
	setLspTraceFile(filePath: string | undefined): Promise<void> {
		this._assertActive();
		return this._trackAdmittedAncillaryWork(this._tools.setLspTraceFile(filePath));
	}

	/** Stop LSP tracing from a synchronous process teardown path. */
	closeLspTraceSync(): void {
		this._tools.closeLspTraceSync();
	}

	/**
	 * Stop all running language servers, including those shared with subagents and
	 * other sessions from the same pool; they respawn lazily on next use. Returns the number stopped.
	 */
	restartLspServers(): number {
		this._assertActive();
		return this._tools.restartLspServers();
	}

	/** The branch generation: changes exactly when the active branch switches. */
	private _generation(): number {
		return this._conversation?.state.branchSwitchOrdinal ?? 0;
	}

	/** The session's extension services: invalid limits reject the session's open. */
	private _createExtensionServices(limits: Partial<ExtensionServicesLimits> | undefined): SessionExtensionServices {
		return new SessionExtensionServices(
			{
				settingsManager: this.settingsManager,
				cwd: this._cwd,
				isCurrent: () =>
					!this._disposed &&
					!this._extensions.reloading &&
					this._admissionGate.isOpen &&
					this._lostError === undefined,
				conversation: () => this._conversation,
				extensionRunner: () => this.extensionRunner,
				sessionId: () => this.sessionId,
				generation: () => this._generation(),
				model: () => this.model,
				mode: () => this._planning.current.mode,
				skills: () => this._resourceLoader.getSkills().skills,
				isToolActive: (name) => this._tools.isToolActive(name),
				tool: (name) => this._tools.registeredTool(name),
				toolDefinition: (name) => this._tools.registeredDefinition(name),
				trustedOperationResolver: (name) => this._tools.trustedOperationResolver(name),
				operationGrantProfile: () => this._planning.operationGrantProfile(),
				turnPolicies: () => this._turnPolicy.registrations,
				policyRevision: () => this._turnPolicy.revision,
				isExtensionInput: (clientMessageId) => this._prompting.isExtensionInput(clientMessageId),
			},
			limits,
		);
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener, options: { monitorGitContext?: boolean } = {}): () => void {
		return this._events.subscribe(listener, options);
	}

	/**
	 * Observe conversation-generation commits such as tree navigation.
	 *
	 * The callback runs after the navigation committed and the session's
	 * branch-local runtime state was restored from it, giving snapshot
	 * consumers one atomic read boundary for the new generation.
	 */
	subscribeConversationGenerationChanges(listener: ConversationGenerationListener): () => void {
		return this._navigation.subscribeGenerationChanges(listener);
	}

	/** The branch generation for branch-sensitive host mutations: the log ordinal of the latest branch switch. */
	get conversationGenerationRevision(): number {
		return this._generation();
	}

	/** Capture a branch-local mutation lease, optionally layered over transport authority. */
	private _captureConversationGenerationAssertion(assertExternalAuthorityCurrent?: () => void): () => void {
		const expectedRevision = this._generation();
		return () => {
			this._assertActive();
			// Keep the transport's stable stale-authority error when one is available.
			assertExternalAuthorityCurrent?.();
			if (this._generation() !== expectedRevision) {
				throw new Error("Conversation generation changed during a branch-local mutation");
			}
		};
	}

	/** Monotonic revision of admitted work; changes when an operation begins or settles. */
	get activityRevision(): number {
		return this._activityRevision;
	}

	private _trackAdmittedAncillaryWork<T>(operation: Promise<T>): Promise<T> {
		this._admittedAncillaryWork.add(operation);
		this._activityRevision++;
		void operation.then(
			() => {
				this._admittedAncillaryWork.delete(operation);
				this._activityRevision++;
			},
			() => {
				this._admittedAncillaryWork.delete(operation);
				this._activityRevision++;
			},
		);
		return operation;
	}

	/**
	 * Starts input queued before a delivering stop as a fresh turn once that
	 * stop has settled. The stop leaves a terminal aborted assistant message, so
	 * the turn delivers steering first, then follow-ups, and never resumes the
	 * interrupted work on its own. Quiet host input (a `message` work notice)
	 * alone starts none: it rides the next turn.
	 */
	private _deliverQueuedMessagesAfterStop(): void {
		if (
			this._disposed ||
			!this._admissionGate.isOpen ||
			this._lostError !== undefined ||
			this._conversation.operation !== undefined ||
			!this._conversation.queueWakes
		)
			return;
		const work = this._conversation.continue().catch((error: unknown) => {
			if (this._disposed) return;
			this.extensionRunner.emitError({
				extensionId: "<runtime>",
				event: "queued_message_delivery",
				error: error instanceof Error ? error.message : String(error),
			});
		});
		void this._trackAdmittedPromptWork(work);
	}

	private _trackAdmittedPromptWork<T>(operation: Promise<T>): Promise<T> {
		this._admittedPromptWork.add(operation);
		this._activityRevision++;
		void operation.then(
			() => {
				this._admittedPromptWork.delete(operation);
				this._activityRevision++;
			},
			() => {
				this._admittedPromptWork.delete(operation);
				this._activityRevision++;
			},
		);
		return operation;
	}

	private async _drainAdmittedWork(includePromptWork: boolean): Promise<void> {
		while (this._admittedAncillaryWork.size > 0 || (includePromptWork && this._admittedPromptWork.size > 0)) {
			await Promise.allSettled([
				...this._admittedAncillaryWork,
				...(includePromptWork ? this._admittedPromptWork : []),
			]);
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session. With `leavePromptWork`,
	 * disposal does not wait for admitted prompt work: a session its clients
	 * moved away from may be disposed by the extension command that moved them.
	 */
	dispose(source: AgentAbortSource = "disposal", options: { leavePromptWork?: boolean } = {}): void {
		void this._lifecycle.dispose(source, options.leavePromptWork === true);
	}

	/** Join asynchronous teardown after dispose() has installed its synchronous fence. */
	waitForClosed(): Promise<void> {
		return this._lifecycle.waitForClosed();
	}

	/** The session's teardown, over the runtime state it fences and the participants it stops. */
	private _createLifecycle(): SessionLifecycle {
		return new SessionLifecycle({
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			toolProgressDiagnostics: this._toolProgressDiagnostics,
			conversation: () => this._conversation,
			extensionRunner: () => this.extensionRunner,
			extensionRunnerRef: () => this._extensions.runnerRef,
			bash: () => this._bash,
			extensionServices: () => this._extensionServices,
			promptCache: () => this._promptCache,
			isDisposed: () => this._disposed,
			hasSessionOperationBarrier: () => this._hasSessionOperationBarrier,
			activeToolNames: () => this.getActiveToolNames(),
			subagentToolManager: () => this._tools.getSubagentToolManager(),
			appendNotice: (message) => this._prompting.sendCustomMessage(message, undefined, false, true),
			fence: () => {
				this._disposed = true;
				this._extensionServices.invalidate();
				this._events.endOperation();
				this._promptCache.dispose();
				this._lifetimeAbort.abort(new Error("AgentSession is disposed"));
				// Teardown never releases its hold, even if an overlapping abort finishes.
				this._admissionGate.suspend();
				this._jobs.clearRunRecords();
				this._events.clearStreamingState();
				this._clientInputs.handBackQueue();
			},
			releaseExtensionClients: () => {
				this._extensions.releaseClients();
				// Pending dialogs and approvals end; nothing more reaches the clients.
				this.liveState.close();
			},
			closeWork: () => this._work.cancelAll("closed"),
			settleLiveClientInputs: () => this._clientInputs.settleOnDisposal(),
			stopToolServers: () => this._tools.stopServers(),
			drainAdmittedWork: (includePromptWork) => this._drainAdmittedWork(includePromptWork),
			disposeSubagentToolManager: () => this.disposeSubagentToolManager(),
			disposeMcpManager: () => this._tools.getMcpManager()?.dispose() ?? Promise.resolve(),
			detachConversation: () => {
				this._unsubscribeConversation?.();
				this._unsubscribeConversation = undefined;
				this._unsubscribeSessionEntries?.();
				this._unsubscribeSessionEntries = undefined;
			},
			releaseObservers: () => {
				this._unsubscribeGitContext?.();
				this._unsubscribeGitContext = undefined;
				this._events.releaseGitObservations();
				this._releaseGitContextProvider();
				this._events.clearListeners();
				this._navigation.clearListeners();
			},
			closeDiagnostics: () => this._diagnostics.close(),
		});
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Read-only, bounded diagnostic snapshot of recent tool preparation and execution. */
	getToolProgressDiagnostics() {
		return this._toolProgressDiagnostics.snapshot();
	}

	/** Save a private diagnostic capture without interrupting the current run. */
	captureToolProgressDiagnostics(): Promise<string> {
		return this._toolProgressDiagnostics.capture();
	}

	/** Wait for diagnostic writes already scheduled by this session. */
	waitForToolProgressDiagnostics(): Promise<void> {
		return this._toolProgressDiagnostics.waitForCapture();
	}

	/** Read-only runtime state snapshot. */
	get state(): AgentSessionState {
		this._assertNotDisposed();
		return {
			systemPrompt: this.systemPrompt,
			model: this.model,
			thinkingLevel: this.thinkingLevel,
			tools: this._tools.activeTools(),
			messages: this.messages,
			isStreaming: this.isStreaming,
			streamingMessage:
				this._events.streamingMessage === undefined ? undefined : structuredClone(this._events.streamingMessage),
			pendingToolCalls: new Set(this._events.pendingToolExecutions.keys()),
			pendingToolExecutions: new Map(
				[...this._events.pendingToolExecutions].map(
					([toolCallId, execution]) => [toolCallId, structuredClone(execution)] as const,
				),
			),
			errorMessage: this._events.runtimeErrorMessage,
		};
	}

	/** Current runtime cancellation signal, when a conversation operation is active. */
	get signal(): AbortSignal | undefined {
		return this._conversation.operation?.signal;
	}

	/** Read-only active tool execution projection for RPC and UI state. */
	get activeToolExecutions(): ReadonlyMap<string, PendingToolExecution> {
		return new Map(
			[...this._events.pendingToolExecutions].map(
				([toolCallId, execution]) => [toolCallId, structuredClone(execution)] as const,
			),
		);
	}

	/** The model the active branch names (may be undefined if none is selected or it is not known) */
	get model(): Model<any> | undefined {
		return this._modelSettings.model;
	}

	/** The active branch's thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this._modelSettings.thinkingLevel;
	}

	/** Whether the branch-local Fast mode policy is enabled. */
	get fastModeEnabled(): boolean {
		return this._modelSettings.fastModeEnabled;
	}

	/** Host-owned source linkage, independent of tool permissions and Plan/Build mode. */
	get isReviewDiscussion(): boolean {
		return this.sessionManager.getReviewDiscussion() !== null;
	}

	get agentMode(): AgentMode {
		return this._planning.mode;
	}

	get planningState(): PlanningState {
		return this._planning.planningState;
	}

	getPlanningState(): PlanningState {
		return this.planningState;
	}

	/** Whether a turn holds the conversation: reserved for a prompt, running, retrying, or compacting in it. */
	/**
	 * Whether a turn is running: provider streaming, tool execution, or retry
	 * and compaction inside it. A prompt preparing its turn (input hooks,
	 * `before_agent_start`) holds the conversation without streaming; `isBusy`
	 * covers it.
	 */
	get isStreaming(): boolean {
		const operation = this._conversation.operation;
		return this._turnActive && operation?.stage !== "admitted";
	}

	/** Whether a turn holds the conversation, a prompt's reservation included. */
	private get _turnActive(): boolean {
		return !this._disposed && this._conversation.operation?.kind === "turn";
	}

	/** The conversation's background jobs: its `job` work, with the output of the jobs this runtime runs. */
	get jobs(): JobSource {
		return this._jobs.runtime;
	}

	/**
	 * Whether the conversation is busy: an operation (a turn, compaction, tree
	 * navigation, or reload) holds it, or a `!` command or extension command runs.
	 */
	get isBusy(): boolean {
		return this._conversation.busy;
	}

	/** The exclusive operation that holds the conversation, if any. */
	get operation(): ConversationOperationKind | null {
		return this._conversation?.operation?.kind ?? null;
	}

	/**
	 * Observe changes of what `isBusy` and `operation` read, and of the work
	 * this runtime runs. Listeners run synchronously; their failures are ignored.
	 */
	subscribeActivity(listener: () => void): () => void {
		this._activityListeners.add(listener);
		return () => {
			this._activityListeners.delete(listener);
		};
	}

	/**
	 * An `isBusy` input changed, or work started or stopped running. Prompt-cache keepalive measures its idle
	 * window from these transitions.
	 */
	private _activityChanged(): void {
		this._promptCache.activityChanged();
		for (const listener of [...this._activityListeners]) {
			try {
				listener();
			} catch {
				// Activity observers are passive.
			}
		}
	}

	/** A structural operation holds the conversation: compaction, tree navigation, or reload. */
	private get _hasSessionOperationBarrier(): boolean {
		const kind = this._conversation.operation?.kind;
		return this._extensions.reloading || kind === "compaction" || kind === "navigation" || kind === "host";
	}

	/**
	 * Whether pre-provider input or an asynchronous session mutation can still
	 * commit against the current SessionManager. Identified extension command
	 * transactions are excluded because they are the control path that may
	 * intentionally initiate runtime replacement; their contexts are invalidated
	 * at replacement commit.
	 */
	get hasActiveSessionMutation(): boolean {
		return this._hasSessionOperationBarrier;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this._tools.systemPrompt;
	}

	/**
	 * Append fixed context to this session's base system prompt.
	 * Used by subagent runtimes to apply a selected definition before any turns run.
	 */
	appendSystemPromptContext(context: string): void {
		this._assertActive();
		this._tools.appendSystemPromptContext(context);
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retry.attempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this._tools.getActiveToolNames();
	}

	subscribeRuntimeEvents(listener: (event: AgentEvent) => Promise<void> | void): () => void {
		return this._events.subscribeRuntimeEvents(listener);
	}

	/** Own callback snapshots; explicit updates/invalidation revoke earlier managed authorization. */
	registerTurnPolicy(policy: AgentSessionTurnPolicy): PolicyRegistration<AgentSessionTurnPolicy> {
		return this._turnPolicy.register(policy);
	}

	setTransport(transport: NonNullable<ConversationStreamOptions["transport"]>): void {
		this._modelSettings.setTransport(transport);
	}

	getSubagentToolManager(): SubagentToolManager | undefined {
		this._assertNotDisposed();
		return this._tools.getSubagentToolManager();
	}

	disposeSubagentToolManager(): Promise<void> {
		return this._tools.disposeSubagentToolManager();
	}

	getMcpManager(): McpManager | undefined {
		this._assertNotDisposed();
		return this._tools.getMcpManager();
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return this._tools.getAllTools();
	}

	getToolDefinition(name: string): ToolDefinition<any, any> | undefined {
		return this._tools.getToolDefinition(name);
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		this._tools.setActiveToolsByName(toolNames);
	}

	setAgentMode(mode: AgentMode): Promise<PlanningState> {
		return this._planning.setAgentMode(mode);
	}

	toggleAgentMode(): Promise<PlanningState> {
		return this._planning.toggleAgentMode();
	}

	/** Commit a draft plan update; resolves after the new revision commits. */
	updatePlan(input: {
		planId?: string;
		expectedRevision?: number;
		title?: string;
		summary?: string;
		steps: PlanStepInput[];
	}): Promise<PlanState> {
		return this._planning.updatePlan(input);
	}

	/** Commit approved plan progress; resolves after the new revision commits. */
	updatePlanProgress(input: {
		planId: string;
		expectedRevision: number;
		updates: Array<{ id: string; status: PlanStepStatus; note?: string }>;
	}): Promise<PlanState> {
		return this._planning.updatePlanProgress(input);
	}

	/** Return approved execution to a draft; resolves after the draft commits. */
	requestReplan(input: { planId: string; expectedRevision: number; reason: string }): Promise<PlanningState> {
		return this._planning.requestReplan(input);
	}

	/** Submit a draft plan for approval; resolves after the ready plan commits. */
	submitPlan(input: { planId: string; expectedRevision: number; title: string; summary: string }): Promise<PlanState> {
		return this._planning.submitPlan(input);
	}

	/** Return a ready plan to a draft; resolves after the draft commits. */
	changePlan(planId: string, expectedRevision: number): Promise<PlanningState> {
		return this._planning.changePlan(planId, expectedRevision);
	}

	/** Discard the plan; resolves after the cleared planning state commits. */
	discardPlan(planId: string, expectedRevision: number): Promise<PlanningState> {
		return this._planning.discardPlan(planId, expectedRevision);
	}

	activatePlan(
		planId: string,
		expectedRevision: number,
		execution: PlanExecution,
	): Promise<{ planning: PlanningState; activated: boolean }> {
		return this._planning.activatePlan(planId, expectedRevision, execution);
	}

	markPlanHandedOff(planId: string, expectedRevision: number, execution: PlanExecution): Promise<PlanningState> {
		return this._planning.markPlanHandedOff(planId, expectedRevision, execution);
	}

	/** Active logical-operation timing, including automatic compaction and retry backoff. */
	get activeAgentRun(): ActiveAgentRun | undefined {
		const operation = this._events.activeAgentOperation;
		return operation ? { ...operation } : undefined;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return this._compaction.activeCompaction !== undefined;
	}

	/** Active context compaction metadata, if compaction is currently running. */
	get activeCompaction(): ActiveCompaction | undefined {
		const compaction = this._compaction.activeCompaction;
		return compaction ? { ...compaction } : undefined;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		this._assertNotDisposed();
		return cloneCanonicalData(
			[...this.sessionManager.getConversationState().context.messages],
			"Agent message delivery",
		);
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this._modelSettings.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this._modelSettings.followUpMode;
	}

	/** Current persisted session reference, or undefined for in-memory sessions. */
	get sessionRef(): SessionReference | undefined {
		return this.sessionManager.getSessionRef();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._modelSettings.scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._modelSettings.setScopedModels(scopedModels);
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	/**
	 * Replays recoverable queued client input after the runtime is fully ready:
	 * one turn delivers the recovered steering input, then the follow-ups, in
	 * their admission order. Interrupted provider/tool work is never resumed. A
	 * started input without an outcome blocks the replay as ambiguous. Finding
	 * discussions never replay: their interrupted inputs fail.
	 */
	resumeRecoveredClientInputs(): Promise<void> {
		return this._clientInputs.resumeRecovered();
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/** Wait for the agent and any session-level prompt work to settle, excluding work items. */
	async waitForIdle(): Promise<void> {
		await this._waitForIdle();
	}

	/**
	 * Wait until `isBusy` is false or the session is disposed. Unlike `waitForIdle()`, this also waits
	 * for `!` commands, extension commands, and reload, so an extension command must not await it.
	 */
	async waitForNotBusy(): Promise<void> {
		if (this._disposed) return;
		const disposed = new Promise<void>((resolve) => {
			this._lifetimeAbort.signal.addEventListener("abort", () => resolve(), { once: true });
		});
		await Promise.race([this._conversation.waitForNotBusy(), disposed]);
	}

	/** Wait for the conversation's operations, and by default for queued input still committing. */
	private async _waitForIdle(includeQueueAdmissions = true): Promise<void> {
		for (;;) {
			if (includeQueueAdmissions) await Promise.allSettled([...this._clientInputs.queueAdmissions]);
			await this._conversation.waitForIdle();
			if (
				this._conversation.operation === undefined &&
				(!includeQueueAdmissions || this._clientInputs.queueAdmissions.size === 0)
			)
				return;
		}
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via volt.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	prompt(text: string, options?: PromptOptions): Promise<void> {
		return this._trackAdmittedPromptWork(this._prompting.promptAdmitted(text, options));
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call. Queued while idle, it starts a turn.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[], clientMessageId?: string): Promise<void> {
		await this._prompting.queueInput("steer", text, images, clientMessageId);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Queued while idle, it starts a turn.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[], clientMessageId?: string): Promise<void> {
		await this._prompting.queueInput("follow_up", text, images, clientMessageId);
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: queues it and starts a new turn that delivers it
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T>(
		message: CustomMessageInput<T>,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		await this._prompting.sendCustomMessage(message, options, false);
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		return this._prompting.sendUserMessage(content, options);
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 *
	 * Every queued input is withdrawn durably. The conversation drops them from
	 * its queue before that commit, so a persistence failure cannot put the text
	 * back; it is instead carried on the thrown {@link QueueClearPersistenceError}
	 * for callers that must not lose it.
	 * @returns Object with steering and followUp arrays
	 * @throws QueueClearPersistenceError when the cleared state could not be persisted
	 */
	clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		return this._clientInputs.clearQueue();
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		this._assertNotDisposed();
		const { steering, followUp } = this._clientInputs.queueView();
		return steering.length + followUp.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly AgentSessionQueuedMessage[] {
		this._assertNotDisposed();
		return this._clientInputs.queueView().steering;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly AgentSessionQueuedMessage[] {
		this._assertNotDisposed();
		return this._clientInputs.queueView().followUp;
	}

	/** The notices of finished work queued for the next turn, oldest first (read-only). */
	getQueuedWorkNotices(): readonly WorkNoticeDetails[] {
		this._assertNotDisposed();
		return this._clientInputs.queueView().notices;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 *
	 * Queued steering and follow-up input is retained by default. With
	 * `deliverQueuedMessages`, it starts as a new turn once the stop settles; a
	 * joined stop that does not request delivery keeps it retained.
	 */
	abort(source?: AgentAbortSource, options?: { deliverQueuedMessages?: boolean }): Promise<void> {
		if (this._abortPromise) {
			if (!options?.deliverQueuedMessages && this._abortQueueDelivery) this._abortQueueDelivery.requested = false;
			return this._abortPromise;
		}
		const queueDelivery = { requested: options?.deliverQueuedMessages === true };
		this._abortQueueDelivery = queueDelivery;
		const releaseAdmission = this._admissionGate.suspend();
		this._extensionServices.invalidate();
		const turnId = this._turnId;
		let resolveAbort!: () => void;
		let rejectAbort!: (error: unknown) => void;
		const drain = new Promise<void>((resolve, reject) => {
			resolveAbort = resolve;
			rejectAbort = reject;
		});
		const abortPromise = drain.finally(() => {
			if (this._abortPromise === abortPromise) {
				this._abortPromise = undefined;
			}
			if (this._abortQueueDelivery === queueDelivery) {
				this._abortQueueDelivery = undefined;
			}
			releaseAdmission();
		});
		// Admission is already fenced. Publish the join before any cancellation
		// callback can synchronously reenter abort().
		this._abortPromise = abortPromise;
		// Registered before any caller continuation, so delivery reserves the idle
		// conversation before later admissions can observe it.
		void abortPromise.then(
			() => {
				if (queueDelivery.requested) this._deliverQueuedMessagesAfterStop();
			},
			() => undefined,
		);
		const drains: Promise<void>[] = [];
		for (const cancel of [
			() => {
				this._conversation.abort(source);
			},
			() => this.abortRetry(),
			() => this.abortCompaction(),
			// A stop fences the notices of the work its turn started, and cancels running work.
			() => (turnId === undefined ? undefined : this._work.suppressDelivery(turnId)),
			() => this._work.cancelAll("cancelled"),
			() => this._extensionServices.drain(),
			// Queued input committing meanwhile stays queued; the stop does not wait for it.
			() => this._waitForIdle(false),
		]) {
			try {
				drains.push(Promise.resolve(cancel()));
			} catch (error) {
				// One failing cancellation participant must not skip the other drains.
				drains.push(Promise.reject(error));
			}
		}
		void Promise.allSettled(drains)
			.then((results) => {
				const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1) throw new AggregateError(errors, "Agent session abort did not complete");
			})
			.then(resolveAbort, rejectAbort);
		return abortPromise;
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session, and persists as the default unless disabled.
	 * @throws Error if no auth is configured for the model
	 */
	setModel(model: Model<any>, options?: DefaultPersistenceOptions): Promise<void> {
		return this._trackAdmittedAncillaryWork(this._modelSettings.setModel(model, options));
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		return this._trackAdmittedAncillaryWork(this._modelSettings.cycleModel(direction));
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes. Settings persistence can be disabled.
	 */
	setThinkingLevel(level: ThinkingLevel, options?: DefaultPersistenceOptions): Promise<void> {
		return this._trackAdmittedAncillaryWork(this._modelSettings.setThinkingLevel(level, options));
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		void this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this._modelSettings.getAvailableThinkingLevels();
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return this._modelSettings.supportsThinking();
	}

	/** Commit a branch-local Fast mode transition before publishing its settled state. */
	setFastModeEnabled(enabled: boolean): Promise<void> {
		return this._modelSettings.setFastModeEnabled(enabled);
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/** Set the built-in prompt personality and apply it to future turns. */
	setPersonality(personality: Personality): void {
		this._assertActive();
		this._tools.setPersonality(personality);
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this._modelSettings.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this._modelSettings.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	compact(customInstructions?: string, assertConversationGenerationCurrent?: () => void): Promise<CompactionResult> {
		return this._compaction.compact(customInstructions, assertConversationGenerationCurrent);
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compaction.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._navigation.abortBranchSummary();
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this._assertActive();
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	/**
	 * Attach a client to the session's extensions. The first client to attach
	 * binds them: its mode becomes `ctx.mode` and `session_start` fires once.
	 * Later clients add their surface: UI calls go to the last attached client
	 * with a UI, errors go to every client, and session actions go to the client
	 * the call runs for (see `ClientScope`), or to the oldest attached client
	 * outside any client scope. `ready` settles once the extensions are bound.
	 */
	attachExtensionClient(client: ExtensionClient): ExtensionClientAttachment {
		// Binding runs session_start handlers and schedules background work; none of it belongs to the attaching client.
		return ClientScope.exit(() => {
			const attachment = this._extensions.attach(client);
			void this._trackAdmittedAncillaryWork(attachment.ready);
			return attachment;
		});
	}

	/**
	 * Settle the client input whose extension command the current call runs
	 * in, as completed: the command is moving its client to another
	 * conversation, which it may do only once the conversation it leaves has
	 * no input with an unknown outcome.
	 */
	settleInvokingCommandInput(): Promise<void> {
		return this._prompting.settleInvokingCommandInput();
	}

	reload(): Promise<void> {
		// The reloaded extensions' session_start belongs to no client, whoever asked for the reload.
		const reloaded = ClientScope.exit(() => this._trackAdmittedAncillaryWork(this._extensions.reload()));
		void reloaded.then(
			() => {
				for (const listener of [...this._reloadListeners]) {
					try {
						listener();
					} catch {
						// A reload observer's failure never fails the reload.
					}
				}
			},
			() => undefined,
		);
		return reloaded;
	}

	/** Observe completed reloads: the conversation's extensions, commands, prompt templates, and skills may have changed. */
	subscribeReloads(listener: () => void): () => void {
		this._reloadListeners.add(listener);
		return () => {
			this._reloadListeners.delete(listener);
		};
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Cancel in-progress retry: the turn waiting to retry stops.
	 */
	abortRetry(): void {
		this._retry.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retry.isRetrying;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this._assertActive();
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { excludeFromContext?: boolean; operations?: BashOperations },
	): Promise<BashResult> {
		return this._trackAdmittedAncillaryWork(this._bash.execute(command, onChunk, options));
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 * Resolves after the result commits, or at once when it is deferred until
	 * the streaming turn ends.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): Promise<void> {
		return this._bash.record(command, result, options);
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		this._bash.abort();
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bash.running;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._bash.hasPendingMessages;
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/**
	 * Set a display name for the current session. Resolves after the name commits.
	 */
	setSessionName(name: string): Promise<void> {
		return this._sessionInfo.setName(name);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	navigateTree(targetId: string, options: NavigateTreeOptions = {}): Promise<NavigateTreeResult> {
		return this._navigation.navigateTree(targetId, options);
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		return this._sessionInfo.userMessagesForForking();
	}

	/**
	 * Get session statistics.
	 */
	getSessionStats(): SessionStats {
		return this._sessionInfo.stats();
	}

	/** Documented retention of the current model's reusable prompt prefix; undefined when caching does not apply. */
	getPromptCacheStatus(): PromptCacheStatus | undefined {
		return this._promptCache.status();
	}

	/** Apply changed prompt-cache keepalive settings to the running schedule. */
	promptCacheSettingsChanged(): void {
		this._promptCache.publish();
	}

	getContextUsage(): ContextUsage | undefined {
		return this._sessionInfo.contextUsage();
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	exportToHtml(outputPath?: string): Promise<string> {
		return this._sessionInfo.exportToHtml(outputPath);
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		this._assertActive();
		return exportSessionToJsonl(this.sessionManager, outputPath);
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		return this._sessionInfo.lastAssistantText();
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		return this._extensions.createReplacedSessionContext();
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this.extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensions.runner;
	}
}
