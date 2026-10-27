import { Buffer } from "node:buffer";
import {
	AZURE_DEVOPS_HOST,
	AZURE_DEVOPS_PROVIDER_ID,
	type AzureDevOpsPullRequestLocator,
	type AzureDevOpsRepositoryName,
	azureDevOpsPullRequestUrl,
	parseAzureDevOpsPullRequestUrl,
} from "./azure-devops-remote.ts";
import { azureDevOpsFailureMessage, isRecord, requestAzureDevOps } from "./azure-devops-rest.ts";
import {
	type AzureDevOpsReviewTarget,
	azureDevOpsRepositoryPath,
	resolveCurrentAzureDevOpsPullRequest,
	resolveNumberedAzureDevOpsPullRequest,
	sameAzureDevOpsName,
} from "./azure-devops-review-target.ts";
import {
	addLimitation,
	appendDiscussion,
	boundedStructuralString,
	boundedText,
	type CaptureState,
	finalizeCodeHostContext,
	REVIEW_CODE_HOST_LINKED_ISSUE_LIMIT,
} from "./context-render.ts";
import type {
	PullRequestFetchPlan,
	ReviewCodeHostActor,
	ReviewCodeHostContextCaptureOptions,
	ReviewCodeHostContextCaptureResult,
	ReviewCodeHostContextLimitation,
	ReviewCodeHostDiscussionEntry,
	ReviewCodeHostIdentityCaptureResult,
	ReviewCodeHostLinkedIssue,
	ReviewPullRequestCheckSummary,
	ReviewPullRequestIdentity,
	ReviewPullRequestMergeability,
	ReviewPullRequestReviewState,
} from "./types.ts";

const DISPLAY_NAME = "Azure DevOps";
const DISCUSSION_LIMIT_SOURCE = "azure-devops-discussion";
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECK_LIMIT = 10_000;
const RESOLVED_THREAD_STATUSES = new Set(["fixed", "wontFix", "closed", "byDesign"]);
const WORK_ITEM_FIELDS = [
	"System.Title",
	"System.Description",
	"System.State",
	"System.Reason",
	"System.TeamProject",
	"System.CreatedBy",
	"System.CreatedDate",
	"System.ChangedDate",
];

type Failure = Extract<ReviewCodeHostContextCaptureResult, { ok: false }>;
type ThreadInfo = NonNullable<ReviewCodeHostDiscussionEntry["thread"]>;
type CheckOutcome = "passed" | "pending" | "failed" | "neutral" | "unknown";

/** A pull request as Azure DevOps reports it, with the ids later requests address it by. */
interface AzureDevOpsPullRequest {
	identity: ReviewPullRequestIdentity;
	organization: string;
	projectId: string;
	repositoryId: string;
	codeReviewId: number;
}

function failure(error: string, remoteError = error): Failure {
	return { ok: false, error, remoteError };
}

function pullRequestPath(pullRequest: AzureDevOpsPullRequest): string {
	return `/${pullRequest.projectId}/_apis/git/repositories/${pullRequest.repositoryId}/pullRequests/${pullRequest.identity.number}`;
}

function byId(left: unknown, right: unknown): number {
	const id = (value: unknown): number => (isRecord(value) && typeof value.id === "number" ? value.id : 0);
	return id(left) - id(right);
}

/** A branch name from a `refs/heads/` ref, when it is a name Git accepts in a fetch refspec. */
function branchName(ref: unknown): string | undefined {
	if (typeof ref !== "string" || !ref.startsWith("refs/heads/")) return undefined;
	const name = ref.slice("refs/heads/".length);
	if (
		!name ||
		name.length > 1024 ||
		name.startsWith("-") ||
		name.endsWith(".") ||
		/[\u0000-\u0020\u007f~^:?*[\\]/u.test(name) ||
		name.includes("..") ||
		name.includes("@{") ||
		name.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
	) {
		return undefined;
	}
	return name;
}

function actor(value: unknown): ReviewCodeHostActor | undefined {
	if (!isRecord(value)) return undefined;
	const login = boundedStructuralString(value.uniqueName, 500) || boundedStructuralString(value.displayName, 500);
	return login ? { login, type: "User" } : undefined;
}

function reviewState(status: unknown, isDraft: unknown): ReviewPullRequestReviewState | undefined {
	if (status === "completed") return "merged";
	if (status === "abandoned") return "closed";
	if (status !== "active" || typeof isDraft !== "boolean") return undefined;
	return isDraft ? "draft" : "ready";
}

function mergeability(mergeStatus: unknown): ReviewPullRequestMergeability | undefined {
	if (mergeStatus === "succeeded") return "mergeable";
	if (mergeStatus === "conflicts") return "conflicting";
	return typeof mergeStatus === "string" ? "unknown" : undefined;
}

function statusOutcome(state: unknown): CheckOutcome {
	switch (state) {
		case "succeeded":
			return "passed";
		case "notSet":
		case "pending":
			return "pending";
		case "failed":
		case "error":
			return "failed";
		case "notApplicable":
		case "partiallySucceeded":
			return "neutral";
		default:
			return "unknown";
	}
}

function policyOutcome(status: unknown): CheckOutcome {
	switch (status) {
		case "approved":
			return "passed";
		case "queued":
		case "running":
			return "pending";
		case "rejected":
		case "broken":
			return "failed";
		case "notApplicable":
			return "neutral";
		default:
			return "unknown";
	}
}

function checkSummary(outcomes: readonly CheckOutcome[]): ReviewPullRequestCheckSummary {
	const count = (outcome: CheckOutcome): number => outcomes.filter((candidate) => candidate === outcome).length;
	const failedCount = count("failed");
	const pendingCount = count("pending");
	const unknownCount = count("unknown");
	return {
		state:
			outcomes.length === 0
				? "none"
				: failedCount > 0
					? "failing"
					: pendingCount > 0
						? "pending"
						: unknownCount > 0
							? "unknown"
							: "passing",
		totalCount: outcomes.length,
		passedCount: count("passed"),
		pendingCount,
		failedCount,
		neutralCount: count("neutral"),
		unknownCount,
	};
}

function parsePullRequest(
	value: unknown,
	target: AzureDevOpsReviewTarget,
	limitations: ReviewCodeHostContextLimitation[],
	observedAt: number,
): AzureDevOpsPullRequest | undefined {
	if (!isRecord(value) || !isRecord(value.repository) || !isRecord(value.repository.project)) return undefined;
	const repository = value.repository;
	const project = value.repository.project;
	const headRefName = branchName(value.sourceRefName);
	const baseRefName = branchName(value.targetRefName);
	const headRefOid = isRecord(value.lastMergeSourceCommit) ? value.lastMergeSourceCommit.commitId : undefined;
	const baseRefOid = isRecord(value.lastMergeTargetCommit) ? value.lastMergeTargetCommit.commitId : undefined;
	if (
		value.pullRequestId !== target.number ||
		typeof value.title !== "string" ||
		(value.description !== undefined && typeof value.description !== "string") ||
		!headRefName ||
		!baseRefName ||
		typeof headRefOid !== "string" ||
		!OID_PATTERN.test(headRefOid) ||
		typeof baseRefOid !== "string" ||
		!OID_PATTERN.test(baseRefOid) ||
		typeof repository.id !== "string" ||
		!GUID_PATTERN.test(repository.id) ||
		typeof project.id !== "string" ||
		!GUID_PATTERN.test(project.id) ||
		typeof repository.name !== "string" ||
		typeof project.name !== "string" ||
		!sameAzureDevOpsName(repository.name, target.name.repository) ||
		!sameAzureDevOpsName(project.name, target.name.project)
	) {
		return undefined;
	}
	// The web URL takes the names' casing from the host; parsing it back rejects names a URL cannot carry.
	const name: AzureDevOpsRepositoryName = {
		organization: target.name.organization,
		project: project.name,
		repository: repository.name,
	};
	const locator = parseAzureDevOpsPullRequestUrl(azureDevOpsPullRequestUrl(name, target.number));
	if (!locator) return undefined;
	const state = reviewState(value.status, value.isDraft);
	const merge = mergeability(value.mergeStatus);
	const authorLogin = isRecord(value.createdBy) ? value.createdBy.uniqueName : undefined;
	const author =
		typeof authorLogin === "string" &&
		authorLogin.trim() &&
		Buffer.byteLength(authorLogin.trim(), "utf8") <= 256 &&
		!/[\s\u0000-\u001f\u007f]/u.test(authorLogin.trim())
			? { login: authorLogin.trim() }
			: undefined;
	const codeReviewId = value.codeReviewId;
	return {
		identity: {
			providerId: AZURE_DEVOPS_PROVIDER_ID,
			number: target.number,
			title: boundedText(value.title, "pull-request-title", limitations),
			body: boundedText(value.description ?? "", "pull-request-body", limitations),
			url: locator.url,
			baseRefName,
			headRefName,
			baseRefOid,
			headRefOid,
			...(author ? { author } : {}),
			// Health fields are optional display metadata, not required review evidence.
			...(state ? { reviewState: state } : {}),
			...(merge ? { mergeability: merge } : {}),
			observedAt,
		},
		organization: target.name.organization,
		projectId: project.id,
		repositoryId: repository.id,
		codeReviewId:
			typeof codeReviewId === "number" && Number.isSafeInteger(codeReviewId) && codeReviewId > 0
				? codeReviewId
				: target.number,
	};
}

/** PR statuses (latest per context) and enabled branch policy evaluations; undefined unless both are read. */
async function capturePullRequestChecks(
	pullRequest: AzureDevOpsPullRequest,
	signal?: AbortSignal,
): Promise<ReviewPullRequestCheckSummary | undefined> {
	const [statuses, evaluations] = await Promise.all([
		requestAzureDevOps({
			organization: pullRequest.organization,
			path: `${pullRequestPath(pullRequest)}/statuses`,
			signal,
		}),
		requestAzureDevOps({
			organization: pullRequest.organization,
			path: `/${pullRequest.projectId}/_apis/policy/evaluations`,
			query: {
				artifactId: `vstfs:///CodeReview/CodeReviewId/${pullRequest.projectId}/${pullRequest.codeReviewId}`,
			},
			apiVersion: "7.1-preview.1",
			signal,
		}),
	]);
	const statusValues = statuses.ok && isRecord(statuses.value) ? statuses.value.value : undefined;
	const evaluationValues = evaluations.ok && isRecord(evaluations.value) ? evaluations.value.value : undefined;
	// Health is optional display metadata. Never label a partial check list as passing.
	if (
		!Array.isArray(statusValues) ||
		!Array.isArray(evaluationValues) ||
		statusValues.length + evaluationValues.length > CHECK_LIMIT
	) {
		return undefined;
	}
	const latest = new Map<string, { id: number; state: unknown }>();
	for (const status of statusValues) {
		if (!isRecord(status) || !isRecord(status.context) || typeof status.context.name !== "string") return undefined;
		if (typeof status.id !== "number") return undefined;
		const key = JSON.stringify([status.context.genre ?? "", status.context.name]);
		const previous = latest.get(key);
		if (!previous || status.id > previous.id) latest.set(key, { id: status.id, state: status.state });
	}
	const outcomes = [...latest.values()].map((status) => statusOutcome(status.state));
	for (const evaluation of evaluationValues) {
		if (!isRecord(evaluation)) return undefined;
		if (isRecord(evaluation.configuration) && evaluation.configuration.isEnabled === false) continue;
		outcomes.push(policyOutcome(evaluation.status));
	}
	return checkSummary(outcomes);
}

function parseWorkItem(
	value: unknown,
	organization: string,
	limitations: ReviewCodeHostContextLimitation[],
): ReviewCodeHostLinkedIssue | undefined {
	if (!isRecord(value) || !isRecord(value.fields)) return undefined;
	const { id, fields } = value;
	const project = boundedStructuralString(fields["System.TeamProject"], 1_000);
	const state = boundedStructuralString(fields["System.State"], 100);
	if (
		typeof id !== "number" ||
		!Number.isSafeInteger(id) ||
		id < 1 ||
		!project ||
		!state ||
		typeof fields["System.Title"] !== "string"
	) {
		return undefined;
	}
	const stateReason = boundedStructuralString(fields["System.Reason"], 100);
	const author = actor(fields["System.CreatedBy"]);
	const createdAt = boundedStructuralString(fields["System.CreatedDate"], 100);
	const updatedAt = boundedStructuralString(fields["System.ChangedDate"], 100);
	return {
		id: String(id),
		repository: project,
		number: id,
		title: boundedText(fields["System.Title"], "linked-issue-title", limitations),
		body: boundedText(fields["System.Description"], "linked-issue-body", limitations),
		url: `https://${AZURE_DEVOPS_HOST}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_workitems/edit/${id}`,
		state,
		...(stateReason ? { stateReason } : {}),
		// Azure DevOps records that a work item is linked, not whether completing the pull request resolves it.
		relationship: "manual",
		...(author ? { author } : {}),
		...(createdAt ? { createdAt } : {}),
		...(updatedAt ? { updatedAt } : {}),
	};
}

/** The pull request's linked work items, in link order. */
async function captureWorkItems(
	pullRequest: AzureDevOpsPullRequest,
	limitations: ReviewCodeHostContextLimitation[],
	signal?: AbortSignal,
): Promise<ReviewCodeHostLinkedIssue[]> {
	const source = "linked-issues";
	const references = await requestAzureDevOps({
		organization: pullRequest.organization,
		path: `${pullRequestPath(pullRequest)}/workitems`,
		signal,
	});
	if (!references.ok) {
		addLimitation(limitations, "api-error", source);
		return [];
	}
	const values = isRecord(references.value) ? references.value.value : undefined;
	if (!Array.isArray(values)) {
		addLimitation(limitations, "invalid-api-response", source);
		return [];
	}
	const ids: number[] = [];
	for (const value of values) {
		const id = isRecord(value) ? Number(value.id) : Number.NaN;
		if (!Number.isSafeInteger(id) || id < 1) addLimitation(limitations, "invalid-api-response", source);
		else if (!ids.includes(id)) ids.push(id);
	}
	if (ids.length > REVIEW_CODE_HOST_LINKED_ISSUE_LIMIT) {
		addLimitation(limitations, "linked-issue-limit", source);
		ids.length = REVIEW_CODE_HOST_LINKED_ISSUE_LIMIT;
	}
	if (ids.length === 0) return [];
	const items = await requestAzureDevOps({
		organization: pullRequest.organization,
		path: "/_apis/wit/workitems",
		// An item the credentials cannot read comes back empty instead of failing the whole batch.
		query: { ids: ids.join(","), fields: WORK_ITEM_FIELDS.join(","), errorPolicy: "omit" },
		signal,
	});
	const workItems = items.ok && isRecord(items.value) ? items.value.value : undefined;
	if (!Array.isArray(workItems)) {
		addLimitation(limitations, items.ok ? "invalid-api-response" : "api-error", source);
		return [];
	}
	const issues: ReviewCodeHostLinkedIssue[] = [];
	for (const id of ids) {
		const item = workItems.find((candidate) => isRecord(candidate) && candidate.id === id);
		const issue = item === undefined ? undefined : parseWorkItem(item, pullRequest.organization, limitations);
		if (issue) issues.push(issue);
		else addLimitation(limitations, item === undefined ? "api-error" : "invalid-api-response", source);
	}
	return issues;
}

function parseWorkItemComment(
	value: unknown,
	issue: ReviewCodeHostLinkedIssue,
	limitations: ReviewCodeHostContextLimitation[],
): ReviewCodeHostDiscussionEntry | undefined {
	if (!isRecord(value) || typeof value.id !== "number" || typeof value.text !== "string") return undefined;
	const author = actor(value.createdBy);
	const createdAt = boundedStructuralString(value.createdDate, 100);
	const updatedAt = boundedStructuralString(value.modifiedDate, 100);
	return {
		id: `workitem/${issue.number}/comment/${value.id}`,
		kind: "linked-issue-comment",
		body: boundedText(value.text, "linked-issue-comment-body", limitations),
		url: issue.url,
		...(author ? { author } : {}),
		...(createdAt ? { createdAt } : {}),
		...(updatedAt ? { updatedAt } : {}),
		issue: { repository: issue.repository, number: issue.number },
	};
}

async function captureWorkItemComments(
	pullRequest: AzureDevOpsPullRequest,
	issues: readonly ReviewCodeHostLinkedIssue[],
	state: CaptureState,
	signal?: AbortSignal,
): Promise<void> {
	const source = "linked-issue-comments";
	for (const issue of issues) {
		const seenTokens = new Set<string>();
		let continuationToken: string | undefined;
		while (true) {
			const response = await requestAzureDevOps({
				organization: pullRequest.organization,
				path: `/${encodeURIComponent(issue.repository)}/_apis/wit/workItems/${issue.number}/comments`,
				query: { $top: "200", order: "asc", ...(continuationToken ? { continuationToken } : {}) },
				apiVersion: "7.1-preview.4",
				signal,
			});
			const page = response.ok ? response.value : undefined;
			if (!isRecord(page) || !Array.isArray(page.comments)) {
				addLimitation(state.limitations, response.ok ? "invalid-api-response" : "api-error", source);
				break;
			}
			for (const comment of page.comments) {
				if (isRecord(comment) && comment.isDeleted === true) continue;
				const entry = parseWorkItemComment(comment, issue, state.limitations);
				if (!appendDiscussion(state, entry, source, DISCUSSION_LIMIT_SOURCE)) return;
			}
			const next = boundedStructuralString(page.continuationToken, 2_000);
			if (!next) break;
			if (seenTokens.has(next)) {
				addLimitation(state.limitations, "invalid-api-response", source);
				break;
			}
			seenTokens.add(next);
			continuationToken = next;
		}
	}
}

function threadLine(value: unknown): number | undefined {
	const line = isRecord(value) ? value.line : undefined;
	return typeof line === "number" && Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

function parseThread(value: Record<string, unknown>): ThreadInfo | undefined {
	const context = value.threadContext;
	if (context !== undefined && context !== null && !isRecord(context)) return undefined;
	const status = boundedStructuralString(value.status, 100);
	const thread: ThreadInfo = {
		id: String(value.id),
		isResolved: status !== undefined && RESOLVED_THREAD_STATUSES.has(status),
		// Azure DevOps does not mark threads outdated; it tracks their position across iterations instead.
		isOutdated: false,
	};
	if (!isRecord(context)) return thread;
	const path = boundedStructuralString(context.filePath, 4_096)?.replace(/^\/+/, "");
	const right = isRecord(context.rightFileStart);
	const startLine = threadLine(right ? context.rightFileStart : context.leftFileStart);
	const endLine = threadLine(right ? context.rightFileEnd : context.leftFileEnd) ?? startLine;
	return {
		...thread,
		...(path ? { path } : {}),
		...(endLine === undefined ? {} : { line: endLine, diffSide: right ? "RIGHT" : "LEFT" }),
		...(startLine !== undefined && startLine !== endLine ? { startLine } : {}),
	};
}

function parseThreadComment(
	value: Record<string, unknown>,
	thread: ThreadInfo,
	status: string | undefined,
	pullRequestUrl: string,
	limitations: ReviewCodeHostContextLimitation[],
): ReviewCodeHostDiscussionEntry | undefined {
	if (typeof value.id !== "number" || typeof value.content !== "string") return undefined;
	const author = actor(value.author);
	const createdAt = boundedStructuralString(value.publishedDate, 100);
	const updatedAt = boundedStructuralString(value.lastUpdatedDate, 100);
	const parent = value.parentCommentId;
	return {
		id: `thread/${thread.id}/comment/${value.id}`,
		kind: thread.path ? "review-thread-comment" : "pr-comment",
		body: boundedText(value.content, thread.path ? "review-thread-comment-body" : "pr-comment-body", limitations),
		url: `${pullRequestUrl}?discussionId=${thread.id}`,
		...(author ? { author } : {}),
		...(createdAt ? { createdAt } : {}),
		...(updatedAt ? { updatedAt } : {}),
		...(status ? { state: status } : {}),
		thread,
		...(typeof parent === "number" && Number.isSafeInteger(parent) && parent > 0
			? { replyToId: `thread/${thread.id}/comment/${parent}` }
			: {}),
	};
}

/** Comment threads, general and inline; false once the discussion limit is reached. */
async function captureThreads(
	pullRequest: AzureDevOpsPullRequest,
	state: CaptureState,
	signal?: AbortSignal,
): Promise<boolean> {
	const source = "pr-threads";
	const response = await requestAzureDevOps({
		organization: pullRequest.organization,
		path: `${pullRequestPath(pullRequest)}/threads`,
		signal,
	});
	const threads = response.ok && isRecord(response.value) ? response.value.value : undefined;
	if (!Array.isArray(threads)) {
		addLimitation(state.limitations, response.ok ? "invalid-api-response" : "api-error", source);
		return true;
	}
	for (const value of [...threads].sort(byId)) {
		const thread = isRecord(value) && typeof value.id === "number" ? parseThread(value) : undefined;
		if (!isRecord(value) || !thread || !Array.isArray(value.comments)) {
			addLimitation(state.limitations, "invalid-api-response", source);
			continue;
		}
		if (value.isDeleted === true) continue;
		const status = boundedStructuralString(value.status, 100);
		for (const comment of [...value.comments].sort(byId)) {
			// System comments record votes, pushes, and policy updates rather than discussion.
			if (isRecord(comment) && (comment.commentType === "system" || comment.isDeleted === true)) continue;
			const entry = isRecord(comment)
				? parseThreadComment(comment, thread, status, pullRequest.identity.url, state.limitations)
				: undefined;
			if (!appendDiscussion(state, entry, source, DISCUSSION_LIMIT_SOURCE)) return false;
		}
	}
	return true;
}

/** The pull request's current source commit, read by the names its web URL carries. */
export async function readAzureDevOpsPullRequestHead(
	locator: AzureDevOpsPullRequestLocator,
	signal?: AbortSignal,
): Promise<{ ok: true; headRefOid: string } | Failure> {
	const response = await requestAzureDevOps({
		organization: locator.repository.organization,
		path: `${azureDevOpsRepositoryPath(locator.repository)}/pullrequests/${locator.number}`,
		signal,
	});
	if (!response.ok) {
		return failure(
			`Could not recheck the pull request head. ${azureDevOpsFailureMessage(response.failure)}`,
			"Could not recheck the pull request head with Azure DevOps.",
		);
	}
	const value = response.value;
	const head =
		isRecord(value) && isRecord(value.lastMergeSourceCommit) ? value.lastMergeSourceCommit.commitId : undefined;
	if (
		!isRecord(value) ||
		value.pullRequestId !== locator.number ||
		typeof head !== "string" ||
		!OID_PATTERN.test(head)
	) {
		return failure("Could not parse the pull request head Azure DevOps reported.");
	}
	return { ok: true, headRefOid: head };
}

async function finalHeadCheck(pullRequest: AzureDevOpsPullRequest, signal?: AbortSignal): Promise<Failure | undefined> {
	const locator = parseAzureDevOpsPullRequestUrl(pullRequest.identity.url);
	if (!locator) return failure("Could not resolve the selected pull request URL.");
	const head = await readAzureDevOpsPullRequestHead(locator, signal);
	if (!head.ok) return head;
	if (head.headRefOid !== pullRequest.identity.headRefOid) {
		return failure(
			"The pull request moved while Volt captured its Azure DevOps context. Retry the review.",
			"The pull request changed while Volt captured it. Retry the review.",
		);
	}
	return undefined;
}

type LoadedPullRequest =
	| {
			ok: true;
			target: AzureDevOpsReviewTarget;
			pullRequest: AzureDevOpsPullRequest;
			/** What parsing the metadata left out, which the captured context's manifest reports. */
			limitations: ReviewCodeHostContextLimitation[];
	  }
	| { ok: false; error: string; remoteError?: string };

/** Resolve the selected pull request and read its metadata and checks: everything but its work items and threads. */
async function loadPullRequest(options: ReviewCodeHostContextCaptureOptions): Promise<LoadedPullRequest> {
	const limitations: ReviewCodeHostContextLimitation[] = [];
	options.onProgress?.("Loading pull request metadata…");
	const target = options.number
		? await resolveNumberedAzureDevOpsPullRequest(options)
		: await resolveCurrentAzureDevOpsPullRequest(options);
	if (!target.ok) return target;
	if (options.expectedUrl !== undefined) {
		const expected = parseAzureDevOpsPullRequestUrl(options.expectedUrl);
		if (!expected || expected.url.toLowerCase() !== target.url.toLowerCase()) {
			return failure(
				"The selected pull request does not match the resolved review target. Reopen the review picker and select it again.",
			);
		}
	}
	const metadataFailure = "Could not load pull request metadata from Azure DevOps.";
	const response = await requestAzureDevOps({
		organization: target.name.organization,
		path: `${azureDevOpsRepositoryPath(target.name)}/pullrequests/${target.number}`,
		signal: options.signal,
	});
	if (!response.ok) return failure(`${metadataFailure} ${azureDevOpsFailureMessage(response.failure)}`);
	if (isRecord(response.value) && response.value.forkSource !== undefined && response.value.forkSource !== null) {
		return failure(
			"Pull requests from Azure DevOps forks are not supported yet: their source branch is in the fork. Review the change from the fork's repository instead.",
		);
	}
	const pullRequest = parsePullRequest(response.value, target, limitations, Date.now());
	if (!pullRequest) return failure(`${metadataFailure} ${azureDevOpsFailureMessage("invalid-response")}`);
	if (target.kind === "current" && pullRequest.identity.headRefName !== target.headBranch) {
		return failure("Pull request identity could not be verified. Check the target on the host and retry.");
	}
	const checks = await capturePullRequestChecks(pullRequest, options.signal);
	if (checks) pullRequest.identity.checks = checks;
	return { ok: true, target, pullRequest, limitations };
}

function pullRequestFetchPlan(
	target: AzureDevOpsReviewTarget,
	identity: ReviewPullRequestIdentity,
): PullRequestFetchPlan {
	return {
		remote: target.remote,
		remoteUrl: target.remoteUrl,
		base: { remoteRef: `refs/heads/${identity.baseRefName}`, localRef: "refs/review/base" },
		// Azure Repos publishes no pull request head ref, only a merge ref; the source branch must be at the head.
		head: { remoteRef: `refs/heads/${identity.headRefName}`, localRef: "refs/review/head" },
		diffCommand: `git diff ${identity.baseRefOid}...${identity.headRefOid}`,
	};
}

/** The pull request's identity and fetch plan; no work items or threads are read. */
export async function captureAzureDevOpsPullRequestIdentity(
	options: ReviewCodeHostContextCaptureOptions,
): Promise<ReviewCodeHostIdentityCaptureResult> {
	const loaded = await loadPullRequest(options);
	if (!loaded.ok) return loaded;
	options.onProgress?.("Verifying pull request head…");
	const finalError = await finalHeadCheck(loaded.pullRequest, options.signal);
	if (finalError) return finalError;
	const identity = loaded.pullRequest.identity;
	return { ok: true, pullRequest: identity, fetchPlan: pullRequestFetchPlan(loaded.target, identity) };
}

export async function captureAzureDevOpsPullRequestContext(
	options: ReviewCodeHostContextCaptureOptions,
): Promise<ReviewCodeHostContextCaptureResult> {
	const loaded = await loadPullRequest(options);
	if (!loaded.ok) return loaded;
	const { target, pullRequest, limitations } = loaded;

	options.onProgress?.("Capturing pull request context…");
	const workItemLimitations: ReviewCodeHostContextLimitation[] = [];
	const threadState: CaptureState = { limitations: [], discussionEntries: [] };
	const [linkedIssues, underDiscussionLimit] = await Promise.all([
		captureWorkItems(pullRequest, workItemLimitations, options.signal),
		captureThreads(pullRequest, threadState, options.signal),
	]);
	limitations.push(...workItemLimitations, ...threadState.limitations);
	const state: CaptureState = { limitations, discussionEntries: threadState.discussionEntries };
	if (underDiscussionLimit) await captureWorkItemComments(pullRequest, linkedIssues, state, options.signal);

	options.onProgress?.("Verifying pull request head…");
	const finalError = await finalHeadCheck(pullRequest, options.signal);
	if (finalError) return finalError;

	return finalizeCodeHostContext({
		displayName: DISPLAY_NAME,
		pullRequest: pullRequest.identity,
		fetchPlan: pullRequestFetchPlan(target, pullRequest.identity),
		linkedIssues,
		state,
	});
}
