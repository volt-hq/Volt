/**
 * Protocol frames (RFC §6.1, §6.2): the closed set of JSON lines a client and
 * a host exchange, the same over stdio, loopback, the daemon relay, and Iroh.
 *
 * A connection opens with `hello` and `welcome`. A client subscribes to a
 * conversation from a position (`after`: the newest ordinal it holds) or from
 * a snapshot, and receives `snapshot`, `entry`, `head`, and `live` frames on
 * that subscription until `ended`. Its position is the newest ordinal it saw;
 * `head` advances it over entries the profile hides. Resuming with
 * `subscribe{after: P}` sends the visible entries after P, a `head` when
 * needed, then `live{reset: true}`. A profile with bounded replay may answer a
 * long gap with a snapshot at the current ordinal instead.
 *
 * Intents answer `accepted` or `rejected`; queries answer `result` or
 * `query_error`. `changed` tells clients to refetch a catalog. `fatal` ends the
 * connection.
 */

import { type Static, type TSchema, Type } from "typebox";
import { ClientSnapshotSchema } from "./client-fold.ts";
import { LogEntryOrdinalSchema, LogSessionIdSchema } from "./entries.ts";
import { opaque, stringEnum } from "./helpers.ts";
import {
	DYNAMIC_INTENT_PATTERN,
	INTENT_NAME_MAX_CHARS,
	INTENT_OUTCOME_WINDOW,
	type IntentFrame,
	IntentFrameSchema,
} from "./intents.ts";
import {
	EXTENSION_STATUS_MAX_SERIALIZED_BYTES,
	EXTENSION_TITLE_MAX_CHARS,
	HostRequestKindSchema,
	HostResponseSchema,
	LIVE_EXTENSION_NAME_MAX_CHARS,
	LIVE_KEY_ID_MAX_CHARS,
	LiveItemSchema,
} from "./live.ts";
import { RpcConversationIdentifierSchema, RpcSafeNonNegativeIntegerSchema } from "./primitives.ts";
import { ProjectedEntrySchema } from "./projected.ts";
import {
	CONTENT_TEXT_MAX_SCALARS,
	EDITOR_COMPLETION_TEXT_MAX_CHARS,
	EDITOR_COMPLETIONS_MAX_ITEMS,
	HISTORY_PAGE_MAX_ENTRIES,
	type QueryFrame,
	QueryFrameSchema,
} from "./queries.ts";
import { RemoteCapabilitySchema } from "./remote-access.ts";
import { RPC_RETRY_AFTER_MS_MAX } from "./wire-limits.ts";

const closed = { additionalProperties: false } as const;

/** The protocol version `hello` and `welcome` carry. */
export const PROTOCOL_VERSION = 1;

/** Connection, subscription, intent, query, and host-request identifiers. */
const id = RpcConversationIdentifierSchema;
/** A client position: the newest ordinal covered, 0 before the first entry. */
const position = RpcSafeNonNegativeIntegerSchema;

/** `local` serves full fidelity in-process and over stdio; `remote` serves paired devices. */
export const ProfileNameSchema = stringEnum(["local", "remote"]);

const peerSchema = Type.Object({ name: Type.String({ minLength: 1 }), version: Type.String() }, closed);

// ============================================================================
// Outcomes
// ============================================================================

/**
 * Why the host rejected an intent.
 * - `invalid_input`: the frame or input failed its schema or a host check.
 * - `unknown_intent`: no such intent, or not on this host.
 * - `not_allowed`: the profile may not invoke it; `requiredCapability` names a missing grant.
 * - `unavailable`: the intent is disabled in this state.
 * - `stale`: the branch switched after `expectedOrdinal`; `ordinal` is the switch.
 * - `busy`: the conversation is busy and the intent does not queue.
 * - `conflict`: the intent id was used for different input.
 * - `locked`: another host holds the conversation.
 * - `ended`: the conversation ended.
 * - `read_only`: the subscription observes only.
 * - `failed`: the intent ran and failed.
 * - `host_shutdown`: the host is shutting down.
 */
export const RejectionCodeSchema = stringEnum([
	"invalid_input",
	"unknown_intent",
	"not_allowed",
	"unavailable",
	"stale",
	"busy",
	"conflict",
	"locked",
	"ended",
	"read_only",
	"failed",
	"host_shutdown",
]);
export type RejectionCode = Static<typeof RejectionCodeSchema>;

const outcomeHints = {
	requiredCapability: Type.Optional(RemoteCapabilitySchema),
	/** A backoff hint before retrying. */
	retryAfterMs: Type.Optional(Type.Integer({ minimum: 0, maximum: RPC_RETRY_AFTER_MS_MAX })),
};

export const RejectionReasonSchema = Type.Object(
	{ code: RejectionCodeSchema, message: Type.String(), ordinal: Type.Optional(position), ...outcomeHints },
	closed,
);
export type RejectionReason = Static<typeof RejectionReasonSchema>;

/** Why a query failed; the codes mean what the matching rejection codes mean. */
export const QueryErrorCodeSchema = stringEnum([
	"invalid_input",
	"unknown_query",
	"not_allowed",
	"unavailable",
	"failed",
	"host_shutdown",
]);
export type QueryErrorCode = Static<typeof QueryErrorCodeSchema>;

export const QueryErrorReasonSchema = Type.Object(
	{ code: QueryErrorCodeSchema, message: Type.String(), ...outcomeHints },
	closed,
);

/**
 * The catalogs a `changed` frame invalidates. `host` is the host's own status:
 * the `host_status` and `web_search_status` queries.
 */
export const CatalogNameSchema = stringEnum(["models", "intents", "sessions", "mcp", "extensions", "settings", "host"]);

/**
 * Why the host ended a connection.
 * - `invalid_frame`: a frame failed its schema.
 * - `frame_too_large`: a frame exceeded the line limit.
 * - `protocol_mismatch`: `hello` named another protocol version.
 * - `revoked`: the client's grant was revoked.
 * - `workspace_unregistered`: the connection's workspace was unregistered.
 * - `host_shutdown`: the host is shutting down.
 */
export const FatalCodeSchema = stringEnum([
	"invalid_frame",
	"frame_too_large",
	"protocol_mismatch",
	"revoked",
	"workspace_unregistered",
	"host_shutdown",
]);
export type FatalCode = Static<typeof FatalCodeSchema>;

// ============================================================================
// Client frames
// ============================================================================

export const HelloFrameSchema = Type.Object(
	{
		type: Type.Literal("hello"),
		protocol: Type.Literal(PROTOCOL_VERSION),
		client: peerSchema,
		/** The host request kinds this client can answer; it receives only those. */
		accepts: Type.Object({ hostRequests: Type.Array(HostRequestKindSchema, { uniqueItems: true }) }, closed),
	},
	closed,
);

export const SubscribeFrameSchema = Type.Object(
	{
		type: Type.Literal("subscribe"),
		subscriptionId: id,
		conversation: LogSessionIdSchema,
		/** The client's position to resume after, or `snapshot` for a fold snapshot first. */
		after: Type.Union([position, Type.Literal("snapshot")]),
		/** Whether to receive the live lane; default true. */
		live: Type.Optional(Type.Boolean()),
	},
	closed,
);

export const UnsubscribeFrameSchema = Type.Object({ type: Type.Literal("unsubscribe"), subscriptionId: id }, closed);

export const HostResponseFrameSchema = Type.Object(
	{ type: Type.Literal("host_response"), requestId: id, response: HostResponseSchema },
	closed,
);

/** The fixed client frames; intent and query frames are keyed by intent and query name. */
export const CLIENT_FRAME_SCHEMAS = {
	hello: HelloFrameSchema,
	subscribe: SubscribeFrameSchema,
	unsubscribe: UnsubscribeFrameSchema,
	host_response: HostResponseFrameSchema,
} as const;

// ============================================================================
// Host frames
// ============================================================================

export const WelcomeFrameSchema = Type.Object(
	{
		type: Type.Literal("welcome"),
		protocol: Type.Literal(PROTOCOL_VERSION),
		connectionId: id,
		profile: ProfileNameSchema,
		server: peerSchema,
		/** The conversation the host attached the connection to, when it has one: subscribe to it. */
		conversation: Type.Optional(LogSessionIdSchema),
	},
	closed,
);

/** The client fold at `ordinal`; entries after it follow. */
export const SnapshotFrameSchema = Type.Object(
	{
		type: Type.Literal("snapshot"),
		subscriptionId: id,
		conversation: LogSessionIdSchema,
		ordinal: position,
		state: ClientSnapshotSchema,
	},
	closed,
);

export const EntryFrameSchema = Type.Object(
	{ type: Type.Literal("entry"), subscriptionId: id, entry: ProjectedEntrySchema },
	closed,
);

/** The log advanced to `ordinal` over entries the profile hides. */
export const HeadFrameSchema = Type.Object(
	{ type: Type.Literal("head"), subscriptionId: id, ordinal: LogEntryOrdinalSchema },
	closed,
);

export const LiveFrameSchema = Type.Object(
	{
		type: Type.Literal("live"),
		subscriptionId: id,
		/** The ordinal the frame's streaming items build on. */
		basedOn: position,
		/** 1 for the first frame after a reset, then consecutive. */
		seq: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		/** Replace the client's live state with this frame's items. */
		reset: Type.Optional(Type.Boolean()),
		items: Type.Array(LiveItemSchema),
	},
	closed,
);

/**
 * A subscription ended. `moved`: an intent moved the client to `target`;
 * subscribe there. `lost`: the conversation stopped (its log was lost).
 */
export const EndedFrameSchema = Type.Union([
	Type.Object(
		{ type: Type.Literal("ended"), subscriptionId: id, reason: Type.Literal("moved"), target: LogSessionIdSchema },
		closed,
	),
	Type.Object(
		{
			type: Type.Literal("ended"),
			subscriptionId: id,
			reason: stringEnum(["unsubscribed", "closed", "lost", "shutdown"]),
		},
		closed,
	),
]);

export const AcceptedFrameSchema = Type.Object(
	{
		type: Type.Literal("accepted"),
		intentId: id,
		/** The ordinals of the entries the intent committed, possibly none. */
		ordinals: Type.Array(LogEntryOrdinalSchema),
		/** The conversation a structural intent moved the client to. */
		conversation: Type.Optional(LogSessionIdSchema),
		result: Type.Optional(opaque<unknown>("the accepted intent's IntentOutput")),
	},
	closed,
);

export const RejectedFrameSchema = Type.Object(
	{ type: Type.Literal("rejected"), intentId: id, reason: RejectionReasonSchema },
	closed,
);

export const ResultFrameSchema = Type.Object(
	{ type: Type.Literal("result"), queryId: id, data: opaque<unknown>("the answered query's QueryResult") },
	closed,
);

export const QueryErrorFrameSchema = Type.Object(
	{ type: Type.Literal("query_error"), queryId: id, reason: QueryErrorReasonSchema },
	closed,
);

export const ChangedFrameSchema = Type.Object({ type: Type.Literal("changed"), catalog: CatalogNameSchema }, closed);

/** The host ends the connection after this frame. */
export const FatalFrameSchema = Type.Object(
	{ type: Type.Literal("fatal"), code: FatalCodeSchema, message: Type.Optional(Type.String()) },
	closed,
);

export const HOST_FRAME_SCHEMAS = {
	welcome: WelcomeFrameSchema,
	snapshot: SnapshotFrameSchema,
	entry: EntryFrameSchema,
	head: HeadFrameSchema,
	live: LiveFrameSchema,
	ended: EndedFrameSchema,
	accepted: AcceptedFrameSchema,
	rejected: RejectedFrameSchema,
	result: ResultFrameSchema,
	query_error: QueryErrorFrameSchema,
	changed: ChangedFrameSchema,
	fatal: FatalFrameSchema,
} as const;

// ============================================================================
// Unions
// ============================================================================

/** Every frame type name. No intent may be named like one. */
export const RESERVED_FRAME_TYPES = [...Object.keys(CLIENT_FRAME_SCHEMAS), "query", ...Object.keys(HOST_FRAME_SCHEMAS)];

/** Everything a client may write: the fixed frames, intents, and queries. */
export const ClientFrameSchema = Type.Union([
	...Object.values(CLIENT_FRAME_SCHEMAS).map((schema): TSchema => schema),
	IntentFrameSchema,
	QueryFrameSchema,
]);

export type ClientFrame =
	| Static<(typeof CLIENT_FRAME_SCHEMAS)[keyof typeof CLIENT_FRAME_SCHEMAS]>
	| IntentFrame
	| QueryFrame;

/** Everything a host may write. */
export const HostFrameSchema = Type.Union([
	WelcomeFrameSchema,
	SnapshotFrameSchema,
	EntryFrameSchema,
	HeadFrameSchema,
	LiveFrameSchema,
	EndedFrameSchema,
	AcceptedFrameSchema,
	RejectedFrameSchema,
	ResultFrameSchema,
	QueryErrorFrameSchema,
	ChangedFrameSchema,
	FatalFrameSchema,
]);

export type HostFrame = Static<typeof HostFrameSchema>;

// ============================================================================
// Limits block
// ============================================================================

/** The protocol's contract constants, exported into the artifact's `x-volt-limits`. */
export const PROTOCOL_LIMITS = {
	version: PROTOCOL_VERSION,
	reservedFrameTypes: RESERVED_FRAME_TYPES,
	dynamicIntentPattern: DYNAMIC_INTENT_PATTERN,
	intentNameMaxChars: INTENT_NAME_MAX_CHARS,
	intentOutcomeWindow: INTENT_OUTCOME_WINDOW,
	historyPageMaxEntries: HISTORY_PAGE_MAX_ENTRIES,
	contentTextMaxScalars: CONTENT_TEXT_MAX_SCALARS,
	editorCompletionsMaxItems: EDITOR_COMPLETIONS_MAX_ITEMS,
	editorCompletionTextMaxChars: EDITOR_COMPLETION_TEXT_MAX_CHARS,
	liveKeyIdMaxChars: LIVE_KEY_ID_MAX_CHARS,
	liveExtensionNameMaxChars: LIVE_EXTENSION_NAME_MAX_CHARS,
	extensionStatusMaxSerializedBytes: EXTENSION_STATUS_MAX_SERIALIZED_BYTES,
	extensionTitleMaxChars: EXTENSION_TITLE_MAX_CHARS,
} as const;
