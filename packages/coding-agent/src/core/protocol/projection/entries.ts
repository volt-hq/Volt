/**
 * The projected log (RFC §4.3, §6.1): each committed entry a profile includes
 * becomes one `ProjectedEntry`, a pure function of the entry, the log before
 * it, and the profile. The same entry projects to the same bytes for every
 * subscriber of a profile, whenever and however it subscribed.
 *
 * `parentId`, and a `leaf` entry's target, name the nearest ancestor the
 * profile projects, so a client's tree never points at a hidden entry. A
 * full-fidelity profile sends payloads whole; a transcript profile sends
 * message-like entries as their transcript view only, and work entries
 * without input, locators, output, or result data.
 */

import {
	type ClientInputQueuedEntryPayload,
	type ClientInputReceiptEntryPayload,
	type ProjectedEntry,
	type TranscriptItem,
	WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
	WORK_TITLE_MAX_CHARS,
	type WorkCheckpointEntryPayload,
	type WorkFinishedEntryPayload,
	type WorkResult,
	type WorkStartedEntryPayload,
} from "@hansjm10/volt-protocol";
import { toLogEntry } from "../../conversation-log/entry-codec.ts";
import type { CommittedSessionEntry, SessionManager } from "../../session-manager.ts";
import { redactedWorkPhase } from "../../work/phase.ts";
import { workText } from "../../work/registry.ts";
import type { Profile } from "../profiles.ts";
import { type ProjectionSource, projectTranscriptItem } from "./transcript.ts";

export type { ProjectionSource } from "./transcript.ts";

/** Entry types that carry a transcript view. */
const VIEW_ENTRY_TYPES: ReadonlySet<string> = new Set(["message", "compaction", "branch_summary", "custom_message"]);

/** Ancestors walked past hidden entries, at most; a deeper hidden chain keeps the parent as is. */
const HIDDEN_ANCESTOR_DEPTH = 4_096;

/**
 * Queued input images without their data: a transcript client counts them,
 * and fetches the delivered message's images with the `content` query.
 */
function withoutImageData<T extends { readonly data: string }>(images: readonly T[]): T[] {
	return images.map((image) => ({ ...image, data: "" }));
}

/**
 * A work entry as a transcript profile sends it: without the work's input,
 * its child's locator, its output text, and its result data, which may hold
 * host paths, secrets, or bulk (output is read with `work_output`). Paths
 * are redacted first, text the host cut to its bound (a title, summary,
 * error, progress text, or step label) loses a root's start the cut left,
 * and what redaction lengthened is bounded again: text to its bound, a
 * checkpoint to the checkpoint bound.
 */
function transcriptWorkPayload(entry: CommittedSessionEntry, payload: unknown, profile: Profile): unknown {
	const cut = (text: string, max?: number): string => workText(profile.sourceCut(text), max);
	if (entry.type === "work_started") {
		const { input: _input, child, title, ...started } = payload as WorkStartedEntryPayload;
		return {
			...profile.source(started),
			title: cut(title, WORK_TITLE_MAX_CHARS),
			input: null,
			...(child === undefined ? {} : { child: { conversation: child.conversation } }),
		} satisfies WorkStartedEntryPayload;
	}
	if (entry.type === "work_checkpoint") {
		return redactedWorkPhase(
			payload as WorkCheckpointEntryPayload,
			profile.source,
			profile.sourceCut,
			WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
		);
	}
	if (entry.type !== "work_finished") return profile.source(payload);
	const { result, error, ...finished } = payload as WorkFinishedEntryPayload;
	const kept: WorkResult = {
		...(result?.summary === undefined ? {} : { summary: cut(result.summary) }),
		...(result?.output === undefined ? {} : { output: { text: "", truncated: result.output.truncated } }),
		...(result?.child === undefined ? {} : { child: result.child }),
	};
	return {
		...profile.source(finished),
		...(Object.keys(kept).length === 0 ? {} : { result: kept }),
		...(error === undefined ? {} : { error: cut(error) }),
	} satisfies WorkFinishedEntryPayload;
}

/** The projection source over a session manager's committed log. */
export function sessionProjectionSource(sessionManager: SessionManager): ProjectionSource {
	return { entry: (id) => sessionManager.getCommittedEntry(id) };
}

/**
 * `id`, or its nearest ancestor `profile` projects; an id the log does not
 * hold stays as is. Past the search depth, the root: a hidden entry's id is
 * never named.
 */
export function visibleAncestor(id: string | null, source: ProjectionSource, profile: Profile): string | null {
	let current = id;
	for (let depth = 0; current !== null && depth < HIDDEN_ANCESTOR_DEPTH; depth++) {
		const entry = source.entry(current);
		if (!entry || profile.includes(entry)) return current;
		current = entry.parentId;
	}
	return null;
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
		} else if (profile.fidelity === "transcript" && entry.type === "client_input_receipt") {
			const receipt = log.payload as ClientInputReceiptEntryPayload;
			payload = { ...receipt, input: { ...receipt.input, images: withoutImageData(receipt.input.images) } };
		} else if (
			profile.fidelity === "transcript" &&
			(entry.type === "work_started" || entry.type === "work_checkpoint" || entry.type === "work_finished")
		) {
			payload = transcriptWorkPayload(entry, log.payload, profile);
		} else if (profile.fidelity === "transcript" && entry.type === "client_input_queued") {
			// The host messages a queued input delivers become entries the profile shows or hides; the queue
			// a client folds needs only the input's text and image count.
			const { messages: _messages, ...queuedInput } = (log.payload as ClientInputQueuedEntryPayload).queuedInput;
			payload = {
				...(log.payload as ClientInputQueuedEntryPayload),
				queuedInput: { ...queuedInput, images: withoutImageData(queuedInput.images) },
			};
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
