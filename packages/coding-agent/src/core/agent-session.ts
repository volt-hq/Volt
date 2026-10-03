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

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
	AgentAbortSource,
	AgentEvent,
	AgentHarnessNextActionPolicy,
	AgentMessage,
	AgentTool,
	ConversationBranchSummary,
	ConversationBranchSummaryRequest,
	ConversationCompactionCause,
	ConversationCompactionCheck,
	ConversationCompactionDecision,
	ConversationCompactionRequest,
	ConversationCompactionSummary,
	ConversationDelivery,
	ConversationEvent,
	ConversationInput,
	ConversationInputAdmission,
	ConversationPhase,
	ConversationPreparedDelivery,
	ConversationQueue,
	ConversationStreamOptions,
	ConversationTurnReservation,
	PendingToolExecution,
	StreamFn,
	ThinkingLevel,
	ToolCallEvent,
	ToolCallResult,
} from "@hansjm10/volt-agent-core";
import {
	AgentHarnessAdmissionGate,
	Conversation,
	ConversationError,
	type ConversationLog,
	clientInputDigest,
	clientInputRecovery,
} from "@hansjm10/volt-agent-core";
import type {
	Api,
	ImageContent,
	JsonValue,
	Message,
	Model,
	PromptCacheRefresher,
	TextContent,
} from "@hansjm10/volt-ai";
import { estimateToolDefinitionTokens } from "@hansjm10/volt-ai";
import { getAgentDir } from "../config.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import { BackgroundJobDiagnostics } from "./background-job-diagnostics.ts";
import { BackgroundJobManager, type BackgroundJobSource } from "./background-jobs.ts";
import type { BashResult } from "./bash-executor.ts";
import { cloneCanonicalData } from "./canonical-data.ts";
import { compactContext } from "./compaction/context-compaction.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	collectEntriesForBranchSummary,
	estimateMessagesTokens,
	generateBranchSummary,
	prepareCompaction,
	type SummarizationRetryOptions,
} from "./compaction/index.ts";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	type ExtensionRunner,
	type ExtensionUIContext,
	ExtensionUIDismissedError,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
} from "./extensions/index.ts";
import type { PolicyRegistration } from "./extensions/policy-registration.ts";
import { withoutExtensionWork } from "./extensions/work-runtime.ts";
import type { ExtensionWorkLimits } from "./extensions/work-types.ts";
import { GitContextProvider } from "./git-context-provider.ts";
import type { HostInteraction } from "./host-interaction.ts";
import type { LspServerStatus } from "./lsp/manager.ts";
import type { LspServerPool } from "./lsp/server-pool.ts";
import type { McpManager } from "./mcp/manager.ts";
import type { McpManagerEvent } from "./mcp/types.ts";
import { type CustomMessage, type CustomMessageInput, getClientMessageId, withoutClientMessageId } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import { type OperationGrantProfile, RESEARCH_OPERATION_GRANT_PROFILE } from "./operation-authorization.ts";
import type { Personality } from "./personality.ts";
import {
	type AgentMode,
	assertPlanRevision,
	branchPlanningState,
	clonePlanningState,
	clonePlanState,
	derivePlanStepStatus,
	formatPlanCheckpoint,
	getPlanLeafSteps,
	PLAN_CHECKPOINT_CUSTOM_TYPE,
	type PlanExecution,
	type PlanItem,
	type PlanningState,
	type PlanState,
	type PlanStepStatus,
	parsePlanningState,
} from "./planning.ts";
import type { PromptCacheStatus } from "./prompt-cache-status.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { RpcGitContext, UiActionStateDescriptor } from "./rpc/types.ts";
import { SessionBackgroundContinuation } from "./session/background-continuation.ts";
import { SessionBash } from "./session/bash.ts";
import {
	checkResponseCompaction,
	latestCompactionTime,
	shouldCompactBeforeContinuing,
} from "./session/compaction-policy.ts";
import { SessionExtensionBinding } from "./session/extension-binding.ts";
import { SessionExtensionWork } from "./session/extension-work.ts";
import { SessionLifecycle } from "./session/lifecycle.ts";
import { type DefaultPersistenceOptions, ModelSettings } from "./session/model-settings.ts";
import { SessionPromptCache } from "./session/prompt-cache.ts";
import { SessionRetry } from "./session/retry-policy.ts";
import { exportSessionToJsonl, extractUserMessageText, SessionInfo } from "./session/session-info.ts";
import { SessionToolRuntime } from "./session/tool-runtime.ts";
import { SessionTurnPolicy } from "./session/turn-policy.ts";
import { boundClientInputError, normalizeClientInputPayload } from "./session-entry-codec.ts";
import { PRODUCT_SESSION_ENTRY_TYPES } from "./session-entry-types.ts";
import type { BranchSummaryEntry, ClientInputCommand, SessionEntry, SessionManager } from "./session-manager.ts";
import {
	CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES,
	getLatestCompactionEntry,
	type SessionReference,
} from "./session-manager.ts";
import { ConversationSessionWriter, type SessionWriter } from "./session-writer.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { writeToolProgressCapture } from "./tool-progress-capture.ts";
import { ToolProgressDiagnostics } from "./tool-progress-diagnostics.ts";
import type { BashOperations } from "./tools/bash.ts";
import type { SubagentToolManager } from "./tools/index.ts";
import { canonicalizePlanSteps, type PlanStepInput, planStepsSemanticallyEqual } from "./tools/planning.ts";

function cloneAgentMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	return cloneCanonicalData([...messages], "Agent message delivery");
}

function isAgentEvent(event: { type: string }): event is AgentEvent {
	return (
		event.type === "agent_start" ||
		event.type === "agent_end" ||
		event.type === "delivery_start" ||
		event.type === "turn_start" ||
		event.type === "turn_end" ||
		event.type === "message_start" ||
		event.type === "message_update" ||
		event.type === "message_end" ||
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	);
}

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

/**
 * Prefix of the durable identity the session gives input that arrives without
 * one (local TUI, SDK, and extension input). Every input is durable; outcomes
 * are reported only for caller-supplied identities.
 */
const LOCAL_CLIENT_INPUT_ID_PREFIX = "local-";

function createLocalClientInputId(): string {
	return `${LOCAL_CLIENT_INPUT_ID_PREFIX}${randomUUID()}`;
}

/** A runtime message as providers see it: a client user message without its client input identity. */
function withoutClientIdentity(message: AgentMessage): AgentMessage {
	return message.role === "user" && "clientMessageId" in message ? withoutClientMessageId(message) : message;
}

function isLocalClientInputId(clientMessageId: string): boolean {
	return clientMessageId.startsWith(LOCAL_CLIENT_INPUT_ID_PREFIX);
}

function messageText(content: AgentMessage): string {
	if (!("content" in content)) return "";
	const value = content.content;
	if (typeof value === "string") return value;
	return value
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

/** The queue identity projection retains every admitted entry inside its wire budget. */
export const AGENT_SESSION_MAX_QUEUED_MESSAGES = CLIENT_INPUT_MAX_RECOVERABLE_QUEUE_ENTRIES;

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
	| {
			type: "ui_action_state_changed";
			action: string;
			state: UiActionStateDescriptor;
	  }
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
	/** Optional managed extension-work limits; may only tighten the host ceilings. */
	extensionWorkLimits?: Partial<ExtensionWorkLimits>;
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
	/** Optional host interaction bridge for blocking host-initiated actions. */
	hostInteraction?: HostInteraction;
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

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
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
		event: ToolCallEvent,
		signal: AbortSignal,
	) => ToolCallResult | undefined | Promise<ToolCallResult | undefined>;
	nextAction?: AgentHarnessNextActionPolicy;
}

/**
 * A client input this runtime admitted and has not settled: a retry with the
 * same identity joins it. `accepted` settles when the input is admitted (its
 * user message committed, or it was queued or handled); `done` when it
 * completes.
 */
interface LiveClientInput {
	readonly command: ClientInputCommand;
	readonly input: ConversationInput;
	readonly accepted: PromiseWithResolvers<PromptAdmissionOutcome>;
	readonly done: PromiseWithResolvers<void>;
	/** The turn operation it was admitted to start: that turn delivers it, or it fails once that turn ended. */
	operationId: string | undefined;
	/**
	 * Input without a caller identity (local input, a message that triggers a
	 * turn): when its turn or the session stops before delivering it, it is
	 * withdrawn and its caller resolves, as a cancelled run does.
	 */
	local: boolean;
}

type PromptDispatchOutcome = "handled" | "queued" | "run";

export class ClientInputConflictError extends Error {
	readonly code = "client_input_conflict";
}

export class ClientInputOutcomeAmbiguousError extends Error {
	readonly code = "client_input_outcome_ambiguous";
}

/**
 * Raised when {@link AgentSession.clearQueue} revoked the runtime queues but their
 * cancellation could not be made durable. The queues are already gone, so the
 * captured text is carried on the error: it is the only remaining copy of what the
 * user typed, and callers restoring input to an editor must recover it from here.
 */
export class QueueClearPersistenceError extends Error {
	readonly code = "queue_clear_persistence_failed";
	readonly steering: string[];
	readonly followUp: string[];

	constructor(cause: Error, queues: { steering: string[]; followUp: string[] }) {
		super(cause.message, { cause });
		this.steering = queues.steering;
		this.followUp = queues.followUp;
	}
}

/** @internal Preserves the primary constructor failure and every synchronous rollback failure. */
export class AgentSessionConstructionCleanupError extends AggregateError {}

// ============================================================================
// Constants
// ============================================================================

const MAX_COMPACTION_SUMMARY_RETRIES = 2;
const MAX_COMPACTION_RETRY_DELAY_MS = 30_000;

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly gitContextProvider: GitContextProvider;
	private readonly _releaseGitContextProvider: () => void;

	/** The conversation kernel this session runs on, over its session manager's log. */
	private _conversation!: Conversation<AgentTool>;
	/** The log the conversation writes, held from `takeLog` until the conversation closes it. */
	private _log: ConversationLog | undefined;
	/** Writes of this session's log through its conversation. */
	private _sessionWriter!: SessionWriter;
	private readonly _streamFn: StreamFn;
	private readonly _toolProgressDiagnostics: ToolProgressDiagnostics;
	private readonly _backgroundDiagnostics: BackgroundJobDiagnostics;
	private readonly _promptCache: SessionPromptCache;
	private readonly _modelSettings: ModelSettings;
	private readonly _retry: SessionRetry;
	private readonly _bash: SessionBash;
	private readonly _sessionInfo: SessionInfo;
	private readonly _lifecycle: SessionLifecycle;
	private readonly _tools: SessionToolRuntime;
	private readonly _extensions: SessionExtensionBinding;
	private readonly _turnPolicy: SessionTurnPolicy;
	private readonly _background: SessionBackgroundContinuation;

	private readonly _convertToLlm: AgentSessionConfig["convertToLlm"];

	// Event subscription state
	private _unsubscribeConversation?: () => void;
	private _unsubscribeSessionEntries?: () => void;
	private _unsubscribeGitContext?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private readonly _eventListenerGitObservations = new Set<() => void>();
	private readonly _conversationGenerationListeners = new Set<ConversationGenerationListener>();
	private _streamingMessage: AgentMessage | undefined;
	private readonly _pendingToolExecutions = new Map<string, PendingToolExecution>();
	private _runtimeErrorMessage: string | undefined;

	/**
	 * Queue text handed back once the queue can no longer be cleared durably:
	 * captured by the synchronous dispose fence, or by the first clear after
	 * the log is lost. Once it is set, the session shows no queue.
	 */
	private _disposedQueueHandback: { steering: string[]; followUp: string[] } | undefined;
	/** The queue the session last published, serialized, so it publishes only changes. */
	private _publishedQueue: string | undefined;
	/** The ready plan a delivery claimed for its transition to draft, and the input that owns the claim. */
	private _readyPlanClaim: { planKey: string; owner: string | undefined } | undefined;
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];
	private _resumeRecoveredClientInputsPromise: Promise<void> | undefined;
	/** Blocks newer input from overtaking durable queue entries restored at open. */
	private _recoveredClientInputReplayPending = false;
	/** Client inputs this runtime admitted and has not settled, by client message id. */
	private readonly _liveClientInputs = new Map<string, LiveClientInput>();
	/** Inputs whose delivery an extension message hook rejected; they fail when their turn ends. */
	private readonly _failedDeliveryInputs = new Map<string, Error>();
	/** Fatal host errors extension hooks raised, by the turn operation they ran in; its prompt rejects with it. */
	private readonly _turnFatalErrors = new Map<string, Error>();
	/** Inputs extensions sent (`sendUserMessage`) that have not settled; they start no extension work. */
	private readonly _extensionInputIds = new Set<string>();
	private _activeExtensionCommandHandlers = 0;
	/** Distinguishes handler-owned prompts that already completed a custom turn. */
	private _agentSettlementRevision = 0;
	/** Nonexclusive admitted continuations that must settle before runtime resources close. */
	private readonly _admittedAncillaryWork = new Set<Promise<unknown>>();
	/** Queued input whose admission is committing: `waitForIdle` joins the turn it starts. */
	private readonly _queueAdmissions = new Set<Promise<unknown>>();
	/** Prompt/preflight work is detached during replacement to avoid ctx.newSession self-joins. */
	private readonly _admittedPromptWork = new Set<Promise<unknown>>();
	private _activityRevision = 0;
	/** The exclusive operation the conversation last published. */
	private _phaseOperation: ConversationPhase["operation"] = null;
	/** Each prompt turn's `before_agent_start` system prompt override, recorded when its prompt is admitted. */
	private readonly _turnSystemPromptOverrides = new Map<string, string | undefined>();
	/** The turn operation that made a provider request; compaction before it checks the context's tail. */
	private _requestedOperationId: string | undefined;
	/** The turn operation that compacted to recover from a context overflow. */
	private _overflowRecoveredOperationId: string | undefined;
	/** The automatic compaction policy decided on, read by the summarizer and the compaction events. */
	/** The automatic compaction a policy decision started; a retry drops the response it retries from its request. */
	private _pendingCompaction:
		| { reason: CompactionReason; willRetry: boolean; dropTrailing?: "error" | "length" }
		| undefined;
	/** The summary the summarizer produced, reported once its compaction commits. */
	private _compactionSummary: { result: CompactionResult; fromExtension: boolean } | undefined;
	/** The latest committed compaction's result, for the manual compaction that ran it. */
	private _lastCompactionResult: CompactionResult | undefined;
	/** The branch summary navigation prepared for the summarizer. */
	private _pendingBranchSummary:
		| { entries: SessionEntry[]; customInstructions?: string; replaceInstructions?: boolean }
		| undefined;
	/** When the active operation's abort source was first observed, for diagnostics. */
	private _abortObserved: { operationId: string; timestamp: number } | undefined;

	// Agent-run and compaction state
	/** Per-run identity for background waits and provider-result acknowledgement fences. */
	private _activeAgentRun: ActiveAgentRun | undefined = undefined;
	/** Public elapsed timing spans every run and recovery phase before operation settlement. */
	private _activeAgentOperation: ActiveAgentRun | undefined = undefined;
	private _activeCompaction: ActiveCompaction | undefined = undefined;

	/** One admission authority for foreground operations, native tools, and background jobs. */
	private readonly _admissionGate = new AgentHarnessAdmissionGate();
	/** Preflight continuations retain the same revision that fences low-level reservations. */
	private get _abortGeneration(): number {
		return this._admissionGate.revision;
	}
	private _abortPromise: Promise<void> | undefined;
	/** Whether the in-flight stop starts retained queued input once it settles; joined stops can only decline. */
	private _abortQueueDelivery: { requested: boolean } | undefined;

	// Background work outlives individual model turns, but never this session.
	private readonly _backgroundJobs = new BackgroundJobManager({
		admissionGate: this._admissionGate,
		isToolAllowed: (name) =>
			!this._disposed &&
			this._planningState.mode !== "plan" &&
			this._tools.isToolActive(name) &&
			this._tools.isTrustedBuiltin(name),
		getGeneration: () => this._generation(),
		getRunIdentity: () => this._activeAgentRun,
		recordDiagnostic: (event) => this._background.recordDiagnostic(event),
	});
	private _unsubscribeBackgroundJobs?: () => void;

	// Extension system
	private _extensionWork!: SessionExtensionWork;
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
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _cwd: string;
	private _agentDir: string;
	private _disposed = false;

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;
	private _planningState: PlanningState;
	private _planningTransitionQueue: Promise<void> = Promise.resolve();
	private _planningTransitionInFlight = false;
	/** Conversation generation whose successful read currently satisfies the Plan research gate. */
	private _planResearchGeneration: number | undefined;

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
		this._backgroundDiagnostics = new BackgroundJobDiagnostics({
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
		this._planningState = branchPlanningState(this.sessionManager.getConversationState().planning);
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
				emit: (event) => this._emit(event),
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
			hasInFlightWork: () => this._phaseOperation !== null || this.isBusy || this.hasBackgroundJobs,
			isDisposed: () => this._disposed,
			emit: (event) => this._emit(event),
		});
		this._retry = new SessionRetry({
			settingsManager: this.settingsManager,
			conversation: () => this._conversation,
			model: () => this.model,
			overflowRecoveredOperationId: () => this._overflowRecoveredOperationId,
			emit: (event) => this._emit(event),
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
			emit: (event) => this._emit(event),
		});
		this._lifecycle = this._createLifecycle();
		this._tools = new SessionToolRuntime(
			{
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				modelRegistry: this._modelRegistry,
				resourceLoader: this._resourceLoader,
				backgroundJobs: this._backgroundJobs,
				cwd: this._cwd,
				agentDir: this._agentDir,
				lostSignal: this._lostAbort.signal,
				planningController: this,
				conversation: () => this._conversation,
				extensions: () => this._extensions,
				extensionWork: () => this._extensionWork,
				background: () => this._background,
				sessionWriter: () => this._sessionWriter,
				isDisposed: () => this._disposed,
				assertActive: () => this._assertActive(),
				model: () => this.model,
				messages: () => this.messages,
				planningState: () => this._planningState,
				operationGrantProfile: () => this._getOperationGrantProfile(),
				isReviewDiscussion: () => this.isReviewDiscussion,
				emit: (event) => this._emit(event),
			},
			{
				customTools: config.customTools,
				projectCwd: resolvePath(config.projectCwd ?? this._cwd),
				allowedToolNames: config.allowedToolNames,
				allowUnlistedExtensionTools: config.allowUnlistedExtensionTools,
				excludedToolNames: config.excludedToolNames,
				baseToolsOverride: config.baseToolsOverride,
				hostInteraction: config.hostInteraction,
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
				conversation: () => this._conversation,
				tools: () => this._tools,
				extensionWork: () => this._extensionWork,
				background: () => this._background,
				sessionWriter: () => this._sessionWriter,
				assertActive: () => this._assertActive(),
				hasActiveWork: () =>
					this._turnActive ||
					this.isBashRunning ||
					this.hasActiveSessionMutation ||
					this._backgroundJobs.hasActive,
				extensionCommandRunning: () => this._activeExtensionCommandHandlers > 0,
				sendCustomMessage: (message, options, allowDuringPromptTransaction) =>
					this._sendCustomMessage(message, options, allowDuringPromptTransaction),
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
			extensionWork: () => this._extensionWork,
			tools: () => this._tools,
			background: () => this._background,
			isDisposed: () => this._disposed,
			isLost: () => this._lostError !== undefined,
			assertActive: () => this._assertActive(),
			assertNotLost: () => this._assertNotLost(),
			activeToolNames: () => this.getActiveToolNames(),
			operationGrantProfile: () => this._getOperationGrantProfile(),
			planningState: () => this._planningState,
			hasPlanResearch: () => this._planResearchGeneration === this._generation(),
			recordPlanResearch: () => {
				this._planResearchGeneration = this._generation();
			},
			emitExtensionEvent: (event) => this._emitExtensionEvent(event),
			recordTurnFatalError: (error) => this._recordTurnFatalError(error),
			failDelivery: (clientMessageId, error) => {
				this._failedDeliveryInputs.set(clientMessageId, error);
			},
			prepareDelivery: (delivery) => this._prepareDelivery(delivery),
			compactionDecision: (cause, check) => this._compactionDecision(cause, check),
		});
		this._background = new SessionBackgroundContinuation({
			jobs: this._backgroundJobs,
			admissionGate: this._admissionGate,
			diagnostics: this._backgroundDiagnostics,
			toolProgressDiagnostics: this._toolProgressDiagnostics,
			providerStream: (model, context, options) => this._streamFn(model, context, options),
			conversation: () => this._conversation,
			extensionRunner: () => this.extensionRunner,
			turnPolicy: () => this._turnPolicy,
			assertActive: () => this._assertActive(),
			isDisposed: () => this._disposed,
			isLost: () => this._lostError !== undefined,
			activeRun: () => this._activeAgentRun,
			isCompacting: () => this._activeCompaction !== undefined,
			generation: () => this._generation(),
			hasForegroundWork: () =>
				this.isBusy ||
				this._turnActive ||
				this._admittedPromptWork.size > 0 ||
				this._admittedAncillaryWork.size > 0 ||
				this._recoveredClientInputReplayPending ||
				this._conversation.queue.prompt.length > 0,
			hasSessionOperationBarrier: () => this._hasSessionOperationBarrier,
			isToolExecutionPending: (toolCallId) => this._pendingToolExecutions.has(toolCallId),
			trackPromptWork: (work) => this._trackAdmittedPromptWork(work),
		});
	}

	/** Open the conversation over the session's log, then bind the runtime to it. */
	private async _open(config: AgentSessionConfig): Promise<void> {
		const ownsGitContextProvider = config.gitContextProvider === undefined;
		const gitContextSubscriptionFinalizers: Array<() => void> = [];
		try {
			if (ownsGitContextProvider) void this.gitContextProvider.refresh();
			this._tools.attachMcpManagerEvents();
			this._extensionWork = this._createExtensionWork(config.extensionWorkLimits);
			await this._modelSettings.applyInitialSelection(config.model, config.thinkingLevel);
			this._log = this.sessionManager.takeLog();
			this._conversation = await Conversation.open<AgentTool>({
				log: this._log,
				entryTypes: Object.values(PRODUCT_SESSION_ENTRY_TYPES),
				stream: (model, context, options) => this._background.stream(model, context, options),
				resolveModel: (provider, modelId) => this._modelSettings.findModel(provider, modelId),
				...(config.promptCacheRefresh === undefined ? {} : { promptCacheRefresh: config.promptCacheRefresh }),
				summarizer: {
					compact: async (request) => {
						try {
							return await this._summarizeCompaction(request);
						} catch (error) {
							// A turn whose automatic compaction fails reports the failure to its prompt.
							if (request.cause !== "manual" && !request.signal.aborted) {
								const message = error instanceof Error ? error.message : String(error);
								this._recordTurnFatalError(
									new Error(
										request.cause === "overflow"
											? `Context overflow recovery failed: ${message}`
											: `Auto-compaction failed: ${message}`,
										{ cause: error },
									),
								);
							}
							throw error;
						}
					},
					summarizeBranch: async (request) => await this._summarizeBranch(request),
				},
				systemPrompt: () => this._turnSystemPrompt(),
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
				async (event) => await this._onConversationEvent(event),
			);
			this._unsubscribeSessionEntries = this.sessionManager.subscribeEntries((entry) => {
				if (entry.type === "planning_state_change") this._onPlanningCommitted(entry.planning);
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
				this.gitContextProvider.subscribe((gitContext) => this._emit({ type: "git_context_changed", gitContext }), {
					monitor: false,
				}),
			);
			void this.gitContextProvider.refresh();

			this._tools.build({
				activeToolNames: config.initialActiveToolNames,
				includeAllExtensionTools: true,
			});
			this._tools.startPlanningRuntime();
			this._publishQueue();
			await this._readmitRecoveredInputs();
			this._recoveredClientInputReplayPending = clientInputRecovery(this._conversation.state).kind !== "idle";
			this._unsubscribeBackgroundJobs = this._backgroundJobs.subscribe(() => {
				this._activityChanged();
				this._background.jobsChanged();
			});
		} catch (error) {
			this._disposed = true;
			void this._extensionWork?.close();
			void this._backgroundJobs.close();
			void this._backgroundDiagnostics.close();
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
	 * The session lost its log. Nothing it does afterwards can be saved, so it cancels its own
	 * work: the turn (with its retries and compaction), background jobs, bash, and the
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
		this._extensionWork.invalidate();
		const lostInputError = new Error("The session lost its log before the client input settled", { cause: error });
		for (const live of this._liveClientInputs.values()) {
			live.accepted.reject(lostInputError);
			live.done.reject(lostInputError);
		}
		this._liveClientInputs.clear();
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

	setHostInteraction(hostInteraction: HostInteraction | undefined): void {
		this._assertActive();
		this._tools.setHostInteraction(hostInteraction);
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

	/**
	 * The system prompt of a request: the turn's `before_agent_start` override
	 * from when its prompt was admitted, or the base prompt for its tools, then
	 * the trusted policy of the plan state the request runs in. A plan change
	 * the turn's delivery committed (a ready plan back to draft) applies from
	 * its first request.
	 */
	private _turnSystemPrompt(): string {
		const operationId = this._conversation.operation?.id;
		const override = operationId === undefined ? undefined : this._turnSystemPromptOverrides.get(operationId);
		return this._tools.composeSystemPrompt(override ?? this._tools.baseSystemPrompt);
	}

	/** The branch generation: changes exactly when the active branch switches. */
	private _generation(): number {
		return this._conversation?.state.branchSwitchOrdinal ?? 0;
	}

	/**
	 * The first user-bearing delivery while a plan is ready returns the plan to
	 * draft: its planning snapshot and checkpoint commit in the delivery's batch.
	 */
	private _prepareDelivery(delivery: ConversationDelivery): ConversationPreparedDelivery | undefined {
		if (!delivery.messages.some((message) => message.role === "user")) return undefined;
		const readyPlan = this._planningState.plan;
		if (readyPlan?.phase !== "ready") return undefined;
		const planKey = `${readyPlan.id}:${readyPlan.revision}`;
		const owner = delivery.clientMessageId;
		const claim = this._readyPlanClaim;
		if (claim?.planKey === planKey && claim.owner !== owner && this._readyPlanClaimLive(claim.owner)) {
			return undefined;
		}
		this._readyPlanClaim = { planKey, owner };
		const nextPlanningState = parsePlanningState({
			mode: "plan",
			plan: { ...readyPlan, revision: readyPlan.revision + 1, phase: "draft" },
		});
		const checkpoint = this._createPlanningCheckpointMessage(nextPlanningState);
		return {
			messages: checkpoint ? [checkpoint, ...delivery.messages] : [...delivery.messages],
			entries: [{ type: "planning_state_change", payload: { planning: nextPlanningState } }],
		};
	}

	/** Whether the input that claimed a ready-plan transition may still deliver it. */
	private _readyPlanClaimLive(owner: string | undefined): boolean {
		if (owner === undefined) return true;
		const state = this._conversation.state.clientInputs.inputs.get(owner)?.state;
		return state === "accepted" || state === "started";
	}

	/** The session's extension work: invalid limits reject the session's open. */
	private _createExtensionWork(limits: Partial<ExtensionWorkLimits> | undefined): SessionExtensionWork {
		return new SessionExtensionWork(
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
				mode: () => this._planningState.mode,
				skills: () => this._resourceLoader.getSkills().skills,
				isToolActive: (name) => this._tools.isToolActive(name),
				tool: (name) => this._tools.registeredTool(name),
				toolDefinition: (name) => this._tools.registeredDefinition(name),
				trustedOperationResolver: (name) => this._tools.trustedOperationResolver(name),
				operationGrantProfile: () => this._getOperationGrantProfile(),
				turnPolicies: () => this._turnPolicy.registrations,
				policyRevision: () => this._turnPolicy.revision,
				isExtensionInput: (clientMessageId) => this._extensionInputIds.has(clientMessageId),
			},
			limits,
		);
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	private _reportEventProjectionFailure(eventType: AgentSessionEvent["type"], error: unknown): void {
		try {
			this.extensionRunner?.emitError({
				extensionPath: "<runtime>",
				event: "session_event_projection",
				error: `Could not project AgentSession ${eventType} event: ${error instanceof Error ? error.message : String(error)}`,
				...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
			});
		} catch {
			// Runtime diagnostics are passive. Their observers cannot alter an
			// already-committed session outcome or revive an invalid projection.
		}
	}

	/** The active operation's abort source, for tool progress diagnostics. */
	private _diagnosticRun(): { source?: AgentAbortSource; diagnosticTimestamp?: number } | undefined {
		const operation = this._conversation?.operation;
		if (operation?.abortSource === undefined) return undefined;
		if (this._abortObserved?.operationId !== operation.id) {
			this._abortObserved = { operationId: operation.id, timestamp: Date.now() };
		}
		return { source: operation.abortSource, diagnosticTimestamp: this._abortObserved.timestamp };
	}

	/** Publish an isolated passive projection to every public session observer. */
	private _emit(event: AgentSessionEvent): void {
		if (this._lostError) return;
		if (isAgentEvent(event)) {
			try {
				this._toolProgressDiagnostics.observe(event, this._diagnosticRun());
			} catch {
				// Diagnostics are passive and cannot change the session outcome.
			}
		}
		if (event.type === "agent_start" || event.type === "agent_end") {
			this._background.recordRunDiagnostic(event.type === "agent_start" ? "run_start" : "run_end");
		} else if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			this._background.recordDiagnostic({
				kind: event.type === "tool_execution_start" ? "tool_start" : "tool_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				...(event.type === "tool_execution_end" ? { isError: event.isError } : {}),
			});
		}
		if (event.type === "tool_execution_end" || event.type === "agent_settled") {
			this.gitContextProvider.scheduleRefresh();
		}
		if (event.type === "agent_settled") this._backgroundDiagnostics.flush();
		this._dispatchEvent(event);
		if (event.type === "message_start" && event.message.role === "assistant") {
			this._promptCache.requestStarted(event.message);
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			this._promptCache.requestEnded(event.message);
		}
		if (
			event.type === "agent_start" ||
			event.type === "agent_settled" ||
			event.type === "compaction_start" ||
			event.type === "compaction_end" ||
			event.type === "tool_execution_start"
		) {
			this._activityChanged();
		}
		if (event.type === "agent_settled" || event.type === "compaction_end") this._promptCache.publish();
	}

	private _dispatchEvent(event: AgentSessionEvent): void {
		const listeners = [...this._eventListeners];
		const description = `AgentSession ${event.type} event`;
		let canonicalEvent: AgentSessionEvent;
		try {
			canonicalEvent = cloneCanonicalData(event, description);
		} catch (error) {
			this._reportEventProjectionFailure(event.type, error);
			return;
		}

		for (const listener of listeners) {
			let snapshot: AgentSessionEvent;
			try {
				snapshot = cloneCanonicalData(canonicalEvent, description);
			} catch (error) {
				this._reportEventProjectionFailure(event.type, error);
				continue;
			}
			try {
				void Promise.resolve(listener(snapshot)).catch(() => {});
			} catch {
				// Public subscribers are passive projections. Their failure or mutation
				// cannot alter session state or suppress a later subscriber.
			}
		}
	}

	private _ambiguousRecoveredClientInputError(clientMessageId: string): ClientInputOutcomeAmbiguousError {
		return new ClientInputOutcomeAmbiguousError(
			`client_input_outcome_ambiguous: ${JSON.stringify(clientMessageId)} crossed its durable dispatch boundary before restart but has no canonical or terminal record; later queued input remains fenced`,
		);
	}

	/**
	 * The queue: the fold's queued client inputs with a client origin, in
	 * admission order, that the conversation holds for delivery. Input being
	 * delivered or withdrawn has left it. Recovered input fenced behind an
	 * ambiguous predecessor stays visible, though nothing delivers it. Host
	 * messages are queued too, but show no text.
	 */
	private _queueView(): { steering: AgentSessionQueuedMessage[]; followUp: AgentSessionQueuedMessage[] } {
		const steering: AgentSessionQueuedMessage[] = [];
		const followUp: AgentSessionQueuedMessage[] = [];
		if (this._disposedQueueHandback) return { steering, followUp };
		const state = this._conversation.state;
		const queue = this._conversation.queue;
		const held = new Set([...queue.steer, ...queue.followUp].flatMap((message) => getClientMessageId(message) ?? []));
		const fenced = clientInputRecovery(state).kind === "blocked";
		for (const clientMessageId of state.clientInputs.queued) {
			const record = state.clientInputs.inputs.get(clientMessageId);
			const queued = record?.queuedInput;
			if (!queued || record.origin === "host" || (!fenced && !held.has(clientMessageId))) continue;
			(queued.delivery === "steer" ? steering : followUp).push({ clientMessageId, text: queued.message });
		}
		return { steering, followUp };
	}

	/** Publish the queue when it changed since the session last published it. */
	private _publishQueue(): void {
		const queue = this._queueView();
		const serialized = JSON.stringify(queue);
		if (serialized === this._publishedQueue) return;
		this._publishedQueue = serialized;
		this._emit({ type: "queue_update", ...queue });
	}

	/**
	 * Report the outcome of an identified input its client was told is queued:
	 * when its admission completes withdrawn or failed, the client learns it
	 * from `client_input_outcome`. Local input has no client to tell.
	 */
	private _reportQueuedOutcome(admission: ConversationInputAdmission): void {
		const clientMessageId = admission.clientMessageId;
		if (isLocalClientInputId(clientMessageId)) return;
		void admission.completion.then(
			(outcome) => {
				if (outcome.state === "completed") return;
				this._emit({
					type: "client_input_outcome",
					clientMessageId,
					outcome: "failed",
					reason: outcome.state === "withdrawn" ? "queue_cleared" : "dispatch_failed",
				});
			},
			// A conversation that ended first reports no outcome; the input stays recoverable.
			() => undefined,
		);
	}

	/**
	 * Admit again, as idempotent resubmissions that record nothing, the
	 * identified inputs a previous runtime left queued or mid-dispatch, so
	 * their clients learn their outcomes like those of input queued now.
	 */
	private async _readmitRecoveredInputs(): Promise<void> {
		const { inputs, queued, started } = this._conversation.state.clientInputs;
		for (const clientMessageId of [...started, ...queued]) {
			const record = inputs.get(clientMessageId);
			if (!record || record.origin !== undefined || isLocalClientInputId(clientMessageId)) continue;
			const { message, images, streamingBehavior } = record.input;
			const admission = await this._conversation.admitInput(
				record.command,
				{ clientMessageId, message, images, ...(streamingBehavior === undefined ? {} : { streamingBehavior }) },
				{ deliver: false },
			);
			this._reportQueuedOutcome(admission);
		}
	}

	/** Every conversation event, in publication order. */
	private async _onConversationEvent(event: ConversationEvent): Promise<void> {
		if (this._disposed) return;
		switch (event.type) {
			case "committed":
				// The session manager's view already includes the batch. A client input's
				// state can change the queue without the conversation's queue changing.
				if (event.entries.some((entry) => entry.type.startsWith("client_input_"))) this._publishQueue();
				return;
			case "queue_changed":
				this._backgroundJobs.setSteeringPending(event.queue.steer.length > 0);
				this._publishQueue();
				return;
			case "phase_changed":
				await this._onPhaseChanged(event.phase);
				return;
			case "next_action_resolved":
				if (event.stopReason === "policy" || event.stopReason === "tool") this._extensionWork.invalidate();
				this._background.nextActionResolved(event);
				return;
			case "retry_start":
				this._retry.started(event);
				return;
			case "retry_end":
				this._retry.ended(event);
				return;
			case "compaction_start":
				this._activeCompaction ??= { reason: event.cause, startedAt: Date.now() };
				this._emit({ type: "compaction_start", reason: event.cause });
				return;
			case "compaction_end":
				await this._onCompactionEnd(event.cause, event.status, event.error);
				return;
			case "ended":
				// Only the session's own disposal closes its log; any other end loses it.
				if (event.reason !== "closed" || !this._disposed) this._lose(event.error);
				return;
			default: {
				const { basedOn: _basedOn, ...agentEvent } = event;
				await this._handleAgentEvent(agentEvent as AgentEvent);
			}
		}
	}

	/** The conversation's operation changed; a turn that ended settles here. */
	private async _onPhaseChanged(phase: ConversationPhase): Promise<void> {
		const previous = this._phaseOperation;
		this._phaseOperation = phase.operation;
		this._activityRevision++;
		if (previous === "turn" && phase.operation !== "turn") await this._settleTurn();
		if (phase.operation === null) this._turnSystemPromptOverrides.clear();
		this._activityChanged();
	}

	/**
	 * A turn operation ended: inputs it reserved but never delivered fail,
	 * deferred bash output commits, and a turn that ran publishes
	 * `agent_settled`.
	 */
	private async _settleTurn(): Promise<void> {
		const ran = this._activeAgentOperation !== undefined;
		this._activeAgentRun = undefined;
		this._activeAgentOperation = undefined;
		this._streamingMessage = undefined;
		this._pendingToolExecutions.clear();
		this._retry.reset();
		if (this._lostError) return;
		for (const [clientMessageId, error] of [...this._failedDeliveryInputs]) {
			this._failedDeliveryInputs.delete(clientMessageId);
			await this._failClientInput(clientMessageId, error);
		}
		for (const clientMessageId of this._extensionInputIds) {
			const state = this._conversation.state.clientInputs.inputs.get(clientMessageId)?.state;
			if (state === "completed" || state === "failed" || state === "withdrawn") {
				this._extensionInputIds.delete(clientMessageId);
			}
		}
		const activeOperationId = this._conversation.operation?.id;
		for (const [clientMessageId, live] of [...this._liveClientInputs]) {
			// An input its turn ended without delivering: nothing else will.
			const state = this._conversation.state.clientInputs.inputs.get(clientMessageId)?.state;
			if (live.operationId === undefined || live.operationId === activeOperationId) continue;
			if (state !== "accepted" && state !== "started") continue;
			// A hook that failed the turn fails its input; otherwise the turn stopped before delivering it.
			const fatalError = this._turnFatalErrors.get(live.operationId);
			await this._failClientInput(
				clientMessageId,
				fatalError ?? new Error("Client input stopped before its canonical user message committed"),
				fatalError === undefined,
			);
		}
		try {
			await this._bash.flushPending();
		} catch {
			// Deferred bash output is best-effort once its turn ended.
		}
		if (!ran || this._disposed) return;
		this._extensionWork.invalidate();
		this._agentSettlementRevision += 1;
		this._emit({ type: "agent_settled" });
		this._background.schedule();
	}

	/**
	 * Record a client input's failure: its pending delivery is withdrawn and a
	 * prompt that admitted it rejects. A client told its input was queued
	 * learns the outcome from the input's admission.
	 */
	private async _failClientInput(clientMessageId: string, error: Error, interrupted = false): Promise<void> {
		const live = this._liveClientInputs.get(clientMessageId);
		const state = this._conversation.state.clientInputs.inputs.get(clientMessageId)?.state;
		// Local input a stop interrupted before delivery is withdrawn, as a cancelled run is.
		const withdraw = interrupted && live?.local === true && state === "accepted";
		let reported: Error | undefined = error;
		if (state === "accepted" || state === "started") {
			try {
				await this._conversation.settleClientInput(
					clientMessageId,
					withdraw ? { state: "withdrawn" } : { state: "failed", error: boundClientInputError(error.message) },
				);
				if (withdraw) reported = undefined;
			} catch (settleError) {
				reported = settleError instanceof Error ? settleError : new Error(String(settleError));
			}
		}
		if (!live) return;
		this._liveClientInputs.delete(clientMessageId);
		if (reported === undefined) {
			live.accepted.resolve("admitted");
			live.done.resolve();
			return;
		}
		live.accepted.reject(reported);
		live.done.reject(reported);
	}

	/** A planning snapshot committed: it becomes the runtime's plan state. */
	private _onPlanningCommitted(planning: PlanningState): void {
		if (this._disposed || isDeepStrictEqual(planning, this._planningState)) return;
		if (this._planningState.mode !== "plan" || this._planResearchGeneration !== this._generation()) {
			this._planResearchGeneration = undefined;
		}
		this._planningState = clonePlanningState(planning);
		this._tools.syncPlanningRuntime();
		this._emit({ type: "planning_state_changed", planning: clonePlanningState(this._planningState) });
	}

	/** A loop event of the active turn, after its messages committed. */
	private async _handleAgentEvent(event: AgentEvent): Promise<void> {
		if (this._disposed) return;
		if (event.type === "agent_start") {
			this._runtimeErrorMessage = undefined;
			this._retry.runStarted();
			this._activeAgentRun = { startedAt: Date.now() };
			this._activeAgentOperation ??= { ...this._activeAgentRun };
		}
		if (event.type === "agent_end") {
			// Aborted tool calls can skip afterToolCall, leaving their plan-mode
			// authorization records behind; no record outlives its run.
			this._turnPolicy.clearRunRecords();
			this._background.clearRunRecords();
		}
		if (event.type === "turn_start") this._requestedOperationId = this._conversation.operation?.id;
		if (this._lostError !== undefined) return;

		// Delivered messages ran their extension message hooks as they were prepared.
		const delivered = "deliveryId" in event && event.deliveryId !== undefined;
		if (!delivered && event.type !== "message_end" && event.type !== "delivery_start") {
			await this._emitExtensionEvent(event);
			if (this._disposed || this._lostError !== undefined) return;
		}

		if (event.type === "message_start" || event.type === "message_update") {
			this._streamingMessage = event.message;
		} else if (event.type === "message_end") {
			this._streamingMessage = undefined;
		} else if (event.type === "tool_execution_start") {
			this._pendingToolExecutions.set(event.toolCallId, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			});
		} else if (event.type === "tool_execution_update") {
			const existing = this._pendingToolExecutions.get(event.toolCallId);
			const details = (event.partialResult as { details?: unknown } | undefined)?.details;
			if (existing && details !== undefined) {
				this._pendingToolExecutions.set(event.toolCallId, {
					...existing,
					latestDetails: details as JsonValue,
				});
			}
		} else if (event.type === "tool_execution_end") {
			this._pendingToolExecutions.delete(event.toolCallId);
		} else if (event.type === "turn_end") {
			if (event.message.role === "assistant" && event.message.error) {
				this._runtimeErrorMessage = event.message.error.message;
			}
		} else if (event.type === "agent_end") {
			this._streamingMessage = undefined;
			this._pendingToolExecutions.clear();
		}

		// Every continuation carries the original operation timestamp so remote
		// clients retain elapsed time across recovery and delayed delivery.
		if (event.type === "agent_start") {
			this._emit({ type: "agent_start", startedAt: this._activeAgentOperation!.startedAt });
		} else if (event.type === "agent_end") {
			const willRetry = this._retry.takeScheduled();
			this._emit({ ...event, willRetry });
			this._activeAgentRun = undefined;
		} else {
			this._emit(event);
		}

		if (event.type === "delivery_start") {
			const userMessage = event.messages.find((message) => message.role === "user");
			if (userMessage) {
				// Admitted user input independently authorizes this request even if its wake job is cancelled.
				this._background.userInputDelivered();
				this._sessionInfo.maybeGenerateName(
					extractUserMessageText(userMessage.content),
					this._captureConversationGenerationAssertion(),
				);
			}
		}
		if (event.type === "message_end" && delivered) {
			this._background.acknowledgeDeliveredNotice(event.message);
			const clientMessageId = getClientMessageId(event.message);
			if (clientMessageId !== undefined) this._liveClientInputs.get(clientMessageId)?.accepted.resolve("admitted");
		}
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<AgentMessage | undefined> {
		this._assertActive();
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this.extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this.extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this.extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: cloneCanonicalData(event.message, "Extension message_start input"),
			};
			await this.extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent = cloneCanonicalData(
				{
					type: "message_update" as const,
					message: event.message,
					assistantMessageEvent: event.assistantMessageEvent,
				} satisfies MessageUpdateEvent,
				"Extension message_update input",
			);
			await this.extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const message = cloneCanonicalData(event.message, `Agent ${event.message.role} message`);
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message,
			};
			const replacement = await this.extensionRunner.emitMessageEnd(extensionEvent);
			return replacement ?? message;
		} else if (event.type === "tool_execution_start") {
			const extensionEvent = cloneCanonicalData(
				{
					type: "tool_execution_start",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
				} as const,
				"Extension tool_execution_start input",
			) as ToolExecutionStartEvent;
			await this.extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent = cloneCanonicalData(
				{
					type: "tool_execution_update",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					args: event.args,
					partialResult: event.partialResult,
				} as const,
				"Extension tool_execution_update input",
			) as ToolExecutionUpdateEvent;
			await this.extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent = cloneCanonicalData(
				{
					type: "tool_execution_end",
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					result: event.result,
					isError: event.isError,
				} as const,
				"Extension tool_execution_end input",
			) as ToolExecutionEndEvent;
			await this.extensionRunner.emit(extensionEvent);
		}
		return undefined;
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener, options: { monitorGitContext?: boolean } = {}): () => void {
		this._eventListeners.push(listener);
		const releaseGitObservation =
			options.monitorGitContext === false ? undefined : this.gitContextProvider.retainObservation();
		if (releaseGitObservation) this._eventListenerGitObservations.add(releaseGitObservation);
		let unsubscribed = false;

		// Return unsubscribe function for this specific listener
		return () => {
			if (unsubscribed) return;
			unsubscribed = true;
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
			if (releaseGitObservation) {
				this._eventListenerGitObservations.delete(releaseGitObservation);
				releaseGitObservation();
			}
		};
	}

	/**
	 * Observe conversation-generation commits such as tree navigation.
	 *
	 * The callback runs after the navigation committed and the session's
	 * branch-local runtime state was restored from it, giving snapshot
	 * consumers one atomic read boundary for the new generation.
	 */
	subscribeConversationGenerationChanges(listener: ConversationGenerationListener): () => void {
		this._conversationGenerationListeners.add(listener);
		return () => {
			this._conversationGenerationListeners.delete(listener);
		};
	}

	/** The branch generation for branch-sensitive host mutations: the log ordinal of the latest branch switch. */
	get conversationGenerationRevision(): number {
		return this._generation();
	}

	private _notifyConversationGenerationChange(change: ConversationGenerationChange): void {
		if (change.previousLeafId === change.nextLeafId) {
			return;
		}
		for (const listener of this._conversationGenerationListeners) {
			try {
				listener(change);
			} catch {
				// The branch and runtime state are already authoritative. A projection
				// observer cannot make a committed navigation appear to have failed.
			}
		}
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
				this._background.schedule();
			},
			() => {
				this._admittedAncillaryWork.delete(operation);
				this._activityRevision++;
				this._background.schedule();
			},
		);
		return operation;
	}

	/**
	 * Starts input queued before a delivering stop as a fresh turn once that
	 * stop has settled. The stop leaves a terminal aborted assistant message, so
	 * the turn delivers steering first, then follow-ups, and never resumes the
	 * interrupted work on its own.
	 */
	private _deliverQueuedMessagesAfterStop(): void {
		const queue = this._conversation.queue;
		if (
			this._disposed ||
			!this._admissionGate.isOpen ||
			this._lostError !== undefined ||
			this._conversation.operation !== undefined ||
			(queue.steer.length === 0 && queue.followUp.length === 0)
		)
			return;
		const work = this._conversation.continue().catch((error: unknown) => {
			if (this._disposed) return;
			this.extensionRunner.emitError({
				extensionPath: "<runtime>",
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
				this._background.schedule();
			},
			() => {
				this._admittedPromptWork.delete(operation);
				this._activityRevision++;
				this._background.schedule();
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
	 * Call this when completely done with the session.
	 */
	dispose(source: AgentAbortSource = "disposal"): void {
		void this._lifecycle.dispose(source, false);
	}

	/** Join asynchronous teardown after dispose() has installed its synchronous fence. */
	waitForClosed(): Promise<void> {
		return this._lifecycle.waitForClosed();
	}

	/** Dispose an outgoing generation without joining admitted prompt work, which may be what replaces it. */
	disposeForSessionReplacement(): Promise<void> {
		return this._lifecycle.dispose("session_replacement", true);
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
			extensionWork: () => this._extensionWork,
			promptCache: () => this._promptCache,
			isDisposed: () => this._disposed,
			hasSessionOperationBarrier: () => this._hasSessionOperationBarrier,
			activeToolNames: () => this.getActiveToolNames(),
			subagentToolManager: () => this._tools.getSubagentToolManager(),
			appendNotice: (message) => this._sendCustomMessage(message, undefined, false, true),
			fence: () => {
				this._disposed = true;
				this._extensionWork.invalidate();
				this._activeAgentOperation = undefined;
				this._unsubscribeBackgroundJobs?.();
				this._unsubscribeBackgroundJobs = undefined;
				this._promptCache.dispose();
				this._lifetimeAbort.abort(new Error("AgentSession is disposed"));
				this._background.cancelSchedule();
				// Teardown never releases its hold, even if an overlapping abort finishes.
				this._admissionGate.suspend();
				this._background.clearRunRecords();
				this._streamingMessage = undefined;
				this._pendingToolExecutions.clear();
				this._disposedQueueHandback = this._queueText();
			},
			releaseExtensionErrorListener: () => this._extensions.releaseErrorListener(),
			closeBackgroundJobs: () => this._backgroundJobs.close(),
			settleLiveClientInputs: () => {
				const disposalError = new Error("Session disposed before client input completed");
				for (const [clientMessageId, live] of this._liveClientInputs) {
					// A local run the disposal cancels ends quietly, as does a delivered input; an undelivered identified input reports it.
					if (
						live.local ||
						this._conversation.state.clientInputs.inputs.get(clientMessageId)?.state === "completed"
					) {
						live.accepted.resolve("admitted");
						live.done.resolve();
						continue;
					}
					live.accepted.reject(disposalError);
					live.done.reject(disposalError);
				}
				this._liveClientInputs.clear();
			},
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
				for (const releaseObservation of this._eventListenerGitObservations) releaseObservation();
				this._eventListenerGitObservations.clear();
				this._releaseGitContextProvider();
				this._eventListeners = [];
				this._conversationGenerationListeners.clear();
			},
			closeBackgroundDiagnostics: () => this._backgroundDiagnostics.close(),
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
			streamingMessage: this._streamingMessage === undefined ? undefined : structuredClone(this._streamingMessage),
			pendingToolCalls: new Set(this._pendingToolExecutions.keys()),
			pendingToolExecutions: new Map(
				[...this._pendingToolExecutions].map(
					([toolCallId, execution]) => [toolCallId, structuredClone(execution)] as const,
				),
			),
			errorMessage: this._runtimeErrorMessage,
		};
	}

	/** Current runtime cancellation signal, when a conversation operation is active. */
	get signal(): AbortSignal | undefined {
		return this._conversation.operation?.signal;
	}

	/** Read-only active tool execution projection for RPC and UI state. */
	get activeToolExecutions(): ReadonlyMap<string, PendingToolExecution> {
		return new Map(
			[...this._pendingToolExecutions].map(
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

	private _getOperationGrantProfile(): OperationGrantProfile | undefined {
		return this._planningState.mode === "plan" ? RESEARCH_OPERATION_GRANT_PROFILE : undefined;
	}

	get agentMode(): AgentMode {
		this._assertNotDisposed();
		return this._planningState.mode;
	}

	get planningState(): PlanningState {
		this._assertNotDisposed();
		return branchPlanningState(this.sessionManager.getConversationState().planning);
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

	/** Local UI access to this runtime's branch-scoped background jobs. */
	get backgroundJobs(): BackgroundJobSource {
		return this._backgroundJobs;
	}

	/** Whether session-owned background jobs are running or still cancelling. */
	get hasBackgroundJobs(): boolean {
		return this._backgroundJobs.hasActive;
	}

	/**
	 * Whether the conversation is busy: an operation (a turn, compaction, tree
	 * navigation, or reload) holds it, or a `!` command or extension command runs.
	 */
	get isBusy(): boolean {
		return this._conversation.busy;
	}

	/**
	 * An `isBusy` or `hasBackgroundJobs` input changed. Prompt-cache keepalive measures its idle
	 * window from these transitions.
	 */
	private _activityChanged(): void {
		this._promptCache.activityChanged();
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
		return this._conversation.subscribe(async (event) => {
			if (!isAgentEvent(event)) return;
			const { basedOn: _basedOn, ...agentEvent } = event;
			await listener(agentEvent as AgentEvent);
		});
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

	private _planningStateNeedsCheckpoint(state: PlanningState): boolean {
		return state.plan !== null && (state.mode === "plan" || state.plan.phase === "active");
	}

	private _createPlanningCheckpointMessage(state: PlanningState): CustomMessage | undefined {
		if (!this._planningStateNeedsCheckpoint(state)) return undefined;
		const content = formatPlanCheckpoint(state);
		if (!content) return undefined;
		return {
			role: "custom",
			customType: PLAN_CHECKPOINT_CUSTOM_TYPE,
			content,
			display: false,
			timestamp: Date.now(),
		};
	}

	private async _deliverPlanningCheckpoint(state: PlanningState): Promise<void> {
		const message = this._createPlanningCheckpointMessage(state);
		if (!message) return;
		if (this._turnActive) {
			await this._trackQueueAdmission(this._conversation.queueMessages("steer", [message]));
			return;
		}
		await this._sessionWriter.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	/**
	 * Commit a Plan mode snapshot. Runs inside a planning transition; the
	 * committed snapshot becomes the runtime's plan state and is published as
	 * it commits.
	 */
	private async _commitPlanningState(next: PlanningState): Promise<PlanningState> {
		this._assertActive();
		const parsed = parsePlanningState(next);
		if (parsed.mode === "plan" && this._backgroundJobs.hasActive) {
			throw new Error("Cannot enter Plan mode while background jobs are active; abort or wait for them to finish");
		}
		await this._sessionWriter.appendPlanningState(parsed);
		this._assertActive();
		return clonePlanningState(this._planningState);
	}

	private _draftFromExecutedPlan(plan: PlanState): PlanState {
		const cloned = clonePlanState(plan);
		return {
			id: cloned.id,
			revision: cloned.revision + 1,
			phase: "draft",
			...(cloned.title ? { title: cloned.title } : {}),
			...(cloned.summary ? { summary: cloned.summary } : {}),
			steps: cloned.steps,
		};
	}

	/**
	 * Planning transitions run one at a time. They may suspend at an await (MCP
	 * restoration, the planning commit) while the event loop keeps running, so
	 * they re-validate planning state after every await before committing, and
	 * a plan mutation called while one is suspended mid-flight is refused.
	 */
	private _enqueuePlanningTransition<T>(transition: () => Promise<T>): Promise<T> {
		this._assertActive();
		const result = this._planningTransitionQueue.then(async () => {
			this._assertActive();
			this._planningTransitionInFlight = true;
			try {
				return await transition();
			} finally {
				this._planningTransitionInFlight = false;
			}
		});
		const tracked = this._trackAdmittedAncillaryWork(result);
		this._planningTransitionQueue = tracked.then(
			() => undefined,
			() => undefined,
		);
		return tracked;
	}

	private _assertNoPlanningTransitionInFlight(action: string): void {
		this._assertActive();
		if (this._planningTransitionInFlight) {
			throw new Error(`${action} is unavailable while a planning transition is in progress; retry once it settles`);
		}
	}

	setAgentMode(mode: AgentMode): Promise<PlanningState> {
		return this._enqueuePlanningTransition(() => this._setAgentMode(mode));
	}

	private async _setAgentMode(mode: AgentMode): Promise<PlanningState> {
		if (mode === "build" && this._planningState.mode === "plan") {
			await this._tools.prepareUnrestrictedMcpForBuild();
		}
		if (mode === this._planningState.mode) {
			return this.planningState;
		}
		const plan = this._planningState.plan;
		if (mode === "plan") {
			this._planResearchGeneration = undefined;
		}
		if (mode === "plan" && plan?.phase === "active") {
			const next = await this._commitPlanningState({ mode, plan: this._draftFromExecutedPlan(plan) });
			await this._deliverPlanningCheckpoint(next);
			return next;
		}
		if (mode === "plan" && (plan?.phase === "completed" || plan?.phase === "handed_off")) {
			return this._commitPlanningState({ mode, plan: null });
		}
		const next = await this._commitPlanningState({ ...clonePlanningState(this._planningState), mode });
		if (mode === "plan" && next.plan?.phase === "draft") {
			await this._deliverPlanningCheckpoint(next);
		}
		return next;
	}

	toggleAgentMode(): Promise<PlanningState> {
		return this._enqueuePlanningTransition(() => this._setAgentMode(this.agentMode === "plan" ? "build" : "plan"));
	}

	/** Commit a draft plan update; resolves after the new revision commits. */
	async updatePlan(input: {
		planId?: string;
		expectedRevision?: number;
		title?: string;
		summary?: string;
		steps: PlanStepInput[];
	}): Promise<PlanState> {
		this._assertNoPlanningTransitionInFlight("update_plan");
		return this._enqueuePlanningTransition(() => this._updatePlan(input));
	}

	private async _updatePlan(input: {
		planId?: string;
		expectedRevision?: number;
		title?: string;
		summary?: string;
		steps: PlanStepInput[];
	}): Promise<PlanState> {
		if (this._planningState.mode !== "plan") {
			throw new Error("update_plan is available only in Plan mode");
		}
		const previous = this._planningState.plan;
		if (previous) {
			if (previous.phase !== "draft") {
				throw new Error("Only a draft plan can be updated");
			}
			if (input.planId === undefined || input.expectedRevision === undefined) {
				throw new Error("Updating an existing plan requires planId and expectedRevision");
			}
			assertPlanRevision(this._planningState, input.planId, input.expectedRevision);
		} else if (input.planId !== undefined || input.expectedRevision !== undefined) {
			throw new Error("A new plan must not provide planId or expectedRevision");
		}
		const title = input.title?.trim() || previous?.title;
		const summary = input.summary?.trim() || previous?.summary;
		const steps = canonicalizePlanSteps(input.steps, previous ?? undefined);
		if (
			previous &&
			previous.title === title &&
			previous.summary === summary &&
			// Ids are deliberately ignored: identical content and progress in the
			// same hierarchy is the same checklist, so id-less resends cannot churn.
			planStepsSemanticallyEqual(previous.steps, steps)
		) {
			throw new Error("Plan update made no changes; continue research or submit the current draft");
		}
		const plan: PlanState = {
			id: previous?.id ?? randomUUID(),
			revision: (previous?.revision ?? 0) + 1,
			phase: "draft",
			...(title ? { title } : {}),
			...(summary ? { summary } : {}),
			steps,
		};
		await this._commitPlanningState({ mode: "plan", plan });
		return clonePlanState(plan);
	}

	/** Commit approved plan progress; resolves after the new revision commits. */
	async updatePlanProgress(input: {
		planId: string;
		expectedRevision: number;
		updates: Array<{ id: string; status: PlanStepStatus; note?: string }>;
	}): Promise<PlanState> {
		this._assertNoPlanningTransitionInFlight("update_plan_progress");
		return this._enqueuePlanningTransition(() => this._updatePlanProgress(input));
	}

	private async _updatePlanProgress(input: {
		planId: string;
		expectedRevision: number;
		updates: Array<{ id: string; status: PlanStepStatus; note?: string }>;
	}): Promise<PlanState> {
		if (this._planningState.mode !== "build" || this._planningState.plan?.phase !== "active") {
			throw new Error("update_plan_progress is available only during approved plan execution");
		}
		assertPlanRevision(this._planningState, input.planId, input.expectedRevision);
		if (input.updates.length === 0) {
			throw new Error("At least one plan progress update is required");
		}
		const updates = new Map<string, { status: PlanStepStatus; note?: string }>();
		const executableIds = new Set(getPlanLeafSteps(this._planningState.plan).map((step) => step.id));
		const groupIds = new Set(
			this._planningState.plan.steps.filter((step) => step.substeps !== undefined).map((step) => step.id),
		);
		for (const update of input.updates) {
			const id = update.id.trim();
			if (groupIds.has(id)) {
				throw new Error(`Plan progress cannot update group outcome id: ${id}`);
			}
			if (!id || !executableIds.has(id)) {
				throw new Error(`Plan progress references an unknown executable leaf id: ${update.id}`);
			}
			if (updates.has(id)) {
				throw new Error(`Plan progress duplicates executable leaf id: ${id}`);
			}
			updates.set(id, {
				status: update.status,
				...(update.note === undefined ? {} : { note: update.note }),
			});
		}
		const applyUpdate = (step: PlanItem): PlanItem => {
			const update = updates.get(step.id);
			if (!update) return { ...step };
			const note = update.note === undefined ? step.note : update.note.trim() || undefined;
			return {
				id: step.id,
				text: step.text,
				status: update.status,
				...(note ? { note } : {}),
			};
		};
		const steps: PlanState["steps"] = this._planningState.plan.steps.map((step) => {
			if (!step.substeps) return applyUpdate(step);
			const substeps = step.substeps.map(applyUpdate);
			return { id: step.id, text: step.text, status: derivePlanStepStatus(substeps), substeps };
		});
		if (planStepsSemanticallyEqual(this._planningState.plan.steps, steps)) {
			throw new Error("Plan progress update made no changes");
		}
		const plan: PlanState = {
			...this._planningState.plan,
			revision: this._planningState.plan.revision + 1,
			phase: getPlanLeafSteps({ steps }).every((step) => step.status === "completed") ? "completed" : "active",
			steps,
		};
		await this._commitPlanningState({ mode: "build", plan });
		return clonePlanState(plan);
	}

	/** Return approved execution to a draft; resolves after the draft commits. */
	async requestReplan(input: { planId: string; expectedRevision: number; reason: string }): Promise<PlanningState> {
		this._assertNoPlanningTransitionInFlight("request_replan");
		return this._enqueuePlanningTransition(async () => this._requestReplan(input));
	}

	private async _requestReplan(input: {
		planId: string;
		expectedRevision: number;
		reason: string;
	}): Promise<PlanningState> {
		if (this._planningState.mode !== "build" || this._planningState.plan?.phase !== "active") {
			throw new Error("request_replan is available only during approved plan execution");
		}
		assertPlanRevision(this._planningState, input.planId, input.expectedRevision);
		if (!input.reason.trim()) {
			throw new Error("request_replan requires implementation evidence");
		}
		this._planResearchGeneration = undefined;
		return this._commitPlanningState({
			mode: "plan",
			plan: this._draftFromExecutedPlan(this._planningState.plan),
		});
	}

	/** Submit a draft plan for approval; resolves after the ready plan commits. */
	async submitPlan(input: {
		planId: string;
		expectedRevision: number;
		title: string;
		summary: string;
	}): Promise<PlanState> {
		this._assertNoPlanningTransitionInFlight("submit_plan");
		return this._enqueuePlanningTransition(() => this._submitPlan(input));
	}

	private async _submitPlan(input: {
		planId: string;
		expectedRevision: number;
		title: string;
		summary: string;
	}): Promise<PlanState> {
		if (this._planningState.mode !== "plan") {
			throw new Error("submit_plan is available only in Plan mode");
		}
		assertPlanRevision(this._planningState, input.planId, input.expectedRevision);
		if (this._planningState.plan.phase !== "draft") {
			throw new Error("Only a draft plan can be submitted");
		}
		if (this._planningState.plan.steps.length === 0) {
			throw new Error("A plan must contain at least one checklist step");
		}
		if (!input.title.trim() || !input.summary.trim()) {
			throw new Error("A submitted plan requires a non-empty title and summary");
		}
		const plan: PlanState = {
			...this._planningState.plan,
			revision: this._planningState.plan.revision + 1,
			phase: "ready",
			title: input.title.trim(),
			summary: input.summary.trim(),
		};
		await this._commitPlanningState({ mode: "plan", plan });
		return clonePlanState(plan);
	}

	/** Return a ready plan to a draft; resolves after the draft commits. */
	async changePlan(planId: string, expectedRevision: number): Promise<PlanningState> {
		this._assertNoPlanningTransitionInFlight("changePlan");
		return this._enqueuePlanningTransition(() => this._changeReadyPlanToDraft(planId, expectedRevision, true));
	}

	private async _changeReadyPlanToDraft(
		planId: string,
		expectedRevision: number,
		deliverCheckpoint: boolean,
	): Promise<PlanningState> {
		assertPlanRevision(this._planningState, planId, expectedRevision);
		if (this._planningState.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be changed");
		}
		// Only same-generation Plan feedback can reuse the successful read that
		// supported the ready plan. Build entry and branch navigation fail closed.
		if (this._planningState.mode !== "plan" || this._planResearchGeneration !== this._generation()) {
			this._planResearchGeneration = undefined;
		}
		const next = await this._commitPlanningState({
			mode: "plan",
			plan: {
				...this._planningState.plan,
				revision: this._planningState.plan.revision + 1,
				phase: "draft",
			},
		});
		if (deliverCheckpoint) {
			await this._deliverPlanningCheckpoint(next);
		}
		return next;
	}

	/** Discard the plan; resolves after the cleared planning state commits. */
	async discardPlan(planId: string, expectedRevision: number): Promise<PlanningState> {
		this._assertNoPlanningTransitionInFlight("discardPlan");
		return this._enqueuePlanningTransition(async () => {
			assertPlanRevision(this._planningState, planId, expectedRevision);
			this._planResearchGeneration = undefined;
			return this._commitPlanningState({ mode: this._planningState.mode, plan: null });
		});
	}

	activatePlan(
		planId: string,
		expectedRevision: number,
		execution: PlanExecution,
	): Promise<{ planning: PlanningState; activated: boolean }> {
		return this._enqueuePlanningTransition(() => this._activatePlan(planId, expectedRevision, execution));
	}

	private async _activatePlan(
		planId: string,
		expectedRevision: number,
		execution: PlanExecution,
	): Promise<{ planning: PlanningState; activated: boolean }> {
		if (this.isReviewDiscussion && execution.strategy !== "retain_context") {
			throw new Error("Finding discussions execute plans in the current context; reset through the source review");
		}
		let currentPlan = this._planningState.plan;
		if (
			currentPlan?.id === planId &&
			currentPlan.execution?.approvedRevision === expectedRevision &&
			currentPlan.execution.strategy === execution.strategy
		) {
			return { planning: this.planningState, activated: false };
		}
		assertPlanRevision(this._planningState, planId, expectedRevision);
		if (this._planningState.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be executed");
		}
		if (this._planningState.mode === "plan") {
			await this._tools.prepareUnrestrictedMcpForBuild();
		}
		currentPlan = this._planningState.plan;
		if (
			currentPlan?.id === planId &&
			currentPlan.execution?.approvedRevision === expectedRevision &&
			currentPlan.execution.strategy === execution.strategy
		) {
			return { planning: this.planningState, activated: false };
		}
		assertPlanRevision(this._planningState, planId, expectedRevision);
		if (this._planningState.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be executed");
		}
		return {
			planning: await this._commitPlanningState({
				mode: "build",
				plan: {
					...this._planningState.plan,
					revision: this._planningState.plan.revision + 1,
					phase: "active",
					execution,
				},
			}),
			activated: true,
		};
	}

	markPlanHandedOff(planId: string, expectedRevision: number, execution: PlanExecution): Promise<PlanningState> {
		return this._enqueuePlanningTransition(() => this._markPlanHandedOff(planId, expectedRevision, execution));
	}

	private async _markPlanHandedOff(
		planId: string,
		expectedRevision: number,
		execution: PlanExecution,
	): Promise<PlanningState> {
		if (this.isReviewDiscussion) {
			throw new Error(
				"Finding discussions cannot hand off their source-linked identity; execute in the current context",
			);
		}
		assertPlanRevision(this._planningState, planId, expectedRevision);
		if (this._planningState.plan.phase !== "ready") {
			throw new Error("Only a ready plan can be handed off");
		}
		if (this._planningState.mode === "plan") {
			await this._tools.prepareUnrestrictedMcpForBuild();
			assertPlanRevision(this._planningState, planId, expectedRevision);
			if (this._planningState.plan.phase !== "ready") {
				throw new Error("Only a ready plan can be handed off");
			}
		}
		return this._commitPlanningState({
			mode: "build",
			plan: {
				...this._planningState.plan,
				revision: this._planningState.plan.revision + 1,
				phase: "handed_off",
				execution,
			},
		});
	}

	/** Active logical-operation timing, including automatic compaction and retry backoff. */
	get activeAgentRun(): ActiveAgentRun | undefined {
		return this._activeAgentOperation ? { ...this._activeAgentOperation } : undefined;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return this._activeCompaction !== undefined;
	}

	/** Active context compaction metadata, if compaction is currently running. */
	get activeCompaction(): ActiveCompaction | undefined {
		return this._activeCompaction ? { ...this._activeCompaction } : undefined;
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		this._assertNotDisposed();
		return cloneAgentMessages(this.sessionManager.getConversationState().context.messages);
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

	/** A client input as the conversation admits it, normalized like the session log stores it. */
	private _conversationInput(
		command: ClientInputCommand,
		clientMessageId: string,
		text: string,
		images: readonly ImageContent[] | undefined,
		streamingBehavior?: "steer" | "followUp",
	): ConversationInput {
		const payload = normalizeClientInputPayload(command, {
			message: text,
			...(images === undefined ? {} : { images }),
			...(streamingBehavior === undefined ? {} : { streamingBehavior }),
		});
		return {
			clientMessageId,
			message: payload.message,
			images: payload.images,
			...(payload.streamingBehavior === undefined ? {} : { streamingBehavior: payload.streamingBehavior }),
		};
	}

	private _createLiveClientInput(
		command: ClientInputCommand,
		input: ConversationInput,
		local = false,
	): LiveClientInput {
		const live: LiveClientInput = {
			command,
			input,
			accepted: Promise.withResolvers<PromptAdmissionOutcome>(),
			done: Promise.withResolvers<void>(),
			operationId: undefined,
			local,
		};
		void live.accepted.promise.catch(() => {});
		void live.done.promise.catch(() => {});
		return live;
	}

	/** Map a conversation's input errors to the session's. */
	private _clientInputError(error: unknown): Error {
		if (error instanceof ConversationError && error.code === "client_input_conflict") {
			return new ClientInputConflictError(`client_input_conflict: ${error.message}`);
		}
		return error instanceof Error ? error : new Error(String(error));
	}

	/**
	 * The outcome of an identified input an earlier admission already recorded,
	 * when this runtime holds no live admission of it: completed, still queued
	 * (`admitted`), or an error. Undefined for a new input.
	 */
	private async _existingClientInput(
		command: ClientInputCommand,
		input: ConversationInput,
	): Promise<PromptAdmissionOutcome | undefined> {
		const clientMessageId = input.clientMessageId;
		if (clientMessageId === undefined) return undefined;
		const record = this._conversation.state.clientInputs.inputs.get(clientMessageId);
		if (!record) return undefined;
		const digest = await clientInputDigest(command, {
			message: input.message,
			images: [...(input.images ?? [])],
			...(input.streamingBehavior === undefined ? {} : { streamingBehavior: input.streamingBehavior }),
		});
		if (record.command !== command || record.origin !== undefined || record.semanticDigest !== digest) {
			throw new ClientInputConflictError(
				`client_input_conflict: ${JSON.stringify(clientMessageId)} was already used for different input`,
			);
		}
		switch (record.state) {
			case "completed":
				return "completed";
			case "failed":
				throw new Error(record.error ?? "client_input_failed: the original input failed before commit");
			case "withdrawn":
				throw new Error("client_input_failed: queued input was cleared before canonical consumption");
			case "started":
				throw new ClientInputOutcomeAmbiguousError(
					`client_input_outcome_ambiguous: ${JSON.stringify(clientMessageId)} started before the host restarted but has no durable terminal record; it was not replayed`,
				);
			case "accepted": {
				// A queued input is delivered in order.
				if (record.queuedInput) return "admitted";
				// An earlier runtime admitted it and stopped before any side effect or delivery.
				const error = new Error(
					"client_input_failed: the input was interrupted before it was delivered; submit it again",
				);
				await this._conversation.settleClientInput(clientMessageId, {
					state: "failed",
					error: boundClientInputError(error.message),
				});
				throw error;
			}
		}
	}

	/**
	 * Admit an identified prompt before its preflight: a durable receipt that a
	 * retry with the same identity joins, conflicts with, or reads the outcome
	 * of. The input stays undelivered until the prompt delivers or settles it.
	 */
	private async _admitClientInput(
		input: ConversationInput,
	): Promise<
		{ kind: "completed" } | { kind: "live"; live: LiveClientInput } | { kind: "start"; live: LiveClientInput }
	> {
		const clientMessageId = input.clientMessageId!;
		const join = (live: LiveClientInput): { kind: "live"; live: LiveClientInput } => {
			if (live.command !== "prompt" || !isDeepStrictEqual(live.input, input)) {
				throw new ClientInputConflictError(
					`client_input_conflict: ${JSON.stringify(clientMessageId)} was already used for different input`,
				);
			}
			return { kind: "live", live };
		};
		const live = this._liveClientInputs.get(clientMessageId);
		if (live) return join(live);
		const abortGeneration = this._abortGeneration;
		const existing = await this._existingClientInput("prompt", input);
		// A duplicate whose admission started while this one checked the log is joined.
		const concurrent = this._liveClientInputs.get(clientMessageId);
		if (concurrent) return join(concurrent);
		if (existing === "completed") return { kind: "completed" };
		if (existing === "admitted") {
			const queued = this._createLiveClientInput("prompt", input);
			queued.accepted.resolve("admitted");
			queued.done.resolve();
			return { kind: "live", live: queued };
		}
		// Registered before the receipt commits, so a retry meanwhile joins it.
		const started = this._createLiveClientInput("prompt", input);
		this._liveClientInputs.set(clientMessageId, started);
		try {
			await this._conversation.admitInput("prompt", input, { deliver: false });
			if (this._disposed) throw new Error("Session disposed before client input admission completed");
			if (abortGeneration !== this._abortGeneration) {
				throw new Error("Client input admission was aborted before its receipt became durable");
			}
		} catch (error) {
			const admissionError = this._clientInputError(error);
			if (this._liveClientInputs.get(clientMessageId) === started) {
				await this._failClientInput(clientMessageId, admissionError);
			}
			started.accepted.reject(admissionError);
			started.done.reject(admissionError);
			throw admissionError;
		}
		return { kind: "start", live: started };
	}

	/**
	 * Record that an identified input reached a side-effect boundary (an
	 * extension command, input hook, or `before_agent_start`): after a restart
	 * it is ambiguous and never run again.
	 */
	private async _markClientInputStarted(clientMessageId: string | undefined, abortGeneration: number): Promise<void> {
		if (clientMessageId === undefined) return;
		if (this._disposed) throw new Error("Session disposed before client input dispatch");
		if (abortGeneration !== this._abortGeneration) {
			throw new Error("Client input was aborted before its dispatch boundary");
		}
		if (this._conversation.state.clientInputs.inputs.get(clientMessageId)?.state !== "accepted") return;
		await this._conversation.markInputStarted(clientMessageId);
		if (this._disposed) throw new Error("Session disposed before client input dispatch");
		if (abortGeneration !== this._abortGeneration) {
			throw new Error("Client input was aborted while persisting its dispatch boundary");
		}
	}

	private _completeLiveClientInput(clientMessageId: string, outcome: PromptAdmissionOutcome): void {
		const live = this._liveClientInputs.get(clientMessageId);
		if (!live) return;
		this._liveClientInputs.delete(clientMessageId);
		live.accepted.resolve(outcome);
		live.done.resolve();
	}

	private _observeLivePrompt(
		live: LiveClientInput,
		preflightResult: ((result: PromptPreflightResult) => void) | undefined,
	): Promise<void> {
		void live.accepted.promise.then(
			(outcome) => preflightResult?.({ success: true, outcome }),
			() => preflightResult?.({ success: false }),
		);
		return live.accepted.promise.then(() => live.done.promise);
	}

	/**
	 * Replays recoverable queued client input after the runtime is fully ready:
	 * one turn delivers the recovered steering input, then the follow-ups, in
	 * their admission order. Interrupted provider/tool work is never resumed. A
	 * started input without an outcome blocks the replay as ambiguous. Finding
	 * discussions never replay: their interrupted inputs fail.
	 */
	resumeRecoveredClientInputs(): Promise<void> {
		this._assertActive();
		if (this._resumeRecoveredClientInputsPromise) {
			return this._resumeRecoveredClientInputsPromise;
		}
		if (this.isBusy || this._disposed) {
			return Promise.reject(new Error("Cannot resume recovered client input while the agent runtime is busy"));
		}
		if (!this._admissionGate.isOpen) {
			return Promise.reject(new Error("Operation admission is suspended"));
		}
		const abortGeneration = this._abortGeneration;
		if (this.isReviewDiscussion) this._recoveredClientInputReplayPending = true;
		const resume = (async () => {
			if (this._disposed || abortGeneration !== this._abortGeneration) {
				throw new Error("Recovered client input resume was aborted before it started");
			}
			if (this.isReviewDiscussion) {
				const interrupted = [...this._conversation.state.clientInputs.inputs.values()].filter(
					(record) => record.state === "accepted" || record.state === "started",
				);
				for (const record of interrupted) {
					await this._conversation.settleClientInput(record.clientMessageId, {
						state: "failed",
						error: "Review discussion interrupted; submit a new prompt to retry explicitly.",
					});
					this._assertActive();
					if (abortGeneration !== this._abortGeneration) throw new Error("Review recovery was aborted");
				}
				this._recoveredClientInputReplayPending = false;
				return;
			}
			const recovery = clientInputRecovery(this._conversation.state);
			if (recovery.kind === "blocked") {
				this._recoveredClientInputReplayPending = true;
				throw this._ambiguousRecoveredClientInputError(recovery.blocker.clientMessageId);
			}
			if (recovery.kind === "idle") {
				this._recoveredClientInputReplayPending = false;
				return;
			}
			const replay = this._conversation.continue();
			const operationId = this._conversation.operation?.id;
			await replay;
			await this._conversation.waitForIdle();
			// A hook that failed the replayed delivery reports to the resume caller.
			const fatalError = operationId === undefined ? undefined : this._turnFatalErrors.get(operationId);
			if (fatalError) throw fatalError;
			const remaining = clientInputRecovery(this._conversation.state);
			this._recoveredClientInputReplayPending = remaining.kind !== "idle";
			if (remaining.kind === "blocked") {
				throw this._ambiguousRecoveredClientInputError(remaining.blocker.clientMessageId);
			}
			if (remaining.kind === "replay") {
				throw new Error("Recovered client input stopped before the durable queue fully drained");
			}
		})();
		const tracked = this._trackAdmittedAncillaryWork(resume);
		this._resumeRecoveredClientInputsPromise = tracked;
		void tracked.catch(() => {
			if (this._resumeRecoveredClientInputsPromise === tracked) {
				this._resumeRecoveredClientInputsPromise = undefined;
			}
		});
		return tracked;
	}

	private _assertRecoveredClientInputOrdering(clientMessageId: string | undefined): void {
		if (!this._recoveredClientInputReplayPending) return;
		if (this.isReviewDiscussion && this._resumeRecoveredClientInputsPromise) {
			throw new Error("Review discussion input recovery must settle before another prompt is admitted");
		}
		const recovery = clientInputRecovery(this._conversation.state);
		if (recovery.kind === "idle") {
			// Queue cancellation/terminalization is authoritative and releases the
			// fence even after a previous replay attempt failed.
			this._recoveredClientInputReplayPending = false;
			return;
		}
		// Idempotent retries for an already-restored receipt may still join/replay
		// their original outcome. Only a distinct input could overtake the queue.
		if (
			clientMessageId !== undefined &&
			(recovery.records.some((record) => record.clientMessageId === clientMessageId) ||
				(recovery.kind === "blocked" && recovery.blocker.clientMessageId === clientMessageId))
		) {
			return;
		}
		if (recovery.kind === "blocked") {
			throw new Error(
				`Ambiguous recovered client input ${JSON.stringify(recovery.blocker.clientMessageId)} must be resolved before later or fresh input can be admitted`,
			);
		}
		throw new Error("Recovered client input must finish replaying before fresh input can be admitted");
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/** A handled command or input hook ran no turn: publish the settlement a turn would have. */
	private _emitHandledSettlement(): void {
		if (this._conversation.operation !== undefined) return;
		this._extensionWork.invalidate();
		this._agentSettlementRevision += 1;
		this._emit({ type: "agent_settled" });
		this._background.schedule();
	}

	/** Wait for the agent and any session-level prompt work to settle, excluding background jobs. */
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

	/** Join background job settlement without cancelling work or blocking foreground prompts. */
	waitForBackgroundJobs(): Promise<void> {
		return this._backgroundJobs.waitForIdle();
	}

	/** Track queued input while its admission commits, so `waitForIdle` joins the turn it starts. */
	private _trackQueueAdmission<T>(admission: Promise<T>): Promise<T> {
		this._queueAdmissions.add(admission);
		const settle = () => {
			this._queueAdmissions.delete(admission);
		};
		void admission.then(settle, settle);
		return admission;
	}

	/** Wait for the conversation's operations, and by default for queued input still committing. */
	private async _waitForIdle(includeQueueAdmissions = true): Promise<void> {
		for (;;) {
			if (includeQueueAdmissions) await Promise.allSettled([...this._queueAdmissions]);
			await this._background.scheduledDispatch;
			await this._background.attemptSettled;
			await this._conversation.waitForIdle();
			if (
				this._conversation.operation === undefined &&
				(!includeQueueAdmissions || this._queueAdmissions.size === 0) &&
				!this._background.pending
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
		return this._trackAdmittedPromptWork(this._promptAdmitted(text, options));
	}

	private async _promptAdmitted(text: string, options?: PromptOptions): Promise<void> {
		if (this._disposed) {
			throw new Error("Cannot prompt a disposed session");
		}
		this._assertActive();
		if (this._hasSessionOperationBarrier) {
			throw new Error("Cannot prompt while a session mutation is active");
		}
		const assertConversationGenerationCurrent = this._captureConversationGenerationAssertion(
			options?.assertConversationGenerationCurrent,
		);
		assertConversationGenerationCurrent();
		this._assertRecoveredClientInputOrdering(options?.clientMessageId);
		const wasRunning = this._turnActive;
		// Claim the idle conversation for this prompt's turn while it is prepared;
		// input queued meanwhile waits for it.
		let reservation: ConversationTurnReservation | undefined;
		if (!wasRunning && this._admissionGate.isOpen && this._conversation.queue.prompt.length === 0) {
			reservation = this._conversation.reserve();
		}
		const clientMessageId = options?.clientMessageId;
		let admission: Awaited<ReturnType<AgentSession["_admitClientInput"]>> | undefined;
		try {
			admission =
				clientMessageId === undefined
					? undefined
					: await this._admitClientInput(
							this._conversationInput(
								"prompt",
								clientMessageId,
								text,
								options?.images,
								options?.streamingBehavior,
							),
						);
		} catch (error) {
			reservation?.cancel();
			throw error;
		}
		try {
			assertConversationGenerationCurrent();
		} catch (error) {
			reservation?.cancel();
			if (admission?.kind === "start" && clientMessageId !== undefined) {
				await this._failClientInput(clientMessageId, error instanceof Error ? error : new Error(String(error)));
			}
			throw error;
		}
		const shouldQueue = wasRunning || !this._admissionGate.isOpen;
		const allowQueue = wasRunning && this._admissionGate.isOpen;
		const abortGeneration = this._abortGeneration;
		if (admission?.kind === "completed") {
			reservation?.cancel();
			options?.preflightResult?.({ success: true, outcome: "completed" });
			return;
		}
		if (admission?.kind === "live") {
			reservation?.cancel();
			return this._observeLivePrompt(admission.live, options?.preflightResult);
		}

		const live = admission?.live;
		if (live) {
			const originalPreflightResult = options?.preflightResult;
			void live.accepted.promise.then(
				(outcome) => originalPreflightResult?.({ success: true, outcome }),
				() => originalPreflightResult?.({ success: false }),
			);
		}
		const settlementRevision = this._agentSettlementRevision;
		let outcome: PromptDispatchOutcome;
		try {
			outcome = await this._prompt(
				text,
				options,
				shouldQueue,
				allowQueue,
				abortGeneration,
				live,
				reservation,
				assertConversationGenerationCurrent,
			);
		} catch (error) {
			const normalized = this._clientInputError(error);
			// This process observed the failure before the canonical user append.
			// Leaving `started` would misreport it as a lost owner and fence every
			// later input after a reload.
			if (live && clientMessageId !== undefined) {
				await this._failClientInput(clientMessageId, normalized);
			}
			throw normalized;
		}
		// A handled command or input hook already ran its side effects. If its
		// terminal write fails, `started` remains the truthful ambiguous outcome.
		if (outcome === "handled") {
			if (live && clientMessageId !== undefined) {
				try {
					this._assertActive();
					await this._conversation.settleClientInput(clientMessageId, { state: "completed" });
				} catch (error) {
					// The input stays `started`: a retry reports the ambiguous outcome instead of joining this one.
					const settled = this._liveClientInputs.get(clientMessageId);
					if (settled) {
						this._liveClientInputs.delete(clientMessageId);
						const settleError = this._clientInputError(error);
						settled.accepted.reject(settleError);
						settled.done.reject(settleError);
					}
					throw error;
				}
				this._completeLiveClientInput(clientMessageId, "completed");
			} else if (!live && !this._disposed) {
				// Local/prompt-backed UI actions have no durable client identity, but
				// their completed handler is still an authoritative admission boundary.
				options?.preflightResult?.({ success: true, outcome: "admitted" });
			}
			// A handler-owned prompt runs no turn to publish settlement, unless the
			// handler already completed a custom turn and published it itself.
			if (this._agentSettlementRevision === settlementRevision) this._emitHandledSettlement();
		}
	}

	private async _prompt(
		text: string,
		options: PromptOptions | undefined,
		shouldQueue: boolean,
		allowQueue: boolean,
		abortGeneration: number,
		live: LiveClientInput | undefined,
		initialReservation: ConversationTurnReservation | undefined,
		assertConversationGenerationCurrent: () => void,
	): Promise<PromptDispatchOutcome> {
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		// Identified inputs report admission through their live record.
		const preflightResult = live ? undefined : options?.preflightResult;
		const identifiedClientMessageId = live ? options?.clientMessageId : undefined;
		let reservation = initialReservation;
		const releaseReservation = (): void => {
			reservation?.cancel();
			reservation = undefined;
		};
		let input: ConversationInput;
		let attachments: AgentMessage[];
		let extensionInputId: string | undefined;
		let systemPromptOverride: string | undefined;

		try {
			assertConversationGenerationCurrent();
			if (this._disposed || abortGeneration !== this._abortGeneration) {
				throw new Error("Prompt aborted before preflight started");
			}

			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via volt.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text, async () => {
					releaseReservation();
					await this._markClientInputStarted(identifiedClientMessageId, abortGeneration);
					if (this._disposed || abortGeneration !== this._abortGeneration) {
						throw new Error("Prompt aborted before preflight started");
					}
				});
				if (handled) {
					// Extension command executed, no prompt to send
					releaseReservation();
					return "handled";
				}
				assertConversationGenerationCurrent();
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this.extensionRunner.hasHandlers("input")) {
				// Input hooks are arbitrary side-effect boundaries. Persist ambiguity
				// before entering them. A later durable queued payload safely returns
				// this receipt to recoverable `accepted`; a crash in between never
				// re-executes an uncertain hook.
				await this._markClientInputStarted(identifiedClientMessageId, abortGeneration);
				const inputResult = await this.extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					shouldQueue ? options?.streamingBehavior : undefined,
				);
				assertConversationGenerationCurrent();
				if (this._disposed || abortGeneration !== this._abortGeneration) {
					throw new Error("Prompt aborted during input preflight");
				}
				if (inputResult.action === "handled") {
					releaseReservation();
					return "handled";
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}
			input = {
				...this._conversationInput(
					"prompt",
					options?.clientMessageId ?? createLocalClientInputId(),
					text,
					options?.images,
					options?.streamingBehavior,
				),
				prepared: { message: expandedText, ...(currentImages === undefined ? {} : { images: currentImages }) },
			};
			if (options?.source === "extension") {
				extensionInputId = input.clientMessageId!;
				this._extensionInputIds.add(extensionInputId);
			}

			// Queue only behind an active turn. During preflight or abort, reject
			// promptly so an accepted message cannot be stranded.
			if (shouldQueue) {
				assertConversationGenerationCurrent();
				if (allowQueue && !this._turnActive) {
					throw new Error(
						"Agent finished processing while queued prompt preflight was running. Resubmit the prompt.",
					);
				}
				if (!allowQueue || !options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				this._assertQueueCapacity();
				if (options.streamingBehavior === "steer") this._extensionWork.invalidate();
				const admission = await this._trackQueueAdmission(this._conversation.prompt(input));
				if (admission.ordinals.length > 0) this._reportQueuedOutcome(admission);
				if (identifiedClientMessageId !== undefined) {
					this._completeLiveClientInput(identifiedClientMessageId, "admitted");
				}
				preflightResult?.({ success: true, outcome: "admitted" });
				releaseReservation();
				return "queued";
			}

			// Flush any pending bash messages before the new prompt
			assertConversationGenerationCurrent();
			await this._bash.flushPending();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
				const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// Deterministic model/auth preflight is complete. Everything below can
			// invoke side-effect-capable before_agent_start and message hooks.
			// Persist the ambiguous dispatch boundary before any of them so a crash
			// never replays extension or provider side effects.
			await this._markClientInputStarted(identifiedClientMessageId, abortGeneration);

			// Snapshot pending "nextTurn" context. It is consumed only after preflight
			// is accepted so aborting an extension hook cannot lose queued context.
			const pendingNextTurnMessages = [...this._pendingNextTurnMessages];
			attachments = [...pendingNextTurnMessages];

			// Emit before_agent_start extension event
			const result = await this.extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._tools.baseSystemPrompt,
				this._tools.baseSystemPromptOptions,
			);
			assertConversationGenerationCurrent();
			if (this._disposed || abortGeneration !== this._abortGeneration) {
				throw new Error("Prompt aborted before the agent run started");
			}

			// Add all custom messages from extensions
			if (result?.messages) {
				for (const msg of result.messages) {
					attachments.push(
						cloneCanonicalData(
							{
								role: "custom",
								customType: msg.customType,
								content: msg.content,
								display: msg.display,
								...(msg.details === undefined ? {} : { details: msg.details }),
								timestamp: Date.now(),
							} satisfies CustomMessage,
							`Extension before_agent_start message ${msg.customType}`,
						),
					);
				}
			}
			// Apply the per-turn extension prompt before appending trusted planning instructions.
			systemPromptOverride = result?.systemPrompt;
			this._tools.applyTrustedPlanningInstructions(systemPromptOverride);

			this._pendingNextTurnMessages.splice(0, pendingNextTurnMessages.length);
			// Turn-start seam: every fresh-input turn surfaces recovered subagent
			// results first, behind the admission and generation fences.
			await this._lifecycle.maybeAppendSubagentRecoveryNotice();
			assertConversationGenerationCurrent();
			if (this._disposed || abortGeneration !== this._abortGeneration) {
				throw new Error("Prompt aborted before the agent run started");
			}
		} catch (error) {
			releaseReservation();
			if (extensionInputId !== undefined) this._extensionInputIds.delete(extensionInputId);
			preflightResult?.({ success: false });
			assertConversationGenerationCurrent();
			throw error;
		}

		this._background.explicitRunStarted();
		// The turn's requests use the before_agent_start override as admitted.
		if (reservation) this._turnSystemPromptOverrides.set(reservation.id, systemPromptOverride);
		const clientMessageId = input.clientMessageId!;
		const tracked = live ?? this._createLiveClientInput("prompt", input, true);
		if (!live) this._liveClientInputs.set(clientMessageId, tracked);
		let admitted: ConversationInputAdmission;
		try {
			admitted = await this._conversation.prompt(
				{ ...input, attachments },
				reservation === undefined ? {} : { reservation },
			);
		} catch (error) {
			if (reservation) this._turnSystemPromptOverrides.delete(reservation.id);
			if (!live && this._liveClientInputs.get(clientMessageId) === tracked) {
				this._liveClientInputs.delete(clientMessageId);
			}
			preflightResult?.({ success: false });
			throw this._clientInputError(error);
		}
		// The prompt's turn runs under its reservation, or under the lease the conversation took for it.
		tracked.operationId = reservation?.id ?? this._conversation.operation?.id;
		if (!live) {
			// Identified inputs acknowledge through their canonical user commit.
			// Unidentified local/UI-action prompts still need a bounded admission
			// signal so their caller need not hold lifecycle ownership for the full
			// provider turn.
			preflightResult?.({ success: true, outcome: "admitted" });
		}
		void admitted.completion.then(
			(completion) => {
				if (completion.state === "completed") {
					this._completeLiveClientInput(clientMessageId, "admitted");
					return;
				}
				// A local prompt its turn stopped before delivering (an abort, a stop policy) ends quietly.
				if (completion.state === "withdrawn" && tracked.local) {
					this._completeLiveClientInput(clientMessageId, "admitted");
					return;
				}
				// A hook that failed the turn reports its own error.
				const fatalError =
					tracked.operationId === undefined ? undefined : this._turnFatalErrors.get(tracked.operationId);
				const error =
					fatalError ??
					new Error(
						completion.state === "failed"
							? completion.error
							: "client_input_failed: queued input was cleared before canonical consumption",
					);
				tracked.accepted.reject(error);
				tracked.done.reject(error);
				if (this._liveClientInputs.get(clientMessageId) === tracked) this._liveClientInputs.delete(clientMessageId);
			},
			(error: unknown) => {
				if (tracked.local && this._disposed) {
					tracked.accepted.resolve("admitted");
					tracked.done.resolve();
					return;
				}
				const ended = error instanceof Error ? error : new Error(String(error));
				tracked.accepted.reject(ended);
				tracked.done.reject(ended);
			},
		);
		try {
			await tracked.done.promise;
		} finally {
			if (this._liveClientInputs.get(clientMessageId) === tracked) this._liveClientInputs.delete(clientMessageId);
		}
		const fatalError = tracked.operationId === undefined ? undefined : this._turnFatalErrors.get(tracked.operationId);
		// Settlement events (agent_settled) are published before the prompt resolves.
		await this._conversation.waitForIdle();
		if (fatalError) throw fatalError;
		return "run";
	}

	/** Record the first fatal hook error of the running turn; a few recent turns are kept. */
	private _recordTurnFatalError(error: Error): void {
		const operationId = this._conversation.operation?.id;
		if (operationId === undefined || this._turnFatalErrors.has(operationId)) return;
		this._turnFatalErrors.set(operationId, error);
		const oldest = this._turnFatalErrors.keys().next().value;
		if (this._turnFatalErrors.size > 16 && oldest !== undefined) this._turnFatalErrors.delete(oldest);
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string, onWillExecute?: () => Promise<void>): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this.extensionRunner.getCommand(commandName);
		if (!command) return false;
		// A command handler is an arbitrary side-effect boundary with no canonical
		// user append. Persist `started` first so a crash can only replay an
		// explicit ambiguous outcome, never execute the handler twice.
		await onWillExecute?.();

		// Command transactions must not wait on themselves or each other.
		// waitForIdle still waits for active runs and non-command prompt work.
		const ctx = this.extensionRunner.createCommandContext(() => this._waitForIdle(), this._lifetimeAbort.signal);

		const releaseActivity = this._conversation.beginActivity("extension_command");
		this._activeExtensionCommandHandlers++;
		try {
			const handler = Promise.resolve(command.handler(args, ctx));
			// After the session lost its log nothing the handler does can be saved. Stop awaiting
			// it (its ctx.signal is aborted) so a handler that never settles cannot keep the
			// ending runtime alive.
			const abandoned = await Promise.race([handler.then(() => false), this.lost.then(() => true)]);
			if (abandoned) {
				void handler.catch(() => undefined);
				return true;
			}
			return true;
		} catch (err) {
			// Volt tore the handler's custom UI down (session replacement, reload, or the session ending).
			if (err instanceof ExtensionUIDismissedError) return true;
			// Emit error via extension runner
			this.extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		} finally {
			this._activeExtensionCommandHandlers--;
			releaseActivity();
			this._activityChanged();
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this.extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
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
		await this._queueInput("steer", text, images, clientMessageId);
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
		await this._queueInput("follow_up", text, images, clientMessageId);
	}

	/** Queue durable steering or follow-up input; it is acknowledged once its queue intent commits. */
	private async _queueInput(
		command: "steer" | "follow_up",
		text: string,
		images: ImageContent[] | undefined,
		clientMessageId: string | undefined,
	): Promise<void> {
		this._assertActive();
		if (this._hasSessionOperationBarrier) {
			throw new Error("Cannot queue input while a session mutation is active");
		}
		this._assertRecoveredClientInputOrdering(clientMessageId);
		const input = this._conversationInput(command, clientMessageId ?? createLocalClientInputId(), text, images);
		if (clientMessageId !== undefined && (await this._existingClientInput(command, input)) !== undefined) return;
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}
		this._assertQueueCapacity();

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		const prepared: ConversationInput = {
			...input,
			prepared: { message: expandedText, ...(images === undefined ? {} : { images }) },
		};
		let admission: ConversationInputAdmission;
		try {
			if (command === "steer") {
				this._extensionWork.invalidate();
				admission = await this._trackQueueAdmission(this._conversation.steer(prepared));
			} else {
				admission = await this._trackQueueAdmission(this._conversation.followUp(prepared));
			}
		} catch (error) {
			throw this._clientInputError(error);
		}
		// A concurrent duplicate joins the first admission, which reports the outcome.
		if (admission.ordinals.length > 0) this._reportQueuedOutcome(admission);
	}

	/** The durable queue holds at most {@link AGENT_SESSION_MAX_QUEUED_MESSAGES} inputs, host messages included. */
	private _assertQueueCapacity(): void {
		if (this._conversation.state.clientInputs.queued.length >= AGENT_SESSION_MAX_QUEUED_MESSAGES) {
			throw new Error(`Agent queue is limited to ${AGENT_SESSION_MAX_QUEUED_MESSAGES} messages`);
		}
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this.extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
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
		await this._sendCustomMessage(message, options, false);
	}

	private async _sendCustomMessage<T>(
		message: CustomMessageInput<T>,
		options: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined,
		allowDuringPromptTransaction: boolean,
		appendDuringReservedTurn = false,
	): Promise<void> {
		this._assertActive();
		if (this._hasSessionOperationBarrier) {
			throw new Error("Cannot append a custom message while a session mutation is active");
		}
		const ownedInput = cloneCanonicalData(message, "Custom message input");
		const appMessage = cloneCanonicalData(
			{
				role: "custom" as const,
				customType: ownedInput.customType,
				content: ownedInput.content,
				display: ownedInput.display,
				...(ownedInput.details === undefined ? {} : { details: ownedInput.details as JsonValue }),
				timestamp: Date.now(),
			} satisfies CustomMessage,
			`Custom message ${ownedInput.customType}`,
		);
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this._turnActive && !appendDuringReservedTurn) {
			if (options?.deliverAs !== "followUp") this._extensionWork.invalidate();
			await this._trackQueueAdmission(
				this._conversation.queueMessages(options?.deliverAs === "followUp" ? "followUp" : "steer", [appMessage]),
			);
		} else if (options?.triggerTurn) {
			if (
				(this._conversation.operation !== undefined || this._activeExtensionCommandHandlers > 0) &&
				!allowDuringPromptTransaction
			) {
				throw new Error("Agent is already processing a prompt transaction");
			}
			if (!this.model) throw new Error(formatNoModelSelectedMessage());
			this._admissionGate.assertOpen();
			const abortGeneration = this._abortGeneration;
			// Claim the idle conversation now, so a caller waiting for idle joins the turn this message starts.
			const reservation =
				this._conversation.operation === undefined && this._admissionGate.isOpen
					? this._conversation.reserve()
					: undefined;
			let admission: ConversationInputAdmission;
			try {
				await this._lifecycle.maybeAppendSubagentRecoveryNotice();
				if (this._disposed || abortGeneration !== this._abortGeneration) return;
				this._assertActive();
				this._background.explicitRunStarted();
				// Queued while the claim is held, the message waits for the turn that takes the claim over.
				admission = await this._conversation.queueMessages("steer", [appMessage]);
			} finally {
				// Released while the message is pending, the claim passes to the turn that delivers it.
				reservation?.cancel();
			}
			const tracked = this._createLiveClientInput(
				"steer",
				{ clientMessageId: admission.clientMessageId, message: "" },
				true,
			);
			tracked.operationId = this._conversation.operation?.id;
			this._liveClientInputs.set(admission.clientMessageId, tracked);
			if (tracked.operationId === undefined) {
				// No turn could start (admission was suspended meanwhile): nothing will deliver the message.
				await this._failClientInput(
					admission.clientMessageId,
					new Error("The turn for the message could not start"),
				);
			}
			void admission.completion.then(
				(completion) => {
					if (completion.state === "completed") tracked.done.resolve();
					else {
						const fatalError =
							tracked.operationId === undefined ? undefined : this._turnFatalErrors.get(tracked.operationId);
						tracked.done.reject(
							fatalError ?? new Error(completion.state === "failed" ? completion.error : "Withdrawn"),
						);
					}
				},
				(error: unknown) => {
					if (this._disposed) tracked.done.resolve();
					else tracked.done.reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
			try {
				await tracked.done.promise;
			} finally {
				if (this._liveClientInputs.get(admission.clientMessageId) === tracked) {
					this._liveClientInputs.delete(admission.clientMessageId);
				}
			}
			await this._conversation.waitForIdle();
		} else {
			await this._sessionWriter.appendCustomMessageEntry(
				appMessage.customType,
				appMessage.content,
				appMessage.display,
				appMessage.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		this._assertActive();
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
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
	async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
		if (this._disposed || this._lostError !== undefined) {
			const handback = this._disposedQueueHandback ?? this._queueText();
			this._disposedQueueHandback = { steering: [], followUp: [] };
			return { steering: [...handback.steering], followUp: [...handback.followUp] };
		}
		// Input still being admitted is part of the queue being cleared.
		await Promise.allSettled([...this._queueAdmissions]);
		const queued = this._queueText();
		let cleared: ConversationQueue;
		try {
			cleared = await this._conversation.clearQueue();
		} catch (error) {
			// The conversation no longer holds the input, so the thrown error carries its text back.
			throw new QueueClearPersistenceError(error instanceof Error ? error : new Error(String(error)), queued);
		}
		// Client input delivers a user message with its identity; host messages show no text.
		const text = (messages: readonly AgentMessage[]) =>
			messages.flatMap((message) => (getClientMessageId(message) === undefined ? [] : [messageText(message)]));
		return { steering: text(cleared.steer), followUp: text(cleared.followUp) };
	}

	/** The queue's text, as an editor takes it back. */
	private _queueText(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this._queueView();
		return { steering: steering.map((entry) => entry.text), followUp: followUp.map((entry) => entry.text) };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		this._assertNotDisposed();
		const { steering, followUp } = this._queueView();
		return steering.length + followUp.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly AgentSessionQueuedMessage[] {
		this._assertNotDisposed();
		return this._queueView().steering;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly AgentSessionQueuedMessage[] {
		this._assertNotDisposed();
		return this._queueView().followUp;
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
		this._extensionWork.invalidate();
		this._backgroundJobs.suppressContinuations();
		this._background.cancelSchedule();
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
			() => this._backgroundJobs.cancelAll(),
			() => this._extensionWork.drain(),
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

	private _getSummarizationRetryOptions(): SummarizationRetryOptions {
		const settings = this.settingsManager.getRetrySettings();
		return {
			maxRetries: settings.enabled ? Math.min(MAX_COMPACTION_SUMMARY_RETRIES, Math.max(0, settings.maxRetries)) : 0,
			baseDelayMs: Math.max(0, settings.baseDelayMs),
			maxDelayMs: Math.min(
				MAX_COMPACTION_RETRY_DELAY_MS,
				Math.max(0, this.settingsManager.getProviderRetrySettings().maxRetryDelayMs),
			),
		};
	}

	private _generateCompaction(
		preparation: CompactionPreparation,
		model: Model<Api>,
		pathEntries: SessionEntry[],
		messages: readonly AgentMessage[],
		operation: { readonly stream: StreamFn; readonly signal: AbortSignal },
		customInstructions?: string,
	): Promise<CompactionResult> {
		const firstKeptIndex = pathEntries.findIndex((entry) => entry.id === preparation.firstKeptEntryId);
		const retainedCount = pathEntries
			.slice(firstKeptIndex)
			.filter(
				(entry) =>
					entry.type === "message" ||
					entry.type === "custom_message" ||
					(entry.type === "branch_summary" && entry.summary),
			).length;
		// Keep the full rebuilt conversation warm, including the latest response.
		// Describe the retained suffix only in the appended checkpoint instruction.
		return compactContext(preparation, model, {
			sourceMessageCount: messages.length,
			retainedMessageCount: retainedCount,
			context: async (signal) => {
				const transformed = await withoutExtensionWork(() =>
					this.extensionRunner.emitContext(cloneAgentMessages(messages)),
				);
				signal.throwIfAborted();
				const llmMessages = await this._convertToLlm(transformed);
				signal.throwIfAborted();
				return {
					systemPrompt: this.systemPrompt,
					tools: [...this._conversation.activeTools],
					messages: llmMessages,
				};
			},
			streamFn: this._withInferenceSpeed(operation.stream),
			signal: operation.signal,
			thinkingLevel: this.thinkingLevel,
			thinkingBudgets: this._modelSettings.streamOptions.thinkingBudgets,
			retry: this._getSummarizationRetryOptions(),
			customInstructions,
			// Written before the error surfaces so the record exists when the user sees it.
			onFailure: (report) =>
				writeToolProgressCapture(
					join(this._agentDir, "debug", "compaction-latest.json"),
					JSON.stringify(
						{
							sessionId: this.sessionManager.getSessionId(),
							capturedAt: Date.now(),
							thinkingLevel: this.thinkingLevel,
							...report,
						},
						null,
						2,
					),
				),
		});
	}

	/**
	 * The conversation's summarizer for manual and automatic compaction: the
	 * compaction boundary, the `session_before_compact` hook (which may cancel
	 * or supply the summary), the summary itself, and the plan checkpoint that
	 * commits with it. The conversation commits the result and resumes the turn.
	 */
	private async _summarizeCompaction(
		request: ConversationCompactionRequest,
	): Promise<ConversationCompactionSummary | undefined> {
		const reason = request.cause;
		const willRetry = reason === "manual" ? false : (this._pendingCompaction?.willRetry ?? false);
		// The summary runs before the session observes the compaction's start event.
		this._activeCompaction ??= { reason, startedAt: Date.now() };
		this._compactionSummary = undefined;
		const model = request.model;
		const pathEntries = this.sessionManager.getBranch();
		const branchMessages = this.sessionManager.getConversationState().context.messages;
		const settings = this.settingsManager.getCompactionSettings();
		// A branch of settings entries alone (its model selection) has nothing to compact.
		const preparation =
			this._conversation.state.context.messages.length === 0
				? undefined
				: prepareCompaction(pathEntries, branchMessages, settings, {
						tools: this._conversation.activeTools,
						contextWindow: model.contextWindow,
					});
		if (!preparation) {
			if (reason !== "manual") throw new Error("Auto-compaction could not find a safe compaction boundary");
			if (pathEntries.at(-1)?.type === "compaction") throw new Error("Already compacted");
			throw new Error("Nothing to compact (session too small)");
		}

		let extensionCompaction: CompactionResult | undefined;
		if (this.extensionRunner.hasHandlers("session_before_compact")) {
			const result = (await this.extensionRunner.emit({
				type: "session_before_compact",
				preparation,
				branchEntries: pathEntries,
				...(reason === "manual" ? { customInstructions: request.instructions } : {}),
				reason,
				willRetry,
				signal: request.signal,
			})) as SessionBeforeCompactResult | undefined;
			if (result?.cancel) {
				throw new Error(
					reason === "manual" ? "Compaction cancelled" : "Auto-compaction was cancelled by an extension",
				);
			}
			extensionCompaction = result?.compaction;
		}
		const compaction =
			extensionCompaction ??
			(await this._generateCompaction(
				preparation,
				model,
				pathEntries,
				branchMessages,
				{ stream: request.stream, signal: request.signal },
				request.instructions,
			));
		if (request.signal.aborted) throw new Error("Compaction cancelled");
		this._compactionSummary = {
			result: {
				summary: compaction.summary,
				firstKeptEntryId: compaction.firstKeptEntryId,
				tokensBefore: compaction.tokensBefore,
				...(compaction.details === undefined ? {} : { details: compaction.details }),
			},
			fromExtension: extensionCompaction !== undefined,
		};
		const planningCheckpoint = this._createPlanningCheckpointMessage(this._planningState);
		return {
			summary: compaction.summary,
			firstKeptEntryId: compaction.firstKeptEntryId,
			tokensBefore: compaction.tokensBefore,
			...(compaction.details === undefined ? {} : { details: compaction.details }),
			...(extensionCompaction === undefined ? {} : { fromHook: true }),
			...(planningCheckpoint === undefined ? {} : { messages: [planningCheckpoint] }),
		};
	}

	/**
	 * A compaction ended. A committed one is reported to extensions
	 * (`session_compact`) with its result, then to session observers.
	 */
	private async _onCompactionEnd(
		reason: ConversationCompactionCause,
		status: "compacted" | "skipped" | "aborted" | "failed",
		error: string | undefined,
	): Promise<void> {
		const willRetry = reason === "manual" ? false : (this._pendingCompaction?.willRetry ?? false);
		const dropTrailing = reason === "manual" ? undefined : this._pendingCompaction?.dropTrailing;
		this._pendingCompaction = undefined;
		const summary = this._compactionSummary;
		this._compactionSummary = undefined;
		this._activeCompaction = undefined;
		if (status === "compacted" && summary) {
			// The retried request leaves out the response it retries (behind a plan checkpoint, if any).
			const messages = [...this.messages];
			const tail = messages.at(-1);
			const lastIndex =
				tail?.role === "custom" && tail.customType === PLAN_CHECKPOINT_CUSTOM_TYPE
					? messages.length - 2
					: messages.length - 1;
			const candidate = messages[lastIndex];
			if (dropTrailing !== undefined && candidate?.role === "assistant" && candidate.stopReason === dropTrailing) {
				messages.splice(lastIndex, 1);
			}
			const result: CompactionResult = {
				...summary.result,
				estimatedTokensAfter:
					estimateMessagesTokens(messages) + estimateToolDefinitionTokens(this._conversation.activeTools),
			};
			this._lastCompactionResult = result;
			const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
			if (compactionEntry && this.extensionRunner) {
				await this.extensionRunner.emit({
					type: "session_compact",
					compactionEntry,
					fromExtension: summary.fromExtension,
					reason,
					willRetry,
				});
			}
			this._background.readinessChanged();
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
			return;
		}
		const cancelled = error === "Compaction cancelled";
		const aborted = status === "aborted" || (reason === "manual" && cancelled);
		this._emit({
			type: "compaction_end",
			reason,
			aborted,
			willRetry: false,
			...(aborted || error === undefined
				? {}
				: {
						errorMessage:
							reason === "manual"
								? `Compaction failed: ${error}`
								: reason === "overflow"
									? `Context overflow recovery failed: ${error}`
									: `Auto-compaction failed: ${error}`,
					}),
		});
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(
		customInstructions?: string,
		assertConversationGenerationCurrent?: () => void,
	): Promise<CompactionResult> {
		if (this._extensions.reloading || this.isBashRunning) {
			throw new Error("Cannot compact while another session mutation or bash run is active");
		}
		const assertConversationCurrent = this._captureConversationGenerationAssertion(
			assertConversationGenerationCurrent,
		);
		assertConversationCurrent();
		if (!this.model) throw new Error(formatNoModelSelectedMessage());
		this._lastCompactionResult = undefined;
		// Compaction preempts a running turn; the stop is attributed to whoever asked for it.
		if (this._turnActive)
			this._conversation.abort(this._extensions.mode === "rpc" ? "remote_request" : "host_action");
		try {
			const outcome = await this._conversation.compact(
				customInstructions === undefined ? {} : { instructions: customInstructions },
			);
			// The compaction's events, its result included, are published before it resolves.
			await this._conversation.waitForIdle();
			const result = this._lastCompactionResult;
			if (outcome.status !== "compacted" || !result) {
				// A compaction the session's disposal interrupted reports the disposal.
				this._assertNotDisposed();
				throw new Error("Compaction cancelled");
			}
			return result;
		} finally {
			this._background.schedule();
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		if (this._activeCompaction) this._conversation.abort("host_action");
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		if (this._conversation.operation?.kind === "navigation") this._conversation.abort("host_action");
	}

	/**
	 * The compaction policy, consulted inside a turn. Before the turn's first
	 * request it checks the context's tail (an earlier turn's overflow, abort,
	 * or large response, aborted responses included); between requests it
	 * stops a continuing turn at the threshold to compact mid-task; after the
	 * turn's final response it checks overflow and the threshold. An overflow
	 * compacts once and retries; a tool-free length stop retries without the
	 * truncated response.
	 */
	private _compactionDecision(
		cause: Exclude<ConversationCompactionCause, "manual">,
		check: ConversationCompactionCheck,
	): ConversationCompactionDecision | undefined {
		if (this._disposed) return undefined;
		const operationId = this._conversation.operation?.id;
		const requested = operationId !== undefined && this._requestedOperationId === operationId;
		const settings = this.settingsManager.getCompactionSettings(check.model);
		const messages = check.state.context.messages;
		const tools = this._conversation.activeTools;
		let decision: ConversationCompactionDecision;
		let willRetry: boolean;
		let dropTrailing: "error" | "length" | undefined;
		if (requested && check.continuing) {
			if (
				!shouldCompactBeforeContinuing({
					message: check.message,
					continuing: true,
					messages,
					tools,
					model: check.model,
					settings,
				})
			) {
				return undefined;
			}
			decision = {};
			willRetry = true;
		} else {
			const compaction = checkResponseCompaction({
				message: check.message,
				includeAborted: !requested,
				model: check.model,
				settings,
				overflowRecoveryAttempted: false,
				compactedAt: () => latestCompactionTime(check.state),
				context: () => ({ messages, tools }),
			});
			if (compaction.kind === "none" || compaction.kind === "overflow_exhausted") return undefined;
			// A length stop over the window overflowed silently: it retries without its response, as a
			// provider overflow does. A complete response over the window only compacts.
			const lengthStop = check.message.stopReason === "length";
			const retry =
				(compaction.kind === "overflow" && (lengthStop || check.message.stopReason === "error")) ||
				(compaction.kind === "threshold" && compaction.continueAfterCompaction);
			decision = retry ? { resume: "retry" } : {};
			willRetry = retry;
			if (retry) dropTrailing = lengthStop ? "length" : "error";
		}
		if (cause === "overflow") {
			this._overflowRecoveredOperationId = operationId;
			willRetry = true;
			dropTrailing = "error";
		}
		this._pendingCompaction = { reason: cause, willRetry, ...(dropTrailing === undefined ? {} : { dropTrailing }) };
		return decision;
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

	bindExtensions(bindings: ExtensionBindings): Promise<void> {
		return this._trackAdmittedAncillaryWork(this._extensions.bind(bindings));
	}

	reload(): Promise<void> {
		return this._trackAdmittedAncillaryWork(this._extensions.reload());
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
	navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this._turnActive || this.isBashRunning || this._backgroundJobs.hasActive) {
			return Promise.reject(
				new Error(
					"Cannot navigate the session tree while an agent, bash run, or background job is active; abort or wait for it to finish",
				),
			);
		}
		if (this._hasSessionOperationBarrier) {
			return Promise.reject(new Error("Cannot navigate the session tree while another session mutation is active"));
		}
		this._extensionWork.invalidate();
		return this._navigateTree(targetId, options).finally(() => this._background.schedule());
	}

	/**
	 * Move the active branch inside one conversation navigation: the
	 * `session_before_tree` hook may cancel it or supply the summary, the
	 * summarizer summarizes the abandoned branch, and the move commits with
	 * its summary. The session then restores its branch-local runtime state.
	 */
	private async _navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Model required for summarization
		const model = options.summarize ? this.model : undefined;
		if (options.summarize && !model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Determine the new leaf position based on target type
		let newLeafId: string | null;
		let editorText: string | undefined;
		if (targetEntry.type === "message" && targetEntry.message.role === "user") {
			// User message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText = extractUserMessageText(targetEntry.message.content);
		} else if (targetEntry.type === "custom_message") {
			// Custom message: leaf = parent (null if root), text goes to editor
			newLeafId = targetEntry.parentId;
			editorText =
				typeof targetEntry.content === "string"
					? targetEntry.content
					: targetEntry.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
		} else {
			// Non-user message: leaf = selected node
			newLeafId = targetId;
		}

		let label = options.label;
		let fromExtension = false;
		let summarized = false;
		const previousGeneration = this._generation();
		const previousModel = this.model;
		const previousThinkingLevel = this.thinkingLevel;
		const previousFastMode = this.fastModeEnabled;
		const result = await this._conversation.navigate(newLeafId, {
			summarize: options.summarize === true,
			prepare: async ({ signal }) => {
				// Collect entries to summarize (from old leaf to common ancestor)
				const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
					this.sessionManager,
					oldLeafId,
					targetId,
				);
				let customInstructions = options.customInstructions;
				let replaceInstructions = options.replaceInstructions;
				let extensionSummary: ConversationBranchSummary | undefined;

				if (this.extensionRunner.hasHandlers("session_before_tree")) {
					const preparation: TreePreparation = {
						targetId,
						oldLeafId,
						commonAncestorId,
						entriesToSummarize,
						userWantsSummary: options.summarize ?? false,
						customInstructions,
						replaceInstructions,
						label,
					};
					const hookResult = (await this.extensionRunner.emit({
						type: "session_before_tree",
						preparation,
						signal,
					})) as SessionBeforeTreeResult | undefined;

					if (hookResult?.cancel) {
						return { cancel: true };
					}

					if (hookResult?.summary && options.summarize) {
						extensionSummary = {
							summary: hookResult.summary.summary,
							...(hookResult.summary.details === undefined ? {} : { details: hookResult.summary.details }),
							fromHook: true,
						};
						fromExtension = true;
					}

					// Allow extensions to override instructions and label
					if (hookResult?.customInstructions !== undefined) {
						customInstructions = hookResult.customInstructions;
					}
					if (hookResult?.replaceInstructions !== undefined) {
						replaceInstructions = hookResult.replaceInstructions;
					}
					if (hookResult?.label !== undefined) {
						label = hookResult.label;
					}
				}

				summarized =
					extensionSummary !== undefined || (options.summarize === true && entriesToSummarize.length > 0);
				this._pendingBranchSummary = summarized
					? {
							entries: entriesToSummarize,
							...(customInstructions === undefined ? {} : { customInstructions }),
							...(replaceInstructions === undefined ? {} : { replaceInstructions }),
						}
					: undefined;
				// A summary carries the label; without one, the selected entry does.
				return {
					...(extensionSummary === undefined ? {} : { summary: extensionSummary }),
					...(summarized && label !== undefined ? { label } : {}),
				};
			},
		});
		this._pendingBranchSummary = undefined;
		// The navigation's events, its end included, are observed before it resolves.
		await this._conversation.waitForIdle();
		if (result.status === "cancelled") return { cancelled: true };
		if (result.status === "aborted") return { cancelled: true, aborted: true };

		const summaryEntry =
			result.summaryEntryId === undefined
				? undefined
				: (this.sessionManager.getEntry(result.summaryEntryId) as BranchSummaryEntry | undefined);
		if (label && !summaryEntry) {
			await this._conversation.setLabel(targetId, label);
		}

		const conversationGenerationChange = {
			previousLeafId: oldLeafId,
			nextLeafId: this.sessionManager.getLeafId(),
		};
		if (this._generation() !== previousGeneration) {
			// Prompt authority and runtime-only research evidence belong to the abandoned branch.
			this._backgroundJobs.cancelInaccessible();
			this._background.discardNotifications();
			this._planResearchGeneration = undefined;
		}

		// Restore branch-local runtime policy from the committed branch: model,
		// thinking level, and fast mode come from it; the plan state follows it.
		const previousPlanningState = clonePlanningState(this._planningState);
		this._planningState = branchPlanningState(this.sessionManager.getConversationState().planning);
		this._tools.syncPlanningRuntime();
		if (JSON.stringify(previousPlanningState) !== JSON.stringify(this._planningState)) {
			this._emit({ type: "planning_state_changed", planning: this.planningState });
		}
		if (this.thinkingLevel !== previousThinkingLevel) {
			this._emit({ type: "thinking_level_changed", level: this.thinkingLevel });
			void this.extensionRunner.emit({
				type: "thinking_level_select",
				level: this.thinkingLevel,
				previousLevel: previousThinkingLevel,
			});
		}
		if (previousFastMode !== this.fastModeEnabled) {
			this._modelSettings.emitFastModeStateChanged();
		}
		if (this.model) {
			await this._modelSettings.emitModelSelect(this.model, previousModel, "restore");
		}
		this._notifyConversationGenerationChange(conversationGenerationChange);

		// Emit session_tree event
		await this.extensionRunner.emit({
			type: "session_tree",
			newLeafId: this.sessionManager.getLeafId(),
			oldLeafId,
			summaryEntry,
			...(fromExtension ? { fromExtension: true } : {}),
		});

		return { editorText, cancelled: false, summaryEntry };
	}

	/** A summary request stream that runs at the branch's inference speed, as its turns do. */
	private _withInferenceSpeed(stream: StreamFn): StreamFn {
		return (model, context, options) =>
			stream(model, context, { ...options, inferenceSpeed: this.fastModeEnabled ? "fast" : "standard" });
	}

	/** The conversation's summarizer for tree navigation: a summary of the abandoned branch. */
	private async _summarizeBranch(
		request: ConversationBranchSummaryRequest,
	): Promise<ConversationBranchSummary | undefined> {
		const pending = this._pendingBranchSummary;
		if (!pending || pending.entries.length === 0) return undefined;
		const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
		const result = await generateBranchSummary(pending.entries, {
			model: request.model,
			signal: request.signal,
			customInstructions: pending.customInstructions,
			replaceInstructions: pending.replaceInstructions,
			reserveTokens: branchSummarySettings.reserveTokens,
			streamFn: this._withInferenceSpeed(request.stream),
		});
		if (result.aborted) return undefined;
		if (result.error) throw new Error(result.error);
		if (!result.summary) return undefined;
		return {
			summary: result.summary,
			details: {
				readFiles: result.readFiles || [],
				modifiedFiles: result.modifiedFiles || [],
			},
		};
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
