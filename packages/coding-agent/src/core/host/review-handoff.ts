/**
 * A durable review run handed to a new conversation: a review fix of all or
 * some findings (`open_review_session` included), or the promotion of a review
 * that just completed. The new conversation's log is written before it opens:
 * its copy of the run, the review message, and for a fix the run's
 * acknowledgement. A fix of every finding also acknowledges the run in the
 * source, through the source conversation while it is still open, once the new
 * one opened and before the client leaves the source. The source's log is
 * never reopened by a second writer.
 */

import { createReviewSeedMessage } from "../review-presentation.ts";
import type { ParsedReview } from "../review-report.ts";
import {
	acknowledgeReviewRun,
	appendReviewRun,
	type HydratedReviewRunRecord,
	type ReviewRunRecord,
} from "../review-state.ts";
import type { SessionWriter } from "../session-writer.ts";
import type { HostedConversation } from "./hosted-conversation.ts";

export interface ReviewHandoff {
	/** Writes the new conversation's log before it opens. */
	setup(writer: SessionWriter): Promise<void>;
	/** Writes through the still-open source once the new conversation opened. */
	beforeMove(source: HostedConversation): Promise<void>;
}

export interface ReviewPromotion {
	/** Writes the new conversation's log before it opens. */
	setup(writer: SessionWriter): Promise<void>;
	/** The review message, for the source when the new conversation is cancelled. */
	readonly message: ReturnType<typeof createReviewSeedMessage>;
}

/**
 * A review fix: the new conversation holds the run, the review message with
 * the selected findings (all when `findingIds` is undefined), and the run's
 * acknowledgement, which keeps the source's time when it has one. Selecting
 * every finding acknowledges the run in the source at the same time.
 */
export function createReviewFixHandoff(
	record: HydratedReviewRunRecord,
	findingIds: readonly string[] | undefined,
): ReviewHandoff {
	const message = createReviewSeedMessage(record, findingIds);
	let acknowledgedAt: number | undefined;
	return {
		async setup(writer) {
			await appendReviewRun(writer, record);
			await writer.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			acknowledgedAt = (await acknowledgeReviewRun(writer, record.runId, record.acknowledgedAt ?? Date.now()))
				.acknowledgedAt;
		},
		async beforeMove(source) {
			if (findingIds !== undefined) return;
			if (acknowledgedAt === undefined) throw new Error("Review session was opened without acknowledgment");
			await acknowledgeReviewRun(source.session.sessionWriter, record.runId, acknowledgedAt);
		},
	};
}

/**
 * The promotion of a completed review: the new conversation holds the run
 * and the review message with the full result, and keeps fast mode on when
 * the source had it. The source is left as it was.
 */
export function createReviewPromotion(
	record: ReviewRunRecord,
	result: ParsedReview,
	options: { readonly fastMode: boolean },
): ReviewPromotion {
	const message = createReviewSeedMessage(record, undefined, result);
	return {
		message,
		async setup(writer) {
			if (options.fastMode) await writer.appendFastModeChange(true);
			await appendReviewRun(writer, record);
			await writer.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
		},
	};
}
