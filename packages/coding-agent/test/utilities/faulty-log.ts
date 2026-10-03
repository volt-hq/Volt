import {
	type ConversationLog,
	type ConversationLogAppend,
	type ConversationLogAppendResult,
	type ConversationLogLossReason,
	ConversationLogLostError,
	type ConversationLogPage,
} from "@hansjm10/volt-agent-core";
import type { SessionManager } from "../../src/core/session-manager.ts";

/** A loss the next matching append reports instead of its result. */
export interface ConversationLogLossFault {
	readonly kind: "lose";
	readonly reason: ConversationLogLossReason;
	readonly message: string;
	/** Commit the batch to the wrapped log first: the outcome is unknown to the writer but durable. */
	readonly committed: boolean;
}

export type ConversationLogFault = "rolled_back" | ConversationLogLossFault;

/** Lose the log on the next matching append; with `committed`, after the batch became durable. */
export function lose(
	reason: ConversationLogLossReason,
	options: { committed?: boolean; message?: string } = {},
): ConversationLogLossFault {
	return {
		kind: "lose",
		reason,
		committed: options.committed ?? false,
		message: options.message ?? `Injected ${reason} loss`,
	};
}

export type ConversationLogBatchMatcher = (batch: ConversationLogAppend) => boolean;

/** Whether a batch appends an entry of `type`. */
export function appendsEntryType(type: string): ConversationLogBatchMatcher {
	return (batch) => batch.entries.some((entry) => entry.type === type);
}

interface PendingFault {
	readonly fault: ConversationLogFault;
	readonly matches: ConversationLogBatchMatcher;
}

interface PendingHold {
	readonly matches: ConversationLogBatchMatcher;
	readonly started: PromiseWithResolvers<void>;
	readonly release: Promise<void>;
}

/** A held append: `started` resolves when the matching append arrives; `release()` lets it continue. */
export interface ConversationLogHold {
	readonly started: Promise<void>;
	release(): void;
}

const ANY_BATCH: ConversationLogBatchMatcher = () => true;

/**
 * A {@link ConversationLog} that forwards to another log and injects append
 * outcomes: a rollback, a loss before or after the batch commits, or a pause.
 * Each fault applies once, to the next append its matcher accepts. Batches
 * that received a fault are recorded in `faulted`.
 */
export class FaultyConversationLog implements ConversationLog {
	readonly conversationId: string;
	readonly lost: Promise<ConversationLogLostError>;
	/** Batches that received an injected fault, in order. */
	readonly faulted: ConversationLogAppend[] = [];
	private readonly inner: ConversationLog;
	private readonly faults: PendingFault[] = [];
	private readonly holds: PendingHold[] = [];
	private readonly injectedLoss = Promise.withResolvers<ConversationLogLostError>();
	private lostError: ConversationLogLostError | undefined;

	constructor(inner: ConversationLog) {
		this.inner = inner;
		this.conversationId = inner.conversationId;
		this.lost = Promise.race([this.injectedLoss.promise, inner.lost]);
		void inner.lost.then((error) => {
			this.lostError ??= error;
		});
	}

	/** Inject `fault` into the next append `matches` accepts (any append by default). */
	failNext(fault: ConversationLogFault, matches: ConversationLogBatchMatcher = ANY_BATCH): void {
		this.faults.push({ fault, matches });
	}

	/** Pause the next append `matches` accepts until `release()`; it then proceeds normally. */
	holdNext(matches: ConversationLogBatchMatcher = ANY_BATCH): ConversationLogHold {
		const release = Promise.withResolvers<void>();
		const hold: PendingHold = { matches, started: Promise.withResolvers<void>(), release: release.promise };
		this.holds.push(hold);
		return { started: hold.started.promise, release: () => release.resolve() };
	}

	head(): number {
		return this.inner.head();
	}

	async append(batch: ConversationLogAppend): Promise<ConversationLogAppendResult> {
		if (this.lostError) throw this.lostError;
		const holdIndex = this.holds.findIndex((candidate) => candidate.matches(batch));
		if (holdIndex !== -1) {
			const [hold] = this.holds.splice(holdIndex, 1);
			hold.started.resolve();
			await hold.release;
			if (this.lostError) throw this.lostError;
		}
		const faultIndex = this.faults.findIndex((candidate) => candidate.matches(batch));
		if (faultIndex === -1) return this.inner.append(batch);
		const [{ fault }] = this.faults.splice(faultIndex, 1);
		this.faulted.push(structuredClone(batch));
		if (fault === "rolled_back") {
			return { status: "rolled_back", error: new Error("Injected rollback") };
		}
		if (fault.committed) {
			const result = await this.inner.append(batch);
			if (result.status !== "committed") throw new Error("The injected loss expected its batch to commit");
		}
		throw this.loseNow(new ConversationLogLostError(fault.reason, fault.message));
	}

	async read(afterOrdinal: number, limit: number): Promise<ConversationLogPage> {
		if (this.lostError) throw this.lostError;
		return this.inner.read(afterOrdinal, limit);
	}

	/** Close the wrapped log, which releases its storage and lock even after an injected loss. */
	async close(): Promise<void> {
		this.loseNow(new ConversationLogLostError("closed", "The conversation log was closed"));
		await this.inner.close();
	}

	private loseNow(error: ConversationLogLostError): ConversationLogLostError {
		if (!this.lostError) {
			this.lostError = error;
			this.injectedLoss.resolve(error);
		}
		return this.lostError;
	}
}

/**
 * Wrap `manager`'s current log in a {@link FaultyConversationLog}. The manager
 * writes through the wrapper until it switches sessions.
 */
export function injectFaultyLog(manager: SessionManager): FaultyConversationLog {
	const internals = manager as unknown as {
		log: ConversationLog | undefined;
		_attachLog(log: ConversationLog): void;
	};
	if (!internals.log) throw new Error("The session manager has no writable log");
	const faulty = new FaultyConversationLog(internals.log);
	internals._attachLog(faulty);
	return faulty;
}
