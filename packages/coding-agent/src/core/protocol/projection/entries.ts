/**
 * The projected log (RFC §4.3, §6.1): each committed entry a profile includes
 * becomes one `ProjectedEntry`, a pure function of the entry, the log before
 * it, and the profile. The same entry projects to the same bytes for every
 * subscriber of a profile, whenever and however it subscribed.
 *
 * `parentId`, and a `leaf` entry's target, name the nearest ancestor the
 * profile projects, so a client's tree never points at a hidden entry. A
 * full-fidelity profile sends payloads whole; a transcript profile sends
 * message-like entries as their transcript view only.
 */

import type { ProjectedEntry, TranscriptItem } from "@hansjm10/volt-protocol";
import { toLogEntry } from "../../conversation-log/entry-codec.ts";
import type { CommittedSessionEntry, SessionManager } from "../../session-manager.ts";
import type { Profile } from "../profiles.ts";
import { type ProjectionSource, projectTranscriptItem } from "./transcript.ts";

export type { ProjectionSource } from "./transcript.ts";

/** Entry types that carry a transcript view. */
const VIEW_ENTRY_TYPES: ReadonlySet<string> = new Set(["message", "compaction", "branch_summary", "custom_message"]);

/** Ancestors walked past hidden entries, at most; a deeper hidden chain keeps the parent as is. */
const HIDDEN_ANCESTOR_DEPTH = 4_096;

/** The projection source over a session manager's committed log. */
export function sessionProjectionSource(sessionManager: SessionManager): ProjectionSource {
	return { entry: (id) => sessionManager.getCommittedEntry(id) };
}

/** `id`, or its nearest ancestor `profile` projects; an id the log does not hold stays as is. */
export function visibleAncestor(id: string | null, source: ProjectionSource, profile: Profile): string | null {
	let current = id;
	for (let depth = 0; current !== null && depth < HIDDEN_ANCESTOR_DEPTH; depth++) {
		const entry = source.entry(current);
		if (!entry || profile.includes(entry)) return current;
		current = entry.parentId;
	}
	return current;
}

/** The projected form of `entry` for `profile`, or none when the profile hides it. */
export function projectEntry(
	entry: CommittedSessionEntry,
	source: ProjectionSource,
	profile: Profile,
): ProjectedEntry | undefined {
	if (!profile.includes(entry)) return undefined;
	const log = toLogEntry(entry);
	const view: TranscriptItem | undefined = VIEW_ENTRY_TYPES.has(entry.type)
		? projectTranscriptItem(entry, source, profile)
		: undefined;
	const sendsPayload = profile.fidelity === "full" || !VIEW_ENTRY_TYPES.has(entry.type);
	let payload: unknown;
	if (sendsPayload) {
		if (entry.type === "message") {
			payload = {
				message: entry.message,
				...(entry.clientMessageId === undefined ? {} : { clientMessageId: entry.clientMessageId }),
			};
		} else if (entry.type === "leaf") {
			payload = { targetId: visibleAncestor(entry.targetId, source, profile) };
		} else {
			payload = log.payload;
		}
	}
	return {
		ordinal: entry.ordinal,
		id: entry.id,
		parentId: visibleAncestor(entry.parentId, source, profile),
		type: entry.type,
		timestamp: entry.timestamp,
		...(payload === undefined ? {} : { payload }),
		...(view === undefined ? {} : { view }),
	} as ProjectedEntry;
}
