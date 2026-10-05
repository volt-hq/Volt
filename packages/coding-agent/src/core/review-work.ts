/**
 * Reviews as conversation work (RFC §7.2, work kind `review`). A review runs
 * detached from the conversation's turns, in isolated sessions of its own: at
 * most {@link REVIEW_WORK_MAX_ACTIVE} at once, never cancelled by an abort of
 * the conversation's run, and without a notice (delivery `none`). Its work id
 * is the run id of the `volt.review.run` record it ends with; its findings
 * stay in that record. A review running when the runtime stops ends
 * `interrupted`. Opening finished review work fixes its findings in a new
 * conversation, as `review_open_session` does.
 */

import type { WorkRecord } from "@hansjm10/volt-agent-core";
import type { JsonValue } from "@hansjm10/volt-ai";
import { WORK_TITLE_MAX_CHARS } from "@hansjm10/volt-protocol";
import { openReviewFindings } from "./host/review-handoff.ts";
import type { ParsedReview } from "./review-report.ts";
import type { SessionManager } from "./session-manager.ts";
import { WorkError, type WorkKindDefinition } from "./work/registry.ts";

/** Most reviews running at once in one conversation. */
export const REVIEW_WORK_MAX_ACTIVE = 3;

/** What a review's `work_started` keeps: its host action (`review.<target kind>`) and what it reviews. */
export interface ReviewWorkInput {
	readonly action: string;
	readonly target: string;
}

/** What a completed review's result data holds, besides its summary. */
export interface ReviewWorkData {
	readonly target: string;
	readonly findingsCount: number;
	readonly completionStatus: ParsedReview["completionStatus"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The input of review work for `action` on `target`, the target bounded to a title. */
export function reviewWorkInput(action: string, target: string): JsonValue {
	return { action, target: target.slice(0, WORK_TITLE_MAX_CHARS) } satisfies ReviewWorkInput;
}

/** The result data of completed review work, or undefined for other work. */
export function reviewWorkData(record: WorkRecord): ReviewWorkData | undefined {
	const data = record.result?.data;
	if (record.kind !== "review" || record.outcome !== "completed" || !isRecord(data)) return undefined;
	const { target, findingsCount, completionStatus } = data;
	if (
		typeof target !== "string" ||
		typeof findingsCount !== "number" ||
		!Number.isSafeInteger(findingsCount) ||
		findingsCount < 0 ||
		(completionStatus !== "complete" && completionStatus !== "incomplete")
	) {
		return undefined;
	}
	return { target, findingsCount, completionStatus };
}

/** The `review` kind of the work of the conversation whose log `sessionManager` reads. */
export function reviewWorkKind(sessionManager: () => SessionManager): WorkKindDefinition {
	return {
		kind: "review",
		delivery: "none",
		cancellable: true,
		cancelOnAbort: false,
		maxActive: REVIEW_WORK_MAX_ACTIVE,
		title: (input) => `Review ${isRecord(input) && typeof input.target === "string" ? input.target : "changes"}`,
		async open(item, ctx) {
			if (item.outcome === undefined) {
				throw new WorkError("running", `Review ${item.workId} is still running`);
			}
			if (item.outcome !== "completed") {
				throw new WorkError(
					"unavailable",
					`Review ${item.workId} ended ${item.outcome}: it has no findings to open`,
				);
			}
			const opened = await openReviewFindings(
				{ host: ctx.host, client: ctx.client, sessionManager: sessionManager() },
				item.workId,
				undefined,
				ctx.assertCurrent,
			);
			return opened.cancelled ? { cancelled: true } : { conversation: opened.sessionId, moved: true };
		},
	};
}
