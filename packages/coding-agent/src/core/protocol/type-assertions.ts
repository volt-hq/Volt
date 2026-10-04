/**
 * Compile-time drift tripwires pinning the @hansjm10/volt-protocol schemas to
 * the upstream types they project onto the wire (volt-agent-core and host
 * modules that own the source shapes). volt-ai pins its own schemas, which the
 * contract uses directly. No runtime exports — `tsc --noEmit` and every build
 * fail when an upstream shape changes until the contract is updated
 * consciously.
 *
 * JsonWireShape maps `| undefined` properties to optional ones — the wire
 * sees JSON.stringify output, which drops undefined-valued keys.
 */

import type { AgentMessage, ThinkingLevel } from "@hansjm10/volt-agent-core";
import type {
	Assert,
	JsonWireShape,
	LogMessage,
	MutualExtends,
	RpcBashResultSchema,
	RpcCompactionResultSchema,
	RpcMcpCapabilitiesResponseSchema,
	RpcMcpOAuthBrowserCompleteResultSchema,
	RpcMcpOAuthBrowserStartResultSchema,
	RpcMcpOAuthDevicePollResultSchema,
	RpcMcpOAuthDeviceStartResultSchema,
	RpcMcpPromptSummarySchema,
	RpcMcpRecentCallSummarySchema,
	RpcMcpResourceSummarySchema,
	RpcMcpServerSummarySchema,
	RpcMcpToolSummarySchema,
	RpcPromptCacheStatusSchema,
	RpcReviewCoverageSchema,
	RpcReviewFindingSchema,
	RpcSubscriptionUsageReportSchema,
	RpcThinkingLevelSchema,
	SessionReferenceSchema,
} from "@hansjm10/volt-protocol";
import type { Static } from "typebox";
import type { BashResult } from "../bash-executor.ts";
import type { CompactionResult } from "../compaction/index.ts";
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
import type { PromptCacheStatus } from "../prompt-cache-status.ts";
import type { ReviewCoverage, ReviewFinding } from "../review.ts";
import type { SessionReference } from "../session-manager.ts";
import type { SubscriptionUsageReport } from "../subscription-usage.ts";

// volt-agent-core
type _thinkingLevel = Assert<MutualExtends<Static<typeof RpcThinkingLevelSchema>, ThinkingLevel>>;

// Host modules that own response-body shapes
type _promptCacheStatus = Assert<MutualExtends<Static<typeof RpcPromptCacheStatusSchema>, PromptCacheStatus>>;
type _subscriptionUsage = Assert<
	MutualExtends<Static<typeof RpcSubscriptionUsageReportSchema>, JsonWireShape<SubscriptionUsageReport>>
>;
type _bashResult = Assert<MutualExtends<Static<typeof RpcBashResultSchema>, JsonWireShape<BashResult>>>;
type _compactionResult = Assert<MutualExtends<Static<typeof RpcCompactionResultSchema>, CompactionResult>>;
type _reviewFinding = Assert<MutualExtends<Static<typeof RpcReviewFindingSchema>, ReviewFinding>>;
type _reviewCoverage = Assert<MutualExtends<Static<typeof RpcReviewCoverageSchema>, ReviewCoverage>>;

// MCP module shapes
type _mcpCapabilities = Assert<MutualExtends<Static<typeof RpcMcpCapabilitiesResponseSchema>, McpRpcCapabilities>>;
type _mcpRecentCall = Assert<MutualExtends<Static<typeof RpcMcpRecentCallSummarySchema>, McpRecentCallSummary>>;
type _mcpTool = Assert<MutualExtends<Static<typeof RpcMcpToolSummarySchema>, McpToolSummary>>;
type _mcpResource = Assert<MutualExtends<Static<typeof RpcMcpResourceSummarySchema>, McpResourceSummary>>;
type _mcpPrompt = Assert<MutualExtends<Static<typeof RpcMcpPromptSummarySchema>, McpPromptSummary>>;
type _mcpServer = Assert<MutualExtends<Static<typeof RpcMcpServerSummarySchema>, McpServerSummary>>;
type _mcpBrowserStart = Assert<
	MutualExtends<Static<typeof RpcMcpOAuthBrowserStartResultSchema>, McpOAuthBrowserStartResult>
>;
type _mcpBrowserComplete = Assert<
	MutualExtends<Static<typeof RpcMcpOAuthBrowserCompleteResultSchema>, McpOAuthBrowserCompleteResult>
>;
type _mcpDeviceStart = Assert<
	MutualExtends<Static<typeof RpcMcpOAuthDeviceStartResultSchema>, McpOAuthDeviceStartResult>
>;
type _mcpDevicePoll = Assert<MutualExtends<Static<typeof RpcMcpOAuthDevicePollResultSchema>, McpOAuthDevicePollResult>>;

// Session log: the runtime's open message union stores every protocol message role,
// and the durable child reference matches the protocol's session reference.
type _logMessage = Assert<[LogMessage] extends [AgentMessage] ? true : false>;
type _sessionReference = Assert<MutualExtends<Static<typeof SessionReferenceSchema>, SessionReference>>;
