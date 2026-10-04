/**
 * Session catalog, run-state, model, subagent, and host-status schemas: the
 * shapes the `sessions`, `models`, `session_contexts`, `subagent_definitions`,
 * and `host_status` queries, the live `phase` and `prompt_cache` values, and
 * the host intents return.
 */

import type { Api, Model } from "@hansjm10/volt-ai";
import { ModelSchema } from "@hansjm10/volt-ai/schemas";
import { type Static, Type } from "typebox";
import { RpcGitContextSchema } from "./git-context.ts";
import { opaque, stringEnum } from "./helpers.ts";
import { RpcThinkingLevelSchema } from "./primitives.ts";
import { RpcReviewDiscussionLinkSchema } from "./review-discussions.ts";
import {
	RPC_WORK_BRANCH_MAX_CHARS,
	RPC_WORK_CHANGE_ID_MAX_CHARS,
	RPC_WORK_PROVIDER_MAX_CHARS,
	RPC_WORK_PULL_REQUEST_TITLE_MAX_CHARS,
	RPC_WORK_REPOSITORY_MAX_CHARS,
} from "./wire-limits.ts";

export const RpcSessionWorkPullRequestSchema = Type.Object(
	{
		provider: Type.String({ minLength: 1, maxLength: RPC_WORK_PROVIDER_MAX_CHARS }),
		number: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		title: Type.String({ maxLength: RPC_WORK_PULL_REQUEST_TITLE_MAX_CHARS }),
		status: stringEnum(["open", "draft", "merged", "closed"]),
		stale: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const rpcSessionWorkBaseProperties = {
	changeId: Type.String({ minLength: 1, maxLength: RPC_WORK_CHANGE_ID_MAX_CHARS }),
	repository: Type.String({ minLength: 1, maxLength: RPC_WORK_REPOSITORY_MAX_CHARS }),
	branch: Type.String({ minLength: 1, maxLength: RPC_WORK_BRANCH_MAX_CHARS }),
};

/** Sanitized provider-neutral Work association exposed only through session lists. */
export const RpcSessionWorkContextSchema = Type.Union([
	Type.Object(
		{
			...rpcSessionWorkBaseProperties,
			resolutionState: Type.Literal("resolved"),
			pullRequest: RpcSessionWorkPullRequestSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...rpcSessionWorkBaseProperties,
			resolutionState: stringEnum(["none", "ambiguous", "unavailable"]),
		},
		{ additionalProperties: false },
	),
]);
export type RpcSessionWorkContext = Static<typeof RpcSessionWorkContextSchema>;

export const RpcSessionContextSchema = Type.Object(
	{
		sessionId: Type.String({ minLength: 1, maxLength: 128 }),
		startingGitContext: Type.Union([RpcGitContextSchema, Type.Null()]),
		workContext: Type.Union([RpcSessionWorkContextSchema, Type.Null()]),
	},
	{ additionalProperties: false },
);

export const RpcSessionListItemSchema = Type.Object(
	{
		reviewDiscussion: Type.Optional(RpcReviewDiscussionLinkSchema),
		sessionId: Type.String(),
		sessionName: Type.Optional(Type.String()),
		createdAt: Type.String(),
		modifiedAt: Type.String(),
		messageCount: Type.Number(),
		firstMessage: Type.String(),
		current: Type.Boolean(),
		/** "subagent" when this session was created for a delegated subagent run. */
		origin: Type.Optional(Type.Literal("subagent")),
		/** First host-observed path-free Git state for this session. */
		startingGitContext: Type.Optional(Type.Union([RpcGitContextSchema, Type.Null()])),
		/** Daemon-owned Work association, when one has been observed. */
		workContext: Type.Optional(RpcSessionWorkContextSchema),
		/** Which host process serves the session now, when one does (daemon hosts only). */
		runtimeState: Type.Optional(stringEnum(["tui-owned", "daemon-active", "daemon-detached", "daemon-draining"])),
		/** The daemon-managed worktree the session is bound to. */
		worktreeId: Type.Optional(Type.String()),
		/** The session's working directory relative to its workspace or worktree root; absent at the root. */
		workingDirectory: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type RpcSessionListItem = Static<typeof RpcSessionListItemSchema>;

export const RpcActiveAgentRunSchema = Type.Object(
	{
		/** Logical operation start in Unix epoch milliseconds; retained through automatic recovery until settlement. */
		startedAt: Type.Number(),
	},
	{ additionalProperties: false },
);

export const RpcActiveCompactionSchema = Type.Object(
	{
		reason: stringEnum(["manual", "threshold", "overflow"]),
		/** Unix epoch milliseconds when the active compaction started. */
		startedAt: Type.Number(),
	},
	{ additionalProperties: false },
);

export const RpcActiveRetrySchema = Type.Object(
	{
		attempt: Type.Number(),
		maxAttempts: Type.Number(),
	},
	{ additionalProperties: false },
);

/**
 * Documented prompt-cache retention for the current model's reusable prefix.
 * Clients compare `expiresAt` with their clock; no event fires at expiry.
 */
export const RpcPromptCacheStatusSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("retained"),
			/** Unix epoch milliseconds when the latest request or cache refresh with the current model started. */
			lastRequestAt: Type.Number(),
			/** Unix epoch milliseconds when the documented retention window lapses; absent when the provider publishes none. */
			expiresAt: Type.Optional(Type.Number()),
			/** Unix epoch milliseconds until which the host keeps refreshing the idle cache; absent unless idle keepalive applies. */
			keepAliveUntil: Type.Optional(Type.Number()),
		},
		{ additionalProperties: false },
	),
	/** Earlier requests used other models, so the next request starts uncached. */
	Type.Object({ kind: Type.Literal("model_changed") }, { additionalProperties: false }),
]);
export type RpcPromptCacheStatus = Static<typeof RpcPromptCacheStatusSchema>;

/** volt-ai model metadata with `compat` opaque: provider tuning that clients never interpret. */
export const RpcModelSchema = Type.Object(
	{
		...ModelSchema.properties,
		compat: Type.Optional(
			opaque<NonNullable<Model<Api>["compat"]>>("provider compatibility tuning; clients never interpret this"),
		),
	},
	{ additionalProperties: false },
);

/** A model as reported to clients with host-owned selectable capabilities. */
export const RpcCatalogModelSchema = Type.Object(
	{
		...RpcModelSchema.properties,
		availableThinkingLevels: Type.Array(RpcThinkingLevelSchema),
		supportsFastMode: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export type RpcCatalogModel = Static<typeof RpcCatalogModelSchema>;

// ============================================================================
// Subagents
// ============================================================================

export const RpcSubagentDefinitionSourceSchema = stringEnum(["built-in", "user", "project"]);

export const RpcSubagentSourceInfoSchema = Type.Object(
	{
		source: Type.String(),
		scope: stringEnum(["user", "project", "temporary"]),
		origin: stringEnum(["package", "top-level"]),
	},
	{ additionalProperties: false },
);

export const RpcSubagentDefinitionSchema = Type.Object(
	{
		name: Type.String(),
		description: Type.String(),
		source: RpcSubagentDefinitionSourceSchema,
		sourceInfo: RpcSubagentSourceInfoSchema,
		tools: Type.Optional(Type.Array(Type.String())),
		excludedTools: Type.Optional(Type.Array(Type.String())),
		allowedSubagents: Type.Optional(Type.Array(Type.String())),
		maxSubagentDepth: Type.Optional(Type.Number()),
		maxChildAgents: Type.Optional(Type.Number()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type RpcSubagentDefinition = Static<typeof RpcSubagentDefinitionSchema>;

export const RpcListSubagentsResponseSchema = Type.Object(
	{ subagents: Type.Array(RpcSubagentDefinitionSchema) },
	{ additionalProperties: false },
);
export type RpcListSubagentsResponse = Static<typeof RpcListSubagentsResponseSchema>;

// ============================================================================
// Push registration responses
// ============================================================================

export const RpcRegisterPushTargetResponseSchema = Type.Object(
	{
		status: Type.Literal("registered"),
		pushTargetId: Type.String(),
	},
	{ additionalProperties: false },
);
export type RpcRegisterPushTargetResponse = Static<typeof RpcRegisterPushTargetResponseSchema>;

// ============================================================================
// Host status
// ============================================================================

/**
 * Host keep-awake (prevent sleep) state as reported to phones. Deliberately
 * omits the host-local mechanism (caffeinate etc.); `reason` is generic wording
 * present only when degraded.
 */
export const RpcKeepAwakeStatusSchema = Type.Object(
	{
		enabled: Type.Boolean(),
		state: stringEnum(["disabled", "active", "degraded"]),
		reason: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);
export type RpcKeepAwakeStatus = Static<typeof RpcKeepAwakeStatusSchema>;

/**
 * Host web-search key state as reported to phones. Deliberately omits the key
 * itself; only whether one is stored.
 */
export const RpcWebSearchStatusSchema = Type.Object({ configured: Type.Boolean() }, { additionalProperties: false });
export type RpcWebSearchStatus = Static<typeof RpcWebSearchStatusSchema>;
