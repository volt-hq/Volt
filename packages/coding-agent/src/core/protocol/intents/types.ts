/**
 * The host side of protocol intents (RFC §6.1): one definition per intent,
 * binding the protocol schema (`INTENT_SCHEMAS`) to what a client may know
 * about it (its descriptor) and what the host does (`run`).
 *
 * A definition's `run` returns a domain outcome; `accept` maps the outcome to
 * the wire acceptance (`conversation`, `result`). Admission (profile, input
 * schema, fence, availability) is the registry's and happens before `run`.
 */

import type { ThinkingLevel } from "@hansjm10/volt-agent-core";
import type { Api, Model } from "@hansjm10/volt-ai";
import type {
	BuiltinIntentName,
	IntentInput,
	IntentOption,
	IntentOutput,
	IntentPresentation,
	IntentSlashAlias,
	IntentStateValue,
	IrohRemoteWorktreeSummary,
	PrReviewPrepareRequest,
	PrReviewPrepareResponse,
	PrReviewResolveResponse,
	PrReviewSourceRequest,
	RejectionCode,
	RemoteCapability,
	RemoteGrant,
	RpcAgentOptionsSchema,
	RpcKeepAwakeStatus,
	RpcListSubagentsResponse,
	RpcRegisterPushTargetArgs,
	RpcRegisterPushTargetResponse,
	RpcSessionContextSchema,
	RpcSessionListItemSchema,
} from "@hansjm10/volt-protocol";
import type { Static } from "typebox";
import type { AgentSession } from "../../agent-session.ts";
import type { InputSource } from "../../extensions/types.ts";
import type { ConversationHost } from "../../host/conversation-host.ts";
import type { HostedConversation } from "../../host/hosted-conversation.ts";
import type { HostClient } from "../../host/targets.ts";
import type { PlanningState } from "../../planning.ts";
import type { ReviewRunControls, ReviewTarget, ReviewWorkflowResult } from "../../review.ts";
import type { ReviewDiscussionService } from "../../review-discussions.ts";
import type { SessionManager } from "../../session-manager.ts";
import type { SettingsManager } from "../../settings-manager.ts";
import type { SubscriptionUsageService } from "../../subscription-usage.ts";
import type { Profile } from "../profiles.ts";

// ============================================================================
// Profiles
// ============================================================================

/**
 * Who invokes: a local client (full fidelity, every intent) or a paired
 * remote device, limited to remote-safe intents within its grant.
 */
export type IntentProfile = { readonly name: "local" } | { readonly name: "remote"; readonly grant: RemoteGrant };

export const LOCAL_INTENT_PROFILE: IntentProfile = Object.freeze({ name: "local" });

// ============================================================================
// Context
// ============================================================================

/** The conversation a conversation-scope intent acts on, and the client invoking it. */
export interface IntentTarget {
	readonly session: AgentSession;
	readonly conversation: HostedConversation;
	readonly host: ConversationHost;
	readonly client: HostClient;
}

/** How a review starts: remote reviews confirm, require project trust, and sanitize failures. */
export interface IntentReviewOptions {
	readonly remote: boolean;
	readonly requireConfirmation: boolean;
	readonly controls?: Partial<ReviewRunControls>;
	readonly parentRunId?: string;
	/** Auxiliary tools of the conversation the passes may use besides their snapshot tools (local clients only). */
	readonly tools?: readonly string[];
}

/** Subagents of the conversation, on hosts that let clients start them. */
export interface IntentSubagentServices {
	list(): RpcListSubagentsResponse;
	/** Start a subagent as work of the conversation: its work id (the subagent id) and its child conversation. */
	start(agent: string, prompt: string): Promise<{ readonly workId: string; readonly conversation: string }>;
}

/** Host keep-awake: the status a client sees never names the host mechanism. */
export interface IntentKeepAwakeService {
	status(): RpcKeepAwakeStatus;
	setEnabled(enabled: boolean): RpcKeepAwakeStatus;
}

/** The stored web search key: clients learn only whether one is stored. */
export interface IntentWebSearchKeyService {
	readonly configured: boolean;
	set(apiKey: string | null): void;
}

export interface IntentPushTargetService {
	register(args: RpcRegisterPushTargetArgs): Promise<RpcRegisterPushTargetResponse>;
}

/** A failed workspace operation, by the stable error the remote wire reports; `details` are for the host's audit log. */
export class WorkspaceIntentError extends Error {
	readonly error: string;
	readonly details?: Record<string, unknown>;

	constructor(error: string, details?: Record<string, unknown>) {
		super(error);
		this.name = "WorkspaceIntentError";
		this.error = error;
		if (details !== undefined) this.details = details;
	}
}

export interface IntentWorktreeRemoval {
	readonly stoppedRuntimeCount: number;
	readonly closedStreamCount: number;
}

/**
 * The registered workspace a remote connection is bound to. Every operation
 * acts on that workspace only; failures throw {@link WorkspaceIntentError}.
 */
export interface IntentWorkspaceServices {
	readonly name: string;
	unregister?(): Promise<void>;
	createWorktree?(options: {
		id?: string;
		branch?: string;
		baseRef?: string;
		workingDirectory?: string;
	}): Promise<IrohRemoteWorktreeSummary>;
	listWorktrees?(): Promise<IrohRemoteWorktreeSummary[]>;
	removeWorktree?(worktreeId: string, force: boolean): Promise<IntentWorktreeRemoval>;
	listDirectories?(
		path: string | undefined,
	): Promise<{ path?: string; directories: { name: string; path: string }[] }>;
	agentOptions?(): Promise<Static<typeof RpcAgentOptionsSchema>>;
	sessionContexts?(sessionIds: readonly string[]): Promise<Static<typeof RpcSessionContextSchema>[]>;
	resolvePrReview?(request: PrReviewSourceRequest): Promise<PrReviewResolveResponse>;
	preparePrReview?(request: PrReviewPrepareRequest): Promise<PrReviewPrepareResponse>;
	uploadDeviceLogs?(request: { fileName?: string; content: string }): Promise<{ path: string; byteCount: number }>;
	/** The workspace's sessions, newest first, as the host lists them to its remote clients. */
	listSessions?(): Promise<Static<typeof RpcSessionListItemSchema>[]>;
}

/** The theme a host shares with its remote clients: resolved hex colors by token name. */
export interface IntentHostTheme {
	readonly themeName: string;
	readonly tokens: Readonly<Record<string, string>>;
}

/**
 * What a host provides beyond the conversation: each host (stdio RPC, the
 * TUI, the daemon) supplies the services it has. An intent whose service is
 * missing is not available on that host.
 */
export interface IntentServices {
	/** Stop the run: hosts differ in the abort reason and whether queued input is delivered. */
	readonly abortRun?: (session: AgentSession) => Promise<void>;
	/** Start a review. A detached host starts it as `review` work and answers `accepted`. */
	readonly runReview?: (target: ReviewTarget, options: IntentReviewOptions) => Promise<ReviewWorkflowResult>;
	/** Reviews run detached from the conversation, so its busy states do not gate them. */
	readonly detachedReviews?: boolean;
	readonly reviewDiscussions?: ReviewDiscussionService;
	readonly subagents?: IntentSubagentServices;
	readonly subscriptionUsage?: SubscriptionUsageService;
	readonly keepAwake?: IntentKeepAwakeService;
	readonly webSearchKey?: IntentWebSearchKeyService;
	readonly pushTargets?: IntentPushTargetService;
	readonly workspace?: IntentWorkspaceServices;
	/** The theme the host shares, when it shares one. */
	readonly hostTheme?: () => IntentHostTheme | undefined;
}

/** One invocation's context: the target conversation (conversation scope), the host's services, and the profile. */
export interface IntentContext {
	readonly target?: IntentTarget;
	readonly services: IntentServices;
	readonly profile: IntentProfile;
	/** The frame's intent id: for input intents, the input's durable `clientMessageId`. */
	readonly intentId?: string;
	/** Recheck the caller's authority (transport lease, branch) before a mutation; throws when stale. */
	readonly assertCurrent?: () => void;
	/** A protocol connection's subscriber profile: what `history` and `content` project. */
	readonly subscriber?: Profile;
	/**
	 * The log of a closed conversation the client may read, opened read-only:
	 * what the queries that read logs (`history`, `content`, `work_output`)
	 * read when no runtime serves the conversation. Set without a target.
	 */
	readonly closedLog?: SessionManager;
	/** The source of the `input` event the prompts it sends raise; `rpc` by default. */
	readonly inputSource?: InputSource;
}

// ============================================================================
// Availability
// ============================================================================

/** The conversation state availability, state, and descriptions read. */
export interface IntentState {
	readonly isReviewDiscussion?: boolean;
	readonly isBusy?: boolean;
	readonly isStreaming: boolean;
	readonly isCompacting: boolean;
	readonly model?: Model<Api>;
	readonly thinkingLevel?: ThinkingLevel;
	readonly fastModeEnabled?: boolean;
	readonly planningState?: PlanningState;
	readonly settingsManager?: SettingsManager;
}

export const IDLE_INTENT_STATE: IntentState = Object.freeze({ isStreaming: false, isCompacting: false });

/** What availability is computed against. */
export interface IntentView {
	readonly state: IntentState;
	readonly services: IntentServices;
	readonly profile: IntentProfile;
	/** The conversation, when availability depends on more than its state (an invocation's input). */
	readonly target?: IntentTarget;
}

export type IntentAvailability =
	| { readonly enabled: true }
	| {
			readonly enabled: false;
			readonly reason: string;
			readonly code?: "unavailable" | "invalid_input" | "not_allowed";
	  };

export const INTENT_ENABLED: IntentAvailability = Object.freeze({ enabled: true });

// ============================================================================
// Definitions
// ============================================================================

export type IntentCategory =
	| "session"
	| "model"
	| "context"
	| "review"
	| "mcp"
	| "host"
	| "extension"
	| "prompt"
	| "skill"
	| "advanced";

/** What the host says when it accepts an intent: the conversation it moved the client to, and its result. */
export interface IntentAcceptance<N extends BuiltinIntentName> {
	readonly conversation?: string;
	readonly result?: IntentOutput<N>;
}

/** The metadata a descriptor carries, shared by built-in and dynamic intents. */
export interface IntentMetadata {
	readonly label: string;
	readonly description?: string | ((view: IntentView) => string);
	readonly category: IntentCategory;
	/** `conversation` intents need a target conversation; `host` intents act on the host. */
	readonly scope: "conversation" | "host";
	/** `branch`: rejected `stale` when the branch switched after the client's `expectedOrdinal`. */
	readonly fence: "none" | "branch";
	/** Whether a remote profile may invoke it at all. */
	readonly remote: "safe" | "unsafe";
	/** The remote capabilities an invocation needs. */
	readonly requires: readonly RemoteCapability[];
	/** While the conversation is busy: rejected, run at once, or queued as a prompt. */
	readonly whileBusy: "reject" | "run" | "queue";
	readonly confirm?: { readonly message?: string; readonly destructive?: boolean };
	readonly presentation?: IntentPresentation;
	readonly slash?: IntentSlashAlias;
	/** Input fields the `intent_completions` query completes. */
	readonly completions?: readonly string[];
}

export interface IntentDefinition<N extends BuiltinIntentName, O> extends IntentMetadata {
	readonly name: N;
	/**
	 * A review discussion's source owns this lifecycle operation (for this
	 * input): the discussion rejects it. Linkage is not a capability ceiling.
	 */
	readonly sourceOwned?: boolean | ((input: IntentInput<N>, view: IntentView) => boolean);
	available?(view: IntentView, input?: IntentInput<N>): IntentAvailability;
	state?(view: IntentView): IntentStateValue | undefined;
	complete?(ctx: IntentContext, field: string, prefix: string): Promise<IntentOption[]>;
	run(ctx: IntentContext, input: IntentInput<N>): Promise<O>;
	accept?(outcome: O): IntentAcceptance<N>;
}

/** Builds a definition, keeping its outcome type. */
export function defineIntent<N extends BuiltinIntentName, O>(
	definition: IntentDefinition<N, O>,
): IntentDefinition<N, O> {
	return definition;
}

// ============================================================================
// Rejections
// ============================================================================

/** An intent the host refused before running it, or a run that failed with a protocol code. */
export class IntentRejectedError extends Error {
	readonly code: RejectionCode;
	readonly ordinal?: number;
	readonly requiredCapability?: RemoteCapability;

	constructor(
		code: RejectionCode,
		message: string,
		details: { ordinal?: number; requiredCapability?: RemoteCapability } = {},
	) {
		super(message);
		this.name = "IntentRejectedError";
		this.code = code;
		if (details.ordinal !== undefined) this.ordinal = details.ordinal;
		if (details.requiredCapability !== undefined) this.requiredCapability = details.requiredCapability;
	}
}

/** The profile of a client holding `grant`, or the local profile without one. */
export function intentProfileFor(grant: RemoteGrant | undefined): IntentProfile {
	return grant === undefined ? LOCAL_INTENT_PROFILE : { name: "remote", grant };
}

/** The first capability in `required` the grant lacks. */
export function missingCapability(
	grant: RemoteGrant,
	required: readonly RemoteCapability[],
): RemoteCapability | undefined {
	const granted = new Set(grant.capabilities);
	return required.find((capability) => !granted.has(capability));
}
