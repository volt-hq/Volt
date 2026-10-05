/**
 * The conversation log: the entry envelope and the core entry types the
 * kernel folds (RFC §4.1–§4.4, §5.1).
 *
 * Every durable fact about a conversation is one entry in one ordered,
 * append-only log. An entry is `{ ordinal, id, parentId, type, timestamp,
 * visibility, payload }`: the ordinal is its only position, `parentId` forms
 * the branch tree, and `visibility` says whether clients may see it (`public`)
 * or only the host (`host`). A message entry also carries the submitting
 * client's `clientMessageId` beside its payload.
 *
 * Hosts define their own product entry types (review state, PR review
 * bindings) with {@link defineLogEntryType}; the kernel folds only the core
 * types here and carries the rest through.
 *
 * The session-store worker loads this module through the light
 * `@hansjm10/volt-protocol/entries` subpath: keep its imports to typebox,
 * `@hansjm10/volt-ai/schemas`, and light protocol modules.
 */

import type { JsonValue } from "@hansjm10/volt-ai";
import {
	AssistantMessageSchema,
	ImageContentSchema,
	TextContentSchema,
	ToolResultMessageSchema,
	UserMessageSchema,
} from "@hansjm10/volt-ai/schemas";
import { type Static, type TLiteral, type TObject, type TProperties, type TSchema, Type } from "typebox";
import { opaque, stringEnum } from "./helpers.ts";
import { RpcPlanningStateSchema } from "./planning.ts";
import {
	RpcClientMessageIdSchema,
	RpcConversationInputImagesSchema,
	RpcStreamingBehaviorSchema,
	RpcThinkingLevelSchema,
} from "./primitives.ts";
import { UiNodeSchema } from "./ui-node.ts";
import { RPC_WIRE_MAX_SAFE_INTEGER } from "./wire-limits.ts";
import {
	WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
	WORK_DATA_MAX_SERIALIZED_BYTES,
	WORK_INPUT_MAX_SERIALIZED_BYTES,
	WORK_OUTPUT_MAX_UTF8_BYTES,
	WorkDeliverySchema,
	WorkKindSchema,
	WorkOutcomeSchema,
	WorkProgressSchema,
	WorkTextSchema,
	WorkTitleSchema,
} from "./work.ts";

const closed = { additionalProperties: false } as const;

// ============================================================================
// Envelope
// ============================================================================

/** Longest entry or log-record identifier, in characters. */
export const LOG_ENTRY_ID_MAX_CHARS = 512;

/** `public` entries are projected to clients; `host` entries never leave the host. */
export const LogEntryVisibilitySchema = stringEnum(["public", "host"]);
export type LogEntryVisibility = Static<typeof LogEntryVisibilitySchema>;

/** Entry and log-record identifiers: non-empty, NUL-free, at most 512 characters. */
export const LogEntryIdSchema = Type.String({
	minLength: 1,
	maxLength: LOG_ENTRY_ID_MAX_CHARS,
	pattern: "^[^\\u0000]+$",
});

/** Contiguous per-log position, starting at 1. The only revision, cursor, and fence. */
export const LogEntryOrdinalSchema = Type.Integer({ minimum: 1, maximum: RPC_WIRE_MAX_SAFE_INTEGER });

/** Canonical ISO-8601 UTC timestamp, exactly as `Date.prototype.toISOString` writes it. */
export const LogEntryTimestampSchema = Type.String({
	pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
	"x-volt-expected": "be a canonical ISO-8601 UTC timestamp",
});

/** Session identifiers: ASCII alphanumerics with inner `.`, `_`, or `-`, at most 512 characters. */
export const LogSessionIdSchema = Type.String({
	maxLength: LOG_ENTRY_ID_MAX_CHARS,
	pattern: "^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$",
});

const nonEmptyString = Type.String({ minLength: 1, pattern: "^[^\\u0000]+$" });
const jsonData = opaque<JsonValue>("lossless JSON data owned by the entry's producer");

const envelopeProperties = {
	ordinal: LogEntryOrdinalSchema,
	id: LogEntryIdSchema,
	parentId: Type.Union([LogEntryIdSchema, Type.Null()]),
	timestamp: LogEntryTimestampSchema,
};

/** The envelope fields every log entry carries around its payload. */
export const LOG_ENTRY_ENVELOPE_KEYS = [
	"ordinal",
	"id",
	"parentId",
	"type",
	"timestamp",
	"visibility",
	"payload",
] as const;

type LogEntryProperties<
	K extends string,
	V extends LogEntryVisibility,
	P extends TObject,
	E extends TProperties,
> = typeof envelopeProperties & { type: TLiteral<K>; visibility: TLiteral<V>; payload: P } & E;

/** One entry type of a log: its discriminant, fixed visibility, payload schema, and envelope schema. */
export interface LogEntryType<
	K extends string = string,
	V extends LogEntryVisibility = LogEntryVisibility,
	P extends TObject = TObject,
	E extends TProperties = TProperties,
> {
	readonly type: K;
	readonly visibility: V;
	/** Closed schema of the type-specific fields. */
	readonly payload: P;
	/** Closed schema of the complete entry: envelope, payload, and any envelope extensions. */
	readonly schema: TObject<LogEntryProperties<K, V, P, E>>;
}

/**
 * Defines one log entry type. Core types are defined below; a host defines
 * its product types the same way and registers them beside the core ones.
 * `envelope` adds fields beside the payload (the message entry's
 * `clientMessageId`).
 *
 * The return type is declared explicitly: TypeScript widens object literals
 * that spread a generic to the bare `TProperties` index signature, which would
 * erase the `Static` entry types. The declared shape is exactly what the
 * runtime value holds.
 */
export function defineLogEntryType<
	K extends string,
	V extends LogEntryVisibility,
	P extends TObject,
	E extends TProperties = Record<never, never>,
>(type: K, visibility: V, payload: P, envelope?: E): LogEntryType<K, V, P, E> {
	const schema = Type.Object(
		{
			ordinal: envelopeProperties.ordinal,
			id: envelopeProperties.id,
			parentId: envelopeProperties.parentId,
			type: Type.Literal(type),
			timestamp: envelopeProperties.timestamp,
			visibility: Type.Literal(visibility),
			payload,
			...envelope,
		},
		closed,
	) as TObject<LogEntryProperties<K, V, P, E>>;
	return { type, visibility, payload, schema };
}

// ============================================================================
// Messages stored in message entries
// ============================================================================

const userContentSchema = Type.Union([Type.String(), Type.Array(Type.Union([TextContentSchema, ImageContentSchema]))]);

/** Output of a user-run shell command (`!`); `excludeFromContext` keeps it out of the model context (`!!`). */
export const BashExecutionMessageSchema = Type.Object(
	{
		role: Type.Literal("bashExecution"),
		command: Type.String(),
		output: Type.String(),
		exitCode: Type.Optional(Type.Number()),
		cancelled: Type.Boolean(),
		truncated: Type.Boolean(),
		fullOutputPath: Type.Optional(Type.String()),
		timestamp: Type.Number(),
		excludeFromContext: Type.Optional(Type.Boolean()),
	},
	closed,
);

/** A host- or extension-injected message that enters the model context as user content. */
export const CustomMessageSchema = Type.Object(
	{
		role: Type.Literal("custom"),
		customType: nonEmptyString,
		content: userContentSchema,
		display: Type.Boolean(),
		details: Type.Optional(jsonData),
		timestamp: Type.Number(),
	},
	closed,
);

/** Every message role a message entry stores. */
export const LogMessageSchema = Type.Union([
	UserMessageSchema,
	AssistantMessageSchema,
	ToolResultMessageSchema,
	BashExecutionMessageSchema,
	CustomMessageSchema,
]);
export type LogMessage = Static<typeof LogMessageSchema>;

// ============================================================================
// Client input
// ============================================================================

export const ClientInputCommandSchema = stringEnum(["prompt", "steer", "follow_up"]);
export type ClientInputCommand = Static<typeof ClientInputCommandSchema>;

/**
 * Client input lifecycle. `accepted` → `started` → `completed` | `failed`;
 * a queued input that is taken back before dispatch (clear queue, abort to
 * editor) is `withdrawn`.
 */
export const ClientInputStateSchema = stringEnum(["accepted", "started", "completed", "failed", "withdrawn"]);
export type ClientInputState = Static<typeof ClientInputStateSchema>;

export const ClientInputQueuedDeliverySchema = stringEnum(["steer", "follow_up"]);
export type ClientInputQueuedDelivery = Static<typeof ClientInputQueuedDeliverySchema>;

/** The exact retryable input, in canonical form: `images` is always present. */
export const ClientInputPayloadSchema = Type.Object(
	{
		message: Type.String(),
		images: RpcConversationInputImagesSchema,
		streamingBehavior: Type.Optional(RpcStreamingBehaviorSchema),
	},
	closed,
);
export type ClientInputPayload = Static<typeof ClientInputPayloadSchema>;

/**
 * The queue intent persisted after preflight, before queue admission is
 * acknowledged. A host input may queue the messages it delivers in `messages`
 * instead of a user message; its `message` and `images` are then empty. A
 * host input with `wake: false` never starts a turn: it rides the next turn
 * that runs anyway (a `message` work notice).
 */
export const ClientInputQueuedPayloadSchema = Type.Object(
	{
		delivery: ClientInputQueuedDeliverySchema,
		message: Type.String(),
		images: RpcConversationInputImagesSchema,
		messages: Type.Optional(Type.Array(LogMessageSchema, { minItems: 1 })),
		wake: Type.Optional(Type.Literal(false)),
	},
	closed,
);
export type ClientInputQueuedPayload = Static<typeof ClientInputQueuedPayloadSchema>;

/**
 * The canonical text a client input's `semanticDigest` hashes: the JSON of
 * `{command, message, images, streamingBehavior?}` with each image as
 * `{type, mimeType, data}`. Every writer hashes this material (hex SHA-256 of
 * its UTF-8 bytes), so the same input digests the same everywhere.
 */
export function clientInputDigestMaterial(command: ClientInputCommand, input: ClientInputPayload): string {
	return JSON.stringify({
		command,
		message: input.message,
		images: input.images.map((image) => ({ type: image.type, mimeType: image.mimeType, data: image.data })),
		...(input.streamingBehavior === undefined ? {} : { streamingBehavior: input.streamingBehavior }),
	});
}

// ============================================================================
// Core entry payloads
// ============================================================================

export const MessageEntryPayloadSchema = Type.Object({ message: LogMessageSchema }, closed);

/** Durable idempotency reservation for one input. Host metadata only. */
export const ClientInputReceiptEntryPayloadSchema = Type.Object(
	{
		clientMessageId: RpcClientMessageIdSchema,
		command: ClientInputCommandSchema,
		/** Hex SHA-256 of {@link clientInputDigestMaterial}. */
		semanticDigest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
		input: ClientInputPayloadSchema,
		/**
		 * `host` on input the host submitted itself (extension messages,
		 * background notices, plan checkpoints); client input has no origin.
		 */
		origin: Type.Optional(Type.Literal("host")),
	},
	closed,
);

export const ClientInputQueuedEntryPayloadSchema = Type.Object(
	{
		receiptId: LogEntryIdSchema,
		clientMessageId: RpcClientMessageIdSchema,
		queuedInput: ClientInputQueuedPayloadSchema,
	},
	closed,
);

export const ClientInputStateEntryPayloadSchema = Type.Object(
	{
		receiptId: LogEntryIdSchema,
		clientMessageId: RpcClientMessageIdSchema,
		state: ClientInputStateSchema,
		/** Present only on `failed`; at most 2,000 Unicode scalars. */
		error: Type.Optional(Type.String()),
	},
	closed,
);

export const ThinkingLevelChangeEntryPayloadSchema = Type.Object({ thinkingLevel: RpcThinkingLevelSchema }, closed);

export const FastModeChangeEntryPayloadSchema = Type.Object({ enabled: Type.Boolean() }, closed);

export const ModelChangeEntryPayloadSchema = Type.Object({ provider: nonEmptyString, modelId: nonEmptyString }, closed);

/** Complete branch-local Plan mode snapshot. */
export const PlanningStateChangeEntryPayloadSchema = Type.Object({ planning: RpcPlanningStateSchema }, closed);

export const CompactionEntryPayloadSchema = Type.Object(
	{
		summary: Type.String(),
		firstKeptEntryId: LogEntryIdSchema,
		tokensBefore: Type.Number({ minimum: 0 }),
		/** Producer-specific JSON (for example structured-compaction markers). */
		details: Type.Optional(jsonData),
		/** True when an extension produced the summary. */
		fromHook: Type.Optional(Type.Boolean()),
	},
	closed,
);

export const BranchSummaryEntryPayloadSchema = Type.Object(
	{
		/** The parent entry id, or `root` for a summary at the top of the tree. */
		fromId: LogEntryIdSchema,
		summary: Type.String(),
		details: Type.Optional(jsonData),
		fromHook: Type.Optional(Type.Boolean()),
	},
	closed,
);

/** Producer state persisted in the log; never part of the model context. */
export const CustomEntryPayloadSchema = Type.Object(
	{ customType: nonEmptyString, data: Type.Optional(jsonData) },
	closed,
);

/** A producer message that enters the model context as user content; `display` controls rendering. */
export const CustomMessageEntryPayloadSchema = Type.Object(
	{
		customType: nonEmptyString,
		content: userContentSchema,
		details: Type.Optional(jsonData),
		display: Type.Boolean(),
	},
	closed,
);

/** A user-defined bookmark on a conversation entry; no `label` clears it. */
export const LabelEntryPayloadSchema = Type.Object(
	{ targetId: LogEntryIdSchema, label: Type.Optional(Type.String()) },
	closed,
);

/** Conversation metadata such as the display name. */
export const SessionInfoEntryPayloadSchema = Type.Object({ name: Type.Optional(Type.String()) }, closed);

/** The active-branch pointer. Navigation is itself an entry. */
export const LeafEntryPayloadSchema = Type.Object({ targetId: Type.Union([LogEntryIdSchema, Type.Null()]) }, closed);

/** A durable reference to another session's log. */
export const SessionReferenceSchema = Type.Object(
	{
		sessionDirectory: nonEmptyString,
		storeId: LogEntryIdSchema,
		sessionId: LogSessionIdSchema,
		sessionGeneration: LogEntryIdSchema,
	},
	closed,
);

/**
 * First entry of a log created by fork, clone, or import: the source log and
 * the entry the copied branch path ends at, or `null` when the copied branch
 * is empty (a fork before the first message). The copied path follows it, so
 * a log stays self-contained.
 */
export const ForkedFromEntryPayloadSchema = Type.Object(
	{ sessionId: LogSessionIdSchema, entryId: Type.Union([LogEntryIdSchema, Type.Null()]) },
	closed,
);

// ============================================================================
// Work (RFC §7; vocabulary and bounds in work.ts)
// ============================================================================

/** The conversation work runs in: a subagent's child log. `ref` locates it when the child is persisted. */
export const WorkChildSchema = Type.Object(
	{ conversation: LogSessionIdSchema, ref: Type.Optional(SessionReferenceSchema) },
	closed,
);

/** A conversation finished work seeded, such as a review's discussion. */
export const WorkResultChildSchema = Type.Object({ conversation: LogSessionIdSchema }, closed);

/** What finished work produced. Clients see the metadata; output and data are fetched by work id. */
export const WorkResultSchema = Type.Object(
	{
		summary: Type.Optional(WorkTextSchema),
		/** The output's tail; `truncated` when older output was dropped to fit. */
		output: Type.Optional(
			Type.Object(
				{
					text: Type.String({ "x-volt-max-utf8-bytes": WORK_OUTPUT_MAX_UTF8_BYTES }),
					truncated: Type.Boolean(),
				},
				closed,
			),
		),
		child: Type.Optional(WorkResultChildSchema),
		/** Kind-specific result data. */
		data: Type.Optional(
			Type.Unsafe<JsonValue>(
				Type.Unknown({
					"x-volt-opaque": "kind-specific JSON result data",
					"x-volt-max-serialized-bytes": WORK_DATA_MAX_SERIALIZED_BYTES,
				}),
			),
		),
	},
	closed,
);

/**
 * Work started. The kind's delivery policy and resumability are copied in, so
 * reconciliation and delivery are functions of the log alone.
 */
export const WorkStartedEntryPayloadSchema = Type.Object(
	{
		workId: LogEntryIdSchema,
		kind: WorkKindSchema,
		title: WorkTitleSchema,
		/** The work that started this one: earlier in this log, or for a subagent possibly in its parent's log. */
		parentWorkId: Type.Optional(LogEntryIdSchema),
		/** The kind's input. */
		input: Type.Unsafe<JsonValue>(
			Type.Unknown({
				"x-volt-opaque": "kind-specific JSON input",
				"x-volt-max-serialized-bytes": WORK_INPUT_MAX_SERIALIZED_BYTES,
			}),
		),
		cancellable: Type.Boolean(),
		delivery: WorkDeliverySchema,
		/** Open work of a resumable kind is suspended after a restart instead of interrupted. */
		resume: Type.Boolean(),
		state: stringEnum(["awaiting_approval", "running"]),
		/** The tool call that started the work. */
		toolCallId: Type.Optional(LogEntryIdSchema),
		child: Type.Optional(WorkChildSchema),
	},
	closed,
);

/** A coarse checkpoint: a state transition or a kind phase. Fine-grained progress uses the live lane. */
export const WorkCheckpointEntryPayloadSchema = Type.Object(
	{
		workId: LogEntryIdSchema,
		state: Type.Optional(stringEnum(["running", "cancelling"])),
		progress: Type.Optional(WorkProgressSchema),
		detail: Type.Optional(UiNodeSchema),
	},
	{ ...closed, "x-volt-max-serialized-bytes": WORK_CHECKPOINT_MAX_SERIALIZED_BYTES },
);

export const WorkFinishedEntryPayloadSchema = Type.Object(
	{
		workId: LogEntryIdSchema,
		outcome: WorkOutcomeSchema,
		result: Type.Optional(WorkResultSchema),
		error: Type.Optional(WorkTextSchema),
	},
	closed,
);

/** The details of a `work_notice` custom message: metadata only; the output is fetched by work id. */
export const WorkNoticeDetailsSchema = Type.Object(
	{
		workId: LogEntryIdSchema,
		kind: WorkKindSchema,
		title: WorkTitleSchema,
		outcome: stringEnum(["completed", "failed"]),
		summary: Type.Optional(WorkTextSchema),
		error: Type.Optional(WorkTextSchema),
		child: Type.Optional(WorkResultChildSchema),
		/** Present when the work has output. */
		output: Type.Optional(Type.Object({ truncated: Type.Boolean() }, closed)),
	},
	closed,
);

// ============================================================================
// Core entry types
// ============================================================================

/**
 * The core entry types, keyed by `type`. Stored type strings are part of the
 * log format; a host never reuses one for a product type.
 */
export const CORE_LOG_ENTRY_TYPES = {
	message: defineLogEntryType("message", "public", MessageEntryPayloadSchema, {
		/** Stable submitting-client identity of a client-submitted user message. */
		clientMessageId: Type.Optional(RpcClientMessageIdSchema),
	}),
	client_input_receipt: defineLogEntryType("client_input_receipt", "host", ClientInputReceiptEntryPayloadSchema),
	client_input_queued: defineLogEntryType("client_input_queued", "host", ClientInputQueuedEntryPayloadSchema),
	client_input_state: defineLogEntryType("client_input_state", "host", ClientInputStateEntryPayloadSchema),
	thinking_level_change: defineLogEntryType("thinking_level_change", "public", ThinkingLevelChangeEntryPayloadSchema),
	fast_mode_change: defineLogEntryType("fast_mode_change", "public", FastModeChangeEntryPayloadSchema),
	model_change: defineLogEntryType("model_change", "public", ModelChangeEntryPayloadSchema),
	planning_state_change: defineLogEntryType("planning_state_change", "public", PlanningStateChangeEntryPayloadSchema),
	compaction: defineLogEntryType("compaction", "public", CompactionEntryPayloadSchema),
	branch_summary: defineLogEntryType("branch_summary", "public", BranchSummaryEntryPayloadSchema),
	custom: defineLogEntryType("custom", "public", CustomEntryPayloadSchema),
	custom_message: defineLogEntryType("custom_message", "public", CustomMessageEntryPayloadSchema),
	label: defineLogEntryType("label", "public", LabelEntryPayloadSchema),
	session_info: defineLogEntryType("session_info", "public", SessionInfoEntryPayloadSchema),
	leaf: defineLogEntryType("leaf", "host", LeafEntryPayloadSchema),
	forked_from: defineLogEntryType("forked_from", "host", ForkedFromEntryPayloadSchema),
	work_started: defineLogEntryType("work_started", "host", WorkStartedEntryPayloadSchema),
	work_checkpoint: defineLogEntryType("work_checkpoint", "host", WorkCheckpointEntryPayloadSchema),
	work_finished: defineLogEntryType("work_finished", "host", WorkFinishedEntryPayloadSchema),
} as const;

export type CoreLogEntryTypeName = keyof typeof CORE_LOG_ENTRY_TYPES;

/** Any core log entry. */
export const LogEntrySchema = Type.Union(
	Object.values(CORE_LOG_ENTRY_TYPES).map((definition): TSchema => definition.schema),
);

export type LogEntry = {
	[K in CoreLogEntryTypeName]: Static<(typeof CORE_LOG_ENTRY_TYPES)[K]["schema"]>;
}[CoreLogEntryTypeName];

export type MessageEntryPayload = Static<typeof MessageEntryPayloadSchema>;
export type ClientInputReceiptEntryPayload = Static<typeof ClientInputReceiptEntryPayloadSchema>;
export type ClientInputQueuedEntryPayload = Static<typeof ClientInputQueuedEntryPayloadSchema>;
export type ClientInputStateEntryPayload = Static<typeof ClientInputStateEntryPayloadSchema>;
export type ThinkingLevelChangeEntryPayload = Static<typeof ThinkingLevelChangeEntryPayloadSchema>;
export type FastModeChangeEntryPayload = Static<typeof FastModeChangeEntryPayloadSchema>;
export type ModelChangeEntryPayload = Static<typeof ModelChangeEntryPayloadSchema>;
export type PlanningStateChangeEntryPayload = Static<typeof PlanningStateChangeEntryPayloadSchema>;
export type CompactionEntryPayload = Static<typeof CompactionEntryPayloadSchema>;
export type BranchSummaryEntryPayload = Static<typeof BranchSummaryEntryPayloadSchema>;
export type CustomEntryPayload = Static<typeof CustomEntryPayloadSchema>;
export type CustomMessageEntryPayload = Static<typeof CustomMessageEntryPayloadSchema>;
export type LabelEntryPayload = Static<typeof LabelEntryPayloadSchema>;
export type SessionInfoEntryPayload = Static<typeof SessionInfoEntryPayloadSchema>;
export type LeafEntryPayload = Static<typeof LeafEntryPayloadSchema>;
export type ForkedFromEntryPayload = Static<typeof ForkedFromEntryPayloadSchema>;
export type WorkChild = Static<typeof WorkChildSchema>;
export type WorkResultChild = Static<typeof WorkResultChildSchema>;
export type WorkResult = Static<typeof WorkResultSchema>;
export type WorkStartedEntryPayload = Static<typeof WorkStartedEntryPayloadSchema>;
export type WorkCheckpointEntryPayload = Static<typeof WorkCheckpointEntryPayloadSchema>;
export type WorkFinishedEntryPayload = Static<typeof WorkFinishedEntryPayloadSchema>;
export type WorkNoticeDetails = Static<typeof WorkNoticeDetailsSchema>;
