/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines to an RPC transport.
 * Responses and events are emitted as JSON lines by the transport.
 */

import type { AgentMessage, ThinkingLevel } from "@earendil-works/volt-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/volt-ai";
import type { SessionStats } from "../agent-session.ts";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionResult } from "../compaction/index.ts";
import type { HostActionDecisionKind, HostActionRequest, HostActionUpdate } from "../host-interaction.ts";
import type {
	McpOAuthBrowserCompleteResult,
	McpOAuthBrowserStartResult,
	McpOAuthDevicePollResult,
	McpOAuthDeviceStartResult,
} from "../mcp/oauth-flow.ts";
import type { McpRpcCapabilities } from "../mcp/rpc.ts";
import type {
	McpPromptSummary,
	McpRecentCallSummary,
	McpResourceSummary,
	McpServerSummary,
	McpToolSummary,
} from "../mcp/types.ts";
import type { SourceInfo } from "../source-info.ts";

export type RpcModel = Model<Api>;
/** A model as reported to clients: the raw model plus the thinking levels it supports. */
export type RpcCatalogModel = RpcModel & { availableThinkingLevels: ThinkingLevel[] };
export type RpcSubagentDefinitionSource = "built-in" | "user" | "project";

// ============================================================================
// RPC Commands
// ============================================================================

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// Client capabilities and host-initiated actions
	| { id?: string; type: "set_client_capabilities"; features: RpcClientCapabilityFeature[] }
	| { id?: string; type: "get_pending_host_actions" }

	// Native UI actions
	| { id?: string; type: "get_ui_capabilities" }
	| { id?: string; type: "get_ui_actions"; scope?: UiActionListScope }
	| {
			id?: string;
			type: "get_ui_action_completions";
			action: string;
			argument: string;
			prefix?: string;
	  }
	| {
			id?: string;
			type: "invoke_ui_action";
			action: string;
			args?: Record<string, unknown>;
			streamingBehavior?: UiActionInvocationQueueBehavior;
	  }

	// Push notifications
	| { id?: string; type: "register_push_target"; args: RpcRegisterPushTargetArgs }
	| {
			id?: string;
			type: "register_live_activity";
			workspaceName: string;
			sessionId: string;
			activityId: string;
			tokenHash: string;
			tokenEnvironment: RpcPushTokenEnvironment;
			platform: RpcPushPlatform;
	  }
	| { id?: string; type: "unregister_live_activity"; workspaceName: string; sessionId: string; activityId: string }

	// Remote host management
	| { id?: string; type: "unregister_workspace"; name: string }
	| { id?: string; type: "set_keep_awake"; enabled: boolean }
	| { id?: string; type: "get_keep_awake" }
	| { id?: string; type: "set_web_search_key"; apiKey?: string | null }
	| { id?: string; type: "get_web_search_status" }

	// Device diagnostics
	| { id?: string; type: "upload_device_logs"; fileName?: string; content: string }

	// MCP management
	| { id?: string; type: "get_mcp_capabilities" }
	| { id?: string; type: "list_mcp_servers" }
	| { id?: string; type: "get_mcp_server"; server: string }
	| { id?: string; type: "connect_mcp_server"; server: string }
	| { id?: string; type: "disconnect_mcp_server"; server: string }
	| { id?: string; type: "refresh_mcp_server"; server: string }
	| { id?: string; type: "start_mcp_server_auth"; server: string; flow?: "browser" | "device"; redirectUrl?: string }
	| {
			id?: string;
			type: "complete_mcp_server_auth";
			server: string;
			redirectUrl: string;
			code: string;
			state?: string;
	  }
	| { id?: string; type: "poll_mcp_server_auth"; server: string }
	| { id?: string; type: "cancel_mcp_server_auth"; server: string }
	| { id?: string; type: "logout_mcp_server"; server: string }
	| { id?: string; type: "set_mcp_server_enabled"; server: string; enabled: boolean }
	| { id?: string; type: "list_mcp_tools"; server: string }
	| { id?: string; type: "get_mcp_tool"; server: string; tool: string }
	| { id?: string; type: "list_mcp_resources"; server: string; cursor?: string }
	| { id?: string; type: "read_mcp_resource"; server: string; resourceUri: string }
	| { id?: string; type: "list_mcp_prompts"; server: string; cursor?: string }
	| {
			id?: string;
			type: "get_mcp_prompt";
			server: string;
			prompt: string;
			arguments?: Record<string, unknown>;
			argumentsJson?: string;
	  }
	| { id?: string; type: "list_mcp_recent_calls"; server?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_transcript"; limit?: number; beforeEntryId?: string }
	| { id?: string; type: "get_message_images"; entryId: string; startImageIndex?: number }

	// Subagents (local RPC only)
	| { id?: string; type: "list_subagents" }
	| { id?: string; type: "subagent_start"; agent: string; prompt: string }
	| { id?: string; type: "subagent_abort"; subagentId: string }
	| { id?: string; type: "subagent_get_state"; subagentId: string }
	| { id?: string; type: "subagent_get_transcript"; subagentId: string; limit?: number; beforeEntryId?: string }
	| { id?: string; type: "subagent_dispose"; subagentId: string }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string; persistDefault?: boolean }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel; persistDefault?: boolean }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "list_sessions" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "switch_session_by_id"; sessionId: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" };

// ============================================================================
// RPC Native UI Actions
// ============================================================================

export type UiActionSource = "builtin" | "extension" | "prompt" | "skill" | "package";
export type UiActionCategory =
	| "review"
	| "session"
	| "model"
	| "context"
	| "extension"
	| "prompt"
	| "skill"
	| "advanced";
export type UiActionPresentationKind = "card" | "button" | "toggle" | "picker" | "palette" | "detail" | "hidden";
export type UiActionArgumentType = "string" | "boolean" | "enum" | "integer";
export type UiActionStateType = "boolean" | "string" | "enum" | "integer";
export type UiActionStreamingBehavior = "disabled" | "immediate" | "queueSteer" | "queueFollowUp";
export type UiActionScalar = string | number | boolean | null;
export type UiActionListScope = "primary" | "palette" | "all";
export type UiActionInvocationQueueBehavior = "steer" | "followUp";
export type UiActionInvocationStatus = "accepted" | "completed" | "queued" | "handled" | "cancelled";
export type UiActionCapabilityFeature =
	| "ui_actions.v1"
	| "ui_action_invocation.v1"
	| "ui_action_completions.v1"
	| (string & {});
export type RpcClientCapabilityFeature = "host_action_requests.v1" | (string & {});

export interface UiActionOptionDescriptor {
	value: string;
	label?: string;
	description?: string;
}

export interface UiActionPresentationHint {
	kind: UiActionPresentationKind | (string & {});
	group?: string;
	priority?: number;
	icon?: string;
}

export interface UiActionArgumentDescriptor {
	name: string;
	label?: string;
	description?: string;
	type: UiActionArgumentType | (string & {});
	required?: boolean;
	multiline?: boolean;
	placeholder?: string;
	hint?: string;
	defaultValue?: UiActionScalar;
	options?: UiActionOptionDescriptor[];
	completion?: "commandArguments" | (string & {});
}

export interface UiActionStateDescriptor {
	type: UiActionStateType | (string & {});
	value: UiActionScalar;
	label?: string;
	options?: UiActionOptionDescriptor[];
}

export interface UiActionSlashAlias {
	name: string;
	example?: string;
}

export interface UiActionDescriptor {
	schemaVersion: 1;
	id: string;
	label: string;
	description?: string;
	source: UiActionSource | (string & {});
	sourceScope?: "user" | "project" | "temporary";
	sourceOrigin?: "package" | "top-level";
	sourceLabel?: string;
	category: UiActionCategory | (string & {});
	presentation?: UiActionPresentationHint;
	args?: UiActionArgumentDescriptor[];
	state?: UiActionStateDescriptor;
	enabled: boolean;
	disabledReason?: string | null;
	destructive?: boolean;
	requiresConfirmation?: boolean;
	streamingBehavior?: UiActionStreamingBehavior | UiActionStreamingBehavior[];
	remoteSafe: boolean;
	slash?: UiActionSlashAlias;
}

export interface UiActionCapabilities {
	protocolVersion: 1;
	features: UiActionCapabilityFeature[];
	maxActions: number;
	maxDescriptorBytes: number;
}

export interface UiActionListResponse {
	actions: UiActionDescriptor[];
}

export interface UiActionCompletionListResponse {
	completions: UiActionOptionDescriptor[];
}

export interface UiActionInvocationResponse {
	action: string;
	status: UiActionInvocationStatus;
	queuedAs?: UiActionInvocationQueueBehavior;
	state?: UiActionStateDescriptor;
	stateChanged?: boolean;
	actionsChanged?: boolean;
	message?: string;
}

// ============================================================================
// RPC Workflow Events
// ============================================================================

export type RpcWorkflowKind = "review" | (string & {});
export type RpcWorkflowStatus = "running" | "finalizing" | "completed" | "cancelled" | "failed" | (string & {});

export interface RpcWorkflowEvent {
	type: "workflow_start" | "workflow_update" | "workflow_end";
	workflowId: string;
	kind: RpcWorkflowKind;
	action?: string;
	title?: string;
	message?: string;
	status?: RpcWorkflowStatus;
}

export type RpcWorkflowToolEvent =
	| {
			type: "tool_execution_start";
			workflowId: string;
			workflowKind: RpcWorkflowKind;
			workflowAction: string;
			toolCallId: string;
			toolName: string;
			args?: Record<string, unknown>;
	  }
	| {
			type: "tool_execution_end";
			workflowId: string;
			workflowKind: RpcWorkflowKind;
			workflowAction: string;
			toolCallId: string;
			toolName: string;
			isError: boolean;
	  };

// ============================================================================
// RPC Host Actions
// ============================================================================

export type RpcHostActionRequest = { type: "host_action_request" } & HostActionRequest;
export type RpcHostActionUpdate = { type: "host_action_update" } & HostActionUpdate;
export type RpcHostActionResponse = {
	type: "host_action_response";
	id: string;
	decision: Exclude<HostActionDecisionKind, "unavailable">;
	message?: string;
};

export interface RpcPendingHostActionsResponse {
	actions: RpcHostActionRequest[];
}

// ============================================================================
// RPC Subagents
// ============================================================================

export interface RpcSubagentSourceInfo {
	source: SourceInfo["source"];
	scope: SourceInfo["scope"];
	origin: SourceInfo["origin"];
}

export interface RpcSubagentDefinition {
	name: string;
	description: string;
	source: RpcSubagentDefinitionSource;
	sourceInfo: RpcSubagentSourceInfo;
	tools?: string[];
	excludedTools?: string[];
	allowedSubagents?: string[];
	maxSubagentDepth?: number;
	maxChildAgents?: number;
	model?: string;
	thinking?: string;
}

export interface RpcListSubagentsResponse {
	subagents: RpcSubagentDefinition[];
}

export interface RpcSubagentStartResponse {
	subagentId: string;
	sessionId: string;
}

// ============================================================================
// RPC Push Notifications
// ============================================================================

export type RpcPushProvider = "fcm";
export type RpcPushPlatform = "ios";
export type RpcPushTokenEnvironment = "development" | "production";

export interface RpcLiveActivityRegistration {
	activityId: string;
	pushToken: string;
	tokenHash?: string;
	tokenEnvironment?: RpcPushTokenEnvironment;
}

export interface RpcRegisterPushTargetArgs {
	provider: RpcPushProvider;
	platform: RpcPushPlatform;
	pushTargetId: string;
	pushTargetAuthToken: string;
	relayUrl?: string;
	tokenHash?: string;
	liveActivity?: RpcLiveActivityRegistration;
	enabled: boolean;
}

export interface RpcRegisterPushTargetResponse {
	status: "registered";
	pushTargetId: string;
}

export interface RpcRegisterLiveActivityResponse {
	status: "registered";
	activityId: string;
}

export interface RpcUnregisterLiveActivityResponse {
	status: "unregistered";
	activityId: string;
}

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** A command available for invocation via prompt */
export interface RpcMcpCapabilitiesResponse extends McpRpcCapabilities {}

export interface RpcMcpServersResponse {
	servers: McpServerSummary[];
}

export interface RpcMcpServerResponse {
	server: McpServerSummary;
	persisted?: { path: string; scope: string };
}

export interface RpcMcpToolsResponse {
	server: string;
	tools: McpToolSummary[];
	metadataHash?: string;
	stale: boolean;
}

export interface RpcMcpToolResponse {
	tool: McpToolSummary;
}

export interface RpcMcpResourcesResponse {
	server: string;
	resources: McpResourceSummary[];
	nextCursor?: string;
}

export interface RpcMcpResourceContentResponse {
	result: unknown;
}

export interface RpcMcpPromptsResponse {
	server: string;
	prompts: McpPromptSummary[];
	nextCursor?: string;
}

export interface RpcMcpPromptContentResponse {
	result: unknown;
}

export interface RpcMcpRecentCallsResponse {
	calls: McpRecentCallSummary[];
}

export type RpcMcpAuthResponse =
	| McpOAuthBrowserStartResult
	| McpOAuthBrowserCompleteResult
	| McpOAuthDeviceStartResult
	| McpOAuthDevicePollResult
	| {
			action: "auth";
			server: string;
			status: "cancelled" | "logged_out";
			message?: string;
			serverSummary?: McpServerSummary;
	  };

export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Source metadata for the owning resource */
	sourceInfo: SourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionListItem {
	sessionId: string;
	sessionName?: string;
	createdAt: string;
	modifiedAt: string;
	messageCount: number;
	firstMessage: string;
	current: boolean;
}

export interface RpcActiveToolExecution {
	toolCallId: string;
	toolName: string;
	status: "started";
	args?: Record<string, unknown>;
}

export interface RpcActiveCompaction {
	reason: "manual" | "threshold" | "overflow";
	/** Unix epoch milliseconds when the active compaction started. */
	startedAt: number;
}

export interface RpcSessionState {
	model?: RpcModel;
	thinkingLevel: ThinkingLevel;
	availableThinkingLevels: ThinkingLevel[];
	/** Whether a provider run or session-level continuation is active. */
	isStreaming: boolean;
	/** Whether any prompt work, including asynchronous preflight, is active. */
	isBusy?: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
	activeTools?: RpcActiveToolExecution[];
	activeCompaction?: RpcActiveCompaction;
}

export type RpcTranscriptToolStatus = "started" | "completed" | "failed";

export interface RpcTranscriptBaseItem {
	id: string;
	role: "user" | "assistant" | "tool" | "summary";
	timestamp: string;
}

export interface RpcTranscriptTextItem extends RpcTranscriptBaseItem {
	role: "user" | "assistant";
	text: string;
	/** Number of inline image blocks on the persisted user message. Transcript
	 *  projections are text-only; clients recover the blocks per entry via
	 *  `get_message_images`. */
	imageCount?: number;
}

export interface RpcTranscriptToolItem extends RpcTranscriptBaseItem {
	role: "tool";
	toolName: string;
	status: RpcTranscriptToolStatus;
	path?: string;
	summary: string;
	/** Number of inline image blocks on the persisted tool result (for example
	 *  a `read` of an image file). Transcript projections are text-only;
	 *  clients recover the blocks per entry via `get_message_images`. */
	imageCount?: number;
	args?: Record<string, unknown>;
	details?: Record<string, unknown>;
	diffPreview?: string;
	patchPreview?: string;
}

export interface RpcTranscriptSummaryItem extends RpcTranscriptBaseItem {
	role: "summary";
	title: "Conversation compacted";
	text: string;
}

export type RpcTranscriptItem = RpcTranscriptTextItem | RpcTranscriptToolItem | RpcTranscriptSummaryItem;

export interface RpcTranscriptResponse {
	sessionId: string;
	items: RpcTranscriptItem[];
	hasMore: boolean;
	nextBeforeEntryId: string | null;
}

/** One recovered image block. Shaped as an ImageContent record (plus its
 *  position on the message) so remote outbound sanitizers pass the base64
 *  payload through untouched. */
export type RpcMessageImage = ImageContent & { index: number };

export interface RpcMessageImagesResponse {
	sessionId: string;
	entryId: string;
	/** Total image blocks on the entry, including any not in this page. */
	totalImages: number;
	images: RpcMessageImage[];
	/** Cursor for the next page, or null when all images have been returned. */
	nextImageIndex: number | null;
}

/**
 * Host keep-awake (prevent sleep) state as reported to phones. Deliberately
 * omits the host-local mechanism (caffeinate etc.); `reason` is generic wording
 * present only when degraded.
 */
export interface RpcKeepAwakeStatus {
	enabled: boolean;
	state: "disabled" | "active" | "degraded";
	reason?: string;
}

/**
 * Host web-search key state as reported to phones. Deliberately omits the key
 * itself; only whether one is stored.
 */
export interface RpcWebSearchStatus {
	configured: boolean;
}

// ============================================================================
// RPC Responses
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// Client capabilities and host-initiated actions
	| { id?: string; type: "response"; command: "set_client_capabilities"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_pending_host_actions";
			success: true;
			data: RpcPendingHostActionsResponse;
	  }

	// Native UI actions
	| { id?: string; type: "response"; command: "get_ui_capabilities"; success: true; data: UiActionCapabilities }
	| { id?: string; type: "response"; command: "get_ui_actions"; success: true; data: UiActionListResponse }
	| {
			id?: string;
			type: "response";
			command: "get_ui_action_completions";
			success: true;
			data: UiActionCompletionListResponse;
	  }
	| {
			id?: string;
			type: "response";
			command: "invoke_ui_action";
			success: true;
			data: UiActionInvocationResponse;
	  }

	// Push notifications
	| {
			id?: string;
			type: "response";
			command: "register_push_target";
			success: true;
			data: RpcRegisterPushTargetResponse;
	  }
	| {
			id?: string;
			type: "response";
			command: "register_live_activity";
			success: true;
			data: RpcRegisterLiveActivityResponse;
	  }
	| {
			id?: string;
			type: "response";
			command: "unregister_live_activity";
			success: true;
			data: RpcUnregisterLiveActivityResponse;
	  }

	// Remote host management
	| {
			id?: string;
			type: "response";
			command: "unregister_workspace";
			success: true;
			data: {
				removedWorkspace: string;
				workspaceNames: string[];
				workspaces: Array<{ name: string; status: string }>;
			};
	  }
	| {
			id?: string;
			type: "response";
			command: "set_keep_awake";
			success: true;
			data: { keepAwake: RpcKeepAwakeStatus };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_keep_awake";
			success: true;
			data: { keepAwake: RpcKeepAwakeStatus };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_web_search_key";
			success: true;
			data: { webSearch: RpcWebSearchStatus };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_web_search_status";
			success: true;
			data: { webSearch: RpcWebSearchStatus };
	  }

	// Device diagnostics
	| {
			id?: string;
			type: "response";
			command: "upload_device_logs";
			success: true;
			data: { path: string; byteCount: number };
	  }

	// MCP management
	| {
			id?: string;
			type: "response";
			command: "get_mcp_capabilities";
			success: true;
			data: RpcMcpCapabilitiesResponse;
	  }
	| { id?: string; type: "response"; command: "list_mcp_servers"; success: true; data: RpcMcpServersResponse }
	| { id?: string; type: "response"; command: "get_mcp_server"; success: true; data: RpcMcpServerResponse }
	| { id?: string; type: "response"; command: "connect_mcp_server"; success: true; data: RpcMcpServerResponse }
	| { id?: string; type: "response"; command: "disconnect_mcp_server"; success: true; data: RpcMcpServerResponse }
	| { id?: string; type: "response"; command: "refresh_mcp_server"; success: true; data: RpcMcpServerResponse }
	| { id?: string; type: "response"; command: "start_mcp_server_auth"; success: true; data: RpcMcpAuthResponse }
	| { id?: string; type: "response"; command: "complete_mcp_server_auth"; success: true; data: RpcMcpAuthResponse }
	| { id?: string; type: "response"; command: "poll_mcp_server_auth"; success: true; data: RpcMcpAuthResponse }
	| { id?: string; type: "response"; command: "cancel_mcp_server_auth"; success: true; data: RpcMcpAuthResponse }
	| { id?: string; type: "response"; command: "logout_mcp_server"; success: true; data: RpcMcpAuthResponse }
	| { id?: string; type: "response"; command: "set_mcp_server_enabled"; success: true; data: RpcMcpServerResponse }
	| { id?: string; type: "response"; command: "list_mcp_tools"; success: true; data: RpcMcpToolsResponse }
	| { id?: string; type: "response"; command: "get_mcp_tool"; success: true; data: RpcMcpToolResponse }
	| { id?: string; type: "response"; command: "list_mcp_resources"; success: true; data: RpcMcpResourcesResponse }
	| {
			id?: string;
			type: "response";
			command: "read_mcp_resource";
			success: true;
			data: RpcMcpResourceContentResponse;
	  }
	| { id?: string; type: "response"; command: "list_mcp_prompts"; success: true; data: RpcMcpPromptsResponse }
	| { id?: string; type: "response"; command: "get_mcp_prompt"; success: true; data: RpcMcpPromptContentResponse }
	| {
			id?: string;
			type: "response";
			command: "list_mcp_recent_calls";
			success: true;
			data: RpcMcpRecentCallsResponse;
	  }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| { id?: string; type: "response"; command: "get_transcript"; success: true; data: RpcTranscriptResponse }
	| {
			id?: string;
			type: "response";
			command: "get_message_images";
			success: true;
			data: RpcMessageImagesResponse;
	  }

	// Subagents (local RPC only)
	| { id?: string; type: "response"; command: "list_subagents"; success: true; data: RpcListSubagentsResponse }
	| { id?: string; type: "response"; command: "subagent_start"; success: true; data: RpcSubagentStartResponse }
	| { id?: string; type: "response"; command: "subagent_abort"; success: true }
	| { id?: string; type: "response"; command: "subagent_get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "subagent_get_transcript";
			success: true;
			data: RpcTranscriptResponse;
	  }
	| { id?: string; type: "response"; command: "subagent_dispose"; success: true }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: RpcCatalogModel;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: RpcModel; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: RpcCatalogModel[] };
	  }

	// Thinking
	| {
			id?: string;
			type: "response";
			command: "set_thinking_level";
			success: true;
			data: { level: ThinkingLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| {
			id?: string;
			type: "response";
			command: "list_sessions";
			success: true;
			data: { sessions: RpcSessionListItem[] };
	  }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "switch_session_by_id"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

// ============================================================================
// Extension UI Events
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
