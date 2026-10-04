/**
 * Projected entries: the log entries a subscription streams (RFC §6.1).
 *
 * A profile projects each committed core entry to at most one
 * {@link ProjectedEntry}: `{ordinal, id, parentId, type, timestamp, payload?,
 * view?}`. The ordinal is the entry's log ordinal; entries a profile hides
 * leave gaps. `parentId` names the nearest ancestor the profile projects, so a
 * client's tree never points at a hidden entry. Product entry types are host
 * records and are never projected; an entry's visibility follows from its core
 * type.
 *
 * `payload` is the entry's payload as the profile redacts it; the local
 * profile sends it whole. `view` is the transcript item of a message-like
 * entry (messages, custom messages, compactions, branch summaries); the remote
 * profile sends message-like entries as `view` only.
 */

import { StopReasonSchema } from "@hansjm10/volt-ai/schemas";
import {
	type Static,
	type TLiteral,
	type TNull,
	type TObject,
	type TOptional,
	type TSchema,
	type TUnion,
	Type,
} from "typebox";
import {
	CORE_LOG_ENTRY_TYPES,
	type CoreLogEntryTypeName,
	LogEntryIdSchema,
	LogEntryOrdinalSchema,
	LogEntryTimestampSchema,
	LogMessageSchema,
} from "./entries.ts";
import { stringEnum } from "./helpers.ts";
import { RpcClientMessageIdSchema } from "./primitives.ts";

const closed = { additionalProperties: false } as const;

// ============================================================================
// Transcript item
// ============================================================================

/** One text or thinking block of an assistant transcript item, bounded by the profile. */
export const TranscriptAssistantPartSchema = Type.Union([
	Type.Object({ type: Type.Literal("text"), text: Type.String(), truncated: Type.Boolean() }, closed),
	Type.Object(
		{
			type: Type.Literal("thinking"),
			text: Type.String(),
			truncated: Type.Optional(Type.Boolean()),
			redacted: Type.Optional(Type.Boolean()),
		},
		closed,
	),
]);

/**
 * The transcript view of a message-like entry: one shape for every profile.
 * Text is bounded per entry by the profile; `truncated` says the full text is
 * available through the `content` query. Tool items carry the tool call's
 * arguments from the fold and, on the local profile, diff and patch previews.
 */
export const TranscriptItemSchema = Type.Object(
	{
		role: stringEnum(["user", "assistant", "system", "tool"]),
		text: Type.String(),
		truncated: Type.Boolean(),
		/** Stable submitting-client identity of a client-submitted user message. */
		clientMessageId: Type.Optional(RpcClientMessageIdSchema),
		/** Image blocks on the message; fetched with the `content` query. */
		imageCount: Type.Optional(Type.Integer({ minimum: 0 })),
		toolCallId: Type.Optional(Type.String()),
		toolName: Type.Optional(Type.String()),
		status: Type.Optional(stringEnum(["completed", "failed"])),
		summary: Type.Optional(Type.String()),
		path: Type.Optional(Type.String()),
		args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		output: Type.Optional(Type.String()),
		outputTruncated: Type.Optional(Type.Boolean()),
		parts: Type.Optional(Type.Array(TranscriptAssistantPartSchema)),
		stopReason: Type.Optional(StopReasonSchema),
		diffPreview: Type.Optional(Type.String()),
		patchPreview: Type.Optional(Type.String()),
	},
	closed,
);
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

// ============================================================================
// Projected payloads and entries
// ============================================================================

/** A projected message entry carries the submitting client's identity inside its payload. */
export const ProjectedMessagePayloadSchema = Type.Object(
	{ message: LogMessageSchema, clientMessageId: Type.Optional(RpcClientMessageIdSchema) },
	closed,
);

const parentIdSchema = Type.Union([LogEntryIdSchema, Type.Null()]);

type ProjectedEnvelope<K extends string, P extends TSchema> = {
	ordinal: typeof LogEntryOrdinalSchema;
	id: typeof LogEntryIdSchema;
	parentId: TUnion<[typeof LogEntryIdSchema, TNull]>;
	type: TLiteral<K>;
	timestamp: typeof LogEntryTimestampSchema;
	payload: TOptional<P>;
};

type ProjectedViewEnvelope<K extends string, P extends TSchema> = ProjectedEnvelope<K, P> & {
	view: TOptional<typeof TranscriptItemSchema>;
};

/** One projected entry type: its payload schema and closed entry schema. */
export interface ProjectedEntryType<
	K extends string = string,
	P extends TSchema = TSchema,
	S extends TObject = TObject,
> {
	readonly type: K;
	readonly payload: P;
	readonly schema: S;
}

function envelope<K extends string, P extends TSchema>(type: K, payload: P) {
	return {
		ordinal: LogEntryOrdinalSchema,
		id: LogEntryIdSchema,
		parentId: parentIdSchema,
		type: Type.Literal(type),
		timestamp: LogEntryTimestampSchema,
		payload: Type.Optional(payload),
	};
}

/**
 * A projected entry type without a transcript view. The return type is
 * declared explicitly so `Static` keeps the per-type payload (see
 * `defineLogEntryType`).
 */
function projectedEntryType<K extends string, P extends TSchema>(
	type: K,
	payload: P,
): ProjectedEntryType<K, P, TObject<ProjectedEnvelope<K, P>>> {
	const schema = Type.Object(envelope(type, payload), closed) as TObject<ProjectedEnvelope<K, P>>;
	return { type, payload, schema };
}

/** A message-like projected entry type: it may carry a transcript view. */
function projectedViewEntryType<K extends string, P extends TSchema>(
	type: K,
	payload: P,
): ProjectedEntryType<K, P, TObject<ProjectedViewEnvelope<K, P>>> {
	const schema = Type.Object(
		{ ...envelope(type, payload), view: Type.Optional(TranscriptItemSchema) },
		closed,
	) as TObject<ProjectedViewEnvelope<K, P>>;
	return { type, payload, schema };
}

const core = CORE_LOG_ENTRY_TYPES;

/** Every projected entry type, keyed by core entry type. */
export const PROJECTED_ENTRY_TYPES = {
	message: projectedViewEntryType("message", ProjectedMessagePayloadSchema),
	client_input_receipt: projectedEntryType("client_input_receipt", core.client_input_receipt.payload),
	client_input_queued: projectedEntryType("client_input_queued", core.client_input_queued.payload),
	client_input_state: projectedEntryType("client_input_state", core.client_input_state.payload),
	thinking_level_change: projectedEntryType("thinking_level_change", core.thinking_level_change.payload),
	fast_mode_change: projectedEntryType("fast_mode_change", core.fast_mode_change.payload),
	model_change: projectedEntryType("model_change", core.model_change.payload),
	planning_state_change: projectedEntryType("planning_state_change", core.planning_state_change.payload),
	compaction: projectedViewEntryType("compaction", core.compaction.payload),
	branch_summary: projectedViewEntryType("branch_summary", core.branch_summary.payload),
	custom: projectedEntryType("custom", core.custom.payload),
	custom_message: projectedViewEntryType("custom_message", core.custom_message.payload),
	label: projectedEntryType("label", core.label.payload),
	session_info: projectedEntryType("session_info", core.session_info.payload),
	leaf: projectedEntryType("leaf", core.leaf.payload),
	subagent_spawn: projectedEntryType("subagent_spawn", core.subagent_spawn.payload),
	forked_from: projectedEntryType("forked_from", core.forked_from.payload),
	work_started: projectedEntryType("work_started", core.work_started.payload),
	work_checkpoint: projectedEntryType("work_checkpoint", core.work_checkpoint.payload),
	work_finished: projectedEntryType("work_finished", core.work_finished.payload),
} as const satisfies { [K in CoreLogEntryTypeName]: ProjectedEntryType<K> };

export type ProjectedEntryTypeName = keyof typeof PROJECTED_ENTRY_TYPES;

export type ProjectedEntry = {
	[K in ProjectedEntryTypeName]: Static<(typeof PROJECTED_ENTRY_TYPES)[K]["schema"]>;
}[ProjectedEntryTypeName];

/** Any projected entry. */
export const ProjectedEntrySchema = Type.Unsafe<ProjectedEntry>(
	Type.Union(Object.values(PROJECTED_ENTRY_TYPES).map((definition): TSchema => definition.schema)),
);

/** Whether entries of a type are conversation nodes (`public`) that move the leaf when appended. */
export function isPublicProjectedEntryType(type: ProjectedEntryTypeName): boolean {
	return CORE_LOG_ENTRY_TYPES[type].visibility === "public";
}
