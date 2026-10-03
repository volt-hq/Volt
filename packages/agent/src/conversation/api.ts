/**
 * The public surface of the `Conversation` kernel: open options, policy
 * hooks, the injected summarizer, intents' inputs and results, events, and
 * errors.
 */

import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	JsonValue,
	Message,
	Model,
	PromptCacheRefresher,
	PromptCacheRefreshResult,
	ProviderEnv,
	ProviderError,
	ProviderResponse,
	SimpleStreamOptions,
	ThinkingBudgets,
	ToolArgumentLimits,
	Transport,
	Usage,
	UserMessage,
} from "@hansjm10/volt-ai";
import type { LogEntryType } from "@hansjm10/volt-protocol/entries";
import type { AgentHarnessAdmissionGate } from "../harness/admission-gate.ts";
import type {
	AgentAbortSource,
	AgentDeliveryKind,
	AgentEvent,
	AgentLoopConfig,
	AgentLoopNextAction,
	AgentLoopNextActionContext,
	AgentMessage,
	AgentRequestAuthority,
	AgentTool,
	QueueMode,
	StreamFn,
	ThinkingLevel,
} from "../types.ts";
import type { CoordinatorPhase, OperationStage } from "./coordinator.ts";
import type { ConversationState } from "./fold.ts";
import type {
	ConversationLog,
	ConversationLogEntry,
	ConversationLogLossReason,
	ConversationLogLostError,
} from "./log.ts";

// ============================================================================
// Errors
// ============================================================================

/**
 * - `busy`: an exclusive operation holds the conversation, or admission is suspended.
 * - `ended`: the conversation was closed or its log was lost.
 * - `invalid_state`: the intent cannot run in the current state (no model, nothing to compact).
 * - `invalid_argument`: the intent's input is malformed.
 * - `client_input_conflict`: a client message id was already used for different input.
 * - `commit_rolled_back`: the log rejected the batch without committing it.
 */
export type ConversationErrorCode =
	| "busy"
	| "ended"
	| "invalid_state"
	| "invalid_argument"
	| "client_input_conflict"
	| "commit_rolled_back";

export class ConversationError extends Error {
	readonly code: ConversationErrorCode;

	constructor(code: ConversationErrorCode, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ConversationError";
		this.code = code;
	}
}

// ============================================================================
// Operations
// ============================================================================

/** Exclusive operations: at most one runs at a time. */
export type ConversationOperationKind = "turn" | "compaction" | "navigation" | "host";

export type ConversationPhase = CoordinatorPhase<ConversationOperationKind>;

/** Immutable view of the active exclusive operation. */
export interface ConversationOperationSnapshot {
	readonly id: string;
	readonly kind: ConversationOperationKind;
	readonly stage: OperationStage;
	/** A delivery committed or a request started; navigation can no longer preempt the turn. */
	readonly requestAccepted: boolean;
	readonly signal: AbortSignal;
	/** The first abort source, once an abort was accepted. */
	readonly abortSource?: AgentAbortSource;
}

// ============================================================================
// Options
// ============================================================================

/** Curated provider request options, read for every request. Fast mode comes from the log. */
export interface ConversationStreamOptions {
	transport?: Transport;
	timeoutMs?: number;
	websocketConnectTimeoutMs?: number;
	maxRetries?: number;
	maxRetryDelayMs?: number;
	thinkingBudgets?: ThinkingBudgets;
	toolArgumentLimits?: ToolArgumentLimits;
	env?: ProviderEnv;
	headers?: Record<string, string>;
	metadata?: Record<string, unknown>;
	cacheRetention?: NonNullable<SimpleStreamOptions["cacheRetention"]>;
}

export interface ConversationQueueModes {
	readonly steer: QueueMode;
	readonly followUp: QueueMode;
}

/** One provider response, as `afterProviderResponse` observes it. */
export type ConversationProviderResponse = ProviderResponse;

/** One user-bearing delivery committed since the previous request. */
export interface ConversationRequestDelivery {
	readonly deliveryId: string;
	readonly kind: AgentDeliveryKind;
	/** The client input the delivery completed, when it carried one. */
	readonly clientMessageId?: string;
	readonly messages: readonly UserMessage[];
}

/** Host-only boundary before a turn request. Structural requests never reach it. */
export interface ConversationRequestBoundary {
	readonly attemptId: string;
	readonly cause: "input" | "tools" | "continuation" | "retry";
	readonly requestAuthority: AgentRequestAuthority;
	/** Ordinal of the newest folded entry the request builds on. */
	readonly basisOrdinal: number;
	/** The newest committed user-bearing delivery batch; never inferred from transcript text. */
	readonly batch?: {
		readonly id: string;
		readonly deliveries: readonly ConversationRequestDelivery[];
	};
	readonly newInput: boolean;
}

/** Optional request-local messages with host-owned, synchronous final admission. */
export interface ConversationRequestContext {
	readonly messages: readonly Message[];
	readonly authorization: {
		/** Recheck host authority after the final admission await. Must be synchronous. */
		isCurrent: () => boolean;
		/** Report inclusion or discard exactly once. Must be synchronous. */
		settle: (admitted: boolean) => void;
	};
}

export type ConversationCompactionCause = "manual" | "overflow" | "threshold";

export interface ConversationCompactionCheck {
	/** The assistant message that ended the request. */
	readonly message: AssistantMessage;
	readonly model: Model<Api>;
	readonly state: ConversationState;
	/** True when the turn would otherwise continue with another request. */
	readonly continuing: boolean;
}

/** Compact now. Overflow and mid-turn compaction always continue the turn afterwards. */
export interface ConversationCompactionDecision {
	/** Continue the turn after a threshold compaction at its end. */
	readonly resume?: boolean;
	readonly instructions?: string;
}

/**
 * Host policy. Every hook is optional; a hook that throws during a turn fails
 * that turn with an error assistant message.
 */
export interface ConversationPolicy {
	/** Rewrites the branch messages before conversion for each request. */
	readonly transformContext?: (
		messages: AgentMessage[],
		signal?: AbortSignal,
	) => AgentMessage[] | Promise<AgentMessage[]>;
	/** Inspects or replaces a provider payload; return undefined to keep it. */
	readonly beforeProviderPayload?: (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>;
	readonly afterProviderResponse?: (response: ConversationProviderResponse, model: Model<Api>) => void | Promise<void>;
	readonly beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	readonly afterToolCall?: AgentLoopConfig["afterToolCall"];
	/** Replaces a message before it commits; the replacement keeps the role. */
	readonly messageEnd?: (
		message: AgentMessage,
		signal: AbortSignal,
	) => AgentMessage | undefined | Promise<AgentMessage | undefined>;
	/** Overrides the suggested action at each dispatch boundary; return undefined to keep it. */
	readonly nextAction?: (
		context: AgentLoopNextActionContext,
		signal: AbortSignal,
	) => AgentLoopNextAction | undefined | Promise<AgentLoopNextAction | undefined>;
	/** Adds optional request-local messages after the delivered input committed. */
	readonly requestBoundary?: (
		boundary: ConversationRequestBoundary,
		context: Context,
		signal?: AbortSignal,
	) => Promise<ConversationRequestContext | undefined>;
	/**
	 * Decides whether a failed request retries: the backoff in milliseconds, or
	 * undefined to stop. `attempt` counts from 1 within one turn operation.
	 */
	readonly retry?: (error: ProviderError, attempt: number, message: AssistantMessage) => number | undefined;
	/** Decides whether to compact inside the turn operation; return undefined to skip. */
	readonly compaction?: (
		usage: Usage,
		cause: Exclude<ConversationCompactionCause, "manual">,
		check: ConversationCompactionCheck,
	) => ConversationCompactionDecision | undefined | Promise<ConversationCompactionDecision | undefined>;
}

interface ConversationSummaryRequest {
	readonly state: ConversationState;
	readonly model: Model<Api>;
	readonly thinkingLevel: ThinkingLevel;
	readonly instructions?: string;
	readonly signal: AbortSignal;
	/** Sends summary requests with the conversation's stream options and payload hooks. */
	readonly stream: StreamFn;
}

export interface ConversationCompactionRequest extends ConversationSummaryRequest {
	readonly cause: ConversationCompactionCause;
}

export interface ConversationCompactionSummary {
	readonly summary: string;
	/** A branch entry the compacted context keeps from. */
	readonly firstKeptEntryId: string;
	readonly tokensBefore: number;
	readonly details?: JsonValue;
	readonly fromHook?: boolean;
}

export interface ConversationBranchSummaryRequest extends ConversationSummaryRequest {
	readonly fromLeafId: string | null;
	readonly targetId: string | null;
	readonly commonAncestorId: string | null;
	/** Entries of the abandoned branch after the common ancestor, oldest first. */
	readonly entries: readonly ConversationLogEntry[];
}

export interface ConversationBranchSummary {
	readonly summary: string;
	readonly details?: JsonValue;
	readonly fromHook?: boolean;
}

/** Produces summaries; the kernel owns when they run and commits them. Undefined means nothing to commit. */
export interface ConversationSummarizer {
	compact(request: ConversationCompactionRequest): Promise<ConversationCompactionSummary | undefined>;
	summarizeBranch(request: ConversationBranchSummaryRequest): Promise<ConversationBranchSummary | undefined>;
}

export interface ConversationOptions<TTool extends AgentTool = AgentTool> {
	/** The log this conversation serves for its whole life. */
	readonly log: ConversationLog;
	/** Product entry types the host appends beside the core types. */
	readonly entryTypes?: readonly LogEntryType[];
	/** Base provider stream, such as an `AiClient`'s `streamSimple`. */
	readonly stream: StreamFn;
	/** Resolves the model a log names, such as an `AiClient`'s `getModel`. */
	readonly resolveModel: (provider: string, modelId: string) => Model<Api> | undefined;
	/** No-output replay of `stream` requests; prompt-cache refresh is unavailable without it. */
	readonly promptCacheRefresh?: PromptCacheRefresher;
	readonly summarizer?: ConversationSummarizer;
	readonly tools?: readonly TTool[];
	/** System prompt, or a provider resolved with the operation signal before every request. */
	readonly systemPrompt?: string | ((signal: AbortSignal) => string | Promise<string>);
	/** Converts runtime messages to provider messages; must drop each user message's `clientMessageId`. */
	readonly convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	readonly streamOptions?: ConversationStreamOptions;
	readonly queueModes?: Partial<ConversationQueueModes>;
	readonly policy?: ConversationPolicy;
	/** Shared host admission fence. Defaults to an independent gate. */
	readonly admissionGate?: AgentHarnessAdmissionGate;
	/** Entry, commit, and delivery identifiers. Defaults to random UUIDs. */
	readonly createId?: () => string;
}

// ============================================================================
// Intents
// ============================================================================

/** One durable client input. */
export interface ConversationInput {
	/** Stable client identity; resubmitting it with the same input is idempotent. Generated when absent. */
	readonly clientMessageId?: string;
	/** The input as the client sent it, recorded in the receipt. */
	readonly message: string;
	readonly images?: readonly ImageContent[];
	/** How a prompt submitted while a turn runs is queued; without it such a prompt is rejected. */
	readonly streamingBehavior?: "steer" | "followUp";
	/** The input after host preparation (templates, input hooks); delivered instead of `message`. */
	readonly prepared?: { readonly message: string; readonly images?: readonly ImageContent[] };
	/** Messages delivered right after the user message, in the same batch. Held in memory until then. */
	readonly attachments?: readonly AgentMessage[];
}

export type ConversationInputOutcome =
	/** The input's user message committed and the turn that delivered it settled. */
	| { readonly state: "completed"; readonly entryId: string; readonly ordinal: number }
	| { readonly state: "failed"; readonly error: string }
	| { readonly state: "withdrawn" };

export interface ConversationInputAdmission {
	readonly clientMessageId: string;
	/** Ordinals of the entries that admitted the input; empty for an idempotent resubmission. */
	readonly ordinals: readonly number[];
	/** Settles with the input's outcome; rejects when the conversation ends first. */
	readonly completion: Promise<ConversationInputOutcome>;
}

/** Pending deliveries in admission order, durable client inputs and host messages alike. */
export interface ConversationQueue {
	readonly prompt: readonly AgentMessage[];
	readonly steer: readonly AgentMessage[];
	readonly followUp: readonly AgentMessage[];
}

export interface ConversationCompactionResult {
	readonly status: "compacted" | "skipped" | "aborted";
	/** The committed compaction entry. */
	readonly entryId?: string;
}

export interface ConversationNavigationOptions {
	/** Summarize the abandoned branch with the summarizer before moving. */
	readonly summarize?: boolean;
	readonly instructions?: string;
	/** Label the branch summary entry, or the target when nothing is summarized. */
	readonly label?: string;
}

export interface ConversationNavigationResult {
	readonly status: "navigated" | "aborted";
	readonly leafId: string | null;
	readonly summaryEntryId?: string;
}

/** An entry the host appends: a registered product type, or a core `custom`, `custom_message`, `message`, or `subagent_spawn`. */
export interface ConversationEntryInput {
	readonly type: string;
	readonly payload: unknown;
}

export interface ConversationHostOperationContext {
	readonly signal: AbortSignal;
	/** Sends requests with the conversation's stream options and payload hooks. */
	readonly stream: StreamFn;
	state(): ConversationState;
	append(entries: readonly ConversationEntryInput[]): Promise<readonly ConversationLogEntry[]>;
}

export type ConversationPromptCacheRefreshResult =
	| (PromptCacheRefreshResult & { readonly model: Model<Api> })
	| {
			/** Nothing was sent: no refresh function, no recorded request, or the recorded request is stale. */
			readonly status: "unavailable";
			readonly reason: "no_refresh_function" | "no_request" | "configuration_changed" | "branch_changed";
	  };

/** Why and when a conversation ended. */
export interface ConversationEnd {
	readonly reason: ConversationLogLossReason;
	readonly error: ConversationLogLostError;
}

// ============================================================================
// Events
// ============================================================================

/** A low-level loop event, keyed to the ordinal of the log position it builds on. */
export type ConversationAgentEvent = AgentEvent & { readonly basedOn: number };

export type ConversationEvent =
	/** Entries reached the log and the fold; `ordinal` is the newest. */
	| { readonly type: "committed"; readonly entries: readonly ConversationLogEntry[]; readonly ordinal: number }
	| ConversationAgentEvent
	| { readonly type: "phase_changed"; readonly phase: ConversationPhase }
	| { readonly type: "queue_changed"; readonly queue: ConversationQueue }
	| {
			readonly type: "next_action_resolved";
			readonly action: AgentLoopNextAction;
			readonly requestAuthority: AgentRequestAuthority;
			/** Present only for stop actions. */
			readonly stopReason?: "completion" | "policy" | "tool";
	  }
	| {
			readonly type: "retry_start";
			readonly attempt: number;
			readonly delayMs: number;
			readonly error: ProviderError;
	  }
	| { readonly type: "retry_end"; readonly attempt: number; readonly success: boolean; readonly error?: string }
	| { readonly type: "compaction_start"; readonly cause: ConversationCompactionCause }
	| {
			readonly type: "compaction_end";
			readonly cause: ConversationCompactionCause;
			readonly status: "compacted" | "skipped" | "aborted" | "failed";
			readonly error?: string;
	  }
	| { readonly type: "ended"; readonly reason: ConversationLogLossReason; readonly error: ConversationLogLostError };

export type ConversationListener = (event: ConversationEvent) => void | Promise<void>;
