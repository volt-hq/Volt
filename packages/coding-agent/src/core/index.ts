/**
 * Core modules shared between all run modes.
 */

export type {
	JsonCompatible,
	JsonCompatibleInput,
	JsonObject,
	JsonPrimitive,
	JsonValue,
} from "@hansjm10/volt-ai";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	type AgentSessionDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export type { CompactionResult } from "./compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
export { areExperimentalFeaturesEnabled } from "./experimental.ts";
// Extensions system
export {
	type AgentEndEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.ts";
export {
	ConversationHost,
	type ConversationHostOptions,
	SessionImportFileNotFoundError,
} from "./host/conversation-host.ts";
export {
	type ConversationFactory,
	type ConversationFactoryResult,
	HostedConversation,
	type SubagentRuntimeContext,
} from "./host/hosted-conversation.ts";
export {
	type HostAnswerResult,
	type HostRequestCancelReason,
	type HostRequestOptions,
	type HostRequestOutcome,
	type LiveClient,
	LiveState,
	type LiveUpdate,
	type PendingHostRequest,
} from "./host/live-state.ts";
export {
	openFork,
	openImport,
	openNewSession,
	openStoredSession,
	openStoredSessionById,
} from "./host/session-intents.ts";
export type { ConversationTarget, HostClient } from "./host/targets.ts";
export type {
	HostActionDecision,
	HostActionDecisionKind,
	HostActionMetadata,
	HostActionMetadataValue,
	HostActionRequest,
	HostActionStatus,
	HostActionUpdate,
	HostInteraction,
} from "./host-interaction.ts";
export * from "./mcp/index.ts";
export type { CustomMessage, CustomMessageInput } from "./messages.ts";
export {
	attachJsonlLineReader,
	createIrohRpcTransport,
	createJsonlRpcTransport,
	createJsonlStreamRpcTransport,
	createLoopbackRpcTransportPair,
	DEFAULT_IROH_READ_LIMIT,
	type IrohBiStreamLike,
	type IrohBytes,
	type IrohRecvStreamLike,
	type IrohRpcTransportOptions,
	type IrohSendStreamLike,
	type JsonlRpcTransportOptions,
	type JsonlStreamRpcTransportOptions,
	type LoopbackRpcTransportPair,
	type RpcCloseHandler,
	type RpcLineHandler,
	type RpcTransport,
	serializeJsonLine,
} from "./protocol/transport/index.ts";
export * from "./remote/iroh/index.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
export {
	createBuiltInSubagentDefinitions,
	DEFAULT_SUBAGENT_TURN_LIMITS,
	type DiscoverSubagentDefinitionsOptions,
	discoverSubagentDefinitions,
	type FileSubagentDefinitionSource,
	type ParseSubagentDefinitionOptions,
	type ParseSubagentDefinitionResult,
	parseSubagentDefinition,
	type SubagentActivity,
	type SubagentActivityEvent,
	type SubagentActivityListener,
	type SubagentActivityStatus,
	type SubagentDefinition,
	SubagentDefinitionConfigurationError,
	SubagentDefinitionNotFoundError,
	type SubagentDefinitionSource,
	SubagentDelegationScope,
	type SubagentDelegationScopeLease,
	type SubagentDelegationScopeOptions,
	type SubagentDelegationScopeSnapshot,
	type SubagentDiscoveryResult,
	type SubagentEndEvent,
	type SubagentEvent,
	type SubagentEventListener,
	type SubagentHandle,
	SubagentManager,
	type SubagentManagerOptions,
	type SubagentResult,
	type SubagentStartByNameOptions,
	type SubagentStartOptions,
	type SubagentTurnBudgetEvent,
	type SubagentTurnLimits,
} from "./subagents/index.ts";
