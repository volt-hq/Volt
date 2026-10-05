/**
 * Intents: the one namespace of client operations (RFC §6.1). Typed commands
 * and UI action ids merge into intents named after the typed commands; UI-only
 * builtins get snake_case names; extension commands, prompt templates, and
 * skills are dynamic intents named by their id prefixes.
 *
 * An intent frame is `{type: <intent name>, intentId, conversation?,
 * expectedOrdinal?, input?}`; the host answers `accepted{ordinals}` or
 * `rejected{reason}`. Input intents (`prompt`, `steer`, `follow_up`) use the
 * durable `clientMessageId` as their `intentId`; the host deduplicates other
 * intents in a per-conversation window of {@link INTENT_OUTCOME_WINDOW}
 * outcomes. Branch-fenced intents carry `expectedOrdinal`, the client's
 * position, and are rejected `stale` once the branch switched after it.
 *
 * Structural intents (`new_session`, `switch_session`, `fork`, `clone`,
 * `review_open_session`, and `open_work` when it moves the client) answer
 * `accepted{conversation}` when they moved the client, followed by
 * `ended{moved, target}` on its subscription; their result is present only
 * when they were cancelled.
 *
 * Frame type names are reserved: no intent is named like a frame.
 */

import type { JsonValue } from "@hansjm10/volt-ai";
import { type Static, type TObject, type TSchema, type TString, type TUnion, Type } from "typebox";
import { RpcAgentOptionsModelSelectionSchema } from "./agent-options.ts";
import { LogEntryIdSchema, LogSessionIdSchema } from "./entries.ts";
import { opaque, openStringEnum, stringEnum } from "./helpers.ts";
import { RpcMcpAuthResponseSchema, RpcMcpServerResponseSchema } from "./mcp.ts";
import { RpcAgentModeSchema, RpcPlanExecutionStrategySchema } from "./planning.ts";
import { RpcPreparePrReviewResponseSchema, RpcPrReviewPrepareRequestSchema } from "./pr-review.ts";
import {
	RpcClientMessageIdSchema,
	RpcConversationIdentifierSchema,
	RpcConversationInputImagesSchema,
	RpcQueueModeSchema,
	RpcRegisterPushTargetArgsSchema,
	RpcSafeNonNegativeIntegerSchema,
	RpcStreamingBehaviorSchema,
	RpcThinkingLevelSchema,
} from "./primitives.ts";
import { RpcReviewAcknowledgmentResponseSchema } from "./projections.ts";
import { RemoteCapabilitiesSchema } from "./remote-access.ts";
import { IrohRemoteWorkingDirectorySchema, IrohRemoteWorktreeIdSchema } from "./remote-handshake.ts";
import { RpcResetReviewDiscussionSchema, RpcStartReviewDiscussionsSchema } from "./review-discussions.ts";
import { RpcKeepAwakeStatusSchema, RpcRegisterPushTargetResponseSchema, RpcWebSearchStatusSchema } from "./session.ts";
import { RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES } from "./wire-limits.ts";
import { IrohRemoteWorkspaceNameSchema, IrohRemoteWorktreeSummarySchema } from "./workspace.ts";

const closed = { additionalProperties: false } as const;

/** Outcomes of non-input intents the host remembers per conversation, so a retried intent id answers the same. */
export const INTENT_OUTCOME_WINDOW = 256;

/** Longest intent name, in characters. */
export const INTENT_NAME_MAX_CHARS = 160;

/** Id prefixes of dynamic intents: extension commands, prompt templates, and skills. */
export const DYNAMIC_INTENT_PATTERN = "^(extension\\.command|prompt\\.template|skill)\\.";

/** A dynamic intent name: a dynamic prefix followed by the host-assigned id. */
export const DynamicIntentNameSchema = Type.String({
	maxLength: INTENT_NAME_MAX_CHARS,
	pattern: "^(?:extension\\.command|prompt\\.template|skill)\\.[A-Za-z0-9_.:-]+$",
	"x-volt-expected": "be a dynamic intent name",
});

/** The input of an intent that takes none. */
export const EmptyInputSchema = Type.Object({}, closed);

/** The output of a structural intent that was cancelled instead of moving the client. */
export const IntentCancelledSchema = Type.Object(
	{ cancelled: Type.Literal(true) },
	{ ...closed, description: "The intent was cancelled; the client stays where it is." },
);

/** The output of an intent that started a review workflow. */
export const ReviewWorkflowStartedSchema = Type.Object({ workflowId: RpcConversationIdentifierSchema }, closed);

/** The output of `bash`: the command's combined output, sanitized and possibly truncated. */
export const RpcBashResultSchema = Type.Object(
	{
		/** Combined stdout + stderr output (sanitized, possibly truncated) */
		output: Type.String(),
		/** Process exit code (absent if killed/cancelled) */
		exitCode: Type.Optional(Type.Number()),
		cancelled: Type.Boolean(),
		truncated: Type.Boolean(),
		/** Path to temp file containing full output (if output exceeded truncation threshold) */
		fullOutputPath: Type.Optional(Type.String()),
	},
	closed,
);

/** The output of `compact`. */
export const RpcCompactionResultSchema = Type.Object(
	{
		summary: Type.String(),
		firstKeptEntryId: Type.String(),
		tokensBefore: Type.Number(),
		/** Estimated context tokens after rebuilding from the new compaction boundary. */
		estimatedTokensAfter: Type.Optional(Type.Number()),
		details: Type.Optional(opaque<JsonValue>("extension-specific compaction data")),
	},
	closed,
);

// ============================================================================
// Input fragments
// ============================================================================

const conversationInput = {
	message: Type.String({ "x-volt-max-utf8-bytes": RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES }),
	images: Type.Optional(RpcConversationInputImagesSchema),
};

const planRevision = {
	planId: Type.String(),
	expectedRevision: Type.Integer({ minimum: 0 }),
};

const reviewOptions = {
	focus: Type.Optional(Type.String()),
	/** Comma-separated repository-relative globs. */
	scope: Type.Optional(Type.String()),
	effort: Type.Optional(stringEnum(["low", "standard", "high"])),
	includeOptional: Type.Optional(Type.Boolean()),
	scopeMode: Type.Optional(stringEnum(["incremental", "full"])),
};

const runId = RpcConversationIdentifierSchema;
const server = Type.String();

// ============================================================================
// Built-in intents
// ============================================================================

/** One built-in intent's input schema and, when it returns data, its output schema. */
export interface IntentSchemas {
	readonly input: TObject;
	readonly output?: TSchema;
}

/**
 * Every built-in intent, keyed by name. The host's intent registry binds
 * each one to its definition (scope, fence, remote safety, required
 * capabilities, availability).
 */
export const INTENT_SCHEMAS = {
	// Input
	prompt: {
		input: Type.Object(
			{ ...conversationInput, streamingBehavior: Type.Optional(RpcStreamingBehaviorSchema) },
			closed,
		),
	},
	steer: { input: Type.Object(conversationInput, closed) },
	follow_up: { input: Type.Object(conversationInput, closed) },

	// Run control
	abort: { input: EmptyInputSchema },
	abort_retry: { input: EmptyInputSchema },
	bash: {
		input: Type.Object({ command: Type.String(), excludeFromContext: Type.Optional(Type.Boolean()) }, closed),
		output: RpcBashResultSchema,
	},
	abort_bash: { input: EmptyInputSchema },
	compact: {
		input: Type.Object({ customInstructions: Type.Optional(Type.String()) }, closed),
		output: RpcCompactionResultSchema,
	},

	// Conversation settings (entries)
	set_model: { input: Type.Object(RpcAgentOptionsModelSelectionSchema.properties, closed) },
	set_thinking_level: {
		input: Type.Object(
			{ level: RpcThinkingLevelSchema },
			{ ...closed, description: "The thinking level for the conversation's branch." },
		),
	},
	set_fast_mode: { input: Type.Object({ enabled: Type.Boolean() }, closed) },
	set_session_name: { input: Type.Object({ name: Type.String() }, closed) },

	// Agent mode and plans
	set_agent_mode: { input: Type.Object({ mode: RpcAgentModeSchema }, closed) },
	plan_execute: {
		input: Type.Object({ ...planRevision, strategy: RpcPlanExecutionStrategySchema }, closed),
		output: Type.Object({ started: Type.Boolean() }, closed),
	},
	plan_change: { input: Type.Object(planRevision, closed) },
	plan_discard: { input: Type.Object(planRevision, closed) },

	// Structural
	new_session: {
		input: Type.Object(
			{
				parentSessionId: Type.Optional(LogSessionIdSchema),
				preserveReviewRunId: Type.Optional(runId),
				replaceReviewGeneral: Type.Optional(Type.Boolean()),
			},
			{
				...closed,
				anyOf: [{ properties: { replaceReviewGeneral: { const: false } } }, { required: ["preserveReviewRunId"] }],
			},
		),
		output: IntentCancelledSchema,
	},
	switch_session: { input: Type.Object({ sessionId: LogSessionIdSchema }, closed), output: IntentCancelledSchema },
	fork: {
		input: Type.Object({ entryId: LogEntryIdSchema }, closed),
		/** Not cancelled: the text of the message the fork was taken before, for the editor. */
		output: Type.Union([IntentCancelledSchema, Type.Object({ text: Type.String() }, closed)]),
	},
	clone: { input: EmptyInputSchema, output: IntentCancelledSchema },
	export_html: {
		input: Type.Object({ outputPath: Type.Optional(Type.String()) }, closed),
		output: Type.Object({ path: Type.String({ minLength: 1 }) }, closed),
	},

	// Subagents
	subagent_start: {
		input: Type.Object({ agent: Type.String(), prompt: Type.String() }, closed),
		output: Type.Object({ subagentId: Type.String(), conversation: LogSessionIdSchema }, closed),
	},
	subagent_abort: { input: Type.Object({ subagentId: Type.String() }, closed) },
	subagent_dispose: { input: Type.Object({ subagentId: Type.String() }, closed) },

	// Work (RFC §7): work items of the conversation, by work id
	/** Cancel open work; rejected `not_allowed` when its kind is not cancellable. */
	cancel_work: { input: Type.Object({ workId: LogEntryIdSchema }, closed) },
	/**
	 * Open the conversation work runs in or produced: a subagent's child, which
	 * the result names for the client to subscribe to, or a conversation the
	 * client moves to (`accepted{conversation}`, then `ended{moved}`).
	 */
	open_work: {
		input: Type.Object({ workId: LogEntryIdSchema }, closed),
		output: Type.Union([IntentCancelledSchema, Type.Object({ conversation: LogSessionIdSchema }, closed)]),
	},
	/** Continue suspended work: open work of a resumable kind that no executor runs since a restart. */
	resume_work: { input: Type.Object({ workId: LogEntryIdSchema }, closed) },
	/** Start a subagent: the work item that runs it and the child conversation to subscribe to. */
	start_subagent: {
		input: Type.Object(
			{
				agent: Type.String({ minLength: 1 }),
				prompt: Type.String({ "x-volt-max-utf8-bytes": RPC_CONVERSATION_INPUT_MESSAGE_MAX_UTF8_BYTES }),
			},
			closed,
		),
		output: Type.Object({ workId: LogEntryIdSchema, conversation: LogSessionIdSchema }, closed),
	},

	// Review
	review_uncommitted: { input: Type.Object(reviewOptions, closed), output: ReviewWorkflowStartedSchema },
	review_branch: {
		input: Type.Object({ base: Type.Optional(Type.String()), ...reviewOptions }, closed),
		output: ReviewWorkflowStartedSchema,
	},
	review_pr: {
		input: Type.Object({ number: Type.Optional(Type.String()), ...reviewOptions }, closed),
		output: ReviewWorkflowStartedSchema,
	},
	review_commit: {
		input: Type.Object({ ref: Type.String({ minLength: 1 }), ...reviewOptions }, closed),
		output: ReviewWorkflowStartedSchema,
	},
	review_rerun: {
		input: Type.Object({ runId, mode: Type.Optional(stringEnum(["incremental", "full"])) }, closed),
		output: ReviewWorkflowStartedSchema,
	},
	review_cancel_workflow: { input: Type.Object({ workflowId: RpcConversationIdentifierSchema }, closed) },
	review_open_session: {
		input: Type.Object(
			{ runId, findingIds: Type.Optional(Type.Array(RpcConversationIdentifierSchema, { maxItems: 50 })) },
			closed,
		),
		output: IntentCancelledSchema,
	},
	review_acknowledge: { input: Type.Object({ runId }, closed), output: RpcReviewAcknowledgmentResponseSchema },
	review_record_finding_outcome: {
		input: Type.Object(
			{
				runId,
				findingId: RpcConversationIdentifierSchema,
				status: stringEnum(["accepted", "fixed", "dismissed"]),
				reason: Type.Optional(stringEnum(["false_positive", "intentional", "not_actionable", "other"])),
				note: Type.Optional(Type.String({ maxLength: 2_000 })),
			},
			closed,
		),
		output: Type.Object(
			{
				runId,
				findingId: RpcConversationIdentifierSchema,
				status: stringEnum(["accepted", "fixed", "dismissed"]),
				reason: Type.Optional(stringEnum(["false_positive", "intentional", "not_actionable", "other"])),
				note: Type.Optional(Type.String()),
				createdAt: Type.Number(),
			},
			closed,
		),
	},
	review_publish: {
		input: Type.Object({ runId, confirmed: Type.Literal(true) }, closed),
		output: Type.Object(
			{
				reviewId: Type.Optional(Type.Integer({ minimum: 1 })),
				url: Type.Optional(Type.String()),
				inlineFindingIds: Type.Array(Type.String()),
				summaryOnlyFindingIds: Type.Array(Type.String()),
			},
			closed,
		),
	},
	review_export_feedback: {
		input: Type.Object({ path: Type.Optional(Type.String()) }, closed),
		/** `path` is present when the outcomes were written to a file. */
		output: Type.Object(
			{
				schemaVersion: Type.Literal(1),
				exportedAt: Type.String(),
				outcomes: Type.Array(Type.Record(Type.String(), Type.Unknown())),
				path: Type.Optional(Type.String()),
			},
			closed,
		),
	},
	review_start_discussions: {
		input: Type.Object(
			{
				runId,
				findingIds: Type.Array(RpcConversationIdentifierSchema, { minItems: 1, maxItems: 50, uniqueItems: true }),
				requestId: RpcConversationIdentifierSchema,
				discussionConfiguration: Type.Optional(
					Type.Object(
						{
							model: Type.Optional(RpcAgentOptionsModelSelectionSchema),
							thinkingLevel: Type.Optional(RpcThinkingLevelSchema),
						},
						closed,
					),
				),
			},
			closed,
		),
		output: RpcStartReviewDiscussionsSchema,
	},
	review_reset_discussion: {
		input: Type.Object(
			{
				discussionId: RpcConversationIdentifierSchema,
				expectedSessionId: RpcConversationIdentifierSchema,
				requestId: RpcConversationIdentifierSchema,
			},
			closed,
		),
		output: RpcResetReviewDiscussionSchema,
	},

	// Host settings
	set_default_model: { input: Type.Object(RpcAgentOptionsModelSelectionSchema.properties, closed) },
	set_default_thinking_level: {
		input: Type.Object(
			{ level: RpcThinkingLevelSchema },
			{ ...closed, description: "The default thinking level for new conversations." },
		),
	},
	set_steering_mode: { input: Type.Object({ mode: RpcQueueModeSchema }, closed) },
	set_follow_up_mode: { input: Type.Object({ mode: RpcQueueModeSchema }, closed) },
	set_auto_retry: { input: Type.Object({ enabled: Type.Boolean() }, closed) },
	/**
	 * `provider`, `modelId`, and `expectedProfile` name the model and settings
	 * profile the client saw; the host rejects the change when they moved.
	 */
	set_auto_compaction: {
		input: Type.Object(
			{
				enabled: Type.Boolean(),
				provider: Type.Optional(Type.String()),
				modelId: Type.Optional(Type.String()),
				expectedProfile: Type.Optional(Type.String()),
			},
			closed,
		),
	},
	/** `tokens` 0 uses the context-limit default. */
	set_compaction_threshold: {
		input: Type.Object(
			{
				tokens: Type.Integer({ minimum: 0 }),
				provider: Type.String(),
				modelId: Type.String(),
				expectedProfile: Type.String(),
			},
			closed,
		),
	},
	set_keep_awake: { input: Type.Object({ enabled: Type.Boolean() }, closed), output: RpcKeepAwakeStatusSchema },
	/** `null` or absent removes the stored key. */
	set_web_search_key: {
		input: Type.Object({ apiKey: Type.Optional(Type.Union([Type.String(), Type.Null()])) }, closed),
		output: RpcWebSearchStatusSchema,
	},
	upload_device_logs: {
		input: Type.Object({ fileName: Type.Optional(Type.String()), content: Type.String() }, closed),
		output: Type.Object({ path: Type.String(), byteCount: Type.Integer({ minimum: 0 }) }, closed),
	},

	// MCP servers
	"mcp.connect": { input: Type.Object({ server }, closed), output: RpcMcpServerResponseSchema },
	"mcp.disconnect": { input: Type.Object({ server }, closed), output: RpcMcpServerResponseSchema },
	"mcp.refresh": { input: Type.Object({ server }, closed), output: RpcMcpServerResponseSchema },
	"mcp.set_enabled": {
		input: Type.Object({ server, enabled: Type.Boolean() }, closed),
		output: RpcMcpServerResponseSchema,
	},
	"mcp.auth_start_device": { input: Type.Object({ server }, closed), output: RpcMcpAuthResponseSchema },
	"mcp.auth_start_browser": {
		input: Type.Object({ server, redirectUrl: Type.Optional(Type.String()) }, closed),
		output: RpcMcpAuthResponseSchema,
	},
	"mcp.auth_complete": {
		input: Type.Object(
			{ server, redirectUrl: Type.String(), code: Type.String(), state: Type.Optional(Type.String()) },
			closed,
		),
		output: RpcMcpAuthResponseSchema,
	},
	"mcp.auth_poll": { input: Type.Object({ server }, closed), output: RpcMcpAuthResponseSchema },
	"mcp.auth_cancel": { input: Type.Object({ server }, closed), output: RpcMcpAuthResponseSchema },
	"mcp.logout": { input: Type.Object({ server }, closed), output: RpcMcpAuthResponseSchema },

	// Push targets and the connection's workspace. Workspace-scoped intents act
	// on the workspace the connection is bound to; none carries a host path.
	register_push_target: { input: RpcRegisterPushTargetArgsSchema, output: RpcRegisterPushTargetResponseSchema },
	/** `workspaceName` confirms the workspace to unregister: the connection's own. */
	unregister_workspace: {
		input: Type.Object({ workspaceName: IrohRemoteWorkspaceNameSchema }, closed),
		output: Type.Object({ workspaceName: IrohRemoteWorkspaceNameSchema, unregistered: Type.Literal(true) }, closed),
	},
	create_worktree: {
		input: Type.Object(
			{
				worktreeName: Type.Optional(IrohRemoteWorktreeIdSchema),
				branch: Type.Optional(Type.String()),
				baseRef: Type.Optional(Type.String()),
				workingDirectory: Type.Optional(IrohRemoteWorkingDirectorySchema),
			},
			closed,
		),
		output: Type.Object({ worktree: IrohRemoteWorktreeSummarySchema }, closed),
	},
	/** `force` removes a worktree with uncommitted or unmerged work: the user's explicit destructive choice. */
	remove_worktree: {
		input: Type.Object({ worktreeId: IrohRemoteWorktreeIdSchema, force: Type.Optional(Type.Boolean()) }, closed),
		output: Type.Object(
			{
				worktreeId: IrohRemoteWorktreeIdSchema,
				removed: Type.Literal(true),
				stoppedRuntimeCount: Type.Integer({ minimum: 0 }),
				closedStreamCount: Type.Integer({ minimum: 0 }),
			},
			closed,
		),
	},
	/** Prepare an isolated worktree session for reviewing a pull request. */
	prepare_pr_review: { input: RpcPrReviewPrepareRequestSchema, output: RpcPreparePrReviewResponseSchema },
} as const satisfies Record<string, IntentSchemas>;

export type BuiltinIntentName = keyof typeof INTENT_SCHEMAS;

export const BUILTIN_INTENT_NAMES = Object.keys(INTENT_SCHEMAS) as BuiltinIntentName[];

/** Intents whose `intentId` is the input's durable `clientMessageId`. */
export const INPUT_INTENT_NAMES = ["prompt", "steer", "follow_up"] as const satisfies readonly BuiltinIntentName[];

export type IntentInput<K extends BuiltinIntentName> = Static<(typeof INTENT_SCHEMAS)[K]["input"]>;

export type IntentOutput<K extends BuiltinIntentName> = (typeof INTENT_SCHEMAS)[K] extends {
	readonly output: infer O extends TSchema;
}
	? Static<O>
	: never;

/** A built-in intent name. */
export const BuiltinIntentNameSchema = stringEnum(BUILTIN_INTENT_NAMES);

/** Any intent name: a built-in name or a dynamic one. */
export const IntentNameSchema = Type.Union([BuiltinIntentNameSchema, DynamicIntentNameSchema]);
export type IntentName = BuiltinIntentName | (string & {});

/** Arguments to an extension command, prompt template, or skill. */
export const DynamicIntentInputSchema = Type.Object(
	{
		/** The raw argument text after the command name. */
		arguments: Type.Optional(Type.String()),
		/** How the resulting prompt is delivered while the agent is busy. */
		streamingBehavior: Type.Optional(RpcStreamingBehaviorSchema),
	},
	closed,
);

// ============================================================================
// Intent frames
// ============================================================================

/** An intent frame: `input` is required when the intent's input has required fields. */
function intentFrameSchema(type: TSchema, input: TObject, intentId: TString): TObject {
	return Type.Object(
		{
			type,
			intentId,
			/** The conversation the intent targets; the host chooses when absent. */
			conversation: Type.Optional(LogSessionIdSchema),
			/** The client's position, for branch-fenced intents. */
			expectedOrdinal: Type.Optional(RpcSafeNonNegativeIntegerSchema),
			input: (input.required?.length ?? 0) > 0 ? input : Type.Optional(input),
		},
		closed,
	);
}

/** One frame schema per built-in intent, keyed by intent name. */
export const INTENT_FRAME_SCHEMAS: Readonly<Record<BuiltinIntentName, TObject>> = (() => {
	const inputIntents: readonly string[] = INPUT_INTENT_NAMES;
	const frames = {} as Record<BuiltinIntentName, TObject>;
	for (const name of BUILTIN_INTENT_NAMES) {
		const intentId = inputIntents.includes(name) ? RpcClientMessageIdSchema : RpcConversationIdentifierSchema;
		frames[name] = intentFrameSchema(Type.Literal(name), INTENT_SCHEMAS[name].input, intentId);
	}
	return frames;
})();

/** The frame of an extension command, prompt template, or skill. */
export const DynamicIntentFrameSchema = intentFrameSchema(
	DynamicIntentNameSchema,
	DynamicIntentInputSchema,
	RpcConversationIdentifierSchema,
);

/** Every intent frame a client may send. */
export const IntentFrameSchema: TUnion<TSchema[]> = Type.Union([
	...BUILTIN_INTENT_NAMES.map((name): TSchema => INTENT_FRAME_SCHEMAS[name]),
	DynamicIntentFrameSchema,
]);

export interface IntentFrameEnvelope {
	intentId: string;
	conversation?: string;
	expectedOrdinal?: number;
}

export type IntentFrame =
	| {
			[K in BuiltinIntentName]: IntentFrameEnvelope & { type: K; input?: IntentInput<K> };
	  }[BuiltinIntentName]
	| (IntentFrameEnvelope & { type: string; input?: Static<typeof DynamicIntentInputSchema> });

// ============================================================================
// Descriptors
// ============================================================================

/** Where an intent comes from: built in, or an extension command, prompt template, skill, or package. */
export const IntentSourceSchema = stringEnum(["builtin", "extension", "prompt", "skill", "package"]);

/** One choice for an intent's state or an input completion. */
export const IntentOptionSchema = Type.Object(
	{
		value: Type.String(),
		label: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
	},
	closed,
);
export type IntentOption = Static<typeof IntentOptionSchema>;

/** The current value an intent sets, such as a toggle's state or a picker's selection. */
export const IntentStateValueSchema = Type.Object(
	{
		type: openStringEnum(["boolean", "string", "enum", "integer"]),
		value: Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
		label: Type.Optional(Type.String()),
		options: Type.Optional(Type.Array(IntentOptionSchema)),
	},
	closed,
);
export type IntentStateValue = Static<typeof IntentStateValueSchema>;

/** How a client may present an intent. Clients ignore kinds they do not know. */
export const IntentPresentationSchema = Type.Object(
	{
		kind: openStringEnum(["card", "button", "toggle", "picker", "palette", "detail", "hidden"]),
		group: Type.Optional(Type.String()),
		priority: Type.Optional(Type.Number()),
		icon: Type.Optional(Type.String()),
	},
	closed,
);
export type IntentPresentation = Static<typeof IntentPresentationSchema>;

/** The slash command that invokes an intent in a text client. */
export const IntentSlashAliasSchema = Type.Object(
	{ name: Type.String(), example: Type.Optional(Type.String()) },
	closed,
);
export type IntentSlashAlias = Static<typeof IntentSlashAliasSchema>;

export const IntentCategorySchema = stringEnum([
	"session",
	"model",
	"context",
	"review",
	"mcp",
	"host",
	"extension",
	"prompt",
	"skill",
	"advanced",
]);

/** `conversation` intents act on one conversation; `host` intents on the host. */
export const IntentScopeSchema = stringEnum(["conversation", "host"]);

/**
 * `branch` intents depend on the branch the client saw: the host rejects them
 * `stale` when the branch switched after their `expectedOrdinal`.
 */
export const IntentFenceSchema = stringEnum(["none", "branch"]);

/** While the conversation is busy: `reject` it, `run` it at once, or `queue` its prompt. */
export const IntentWhileBusySchema = stringEnum(["reject", "run", "queue"]);

/**
 * What a client knows about one intent: its definition without the host's
 * implementation, plus its availability and state for the queried
 * conversation. The live `intents` value updates availability and state.
 */
export const IntentDescriptorSchema = Type.Object(
	{
		name: IntentNameSchema,
		label: Type.String(),
		description: Type.Optional(Type.String()),
		category: IntentCategorySchema,
		source: IntentSourceSchema,
		sourceLabel: Type.Optional(Type.String()),
		scope: IntentScopeSchema,
		input: opaque<Record<string, unknown>>("JSON Schema of the intent's input"),
		output: Type.Optional(opaque<Record<string, unknown>>("JSON Schema of the intent's result")),
		fence: IntentFenceSchema,
		/** Whether remote profiles may invoke it at all. */
		remote: stringEnum(["safe", "unsafe"]),
		/** The remote capabilities an invocation needs. */
		requires: RemoteCapabilitiesSchema,
		whileBusy: IntentWhileBusySchema,
		/** Present when a client confirms with the user before sending. */
		confirm: Type.Optional(
			Type.Object({ message: Type.Optional(Type.String()), destructive: Type.Optional(Type.Boolean()) }, closed),
		),
		presentation: Type.Optional(IntentPresentationSchema),
		slash: Type.Optional(IntentSlashAliasSchema),
		/** Input fields the `intent_completions` query completes. */
		completions: Type.Optional(Type.Array(Type.String())),
		enabled: Type.Boolean(),
		reason: Type.Optional(Type.String()),
		state: Type.Optional(IntentStateValueSchema),
	},
	closed,
);
export type IntentDescriptor = Static<typeof IntentDescriptorSchema>;

/** One intent's current availability and state, as the live `intents` value carries it. */
export const IntentAvailabilitySchema = Type.Object(
	{
		name: IntentNameSchema,
		enabled: Type.Boolean(),
		reason: Type.Optional(Type.String()),
		state: Type.Optional(IntentStateValueSchema),
	},
	closed,
);
export type IntentAvailability = Static<typeof IntentAvailabilitySchema>;
