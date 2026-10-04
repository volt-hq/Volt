/**
 * The entry types a coding-agent session log stores: the protocol's core
 * types plus the product types coding-agent registers beside them. Product
 * types are host-only records the conversation kernel carries through without
 * folding.
 *
 * Loaded by the session-store worker thread through session-entry-codec.ts,
 * so it imports protocol only through its light subpaths.
 */

import { CORE_LOG_ENTRY_TYPES, defineLogEntryType } from "@hansjm10/volt-protocol/entries";
import { RpcGitContextSchema } from "@hansjm10/volt-protocol/git-context";
import { Type } from "typebox";
import { PrReviewPlacementSchema } from "./pr-review-placement.ts";

/** Host-owned product records: the first Git observation and the PR checkout a review session is bound to. */
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
	...PRODUCT_SESSION_ENTRY_TYPES,
} as const;
