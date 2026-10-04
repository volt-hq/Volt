/**
 * The voltd control plane: JSONL over the daemon's local socket, shared by
 * the daemon, the TUI, and the CLI.
 *
 * A connection opens with a hello. A control hello is answered by a
 * `hello_ack` and then carries requests (each answered by responses with the
 * same `id`) and unsolicited events. A relay hello hands the socket to one
 * phone stream: after the ack the daemon writes one `relay_preamble` line and
 * the rest of the socket is raw relay bytes.
 *
 * Every message is closed except the version-negotiation envelopes (hellos,
 * `hello_ack`, `fatal`), whose unknown fields are ignored so peers of
 * different protocol versions can still read a mismatch.
 */

import { type Static, type TSchema, type TString, Type } from "typebox";
import { SessionReferenceSchema } from "./entries.ts";
import { opaque, openStringEnum, stringEnum } from "./helpers.ts";
import { IrohRemotePushNotificationDeliveryStatusSchema, IrohRemotePushNotificationSchema } from "./push.ts";
import {
	IrohRemoteAccessPresetNameSchema,
	IrohRemoteRpcCapabilitiesSchema,
	IrohRemoteRpcGrantSchema,
} from "./remote-access.ts";
import {
	IrohRemoteHandshakeSuccessSchema,
	IrohRemoteHelloSchema,
	IrohRemoteRelayModeSchema,
} from "./remote-handshake.ts";
import { RPC_GIT_CONTEXT_OID_PATTERN, RPC_WIRE_MAX_SAFE_INTEGER } from "./wire-limits.ts";
import { IrohRemoteWorkspaceMetadataSnapshotSchema } from "./workspace.ts";

const closed = { additionalProperties: false } as const;
const open = { additionalProperties: true } as const;

/**
 * A string of `min`-`max` Unicode code points drawn from `characters`. The
 * bound is a pattern because TypeBox's `maxLength` counts grapheme clusters,
 * which do not bound a string's size; `maxLength` still rejects most oversized
 * input before the pattern runs.
 */
function codePoints(min: number, max: number, characters = String.raw`\s\S`): TString {
	return Type.String({ maxLength: max, pattern: `^[${characters}]{${min},${max}}$` });
}

/** No NUL or line breaks: the value is logged and shown on one line. */
const SINGLE_LINE = String.raw`^\u0000\r\n`;

const NonNegativeIntegerSchema = Type.Integer({ minimum: 0, maximum: RPC_WIRE_MAX_SAFE_INTEGER });
const EpochMsSchema = Type.Integer({ minimum: 1, maximum: RPC_WIRE_MAX_SAFE_INTEGER });

// ============================================================================
// Shared vocabulary
// ============================================================================

export const ControlLeaseStateSchema = stringEnum([
	"unowned",
	"daemon-active",
	"daemon-detached",
	"daemon-draining",
	"tui-owned",
]);
export type LeaseState = Static<typeof ControlLeaseStateSchema>;

export const ControlLeaseReleaseReasonSchema = stringEnum([
	"quit",
	"switch",
	"connection_lost",
	"shutdown",
	"retention_expired",
	"workspace_unregistered",
]);
export type LeaseReleaseReason = Static<typeof ControlLeaseReleaseReasonSchema>;

export const ControlClientKindSchema = stringEnum(["tui", "cli"]);
export type ControlClientKind = Static<typeof ControlClientKindSchema>;

export const ControlRelayCloseReasonSchema = stringEnum([
	"phone_disconnected",
	"tui_disconnected",
	"lease_transferred",
	"workspace_unregistered",
	"host_shutdown",
	"error",
]);
export type RelayCloseReason = Static<typeof ControlRelayCloseReasonSchema>;

/** Host keep-awake assertion state. `degraded`: enabled, but the assertion is not held. */
export const ControlKeepAwakeStatusSchema = Type.Object(
	{
		/** Desired (persisted) state. */
		enabled: Type.Boolean(),
		state: stringEnum(["disabled", "active", "degraded"]),
		method: Type.Optional(Type.String()),
		reason: Type.Optional(Type.String()),
	},
	closed,
);
export type ControlKeepAwakeStatus = Static<typeof ControlKeepAwakeStatusSchema>;

export const ControlLeaseStatusSchema = Type.Object(
	{
		workspaceName: Type.String(),
		sessionId: Type.String(),
		state: ControlLeaseStateSchema,
		relayCount: NonNegativeIntegerSchema,
		streamCount: NonNegativeIntegerSchema,
	},
	closed,
);
export type ControlLeaseStatus = Static<typeof ControlLeaseStatusSchema>;

export const ControlWorkspaceStatusSchema = Type.Object(
	{
		name: Type.String(),
		path: Type.String(),
		/** Workspace-specific headless tool grant, when configured. */
		allowedTools: Type.Optional(Type.Array(Type.String())),
	},
	closed,
);
export type ControlWorkspaceStatus = Static<typeof ControlWorkspaceStatusSchema>;

/** Worktree status over the local socket. The control plane is the same user, so checkout paths are included. */
export const ControlWorktreeStatusSchema = Type.Object(
	{
		id: Type.String(),
		workspaceName: Type.String(),
		path: Type.String(),
		branch: Type.String(),
		baseRef: Type.Optional(Type.String()),
		createdAt: Type.Number(),
		sessionIds: Type.Array(Type.String()),
		available: Type.Optional(Type.Boolean()),
		dirty: Type.Optional(Type.Boolean()),
		/** Branch commits vs the base ref (merge-back guidance). */
		aheadBehind: Type.Optional(
			Type.Object({ ahead: NonNegativeIntegerSchema, behind: NonNegativeIntegerSchema }, closed),
		),
	},
	closed,
);
export type ControlWorktreeStatus = Static<typeof ControlWorktreeStatusSchema>;

export const ControlClientStatusSchema = Type.Object(
	{
		clientNodeId: Type.String(),
		label: Type.Optional(Type.String()),
		pairedAtMs: Type.Number(),
		lastSeenAtMs: Type.Optional(Type.Number()),
		/** Resolved device grant, before workspace and daemon ceilings apply. */
		allowedTools: Type.Optional(Type.Array(Type.String())),
		/** True when the device has no customized grant and tracks the daemon's current default. */
		usesDefaultTools: Type.Optional(Type.Boolean()),
		rpcGrant: Type.Optional(IrohRemoteRpcGrantSchema),
	},
	closed,
);
export type ControlClientStatus = Static<typeof ControlClientStatusSchema>;

export const ControlRevokedClientStatusSchema = Type.Object(
	{
		clientNodeId: Type.String(),
		label: Type.Optional(Type.String()),
		pairedAtMs: Type.Number(),
		lastSeenAtMs: Type.Optional(Type.Number()),
		revokedAtMs: Type.Number(),
		/** Present after the desktop explicitly allows this identity to use a fresh pairing ticket. */
		rePairApprovedAtMs: Type.Optional(Type.Number()),
		rpcGrant: Type.Optional(IrohRemoteRpcGrantSchema),
	},
	closed,
);
export type ControlRevokedClientStatus = Static<typeof ControlRevokedClientStatusSchema>;

export const DaemonRemotePolicyStatusSchema = Type.Object(
	{
		/** Daemon-wide override; null delegates to workspace and device grants. */
		allowTools: Type.Union([Type.Array(Type.String()), Type.Null()]),
		/** Retention window for idle, detached daemon-owned runtimes. */
		detachedRuntimeTtlMs: Type.Number(),
	},
	closed,
);
export type DaemonRemotePolicyStatus = Static<typeof DaemonRemotePolicyStatusSchema>;

/** Managed relay access, independent of local endpoint readiness. Never carries credentials. */
export const ControlRelayCredentialStatusSchema = Type.Object(
	{
		state: stringEnum(["unpaired", "pairing", "active", "expired", "subscription_inactive", "revocation_pending"]),
		/** Current access-token expiry, when a token exists. */
		expiresAt: Type.Optional(EpochMsSchema),
		/** Next scheduled broker refresh; absent while a refresh runs or none is scheduled. */
		nextRefreshAt: Type.Optional(EpochMsSchema),
	},
	closed,
);
export type ControlRelayCredentialStatus = Static<typeof ControlRelayCredentialStatusSchema>;

export const REMOTE_TRANSPORT_REASON_CODES = [
	"extension_missing",
	"native_binding_missing",
	"endpoint_start_failed",
	"host_storage_full",
] as const;

export const RemoteTransportHealthSchema = Type.Object(
	{
		state: stringEnum(["starting", "ready", "degraded", "unavailable"]),
		/** Exact @hansjm10/volt-iroh wrapper version, when its manifest is readable. */
		wrapperVersion: Type.Optional(Type.String()),
		/** Present whenever state is degraded or unavailable. */
		reasonCode: Type.Optional(stringEnum(REMOTE_TRANSPORT_REASON_CODES)),
		/** Operator-facing guidance for reasonCode. */
		message: Type.Optional(Type.String()),
	},
	closed,
);
export type RemoteTransportHealth = Static<typeof RemoteTransportHealthSchema>;
export type RemoteTransportReasonCode = (typeof REMOTE_TRANSPORT_REASON_CODES)[number];

/** How voltd resolved the environment its runtimes and tools use. */
export const DaemonEnvironmentStatusSchema = Type.Object(
	{
		source: stringEnum(["login-shell", "inherited"]),
		/** Set when source is login-shell. */
		base: Type.Optional(stringEnum(["service", "systemd", "minimal"])),
		/** Login shell that was run, or would have been run. */
		shell: Type.Optional(Type.String()),
		durationMs: Type.Optional(Type.Number()),
		/** Why the inherited environment is in use. */
		reason: Type.Optional(Type.String()),
	},
	closed,
);
export type DaemonEnvironmentStatus = Static<typeof DaemonEnvironmentStatusSchema>;

/**
 * A device access choice: a preset, or an explicit tool list with RPC
 * capabilities. `pair_request` may omit both for the default preset.
 */
const presetAccess = {
	access: IrohRemoteAccessPresetNameSchema,
	allowedTools: Type.Optional(Type.Never()),
	rpcCapabilities: Type.Optional(Type.Never()),
};
const explicitAccess = {
	access: Type.Optional(Type.Never()),
	allowedTools: Type.Array(Type.String()),
	rpcCapabilities: IrohRemoteRpcCapabilitiesSchema,
};

/**
 * A phone RPC command forwarded verbatim from a TUI-served conversation for
 * the daemon to execute against its state. The daemon validates it per
 * command type and answers unsupported types with an error.
 */
export const ControlRelayRpcCommandSchema = Type.Unsafe<Record<string, unknown> & { type: string }>(
	Type.Object({ type: Type.String() }, open),
);

/**
 * The RPC response the TUI forwards to the phone verbatim. Relayed commands
 * include remote-only commands the RPC contract does not declare yet, so the
 * control plane carries the response as an opaque object.
 */
export const ControlRelayRpcResponseSchema = Type.Record(Type.String(), Type.Unknown());
export type ControlRelayRpcResponse = Static<typeof ControlRelayRpcResponseSchema>;

// ============================================================================
// Hello, ack, fatal, relay preamble
// ============================================================================

export const ControlHelloSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("hello"),
			role: Type.Literal("control"),
			protocolVersion: Type.Number(),
			pid: Type.Number(),
			version: Type.String(),
			client: ControlClientKindSchema,
			/** Per-daemon instance token read from the local pidfile. */
			controlToken: Type.Optional(Type.String()),
			/** Client capabilities, e.g. "worktrees". */
			capabilities: Type.Optional(Type.Array(Type.String())),
		},
		open,
	),
	Type.Object(
		{
			type: Type.Literal("hello"),
			role: Type.Literal("relay"),
			protocolVersion: Type.Number(),
			relayId: Type.String(),
			/** Single-use token from the relay_offer. */
			relayToken: Type.String(),
		},
		open,
	),
]);
export type HelloMessage = Static<typeof ControlHelloSchema>;

export const ControlHelloAckSchema = Type.Object(
	{
		type: Type.Literal("hello_ack"),
		ok: Type.Boolean(),
		error: Type.Optional(stringEnum(["protocol_mismatch", "shutting_down", "bad_relay_token", "auth_failed"])),
		/** Daemon-assigned; present when ok on a control connection. */
		connectionId: Type.Optional(Type.String()),
		/** Daemon package version. */
		version: Type.Optional(Type.String()),
		protocolVersion: Type.Optional(Type.Number()),
	},
	open,
);
export type HelloAck = Static<typeof ControlHelloAckSchema>;

/** Sent before the daemon closes a connection it cannot serve: a malformed hello or an oversized line. */
export const ControlFatalSchema = Type.Object(
	{ type: Type.Literal("fatal"), error: openStringEnum(["invalid_hello", "frame_too_large"]) },
	open,
);
export type ControlFatal = Static<typeof ControlFatalSchema>;

export const ControlRelayPreambleSchema = Type.Object(
	{
		type: Type.Literal("relay_preamble"),
		relayId: Type.String(),
		/** The phone's parsed hello, the success response to write for it, and the bytes it sent after the hello. */
		handshake: Type.Object(
			{
				hello: IrohRemoteHelloSchema,
				response: IrohRemoteHandshakeSuccessSchema,
				initialInput: Type.Array(Type.Integer({ minimum: 0, maximum: 255 })),
			},
			closed,
		),
		/** Everything the TUI needs to serve the stream. */
		authorization: Type.Object(
			{
				...IrohRemoteWorkspaceMetadataSnapshotSchema.properties,
				clientNodeId: Type.String(),
				workspaceName: Type.String(),
				workspacePath: Type.String(),
				/** Headless agent tool grant, for visibility; TUI-owned sessions keep their full local tools. */
				allowedTools: Type.String(),
				rpcGrant: IrohRemoteRpcGrantSchema,
				/** Present when the conversation is bound to a daemon-managed worktree. */
				worktreeId: Type.Optional(Type.String()),
				/** Worktree checkout path: the TUI sanitizes with it as the root. */
				worktreePath: Type.Optional(Type.String()),
				/** Registered-workspace-relative git source root for nested repository worktrees. */
				worktreeSourceRootRelativePath: Type.Optional(Type.String()),
			},
			closed,
		),
		/** The daemon's Iroh node id; the TUI writes it into the handshake response for the phone's host check. */
		hostNodeId: Type.Optional(Type.String()),
		relayMode: Type.Optional(IrohRemoteRelayModeSchema),
		relayUrls: Type.Optional(Type.Array(Type.String())),
		connectionId: Type.String(),
		streamId: Type.String(),
		resolvedTarget: Type.Object(
			{
				sessionId: Type.String(),
				selection: stringEnum(["created", "created_after_missing", "resumed"]),
				requestedSessionId: Type.Optional(Type.String()),
				workspaceName: Type.String(),
				workspacePath: Type.String(),
				worktreeId: Type.Optional(Type.String()),
				/** POSIX-style path relative to the registered workspace root. */
				workingDirectory: Type.Optional(Type.String()),
			},
			closed,
		),
	},
	closed,
);
export type RelayPreamble = Static<typeof ControlRelayPreambleSchema>;

// ============================================================================
// Requests (client -> daemon)
// ============================================================================

const withId = <T extends string, P extends Record<string, TSchema>>(type: T, properties: P) =>
	Type.Object({ type: Type.Literal(type), id: Type.String(), ...properties }, closed);

export const CONTROL_REQUEST_SCHEMAS = {
	status: withId("status", {}),
	shutdown: withId("shutdown", {}),
	lease_acquire: withId("lease_acquire", {
		workspaceName: Type.String(),
		sessionId: Type.String(),
		/** Reserved: true is answered with lease_denied{force_unsupported}. */
		force: Type.Optional(Type.Boolean()),
	}),
	lease_release: withId("lease_release", {
		workspaceName: Type.String(),
		sessionId: Type.String(),
		reason: ControlLeaseReleaseReasonSchema,
	}),
	/** Path-free authoritative Git state from the exact TUI lease holder. */
	work_observe: withId("work_observe", {
		workspaceName: codePoints(1, 256),
		sessionId: codePoints(1, 128),
		gitContext: Type.Union([
			Type.Object(
				{
					repository: codePoints(1, 256, SINGLE_LINE),
					branch: codePoints(1, 1024, SINGLE_LINE),
					headOid: Type.String({ pattern: RPC_GIT_CONTEXT_OID_PATTERN }),
					baseRef: Type.Optional(codePoints(0, 1024, SINGLE_LINE)),
				},
				closed,
			),
			Type.Null(),
		]),
	}),
	/** Progress arrives as pairing_progress events. */
	pair_request: Type.Union([
		withId("pair_request", {
			workspaceName: Type.Optional(Type.String()),
			...presetAccess,
			access: Type.Optional(IrohRemoteAccessPresetNameSchema),
		}),
		withId("pair_request", { workspaceName: Type.Optional(Type.String()), ...explicitAccess }),
	]),
	pair_cancel: withId("pair_cancel", { requestId: Type.String() }),
	clients_list: withId("clients_list", {}),
	relay_credential_revoke: withId("relay_credential_revoke", {}),
	/** Refresh expired or suspended managed relay access now instead of at the next scheduled check. */
	relay_credential_check: withId("relay_credential_check", {}),
	client_access_update: Type.Union([
		withId("client_access_update", {
			clientNodeId: Type.String(),
			expectedRevision: Type.Integer({ minimum: 1, maximum: RPC_WIRE_MAX_SAFE_INTEGER }),
			...presetAccess,
		}),
		withId("client_access_update", {
			clientNodeId: Type.String(),
			expectedRevision: Type.Integer({ minimum: 1, maximum: RPC_WIRE_MAX_SAFE_INTEGER }),
			...explicitAccess,
		}),
	]),
	client_revoke: withId("client_revoke", { clientNodeId: Type.String() }),
	client_approve_repair: withId("client_approve_repair", { clientNodeId: Type.String() }),
	workspace_register: withId("workspace_register", { name: Type.String(), path: Type.String() }),
	workspace_unregister: withId("workspace_unregister", { name: Type.String() }),
	worktree_create: withId("worktree_create", {
		workspaceName: Type.String(),
		worktreeName: Type.Optional(Type.String()),
		branch: Type.Optional(Type.String()),
		baseRef: Type.Optional(Type.String()),
	}),
	worktree_adopt: withId("worktree_adopt", {
		workspaceName: Type.String(),
		path: Type.String(),
		worktreeName: Type.Optional(Type.String()),
		baseRef: Type.Optional(Type.String()),
	}),
	worktree_list: withId("worktree_list", { workspaceName: Type.Optional(Type.String()) }),
	worktree_remove: withId("worktree_remove", {
		workspaceName: Type.String(),
		worktreeId: Type.String(),
		force: Type.Optional(Type.Boolean()),
	}),
	worktree_prune: withId("worktree_prune", {
		workspaceName: Type.Optional(Type.String()),
		purgeRecovery: Type.Optional(Type.Boolean()),
	}),
	/** Resolve a filesystem path to the daemon-managed worktree containing it. */
	worktree_resolve: withId("worktree_resolve", { path: Type.String() }),
	/** Restore and pin an exact local session's managed checkout without changing its stored cwd. */
	worktree_restore: withId("worktree_restore", { path: Type.String(), sessionRef: SessionReferenceSchema }),
	/** Bind a session id to a worktree (TUI-created worktree sessions). */
	worktree_bind: withId("worktree_bind", {
		workspaceName: Type.String(),
		worktreeId: Type.String(),
		sessionId: Type.String(),
		/** Direct managed-checkout startup: acquire the lease on this connection while binding. */
		acquireLease: Type.Optional(Type.Boolean()),
	}),
	/** A theme name; the daemon resolves it and broadcasts a theme_snapshot. */
	theme_set: withId("theme_set", { theme: Type.String() }),
	/** Hold or release the host sleep-prevention assertion. */
	keep_awake_set: withId("keep_awake_set", { enabled: Type.Boolean() }),
	viewer_subscribe: withId("viewer_subscribe", { viewerFeedId: Type.String() }),
	viewer_unsubscribe: withId("viewer_unsubscribe", { viewerFeedId: Type.String() }),
	viewer_abort: withId("viewer_abort", { viewerFeedId: Type.String() }),
	relay_rpc: withId("relay_rpc", {
		/** The active relay whose phone command is forwarded. */
		relayId: Type.String(),
		clientNodeId: Type.String(),
		workspaceName: Type.String(),
		/** The TUI's current session id for the relayed conversation. */
		sessionId: Type.String(),
		command: ControlRelayRpcCommandSchema,
	}),
	relay_notification_delivery: withId("relay_notification_delivery", {
		clientNodeId: Type.String(),
		workspaceName: Type.String(),
		sessionId: Type.String(),
		notification: IrohRemotePushNotificationSchema,
	}),
} as const;

export const ControlRequestSchema = Type.Union([
	CONTROL_REQUEST_SCHEMAS.status,
	CONTROL_REQUEST_SCHEMAS.shutdown,
	CONTROL_REQUEST_SCHEMAS.lease_acquire,
	CONTROL_REQUEST_SCHEMAS.lease_release,
	CONTROL_REQUEST_SCHEMAS.work_observe,
	CONTROL_REQUEST_SCHEMAS.pair_request,
	CONTROL_REQUEST_SCHEMAS.pair_cancel,
	CONTROL_REQUEST_SCHEMAS.clients_list,
	CONTROL_REQUEST_SCHEMAS.relay_credential_revoke,
	CONTROL_REQUEST_SCHEMAS.relay_credential_check,
	CONTROL_REQUEST_SCHEMAS.client_access_update,
	CONTROL_REQUEST_SCHEMAS.client_revoke,
	CONTROL_REQUEST_SCHEMAS.client_approve_repair,
	CONTROL_REQUEST_SCHEMAS.workspace_register,
	CONTROL_REQUEST_SCHEMAS.workspace_unregister,
	CONTROL_REQUEST_SCHEMAS.worktree_create,
	CONTROL_REQUEST_SCHEMAS.worktree_adopt,
	CONTROL_REQUEST_SCHEMAS.worktree_list,
	CONTROL_REQUEST_SCHEMAS.worktree_remove,
	CONTROL_REQUEST_SCHEMAS.worktree_prune,
	CONTROL_REQUEST_SCHEMAS.worktree_resolve,
	CONTROL_REQUEST_SCHEMAS.worktree_restore,
	CONTROL_REQUEST_SCHEMAS.worktree_bind,
	CONTROL_REQUEST_SCHEMAS.theme_set,
	CONTROL_REQUEST_SCHEMAS.keep_awake_set,
	CONTROL_REQUEST_SCHEMAS.viewer_subscribe,
	CONTROL_REQUEST_SCHEMAS.viewer_unsubscribe,
	CONTROL_REQUEST_SCHEMAS.viewer_abort,
	CONTROL_REQUEST_SCHEMAS.relay_rpc,
	CONTROL_REQUEST_SCHEMAS.relay_notification_delivery,
]);
export type ControlRequest = Static<typeof ControlRequestSchema>;

// ============================================================================
// Responses (daemon -> client)
// ============================================================================

export const CONTROL_RESPONSE_SCHEMAS = {
	ok: withId("ok", {}),
	error: withId("error", { code: Type.String(), message: Type.String() }),
	lease_granted: withId("lease_granted", {
		workspaceName: Type.String(),
		sessionId: Type.String(),
		handoff: stringEnum(["cold", "warm", "none"]),
	}),
	/** Provisional: the terminal response for the same id follows when the drain completes or fails. */
	lease_pending: withId("lease_pending", { viewerFeedId: Type.String() }),
	lease_denied: withId("lease_denied", {
		reason: stringEnum(["held_by_tui", "force_unsupported", "draining_elsewhere"]),
	}),
	status_result: withId("status_result", {
		version: Type.String(),
		protocolVersion: Type.Number(),
		pid: Type.Number(),
		startedAtMs: Type.Number(),
		environment: DaemonEnvironmentStatusSchema,
		/** Optional feature flags. */
		capabilities: Type.Optional(Type.Array(Type.String())),
		leases: Type.Array(ControlLeaseStatusSchema),
		phoneConnections: NonNegativeIntegerSchema,
		workspaces: Type.Array(ControlWorkspaceStatusSchema),
		clients: Type.Array(ControlClientStatusSchema),
		/** Revoked identities retained for explicit repair approval. */
		revokedClients: Type.Optional(Type.Array(ControlRevokedClientStatusSchema)),
		/** Phone-transport readiness; local daemon functions stay available when not ready. */
		remoteTransport: RemoteTransportHealthSchema,
		/** Omitted for non-managed relay setups. */
		relayCredential: Type.Optional(ControlRelayCredentialStatusSchema),
		remotePolicy: Type.Optional(DaemonRemotePolicyStatusSchema),
		keepAwake: ControlKeepAwakeStatusSchema,
	}),
	keep_awake_result: withId("keep_awake_result", { keepAwake: ControlKeepAwakeStatusSchema }),
	clients_result: withId("clients_result", { clients: Type.Array(ControlClientStatusSchema) }),
	client_access_updated: withId("client_access_updated", { client: ControlClientStatusSchema }),
	worktree_result: withId("worktree_result", { worktree: ControlWorktreeStatusSchema }),
	worktrees_result: withId("worktrees_result", { worktrees: Type.Array(ControlWorktreeStatusSchema) }),
	worktree_resolve_result: withId("worktree_resolve_result", {
		/** Parent workspace the worktree belongs to. */
		workspaceName: Type.String(),
		/** Parent workspace checkout path. */
		workspacePath: Type.String(),
		worktreeId: Type.String(),
		worktreePath: Type.String(),
	}),
	worktree_prune_result: withId("worktree_prune_result", {
		results: Type.Array(
			Type.Object(
				{
					workspaceName: Type.String(),
					removedRecords: Type.Array(Type.String()),
					orphanCheckouts: Type.Array(Type.String()),
					purgedRecoveryCheckouts: Type.Optional(Type.Array(Type.String())),
				},
				closed,
			),
		),
	}),
	pair_started: withId("pair_started", { requestId: Type.String() }),
	relay_rpc_result: withId("relay_rpc_result", {
		response: ControlRelayRpcResponseSchema,
		/** Refreshed workspace catalog after a successful unregister_workspace. */
		workspaceMetadata: Type.Optional(IrohRemoteWorkspaceMetadataSnapshotSchema),
	}),
	relay_push_delivery_result: withId("relay_push_delivery_result", {
		status: IrohRemotePushNotificationDeliveryStatusSchema,
	}),
} as const;

export const ControlResponseSchema = Type.Union([
	CONTROL_RESPONSE_SCHEMAS.ok,
	CONTROL_RESPONSE_SCHEMAS.error,
	CONTROL_RESPONSE_SCHEMAS.lease_granted,
	CONTROL_RESPONSE_SCHEMAS.lease_pending,
	CONTROL_RESPONSE_SCHEMAS.lease_denied,
	CONTROL_RESPONSE_SCHEMAS.status_result,
	CONTROL_RESPONSE_SCHEMAS.keep_awake_result,
	CONTROL_RESPONSE_SCHEMAS.clients_result,
	CONTROL_RESPONSE_SCHEMAS.client_access_updated,
	CONTROL_RESPONSE_SCHEMAS.worktree_result,
	CONTROL_RESPONSE_SCHEMAS.worktrees_result,
	CONTROL_RESPONSE_SCHEMAS.worktree_resolve_result,
	CONTROL_RESPONSE_SCHEMAS.worktree_prune_result,
	CONTROL_RESPONSE_SCHEMAS.pair_started,
	CONTROL_RESPONSE_SCHEMAS.relay_rpc_result,
	CONTROL_RESPONSE_SCHEMAS.relay_push_delivery_result,
]);
export type ControlResponse = Static<typeof ControlResponseSchema>;

// ============================================================================
// Events (daemon -> control clients, unsolicited)
// ============================================================================

const event = <T extends string, P extends Record<string, TSchema>>(type: T, properties: P) =>
	Type.Object({ type: Type.Literal(type), ...properties }, closed);

export const CONTROL_EVENT_SCHEMAS = {
	relay_offer: event("relay_offer", {
		relayId: Type.String(),
		/** Single-use; expires after 10 seconds. */
		relayToken: Type.String(),
		workspaceName: Type.String(),
		sessionId: Type.String(),
		clientNodeId: Type.String(),
		connectionId: Type.String(),
		streamId: Type.String(),
	}),
	relay_closed: event("relay_closed", { relayId: Type.String(), reason: ControlRelayCloseReasonSchema }),
	viewer_event: event("viewer_event", {
		viewerFeedId: Type.String(),
		seq: NonNegativeIntegerSchema,
		event: opaque<unknown>(
			"a draining daemon runtime's session event as JSON, or {kind: 'truncated'} after a buffer overflow; deleted with the viewer feed",
		),
	}),
	viewer_end: event("viewer_end", {
		viewerFeedId: Type.String(),
		reason: stringEnum(["granted", "cancelled", "error"]),
	}),
	theme_snapshot: event("theme_snapshot", {
		themeName: Type.String(),
		tokens: Type.Record(Type.String(), Type.String()),
	}),
	keep_awake_changed: event("keep_awake_changed", { keepAwake: ControlKeepAwakeStatusSchema }),
	pairing_progress: event("pairing_progress", {
		requestId: Type.String(),
		phase: stringEnum(["ticket", "qr", "waiting", "completed", "failed"]),
		ticket: Type.Optional(Type.String()),
		qrLines: Type.Optional(Type.Array(Type.String())),
		clientNodeId: Type.Optional(Type.String()),
		error: Type.Optional(Type.String()),
	}),
	daemon_shutdown: event("daemon_shutdown", {}),
} as const;

export const ControlEventSchema = Type.Union([
	CONTROL_EVENT_SCHEMAS.relay_offer,
	CONTROL_EVENT_SCHEMAS.relay_closed,
	CONTROL_EVENT_SCHEMAS.viewer_event,
	CONTROL_EVENT_SCHEMAS.viewer_end,
	CONTROL_EVENT_SCHEMAS.theme_snapshot,
	CONTROL_EVENT_SCHEMAS.keep_awake_changed,
	CONTROL_EVENT_SCHEMAS.pairing_progress,
	CONTROL_EVENT_SCHEMAS.daemon_shutdown,
]);
export type ControlEvent = Static<typeof ControlEventSchema>;
