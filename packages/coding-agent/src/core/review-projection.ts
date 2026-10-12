/**
 * A durable review run as clients see it (`review.result`, `review.runs`): its target without a pull request's
 * private body unless the run is shown in full, its options and status, and its result.
 */

import { type HydratedReviewRunRecord, reviewRunEngine } from "./review-state.ts";
import { createReviewFileMetadata, createReviewPullRequestMetadata } from "./review-target-metadata.ts";
import { UNAVAILABLE_REVIEW_USAGE } from "./review-usage.ts";

function projectReviewTargetIdentity(
	identity: HydratedReviewRunRecord["target"]["identity"],
	includePullRequestBody: boolean,
): Record<string, unknown> {
	const pullRequest = identity.pullRequest;
	return {
		kind: identity.kind,
		baseTree: identity.baseTree,
		headTree: identity.headTree,
		...(identity.baseCommit ? { baseCommit: identity.baseCommit } : {}),
		...(identity.mergeBaseCommit ? { mergeBaseCommit: identity.mergeBaseCommit } : {}),
		...(identity.headCommit ? { headCommit: identity.headCommit } : {}),
		...(pullRequest
			? {
					pullRequest: {
						number: pullRequest.number,
						title: pullRequest.title,
						...(includePullRequestBody ? { body: pullRequest.body } : {}),
						url: pullRequest.url,
						baseRefName: pullRequest.baseRefName,
						headRefName: pullRequest.headRefName,
						baseRefOid: pullRequest.baseRefOid,
						headRefOid: pullRequest.headRefOid,
					},
				}
			: {}),
	};
}

/** A durable review run as clients see it: in full with its result, or summarized in a listing. */
export function projectReviewRun(record: HydratedReviewRunRecord, includeResult: boolean): Record<string, unknown> {
	const result = record.result;
	const pullRequest = createReviewPullRequestMetadata(record.target.identity);
	const files = createReviewFileMetadata(record.target.files, record.target.fileSummary, includeResult);
	return {
		runId: record.runId,
		workflowAction: record.workflowAction,
		engine: reviewRunEngine(record),
		status: record.status,
		startedAt: record.startedAt,
		endedAt: record.endedAt,
		usage: record.usage?.summary ?? UNAVAILABLE_REVIEW_USAGE,
		...(record.usage
			? {
					usageUpdatedAt: record.usage.updatedAt,
					...(includeResult ? { usageBreakdown: record.usage.attempts } : {}),
				}
			: {}),
		...(record.acknowledgedAt === undefined ? {} : { acknowledgedAt: record.acknowledgedAt }),
		target: {
			description: record.target.description,
			diffCommand: record.target.diffCommand,
			identity: projectReviewTargetIdentity(record.target.identity, includeResult),
			...(pullRequest ? { pullRequest } : {}),
			files,
			...(record.target.context ? { context: record.target.context } : {}),
		},
		options: record.options,
		...(record.parentRunId ? { parentRunId: record.parentRunId } : {}),
		...(record.incrementalFallbackReason ? { incrementalFallbackReason: record.incrementalFallbackReason } : {}),
		...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
		...(result
			? includeResult
				? {
						completionStatus: result.completionStatus,
						summary: result.summary,
						findings: result.findings,
						coverage: result.coverage,
						...(result.overallCorrectness ? { overallCorrectness: result.overallCorrectness } : {}),
						overallExplanation: result.overallExplanation,
						...(result.verificationChallenge ? { verificationChallenge: result.verificationChallenge } : {}),
					}
				: { completionStatus: result.completionStatus, findingsCount: result.findings.length }
			: {}),
	};
}
