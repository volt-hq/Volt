/**
 * The voltd control plane: JSONL over the daemon's local socket, shared by
 * the daemon, the TUI, the CLI, and the conversation workers it supervises.
 *
 * A connection opens with a hello. A control hello is answered by a
 * `hello_ack` and then carries requests (each answered by responses with the
 * same `id`) and unsolicited events. A worker hello is admitted with the
 * single-use token its spawn issued, and then carries the worker requests
 * and the events the daemon sends its worker: one worker per connection. A
 * relay hello hands the socket to one end of a relayed client stream. A
 * worker redeeming a `relay_offer` reads the ack, then one `relay_preamble`
 * line, then raw relay bytes; a TUI redeeming its `conversation_opened` reads
 * the ack, then raw relay bytes.
 *
 * Every message is closed except the version-negotiation envelopes (hellos,
 * `hello_ack`, `fatal`), whose unknown fields are ignored so peers of
 * different protocol versions can still read a mismatch.
 */

import { type Static, type TSchema, type TString, Type } from "typebox";
import { LogSessionIdSchema, SessionReferenceSchema } from "./entries.ts";
import { AcceptedFrameSchema, QueryErrorFrameSchema, RejectedFrameSchema, ResultFrameSchema } from "./frames.ts";
import { openStringEnum, stringEnum } from "./helpers.ts";
import { type BuiltinIntentName, INTENT_FRAME_SCHEMAS, type IntentFrameEnvelope, type IntentInput } from "./intents.ts";
import { HostPromptRequestSchema, HostResponseSchema } from "./live.ts";
import { RpcThinkingLevelSchema } from "./primitives.ts";
import { IrohRemotePushNotificationDeliveryStatusSchema, IrohRemotePushNotificationSchema } from "./push.ts";
import { QUERY_FRAME_SCHEMAS, type QueryFrame, type QueryName } from "./queries.ts";
import { RemoteAccessPresetNameSchema, RemoteCapabilitiesSchema, RemoteGrantSchema } from "./remote-access.ts";
import {
	IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES,
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

export const ControlClientKindSchema = stringEnum(["tui", "cli"]);
export type ControlClientKind = Static<typeof ControlClientKindSchema>;

export const ControlRelayCloseReasonSchema = stringEnum([
	"phone_disconnected",
	/** The worker serving the relay closed its end. */
	"worker_disconnected",
	"workspace_unregistered",
	"host_shutdown",
	/** The worker serving the relay exited; the client reconnects with resume. */
	"worker_exited",
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

export const ControlWorkspaceStatusSchema = Type.Object(
	{
		name: Type.String(),
		path: Type.String(),
		/** Workspace-specific headless tool grant, when configured. */
		allowedTools: Type.Optional(Type.Array(Type.String())),
		/** Local to this host: paired devices neither see nor reach it unless their grant names it (D17). */
		localOnly: Type.Optional(Type.Literal(true)),
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
		rpcGrant: Type.Optional(RemoteGrantSchema),
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
		rpcGrant: Type.Optional(RemoteGrantSchema),
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

/**
 * A conversation worker in the daemon's registry: `starting` until it reports
 * ready, `live` while it serves, `retiring` once it was asked to stop (or lost
 * its control connection) until its process exits.
 */
export const ControlWorkerStateSchema = stringEnum(["starting", "live", "retiring"]);
export type ControlWorkerState = Static<typeof ControlWorkerStateSchema>;

/** Who caused a worker to start: its tool policy and environment follow. */
export const ControlWorkerOriginSchema = stringEnum(["phone", "tui"]);
export type ControlWorkerOrigin = Static<typeof ControlWorkerOriginSchema>;

export const ControlWorkerStatusSchema = Type.Object(
	{
		workerId: Type.String(),
		pid: NonNegativeIntegerSchema,
		state: ControlWorkerStateSchema,
		origin: ControlWorkerOriginSchema,
		workspaceName: Type.String(),
		/** Every conversation the worker hosts: its top-level conversations (up to six), and what they claimed. */
		sessionIds: Type.Array(LogSessionIdSchema),
		/** Relayed streams, offered or open, by client kind. */
		clients: Type.Object({ local: NonNegativeIntegerSchema, remote: NonNegativeIntegerSchema }, closed),
		/** The worker process's log (its stdout and stderr); absent for a worker in the daemon's own process. */
		logPath: Type.Optional(Type.String()),
	},
	closed,
);
export type ControlWorkerStatus = Static<typeof ControlWorkerStatusSchema>;

/** Why a worker hosts a conversation as part of a top-level conversation's group. */
export const WorkerHostKindSchema = stringEnum(["child", "sibling", "moved"]);
export type WorkerHostKind = Static<typeof WorkerHostKindSchema>;

/** Why a relayed client lost its authority: the fatal code its stream ends with. */
export const WorkerAuthorityLossSchema = stringEnum(["revoked", "workspace_unregistered"]);
export type WorkerAuthorityLoss = Static<typeof WorkerAuthorityLossSchema>;

/** A relay's authority as the daemon reads it now. */
export const WorkerRelayAuthoritySchema = stringEnum(["current", "revoked", "workspace_unregistered"]);
export type WorkerRelayAuthority = Static<typeof WorkerRelayAuthoritySchema>;

/** Why the daemon asks a worker to stop. */
export const WorkerStopReasonSchema = stringEnum(["retention", "authority", "shutdown"]);
export type WorkerStopReason = Static<typeof WorkerStopReasonSchema>;

/** An absolute path, or a package source: one line, no NUL. */
const PathSchema = codePoints(1, 4096, SINGLE_LINE);
const PathListSchema = Type.Array(PathSchema, { maxItems: 256 });
const NameListSchema = Type.Array(codePoints(1, 256, SINGLE_LINE), { maxItems: 256 });

/**
 * Spawn-only options: what a worker builds every conversation it hosts with,
 * from the CLI arguments of the TUI that opened it. Each field is the `Args`
 * field of the same name; local paths are absolute (the opener resolved
 * them), others are package sources. A worker keeps them for its lifetime:
 * an open that attaches to a live worker applies none of them, and hears
 * which of its own differ (`conversation_opened.ignoredOptions`).
 */
export const WorkerAgentConfigSchema = Type.Object(
	{
		/**
		 * `--approve`/`--no-approve`: the opener's override of project trust,
		 * for the project of the conversation it opens. Without one, and for
		 * the worker's conversations elsewhere, the worker decides each
		 * conversation's trust itself (its `project_trust` hooks, the saved
		 * decision, `defaultProjectTrust`, the opener's answer to the trust prompt).
		 */
		trust: Type.Optional(Type.Boolean()),
		/** The settings profile. */
		profile: Type.Optional(codePoints(1, 256, SINGLE_LINE)),
		/** `-e`. */
		extensions: Type.Optional(PathListSchema),
		noExtensions: Type.Optional(Type.Boolean()),
		skills: Type.Optional(PathListSchema),
		noSkills: Type.Optional(Type.Boolean()),
		promptTemplates: Type.Optional(PathListSchema),
		noPromptTemplates: Type.Optional(Type.Boolean()),
		themes: Type.Optional(PathListSchema),
		noThemes: Type.Optional(Type.Boolean()),
		noContextFiles: Type.Optional(Type.Boolean()),
		systemPrompt: Type.Optional(Type.String()),
		appendSystemPrompt: Type.Optional(Type.Array(Type.String(), { maxItems: 64 })),
		tools: Type.Optional(NameListSchema),
		noTools: Type.Optional(Type.Boolean()),
		noBuiltinTools: Type.Optional(Type.Boolean()),
		excludeTools: Type.Optional(NameListSchema),
		allowUnlistedExtensionTools: Type.Optional(Type.Boolean()),
		lsp: Type.Optional(Type.Boolean()),
		/** `--api-key`: a runtime key for the session model's provider. Never logged. */
		apiKey: Type.Optional(codePoints(1, 4096, SINGLE_LINE)),
		/** Extension flag values (`registerFlag`), by flag name. */
		flags: Type.Optional(
			Type.Record(
				Type.String({ pattern: String.raw`^[^\u0000\r\n=]{1,128}$` }),
				Type.Union([Type.Boolean(), Type.String()]),
				closed,
			),
		),
	},
	closed,
);
export type WorkerAgentConfig = Static<typeof WorkerAgentConfigSchema>;

/** The spawn-only options, by name: what `conversation_opened.ignoredOptions` names. */
export const WORKER_SPAWN_ONLY_OPTIONS = [
	"trust",
	"profile",
	"extensions",
	"noExtensions",
	"skills",
	"noSkills",
	"promptTemplates",
	"noPromptTemplates",
	"themes",
	"noThemes",
	"noContextFiles",
	"systemPrompt",
	"appendSystemPrompt",
	"tools",
	"noTools",
	"noBuiltinTools",
	"excludeTools",
	"allowUnlistedExtensionTools",
	"lsp",
	"apiKey",
	"flags",
] as const satisfies readonly (keyof WorkerAgentConfig)[];
export const WorkerSpawnOnlyOptionSchema = stringEnum(WORKER_SPAWN_ONLY_OPTIONS);
export type WorkerSpawnOnlyOption = Static<typeof WorkerSpawnOnlyOptionSchema>;

/**
 * Session-level options: what an open asks of its conversation (`--provider`,
 * `--model`, `--thinking`, `--plan`). A spawn opens its first conversation
 * with them; an open that attaches to a live worker has them applied once its
 * client attached, as session commands are.
 */
export const WorkerSessionOptionsSchema = Type.Object(
	{
		provider: Type.Optional(codePoints(1, 256, SINGLE_LINE)),
		/** A model pattern, resolved where the conversation runs; `<pattern>:<thinking>` names a thinking level too. */
		model: Type.Optional(codePoints(1, 1024, SINGLE_LINE)),
		thinking: Type.Optional(RpcThinkingLevelSchema),
		plan: Type.Optional(Type.Boolean()),
	},
	closed,
);
export type WorkerSessionOptions = Static<typeof WorkerSessionOptionsSchema>;

/**
 * What a TUI's open spawns a worker with (`conversation_open`), from its CLI
 * arguments. The worker-level part is the opener's environment and its
 * spawn-only `config`: with the opener's kind, the worker's compatibility
 * key. The rest is the conversation's or the client's own: the working
 * directory, `persist`, the session-level options, and the model scope.
 */
export const WorkerSpawnOptionsSchema = Type.Object(
	{
		/** The opener's environment, which a worker it spawns runs with. Never logged, and never leaves the local socket. */
		env: Type.Record(
			// A name is one printable line (the worker logs names); a value carries no NUL.
			Type.String({ pattern: String.raw`^[^=\u0000-\u001f\u007f]+$` }),
			Type.String({ pattern: String.raw`^[^\u0000]*$` }),
			closed,
		),
		config: WorkerAgentConfigSchema,
		/** The opener's working directory: a new or forked conversation's, and where a session directory defaults from. */
		cwd: PathSchema,
		/** False for `--no-session`: the conversation lives in the worker's memory only (D15). */
		persist: Type.Boolean(),
		session: WorkerSessionOptionsSchema,
		/** `--models`: the opener's model scope patterns, which its client's profile switches scope by. */
		modelScopePatterns: Type.Optional(Type.Array(codePoints(1, 1024, SINGLE_LINE), { maxItems: 256 })),
	},
	closed,
);
export type WorkerSpawnOptions = Static<typeof WorkerSpawnOptionsSchema>;

/** A stored session: its id, and the session directory it is stored in (the opener's default for its cwd otherwise). */
const storedSession = { sessionId: LogSessionIdSchema, sessionDir: Type.Optional(PathSchema) };

/**
 * Why a directory is never registered as a workspace without asking (D17):
 * a filesystem root, the user's home directory (or one containing it), a
 * directory containing Volt's agent directory, or one inside it.
 */
export const SensitiveDirectoryReasonSchema = stringEnum(["root", "home", "contains_agent_dir", "inside_agent_dir"]);
export type SensitiveDirectoryReason = Static<typeof SensitiveDirectoryReasonSchema>;

/**
 * How a TUI's open registers the conversation's directory when no workspace
 * holds it: `shared` (paired devices with access to all workspaces reach
 * it) or `local` (local to this host; no paired device reaches it unless its
 * grant names it).
 */
export const WorkspaceRegistrationSchema = stringEnum(["shared", "local"]);
export type WorkspaceRegistration = Static<typeof WorkspaceRegistrationSchema>;

/** What a TUI opens: a new conversation, one a worker hosts or the store keeps, or a copy of a stored one's branch. */
export const ConversationOpenTargetSchema = Type.Union([
	Type.Object({ kind: Type.Literal("new"), ...storedSession, sessionId: Type.Optional(LogSessionIdSchema) }, closed),
	Type.Object(
		{
			kind: Type.Literal("session"),
			...storedSession,
			/** Run the stored conversation in this directory instead of its own, which the store keeps. */
			cwdOverride: Type.Optional(PathSchema),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("fork"),
			source: Type.Object(storedSession, closed),
			sessionId: Type.Optional(LogSessionIdSchema),
			sessionDir: Type.Optional(PathSchema),
		},
		closed,
	),
]);
export type ConversationOpenTarget = Static<typeof ConversationOpenTargetSchema>;

/**
 * Why a TUI opens a conversation: a session change of its own led it there
 * (`new` for a new session, `resume` for a stored or imported one, `fork` for
 * a fork or clone), from the conversation it left. A worker that starts the
 * conversation for this open reports the reason in its extensions'
 * `session_start`; an open that attaches to a running conversation starts
 * nothing.
 */
export const ConversationOpenCauseSchema = Type.Object(
	{
		reason: stringEnum(["new", "resume", "fork"]),
		/**
		 * The conversation the TUI left, and the session directory it is stored
		 * in. The daemon names it to the conversation's extensions
		 * (`previousSessionRef`) only when it finds it stored there, running in
		 * the same workspace.
		 */
		previous: Type.Optional(Type.Object(storedSession, closed)),
	},
	closed,
);
export type ConversationOpenCause = Static<typeof ConversationOpenCauseSchema>;

const workerSpawnSpecCommon = {
	workerId: Type.String(),
	workspace: Type.Object(
		{
			name: Type.String(),
			path: Type.String(),
			generation: NonNegativeIntegerSchema,
		},
		closed,
	),
	/** The conversation's working directory. */
	cwd: Type.String(),
	/** The root the working directory stays inside: the workspace, or its worktree checkout. */
	root: Type.String(),
	/** Where project resources are read from; the root by default. */
	projectCwd: Type.String(),
	/** The managed worktree's base ref, for the Git context. */
	baseRef: Type.Optional(Type.String()),
};

/**
 * A top-level conversation a worker opens (`worker_open`): the one it was
 * spawned for, after its hello, and each compatible open the daemon routes
 * to it. The daemon resolved the conversation, its placement, and its
 * policy; the worker only opens the log (stored, or for a TUI's `--no-session`
 * in memory) and holds its lock. A phone's open fixes the worker's tool
 * policy; a TUI's carries its spawn-only and session-level options (its
 * environment is the worker process's own). Every top-level conversation of
 * one worker has the same compatibility key: the same opener kind and tool
 * policy, trust, and profile (a phone's), or environment and spawn-only
 * options (a TUI's).
 */
export const WorkerSpawnSpecSchema = Type.Union([
	Type.Object(
		{
			...workerSpawnSpecCommon,
			origin: Type.Literal("phone"),
			/** The stored log the worker opens. */
			session: SessionReferenceSchema,
			/** Fixed for the worker's lifetime (D9). */
			toolPolicy: Type.Object(
				{ tools: Type.Array(Type.String()), allowUnlistedExtensionTools: Type.Boolean() },
				closed,
			),
			projectTrusted: Type.Boolean(),
			profile: Type.Optional(Type.String()),
		},
		closed,
	),
	Type.Object(
		{
			...workerSpawnSpecCommon,
			origin: Type.Literal("tui"),
			/** The stored log the worker opens (in `cwd`), or the id of the in-memory one it creates (D15). */
			session: Type.Union([
				SessionReferenceSchema,
				Type.Object({ sessionId: LogSessionIdSchema, inMemory: Type.Literal(true) }, closed),
			]),
			config: WorkerAgentConfigSchema,
			sessionOptions: WorkerSessionOptionsSchema,
			modelScopePatterns: Type.Optional(Type.Array(Type.String())),
			/**
			 * The opener's client key (the TUI process): the project trust the
			 * worker decided for that TUI's earlier conversations applies to its
			 * later ones of the same project, as in one process before.
			 */
			clientKey: codePoints(1, 128, SINGLE_LINE),
			/**
			 * The opener's session change that led it to the conversation
			 * (`conversation_open.cause`): its extensions' `session_start` has
			 * this reason, and the conversation left when it is a stored one of
			 * the same workspace. Without it, `startup`.
			 */
			sessionStart: Type.Optional(
				Type.Object(
					{
						reason: ConversationOpenCauseSchema.properties.reason,
						previousSessionRef: Type.Optional(SessionReferenceSchema),
					},
					closed,
				),
			),
		},
		closed,
	),
]);
export type WorkerSpawnSpec = Static<typeof WorkerSpawnSpecSchema>;

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
	access: RemoteAccessPresetNameSchema,
	allowedTools: Type.Optional(Type.Never()),
	rpcCapabilities: Type.Optional(Type.Never()),
};
const explicitAccess = {
	access: Type.Optional(Type.Never()),
	allowedTools: Type.Array(Type.String()),
	rpcCapabilities: RemoteCapabilitiesSchema,
};

/**
 * The intents a worker serving a relayed phone forwards to the daemon
 * (`worker_forward`), which executes them against its own state: push targets, workspace registration and
 * worktrees, keep-awake, the web search key, and device log uploads (written
 * under the workspace and audited there).
 */
export const RELAY_INTENT_NAMES = [
	"register_push_target",
	"unregister_workspace",
	"create_worktree",
	"set_keep_awake",
	"set_web_search_key",
	"upload_device_logs",
] as const satisfies readonly BuiltinIntentName[];

/** The queries a worker serving a relayed phone forwards to the daemon. */
export const RELAY_QUERY_NAMES = [
	"sessions",
	"worktrees",
	"host_status",
	"web_search_status",
] as const satisfies readonly QueryName[];

export type RelayIntentName = (typeof RELAY_INTENT_NAMES)[number];
export type RelayQueryName = (typeof RELAY_QUERY_NAMES)[number];
export type ControlRelayFrame =
	| { [K in RelayIntentName]: IntentFrameEnvelope & { type: K; input?: IntentInput<K> } }[RelayIntentName]
	| Extract<QueryFrame, { query: RelayQueryName }>;

/** A relayed phone's intent or query frame, forwarded as the phone sent it. */
export const ControlRelayFrameSchema = Type.Unsafe<ControlRelayFrame>(
	Type.Union([
		...RELAY_INTENT_NAMES.map((name): TSchema => INTENT_FRAME_SCHEMAS[name]),
		...RELAY_QUERY_NAMES.map((name): TSchema => QUERY_FRAME_SCHEMAS[name]),
	]),
);

/** The daemon's outcome for a relayed frame: what the serving worker writes to the phone. */
export const ControlRelayOutcomeSchema = Type.Union([
	AcceptedFrameSchema,
	RejectedFrameSchema,
	ResultFrameSchema,
	QueryErrorFrameSchema,
]);
export type ControlRelayOutcome = Static<typeof ControlRelayOutcomeSchema>;

// ============================================================================
// Hello, ack, fatal, relay preamble
// ============================================================================

/** A base64url nonce or MAC. */
const Base64UrlTokenSchema = codePoints(32, 128, "A-Za-z0-9_\\-");

/**
 * The daemon's first line on every connection, before the client's hello: a
 * fresh random challenge that every proof on the connection covers, so a
 * proof is good for this connection of this daemon only.
 */
export const ControlHelloChallengeSchema = Type.Object(
	{ type: Type.Literal("hello_challenge"), nonce: Base64UrlTokenSchema },
	open,
);
export type ControlHelloChallenge = Static<typeof ControlHelloChallengeSchema>;

/**
 * A hello's proof that its sender holds the role's secret (the pidfile token
 * for a control hello, the spawn's worker token, the offer's relay token),
 * which never crosses the socket: a fresh random `nonce` and `mac` =
 * HMAC-SHA256(secret, JSON ["volt-hello", role, "client", socket path dialed,
 * the connection's challenge, nonce]), base64url.
 */
export const HelloProofSchema = Type.Object({ nonce: Base64UrlTokenSchema, mac: Base64UrlTokenSchema }, closed);
export type HelloProof = Static<typeof HelloProofSchema>;

export const ControlHelloSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("hello"),
			role: Type.Literal("control"),
			protocolVersion: Type.Number(),
			pid: Type.Number(),
			version: Type.String(),
			client: ControlClientKindSchema,
			/** Proof of the per-daemon instance token read from the local pidfile. */
			controlProof: Type.Optional(HelloProofSchema),
			/** Client capabilities. */
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
			/** Proof of the single-use token from the relay_offer. */
			relayProof: HelloProofSchema,
		},
		open,
	),
	Type.Object(
		{
			type: Type.Literal("hello"),
			role: Type.Literal("worker"),
			protocolVersion: Type.Number(),
			/** The worker the daemon spawned. */
			workerId: Type.String(),
			/** Proof of the single-use token the spawn issued; a second hello with it is refused. */
			workerProof: HelloProofSchema,
			pid: Type.Number(),
			version: Type.String(),
		},
		open,
	),
]);
export type HelloMessage = Static<typeof ControlHelloSchema>;

export const ControlHelloAckSchema = Type.Object(
	{
		type: Type.Literal("hello_ack"),
		ok: Type.Boolean(),
		/** Unknown codes from other protocol versions still read as a rejection. */
		error: Type.Optional(openStringEnum(["protocol_mismatch", "shutting_down", "bad_relay_token", "auth_failed"])),
		/** Daemon-assigned; present when ok on a control connection. */
		connectionId: Type.Optional(Type.String()),
		/** Daemon package version. */
		version: Type.Optional(Type.String()),
		protocolVersion: Type.Optional(Type.Number()),
		/**
		 * The daemon's proof of the same secret, on every answer to a hello whose
		 * proof it verified: the hello's MAC with party "daemon", over the same
		 * socket path, challenge, and nonce. A client that sent a proof trusts
		 * no answer without it.
		 */
		daemonProof: Type.Optional(Type.String()),
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

const PhoneRelayPreambleSchema = Type.Object(
	{
		type: Type.Literal("relay_preamble"),
		/** The relayed client: a paired phone. */
		kind: Type.Literal("phone"),
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
		/** Everything the worker needs to serve the stream. */
		authorization: Type.Object(
			{
				...IrohRemoteWorkspaceMetadataSnapshotSchema.properties,
				clientNodeId: Type.String(),
				workspaceName: Type.String(),
				workspacePath: Type.String(),
				/** Headless agent tool grant, for visibility; a TUI-opened worker keeps its own tools (D9). */
				allowedTools: Type.String(),
				rpcGrant: RemoteGrantSchema,
				/** Present when the conversation is bound to a daemon-managed worktree. */
				worktreeId: Type.Optional(Type.String()),
				/** Worktree checkout path: the worker sanitizes with it as the root. */
				worktreePath: Type.Optional(Type.String()),
				/** Registered-workspace-relative git source root for nested repository worktrees. */
				worktreeSourceRootRelativePath: Type.Optional(Type.String()),
			},
			closed,
		),
		/** The daemon's Iroh node id; the worker writes it into the handshake response for the phone's host check. */
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

/**
 * A local TUI's stream (`conversation_open`): the daemon mints it only for a
 * TUI control connection's open, and the worker serves it on the local
 * profile as that TUI's client.
 */
const LocalRelayPreambleSchema = Type.Object(
	{
		type: Type.Literal("relay_preamble"),
		/** The relayed client: a TUI on this host. */
		kind: Type.Literal("local"),
		relayId: Type.String(),
		/** The conversation the TUI opened. */
		sessionId: LogSessionIdSchema,
		/** The TUI process across its connections: its retried intents answer as they did. */
		clientKey: codePoints(1, 128, SINGLE_LINE),
		/** `--models`: the TUI's model scope patterns. */
		modelScopePatterns: Type.Optional(Type.Array(Type.String())),
		/** The session-level options of an open that attached to a live worker: applied once the TUI attached. */
		apply: Type.Optional(WorkerSessionOptionsSchema),
	},
	closed,
);

/** The first line a worker reads on a relay it redeemed: who the client is, and how to serve it. */
export const ControlRelayPreambleSchema = Type.Union([PhoneRelayPreambleSchema, LocalRelayPreambleSchema]);
export type RelayPreamble = Static<typeof ControlRelayPreambleSchema>;
export type PhoneRelayPreamble = Extract<RelayPreamble, { kind: "phone" }>;
export type LocalRelayPreamble = Extract<RelayPreamble, { kind: "local" }>;

// ============================================================================
// Requests (client -> daemon)
// ============================================================================

const withId = <T extends string, P extends Record<string, TSchema>>(type: T, properties: P) =>
	Type.Object({ type: Type.Literal(type), id: Type.String(), ...properties }, closed);

export const CONTROL_REQUEST_SCHEMAS = {
	status: withId("status", {}),
	shutdown: withId("shutdown", {}),
	/** Worker: path-free authoritative Git state of a session it hosts. */
	change_observe: withId("change_observe", {
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
			access: Type.Optional(RemoteAccessPresetNameSchema),
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
	}),
	/** A theme name; the daemon resolves it and broadcasts a theme_snapshot. */
	theme_set: withId("theme_set", { theme: Type.String() }),
	/** Hold or release the host sleep-prevention assertion. */
	keep_awake_set: withId("keep_awake_set", { enabled: Type.Boolean() }),
	/**
	 * TUI: open a conversation in a worker (Phase 7 plan §1). The daemon
	 * resolves its workspace from the conversation's working directory
	 * (registering that directory when no workspace holds it, D17), then
	 * attaches the TUI to the live worker hosting it or spawns one with
	 * `spawn`. Answered by `conversation_opened`.
	 */
	conversation_open: withId("conversation_open", {
		target: ConversationOpenTargetSchema,
		spawn: WorkerSpawnOptionsSchema,
		/** The TUI process across its connections; a `--no-session` conversation admits only the client that opened it. */
		clientKey: codePoints(1, 128, SINGLE_LINE),
		/**
		 * How to register the conversation's directory when no workspace holds
		 * it: required for a sensitive one (else `workspace_confirmation_required`),
		 * `shared` by default for any other; ignored when a workspace holds it.
		 */
		workspaceRegistration: Type.Optional(WorkspaceRegistrationSchema),
		/** The TUI's own session change that led it to the conversation. */
		cause: Type.Optional(ConversationOpenCauseSchema),
	}),
	/**
	 * TUI: its answer to `conversation_host_request`, on the connection that
	 * was asked; no `response` when it closed the question without one.
	 * Answered by `ok`.
	 */
	conversation_host_response: withId("conversation_host_response", {
		requestId: Type.String({ maxLength: 64 }),
		response: Type.Optional(HostResponseSchema),
	}),
	/**
	 * Worker: a question about a TUI-opened conversation it is opening (the
	 * project trust prompt, or a `project_trust` hook's dialog), for the TUI
	 * whose open it is. Answered by `worker_host_response` once that TUI
	 * answered, or at once without a `response` when it cannot (it left, or
	 * the conversation is not one opening for a TUI). The daemon's wait for
	 * the conversation's `worker_ready` pauses while the TUI is asked.
	 */
	worker_host_request: withId("worker_host_request", {
		sessionId: LogSessionIdSchema,
		request: HostPromptRequestSchema,
	}),
	/**
	 * Worker: a conversation `worker_open` sent is open and its log locked;
	 * offers may follow. The first makes the worker live.
	 */
	worker_ready: withId("worker_ready", { sessionId: LogSessionIdSchema }),
	/**
	 * Worker: a conversation `worker_open` sent could not open; the opens
	 * waiting for it fail with this outcome. A worker whose first one failed exits.
	 */
	worker_open_failed: withId("worker_open_failed", {
		sessionId: LogSessionIdSchema,
		/** A phone handshake outcome, such as conversation_locked or session_unavailable. */
		outcome: Type.Optional(stringEnum(IROH_REMOTE_HOST_HANDSHAKE_FAILURE_OUTCOMES)),
		message: codePoints(0, 1024),
	}),
	/** Worker: the conversations it hosts that are active now (a turn, running work, or a hold). */
	worker_activity: withId("worker_activity", {
		activeSessionIds: Type.Array(LogSessionIdSchema, { maxItems: 256 }),
	}),
	/** Worker: claim a conversation before opening it. Refused (`claimed`) when another worker hosts it. */
	worker_hosts: withId("worker_hosts", {
		sessionId: LogSessionIdSchema,
		kind: WorkerHostKindSchema,
		/** The hosted conversation the claimed one belongs to: a child's parent, a sibling's source, a move's source. */
		parentSessionId: LogSessionIdSchema,
		/** The conversation lives in the worker's memory, in no store: only a `--no-session` worker hosts one. */
		inMemory: Type.Optional(Type.Literal(true)),
	}),
	/**
	 * Worker: it closed a conversation it hosts, and released its log. A
	 * top-level conversation goes last of its group (what it claimed closes first).
	 */
	worker_released: withId("worker_released", { sessionId: LogSessionIdSchema }),
	/**
	 * Worker: a relayed phone's daemon-backed intent or query, run with that
	 * relay's grant. Only for the worker's own relays.
	 */
	worker_forward: withId("worker_forward", { relayId: Type.String(), frame: ControlRelayFrameSchema }),
	/** Worker: a relayed phone's completion push, for the worker's own relay. */
	worker_notification_delivery: withId("worker_notification_delivery", {
		relayId: Type.String(),
		notification: IrohRemotePushNotificationSchema,
	}),
	/** Worker: a relayed client moved from a conversation it hosts to `to`; the change association follows. */
	worker_moved: withId("worker_moved", { from: LogSessionIdSchema, to: LogSessionIdSchema }),
	/** Worker: a relayed phone was redirected to `sessionId`, its last session in the workspace now. */
	worker_last_session: withId("worker_last_session", { relayId: Type.String(), sessionId: LogSessionIdSchema }),
	/** Worker: whether a relay's client still holds the authority it was relayed with (before each frame acts). */
	worker_authority: withId("worker_authority", { relayId: Type.String() }),
	/** Worker: its answer to `worker_stop`, from its own idle check when the stop arrived. */
	worker_stop_result: withId("worker_stop_result", {
		stopId: Type.String(),
		outcome: stringEnum(["stopped", "refused_active"]),
	}),
	/**
	 * Worker: its answer to `worker_close`, from the group's idle check when
	 * the close arrived; once `closed`, it closes the group and releases each
	 * of its conversations.
	 */
	worker_close_result: withId("worker_close_result", {
		closeId: Type.String(),
		outcome: stringEnum(["closed", "refused_active"]),
	}),
	/**
	 * Worker: restore the managed checkout `path` of a session of its
	 * workspace, and pin it until `worker_worktree_release` or the end of the
	 * connection. Answered by `worker_worktree_pinned`.
	 */
	worker_worktree_restore: withId("worker_worktree_restore", {
		path: codePoints(1, 4096),
		sessionRef: SessionReferenceSchema,
	}),
	/** Worker: release a pin `worker_worktree_restore` took. */
	worker_worktree_release: withId("worker_worktree_release", { pinId: Type.String({ maxLength: 64 }) }),
} as const;

/** The requests a worker connection may send; a control connection may send none of them. */
export const WORKER_REQUEST_TYPES = [
	"worker_host_request",
	"worker_ready",
	"worker_open_failed",
	"worker_activity",
	"worker_hosts",
	"worker_released",
	"worker_forward",
	"worker_notification_delivery",
	"worker_moved",
	"worker_last_session",
	"worker_authority",
	"worker_stop_result",
	"worker_close_result",
	"worker_worktree_restore",
	"worker_worktree_release",
] as const satisfies readonly (keyof typeof CONTROL_REQUEST_SCHEMAS)[];
export type WorkerRequestType = (typeof WORKER_REQUEST_TYPES)[number];

export const ControlRequestSchema = Type.Union([
	CONTROL_REQUEST_SCHEMAS.status,
	CONTROL_REQUEST_SCHEMAS.shutdown,
	CONTROL_REQUEST_SCHEMAS.change_observe,
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
	CONTROL_REQUEST_SCHEMAS.conversation_open,
	CONTROL_REQUEST_SCHEMAS.conversation_host_response,
	CONTROL_REQUEST_SCHEMAS.worker_host_request,
	CONTROL_REQUEST_SCHEMAS.worker_ready,
	CONTROL_REQUEST_SCHEMAS.worker_open_failed,
	CONTROL_REQUEST_SCHEMAS.worker_activity,
	CONTROL_REQUEST_SCHEMAS.worker_hosts,
	CONTROL_REQUEST_SCHEMAS.worker_released,
	CONTROL_REQUEST_SCHEMAS.worker_forward,
	CONTROL_REQUEST_SCHEMAS.worker_notification_delivery,
	CONTROL_REQUEST_SCHEMAS.worker_moved,
	CONTROL_REQUEST_SCHEMAS.worker_last_session,
	CONTROL_REQUEST_SCHEMAS.worker_authority,
	CONTROL_REQUEST_SCHEMAS.worker_stop_result,
	CONTROL_REQUEST_SCHEMAS.worker_close_result,
	CONTROL_REQUEST_SCHEMAS.worker_worktree_restore,
	CONTROL_REQUEST_SCHEMAS.worker_worktree_release,
]);
export type ControlRequest = Static<typeof ControlRequestSchema>;

// ============================================================================
// Responses (daemon -> client)
// ============================================================================

export const CONTROL_RESPONSE_SCHEMAS = {
	ok: withId("ok", {}),
	error: withId("error", { code: Type.String(), message: Type.String() }),
	status_result: withId("status_result", {
		version: Type.String(),
		protocolVersion: Type.Number(),
		pid: Type.Number(),
		startedAtMs: Type.Number(),
		environment: DaemonEnvironmentStatusSchema,
		/** Optional feature flags. */
		capabilities: Type.Optional(Type.Array(Type.String())),
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
		/** Conversation workers the daemon supervises. */
		workers: Type.Array(ControlWorkerStatusSchema),
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
	/**
	 * The conversation a TUI opened: dial a relay hello with `relayId` and
	 * `relayToken` (single-use, expiring after 10 seconds) within that time to
	 * reach it, and speak protocol 1 on the local profile once it is acked.
	 */
	conversation_opened: withId("conversation_opened", {
		relayId: Type.String(),
		relayToken: Type.String(),
		sessionId: LogSessionIdSchema,
		/** `created` for a new or forked conversation; `resumed` otherwise. */
		selection: stringEnum(["created", "resumed"]),
		workspaceName: Type.String(),
		/** The workspace is local to this host: no paired device reaches it unless its grant names it (D17). */
		localOnly: Type.Optional(Type.Literal(true)),
		/**
		 * Whether this open spawned the worker. Otherwise the conversation runs
		 * in a live worker: one it was routed into (with the same spawn-only
		 * options), or the one it was open in already, which keeps its own.
		 */
		spawned: Type.Boolean(),
		/** The open's spawn-only options that differ from those of the worker it was open in already, which kept its own. */
		ignoredOptions: Type.Array(WorkerSpawnOnlyOptionSchema),
	}),
	/**
	 * A TUI's open of a conversation in a sensitive directory no workspace
	 * holds: the daemon registers it only once asked how (`conversation_open`
	 * again with `workspaceRegistration`). Nothing was opened or registered.
	 */
	workspace_confirmation_required: withId("workspace_confirmation_required", {
		/** The directory that would be registered (its real path). */
		directory: Type.String(),
		reason: SensitiveDirectoryReasonSchema,
	}),
	/** The TUI's answer to `worker_host_request`; none when it gave none, or could not be asked. */
	worker_host_response: withId("worker_host_response", { response: Type.Optional(HostResponseSchema) }),
	worker_forward_result: withId("worker_forward_result", { frame: ControlRelayOutcomeSchema }),
	worker_authority_result: withId("worker_authority_result", { authority: WorkerRelayAuthoritySchema }),
	/** The checkout a worker restored is pinned until it releases `pinId`. */
	worker_worktree_pinned: withId("worker_worktree_pinned", { pinId: Type.String() }),
	/** The status of a worker's `worker_notification_delivery`. */
	relay_push_delivery_result: withId("relay_push_delivery_result", {
		status: IrohRemotePushNotificationDeliveryStatusSchema,
	}),
} as const;

export const ControlResponseSchema = Type.Union([
	CONTROL_RESPONSE_SCHEMAS.ok,
	CONTROL_RESPONSE_SCHEMAS.error,
	CONTROL_RESPONSE_SCHEMAS.status_result,
	CONTROL_RESPONSE_SCHEMAS.keep_awake_result,
	CONTROL_RESPONSE_SCHEMAS.clients_result,
	CONTROL_RESPONSE_SCHEMAS.client_access_updated,
	CONTROL_RESPONSE_SCHEMAS.worktree_result,
	CONTROL_RESPONSE_SCHEMAS.worktrees_result,
	CONTROL_RESPONSE_SCHEMAS.worktree_resolve_result,
	CONTROL_RESPONSE_SCHEMAS.worktree_prune_result,
	CONTROL_RESPONSE_SCHEMAS.pair_started,
	CONTROL_RESPONSE_SCHEMAS.conversation_opened,
	CONTROL_RESPONSE_SCHEMAS.workspace_confirmation_required,
	CONTROL_RESPONSE_SCHEMAS.worker_host_response,
	CONTROL_RESPONSE_SCHEMAS.worker_forward_result,
	CONTROL_RESPONSE_SCHEMAS.worker_authority_result,
	CONTROL_RESPONSE_SCHEMAS.worker_worktree_pinned,
	CONTROL_RESPONSE_SCHEMAS.relay_push_delivery_result,
]);
export type ControlResponse = Static<typeof ControlResponseSchema>;

// ============================================================================
// Events (daemon -> control clients, unsolicited)
// ============================================================================

const event = <T extends string, P extends Record<string, TSchema>>(type: T, properties: P) =>
	Type.Object({ type: Type.Literal(type), ...properties }, closed);

export const CONTROL_EVENT_SCHEMAS = {
	/** The redeemed relay's preamble is of the offer's client kind. */
	relay_offer: Type.Union([
		event("relay_offer", {
			/** The relayed client: a paired phone. */
			clientKind: Type.Literal("phone"),
			relayId: Type.String(),
			/** Single-use; expires after 10 seconds. */
			relayToken: Type.String(),
			workspaceName: Type.String(),
			sessionId: Type.String(),
			clientNodeId: Type.String(),
			connectionId: Type.String(),
			streamId: Type.String(),
		}),
		event("relay_offer", {
			/** The relayed client: a TUI on this host, to a worker only. */
			clientKind: Type.Literal("local"),
			relayId: Type.String(),
			/** Single-use; expires after 10 seconds. */
			relayToken: Type.String(),
			workspaceName: Type.String(),
			sessionId: LogSessionIdSchema,
		}),
	]),
	relay_closed: event("relay_closed", { relayId: Type.String(), reason: ControlRelayCloseReasonSchema }),
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
	/**
	 * To a TUI: a question the worker opening its conversation asks (the
	 * project trust prompt, or a `project_trust` hook's dialog), sent only to
	 * the connection whose `conversation_open` that is. Answer it with
	 * `conversation_host_response`; it ends with that open.
	 */
	conversation_host_request: event("conversation_host_request", {
		requestId: Type.String(),
		sessionId: LogSessionIdSchema,
		request: HostPromptRequestSchema,
	}),
	/**
	 * To a worker: a top-level conversation it opens, in a host of its own:
	 * the one it was spawned for after its hello, then each compatible open
	 * the daemon routes to it (D11). Answered by `worker_ready` or
	 * `worker_open_failed`.
	 */
	worker_open: event("worker_open", { spec: WorkerSpawnSpecSchema }),
	/**
	 * To a worker: stop. Answered by `worker_stop_result`. A worker that is
	 * active may refuse a stop that is not forced; a forced stop cannot be
	 * refused and aborts a turn still running after 60 s.
	 */
	worker_stop: event("worker_stop", { stopId: Type.String(), reason: WorkerStopReasonSchema, force: Type.Boolean() }),
	/**
	 * To a worker: close the top-level conversation `sessionId` and the
	 * conversations it claimed (its group), leaving its others serving.
	 * Answered by `worker_close_result`. A group that is active may refuse a
	 * close that is not forced (retention); a forced close cannot be refused,
	 * ends the group's streams, and aborts a turn still running after 60 s (at
	 * once for lost authority).
	 */
	worker_close: event("worker_close", {
		closeId: Type.String(),
		sessionId: LogSessionIdSchema,
		reason: WorkerStopReasonSchema,
		force: Type.Boolean(),
	}),
	/**
	 * To a worker: the relayed client lost its authority. The worker ends the
	 * stream with `fatal{loss}` as its last frame; the daemon closes the relay
	 * itself if the worker has not within 2 s.
	 */
	relay_authority: event("relay_authority", { relayId: Type.String(), loss: WorkerAuthorityLossSchema }),
} as const;

export const ControlEventSchema = Type.Union([
	CONTROL_EVENT_SCHEMAS.relay_offer,
	CONTROL_EVENT_SCHEMAS.relay_closed,
	CONTROL_EVENT_SCHEMAS.theme_snapshot,
	CONTROL_EVENT_SCHEMAS.keep_awake_changed,
	CONTROL_EVENT_SCHEMAS.pairing_progress,
	CONTROL_EVENT_SCHEMAS.daemon_shutdown,
	CONTROL_EVENT_SCHEMAS.conversation_host_request,
	CONTROL_EVENT_SCHEMAS.worker_open,
	CONTROL_EVENT_SCHEMAS.worker_stop,
	CONTROL_EVENT_SCHEMAS.worker_close,
	CONTROL_EVENT_SCHEMAS.relay_authority,
]);
export type ControlEvent = Static<typeof ControlEventSchema>;
