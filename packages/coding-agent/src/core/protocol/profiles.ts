/**
 * Subscriber profiles (RFC §6.2): what a connection sees of the conversations
 * it subscribes to, the intents and queries it may use, and the bounds its
 * frames keep. A profile is chosen when a connection is admitted and never
 * changes for its life; the client cannot widen it.
 *
 * What a profile projects of a log is its {@link Projection}; profiles that
 * project alike share one, and with it the projected entries a conversation
 * caches for it.
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
 * bound to, and the children its work links (subagent children, review
 * passes that read no code-host context) are observe-only. Snapshots carry a
 * bounded tail of the active branch (older entries are paged with
 * `history`), and a resume further back than the replay bound is answered
 * with a snapshot instead. Every remote profile whose sanitizer redacts
 * alike, within the same bounds, shares one projection.
 */

import {
	DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
	DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
	DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	HISTORY_PAGE_MAX_ENTRIES,
	type HostRequestKind,
	IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	PRESENTATION_MAX_SERIALIZED_BYTES,
	PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES,
	type RemoteCapability,
	type RemoteGrant,
} from "@hansjm10/volt-protocol";
import { WORK_NOTICE_CUSTOM_TYPE } from "@hansjm10/volt-protocol/work";
import { createIrohRemoteProjectionSanitizer, type IrohRemoteProjectionSanitizer } from "../remote/iroh/sanitizer.ts";
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
	/**
	 * Entries one read covers: a resume costs a read per this many entries it
	 * replays, and a closed child's log a read per this many entries it holds.
	 */
	readonly entriesPerRead: number;
	/** Most entries a resume replays before it is answered with a snapshot instead. */
	readonly maxReplay: number;
	/** Queued live bytes past which a subscription drops its queued live frames and resets. */
	readonly liveQueueBytes: number;
	/** Most bytes of a streaming assistant message a live reset carries. */
	readonly assistantSnapshotBytes: number;
	/** Longest frame, in bytes, in either direction. */
	readonly frameBytes: number;
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

/** The bounds of what a projection makes of an entry. */
export interface ProjectionBounds {
	/** Most Unicode scalars of text one transcript view carries. */
	readonly textScalars: number;
	/** Largest tool or message presentation, as serialized JSON in UTF-8 bytes; a larger one is fitted or generic. */
	readonly presentationBytes: number;
}

/**
 * How a log projects for a kind of subscriber (RFC §4.3): the entries it
 * shows, their fidelity, the source their views are made from, and the
 * bounds they keep. A projected entry is a pure function of the log before
 * it, the projection, and the presenter set, so it is cached by projection.
 */
export interface Projection extends ProjectionBounds {
	/** `full`: payloads whole; `transcript`: message-like entries as their view only. */
	readonly fidelity: "full" | "transcript";
	/** Whether the projection shows `entry`; hidden entries leave gaps the client's position covers with `head`. */
	includes(entry: CommittedSessionEntry): boolean;
	/**
	 * The log value a view or `content` part is made from. The remote
	 * projection redacts its paths first, so cutting the text to a bound never
	 * leaves part of a root behind; the frame redactor then finds nothing more.
	 */
	source<T>(value: T): T;
	/**
	 * `source` for text the host cut to a bound, ending in "…": the remote
	 * projection also drops the start of a root the cut left behind.
	 */
	sourceCut(text: string): string;
}

export interface Profile {
	readonly name: "local" | "remote";
	/** What the profile's subscriptions and log reads project. */
	readonly projection: Projection;
	/** A redactor for one connection: every frame passes through it at the connection's send. */
	redactor(): FrameRedactor;
	readonly limits: ProfileLimits;
	/** The host request kinds a client that accepts `accepts` is asked. */
	hostRequests(accepts: readonly HostRequestKind[]): ReadonlySet<HostRequestKind>;
	/** The profile intent and query admission runs on. */
	readonly intents: IntentProfile;
	/**
	 * Whether a connection on this profile may target the conversation `id`
	 * with intents and subscriptions. `linkedFrom` names the conversation
	 * whose work links `id` as a child (directly or through linked children):
	 * a remote connection reads the children its bound conversation links,
	 * observe-only, and no other conversation.
	 */
	conversations(id: string, linkedFrom?: string): boolean;
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
	"forked_from",
	"work_started",
	"work_checkpoint",
	"work_finished",
]);

const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/** Full fidelity, unredacted. */
const LOCAL_PROJECTION: Projection = Object.freeze({
	fidelity: "full",
	includes: (entry: CommittedSessionEntry) => LOCAL_ENTRY_TYPES.has(entry.type),
	source: <T>(value: T): T => value,
	sourceCut: (text: string): string => text,
	textScalars: 16_000,
	presentationBytes: PRESENTATION_MAX_SERIALIZED_BYTES,
});

/** Full fidelity for clients in the host's own trust domain: stdio RPC, JSON mode, and the SDK loopback. */
export const localProfile: Profile = Object.freeze({
	name: "local",
	projection: LOCAL_PROJECTION,
	redactor: () => IDENTITY_REDACTOR,
	limits: Object.freeze({
		snapshotTail: UNBOUNDED,
		entriesPerRead: UNBOUNDED,
		maxReplay: UNBOUNDED,
		liveQueueBytes: 64 * 1024 * 1024,
		assistantSnapshotBytes: UNBOUNDED,
		frameBytes: UNBOUNDED,
		subscriptions: 1_024,
		readBurst: UNBOUNDED,
		readRefillMs: 0,
	}),
	hostRequests: (accepts: readonly HostRequestKind[]) => new Set(accepts),
	intents: LOCAL_INTENT_PROFILE,
	conversations: () => true,
});

/**
 * State entries a remote client folds: their payloads, redacted, reach it.
 * Work entries carry no input, child locator, output, or result data
 * (projection/entries.ts); output is read with `work_output`. A work notice
 * is a system message whose text is rebuilt from its details, never its
 * content (projection/transcript.ts).
 */
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
	"forked_from",
	"work_started",
	"work_checkpoint",
	"work_finished",
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
		case WORK_NOTICE_CUSTOM_TYPE:
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

/**
 * The capability a remote client needs to be asked a host request of `kind`;
 * none for a provider sign-in, which a remote client is never asked.
 */
function hostRequestCapability(kind: HostRequestKind): RemoteCapability | undefined {
	switch (kind) {
		case "approval":
			return "host.manage.v1";
		case "mcp_auth":
			return "integrations.manage.v1";
		case "provider_auth":
			return undefined;
		default:
			return "conversation.control.v1";
	}
}

/** The remote profile's bounds. */
export const REMOTE_PROFILE_LIMITS: ProfileLimits = Object.freeze({
	snapshotTail: 100,
	entriesPerRead: HISTORY_PAGE_MAX_ENTRIES,
	maxReplay: 1_000,
	liveQueueBytes: DEFAULT_CONVERSATION_PROJECTION_MAX_QUEUED_BYTES,
	assistantSnapshotBytes: DEFAULT_CONVERSATION_PROJECTION_MAX_ASSISTANT_SNAPSHOT_SERIALIZED_BYTES,
	frameBytes: DEFAULT_IROH_RPC_MAX_LINE_BYTES,
	subscriptions: 16,
	readBurst: 16,
	readRefillMs: 2_000,
	sendQueueBytes: 64 * 1024 * 1024,
});

/** The remote projection's bounds. */
export const REMOTE_PROJECTION_BOUNDS: ProjectionBounds = Object.freeze({
	textScalars: IROH_REMOTE_TRANSCRIPT_TEXT_MAX_SCALARS,
	presentationBytes: PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES,
});

/** Overrides of a remote profile's bounds and its projection's, for tests. */
export type RemoteProfileLimits = Partial<ProfileLimits & ProjectionBounds>;

/** Most remote projections kept for reuse; one serves every stream that redacts alike. */
const REMOTE_PROJECTIONS_MAX = 32;

/** Remote projections by what they redact and their bounds, the least recently used first. */
const remoteProjections = new Map<string, Projection>();

/**
 * The remote projection of what `sanitizer` redacts within `bounds`: the one
 * every profile that redacts alike shares. The key is the sanitizer's own
 * resolved redaction, real paths included, so a retargeted symlink projects
 * anew.
 */
function remoteProjection(sanitizer: IrohRemoteProjectionSanitizer, bounds: ProjectionBounds): Projection {
	const key = JSON.stringify([sanitizer.redaction, bounds.textScalars, bounds.presentationBytes]);
	const found = remoteProjections.get(key);
	if (found) {
		remoteProjections.delete(key);
		remoteProjections.set(key, found);
		return found;
	}
	const projection: Projection = Object.freeze({
		fidelity: "transcript",
		includes: remoteIncludes,
		source: <T>(value: T): T => sanitizer.sanitizeValue(value) as T,
		sourceCut: (text: string): string => sanitizer.sanitizeCutText(text),
		textScalars: bounds.textScalars,
		presentationBytes: bounds.presentationBytes,
	});
	remoteProjections.set(key, projection);
	for (const oldest of remoteProjections.keys()) {
		if (remoteProjections.size <= REMOTE_PROJECTIONS_MAX) break;
		remoteProjections.delete(oldest);
	}
	return projection;
}

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
	readonly limits?: RemoteProfileLimits;
}

/** The profile of a paired device's stream. */
export function remoteProfile(options: RemoteProfileOptions): Profile {
	const {
		textScalars = REMOTE_PROJECTION_BOUNDS.textScalars,
		presentationBytes = REMOTE_PROJECTION_BOUNDS.presentationBytes,
		...overrides
	} = options.limits ?? {};
	const limits: ProfileLimits = Object.freeze({ ...REMOTE_PROFILE_LIMITS, ...overrides });
	const granted = new Set(options.grant.capabilities);
	const bound = options.bound;
	const projection = remoteProjection(createIrohRemoteProjectionSanitizer(options.redaction), {
		textScalars,
		presentationBytes,
	});
	return Object.freeze({
		name: "remote",
		projection,
		redactor: () =>
			createRemoteRedactor({
				...options.redaction,
				frameBytes: limits.frameBytes,
				textScalars: projection.textScalars,
				assistantSnapshotBytes: limits.assistantSnapshotBytes,
				presentationBytes: projection.presentationBytes,
			}),
		limits,
		hostRequests: (accepts: readonly HostRequestKind[]) =>
			new Set(
				accepts.filter((kind) => {
					const capability = hostRequestCapability(kind);
					return capability !== undefined && granted.has(capability);
				}),
			),
		intents: { name: "remote" as const, grant: options.grant },
		conversations: (id: string, linkedFrom?: string) => bound !== undefined && (id === bound || linkedFrom === bound),
		...(bound === undefined ? {} : { bound }),
	});
}
