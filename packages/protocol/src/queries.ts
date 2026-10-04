/**
 * Queries: reads of what is not in a conversation log (RFC §6.1): catalogs,
 * content fetch by id, and bounded history pages.
 *
 * A query frame is `{type: "query", queryId, query, conversation?, params?}`;
 * the host answers `result{queryId, data}` with the query's result, or
 * `query_error{queryId, reason}`. `history` and `content` read only entries
 * the subscriber's profile projects.
 */

import { type Static, type TObject, type TSchema, Type } from "typebox";
import { RpcAgentOptionsSchema } from "./agent-options.ts";
import { RpcBackgroundJobSnapshotSchema } from "./background-jobs.ts";
import { ClientModelRefSchema } from "./client-fold.ts";
import { LogEntryIdSchema, LogEntryOrdinalSchema, LogSessionIdSchema } from "./entries.ts";
import { stringEnum } from "./helpers.ts";
import { EmptyInputSchema, IntentDescriptorSchema, IntentNameSchema, IntentOptionSchema } from "./intents.ts";
import {
	RpcMcpCapabilitiesResponseSchema,
	RpcMcpPromptContentResponseSchema,
	RpcMcpPromptsResponseSchema,
	RpcMcpRecentCallsResponseSchema,
	RpcMcpResourceContentResponseSchema,
	RpcMcpResourcesResponseSchema,
	RpcMcpServerResponseSchema,
	RpcMcpServersResponseSchema,
	RpcMcpToolResponseSchema,
	RpcMcpToolsResponseSchema,
} from "./mcp.ts";
import { RpcPrReviewSourceRequestSchema, RpcResolvePrReviewResponseSchema } from "./pr-review.ts";
import { RpcConversationIdentifierSchema, RpcQueueModeSchema } from "./primitives.ts";
import { ProjectedEntrySchema } from "./projected.ts";
import { RpcReviewWorkflowListResponseSchema, RpcReviewWorkflowResultResponseSchema } from "./projections.ts";
import { IrohRemoteSessionIdSchema, IrohRemoteWorkingDirectorySchema } from "./remote-handshake.ts";
import {
	RpcListReviewDiscussionsSchema,
	RpcReviewDiscussionSchema,
	RpcReviewGeneralSchema,
} from "./review-discussions.ts";
import {
	RpcCatalogModelSchema,
	RpcKeepAwakeStatusSchema,
	RpcListSubagentsResponseSchema,
	RpcSessionContextSchema,
	RpcSessionListItemSchema,
	RpcWebSearchStatusSchema,
} from "./session.ts";
import { RpcSubscriptionUsageReportSchema } from "./subscription-usage.ts";
import { IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS } from "./wire-limits.ts";
import { IrohRemoteWorkspaceDirectorySchema, IrohRemoteWorktreeSummarySchema } from "./workspace.ts";

const closed = { additionalProperties: false } as const;

/** Most entries one `history` page returns. */
export const HISTORY_PAGE_MAX_ENTRIES = 200;

/** Most Unicode scalars of entry text one `content` answer carries. */
export const CONTENT_TEXT_MAX_SCALARS = IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS;

const server = Type.String();
const runId = RpcConversationIdentifierSchema;

/** One query's parameter and result schemas. */
export interface QuerySchemas {
	readonly params: TObject;
	readonly result: TSchema;
}

/** Every query, keyed by name. */
export const QUERY_SCHEMAS = {
	// Intents
	intents: {
		params: EmptyInputSchema,
		result: Type.Object({ intents: Type.Array(IntentDescriptorSchema) }, closed),
	},
	intent_completions: {
		params: Type.Object(
			{ intent: IntentNameSchema, field: Type.String(), prefix: Type.Optional(Type.String()) },
			closed,
		),
		result: Type.Object({ completions: Type.Array(IntentOptionSchema) }, closed),
	},

	// Conversation log
	/**
	 * Older projected entries, newest last: entries with ordinals before
	 * `before`, at most `limit` of them. With `branch`, only the ancestors of
	 * that entry, so a client with a bounded snapshot pages its active branch.
	 */
	history: {
		params: Type.Object(
			{
				before: LogEntryOrdinalSchema,
				limit: Type.Integer({ minimum: 1, maximum: HISTORY_PAGE_MAX_ENTRIES }),
				branch: Type.Optional(LogEntryIdSchema),
			},
			closed,
		),
		result: Type.Object(
			{
				entries: Type.Array(ProjectedEntrySchema),
				/** True when older entries remain. */
				earlier: Type.Boolean(),
			},
			closed,
		),
	},
	/**
	 * One content part of an entry in full: the text, thinking, and image
	 * blocks of its message, in order. Text comes in chunks from `offset`
	 * (in Unicode scalars).
	 */
	content: {
		params: Type.Object(
			{
				entryId: LogEntryIdSchema,
				part: Type.Optional(Type.Integer({ minimum: 0 })),
				offset: Type.Optional(Type.Integer({ minimum: 0 })),
			},
			closed,
		),
		result: Type.Object(
			{
				entryId: LogEntryIdSchema,
				part: Type.Integer({ minimum: 0 }),
				/** Content parts on the entry. */
				parts: Type.Integer({ minimum: 0 }),
				content: Type.Union([
					Type.Object(
						{
							type: Type.Literal("text"),
							text: Type.String(),
							offset: Type.Integer({ minimum: 0 }),
							/** Where the next chunk starts, or null when the text is complete. */
							nextOffset: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
							totalScalars: Type.Integer({ minimum: 0 }),
						},
						closed,
					),
					Type.Object({ type: Type.Literal("image"), mimeType: Type.String(), data: Type.String() }, closed),
				]),
			},
			closed,
		),
	},

	// Catalogs
	/** Selectable models; `cycleScope` lists the models a client's model-cycle control steps through. */
	models: {
		params: EmptyInputSchema,
		result: Type.Object(
			{
				models: Type.Array(RpcCatalogModelSchema),
				cycleScope: Type.Array(ClientModelRefSchema),
			},
			closed,
		),
	},
	sessions: {
		params: Type.Object(
			{
				limit: Type.Optional(Type.Integer({ minimum: 1 })),
				cursor: Type.Optional(Type.String({ minLength: 1 })),
			},
			closed,
		),
		result: Type.Object(
			{
				sessions: Type.Array(RpcSessionListItemSchema),
				hasMore: Type.Boolean(),
				nextCursor: Type.Union([Type.String(), Type.Null()]),
			},
			closed,
		),
	},
	/** Host settings that intents change; refetched on `changed{settings}`. */
	settings: {
		params: EmptyInputSchema,
		result: Type.Object(
			{
				steeringMode: RpcQueueModeSchema,
				followUpMode: RpcQueueModeSchema,
				autoCompaction: Type.Boolean(),
				autoRetry: Type.Boolean(),
				/** The active settings profile, `""` without one: compaction intents name it as `expectedProfile`. */
				profile: Type.String(),
			},
			closed,
		),
	},
	subscription_usage: { params: EmptyInputSchema, result: RpcSubscriptionUsageReportSchema },
	/** The host's keep-awake state and, when the host shares it, its theme colors; refetched on `changed{host}`. */
	host_status: {
		params: EmptyInputSchema,
		result: Type.Object(
			{
				keepAwake: RpcKeepAwakeStatusSchema,
				theme: Type.Optional(
					Type.Object(
						{
							themeName: Type.String(),
							/** Resolved colors by token name, hex values only. */
							tokens: Type.Record(
								Type.String(),
								Type.String({ pattern: "^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$" }),
							),
						},
						closed,
					),
				),
			},
			closed,
		),
	},
	/** Whether the host stores a web search key; never the key. */
	web_search_status: {
		params: EmptyInputSchema,
		result: Type.Object({ webSearch: RpcWebSearchStatusSchema }, closed),
	},
	subagent_definitions: { params: EmptyInputSchema, result: RpcListSubagentsResponseSchema },
	job_output: {
		params: Type.Object({ jobId: RpcConversationIdentifierSchema }, closed),
		result: Type.Object({ job: RpcBackgroundJobSnapshotSchema }, closed),
	},

	// The connection's workspace
	/** The models and default configuration for a new conversation in the workspace. */
	agent_options: { params: EmptyInputSchema, result: RpcAgentOptionsSchema },
	/** Each session's starting git context and work context, in request order. */
	session_contexts: {
		params: Type.Object(
			{ sessionIds: Type.Array(IrohRemoteSessionIdSchema, { minItems: 1, maxItems: 64, uniqueItems: true }) },
			closed,
		),
		result: Type.Object({ contexts: Type.Array(RpcSessionContextSchema) }, closed),
	},
	worktrees: {
		params: EmptyInputSchema,
		result: Type.Object({ worktrees: Type.Array(IrohRemoteWorktreeSummarySchema) }, closed),
	},
	/** The folders under `path` (the workspace root when absent), by workspace-relative path. */
	workspace_directories: {
		params: Type.Object({ path: Type.Optional(IrohRemoteWorkingDirectorySchema) }, closed),
		result: Type.Object(
			{ path: Type.Optional(Type.String()), directories: Type.Array(IrohRemoteWorkspaceDirectorySchema) },
			closed,
		),
	},
	/** The pull request a review would target: by number, or the one for a checkout's branch. */
	pr_review: { params: RpcPrReviewSourceRequestSchema, result: RpcResolvePrReviewResponseSchema },

	// MCP
	"mcp.capabilities": { params: EmptyInputSchema, result: RpcMcpCapabilitiesResponseSchema },
	"mcp.servers": { params: EmptyInputSchema, result: RpcMcpServersResponseSchema },
	"mcp.server": { params: Type.Object({ server }, closed), result: RpcMcpServerResponseSchema },
	"mcp.tools": { params: Type.Object({ server }, closed), result: RpcMcpToolsResponseSchema },
	"mcp.tool": { params: Type.Object({ server, tool: Type.String() }, closed), result: RpcMcpToolResponseSchema },
	"mcp.resources": {
		params: Type.Object({ server, cursor: Type.Optional(Type.String()) }, closed),
		result: RpcMcpResourcesResponseSchema,
	},
	"mcp.resource": {
		params: Type.Object({ server, resourceUri: Type.String() }, closed),
		result: RpcMcpResourceContentResponseSchema,
	},
	"mcp.prompts": {
		params: Type.Object({ server, cursor: Type.Optional(Type.String()) }, closed),
		result: RpcMcpPromptsResponseSchema,
	},
	"mcp.prompt": {
		params: Type.Object(
			{
				server,
				prompt: Type.String(),
				arguments: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
				argumentsJson: Type.Optional(Type.String()),
			},
			closed,
		),
		result: RpcMcpPromptContentResponseSchema,
	},
	"mcp.recent_calls": {
		params: Type.Object({ server: Type.Optional(server) }, closed),
		result: RpcMcpRecentCallsResponseSchema,
	},

	// Review
	"review.discussions": {
		params: Type.Object(
			{
				runId,
				cursor: Type.Optional(Type.String({ maxLength: 32, pattern: "^[0-9]+$" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
			},
			closed,
		),
		result: RpcListReviewDiscussionsSchema,
	},
	/** The discussion this conversation belongs to, when it is a review discussion. */
	"review.discussion_source": {
		params: EmptyInputSchema,
		result: Type.Object({ discussion: Type.Union([RpcReviewDiscussionSchema, Type.Null()]) }, closed),
	},
	"review.general": {
		params: Type.Object({ runId }, closed),
		result: Type.Object(RpcReviewGeneralSchema.properties, {
			...closed,
			description: "A review run's general discussion session.",
		}),
	},
	"review.result": { params: Type.Object({ runId }, closed), result: RpcReviewWorkflowResultResponseSchema },
	"review.workflows": {
		params: Type.Object(
			{
				cursor: Type.Optional(Type.String()),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
			},
			closed,
		),
		result: RpcReviewWorkflowListResponseSchema,
	},
} as const satisfies Record<string, QuerySchemas>;

export type QueryName = keyof typeof QUERY_SCHEMAS;

export const QUERY_NAMES = Object.keys(QUERY_SCHEMAS) as QueryName[];

export const QueryNameSchema = stringEnum(QUERY_NAMES);

export type QueryParams<K extends QueryName> = Static<(typeof QUERY_SCHEMAS)[K]["params"]>;
export type QueryResult<K extends QueryName> = Static<(typeof QUERY_SCHEMAS)[K]["result"]>;

// ============================================================================
// Query frames
// ============================================================================

/** One frame schema per query, keyed by query name: `params` is required when the query has required parameters. */
export const QUERY_FRAME_SCHEMAS: Readonly<Record<QueryName, TObject>> = (() => {
	const frames = {} as Record<QueryName, TObject>;
	for (const name of QUERY_NAMES) {
		const params: TObject = QUERY_SCHEMAS[name].params;
		frames[name] = Type.Object(
			{
				type: Type.Literal("query"),
				queryId: RpcConversationIdentifierSchema,
				query: Type.Literal(name),
				/** The conversation a conversation-scoped query reads; the host chooses when absent. */
				conversation: Type.Optional(LogSessionIdSchema),
				params: (params.required?.length ?? 0) > 0 ? params : Type.Optional(params),
			},
			closed,
		);
	}
	return frames;
})();

/** Every query frame a client may send. */
export const QueryFrameSchema = Type.Union(QUERY_NAMES.map((name): TSchema => QUERY_FRAME_SCHEMAS[name]));

export type QueryFrame = {
	[K in QueryName]: {
		type: "query";
		queryId: string;
		query: K;
		conversation?: string;
		params?: QueryParams<K>;
	};
}[QueryName];
