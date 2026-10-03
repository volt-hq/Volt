/**
 * The conversation log contract (RFC §4.1): one ordered, append-only log per
 * conversation, read and written by exactly one kernel.
 *
 * Entries use the protocol envelope (`@hansjm10/volt-protocol/entries`). The
 * log assigns ordinals: contiguous per log, starting at 1. The ordinal is the
 * only position, cursor, and fence.
 *
 * Commit, then publish. `append` resolves `committed` only after its entries
 * are durable, and a reader never observes an entry whose commit has not
 * completed. A writer folds and publishes an entry (to its state, to
 * subscribers) only after `append` resolves `committed`; an entry whose batch
 * rolled back, or whose outcome is unknown, is never published.
 *
 * Single writer. A writer passes the ordinal its fold has reached as
 * `expectedOrdinal`. A mismatch means another writer appended or the writer's
 * fold is stale, so the log is lost (`fence_conflict`): the batch is not
 * appended and the log accepts no further work.
 */

import { CORE_LOG_ENTRY_TYPES, type LogEntry, type LogEntryVisibility } from "@hansjm10/volt-protocol/entries";

/**
 * An entry of a host-defined product type. The kernel indexes it in the tree
 * by its envelope and carries it through without reading its payload.
 */
export interface ProductLogEntry {
	readonly ordinal: number;
	readonly id: string;
	readonly parentId: string | null;
	readonly type: string;
	readonly timestamp: string;
	readonly visibility: LogEntryVisibility;
	readonly payload: unknown;
}

/** Any committed entry of a conversation log: a core entry the kernel folds, or a product entry. */
export type ConversationLogEntry = LogEntry | ProductLogEntry;

type WithoutOrdinal<T> = T extends unknown ? Omit<T, "ordinal"> : never;

/** An entry as a writer submits it; the log assigns its ordinal at commit. */
export type ConversationLogEntryDraft = WithoutOrdinal<ConversationLogEntry>;

/** Whether an entry has a core type. Core type strings are never reused by product types. */
export function isCoreLogEntry(entry: ConversationLogEntry): entry is LogEntry {
	return Object.hasOwn(CORE_LOG_ENTRY_TYPES, entry.type);
}

export interface ConversationLogAppend {
	/** The ordinal of the newest entry the writer has folded; must equal the log head. */
	readonly expectedOrdinal: number;
	/**
	 * Idempotency key. Retrying a commit with the same id, fence, and entries
	 * returns the original result instead of appending again.
	 */
	readonly commitId: string;
	/** At least one entry, appended in order and atomically. */
	readonly entries: readonly ConversationLogEntryDraft[];
}

export type ConversationLogAppendResult =
	/** Durable: the entries hold ordinals `first` through `last`. */
	| { readonly status: "committed"; readonly first: number; readonly last: number }
	/** Definitely not committed; the log is unchanged and still writable. */
	| { readonly status: "rolled_back"; readonly error: Error };

/** One ordinal-ordered page of committed entries. */
export interface ConversationLogPage {
	/** Entries with ordinals after the requested one, oldest first, at most `limit` of them. */
	readonly entries: readonly ConversationLogEntry[];
	/** The log head when the page was read. */
	readonly lastOrdinal: number;
}

/**
 * Why a log stopped accepting work.
 * - `fence_conflict`: an append's `expectedOrdinal` did not match the head.
 * - `uncertain_commit`: a commit's outcome could not be determined.
 * - `storage`: the storage failed in a way that leaves the log unusable.
 * - `closed`: the writer closed the log.
 */
export type ConversationLogLossReason = "fence_conflict" | "uncertain_commit" | "storage" | "closed";

/** The error a lost log rejects with and its `lost` promise resolves to. */
export class ConversationLogLostError extends Error {
	readonly reason: ConversationLogLossReason;

	constructor(reason: ConversationLogLossReason, message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "ConversationLogLostError";
		this.reason = reason;
	}
}

export interface ConversationLog {
	readonly conversationId: string;
	/** Ordinal of the newest committed entry; 0 for an empty log. */
	head(): number;
	/**
	 * Commit one batch. Resolves `committed` after the batch is durable, or
	 * `rolled_back` when it definitely did not commit and the log is still
	 * writable. Rejects with {@link ConversationLogLostError} when the log is
	 * or becomes lost; the caller then treats the outcome as unknown.
	 */
	append(batch: ConversationLogAppend): Promise<ConversationLogAppendResult>;
	/** Read committed entries with ordinal greater than `afterOrdinal`, at most `limit` of them. */
	read(afterOrdinal: number, limit: number): Promise<ConversationLogPage>;
	/** Resolves once, when the log stops accepting work. Never rejects. */
	readonly lost: Promise<ConversationLogLostError>;
	/** Stop accepting work; `lost` resolves with reason `closed` unless the log was already lost. */
	close(): Promise<void>;
}
