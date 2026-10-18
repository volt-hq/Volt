/**
 * The projected log (RFC §4.3, §6.1): each committed entry a projection
 * includes becomes one `ProjectedEntry`, a pure function of the entry, the
 * log before it, the projection, and the presenter set. The same entry
 * projects to the same bytes for every subscriber of a projection, whenever
 * and however it subscribed, so a conversation's projection cache shares it
 * between them.
 *
 * `parentId`, and a `leaf` entry's target, name the nearest ancestor the
 * projection includes, so a client's tree never points at a hidden entry. A
 * full-fidelity projection sends payloads whole; a transcript projection
 * sends message-like entries as their transcript view only, and work entries
 * without input, locators, output, or result data.
 *
 * An entry's envelope (its position, parent, type, timestamp, and payload) is
 * projected apart from its view: the client fold reads the envelope and only
 * the view's client id, so a fold entry ({@link projectFoldEntry}) skips
 * presenting the entry.
 */

import {
	type ClientInputQueuedEntryPayload,
	type ClientInputReceiptEntryPayload,
	type FoldEntry,
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
import { BUILTIN_PRESENTERS } from "../../tools/presenters.ts";
import type { PresenterSet } from "../../ui/presentation.ts";
import { redactedWorkPhase } from "../../work/phase.ts";
import { workText } from "../../work/registry.ts";
import type { Projection } from "../profiles.ts";
import type { ProjectionCache } from "./cache.ts";
import { entryPresenter } from "./presentation.ts";
import { type ProjectionSource, projectTranscriptItem, transcriptClientMessageId } from "./transcript.ts";

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
function transcriptWorkPayload(entry: CommittedSessionEntry, payload: unknown, projection: Projection): unknown {
	const cut = (text: string, max?: number): string => workText(projection.sourceCut(text), max);
	if (entry.type === "work_started") {
		const { input: _input, child, title, ...started } = payload as WorkStartedEntryPayload;
		return {
			...projection.source(started),
			title: cut(title, WORK_TITLE_MAX_CHARS),
			input: null,
			...(child === undefined ? {} : { child: { conversation: child.conversation } }),
		} satisfies WorkStartedEntryPayload;
	}
	if (entry.type === "work_checkpoint") {
		const { child, ...phase } = payload as WorkCheckpointEntryPayload;
		return redactedWorkPhase(
			{ ...phase, ...(child === undefined ? {} : { child: { conversation: child.conversation } }) },
			projection.source,
			projection.sourceCut,
			WORK_CHECKPOINT_MAX_SERIALIZED_BYTES,
		);
	}
	if (entry.type !== "work_finished") return projection.source(payload);
	const { result, error, ...finished } = payload as WorkFinishedEntryPayload;
	const kept: WorkResult = {
		...(result?.summary === undefined ? {} : { summary: cut(result.summary) }),
		...(result?.output === undefined ? {} : { output: { text: "", truncated: result.output.truncated } }),
		...(result?.child === undefined ? {} : { child: result.child }),
	};
	return {
		...projection.source(finished),
		...(Object.keys(kept).length === 0 ? {} : { result: kept }),
		...(error === undefined ? {} : { error: cut(error) }),
	} satisfies WorkFinishedEntryPayload;
}

/**
 * The projection source over a session manager's committed log: its entries,
 * the presenters its tool calls and custom messages present with (the
 * built-in tools' for a log read without a runtime), and the cache of its
 * projected entries.
 */
export function sessionProjectionSource(
	sessionManager: SessionManager,
	presenters: PresenterSet = BUILTIN_PRESENTERS,
	cache?: ProjectionCache,
): ProjectionSource {
	return {
		entry: (id) => sessionManager.getCommittedEntry(id),
		presenters,
		cwd: sessionManager.getCwd(),
		...(cache === undefined ? {} : { cache }),
	};
}

/** The projection source of a session: its log, its presenters, and the cache of its projected entries. */
export function conversationProjectionSource(session: {
	readonly sessionManager: SessionManager;
	readonly presenters: PresenterSet & { readonly cache: ProjectionCache };
}): ProjectionSource {
	return sessionProjectionSource(session.sessionManager, session.presenters, session.presenters.cache);
}

/**
 * `id`, or its nearest ancestor `projection` includes; an id the log does not
 * hold stays as is. Past the search depth, the root: a hidden entry's id is
 * never named.
 */
export function visibleAncestor(id: string | null, source: ProjectionSource, projection: Projection): string | null {
	let current = id;
	for (let depth = 0; current !== null && depth < HIDDEN_ANCESTOR_DEPTH; depth++) {
		const entry = source.entry(current);
		if (!entry || projection.includes(entry)) return current;
		current = entry.parentId;
	}
	return null;
}

/** A projected entry without its view. */
interface ProjectedEnvelope {
	readonly ordinal: number;
	readonly id: string;
	readonly parentId: string | null;
	readonly type: CommittedSessionEntry["type"];
	readonly timestamp: string;
	readonly payload?: unknown;
}

/**
 * The projected form of `entry` for `projection`, or none when it hides the
 * entry: the source's cached one while it is valid.
 */
export function projectEntry(
	entry: CommittedSessionEntry,
	source: ProjectionSource,
	projection: Projection,
): ProjectedEntry | undefined {
	if (!projection.includes(entry)) return undefined;
	const project = (): ProjectedEntry => {
		const view: TranscriptItem | undefined = VIEW_ENTRY_TYPES.has(entry.type)
			? projectTranscriptItem(entry, source, projection)
			: undefined;
		return {
			...projectEnvelope(entry, source, projection),
			...(view === undefined ? {} : { view }),
		} as ProjectedEntry;
	};
	return source.cache === undefined
		? project()
		: source.cache.resolve(
				projection,
				entry.id,
				source.presenters.generation,
				entryPresenter(entry, source, projection),
				project,
			);
}

/**
 * `entry` as the client fold reads it for `projection`, or none when it hides
 * the entry: its projected envelope, and of its view only the client id the
 * view carries. Folding these equals folding the projected entries.
 */
export function projectFoldEntry(
	entry: CommittedSessionEntry,
	source: ProjectionSource,
	projection: Projection,
): FoldEntry | undefined {
	if (!projection.includes(entry)) return undefined;
	const clientMessageId = transcriptClientMessageId(entry, projection);
	return {
		...projectEnvelope(entry, source, projection),
		...(clientMessageId === undefined ? {} : { view: { clientMessageId } }),
	} as FoldEntry;
}

function projectEnvelope(
	entry: CommittedSessionEntry,
	source: ProjectionSource,
	projection: Projection,
): ProjectedEnvelope {
	const log = toLogEntry(entry);
	const sendsPayload = projection.fidelity === "full" || !VIEW_ENTRY_TYPES.has(entry.type);
	let payload: unknown;
	if (sendsPayload) {
		if (entry.type === "message") {
			payload = {
				message: entry.message,
				...(entry.clientMessageId === undefined ? {} : { clientMessageId: entry.clientMessageId }),
			};
		} else if (entry.type === "leaf") {
			payload = { targetId: visibleAncestor(entry.targetId, source, projection) };
		} else if (projection.fidelity === "transcript" && entry.type === "client_input_receipt") {
			const receipt = log.payload as ClientInputReceiptEntryPayload;
			payload = { ...receipt, input: { ...receipt.input, images: withoutImageData(receipt.input.images) } };
		} else if (
			projection.fidelity === "transcript" &&
			(entry.type === "work_started" || entry.type === "work_checkpoint" || entry.type === "work_finished")
		) {
			payload = transcriptWorkPayload(entry, log.payload, projection);
		} else if (projection.fidelity === "transcript" && entry.type === "client_input_queued") {
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
		parentId: visibleAncestor(entry.parentId, source, projection),
		type: entry.type,
		timestamp: entry.timestamp,
		...(payload === undefined ? {} : { payload }),
	};
}
