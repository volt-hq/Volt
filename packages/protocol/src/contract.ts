/**
 * The protocol contract: the protocol frames (`ClientFrame`, `HostFrame`, and
 * their intents, queries, live values, and projected entries), the daemon
 * control plane, the Iroh remote handshake, every named schema (wire frames,
 * log entries, and `UiNode`), and the numeric limits block — everything the
 * JSON Schema artifact (contract/protocol-schema.json) is generated from by
 * scripts/generate-protocol-schema.ts.
 */

import {
	ApiSchema,
	AssistantContentSchema,
	AssistantMessageDiagnosticSchema,
	AssistantMessageSchema,
	DiagnosticErrorInfoSchema,
	ProviderErrorKindSchema,
	ProviderErrorSchema,
	StopReasonSchema,
	TextContentSchema,
	ThinkingContentSchema,
	ToolCallSchema,
	ToolResultMessageSchema,
	UsageSchema,
	UserMessageSchema,
} from "@hansjm10/volt-ai/schemas";
import type { TSchema } from "typebox";
import {
	RpcAgentOptionsDefaultConfigSchema,
	RpcAgentOptionsModelSelectionSchema,
	RpcAgentOptionsSchema,
} from "./agent-options.ts";
import {
	CLIENT_WORK_FINISHED_MAX,
	ClientLabelSchema,
	ClientModelRefSchema,
	ClientQueuedInputSchema,
	ClientSnapshotSchema,
	ClientWorkItemSchema,
	ClientWorkResultSchema,
} from "./client-fold.ts";
import {
	CONTROL_EVENT_SCHEMAS,
	CONTROL_REQUEST_SCHEMAS,
	CONTROL_RESPONSE_SCHEMAS,
	ControlClientKindSchema,
	ControlClientStatusSchema,
	ControlEventSchema,
	ControlFatalSchema,
	ControlHelloAckSchema,
	ControlHelloSchema,
	ControlKeepAwakeStatusSchema,
	ControlLeaseReleaseReasonSchema,
	ControlLeaseStateSchema,
	ControlLeaseStatusSchema,
	ControlRelayCloseReasonSchema,
	ControlRelayCredentialStatusSchema,
	ControlRelayFrameSchema,
	ControlRelayOutcomeSchema,
	ControlRelayPreambleSchema,
	ControlRequestSchema,
	ControlResponseSchema,
	ControlRevokedClientStatusSchema,
	ControlWorkspaceStatusSchema,
	ControlWorktreeStatusSchema,
	DaemonEnvironmentStatusSchema,
	DaemonRemotePolicyStatusSchema,
	RemoteTransportHealthSchema,
} from "./daemon-control.ts";
import {
	BashExecutionMessageSchema,
	ClientInputCommandSchema,
	ClientInputPayloadSchema,
	ClientInputQueuedDeliverySchema,
	ClientInputQueuedPayloadSchema,
	ClientInputStateSchema,
	CORE_LOG_ENTRY_TYPES,
	CustomMessageSchema,
	LogEntrySchema,
	LogEntryVisibilitySchema,
	LogMessageSchema,
	SessionReferenceSchema,
	WorkChildSchema,
	WorkNoticeDetailsSchema,
	WorkResultChildSchema,
	WorkResultSchema,
} from "./entries.ts";
import {
	CatalogNameSchema,
	CLIENT_FRAME_SCHEMAS,
	ClientFrameSchema,
	FatalCodeSchema,
	HOST_FRAME_SCHEMAS,
	HostFrameSchema,
	PROTOCOL_LIMITS,
	ProfileNameSchema,
	QueryErrorCodeSchema,
	QueryErrorReasonSchema,
	RejectionCodeSchema,
	RejectionReasonSchema,
} from "./frames.ts";
import {
	RpcGitChangeCountsSchema,
	RpcGitComparisonSchema,
	RpcGitContextSchema,
	RpcGitHeadSchema,
	RpcGitObjectIdSchema,
	RpcGitOperationSchema,
	RpcGitRefSchema,
	RpcGitStatusCountsSchema,
} from "./git-context.ts";
import {
	BUILTIN_INTENT_NAMES,
	BuiltinIntentNameSchema,
	DynamicIntentFrameSchema,
	DynamicIntentInputSchema,
	DynamicIntentNameSchema,
	EmptyInputSchema,
	INTENT_FRAME_SCHEMAS,
	INTENT_SCHEMAS,
	IntentAvailabilitySchema,
	IntentCancelledSchema,
	IntentCategorySchema,
	IntentDescriptorSchema,
	IntentFenceSchema,
	IntentFrameSchema,
	IntentNameSchema,
	IntentOptionSchema,
	IntentPresentationSchema,
	type IntentSchemas,
	IntentScopeSchema,
	IntentSlashAliasSchema,
	IntentSourceSchema,
	IntentStateValueSchema,
	IntentWhileBusySchema,
	ReviewWorkflowStartedSchema,
	RpcBashResultSchema,
	RpcCompactionResultSchema,
} from "./intents.ts";
import {
	HostRequestKindSchema,
	HostRequestSchema,
	HostResponseSchema,
	LIVE_ITEM_SCHEMAS,
	LIVE_VALUE_SCHEMAS,
	LiveAssistantEventSchema,
	LiveItemSchema,
	LiveKeySchema,
	LiveToolPartialSchema,
	LiveValueSchema,
} from "./live.ts";
import {
	RpcMcpAuthResponseSchema,
	RpcMcpAuthStateSchema,
	RpcMcpCapabilitiesResponseSchema,
	RpcMcpOAuthBrowserCompleteResultSchema,
	RpcMcpOAuthBrowserStartResultSchema,
	RpcMcpOAuthDevicePollResultSchema,
	RpcMcpOAuthDeviceStartResultSchema,
	RpcMcpPromptContentResponseSchema,
	RpcMcpPromptSummarySchema,
	RpcMcpPromptsResponseSchema,
	RpcMcpRecentCallStatusSchema,
	RpcMcpRecentCallSummarySchema,
	RpcMcpRecentCallsResponseSchema,
	RpcMcpResourceContentResponseSchema,
	RpcMcpResourceSummarySchema,
	RpcMcpResourcesResponseSchema,
	RpcMcpRiskSchema,
	RpcMcpServerResponseSchema,
	RpcMcpServerStatusSchema,
	RpcMcpServerSummarySchema,
	RpcMcpServersResponseSchema,
	RpcMcpSourceScopeSchema,
	RpcMcpToolResponseSchema,
	RpcMcpToolSummarySchema,
	RpcMcpToolsResponseSchema,
} from "./mcp.ts";
import {
	RpcAgentModeSchema,
	RpcPlanExecutionSchema,
	RpcPlanExecutionStrategySchema,
	RpcPlanningStateSchema,
	RpcPlanStateSchema,
	RpcPlanStepSchema,
	RpcPlanStepStatusSchema,
} from "./planning.ts";
import {
	RpcClientMessageIdSchema,
	RpcConversationIdentifierSchema,
	RpcConversationInputImagesSchema,
	RpcImageContentSchema,
	RpcPushPlatformSchema,
	RpcPushProviderSchema,
	RpcQueueModeSchema,
	RpcRegisterPushTargetArgsSchema,
	RpcSafeNonNegativeIntegerSchema,
	RpcStreamingBehaviorSchema,
	RpcThinkingLevelSchema,
} from "./primitives.ts";
import {
	PROJECTED_ENTRY_TYPES,
	ProjectedEntrySchema,
	TranscriptAssistantPartSchema,
	TranscriptItemSchema,
} from "./projected.ts";
import {
	RpcProjectionTruncationSchema,
	RpcReviewAcknowledgmentResponseSchema,
	RpcReviewCompletionStatusSchema,
	RpcReviewCorrectnessSchema,
	RpcReviewCoverageSchema,
	RpcReviewFindingSchema,
	RpcReviewFindingStatusSchema,
	RpcReviewLocationSchema,
	RpcReviewOptionsSchema,
	RpcReviewRunDescriptorSchema,
	RpcReviewRunStatusSchema,
	RpcReviewTargetIdentitySchema,
	RpcReviewWorkflowDescriptorSchema,
	RpcReviewWorkflowLifecycleStatusSchema,
	RpcReviewWorkflowListResponseSchema,
	RpcReviewWorkflowResultResponseSchema,
	RpcWorkflowEventSchema,
	RpcWorkflowKindSchema,
	RpcWorkflowStatusSchema,
	RpcWorkflowToolEventSchema,
} from "./projections.ts";
import { IrohRemotePushNotificationDeliveryStatusSchema, IrohRemotePushNotificationSchema } from "./push.ts";
import { QUERY_FRAME_SCHEMAS, QUERY_NAMES, QUERY_SCHEMAS, QueryFrameSchema, QueryNameSchema } from "./queries.ts";
import {
	RemoteAccessPresetNameSchema,
	RemoteCapabilitiesSchema,
	RemoteCapabilitySchema,
	RemoteGrantSchema,
} from "./remote-access.ts";
import {
	IrohRemoteConversationHandshakeMetadataSchema,
	IrohRemoteConversationSelectionSchema,
	IrohRemoteConversationTargetSchema,
	IrohRemoteHandshakeFailureSchema,
	IrohRemoteHandshakeResponseSchema,
	IrohRemoteHandshakeSuccessSchema,
	IrohRemoteHelloSchema,
	IrohRemoteHelloWireSchema,
	IrohRemoteHostHandshakeMetadataSchema,
	IrohRemoteOutcomeSchema,
	IrohRemoteRelayModeSchema,
	IrohRemoteRelayUrlsSchema,
	IrohRemoteSessionIdSchema,
	IrohRemoteWorkingDirectorySchema,
	IrohRemoteWorkspaceDiscoveryTargetSchema,
	IrohRemoteWorkspaceManagementTargetSchema,
	IrohRemoteWorktreeIdSchema,
} from "./remote-handshake.ts";
import {
	RpcListReviewDiscussionsSchema,
	RpcResetReviewDiscussionSchema,
	RpcReviewDiscussionLinkSchema,
	RpcReviewDiscussionSchema,
	RpcStartReviewDiscussionsSchema,
} from "./review-discussions.ts";
import {
	RpcActiveAgentRunSchema,
	RpcActiveCompactionSchema,
	RpcActiveRetrySchema,
	RpcCatalogModelSchema,
	RpcKeepAwakeStatusSchema,
	RpcListSubagentsResponseSchema,
	RpcPromptCacheStatusSchema,
	RpcRegisterPushTargetResponseSchema,
	RpcSessionChangeContextSchema,
	RpcSessionChangePullRequestSchema,
	RpcSessionListItemSchema,
	RpcSubagentDefinitionSchema,
	RpcSubagentDefinitionSourceSchema,
	RpcSubagentSourceInfoSchema,
	RpcWebSearchStatusSchema,
} from "./session.ts";
import {
	RpcSubscriptionUsageErrorCodeSchema,
	RpcSubscriptionUsageLimitSchema,
	RpcSubscriptionUsageProviderReportSchema,
	RpcSubscriptionUsageReportSchema,
	RpcSubscriptionUsageResultSchema,
	RpcSubscriptionUsageSnapshotSchema,
} from "./subscription-usage.ts";
import {
	UI_NODE_LIMITS,
	UiActionsNodeSchema,
	UiCodeNodeSchema,
	UiDiffNodeSchema,
	UiFormNodeSchema,
	UiImageNodeSchema,
	UiKeyValueNodeSchema,
	UiMarkdownNodeSchema,
	UiNodeActionSchema,
	UiNodeFormFieldSchema,
	UiNodeIntentSchema,
	UiNodeSchema,
	UiNodeStyledLineSchema,
	UiNodeStyledSpanSchema,
	UiNodeStyledTextSchema,
	UiNodeTextSchema,
	UiNodeTokenSchema,
	UiProgressNodeSchema,
	UiTableNodeSchema,
	UiTerminalNodeSchema,
	UiTextNodeSchema,
	UiTreeItemSchema,
	UiTreeNodeSchema,
} from "./ui-node.ts";
import {
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
	DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES,
	DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES,
	RPC_ACTIVE_TOOL_DETAILS_MAX_SERIALIZED_BYTES,
	RPC_CLIENT_MESSAGE_ID_MAX_CHARS,
	RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE,
	RPC_CLIENT_MESSAGE_ID_SCHEMA_PATTERN,
	RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_MAX_IMAGES,
	RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES,
	RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES,
	RPC_GIT_CONTEXT_OBSERVED_AT_MAX_CHARS,
	RPC_GIT_CONTEXT_OID_MAX_CHARS,
	RPC_GIT_CONTEXT_OID_PATTERN,
	RPC_GIT_CONTEXT_REF_MAX_CHARS,
	RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS,
	RPC_RETRY_AFTER_MS_MAX,
	RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX,
	RPC_SESSION_QUEUE_MAX_ITEMS,
	RPC_WIRE_MAX_SAFE_INTEGER,
} from "./wire-limits.ts";
import {
	WORK_LIMITS,
	WorkDeliverySchema,
	WorkKindSchema,
	WorkOutcomeSchema,
	WorkProgressSchema,
	WorkProgressStepSchema,
	WorkStateSchema,
	WorkTextSchema,
	WorkTitleSchema,
} from "./work.ts";
import {
	IrohRemoteWorkspaceAvailabilityStatusSchema,
	IrohRemoteWorkspaceMetadataSnapshotSchema,
	IrohRemoteWorkspaceNameSchema,
	IrohRemoteWorkspaceStatusSchema,
} from "./workspace.ts";

// ============================================================================
// Registry: $defs name → schema
// ============================================================================

const SHARED_SCHEMAS: Record<string, TSchema> = {
	// Primitives
	RpcConversationIdentifier: RpcConversationIdentifierSchema,
	RpcClientMessageId: RpcClientMessageIdSchema,
	RpcSafeNonNegativeInteger: RpcSafeNonNegativeIntegerSchema,
	RpcImageContent: RpcImageContentSchema,
	RpcConversationInputImages: RpcConversationInputImagesSchema,
	RpcThinkingLevel: RpcThinkingLevelSchema,
	RpcStreamingBehavior: RpcStreamingBehaviorSchema,
	RpcQueueMode: RpcQueueModeSchema,
	RpcPushProvider: RpcPushProviderSchema,
	RpcPushPlatform: RpcPushPlatformSchema,
	RpcRegisterPushTargetArgs: RpcRegisterPushTargetArgsSchema,

	// Configurable agent options
	RpcAgentOptionsModelSelection: RpcAgentOptionsModelSelectionSchema,
	RpcAgentOptionsDefaultConfig: RpcAgentOptionsDefaultConfigSchema,
	RpcAgentOptions: RpcAgentOptionsSchema,

	// Git context
	RpcGitObjectId: RpcGitObjectIdSchema,
	RpcGitRef: RpcGitRefSchema,
	RpcGitHead: RpcGitHeadSchema,
	RpcGitComparison: RpcGitComparisonSchema,
	RpcGitChangeCounts: RpcGitChangeCountsSchema,
	RpcGitStatusCounts: RpcGitStatusCountsSchema,
	RpcGitOperation: RpcGitOperationSchema,
	RpcGitContext: RpcGitContextSchema,

	// Assistant message family (volt-ai schemas and their wire projections)
	RpcTextContent: TextContentSchema,
	RpcThinkingContent: ThinkingContentSchema,
	RpcToolCall: ToolCallSchema,
	RpcAssistantContent: AssistantContentSchema,
	RpcUsage: UsageSchema,
	RpcStopReason: StopReasonSchema,
	RpcProviderErrorKind: ProviderErrorKindSchema,
	RpcProviderError: ProviderErrorSchema,
	RpcApi: ApiSchema,
	RpcDiagnosticErrorInfo: DiagnosticErrorInfoSchema,
	RpcAssistantMessageDiagnostic: AssistantMessageDiagnosticSchema,
	RpcAssistantMessage: AssistantMessageSchema,

	// Projection metadata + workflows + review
	RpcReviewDiscussionLink: RpcReviewDiscussionLinkSchema,
	RpcReviewDiscussion: RpcReviewDiscussionSchema,
	RpcStartReviewDiscussions: RpcStartReviewDiscussionsSchema,
	RpcListReviewDiscussions: RpcListReviewDiscussionsSchema,
	RpcResetReviewDiscussion: RpcResetReviewDiscussionSchema,
	RpcWorkflowKind: RpcWorkflowKindSchema,
	RpcWorkflowStatus: RpcWorkflowStatusSchema,
	RpcProjectionTruncation: RpcProjectionTruncationSchema,
	RpcWorkflowEvent: RpcWorkflowEventSchema,
	RpcWorkflowToolEvent: RpcWorkflowToolEventSchema,
	RpcReviewAcknowledgmentResponse: RpcReviewAcknowledgmentResponseSchema,
	RpcReviewWorkflowLifecycleStatus: RpcReviewWorkflowLifecycleStatusSchema,
	RpcReviewRunStatus: RpcReviewRunStatusSchema,
	RpcReviewCompletionStatus: RpcReviewCompletionStatusSchema,
	RpcReviewCorrectness: RpcReviewCorrectnessSchema,
	RpcReviewFindingStatus: RpcReviewFindingStatusSchema,
	RpcReviewWorkflowDescriptor: RpcReviewWorkflowDescriptorSchema,
	RpcReviewLocation: RpcReviewLocationSchema,
	RpcReviewFinding: RpcReviewFindingSchema,
	RpcReviewCoverage: RpcReviewCoverageSchema,
	RpcReviewOptions: RpcReviewOptionsSchema,
	RpcReviewTargetIdentity: RpcReviewTargetIdentitySchema,
	RpcReviewRunDescriptor: RpcReviewRunDescriptorSchema,
	RpcReviewWorkflowResultResponse: RpcReviewWorkflowResultResponseSchema,
	RpcReviewWorkflowListResponse: RpcReviewWorkflowListResponseSchema,

	// MCP
	RpcMcpRisk: RpcMcpRiskSchema,
	RpcMcpSourceScope: RpcMcpSourceScopeSchema,
	RpcMcpServerStatus: RpcMcpServerStatusSchema,
	RpcMcpAuthState: RpcMcpAuthStateSchema,
	RpcMcpRecentCallStatus: RpcMcpRecentCallStatusSchema,
	RpcMcpRecentCallSummary: RpcMcpRecentCallSummarySchema,
	RpcMcpToolSummary: RpcMcpToolSummarySchema,
	RpcMcpResourceSummary: RpcMcpResourceSummarySchema,
	RpcMcpPromptSummary: RpcMcpPromptSummarySchema,
	RpcMcpServerSummary: RpcMcpServerSummarySchema,
	RpcMcpOAuthBrowserStartResult: RpcMcpOAuthBrowserStartResultSchema,
	RpcMcpOAuthBrowserCompleteResult: RpcMcpOAuthBrowserCompleteResultSchema,
	RpcMcpOAuthDeviceStartResult: RpcMcpOAuthDeviceStartResultSchema,
	RpcMcpOAuthDevicePollResult: RpcMcpOAuthDevicePollResultSchema,
	RpcMcpAuthResponse: RpcMcpAuthResponseSchema,
	RpcMcpCapabilitiesResponse: RpcMcpCapabilitiesResponseSchema,
	RpcMcpServersResponse: RpcMcpServersResponseSchema,
	RpcMcpServerResponse: RpcMcpServerResponseSchema,
	RpcMcpToolsResponse: RpcMcpToolsResponseSchema,
	RpcMcpToolResponse: RpcMcpToolResponseSchema,
	RpcMcpResourcesResponse: RpcMcpResourcesResponseSchema,
	RpcMcpResourceContentResponse: RpcMcpResourceContentResponseSchema,
	RpcMcpPromptsResponse: RpcMcpPromptsResponseSchema,
	RpcMcpPromptContentResponse: RpcMcpPromptContentResponseSchema,
	RpcMcpRecentCallsResponse: RpcMcpRecentCallsResponseSchema,

	// Session catalog, run state, models, subagents, plans, and host status
	RpcSessionChangePullRequest: RpcSessionChangePullRequestSchema,
	RpcSessionChangeContext: RpcSessionChangeContextSchema,
	RpcSessionListItem: RpcSessionListItemSchema,
	RpcActiveAgentRun: RpcActiveAgentRunSchema,
	RpcActiveCompaction: RpcActiveCompactionSchema,
	RpcActiveRetry: RpcActiveRetrySchema,
	RpcPromptCacheStatus: RpcPromptCacheStatusSchema,
	RpcAgentMode: RpcAgentModeSchema,
	RpcPlanStepStatus: RpcPlanStepStatusSchema,
	RpcPlanExecutionStrategy: RpcPlanExecutionStrategySchema,
	RpcPlanStep: RpcPlanStepSchema,
	RpcPlanExecution: RpcPlanExecutionSchema,
	RpcPlanState: RpcPlanStateSchema,
	RpcPlanningState: RpcPlanningStateSchema,
	RpcCatalogModel: RpcCatalogModelSchema,
	RpcSubagentDefinitionSource: RpcSubagentDefinitionSourceSchema,
	RpcSubagentSourceInfo: RpcSubagentSourceInfoSchema,
	RpcSubagentDefinition: RpcSubagentDefinitionSchema,
	RpcListSubagentsResponse: RpcListSubagentsResponseSchema,
	RpcRegisterPushTargetResponse: RpcRegisterPushTargetResponseSchema,
	RpcKeepAwakeStatus: RpcKeepAwakeStatusSchema,
	RpcWebSearchStatus: RpcWebSearchStatusSchema,
	RpcBashResult: RpcBashResultSchema,
	RpcCompactionResult: RpcCompactionResultSchema,

	// Subscription usage
	RpcSubscriptionUsageErrorCode: RpcSubscriptionUsageErrorCodeSchema,
	RpcSubscriptionUsageLimit: RpcSubscriptionUsageLimitSchema,
	RpcSubscriptionUsageSnapshot: RpcSubscriptionUsageSnapshotSchema,
	RpcSubscriptionUsageResult: RpcSubscriptionUsageResultSchema,
	RpcSubscriptionUsageProviderReport: RpcSubscriptionUsageProviderReportSchema,
	RpcSubscriptionUsageReport: RpcSubscriptionUsageReportSchema,

	// Conversation log: envelope vocabulary, stored messages, client input
	LogEntryVisibility: LogEntryVisibilitySchema,
	SessionReference: SessionReferenceSchema,
	UserMessage: UserMessageSchema,
	ToolResultMessage: ToolResultMessageSchema,
	BashExecutionMessage: BashExecutionMessageSchema,
	CustomMessage: CustomMessageSchema,
	LogMessage: LogMessageSchema,
	ClientInputCommand: ClientInputCommandSchema,
	ClientInputState: ClientInputStateSchema,
	ClientInputQueuedDelivery: ClientInputQueuedDeliverySchema,
	ClientInputPayload: ClientInputPayloadSchema,
	ClientInputQueuedPayload: ClientInputQueuedPayloadSchema,

	// Work
	WorkKind: WorkKindSchema,
	WorkState: WorkStateSchema,
	WorkOutcome: WorkOutcomeSchema,
	WorkDelivery: WorkDeliverySchema,
	WorkTitle: WorkTitleSchema,
	WorkText: WorkTextSchema,
	WorkProgressStep: WorkProgressStepSchema,
	WorkProgress: WorkProgressSchema,
	WorkChild: WorkChildSchema,
	WorkResultChild: WorkResultChildSchema,
	WorkResult: WorkResultSchema,
	WorkNoticeDetails: WorkNoticeDetailsSchema,

	// UiNode
	UiNodeToken: UiNodeTokenSchema,
	UiNodeText: UiNodeTextSchema,
	UiNodeStyledSpan: UiNodeStyledSpanSchema,
	UiNodeStyledText: UiNodeStyledTextSchema,
	UiNodeStyledLine: UiNodeStyledLineSchema,
	UiNodeIntent: UiNodeIntentSchema,
	UiNodeAction: UiNodeActionSchema,
	UiNodeFormField: UiNodeFormFieldSchema,
	UiTextNode: UiTextNodeSchema,
	UiMarkdownNode: UiMarkdownNodeSchema,
	UiTableNode: UiTableNodeSchema,
	UiKeyValueNode: UiKeyValueNodeSchema,
	UiProgressNode: UiProgressNodeSchema,
	UiFormNode: UiFormNodeSchema,
	UiActionsNode: UiActionsNodeSchema,
	UiDiffNode: UiDiffNodeSchema,
	UiTerminalNode: UiTerminalNodeSchema,
	UiCodeNode: UiCodeNodeSchema,
	UiImageNode: UiImageNodeSchema,
	UiTreeItem: UiTreeItemSchema,
	UiTreeNode: UiTreeNodeSchema,
	UiNode: UiNodeSchema,

	// Push notifications and the workspace catalog
	IrohRemotePushNotification: IrohRemotePushNotificationSchema,
	IrohRemotePushNotificationDeliveryStatus: IrohRemotePushNotificationDeliveryStatusSchema,
	IrohRemoteWorkspaceName: IrohRemoteWorkspaceNameSchema,
	IrohRemoteWorkspaceAvailabilityStatus: IrohRemoteWorkspaceAvailabilityStatusSchema,
	IrohRemoteWorkspaceStatus: IrohRemoteWorkspaceStatusSchema,
	IrohRemoteWorkspaceMetadataSnapshot: IrohRemoteWorkspaceMetadataSnapshotSchema,

	// Iroh remote handshake
	"RemoteHandshake.SessionId": IrohRemoteSessionIdSchema,
	"RemoteHandshake.WorktreeId": IrohRemoteWorktreeIdSchema,
	"RemoteHandshake.WorkingDirectory": IrohRemoteWorkingDirectorySchema,
	"RemoteHandshake.Outcome": IrohRemoteOutcomeSchema,
	"RemoteHandshake.RelayMode": IrohRemoteRelayModeSchema,
	"RemoteHandshake.RelayUrls": IrohRemoteRelayUrlsSchema,
	"RemoteHandshake.ConversationTarget": IrohRemoteConversationTargetSchema,
	"RemoteHandshake.WorkspaceDiscoveryTarget": IrohRemoteWorkspaceDiscoveryTargetSchema,
	"RemoteHandshake.WorkspaceManagementTarget": IrohRemoteWorkspaceManagementTargetSchema,
	"RemoteHandshake.Hello": IrohRemoteHelloWireSchema,
	"RemoteHandshake.ParsedHello": IrohRemoteHelloSchema,
	"RemoteHandshake.ConversationSelection": IrohRemoteConversationSelectionSchema,
	"RemoteHandshake.ConversationMetadata": IrohRemoteConversationHandshakeMetadataSchema,
	"RemoteHandshake.HostMetadata": IrohRemoteHostHandshakeMetadataSchema,
	"RemoteHandshake.Success": IrohRemoteHandshakeSuccessSchema,
	"RemoteHandshake.Failure": IrohRemoteHandshakeFailureSchema,
	"RemoteHandshake.Response": IrohRemoteHandshakeResponseSchema,

	// Daemon control plane: shared vocabulary and envelopes
	"Control.LeaseState": ControlLeaseStateSchema,
	"Control.LeaseReleaseReason": ControlLeaseReleaseReasonSchema,
	"Control.ClientKind": ControlClientKindSchema,
	"Control.RelayCloseReason": ControlRelayCloseReasonSchema,
	"Control.KeepAwakeStatus": ControlKeepAwakeStatusSchema,
	"Control.LeaseStatus": ControlLeaseStatusSchema,
	"Control.WorkspaceStatus": ControlWorkspaceStatusSchema,
	"Control.WorktreeStatus": ControlWorktreeStatusSchema,
	"Control.ClientStatus": ControlClientStatusSchema,
	"Control.RevokedClientStatus": ControlRevokedClientStatusSchema,
	"Control.RemotePolicyStatus": DaemonRemotePolicyStatusSchema,
	"Control.RelayCredentialStatus": ControlRelayCredentialStatusSchema,
	"Control.RemoteTransportHealth": RemoteTransportHealthSchema,
	"Control.EnvironmentStatus": DaemonEnvironmentStatusSchema,
	"Control.RelayFrame": ControlRelayFrameSchema,
	"Control.RelayOutcome": ControlRelayOutcomeSchema,
	"Control.Hello": ControlHelloSchema,
	"Control.HelloAck": ControlHelloAckSchema,
	"Control.Fatal": ControlFatalSchema,
	"Control.RelayPreamble": ControlRelayPreambleSchema,
};

/** Protocol schemas registered under their own names, before the per-intent, per-query, and per-frame entries. */
const PROTOCOL_SCHEMAS: Record<string, TSchema> = {
	// Remote access
	RemoteCapability: RemoteCapabilitySchema,
	RemoteCapabilities: RemoteCapabilitiesSchema,
	RemoteGrant: RemoteGrantSchema,
	RemoteAccessPresetName: RemoteAccessPresetNameSchema,

	// Projected entries and the client fold
	TranscriptAssistantPart: TranscriptAssistantPartSchema,
	TranscriptItem: TranscriptItemSchema,
	ClientModelRef: ClientModelRefSchema,
	ClientLabel: ClientLabelSchema,
	ClientQueuedInput: ClientQueuedInputSchema,
	ClientWorkResult: ClientWorkResultSchema,
	ClientWorkItem: ClientWorkItemSchema,

	// Intents
	EmptyInput: EmptyInputSchema,
	IntentCancelled: IntentCancelledSchema,
	ReviewWorkflowStarted: ReviewWorkflowStartedSchema,
	BuiltinIntentName: BuiltinIntentNameSchema,
	DynamicIntentName: DynamicIntentNameSchema,
	IntentName: IntentNameSchema,
	DynamicIntentInput: DynamicIntentInputSchema,
	IntentCategory: IntentCategorySchema,
	IntentScope: IntentScopeSchema,
	IntentFence: IntentFenceSchema,
	IntentWhileBusy: IntentWhileBusySchema,
	IntentSource: IntentSourceSchema,
	IntentOption: IntentOptionSchema,
	IntentStateValue: IntentStateValueSchema,
	IntentPresentation: IntentPresentationSchema,
	IntentSlashAlias: IntentSlashAliasSchema,
	IntentAvailability: IntentAvailabilitySchema,
	IntentDescriptor: IntentDescriptorSchema,

	// Queries
	QueryName: QueryNameSchema,

	// Live lane and host requests
	HostRequestKind: HostRequestKindSchema,
	HostRequest: HostRequestSchema,
	HostResponse: HostResponseSchema,
	LiveKey: LiveKeySchema,
	LiveAssistantEvent: LiveAssistantEventSchema,
	LiveToolPartial: LiveToolPartialSchema,

	// Outcomes
	ProfileName: ProfileNameSchema,
	RejectionCode: RejectionCodeSchema,
	RejectionReason: RejectionReasonSchema,
	QueryErrorCode: QueryErrorCodeSchema,
	QueryErrorReason: QueryErrorReasonSchema,
	CatalogName: CatalogNameSchema,
	FatalCode: FatalCodeSchema,
};

/**
 * Every named definition of the artifact. Daemon control messages are keyed
 * `Control.Request.<type>` / `Control.Response.<type>` / `Control.Event.<type>`,
 * each followed by its union. Each core log entry type contributes
 * `LogEntryPayload.<type>` and `LogEntry.<type>`, closed by the `LogEntry`
 * union.
 *
 * Protocol 1 follows: each projected entry type contributes
 * `ProjectedPayload.<type>` and `ProjectedEntry.<type>`; each built-in intent
 * `IntentInput.<name>` (and `IntentOutput.<name>` when it returns data); each
 * query `QueryParams.<name>` and `QueryResult.<name>`; each live value kind
 * and item type `LiveValue.<kind>` and `LiveItem.<type>`. Frames are
 * `Frame.<type>`, intent frames `Frame.intent.<name>` (the frame's type is the
 * intent name) and `Frame.intent.dynamic`, query frames `Frame.query.<name>`;
 * the closed `ClientFrame` and `HostFrame` unions close the map.
 */
export const CONTRACT_SCHEMA_REGISTRY: ReadonlyMap<string, TSchema> = (() => {
	const registry = new Map<string, TSchema>(Object.entries(SHARED_SCHEMAS));
	for (const [type, schema] of Object.entries(CONTROL_REQUEST_SCHEMAS)) {
		registry.set(`Control.Request.${type}`, schema);
	}
	registry.set("Control.Request", ControlRequestSchema);
	for (const [type, schema] of Object.entries(CONTROL_RESPONSE_SCHEMAS)) {
		registry.set(`Control.Response.${type}`, schema);
	}
	registry.set("Control.Response", ControlResponseSchema);
	for (const [type, schema] of Object.entries(CONTROL_EVENT_SCHEMAS)) {
		registry.set(`Control.Event.${type}`, schema);
	}
	registry.set("Control.Event", ControlEventSchema);
	for (const definition of Object.values(CORE_LOG_ENTRY_TYPES)) {
		registry.set(`LogEntryPayload.${definition.type}`, definition.payload);
		registry.set(`LogEntry.${definition.type}`, definition.schema);
	}
	registry.set("LogEntry", LogEntrySchema);

	for (const [name, schema] of Object.entries(PROTOCOL_SCHEMAS)) registry.set(name, schema);
	for (const [type, definition] of Object.entries(PROJECTED_ENTRY_TYPES)) {
		registry.set(`ProjectedPayload.${type}`, definition.payload);
		registry.set(`ProjectedEntry.${type}`, definition.schema);
	}
	registry.set("ProjectedEntry", ProjectedEntrySchema);
	registry.set("ClientSnapshot", ClientSnapshotSchema);
	for (const name of BUILTIN_INTENT_NAMES) {
		const schemas: IntentSchemas = INTENT_SCHEMAS[name];
		registry.set(`IntentInput.${name}`, schemas.input);
		if (schemas.output !== undefined) registry.set(`IntentOutput.${name}`, schemas.output);
	}
	for (const name of QUERY_NAMES) {
		registry.set(`QueryParams.${name}`, QUERY_SCHEMAS[name].params);
		registry.set(`QueryResult.${name}`, QUERY_SCHEMAS[name].result);
	}
	for (const [kind, schema] of Object.entries(LIVE_VALUE_SCHEMAS)) registry.set(`LiveValue.${kind}`, schema);
	registry.set("LiveValue", LiveValueSchema);
	for (const [type, schema] of Object.entries(LIVE_ITEM_SCHEMAS)) registry.set(`LiveItem.${type}`, schema);
	registry.set("LiveItem", LiveItemSchema);
	for (const [type, schema] of Object.entries(CLIENT_FRAME_SCHEMAS)) registry.set(`Frame.${type}`, schema);
	for (const name of BUILTIN_INTENT_NAMES) registry.set(`Frame.intent.${name}`, INTENT_FRAME_SCHEMAS[name]);
	registry.set("Frame.intent.dynamic", DynamicIntentFrameSchema);
	registry.set("Frame.intent", IntentFrameSchema);
	for (const name of QUERY_NAMES) registry.set(`Frame.query.${name}`, QUERY_FRAME_SCHEMAS[name]);
	registry.set("Frame.query", QueryFrameSchema);
	for (const [type, schema] of Object.entries(HOST_FRAME_SCHEMAS)) registry.set(`Frame.${type}`, schema);
	registry.set("ClientFrame", ClientFrameSchema);
	registry.set("HostFrame", HostFrameSchema);
	return registry;
})();

// ============================================================================
// Limits block (x-volt-limits)
// ============================================================================

/**
 * The numeric bounds of the wire that clients mirror. Values come from the
 * same constants the host enforces — the artifact cannot drift from the
 * runtime.
 */
export const RPC_WIRE_LIMITS = {
	conversationIdentifierMaxUtf8Bytes: RPC_CONVERSATION_IDENTIFIER_MAX_UTF8_BYTES,
	clientMessageId: {
		maxChars: RPC_CLIENT_MESSAGE_ID_MAX_CHARS,
		patternSource: RPC_CLIENT_MESSAGE_ID_PATTERN_SOURCE,
		schemaPattern: RPC_CLIENT_MESSAGE_ID_SCHEMA_PATTERN,
		reservedPrefix: RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX,
	},
	conversationInput: {
		messageMaxUtf8Bytes: RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES,
		maxImages: RPC_CONVERSATION_INPUT_MAX_IMAGES,
		imageMimeTypeMaxUtf8Bytes: RPC_CONVERSATION_INPUT_IMAGE_MIME_TYPE_MAX_UTF8_BYTES,
		imageDataMaxUtf8Bytes: RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES,
		imagesMaxUtf8Bytes: RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES,
		maxSerializedBytes: RPC_CONVERSATION_INPUT_MAX_SERIALIZED_BYTES,
		/** Accepted and started inputs a conversation's queue holds. */
		queueMaxItems: RPC_SESSION_QUEUE_MAX_ITEMS,
	},
	gitContext: {
		repositoryMaxChars: RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS,
		refMaxChars: RPC_GIT_CONTEXT_REF_MAX_CHARS,
		oidMaxChars: RPC_GIT_CONTEXT_OID_MAX_CHARS,
		oidPattern: RPC_GIT_CONTEXT_OID_PATTERN,
		observedAtMaxChars: RPC_GIT_CONTEXT_OBSERVED_AT_MAX_CHARS,
	},
	remoteProfile: {
		liveQueueBytes: DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
		assistantContentMaxUtf8Bytes: DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
		assistantSnapshotMaxBytes: DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
		toolArgsMaxSerializedBytes: RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES,
		toolDetailsMaxSerializedBytes: RPC_ACTIVE_TOOL_DETAILS_MAX_SERIALIZED_BYTES,
		/** Scalar cap per transcript view text and per `content` chunk. */
		textMaxScalars: IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	},
	jsonl: {
		maxEncodedLineBytes: DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES,
		maxLineBytes: DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	},
	wireMaxSafeInteger: RPC_WIRE_MAX_SAFE_INTEGER,
	/** Client-enforced ceiling on retryAfterMs backoff hints. */
	retryAfterMsMax: RPC_RETRY_AFTER_MS_MAX,
} as const;

/**
 * Everything exported into the artifact as `x-volt-limits`: the wire limits,
 * the `UiNode` and work entry bounds, and the protocol constants.
 */
export const CONTRACT_LIMITS = {
	...RPC_WIRE_LIMITS,
	uiNode: UI_NODE_LIMITS,
	/** `clientFinishedMax`: the finished work items a client fold keeps beside the open ones. */
	work: { ...WORK_LIMITS, clientFinishedMax: CLIENT_WORK_FINISHED_MAX },
	protocol: PROTOCOL_LIMITS,
} as const;
