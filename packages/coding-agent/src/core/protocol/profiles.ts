/**
 * Subscriber profiles (RFC §6.2): what a connection sees of the conversations
 * it subscribes to, the intents and queries it may use, and the bounds its
 * frames keep. A profile is chosen when a connection is admitted and never
 * changes for its life.
 *
 * The local profile (stdio RPC, JSON mode, SDK loopback) has full fidelity:
 * every core entry the client fold reads, payloads whole, no redaction, every
 * intent and query, every host request the client accepts, and unbounded
 * snapshots and replay. The remote profile for paired devices arrives with
 * the remote cut-over.
 */

import type { HostFrame, HostRequestKind } from "@hansjm10/volt-protocol";
import type { CommittedSessionEntry } from "../session-manager.ts";
import { type IntentProfile, LOCAL_INTENT_PROFILE } from "./intents/types.ts";

export interface ProfileLimits {
	/** Most entries a snapshot carries; older ones are paged with `history`. */
	readonly snapshotTail: number;
	/** Most entries a resume replays before it is answered with a snapshot instead. */
	readonly maxReplay: number;
	/** Queued live bytes past which a subscription drops its queued live frames and resets. */
	readonly liveQueueBytes: number;
	/** Most bytes of a streaming assistant message a live reset carries. */
	readonly assistantSnapshotBytes: number;
	/** Longest frame, in bytes. */
	readonly frameBytes: number;
	/** Most Unicode scalars of text one transcript view carries. */
	readonly textScalars: number;
}

export interface Profile {
	readonly name: "local" | "remote";
	/** `full`: payloads whole; `transcript`: message-like entries as their view only. */
	readonly fidelity: "full" | "transcript";
	/** Whether the profile projects `entry`; hidden entries leave gaps the client's position covers with `head`. */
	includes(entry: CommittedSessionEntry): boolean;
	/** The frame as a client on this profile may see it. */
	redact(frame: HostFrame): HostFrame;
	readonly limits: ProfileLimits;
	/** The host request kinds a client that accepts `accepts` is asked. */
	hostRequests(accepts: readonly HostRequestKind[]): ReadonlySet<HostRequestKind>;
	/** The profile intent and query admission runs on. */
	readonly intents: IntentProfile;
	/** Whether a connection on this profile may subscribe to the conversation `id`. */
	conversations(id: string): boolean;
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
	redact: (frame: HostFrame) => frame,
	limits: Object.freeze({
		snapshotTail: UNBOUNDED,
		maxReplay: UNBOUNDED,
		liveQueueBytes: 64 * 1024 * 1024,
		assistantSnapshotBytes: UNBOUNDED,
		frameBytes: UNBOUNDED,
		textScalars: 16_000,
	}),
	hostRequests: (accepts: readonly HostRequestKind[]) => new Set(accepts),
	intents: LOCAL_INTENT_PROFILE,
	conversations: () => true,
});
