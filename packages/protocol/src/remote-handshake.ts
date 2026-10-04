/**
 * The Iroh remote handshake: the hello a phone writes on a new stream, the
 * host's success or failure response, and the terminal frame that ends a
 * stream on purpose.
 *
 * The hello and the response are version-negotiation envelopes: their top
 * level ignores unknown fields so peers can read a mismatch. Every nested
 * target and metadata object is closed. Hosts derive the stream `mode` from
 * which single target key is present; a `mode` field on the wire is ignored.
 */

import { type Static, Type } from "typebox";
import { stringEnum } from "./helpers.ts";
import { IrohRemoteWorkspaceNameSchema, IrohRemoteWorkspaceStatusSchema } from "./workspace.ts";

export const IROH_REMOTE_ALPN = "volt-rpc/0";
export const IROH_REMOTE_HELLO_TYPE = "volt_iroh_hello";
export const IROH_REMOTE_HANDSHAKE_TYPE = "volt_iroh_handshake";

export const IROH_REMOTE_OUTCOMES = [
	"host_unreachable",
	"host_storage_full",
	"invalid_workspace",
	"invalid_conversation_target",
	"conversation_streams_unsupported",
	"pairing_secret_expired",
	"pairing_secret_consumed",
	"client_unknown",
	"client_revoked",
	"workspace_unavailable",
	"workspace_missing",
	"workspace_forbidden",
	"workspace_authorization_removed",
	"workspace_unregistered",
	"session_unavailable",
	"duplicate_conversation_connection",
	"conversation_in_use",
	"conversation_locked",
	"host_identity_mismatch",
	"saved_host_invalid",
] as const;

/** The outcomes a host itself reports in a failed handshake; the rest are client-side. */
export const IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES = [
	"host_storage_full",
	"invalid_workspace",
	"invalid_conversation_target",
	"conversation_streams_unsupported",
	"pairing_secret_expired",
	"pairing_secret_consumed",
	"client_unknown",
	"client_revoked",
	"workspace_unavailable",
	"workspace_missing",
	"workspace_forbidden",
	"workspace_authorization_removed",
	"workspace_unregistered",
	"session_unavailable",
	"duplicate_conversation_connection",
	"conversation_in_use",
	"conversation_locked",
] as const;

export const IROH_REMOTE_SESSION_ID_PATTERN_SOURCE = "^[a-z0-9_-]{1,128}$";
/** Daemon-managed worktree ids: lowercase slug, unique per workspace. */
export const IROH_REMOTE_WORKTREE_ID_PATTERN_SOURCE = "^[a-z0-9][a-z0-9._-]{0,63}$";
export const IROH_REMOTE_WORKING_DIRECTORY_MAX_CHARS = 4096;
export const IROH_REMOTE_WORKING_DIRECTORY_MAX_UTF8_BYTES = 8192;

const WORKING_DIRECTORY_SEGMENT = String.raw`(?!\.{1,2}(?:/|$))(?![.][Gg][Ii][Tt](?:/|$))[^/\\\u0000-\u001f\u007f]+`;

const NonEmptyStringSchema = Type.String({ minLength: 1, "x-volt-expected": "be a non-empty string" });

export const IrohRemoteSessionIdSchema = Type.String({
	pattern: IROH_REMOTE_SESSION_ID_PATTERN_SOURCE,
	"x-volt-expected": "match lowercase remote session ID syntax",
});

export const IrohRemoteWorktreeIdSchema = Type.String({
	pattern: IROH_REMOTE_WORKTREE_ID_PATTERN_SOURCE,
	"x-volt-expected": "match lowercase worktree id syntax",
});

/**
 * A POSIX path relative to the registered workspace root: no drive letter,
 * backslash, control character, or empty, `.`, `..`, or `.git` segment. The
 * UTF-16 length and UTF-8 byte budgets are enforced by a layered check.
 */
export const IrohRemoteWorkingDirectorySchema = Type.String({
	pattern: `^(?![A-Za-z]:)${WORKING_DIRECTORY_SEGMENT}(?:/${WORKING_DIRECTORY_SEGMENT})*$`,
	maxLength: IROH_REMOTE_WORKING_DIRECTORY_MAX_CHARS,
	"x-volt-max-utf8-bytes": IROH_REMOTE_WORKING_DIRECTORY_MAX_UTF8_BYTES,
	"x-volt-expected": "be a relative POSIX path inside the workspace",
});

export const IrohRemoteOutcomeSchema = stringEnum(IROH_REMOTE_OUTCOMES, {
	"x-volt-expected": "be a known Iroh remote outcome",
});
export type IrohRemoteOutcome = Static<typeof IrohRemoteOutcomeSchema>;
export type IrohRemoteHostHandshakeFailureOutcome = (typeof IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES)[number];

export const IrohRemoteRelayModeSchema = stringEnum(["disabled", "development", "production"], {
	"x-volt-expected": "be a supported relay mode",
});
export type IrohRemoteRelayMode = Static<typeof IrohRemoteRelayModeSchema>;

export const IrohRemoteRelayUrlsSchema = Type.Array(NonEmptyStringSchema, {
	minItems: 1,
	"x-volt-expected": "be a non-empty array of relay URLs",
});

/** A key that must be absent from this variant. */
const absent = () => Type.Optional(Type.Never({ "x-volt-expected": "be absent" }));

// ============================================================================
// Hello (phone -> host)
// ============================================================================

/**
 * The conversation a stream serves. `new` carries the session id the phone
 * minted and may bind a worktree or working directory; resume targets derive
 * both from the persisted binding, never from the phone.
 */
export const IROH_REMOTE_CONVERSATION_TARGET_SCHEMAS = {
	last: Type.Object(
		{ target: Type.Literal("last"), sessionId: absent(), worktreeId: absent(), workingDirectory: absent() },
		{ additionalProperties: false },
	),
	new: Type.Object(
		{
			target: Type.Literal("new"),
			sessionId: IrohRemoteSessionIdSchema,
			worktreeId: Type.Optional(IrohRemoteWorktreeIdSchema),
			/** POSIX-style path relative to the registered workspace root. */
			workingDirectory: Type.Optional(IrohRemoteWorkingDirectorySchema),
		},
		{ additionalProperties: false },
	),
	session: Type.Object(
		{
			target: Type.Literal("session"),
			sessionId: IrohRemoteSessionIdSchema,
			worktreeId: absent(),
			workingDirectory: absent(),
		},
		{ additionalProperties: false },
	),
} as const;

export const IrohRemoteConversationTargetSchema = Type.Union([
	IROH_REMOTE_CONVERSATION_TARGET_SCHEMAS.last,
	IROH_REMOTE_CONVERSATION_TARGET_SCHEMAS.new,
	IROH_REMOTE_CONVERSATION_TARGET_SCHEMAS.session,
]);
export type IrohRemoteConversationTarget = Static<typeof IrohRemoteConversationTargetSchema>;

export const IrohRemoteWorkspaceDiscoveryTargetSchema = Type.Object(
	{
		purpose: stringEnum(["list_sessions", "agent_options", "session_contexts", "review"], {
			"x-volt-expected": "be a supported workspaceDiscovery purpose",
		}),
	},
	{ additionalProperties: false },
);
export type IrohRemoteWorkspaceDiscoveryTarget = Static<typeof IrohRemoteWorkspaceDiscoveryTargetSchema>;

export const IrohRemoteWorkspaceManagementTargetSchema = Type.Object(
	{
		purpose: stringEnum(["unregister_workspace", "manage_worktrees", "list_workspace_directories"], {
			"x-volt-expected": "be a supported workspaceManagement purpose",
		}),
	},
	{ additionalProperties: false },
);
export type IrohRemoteWorkspaceManagementTarget = Static<typeof IrohRemoteWorkspaceManagementTargetSchema>;

const helloProperties = {
	type: Type.Literal(IROH_REMOTE_HELLO_TYPE),
	protocol: Type.Literal(IROH_REMOTE_ALPN),
	workspace: IrohRemoteWorkspaceNameSchema,
	/** One-time pairing secret from the ticket; absent once paired. */
	secret: Type.Optional(NonEmptyStringSchema),
	clientLabel: Type.Optional(NonEmptyStringSchema),
	/** Advisory only: the host authenticates the transport's node id. */
	clientNodeId: Type.Optional(NonEmptyStringSchema),
};

/** What a phone writes, keyed by its single stream-mode key. */
export const IROH_REMOTE_HELLO_WIRE_SCHEMAS = {
	conversation: Type.Object(
		{
			...helloProperties,
			conversation: IrohRemoteConversationTargetSchema,
			workspaceDiscovery: absent(),
			workspaceManagement: absent(),
		},
		{ additionalProperties: true },
	),
	workspaceDiscovery: Type.Object(
		{
			...helloProperties,
			workspaceDiscovery: IrohRemoteWorkspaceDiscoveryTargetSchema,
			conversation: absent(),
			workspaceManagement: absent(),
		},
		{ additionalProperties: true },
	),
	workspaceManagement: Type.Object(
		{
			...helloProperties,
			workspaceManagement: IrohRemoteWorkspaceManagementTargetSchema,
			conversation: absent(),
			workspaceDiscovery: absent(),
		},
		{ additionalProperties: true },
	),
} as const;

/** What a phone writes: exactly one of `conversation`, `workspaceDiscovery`, or `workspaceManagement`. */
export const IrohRemoteHelloWireSchema = Type.Union([
	IROH_REMOTE_HELLO_WIRE_SCHEMAS.conversation,
	IROH_REMOTE_HELLO_WIRE_SCHEMAS.workspaceDiscovery,
	IROH_REMOTE_HELLO_WIRE_SCHEMAS.workspaceManagement,
]);

/** A parsed hello: the wire hello reduced to its known fields, with the derived stream `mode`. */
export const IrohRemoteHelloSchema = Type.Union([
	Type.Object(
		{ ...helloProperties, mode: Type.Literal("conversation"), conversation: IrohRemoteConversationTargetSchema },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...helloProperties,
			mode: Type.Literal("workspaceDiscovery"),
			workspaceDiscovery: IrohRemoteWorkspaceDiscoveryTargetSchema,
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...helloProperties,
			mode: Type.Literal("workspaceManagement"),
			workspaceManagement: IrohRemoteWorkspaceManagementTargetSchema,
		},
		{ additionalProperties: false },
	),
]);
export type IrohRemoteHello = Static<typeof IrohRemoteHelloSchema>;

// ============================================================================
// Handshake response (host -> phone)
// ============================================================================

export const IrohRemoteConversationSelectionSchema = stringEnum(["resumed", "created", "created_missing_last"], {
	"x-volt-expected": "be a supported conversation selection",
});
export type IrohRemoteConversationSelection = Static<typeof IrohRemoteConversationSelectionSchema>;

/** `new` resolves to created or resumed; `session` only to resumed. */
export const IrohRemoteConversationHandshakeMetadataSchema = Type.Object(
	{
		target: stringEnum(["last", "new", "session"], { "x-volt-expected": "be a supported conversation target" }),
		sessionId: IrohRemoteSessionIdSchema,
		selection: IrohRemoteConversationSelectionSchema,
		/** Echoed only for worktree-bound conversations (worktrees.v1). */
		worktreeId: Type.Optional(IrohRemoteWorktreeIdSchema),
		/** POSIX-style path relative to the workspace root. Omitted for the workspace root. */
		workingDirectory: Type.Optional(IrohRemoteWorkingDirectorySchema),
	},
	{ additionalProperties: false },
);
export type IrohRemoteConversationHandshakeMetadata = Static<typeof IrohRemoteConversationHandshakeMetadataSchema>;

/** Host identity and the paired client's workspace catalog. `workspace` and `hostNodeId` match the response. */
export const IrohRemoteHostHandshakeMetadataSchema = Type.Object(
	{
		workspace: IrohRemoteWorkspaceNameSchema,
		workspaceNames: Type.Array(IrohRemoteWorkspaceNameSchema),
		workspaces: Type.Array(IrohRemoteWorkspaceStatusSchema),
		features: Type.Array(NonEmptyStringSchema, { minItems: 1, "x-volt-expected": "be a non-empty string array" }),
		hostNodeId: Type.Optional(NonEmptyStringSchema),
		relayMode: Type.Optional(IrohRemoteRelayModeSchema),
		relayUrls: Type.Optional(IrohRemoteRelayUrlsSchema),
		hostName: Type.Optional(NonEmptyStringSchema),
		userName: Type.Optional(NonEmptyStringSchema),
		cwd: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);
export type IrohRemoteHostHandshakeMetadata = Static<typeof IrohRemoteHostHandshakeMetadataSchema>;

/**
 * A stream-mode success names exactly one mode (a conversation also repeats
 * its session id at the top level), carries `hostNodeId`, and advertises the
 * multi-stream and conversation-stream features.
 */
export const IrohRemoteHandshakeSuccessSchema = Type.Object(
	{
		type: Type.Literal(IROH_REMOTE_HANDSHAKE_TYPE),
		success: Type.Literal(true),
		workspace: NonEmptyStringSchema,
		hostNodeId: Type.Optional(NonEmptyStringSchema),
		/** The transport-authenticated client node id. */
		clientNodeId: NonEmptyStringSchema,
		features: Type.Optional(Type.Array(NonEmptyStringSchema)),
		sessionId: Type.Optional(NonEmptyStringSchema),
		conversation: Type.Optional(IrohRemoteConversationHandshakeMetadataSchema),
		workspaceDiscovery: Type.Optional(IrohRemoteWorkspaceDiscoveryTargetSchema),
		workspaceManagement: Type.Optional(IrohRemoteWorkspaceManagementTargetSchema),
		remoteHost: Type.Optional(IrohRemoteHostHandshakeMetadataSchema),
		child: Type.Optional(NonEmptyStringSchema),
	},
	{ additionalProperties: true },
);
export type IrohRemoteHandshakeSuccess = Static<typeof IrohRemoteHandshakeSuccessSchema>;

export const IrohRemoteHandshakeFailureSchema = Type.Object(
	{
		type: Type.Literal(IROH_REMOTE_HANDSHAKE_TYPE),
		success: Type.Literal(false),
		outcome: Type.Optional(IrohRemoteOutcomeSchema),
		hostNodeId: Type.Optional(NonEmptyStringSchema),
		workspace: Type.Optional(NonEmptyStringSchema),
		sessionId: Type.Optional(IrohRemoteSessionIdSchema),
		retryAfterMs: Type.Optional(Type.Number({ "x-volt-expected": "be a finite number" })),
		error: NonEmptyStringSchema,
	},
	{ additionalProperties: true },
);
export type IrohRemoteHandshakeFailure = Static<typeof IrohRemoteHandshakeFailureSchema>;

export const IrohRemoteHandshakeResponseSchema = Type.Union([
	IrohRemoteHandshakeSuccessSchema,
	IrohRemoteHandshakeFailureSchema,
]);
export type IrohRemoteHandshakeResponse = Static<typeof IrohRemoteHandshakeResponseSchema>;

// ============================================================================
// Terminal frame
// ============================================================================

/**
 * The final frame of a phone conversation stream the host ends on purpose;
 * the stream closes after it. `lease_transferred`: another host process
 * serves the session now; reconnect to the same session. `conversation_moved`:
 * a session command moved this client to `targetSessionId` after its response;
 * reconnect with `target: "session"` and that id.
 */
export const RpcRemoteTerminalEventSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("remote_terminal"),
			reason: Type.Literal("lease_transferred"),
			workspace: Type.String(),
			sessionId: Type.Optional(Type.String()),
			hostNodeId: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("remote_terminal"),
			reason: Type.Literal("conversation_moved"),
			workspace: Type.String(),
			sessionId: Type.String(),
			targetSessionId: Type.String(),
			hostNodeId: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
]);
