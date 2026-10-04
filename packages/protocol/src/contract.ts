/**
 * The protocol contract: the top-level RPC wire unions, every named schema
 * (wire frames, log entries, and `UiNode`), and the numeric limits block —
 * everything the JSON Schema artifact (contract/protocol-schema.json) is
 * generated from by scripts/generate-protocol-schema.ts.
 */

import {
	ActiveToolCallStateSchema,
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
import { type TSchema, Type } from "typebox";
import {
	RpcAgentOptionsDefaultConfigSchema,
	RpcAgentOptionsModelSelectionSchema,
	RpcAgentOptionsSchema,
} from "./agent-options.ts";
import {
	RpcBackgroundJobSnapshotSchema,
	RpcBackgroundJobSummarySchema,
	RpcBackgroundJobsSchema,
	RpcCancelJobResponseSchema,
	RpcListJobsResponseSchema,
	RpcReadJobResponseSchema,
} from "./background-jobs.ts";
import { RPC_COMMAND_SCHEMAS, RpcClientCapabilityFeatureSchema, RpcMcpAuthFlowSchema } from "./commands.ts";
import {
	RpcConversationActiveAssistantSchema,
	RpcConversationAssistantPartSchema,
	RpcConversationBootstrapEventSchema,
	RpcConversationDeliveryPositionSchema,
	RpcConversationTranscriptItemSchema,
	RpcConversationTranscriptPageSchema,
	RpcConversationWorkflowSnapshotSchema,
	RpcMessageEndFrameSchema,
	RpcMessageStartFrameSchema,
	RpcMessageUpdateFrameSchema,
	RpcQueueUpdateEventSchema,
	RpcSessionTreeNodeSchema,
	RpcSessionTreePageSchema,
	RpcSlimAssistantEventSchema,
	RpcTranscriptEntryEventSchema,
} from "./conversation.ts";
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
} from "./entries.ts";
import {
	RpcAgentStartEventSchema,
	RpcBackgroundJobsChangedEventSchema,
	RpcExtensionErrorEventSchema,
	RpcExtensionUIRequestSchema,
	RpcExtensionUIResponseSchema,
	RpcGitContextChangedEventSchema,
	RpcHostActionMetadataValueSchema,
	RpcHostActionRequestSchema,
	RpcHostActionResponseSchema,
	RpcHostActionUpdateSchema,
	RpcModelsChangedEventSchema,
	RpcPendingHostActionsResponseSchema,
	RpcPromptCacheChangedEventSchema,
	RpcRemoteTerminalEventSchema,
	RpcSubagentDisposedEventSchema,
	RpcSubagentEndEventSchema,
	RpcSubagentEventSchema,
	RpcUiActionStateChangedEventSchema,
} from "./events.ts";
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
	RpcMcpAuthResponseSchema,
	RpcMcpAuthStateSchema,
	RpcMcpCapabilitiesResponseSchema,
	RpcMcpOAuthBrowserCompleteResultSchema,
	RpcMcpOAuthBrowserStartResultSchema,
	RpcMcpOAuthDevicePollResultSchema,
	RpcMcpOAuthDeviceStartResultSchema,
	RpcMcpPromptSummarySchema,
	RpcMcpRecentCallStatusSchema,
	RpcMcpRecentCallSummarySchema,
	RpcMcpResourceSummarySchema,
	RpcMcpRiskSchema,
	RpcMcpServerStatusSchema,
	RpcMcpServerSummarySchema,
	RpcMcpSourceScopeSchema,
	RpcMcpToolSummarySchema,
	RpcSlashCommandSchema,
	RpcSourceInfoSchema,
} from "./mcp.ts";
import {
	RpcAgentModeSchema,
	RpcPlanExecutionResultSchema,
	RpcPlanExecutionSchema,
	RpcPlanExecutionStrategySchema,
	RpcPlanningStateChangedEventSchema,
	RpcPlanningStateSchema,
	RpcPlanPhaseSchema,
	RpcPlanStateSchema,
	RpcPlanStepSchema,
	RpcPlanStepStatusSchema,
} from "./planning.ts";
import {
	RpcAssistantStreamPositionSchema,
	RpcClientMessageIdSchema,
	RpcConversationAuthoritySchema,
	RpcConversationBootstrapReasonSchema,
	RpcConversationDiscontinuityReasonSchema,
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
	RpcUiActionListScopeSchema,
} from "./primitives.ts";
import {
	RpcProjectionCollectionTruncationSchema,
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
import {
	RPC_RESPONSE_SCHEMAS,
	RpcBashResultSchema,
	RpcCompactionResultSchema,
	RpcErrorResponseSchema,
	RpcForkResponseSchema,
	RpcMcpPromptContentResponseSchema,
	RpcMcpPromptsResponseSchema,
	RpcMcpRecentCallsResponseSchema,
	RpcMcpResourceContentResponseSchema,
	RpcMcpResourcesResponseSchema,
	RpcMcpServerResponseSchema,
	RpcMcpServersResponseSchema,
	RpcMcpToolResponseSchema,
	RpcMcpToolsResponseSchema,
	RpcMessageImageSchema,
	RpcMessageImagesResponseSchema,
	RpcSessionIntentResponseSchema,
	RpcSessionStatsSchema,
	RpcTranscriptEntryTextResponseSchema,
} from "./responses.ts";
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
	RpcActiveToolExecutionSchema,
	RpcCatalogModelSchema,
	RpcKeepAwakeStatusSchema,
	RpcListSubagentsResponseSchema,
	RpcModelSchema,
	RpcPromptCacheStatusSchema,
	RpcPromptResponseSchema,
	RpcQueuedMessageSchema,
	RpcQueueUpdateProjectionSchema,
	RpcRegisterPushTargetResponseSchema,
	RpcSessionListItemSchema,
	RpcSessionStateProjectionSchema,
	RpcSessionStateSchema,
	RpcSessionWorkContextSchema,
	RpcSessionWorkPullRequestSchema,
	RpcSubagentDefinitionSchema,
	RpcSubagentDefinitionSourceSchema,
	RpcSubagentSourceInfoSchema,
	RpcSubagentStartResponseSchema,
	RpcTranscriptItemSchema,
	RpcTranscriptResponseSchema,
	RpcTranscriptSummaryItemSchema,
	RpcTranscriptTextItemSchema,
	RpcTranscriptToolItemSchema,
	RpcTranscriptToolStatusSchema,
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
	UiActionArgumentDescriptorSchema,
	UiActionArgumentTypeSchema,
	UiActionCapabilitiesSchema,
	UiActionCapabilityFeatureSchema,
	UiActionCategorySchema,
	UiActionCompletionListResponseSchema,
	UiActionDescriptorSchema,
	UiActionInvocationQueueBehaviorSchema,
	UiActionInvocationResponseSchema,
	UiActionInvocationStatusSchema,
	UiActionListResponseSchema,
	UiActionOptionDescriptorSchema,
	UiActionPresentationHintSchema,
	UiActionPresentationKindSchema,
	UiActionScalarSchema,
	UiActionSlashAliasSchema,
	UiActionSourceSchema,
	UiActionStateDescriptorSchema,
	UiActionStateTypeSchema,
	UiActionStreamingBehaviorSchema,
} from "./ui-actions.ts";
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
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_ENVELOPES,
	DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES,
	DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	MESSAGE_IMAGES_ENTRY_MAX_ITEMS,
	MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES,
	MESSAGE_IMAGES_PAGE_MAX_ITEMS,
	MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES,
	MESSAGE_IMAGES_RESPONSE_ENVELOPE_HEADROOM_BYTES,
	REMOTE_TRANSCRIPT_DEFAULT_MAX_SERIALIZED_BYTES,
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
	RPC_PROJECTION_STRING_MAX_UTF8_BYTES,
	RPC_REMOTE_ERROR_STRINGS,
	RPC_RETRY_AFTER_MS_MAX,
	RPC_RUNTIME_QUEUE_ENTRY_ID_PREFIX,
	RPC_SESSION_ACTIVE_TOOLS_MAX_ITEMS,
	RPC_SESSION_ACTIVE_TOOLS_MAX_SERIALIZED_BYTES,
	RPC_SESSION_MODEL_MAX_SERIALIZED_BYTES,
	RPC_SESSION_QUEUE_ID_MAX_UTF8_BYTES,
	RPC_SESSION_QUEUE_ITEM_MAX_UTF8_BYTES,
	RPC_SESSION_QUEUE_MAX_ITEMS,
	RPC_SESSION_QUEUE_MAX_SERIALIZED_BYTES,
	RPC_SESSION_STATE_MAX_SERIALIZED_BYTES,
	RPC_SESSION_TREE_MAX_SERIALIZED_BYTES,
	RPC_SESSION_TREE_PAGE_DEFAULT_ITEMS,
	RPC_SESSION_TREE_PAGE_MAX_ITEMS,
	RPC_STABLE_ERROR_CODES,
	RPC_TRANSCRIPT_PAGE_DEFAULT_ITEMS,
	RPC_TRANSCRIPT_PAGE_MAX_ITEMS,
	RPC_WIRE_MAX_SAFE_INTEGER,
} from "./wire-limits.ts";

// ============================================================================
// Top-level wire unions
// ============================================================================

/** All client→host commands. */
export const RpcCommandSchema = Type.Union(Object.values(RPC_COMMAND_SCHEMAS) as TSchema[]);

/** Everything a client may write to the wire: commands plus control messages. */
export const RpcClientMessageSchema = Type.Union([
	...(Object.values(RPC_COMMAND_SCHEMAS) as TSchema[]),
	RpcExtensionUIResponseSchema,
	RpcHostActionResponseSchema,
]);

/** All host→client responses: one success member per command plus the error member. */
export const RpcResponseSchema = Type.Union([
	...(Object.values(RPC_RESPONSE_SCHEMAS) as TSchema[]),
	RpcErrorResponseSchema,
]);

/**
 * The declared host→client event vocabulary. Deliberately open: in plain
 * (non-ordered) mode the host passes further session events through verbatim
 * (`x-volt-open-events` in the artifact); clients must ignore unknown types.
 */
export const RpcServerEventSchema = Type.Union([
	RpcAgentStartEventSchema,
	RpcBackgroundJobsChangedEventSchema,
	RpcConversationBootstrapEventSchema,
	RpcMessageStartFrameSchema,
	RpcMessageUpdateFrameSchema,
	RpcMessageEndFrameSchema,
	RpcQueueUpdateEventSchema,
	RpcTranscriptEntryEventSchema,
	RpcWorkflowEventSchema,
	RpcWorkflowToolEventSchema,
	RpcExtensionUIRequestSchema,
	RpcExtensionErrorEventSchema,
	RpcHostActionRequestSchema,
	RpcHostActionUpdateSchema,
	RpcSubagentEventSchema,
	RpcSubagentEndEventSchema,
	RpcSubagentDisposedEventSchema,
	RpcModelsChangedEventSchema,
	RpcGitContextChangedEventSchema,
	RpcPromptCacheChangedEventSchema,
	RpcUiActionStateChangedEventSchema,
	RpcPlanningStateChangedEventSchema,
	RpcRemoteTerminalEventSchema,
]);

// ============================================================================
// Registry: $defs name → schema
// ============================================================================

const SHARED_SCHEMAS: Record<string, TSchema> = {
	// Primitives
	RpcConversationIdentifier: RpcConversationIdentifierSchema,
	RpcClientMessageId: RpcClientMessageIdSchema,
	RpcSafeNonNegativeInteger: RpcSafeNonNegativeIntegerSchema,
	RpcConversationAuthority: RpcConversationAuthoritySchema,
	RpcAssistantStreamPosition: RpcAssistantStreamPositionSchema,
	RpcConversationDiscontinuityReason: RpcConversationDiscontinuityReasonSchema,
	RpcConversationBootstrapReason: RpcConversationBootstrapReasonSchema,
	RpcImageContent: RpcImageContentSchema,
	RpcConversationInputImages: RpcConversationInputImagesSchema,
	RpcThinkingLevel: RpcThinkingLevelSchema,
	RpcStreamingBehavior: RpcStreamingBehaviorSchema,
	RpcQueueMode: RpcQueueModeSchema,
	RpcUiActionListScope: RpcUiActionListScopeSchema,
	RpcPushProvider: RpcPushProviderSchema,
	RpcPushPlatform: RpcPushPlatformSchema,
	RpcRegisterPushTargetArgs: RpcRegisterPushTargetArgsSchema,
	RpcClientCapabilityFeature: RpcClientCapabilityFeatureSchema,
	RpcMcpAuthFlow: RpcMcpAuthFlowSchema,

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
	RpcGitContextChangedEvent: RpcGitContextChangedEventSchema,

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
	RpcActiveToolCallState: ActiveToolCallStateSchema,
	RpcModel: RpcModelSchema,
	RpcSlimAssistantEvent: RpcSlimAssistantEventSchema,

	// UI actions
	UiActionSource: UiActionSourceSchema,
	UiActionCategory: UiActionCategorySchema,
	UiActionPresentationKind: UiActionPresentationKindSchema,
	UiActionArgumentType: UiActionArgumentTypeSchema,
	UiActionStateType: UiActionStateTypeSchema,
	UiActionStreamingBehavior: UiActionStreamingBehaviorSchema,
	UiActionScalar: UiActionScalarSchema,
	UiActionInvocationQueueBehavior: UiActionInvocationQueueBehaviorSchema,
	UiActionInvocationStatus: UiActionInvocationStatusSchema,
	UiActionCapabilityFeature: UiActionCapabilityFeatureSchema,
	UiActionOptionDescriptor: UiActionOptionDescriptorSchema,
	UiActionPresentationHint: UiActionPresentationHintSchema,
	UiActionArgumentDescriptor: UiActionArgumentDescriptorSchema,
	UiActionStateDescriptor: UiActionStateDescriptorSchema,
	UiActionSlashAlias: UiActionSlashAliasSchema,
	UiActionDescriptor: UiActionDescriptorSchema,
	UiActionCapabilities: UiActionCapabilitiesSchema,
	UiActionListResponse: UiActionListResponseSchema,
	UiActionCompletionListResponse: UiActionCompletionListResponseSchema,
	UiActionInvocationResponse: UiActionInvocationResponseSchema,
	RpcUiActionStateChangedEvent: RpcUiActionStateChangedEventSchema,

	// Projection metadata + workflows + review
	RpcReviewDiscussionLink: RpcReviewDiscussionLinkSchema,
	RpcReviewDiscussion: RpcReviewDiscussionSchema,
	RpcStartReviewDiscussions: RpcStartReviewDiscussionsSchema,
	RpcListReviewDiscussions: RpcListReviewDiscussionsSchema,
	RpcResetReviewDiscussion: RpcResetReviewDiscussionSchema,
	RpcWorkflowKind: RpcWorkflowKindSchema,
	RpcWorkflowStatus: RpcWorkflowStatusSchema,
	RpcProjectionTruncation: RpcProjectionTruncationSchema,
	RpcProjectionCollectionTruncation: RpcProjectionCollectionTruncationSchema,
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
	RpcSourceInfo: RpcSourceInfoSchema,
	RpcSlashCommand: RpcSlashCommandSchema,

	// Session-owned background jobs
	RpcBackgroundJobSummary: RpcBackgroundJobSummarySchema,
	RpcBackgroundJobSnapshot: RpcBackgroundJobSnapshotSchema,
	RpcBackgroundJobs: RpcBackgroundJobsSchema,
	RpcListJobsResponse: RpcListJobsResponseSchema,
	RpcReadJobResponse: RpcReadJobResponseSchema,
	RpcCancelJobResponse: RpcCancelJobResponseSchema,
	RpcBackgroundJobsChangedEvent: RpcBackgroundJobsChangedEventSchema,

	// Session state + transcript + subagents + host status
	RpcSessionWorkPullRequest: RpcSessionWorkPullRequestSchema,
	RpcSessionWorkContext: RpcSessionWorkContextSchema,
	RpcSessionListItem: RpcSessionListItemSchema,
	RpcActiveToolExecution: RpcActiveToolExecutionSchema,
	RpcActiveAgentRun: RpcActiveAgentRunSchema,
	RpcActiveCompaction: RpcActiveCompactionSchema,
	RpcActiveRetry: RpcActiveRetrySchema,
	RpcPromptCacheStatus: RpcPromptCacheStatusSchema,
	RpcPromptCacheChangedEvent: RpcPromptCacheChangedEventSchema,
	RpcQueuedMessage: RpcQueuedMessageSchema,
	RpcQueueUpdateProjection: RpcQueueUpdateProjectionSchema,
	RpcAgentMode: RpcAgentModeSchema,
	RpcPlanPhase: RpcPlanPhaseSchema,
	RpcPlanStepStatus: RpcPlanStepStatusSchema,
	RpcPlanExecutionStrategy: RpcPlanExecutionStrategySchema,
	RpcPlanStep: RpcPlanStepSchema,
	RpcPlanExecution: RpcPlanExecutionSchema,
	RpcPlanState: RpcPlanStateSchema,
	RpcPlanningState: RpcPlanningStateSchema,
	RpcPlanningStateChangedEvent: RpcPlanningStateChangedEventSchema,
	RpcPlanExecutionResult: RpcPlanExecutionResultSchema,
	RpcSessionStateProjection: RpcSessionStateProjectionSchema,
	RpcSessionState: RpcSessionStateSchema,
	RpcCatalogModel: RpcCatalogModelSchema,
	RpcTranscriptToolStatus: RpcTranscriptToolStatusSchema,
	RpcTranscriptTextItem: RpcTranscriptTextItemSchema,
	RpcTranscriptToolItem: RpcTranscriptToolItemSchema,
	RpcTranscriptSummaryItem: RpcTranscriptSummaryItemSchema,
	RpcTranscriptItem: RpcTranscriptItemSchema,
	RpcTranscriptResponse: RpcTranscriptResponseSchema,
	RpcSubagentDefinitionSource: RpcSubagentDefinitionSourceSchema,
	RpcSubagentSourceInfo: RpcSubagentSourceInfoSchema,
	RpcSubagentDefinition: RpcSubagentDefinitionSchema,
	RpcListSubagentsResponse: RpcListSubagentsResponseSchema,
	RpcSubagentStartResponse: RpcSubagentStartResponseSchema,
	RpcRegisterPushTargetResponse: RpcRegisterPushTargetResponseSchema,
	RpcKeepAwakeStatus: RpcKeepAwakeStatusSchema,
	RpcWebSearchStatus: RpcWebSearchStatusSchema,
	RpcPromptResponse: RpcPromptResponseSchema,

	// Subscription usage
	RpcSubscriptionUsageErrorCode: RpcSubscriptionUsageErrorCodeSchema,
	RpcSubscriptionUsageLimit: RpcSubscriptionUsageLimitSchema,
	RpcSubscriptionUsageSnapshot: RpcSubscriptionUsageSnapshotSchema,
	RpcSubscriptionUsageResult: RpcSubscriptionUsageResultSchema,
	RpcSubscriptionUsageProviderReport: RpcSubscriptionUsageProviderReportSchema,
	RpcSubscriptionUsageReport: RpcSubscriptionUsageReportSchema,

	// Ordered conversation + stream frames
	RpcConversationDeliveryPosition: RpcConversationDeliveryPositionSchema,
	RpcConversationActiveAssistant: RpcConversationActiveAssistantSchema,
	RpcConversationAssistantPart: RpcConversationAssistantPartSchema,
	RpcConversationTranscriptItem: RpcConversationTranscriptItemSchema,
	RpcConversationTranscriptPage: RpcConversationTranscriptPageSchema,
	RpcSessionTreeNode: RpcSessionTreeNodeSchema,
	RpcSessionTreePage: RpcSessionTreePageSchema,
	RpcConversationWorkflowSnapshot: RpcConversationWorkflowSnapshotSchema,
	RpcConversationBootstrapEvent: RpcConversationBootstrapEventSchema,
	RpcMessageStartFrame: RpcMessageStartFrameSchema,
	RpcMessageUpdateFrame: RpcMessageUpdateFrameSchema,
	RpcMessageEndFrame: RpcMessageEndFrameSchema,
	RpcQueueUpdateEvent: RpcQueueUpdateEventSchema,
	RpcTranscriptEntryEvent: RpcTranscriptEntryEventSchema,

	// Events + control messages
	RpcAgentStartEvent: RpcAgentStartEventSchema,
	RpcHostActionMetadataValue: RpcHostActionMetadataValueSchema,
	RpcHostActionRequest: RpcHostActionRequestSchema,
	RpcHostActionUpdate: RpcHostActionUpdateSchema,
	RpcHostActionResponse: RpcHostActionResponseSchema,
	RpcPendingHostActionsResponse: RpcPendingHostActionsResponseSchema,
	RpcExtensionUIRequest: RpcExtensionUIRequestSchema,
	RpcExtensionUIResponse: RpcExtensionUIResponseSchema,
	RpcExtensionErrorEvent: RpcExtensionErrorEventSchema,
	RpcSubagentEvent: RpcSubagentEventSchema,
	RpcSubagentEndEvent: RpcSubagentEndEventSchema,
	RpcSubagentDisposedEvent: RpcSubagentDisposedEventSchema,
	RpcModelsChangedEvent: RpcModelsChangedEventSchema,
	RpcRemoteTerminalEvent: RpcRemoteTerminalEventSchema,

	// Response bodies without another home
	RpcSessionStats: RpcSessionStatsSchema,
	RpcBashResult: RpcBashResultSchema,
	RpcCompactionResult: RpcCompactionResultSchema,
	RpcMessageImage: RpcMessageImageSchema,
	RpcMessageImagesResponse: RpcMessageImagesResponseSchema,
	RpcTranscriptEntryTextResponse: RpcTranscriptEntryTextResponseSchema,
	RpcMcpServersResponse: RpcMcpServersResponseSchema,
	RpcMcpServerResponse: RpcMcpServerResponseSchema,
	RpcMcpToolsResponse: RpcMcpToolsResponseSchema,
	RpcMcpToolResponse: RpcMcpToolResponseSchema,
	RpcMcpResourcesResponse: RpcMcpResourcesResponseSchema,
	RpcMcpResourceContentResponse: RpcMcpResourceContentResponseSchema,
	RpcMcpPromptsResponse: RpcMcpPromptsResponseSchema,
	RpcMcpPromptContentResponse: RpcMcpPromptContentResponseSchema,
	RpcMcpRecentCallsResponse: RpcMcpRecentCallsResponseSchema,
	RpcSessionIntentResponse: RpcSessionIntentResponseSchema,
	RpcForkResponse: RpcForkResponseSchema,
	RpcErrorResponse: RpcErrorResponseSchema,

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
};

/**
 * Every named definition of the artifact. Per-command and per-response
 * members are keyed `RpcCommand.<type>` / `RpcResponse.<command>`, and the
 * four wire unions follow them. Each core log entry type contributes
 * `LogEntryPayload.<type>` and `LogEntry.<type>`; the `LogEntry` union closes
 * the map.
 */
export const CONTRACT_SCHEMA_REGISTRY: ReadonlyMap<string, TSchema> = (() => {
	const registry = new Map<string, TSchema>(Object.entries(SHARED_SCHEMAS));
	for (const [type, schema] of Object.entries(RPC_COMMAND_SCHEMAS)) {
		registry.set(`RpcCommand.${type}`, schema);
	}
	for (const [command, schema] of Object.entries(RPC_RESPONSE_SCHEMAS)) {
		registry.set(`RpcResponse.${command}`, schema);
	}
	registry.set("RpcCommand", RpcCommandSchema);
	registry.set("RpcClientMessage", RpcClientMessageSchema);
	registry.set("RpcResponse", RpcResponseSchema);
	registry.set("RpcServerEvent", RpcServerEventSchema);
	for (const definition of Object.values(CORE_LOG_ENTRY_TYPES)) {
		registry.set(`LogEntryPayload.${definition.type}`, definition.payload);
		registry.set(`LogEntry.${definition.type}`, definition.schema);
	}
	registry.set("LogEntry", LogEntrySchema);
	return registry;
})();

// ============================================================================
// Limits block (x-volt-limits)
// ============================================================================

/**
 * The numeric bounds and stable vocabularies of the RPC wire that clients
 * mirror. Values come from the same constants the host enforces — the
 * artifact cannot drift from the runtime.
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
	},
	gitContext: {
		repositoryMaxChars: RPC_GIT_CONTEXT_REPOSITORY_MAX_CHARS,
		refMaxChars: RPC_GIT_CONTEXT_REF_MAX_CHARS,
		oidMaxChars: RPC_GIT_CONTEXT_OID_MAX_CHARS,
		oidPattern: RPC_GIT_CONTEXT_OID_PATTERN,
		observedAtMaxChars: RPC_GIT_CONTEXT_OBSERVED_AT_MAX_CHARS,
	},
	sessionState: {
		maxSerializedBytes: RPC_SESSION_STATE_MAX_SERIALIZED_BYTES,
		modelMaxSerializedBytes: RPC_SESSION_MODEL_MAX_SERIALIZED_BYTES,
		queueMaxSerializedBytes: RPC_SESSION_QUEUE_MAX_SERIALIZED_BYTES,
		queueMaxItems: RPC_SESSION_QUEUE_MAX_ITEMS,
		queueItemMaxUtf8Bytes: RPC_SESSION_QUEUE_ITEM_MAX_UTF8_BYTES,
		queueIdMaxUtf8Bytes: RPC_SESSION_QUEUE_ID_MAX_UTF8_BYTES,
		activeToolsMaxSerializedBytes: RPC_SESSION_ACTIVE_TOOLS_MAX_SERIALIZED_BYTES,
		activeToolsMaxItems: RPC_SESSION_ACTIVE_TOOLS_MAX_ITEMS,
		activeToolArgsMaxSerializedBytes: RPC_ACTIVE_TOOL_ARGS_MAX_SERIALIZED_BYTES,
		activeToolDetailsMaxSerializedBytes: RPC_ACTIVE_TOOL_DETAILS_MAX_SERIALIZED_BYTES,
		projectionStringMaxUtf8Bytes: RPC_PROJECTION_STRING_MAX_UTF8_BYTES,
	},
	conversationProjection: {
		maxQueuedBytes: DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
		maxQueuedEnvelopes: DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_ENVELOPES,
		assistantMaxContentBlocks: DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CONTENT_BLOCKS,
		assistantMaxCumulativeContentUtf8Bytes:
			DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_CUMULATIVE_CONTENT_UTF8_BYTES,
		assistantMaxToolCallSerializedBytes: DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_TOOL_CALL_SERIALIZED_BYTES,
		assistantMaxSnapshotSerializedBytes: DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
	},
	transcript: {
		pageDefaultItems: RPC_TRANSCRIPT_PAGE_DEFAULT_ITEMS,
		pageMaxItems: RPC_TRANSCRIPT_PAGE_MAX_ITEMS,
		remotePageMaxSerializedBytes: REMOTE_TRANSCRIPT_DEFAULT_MAX_SERIALIZED_BYTES,
		/** Scalar cap per projected item text and per get_transcript_entry_text continuation chunk. */
		remoteEntryTextMaxScalars: IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	},
	sessionTree: {
		pageDefaultItems: RPC_SESSION_TREE_PAGE_DEFAULT_ITEMS,
		pageMaxItems: RPC_SESSION_TREE_PAGE_MAX_ITEMS,
		pageMaxSerializedBytes: RPC_SESSION_TREE_MAX_SERIALIZED_BYTES,
	},
	messageImages: {
		responseEnvelopeHeadroomBytes: MESSAGE_IMAGES_RESPONSE_ENVELOPE_HEADROOM_BYTES,
		responseBudgetBytes: MESSAGE_IMAGES_RESPONSE_BUDGET_BYTES,
		pageMaxItems: MESSAGE_IMAGES_PAGE_MAX_ITEMS,
		entryMaxItems: MESSAGE_IMAGES_ENTRY_MAX_ITEMS,
		entryMaxSerializedBytes: MESSAGE_IMAGES_ENTRY_MAX_SERIALIZED_BYTES,
	},
	jsonl: {
		maxEncodedLineBytes: DEFAULT_IROH_RPC_MAX_ENCODED_LINE_BYTES,
		maxLineBytes: DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	},
	wireMaxSafeInteger: RPC_WIRE_MAX_SAFE_INTEGER,
	/** Client-enforced ceiling on retryAfterMs backoff hints. */
	retryAfterMsMax: RPC_RETRY_AFTER_MS_MAX,
	stableErrorCodes: RPC_STABLE_ERROR_CODES,
	remoteErrorStrings: RPC_REMOTE_ERROR_STRINGS,
} as const;

/** Everything exported into the artifact as `x-volt-limits`: the RPC wire limits plus the `UiNode` bounds. */
export const CONTRACT_LIMITS = { ...RPC_WIRE_LIMITS, uiNode: UI_NODE_LIMITS } as const;
