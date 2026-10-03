/**
 * The reference {@link ConversationLog}: contiguous ordinals, the
 * `expectedOrdinal` fence, `commitId` idempotency, and bounded reads, held in
 * memory. Committed entries are frozen copies; nothing a caller does to its
 * drafts or pages changes the log.
 */

import {
	type ConversationLog,
	type ConversationLogAppend,
	type ConversationLogAppendResult,
	type ConversationLogEntry,
	type ConversationLogEntryDraft,
	type ConversationLogLossReason,
	ConversationLogLostError,
	type ConversationLogPage,
} from "./log.ts";

/** Most entries one `read` returns. */
export const CONVERSATION_LOG_READ_LIMIT_MAX = 1_000;

interface CommitRecord {
	readonly expectedOrdinal: number;
	readonly entries: readonly ConversationLogEntryDraft[];
	readonly result: ConversationLogAppendResult & { readonly status: "committed" };
}

function deepFreeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const nested of Object.values(value)) deepFreeze(nested);
		Object.freeze(value);
	}
	return value;
}

/** Structural equality of JSON data; object key order does not matter. */
function sameJson(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
	const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => Object.hasOwn(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]))
	);
}

function rolledBack(message: string): ConversationLogAppendResult {
	return { status: "rolled_back", error: new Error(message) };
}

export class InMemoryConversationLog implements ConversationLog {
	readonly conversationId: string;
	readonly lost: Promise<ConversationLogLostError>;
	private readonly entries: ConversationLogEntry[] = [];
	private readonly entryIds = new Set<string>();
	private readonly commits = new Map<string, CommitRecord>();
	private lostError: ConversationLogLostError | undefined;
	private resolveLost: (error: ConversationLogLostError) => void = () => {};

	constructor(conversationId: string) {
		this.conversationId = conversationId;
		this.lost = new Promise((resolve) => {
			this.resolveLost = resolve;
		});
	}

	head(): number {
		return this.entries.length;
	}

	async append(batch: ConversationLogAppend): Promise<ConversationLogAppendResult> {
		this.assertOpen();
		const previous = this.commits.get(batch.commitId);
		if (previous) {
			if (previous.expectedOrdinal === batch.expectedOrdinal && sameJson(previous.entries, batch.entries)) {
				return previous.result;
			}
			return rolledBack(`Commit ${JSON.stringify(batch.commitId)} was already used for a different batch`);
		}
		const head = this.head();
		if (batch.expectedOrdinal !== head) {
			throw this.lose(
				"fence_conflict",
				`Expected log ordinal ${String(batch.expectedOrdinal)}, but the log head is ${head}`,
			);
		}
		if (batch.commitId.length === 0) return rolledBack("A commit id must be non-empty");
		if (batch.entries.length === 0) return rolledBack("A commit must append at least one entry");
		const batchIds = new Set<string>();
		for (const entry of batch.entries) {
			if (this.entryIds.has(entry.id) || batchIds.has(entry.id)) {
				return rolledBack(`Entry id ${JSON.stringify(entry.id)} is already in the log`);
			}
			batchIds.add(entry.id);
		}

		const drafts = deepFreeze(structuredClone(batch.entries));
		const committed = drafts.map(
			(draft, index) => deepFreeze({ ...draft, ordinal: head + index + 1 }) as ConversationLogEntry,
		);
		this.entries.push(...committed);
		for (const id of batchIds) this.entryIds.add(id);
		const result = Object.freeze({ status: "committed" as const, first: head + 1, last: head + committed.length });
		this.commits.set(batch.commitId, { expectedOrdinal: batch.expectedOrdinal, entries: drafts, result });
		return result;
	}

	async read(afterOrdinal: number, limit: number): Promise<ConversationLogPage> {
		this.assertOpen();
		if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0) {
			throw new RangeError("afterOrdinal must be a non-negative safe integer");
		}
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > CONVERSATION_LOG_READ_LIMIT_MAX) {
			throw new RangeError(`limit must be an integer from 1 to ${CONVERSATION_LOG_READ_LIMIT_MAX}`);
		}
		return { entries: this.entries.slice(afterOrdinal, afterOrdinal + limit), lastOrdinal: this.head() };
	}

	async close(): Promise<void> {
		if (!this.lostError) this.lose("closed", "The conversation log was closed");
	}

	private assertOpen(): void {
		if (this.lostError) throw this.lostError;
	}

	private lose(reason: ConversationLogLossReason, message: string): ConversationLogLostError {
		const error = new ConversationLogLostError(reason, message);
		this.lostError = error;
		this.resolveLost(error);
		return error;
	}
}
