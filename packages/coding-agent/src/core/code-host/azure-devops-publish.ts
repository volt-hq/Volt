import type { AzureDevOpsPullRequestLocator } from "./azure-devops-remote.ts";
import {
	type AzureDevOpsFailure,
	type AzureDevOpsResponse,
	azureDevOpsFailureMessage,
	isRecord,
	requestAzureDevOps,
} from "./azure-devops-rest.ts";
import { azureDevOpsRepositoryPath } from "./azure-devops-review-target.ts";
import type {
	ReviewCodeHostInlineComment,
	ReviewCodeHostPublishRequest,
	ReviewCodeHostPublishResult,
} from "./types.ts";

/** Thread properties that mark a comment thread as one part of a published review. */
const RUN_PROPERTY = "Volt.ReviewRunId";
const PART_PROPERTY = "Volt.ReviewPart";
const SUMMARY_PART = "summary";
const THREAD_STATUS_ACTIVE = 1;
const COMMENT_TYPE_TEXT = 1;
const CHANGE_PAGE_SIZE = 2_000;
const CHANGE_LIMIT = 20_000;
/** Failures of a request Azure DevOps refused before taking any effect. */
const REFUSED_FAILURES: ReadonlySet<AzureDevOpsFailure> = new Set([
	"no-credentials",
	"access-denied",
	"not-found",
	"rate-limited",
]);

/** One comment thread of a published review: a finding on its lines, or the review's summary. */
interface ReviewPart {
	key: string;
	body: string;
	comment?: ReviewCodeHostInlineComment;
}

type Failed = Extract<AzureDevOpsResponse, { ok: false }>;

function failureReason(response: Failed): string {
	const reason =
		response.failure === "access-denied"
			? "Azure DevOps denied access. Check that the host's personal access token or Azure CLI account can comment on the repository's pull requests."
			: azureDevOpsFailureMessage(response.failure);
	return response.message === undefined ? reason : `${reason} Azure DevOps said: ${response.message}`;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function commitId(ref: unknown): unknown {
	return isRecord(ref) ? ref.commitId : undefined;
}

function stringProperty(properties: unknown, key: string): string | undefined {
	if (!isRecord(properties)) return undefined;
	const property = properties[key];
	const value = isRecord(property) ? property.$value : property;
	return typeof value === "string" ? value : undefined;
}

/** The parts of the run's review already on the pull request, deleted ones included, by key with their thread ids. */
async function readPostedParts(
	locator: AzureDevOpsPullRequestLocator,
	path: string,
	runId: string,
): Promise<Map<string, number> | string> {
	const response = await requestAzureDevOps({
		organization: locator.repository.organization,
		path: `${path}/threads`,
	});
	if (!response.ok) return failureReason(response);
	const threads = isRecord(response.value) ? response.value.value : undefined;
	if (!Array.isArray(threads)) return azureDevOpsFailureMessage("invalid-response");
	const posted = new Map<string, number>();
	for (const thread of threads) {
		if (!isRecord(thread)) return azureDevOpsFailureMessage("invalid-response");
		if (stringProperty(thread.properties, RUN_PROPERTY) !== runId) continue;
		const part = stringProperty(thread.properties, PART_PROPERTY);
		const id = positiveInteger(thread.id);
		if (part === undefined || id === undefined) return azureDevOpsFailureMessage("invalid-response");
		// A part posted twice, by publishes racing, keeps its first thread.
		if (!posted.has(part) || id < posted.get(part)!) posted.set(part, id);
	}
	return posted;
}

/**
 * The latest iteration that compares the reviewed head with the reviewed merge base: the diff the review's lines
 * refer to. A pull request retargeted since the review has the same head in an iteration with another merge base.
 */
async function readReviewedIteration(
	locator: AzureDevOpsPullRequestLocator,
	path: string,
	headRefOid: string,
	mergeBaseCommit: string,
): Promise<number | string> {
	const response = await requestAzureDevOps({
		organization: locator.repository.organization,
		path: `${path}/iterations`,
	});
	if (!response.ok) return failureReason(response);
	const iterations = isRecord(response.value) ? response.value.value : undefined;
	if (!Array.isArray(iterations)) return azureDevOpsFailureMessage("invalid-response");
	let reviewed: number | undefined;
	let reviewedHead = false;
	for (const iteration of iterations) {
		if (!isRecord(iteration)) return azureDevOpsFailureMessage("invalid-response");
		const id = positiveInteger(iteration.id);
		if (id === undefined) return azureDevOpsFailureMessage("invalid-response");
		if (commitId(iteration.sourceRefCommit) !== headRefOid) continue;
		reviewedHead = true;
		if (commitId(iteration.commonRefCommit) === mergeBaseCommit && (reviewed === undefined || id > reviewed)) {
			reviewed = id;
		}
	}
	if (reviewed !== undefined) return reviewed;
	return reviewedHead
		? "The pull request's target changed after the review, so the reviewed diff is not one of its iterations. Run a new review."
		: "None of the pull request's iterations has the reviewed commit as its source. Run a new review.";
}

/**
 * The change tracking ids Azure DevOps assigned the files in `paths` in the iteration's changes against the
 * common commit; a file it does not list is left out.
 */
async function readChangeTrackingIds(
	locator: AzureDevOpsPullRequestLocator,
	path: string,
	iteration: number,
	paths: ReadonlySet<string>,
): Promise<Map<string, number> | string> {
	const ids = new Map<string, number>();
	let skip = 0;
	while (ids.size < paths.size) {
		if (skip >= CHANGE_LIMIT) return `The pull request changes more than ${CHANGE_LIMIT} files.`;
		const response = await requestAzureDevOps({
			organization: locator.repository.organization,
			path: `${path}/iterations/${iteration}/changes`,
			query: { $top: String(CHANGE_PAGE_SIZE), $skip: String(skip), $compareTo: "0" },
		});
		if (!response.ok) return failureReason(response);
		const page = response.value;
		const entries = isRecord(page) ? page.changeEntries : undefined;
		if (!isRecord(page) || !Array.isArray(entries)) return azureDevOpsFailureMessage("invalid-response");
		for (const entry of entries) {
			const item = isRecord(entry) ? entry.item : undefined;
			const filePath = isRecord(item) && typeof item.path === "string" ? item.path.replace(/^\/+/, "") : undefined;
			const id = isRecord(entry) ? positiveInteger(entry.changeTrackingId) : undefined;
			if (filePath !== undefined && id !== undefined && paths.has(filePath)) ids.set(filePath, id);
		}
		const next = page.nextSkip;
		if (entries.length === 0 || typeof next !== "number" || !Number.isSafeInteger(next) || next <= skip) break;
		skip = next;
	}
	return ids;
}

function marker(value: string) {
	return { $type: "System.String", $value: value };
}

function threadOf(
	part: ReviewPart,
	runId: string,
	position: { iteration: number; changeTrackingIds: ReadonlyMap<string, number> } | undefined,
): Record<string, unknown> {
	const thread: Record<string, unknown> = {
		comments: [{ parentCommentId: 0, content: part.body, commentType: COMMENT_TYPE_TEXT }],
		status: THREAD_STATUS_ACTIVE,
		properties: { [RUN_PROPERTY]: marker(runId), [PART_PROPERTY]: marker(part.key) },
	};
	const comment = part.comment;
	if (!comment || !position) return thread;
	const side = comment.side === "head" ? "right" : "left";
	return {
		...thread,
		threadContext: {
			filePath: `/${comment.path}`,
			[`${side}FileStart`]: { line: comment.startLine, offset: 1 },
			[`${side}FileEnd`]: { line: comment.endLine, offset: 1 },
		},
		pullRequestThreadContext: {
			changeTrackingId: position.changeTrackingIds.get(comment.path),
			// Equal iterations compare the iteration with the common commit: the diff the review read.
			iterationContext: {
				firstComparingIteration: position.iteration,
				secondComparingIteration: position.iteration,
			},
		},
	};
}

/**
 * Post a review as comment threads: one per inline finding, then one with the summary. Each thread is marked
 * with the run and its part, so publishing again after a failure posts only the threads still missing.
 */
export async function publishAzureDevOpsReview(
	locator: AzureDevOpsPullRequestLocator,
	request: ReviewCodeHostPublishRequest,
): Promise<ReviewCodeHostPublishResult> {
	const path = `${azureDevOpsRepositoryPath(locator.repository)}/pullRequests/${locator.number}`;
	const parts: ReviewPart[] = [
		...request.comments.map((comment) => ({ key: `finding:${comment.findingId}`, body: comment.body, comment })),
		{ key: SUMMARY_PART, body: request.body },
	];
	const posted = await readPostedParts(locator, path, request.runId);
	if (typeof posted === "string") {
		throw new Error(`Could not read the pull request's comment threads, so none were posted. ${posted}`);
	}
	/** `uncertain`: the last thread may have been posted although Azure DevOps did not confirm it. */
	const fail = (reason: string, uncertain = false): Error => {
		const done = parts.filter((part) => posted.has(part.key)).length;
		const retry = "Publish the review again to post the rest; threads already posted are not posted again.";
		if (uncertain) return new Error(`${reason} The review may be partly on the pull request. ${retry}`);
		return new Error(
			done === 0
				? `${reason} Nothing was published.`
				: `${reason} ${done} of ${parts.length} comment threads of this review are on the pull request. ${retry}`,
		);
	};
	const pending = parts.filter((part) => !posted.has(part.key));
	const inline = pending.flatMap((part) => (part.comment ? [part.comment] : []));
	let position: { iteration: number; changeTrackingIds: ReadonlyMap<string, number> } | undefined;
	if (inline.length > 0) {
		if (request.mergeBaseCommit === undefined) {
			throw fail(
				"The review did not record the merge base it compared against, so its findings cannot be placed. Run a new review.",
			);
		}
		const iteration = await readReviewedIteration(
			locator,
			path,
			request.pullRequest.headRefOid,
			request.mergeBaseCommit,
		);
		if (typeof iteration === "string") throw fail(`Could not find the reviewed pull request iteration. ${iteration}`);
		const ids = await readChangeTrackingIds(locator, path, iteration, new Set(inline.map((comment) => comment.path)));
		if (typeof ids === "string") throw fail(`Could not read the pull request iteration's changes. ${ids}`);
		const missing = inline.find((comment) => !ids.has(comment.path));
		if (missing) {
			throw fail(
				`Azure DevOps does not list ${JSON.stringify(missing.path)} among the reviewed iteration's changes, so its finding cannot be placed on its lines.`,
			);
		}
		position = { iteration, changeTrackingIds: ids };
	}
	for (const part of pending) {
		const response = await requestAzureDevOps({
			organization: locator.repository.organization,
			path: `${path}/threads`,
			body: threadOf(part, request.runId, position),
		});
		if (!response.ok) {
			// A timeout, a lost connection, a server error, or an unreadable reply may follow a thread that was posted.
			const uncertain = !(
				REFUSED_FAILURES.has(response.failure) ||
				(response.failure === "http-error" && response.message !== undefined)
			);
			throw fail(
				`${uncertain ? "Could not confirm a comment thread was posted." : "Azure DevOps did not post a comment thread of the review."} ${failureReason(response)}`,
				uncertain,
			);
		}
		const id = isRecord(response.value) ? positiveInteger(response.value.id) : undefined;
		if (id === undefined) {
			throw fail(
				`Could not confirm a comment thread was posted. ${azureDevOpsFailureMessage("invalid-response")}`,
				true,
			);
		}
		posted.set(part.key, id);
	}
	const summary = posted.get(SUMMARY_PART)!;
	return { reviewId: summary, url: `${locator.url}?discussionId=${summary}` };
}
