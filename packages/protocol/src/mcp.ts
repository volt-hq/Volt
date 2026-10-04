/**
 * MCP management contract schemas: server/tool/resource/prompt summaries,
 * OAuth flow results, and the `mcp.*` query and intent results. SDK-shaped
 * fields (tool schemas, prompt arguments) stay opaque by design.
 */

import { Type } from "typebox";
import { opaque, stringEnum } from "./helpers.ts";

/** One MCP SDK prompt argument, as the SDK reports it. */
export interface RpcMcpPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

export const RpcMcpRiskSchema = stringEnum(["read", "write", "destructive", "unknown"]);
export const RpcMcpSourceScopeSchema = stringEnum(["user", "project", "temporary"]);
export const RpcMcpServerStatusSchema = stringEnum([
	"disabled",
	"untrusted",
	"cold",
	"discovering",
	"connecting",
	"connected",
	"ready",
	"needs_auth",
	"authenticating",
	"error",
	"disconnecting",
	"disconnected",
]);
export const RpcMcpAuthStateSchema = stringEnum(["none", "required", "pending", "authenticated", "failed"]);
export const RpcMcpRecentCallStatusSchema = stringEnum(["started", "completed", "failed", "cancelled"]);

export const RpcMcpRecentCallSummarySchema = Type.Object(
	{
		id: Type.String(),
		timestamp: Type.String(),
		server: Type.String(),
		tool: Type.String(),
		risk: RpcMcpRiskSchema,
		status: RpcMcpRecentCallStatusSchema,
		durationMs: Type.Optional(Type.Number()),
		outputBytes: Type.Optional(Type.Number()),
		truncated: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const RpcMcpToolSummarySchema = Type.Object(
	{
		server: Type.String(),
		name: Type.String(),
		title: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		risk: RpcMcpRiskSchema,
		trustedRead: Type.Boolean(),
		inputSchema: Type.Optional(opaque<unknown>("MCP SDK JSON schema; passed through verbatim")),
		outputSchema: Type.Optional(opaque<unknown>("MCP SDK JSON schema; passed through verbatim")),
		annotations: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		metadataHash: Type.String(),
		lastSeenAt: Type.String(),
		stale: Type.Boolean(),
		direct: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const RpcMcpResourceSummarySchema = Type.Object(
	{
		server: Type.String(),
		uri: Type.String(),
		name: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		mimeType: Type.Optional(Type.String()),
		size: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export const RpcMcpPromptSummarySchema = Type.Object(
	{
		server: Type.String(),
		name: Type.String(),
		title: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		arguments: Type.Optional(opaque<RpcMcpPromptArgument[]>("MCP SDK prompt arguments; passed through verbatim")),
	},
	{ additionalProperties: false },
);

export const RpcMcpServerSummarySchema = Type.Object(
	{
		id: Type.String(),
		displayName: Type.String(),
		sourceScope: RpcMcpSourceScopeSchema,
		sourceLabel: Type.String(),
		enabled: Type.Boolean(),
		activeInSession: Type.Boolean(),
		transport: stringEnum(["stdio", "streamable_http", "sse"]),
		lifecycle: stringEnum(["lazy", "eager", "keep_alive"]),
		status: RpcMcpServerStatusSchema,
		authState: RpcMcpAuthStateSchema,
		toolCounts: Type.Object(
			{
				cached: Type.Number(),
				live: Type.Optional(Type.Number()),
				enabled: Type.Optional(Type.Number()),
			},
			{ additionalProperties: false },
		),
		resourceCount: Type.Optional(Type.Number()),
		promptCount: Type.Optional(Type.Number()),
		recentCalls: Type.Array(RpcMcpRecentCallSummarySchema),
		lastError: Type.Optional(Type.String()),
		lastConnectedAt: Type.Optional(Type.String()),
		capabilities: Type.Object(
			{
				canEnable: Type.Boolean(),
				canConnect: Type.Boolean(),
				canDisconnect: Type.Boolean(),
				canRefresh: Type.Boolean(),
				canAuthenticate: Type.Boolean(),
				canPersistChanges: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

// ============================================================================
// OAuth flow results
// ============================================================================

export const RpcMcpOAuthBrowserStartResultSchema = Type.Object(
	{
		action: Type.Literal("auth"),
		server: Type.String(),
		flow: Type.Literal("browser"),
		status: stringEnum(["pending", "authenticated"]),
		authorizationUrl: Type.Optional(Type.String()),
		redirectUrl: Type.String(),
		state: Type.Optional(Type.String()),
		message: Type.String(),
	},
	{ additionalProperties: false },
);

export const RpcMcpOAuthBrowserCompleteResultSchema = Type.Object(
	{
		action: Type.Literal("auth"),
		server: Type.String(),
		flow: Type.Literal("browser"),
		status: Type.Literal("authenticated"),
		message: Type.String(),
	},
	{ additionalProperties: false },
);

export const RpcMcpOAuthDeviceStartResultSchema = Type.Object(
	{
		action: Type.Literal("auth"),
		server: Type.String(),
		flow: Type.Literal("device"),
		status: Type.Literal("pending"),
		verificationUri: Type.String(),
		verificationUriComplete: Type.Optional(Type.String()),
		userCode: Type.String(),
		expiresAt: Type.String(),
		intervalMs: Type.Number(),
		message: Type.String(),
	},
	{ additionalProperties: false },
);

export const RpcMcpOAuthDevicePollResultSchema = Type.Object(
	{
		action: Type.Literal("auth"),
		server: Type.String(),
		flow: Type.Literal("device"),
		status: stringEnum(["pending", "authenticated", "failed"]),
		nextPollMs: Type.Optional(Type.Number()),
		message: Type.String(),
	},
	{ additionalProperties: false },
);

export const RpcMcpAuthResponseSchema = Type.Union([
	RpcMcpOAuthBrowserStartResultSchema,
	RpcMcpOAuthBrowserCompleteResultSchema,
	RpcMcpOAuthDeviceStartResultSchema,
	RpcMcpOAuthDevicePollResultSchema,
	Type.Object(
		{
			action: Type.Literal("auth"),
			server: Type.String(),
			status: stringEnum(["cancelled", "logged_out"]),
			message: Type.Optional(Type.String()),
			serverSummary: Type.Optional(RpcMcpServerSummarySchema),
		},
		{ additionalProperties: false },
	),
]);

export const RpcMcpCapabilitiesResponseSchema = Type.Object(
	{
		protocolVersion: Type.Literal(1),
		features: Type.Array(Type.String()),
		remoteSafeByDefault: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Query and intent results
// ============================================================================

export const RpcMcpServersResponseSchema = Type.Object(
	{ servers: Type.Array(RpcMcpServerSummarySchema) },
	{ additionalProperties: false },
);

export const RpcMcpToolsResponseSchema = Type.Object(
	{
		server: Type.String(),
		tools: Type.Array(RpcMcpToolSummarySchema),
		metadataHash: Type.Optional(Type.String()),
		stale: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const RpcMcpToolResponseSchema = Type.Object({ tool: RpcMcpToolSummarySchema }, { additionalProperties: false });

export const RpcMcpResourcesResponseSchema = Type.Object(
	{
		server: Type.String(),
		resources: Type.Array(RpcMcpResourceSummarySchema),
		nextCursor: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcMcpResourceContentResponseSchema = Type.Object(
	{ result: opaque<unknown>("MCP SDK resource content; passed through verbatim") },
	{ additionalProperties: false },
);

export const RpcMcpPromptsResponseSchema = Type.Object(
	{
		server: Type.String(),
		prompts: Type.Array(RpcMcpPromptSummarySchema),
		nextCursor: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcMcpPromptContentResponseSchema = Type.Object(
	{ result: opaque<unknown>("MCP SDK prompt content; passed through verbatim") },
	{ additionalProperties: false },
);

export const RpcMcpRecentCallsResponseSchema = Type.Object(
	{ calls: Type.Array(RpcMcpRecentCallSummarySchema) },
	{ additionalProperties: false },
);

export const RpcMcpServerResponseSchema = Type.Object(
	{
		server: RpcMcpServerSummarySchema,
		persisted: Type.Optional(
			Type.Object({ path: Type.String(), scope: Type.String() }, { additionalProperties: false }),
		),
	},
	{ additionalProperties: false },
);
