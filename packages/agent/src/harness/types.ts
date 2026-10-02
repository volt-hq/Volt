import type {
	Context,
	ImageContent,
	InferenceSpeed,
	JsonObject,
	JsonValue,
	Message,
	Model,
	PromptCacheRefreshFunction,
	PromptCacheRefreshResult,
	ProviderEnv,
	SimpleStreamOptions,
	TextContent,
	ThinkingBudgets,
	ToolArgumentLimits,
	Transport,
} from "@hansjm10/volt-ai";
import type {
	AgentDeliveryKind,
	AgentDeliveryOwner,
	AgentEvent,
	AgentLoopNextAction,
	AgentLoopNextActionContext,
	AgentMessage,
	QueueMode,
	StreamFn,
	ThinkingLevel,
} from "../index.ts";
import type { AgentHarnessAdmissionGate } from "./admission-gate.ts";
import type { Session } from "./session/session.ts";

/** Outcome of `AgentHarness.refreshPromptCache`. */
export type AgentHarnessPromptCacheRefreshResult =
	| (PromptCacheRefreshResult & { model: Model<any> })
	| {
			/** Nothing was sent: no refresh function, no retained request, or the retained request is stale. */
			status: "unavailable";
			reason: "no_refresh_function" | "no_request" | "configuration_changed" | "branch_changed";
	  };

/** Normalize unknown thrown values into Error instances before using them as typed error causes. */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	if (typeof error === "string") return new Error(error);
	try {
		return new Error(JSON.stringify(error));
	} catch {
		return new Error(String(error));
	}
}

/** Curated provider request options owned by the harness and snapshotted per turn. */
export interface AgentHarnessStreamOptions {
	/** Preferred transport forwarded to the stream function. */
	transport?: Transport;
	/** Provider request timeout in milliseconds. */
	timeoutMs?: number;
	/** WebSocket connection/open timeout in milliseconds. */
	websocketConnectTimeoutMs?: number;
	/** Maximum provider retry attempts. */
	maxRetries?: number;
	/** Optional cap for provider-requested retry delays. */
	maxRetryDelayMs?: number;
	/** Provider-neutral inference speed preference. */
	inferenceSpeed?: InferenceSpeed;
	/** Per-level thinking token budgets. */
	thinkingBudgets?: ThinkingBudgets;
	/** Bounds for provider tool-argument generation before execution. */
	toolArgumentLimits?: ToolArgumentLimits;
	/** Provider-scoped environment overrides. */
	env?: ProviderEnv;
	/** Additional request headers forwarded to the stream function. */
	headers?: Record<string, string>;
	/** Provider metadata forwarded with requests. */
	metadata?: SimpleStreamOptions["metadata"];
	/** Provider cache retention hint. */
	cacheRetention?: SimpleStreamOptions["cacheRetention"];
}

export type SessionErrorCode =
	| "not_found"
	| "invalid_session"
	| "invalid_entry"
	| "conflict"
	| "authority_retired"
	| "storage"
	| "unknown";

/** Error thrown by session storage, repositories, and session tree operations. */
export class SessionError extends Error {
	/** Session subsystem error code. */
	public code: SessionErrorCode;

	constructor(code: SessionErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "SessionError";
		this.code = code;
	}
}

export type AgentHarnessErrorCode =
	| "busy"
	| "invalid_state"
	| "invalid_argument"
	| "session"
	| "hook"
	| "delivery"
	| "auth"
	| "unknown";

/** Public AgentHarness failure with a stable top-level classification. */
export class AgentHarnessError extends Error {
	public code: AgentHarnessErrorCode;

	constructor(code: AgentHarnessErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "AgentHarnessError";
		this.code = code;
	}
}

export interface SessionTreeEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends SessionTreeEntryBase {
	type: "message";
	message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionTreeEntryBase {
	type: "thinking_level_change";
	thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionTreeEntryBase {
	type: "model_change";
	provider: string;
	modelId: string;
}

export interface ActiveToolsChangeEntry extends SessionTreeEntryBase {
	type: "active_tools_change";
	activeToolNames: string[];
}

export interface CompactionEntry<T = JsonValue> extends SessionTreeEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	fromHook?: boolean;
}

export interface BranchSummaryEntry<T = JsonValue> extends SessionTreeEntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
	details?: T;
	fromHook?: boolean;
}

export interface CustomEntry<T = JsonValue> extends SessionTreeEntryBase {
	type: "custom";
	customType: string;
	data?: T;
}

export interface CustomMessageEntry<T = JsonValue> extends SessionTreeEntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: T;
	display: boolean;
}

export interface LabelEntry extends SessionTreeEntryBase {
	type: "label";
	targetId: string;
	label?: string;
}

export interface SessionInfoEntry extends SessionTreeEntryBase {
	type: "session_info"; // legacy name, kept for backwards compatibility
	name?: string;
}

export interface LeafEntry extends SessionTreeEntryBase {
	type: "leaf";
	targetId: string | null;
}

export type SessionTreeEntry =
	| MessageEntry
	| ThinkingLevelChangeEntry
	| ModelChangeEntry
	| ActiveToolsChangeEntry
	| CompactionEntry
	| BranchSummaryEntry
	| CustomEntry
	| CustomMessageEntry
	| LabelEntry
	| SessionInfoEntry
	| LeafEntry;

export interface SessionContext {
	messages: AgentMessage[];
	thinkingLevel: string;
	model: { provider: string; modelId: string } | null;
	activeToolNames: string[] | null;
	/** Canonical branch leaf used only to validate an ephemeral context projection. */
	anchorLeafId: string | null;
}

export interface SessionMetadata {
	id: string;
	createdAt: string;
}

declare const projectionCursorBrand: unique symbol;

/** Store-issued identity for one revision of one canonical session branch. */
export interface ProjectionCursor {
	readonly authorityGeneration: string;
	readonly revision: number;
	readonly branchIdentity: string | null;
	readonly [projectionCursorBrand]: never;
}

/** One atomic canonical branch read. Entries are ordered from root to the cursor leaf. */
export interface SessionStorageBranchSnapshot {
	readonly cursor: ProjectionCursor;
	readonly entries: readonly SessionTreeEntry[];
}

/** A guard for an atomic session mutation. */
export type ProjectionGuard =
	| { readonly kind: "exact"; readonly cursor: ProjectionCursor }
	| { readonly kind: "descendant"; readonly cursor: ProjectionCursor };

/** Declarative canonical mutation. Storage implementations materialize identity, parent, and timestamp. */
export type SessionMutation =
	| { readonly kind: "append"; readonly entry: PendingSessionWrite }
	| { readonly kind: "move"; readonly leafId: string | null }
	| {
			readonly kind: "move_with_summary";
			readonly leafId: string | null;
			readonly summary?: {
				readonly summary: string;
				readonly details?: JsonValue;
				readonly fromHook?: boolean;
				/** Label materialized against the store-generated branch-summary identity. */
				readonly label?: string;
			};
	  };

/** Stable delivery-attempt identity bound into a canonical mutation receipt. */
export interface SessionDeliveryAttribution {
	readonly deliveryId: string;
	readonly epoch: number;
	readonly attemptId: string;
}

export interface SessionMutationBatch {
	readonly guard: ProjectionGuard;
	readonly mutations: readonly SessionMutation[];
	readonly deliveryAttribution?: SessionDeliveryAttribution;
}

declare const sessionMutationReceiptBrand: unique symbol;

/** Opaque capability issued only after a canonical batch is durably committed. */
export interface SessionMutationReceipt {
	readonly [sessionMutationReceiptBrand]: never;
}

/** Store-authenticated details for one committed mutation receipt. */
export interface SessionMutationReceiptRecord {
	readonly basis: SessionStorageBranchSnapshot;
	readonly before: SessionStorageBranchSnapshot;
	readonly after: SessionStorageBranchSnapshot;
	readonly appendedEntryIds: readonly string[];
	readonly deliveryAttribution?: SessionDeliveryAttribution;
}

export type SessionStorageCommitResult =
	| {
			readonly outcome: "committed";
			readonly receipt: SessionMutationReceipt;
			readonly record: SessionMutationReceiptRecord;
	  }
	| {
			readonly outcome: "rolled_back";
			readonly cursor: ProjectionCursor;
			readonly error: SessionError;
	  }
	| { readonly outcome: "uncertain"; readonly error: SessionError };

/** Canonical branch snapshot reduced into provider-visible context. */
export interface SessionBranchSnapshot extends SessionStorageBranchSnapshot {
	readonly context: SessionContext;
}

/** Exact provider projection change between two store-issued cursors. */
export interface ProjectionAdvance {
	readonly cursor: ProjectionCursor;
	readonly branchRelation: "same" | "descendant" | "diverged";
	readonly messages:
		| { readonly kind: "unchanged" }
		| { readonly kind: "append"; readonly values: readonly AgentMessage[] }
		| { readonly kind: "rewrite"; readonly values: readonly AgentMessage[] };
	readonly persistedPolicy: {
		readonly model: SessionContext["model"];
		readonly thinkingLevel: string;
		readonly activeToolNames: readonly string[] | null;
	};
	readonly persistedPolicyChanged: boolean;
}

export type CanonicalCommitResult =
	| {
			readonly outcome: "committed";
			readonly advance: ProjectionAdvance;
			readonly receipt: SessionMutationReceipt;
			readonly appendedEntryIds: readonly string[];
	  }
	| {
			readonly outcome: "rolled_back";
			readonly cursor: ProjectionCursor;
			readonly error: SessionError;
	  }
	| { readonly outcome: "uncertain"; readonly error: SessionError };

/** Store-verified canonical result recovered from an opaque commit receipt. */
export interface ResolvedSessionMutationReceipt {
	readonly advance: ProjectionAdvance;
	readonly appendedEntryIds: readonly string[];
	readonly deliveryAttribution?: SessionDeliveryAttribution;
}

export interface SessionStorage<TMetadata extends SessionMetadata = SessionMetadata> {
	getMetadata(): Promise<TMetadata>;
	/** Atomically snapshot the current branch, or re-read a previously issued cursor. */
	getBranchSnapshot(cursor?: ProjectionCursor): Promise<SessionStorageBranchSnapshot>;
	/** Apply a short declarative batch under one canonical mutation lane. */
	commitBatch(batch: SessionMutationBatch): Promise<SessionStorageCommitResult>;
	/** Resolve a receipt only when it was issued by this storage authority. */
	resolveMutationReceipt(receipt: SessionMutationReceipt): SessionMutationReceiptRecord | undefined;
	getLeafId(): Promise<string | null>;
	getEntry(id: string): Promise<SessionTreeEntry | undefined>;
	findEntries<TType extends SessionTreeEntry["type"]>(
		type: TType,
	): Promise<Array<Extract<SessionTreeEntry, { type: TType }>>>;
	getLabel(id: string): Promise<string | undefined>;
	getPathToRoot(leafId: string | null): Promise<SessionTreeEntry[]>;
	getEntries(): Promise<SessionTreeEntry[]>;
}

export type { Session } from "./session/session.ts";

export type AgentHarnessPhase = "idle" | "turn" | "compaction" | "branch_summary" | "retry";

export type PendingSessionWrite = Exclude<SessionTreeEntry, LeafEntry> extends infer TEntry
	? TEntry extends Exclude<SessionTreeEntry, LeafEntry>
		? Omit<TEntry, "id" | "parentId" | "timestamp">
		: never
	: never;

export interface QueueUpdateEvent {
	type: "queue_update";
	steer: AgentMessage[];
	followUp: AgentMessage[];
}

export interface SavePointEvent {
	type: "save_point";
	hadPendingMutations: boolean;
}

export interface SettledEvent {
	type: "settled";
}

export interface ContextEvent {
	type: "context";
	messages: AgentMessage[];
}

/** Return undefined to preserve the suggested action; returning stop explicitly enforces termination. */
export interface NextActionEvent extends AgentLoopNextActionContext {
	type: "next_action";
	signal: AbortSignal;
}

/** Final policy decision, after authority normalization and before delivery preparation or run settlement. */
export interface NextActionResolvedEvent {
	type: "next_action_resolved";
	action: AgentLoopNextAction;
	requestAuthority: AgentLoopNextActionContext["requestAuthority"];
	/** Present only for stop actions. Completion permits independently authorized future work. */
	stopReason?: "completion" | "policy" | "tool";
}

export interface BeforeProviderPayloadEvent {
	type: "before_provider_payload";
	model: Model<any>;
	payload: unknown;
}

export interface AfterProviderResponseEvent {
	type: "after_provider_response";
	status: number;
	headers: Record<string, string>;
}

export interface ToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: JsonObject;
	/** Current block decision from earlier reducers. */
	block?: boolean;
	/** Current block reason from earlier reducers. */
	reason?: string;
}

export interface ToolResultEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: JsonObject;
	content: Array<TextContent | ImageContent>;
	details?: JsonValue;
	isError: boolean;
}

export interface ModelUpdateEvent {
	type: "model_update";
	model: Model<any> | undefined;
	previousModel: Model<any> | undefined;
	source: "set" | "restore";
}

export interface ThinkingLevelUpdateEvent {
	type: "thinking_level_update";
	level: ThinkingLevel;
	previousLevel: ThinkingLevel;
}

export interface ToolsUpdateEvent {
	type: "tools_update";
	toolNames: string[];
	previousToolNames: string[];
	activeToolNames: string[];
	previousActiveToolNames: string[];
	source: "set" | "restore";
}

export type AgentHarnessOwnEvent =
	| QueueUpdateEvent
	| SavePointEvent
	| SettledEvent
	| ContextEvent
	| NextActionEvent
	| NextActionResolvedEvent
	| BeforeProviderPayloadEvent
	| AfterProviderResponseEvent
	| ToolCallEvent
	| ToolResultEvent
	| ModelUpdateEvent
	| ThinkingLevelUpdateEvent
	| ToolsUpdateEvent;

export type AgentHarnessEvent = AgentEvent | AgentHarnessOwnEvent;

export interface ContextResult {
	messages: AgentMessage[];
}

export interface MessageEndResult {
	message: AgentMessage;
}

export interface BeforeProviderPayloadResult {
	payload: unknown;
}

export interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

export interface ToolResultPatch {
	content?: Array<TextContent | ImageContent>;
	details?: JsonValue;
	isError?: boolean;
	disposition?: "stop" | "final_response";
}

export type AgentHarnessEventResultMap = {
	context: ContextResult | undefined;
	message_end: MessageEndResult | undefined;
	next_action: AgentLoopNextAction | undefined;
	next_action_resolved: undefined;
	before_provider_payload: BeforeProviderPayloadResult | undefined;
	after_provider_response: undefined;
	tool_call: ToolCallResult | undefined;
	tool_result: ToolResultPatch | undefined;
	model_update: undefined;
	thinking_level_update: undefined;
	tools_update: undefined;
	save_point: undefined;
	settled: undefined;
};

export type AgentHarnessContextProjectionSource = "explicit" | "retry" | "compaction";

/** Identity and canonical origin of one installed ephemeral context projection. */
export interface AgentHarnessContextProjectionToken {
	readonly projectionId: string;
	readonly source: AgentHarnessContextProjectionSource;
	readonly anchorLeafId: string | null;
}

export interface AgentHarnessContextRebaseOptions {
	readonly source: AgentHarnessContextProjectionSource;
	/**
	 * Synchronously derive projected messages from an isolated readonly clone of
	 * one canonical branch snapshot.
	 */
	readonly project?: (messages: readonly AgentMessage[]) => readonly AgentMessage[];
}

export interface AgentHarnessRunOptions {
	/** Override the configured system prompt for this bounded run. */
	systemPrompt?: string;
	/** Override provider context for this run without changing canonical session history. */
	context?: readonly AgentMessage[];
	/** Owner installed before the prompt becomes visible in the delivery inbox. */
	deliveryOwner?: AgentDeliveryOwner;
}

/**
 * Return undefined for no change. Every returned action is an explicit override,
 * including stop when the suggested action is already stop. Use pause for resumable interruptions.
 */
export type AgentHarnessNextActionPolicy = (
	context: AgentLoopNextActionContext,
	signal: AbortSignal,
) => AgentLoopNextAction | undefined | Promise<AgentLoopNextAction | undefined>;

/** Host-only post-delivery boundary. Structural requests never enter this callback. */
export interface AgentHarnessRequestBoundary {
	readonly attemptId: string;
	readonly cause: "input" | "tools" | "continuation" | "retry";
	readonly requestAuthority: AgentLoopNextActionContext["requestAuthority"];
	readonly cursor: ProjectionCursor;
	/** Most recent verified, user-bearing delivery batch; never inferred from transcript text. */
	readonly batch?: {
		readonly id: string;
		readonly deliveries: readonly {
			readonly deliveryId: string;
			readonly kind: AgentDeliveryKind;
			readonly messages: readonly Extract<AgentMessage, { role: "user" }>[];
		}[];
	};
	readonly newInput: boolean;
}

/** Optional provider-only messages with host-owned, synchronous final admission authorization. */
export interface AgentHarnessRequestContext {
	readonly messages: readonly Message[];
	readonly authorization: {
		/** Recheck current host authority after the final admission await. Must be synchronous. */
		isCurrent: () => boolean;
		/** Report inclusion or discard exactly once. Must be synchronous. */
		settle: (admitted: boolean) => void;
	};
}

export interface AgentHarnessOptions {
	session: Session;
	/** Shared host admission fence. Defaults to an independent gate; does not gate queues or cleanup. */
	admissionGate?: AgentHarnessAdmissionGate;
	/** System prompt, or a provider resolved with the active operation's signal for each request snapshot. */
	systemPrompt?: string | ((signal: AbortSignal) => string | Promise<string>);
	/** Base provider stream implementation wrapped by Harness lifecycle policy. */
	streamFn?: StreamFn;
	/**
	 * No-output replay used by `refreshPromptCache`. Defaults to the provider refresh only when
	 * `streamFn` is omitted; a custom `streamFn` must supply a matching refresh or refresh is unavailable.
	 */
	refreshPromptCacheFn?: PromptCacheRefreshFunction;
	/** Append optional request-local messages after context reconciliation; never writes canonical history. */
	requestBoundary?: (
		boundary: AgentHarnessRequestBoundary,
		context: Context,
		signal?: AbortSignal,
	) => Promise<AgentHarnessRequestContext | undefined>;
	/** Convert application messages into provider-compatible messages. */
	convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	/** Curated stream/provider request options. Snapshotted at turn start. */
	streamOptions?: AgentHarnessStreamOptions;
	/** Default owner installed before every high-level delivery admission. */
	deliveryOwner?: AgentDeliveryOwner;
	/** May be omitted at construction, but must be set before a model-backed operation starts. */
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	/** Persist active-tool projections through the session. Disable when the host owns that policy outside session context. */
	persistActiveToolChanges?: boolean;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
}

export type { AgentHarness } from "./agent-harness.ts";
