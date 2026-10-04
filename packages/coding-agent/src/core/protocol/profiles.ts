/**
 * Subscriber profiles (RFC §6.2): what a connection sees of the conversations
 * it subscribes to, the intents and queries it may use, and the bounds its
 * frames keep. A profile is chosen when a connection is admitted and never
 * changes for its life; the client cannot widen it.
 *
 * The local profile (stdio RPC, JSON mode, SDK loopback) has full fidelity:
 * every core entry the client fold reads, payloads whole, no redaction, every
 * intent and query, every host request the client accepts, and unbounded
 * snapshots and replay.
 *
 * The remote profile (paired devices over Iroh, directly or relayed through a
 * TUI) has transcript fidelity: message-like entries carry their transcript
 * view only, state entries their payloads, and custom and product entries
 * stay on the host. Every frame is redacted at the connection's send (see
 * remote-redaction.ts). Intents and queries are the remote-safe ones within
 * the device's grant, intents act only on the conversation the stream is
 * bound to, and its subagent children are observe-only. Snapshots carry a
 * bounded tail of the active branch (older entries are paged with
 * `history`), and a resume further back than the replay bound is answered
 * with a snapshot instead.
 */

import {
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
	DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	type HostRequestKind,
	IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	type RemoteCapability,
	type RemoteGrant,
} from "@hansjm10/volt-protocol";
import { createIrohRemoteProjectionSanitizer } from "../remote/iroh/sanitizer.ts";
import type { CommittedSessionEntry } from "../session-manager.ts";
import { type IntentProfile, LOCAL_INTENT_PROFILE } from "./intents/types.ts";
import {
	createRemoteRedactor,
	type FrameRedactor,
	IDENTITY_REDACTOR,
	type RemoteRedactionOptions,
} from "./remote-redaction.ts";

export interface ProfileLimits {
	/** Most entries a snapshot carries; older ones are paged with `history`. */
	readonly snapshotTail: number;
	/** Most entries a resume replays before it is answered with a snapshot instead. */
	readonly maxReplay: number;
	/** Queued live bytes past which a subscription drops its queued live frames and resets. */
	readonly liveQueueBytes: number;
	/** Most bytes of a streaming assistant message a live reset carries. */
	readonly assistantSnapshotBytes: number;
	/** Longest frame, in bytes, in either direction. */
	readonly frameBytes: number;
	/** Most Unicode scalars of text one transcript view carries. */
	readonly textScalars: number;
	/** Most subscriptions one connection holds at once. */
	readonly subscriptions: number;
	/**
	 * Snapshots and `history` pages a connection may request in a burst; one
	 * more becomes available every `readRefillMs`.
	 */
	readonly readBurst: number;
	readonly readRefillMs: number;
	/**
	 * Bytes a connection may queue for a client that reads slower than the
	 * host writes; past it the connection's stream is reset, and the client
	 * resumes after its position. Without a bound, the host's agent loop
	 * waits for the client instead.
	 */
	readonly sendQueueBytes?: number;
}

export interface Profile {
	readonly name: "local" | "remote";
	/** `full`: payloads whole; `transcript`: message-like entries as their view only. */
	readonly fidelity: "full" | "transcript";
	/** Whether the profile projects `entry`; hidden entries leave gaps the client's position covers with `head`. */
	includes(entry: CommittedSessionEntry): boolean;
	/** A redactor for one connection: every frame passes through it at the connection's send. */
	redactor(): FrameRedactor;
	/**
	 * The log value a view or `content` part is made from. The remote profile
	 * redacts its paths first, so cutting the text to a bound never leaves
	 * part of a root behind; the frame redactor then finds nothing more.
	 */
	source<T>(value: T): T;
	readonly limits: ProfileLimits;
	/** The host request kinds a client that accepts `accepts` is asked. */
	hostRequests(accepts: readonly HostRequestKind[]): ReadonlySet<HostRequestKind>;
	/** The profile intent and query admission runs on. */
	readonly intents: IntentProfile;
	/**
	 * Whether a connection on this profile may target the conversation `id`
	 * with intents and subscriptions. A remote connection also reads the
	 * subagent children of its bound conversation, observe-only.
	 */
	conversations(id: string): boolean;
	/** The conversation a remote connection is bound to; none for local connections and workspace streams. */
	readonly bound?: string;
}

/** Core entries the client fold reads besides the public ones; product entries are host records. */
const LOCAL_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"message",
	"client_input_receipt",
	"client_input_queued",
	"client_input_state",
	"thinking_level_change",
	"fast_mode_change",
	"model_change",
	"planning_state_change",
	"compaction",
	"branch_summary",
	"custom",
	"custom_message",
	"label",
	"session_info",
	"leaf",
	"subagent_spawn",
	"forked_from",
]);

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/** Full fidelity for clients in the host's own trust domain: stdio RPC, JSON mode, and the SDK loopback. */
export const localProfile: Profile = Object.freeze({
	name: "local",
	fidelity: "full",
	includes: (entry: CommittedSessionEntry) => LOCAL_ENTRY_TYPES.has(entry.type),
	redactor: () => IDENTITY_REDACTOR,
	source: <T>(value: T): T => value,
	limits: Object.freeze({
		snapshotTail: UNBOUNDED,
		maxReplay: UNBOUNDED,
		liveQueueBytes: 64 * 1024 * 1024,
		assistantSnapshotBytes: UNBOUNDED,
		frameBytes: UNBOUNDED,
		textScalars: 16_000,
		subscriptions: 1_024,
		readBurst: UNBOUNDED,
		readRefillMs: 0,
	}),
	hostRequests: (accepts: readonly HostRequestKind[]) => new Set(accepts),
	intents: LOCAL_INTENT_PROFILE,
	conversations: () => true,
});

/** State entries a remote client folds: their payloads, redacted, reach it. */
const REMOTE_STATE_ENTRY_TYPES: ReadonlySet<string> = new Set([
	"client_input_receipt",
	"client_input_queued",
	"client_input_state",
	"thinking_level_change",
	"fast_mode_change",
	"model_change",
	"planning_state_change",
	"label",
	"session_info",
	"leaf",
	"subagent_spawn",
	"forked_from",
]);

/**
 * The transcript role of a custom message remote clients see, or undefined
 * for the custom messages that stay on the host.
 */
export function getRemoteVisibleCustomMessageRole(
	customType: string,
	display: boolean,
): "assistant" | "system" | undefined {
	if (!display) return undefined;
	switch (customType) {
		case "review":
			return "assistant";
		case "background_job_notification":
		case "subagent_recovery":
			return "system";
		default:
			return undefined;
	}
}

/** Whether a remote client sees `entry`: messages, summaries, remote-visible custom messages, and state entries. */
function remoteIncludes(entry: CommittedSessionEntry): boolean {
	switch (entry.type) {
		case "message":
			return (
				entry.message.role !== "custom" ||
				getRemoteVisibleCustomMessageRole(entry.message.customType, entry.message.display) !== undefined
			);
		case "custom_message":
			return getRemoteVisibleCustomMessageRole(entry.customType, entry.display) !== undefined;
		case "compaction":
		case "branch_summary":
			return true;
		default:
			return REMOTE_STATE_ENTRY_TYPES.has(entry.type);
	}
}

/** The capability a remote client needs to be asked a host request of `kind`. */
function hostRequestCapability(kind: HostRequestKind): RemoteCapability {
	switch (kind) {
		case "approval":
			return "host.manage.v1";
		case "mcp_auth":
			return "integrations.manage.v1";
		default:
			return "conversation.control.v1";
	}
}

/** The remote profile's bounds. */
export const REMOTE_PROFILE_LIMITS: ProfileLimits = Object.freeze({
	snapshotTail: 200,
	maxReplay: 1_000,
	liveQueueBytes: DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
	assistantSnapshotBytes: DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
	frameBytes: DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	textScalars: IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	subscriptions: 16,
	readBurst: 16,
	readRefillMs: 2_000,
	sendQueueBytes: 64 * 1024 * 1024,
});

export interface RemoteProfileOptions {
	/** The device's grant as admitted; a changed grant ends the connection (`fatal{revoked}`). */
	readonly grant: RemoteGrant;
	/** The roots redacted from every frame, and the path that replaces them. */
	readonly redaction: Pick<
		RemoteRedactionOptions,
		"workspacePath" | "remoteWorkspacePath" | "additionalRedactedPaths"
	>;
	/** The conversation the stream is bound to; none for workspace streams. */
	readonly bound?: string;
	/** Overrides of the default bounds, for tests. */
	readonly limits?: Partial<ProfileLimits>;
}

/** The profile of a paired device's stream. */
export function remoteProfile(options: RemoteProfileOptions): Profile {
	const limits: ProfileLimits = Object.freeze({ ...REMOTE_PROFILE_LIMITS, ...options.limits });
	const granted = new Set(options.grant.capabilities);
	const bound = options.bound;
	const sanitizer = createIrohRemoteProjectionSanitizer(options.redaction);
	return Object.freeze({
		name: "remote",
		fidelity: "transcript",
		includes: remoteIncludes,
		redactor: () =>
			createRemoteRedactor({
				...options.redaction,
				frameBytes: limits.frameBytes,
				textScalars: limits.textScalars,
				assistantSnapshotBytes: limits.assistantSnapshotBytes,
			}),
		source: <T>(value: T): T => sanitizer.sanitizeValue(value) as T,
		limits,
		hostRequests: (accepts: readonly HostRequestKind[]) =>
			new Set(accepts.filter((kind) => granted.has(hostRequestCapability(kind)))),
		intents: { name: "remote" as const, grant: options.grant },
		conversations: (id: string) => bound !== undefined && id === bound,
		...(bound === undefined ? {} : { bound }),
	});
}
