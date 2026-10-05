/**
 * The entry types a coding-agent session log stores: the protocol's core
 * types plus the product types coding-agent registers beside them. Product
 * types are host-only records the conversation kernel carries through without
 * folding.
 *
 * Loaded by the session-store worker thread through session-entry-codec.ts,
 * so it imports protocol only through its light subpaths.
 */

import type { JsonValue } from "@hansjm10/volt-ai";
import {
	CORE_LOG_ENTRY_TYPES,
	defineLogEntryType,
	LogEntryIdSchema,
	LogSessionIdSchema,
} from "@hansjm10/volt-protocol/entries";
import { RpcGitContextSchema } from "@hansjm10/volt-protocol/git-context";
import { Type } from "typebox";
import { PrReviewPlacementSchema } from "./pr-review-placement.ts";

const closed = { additionalProperties: false } as const;

/** Most canonical JSON bytes a finding discussion's context snapshot holds. */
export const REVIEW_DISCUSSION_CONTEXT_MAX_BYTES = 65_536;

/** One exact session incarnation of this store: review records link sessions by id and generation. */
const ReviewSessionIdentitySchema = Type.Object(
	{ sessionId: LogSessionIdSchema, sessionGeneration: LogEntryIdSchema },
	closed,
);

/** A finding discussion's immutable context: the finding, its review target, and the child's model settings. */
const ReviewDiscussionContextSchema = Type.Unsafe<JsonValue>(
	Type.Unknown({ "x-volt-max-serialized-bytes": REVIEW_DISCUSSION_CONTEXT_MAX_BYTES }),
);

/**
 * Review state as host records (RFC §14 Q7). A review run is anchored by the
 * `work_started` of its review work in the conversation that ran it, its
 * source; each record below names runs, discussions, and sessions by their
 * exact identities, and only the host writes them. The store keeps derived
 * indexes of them for cross-session lookups.
 */
const REVIEW_SESSION_ENTRY_TYPES = {
	/** In the source: the run's General discussion moved to `general`. The latest one is current. */
	review_general: defineLogEntryType(
		"review_general",
		"host",
		Type.Object({ runId: LogEntryIdSchema, general: ReviewSessionIdentitySchema }, closed),
	),
	/** In a handoff target: this conversation carries run `runId` of `source`, the run's source. */
	review_alias: defineLogEntryType(
		"review_alias",
		"host",
		Type.Object({ runId: LogEntryIdSchema, source: ReviewSessionIdentitySchema }, closed),
	),
	/** In the source: a finding's discussion and its first child conversation. */
	review_discussion: defineLogEntryType(
		"review_discussion",
		"host",
		Type.Object(
			{
				discussionId: LogEntryIdSchema,
				runId: LogEntryIdSchema,
				findingId: LogEntryIdSchema,
				contextSnapshot: ReviewDiscussionContextSchema,
				child: ReviewSessionIdentitySchema,
				requestId: LogEntryIdSchema,
				kickoffClientMessageId: LogEntryIdSchema,
			},
			closed,
		),
	),
	/** In the source: a discussion reset to a new child conversation, which becomes its current child. */
	review_discussion_reset: defineLogEntryType(
		"review_discussion_reset",
		"host",
		Type.Object(
			{
				discussionId: LogEntryIdSchema,
				child: ReviewSessionIdentitySchema,
				requestId: LogEntryIdSchema,
				kickoffClientMessageId: LogEntryIdSchema,
			},
			closed,
		),
	),
	/** A discussion child's first entry: the discussion, finding, and source it belongs to, and its context. */
	review_discussion_link: defineLogEntryType(
		"review_discussion_link",
		"host",
		Type.Object(
			{
				discussionId: LogEntryIdSchema,
				runId: LogEntryIdSchema,
				findingId: LogEntryIdSchema,
				source: ReviewSessionIdentitySchema,
				contextSnapshot: ReviewDiscussionContextSchema,
			},
			closed,
		),
	),
} as const;

/** The review record types, for code that handles them together. */
export const REVIEW_SESSION_ENTRY_TYPE_NAMES: ReadonlySet<string> = new Set(Object.keys(REVIEW_SESSION_ENTRY_TYPES));

/**
 * Host-owned product records: the first Git observation, the PR checkout a
 * review session is bound to, and review state.
 */
export const PRODUCT_SESSION_ENTRY_TYPES = {
	session_start_git_context: defineLogEntryType(
		"session_start_git_context",
		"host",
		Type.Object({ gitContext: Type.Union([RpcGitContextSchema, Type.Null()]) }, { additionalProperties: false }),
	),
	pr_review_binding: defineLogEntryType(
		"pr_review_binding",
		"host",
		Type.Object({ placement: PrReviewPlacementSchema }, { additionalProperties: false }),
	),
	...REVIEW_SESSION_ENTRY_TYPES,
} as const;

/** Every entry type a session log stores, keyed by `type`. */
export const SESSION_ENTRY_TYPES = {
	message: CORE_LOG_ENTRY_TYPES.message,
	client_input_receipt: CORE_LOG_ENTRY_TYPES.client_input_receipt,
	client_input_queued: CORE_LOG_ENTRY_TYPES.client_input_queued,
	client_input_state: CORE_LOG_ENTRY_TYPES.client_input_state,
	thinking_level_change: CORE_LOG_ENTRY_TYPES.thinking_level_change,
	fast_mode_change: CORE_LOG_ENTRY_TYPES.fast_mode_change,
	model_change: CORE_LOG_ENTRY_TYPES.model_change,
	planning_state_change: CORE_LOG_ENTRY_TYPES.planning_state_change,
	compaction: CORE_LOG_ENTRY_TYPES.compaction,
	branch_summary: CORE_LOG_ENTRY_TYPES.branch_summary,
	custom: CORE_LOG_ENTRY_TYPES.custom,
	custom_message: CORE_LOG_ENTRY_TYPES.custom_message,
	label: CORE_LOG_ENTRY_TYPES.label,
	session_info: CORE_LOG_ENTRY_TYPES.session_info,
	leaf: CORE_LOG_ENTRY_TYPES.leaf,
	subagent_spawn: CORE_LOG_ENTRY_TYPES.subagent_spawn,
	forked_from: CORE_LOG_ENTRY_TYPES.forked_from,
	work_started: CORE_LOG_ENTRY_TYPES.work_started,
	work_checkpoint: CORE_LOG_ENTRY_TYPES.work_checkpoint,
	work_finished: CORE_LOG_ENTRY_TYPES.work_finished,
	...PRODUCT_SESSION_ENTRY_TYPES,
} as const;
