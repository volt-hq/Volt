import {
	AZURE_DEVOPS_PROVIDER_ID,
	type AzureDevOpsRepositoryName,
	azureDevOpsRepositoryNameOf,
} from "./azure-devops-remote.ts";
import { isRecord, requestAzureDevOps } from "./azure-devops-rest.ts";
import { azureDevOpsRepositoryPath, sameAzureDevOpsName } from "./azure-devops-review-target.ts";
import type {
	CodeHostHeadPullRequest,
	CodeHostHeadPullRequestListRequest,
	CodeHostHeadPullRequestListResult,
	CodeHostPullRequestDiscoveryUnavailableReason,
	CodeHostPullRequestStatus,
	CodeHostPullRequestStatusOutcome,
	CodeHostPullRequestStatusRequest,
	CodeHostPullRequestStatusTarget,
} from "./types.ts";

const LIST_LIMIT = 100;
const LIST_MAX_BYTES = 1024 * 1024;
const PULL_REQUEST_MAX_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const STATUS_CONCURRENCY = 4;
const MAX_TITLE_CHARS = 512;

type Read = { ok: true; value: unknown } | { ok: false; reason: CodeHostPullRequestDiscoveryUnavailableReason };

/** One Azure DevOps read for change association: its failure as a discovery reason, never its raw message. */
async function read(
	name: AzureDevOpsRepositoryName,
	path: string,
	options: { query?: Record<string, string>; maxBytes: number; signal?: AbortSignal },
): Promise<Read> {
	let response: Awaited<ReturnType<typeof requestAzureDevOps>>;
	try {
		response = await requestAzureDevOps({
			organization: name.organization,
			path: `${azureDevOpsRepositoryPath(name)}${path}`,
			...(options.query === undefined ? {} : { query: options.query }),
			maxBytes: options.maxBytes,
			timeoutMs: REQUEST_TIMEOUT_MS,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
	} catch {
		// The request throws only when its signal cancels it.
		return { ok: false, reason: "cancelled" };
	}
	if (response.ok) return response;
	switch (response.failure) {
		case "no-credentials":
		case "access-denied":
			return { ok: false, reason: "not_authenticated" };
		case "rate-limited":
			return { ok: false, reason: "rate_limited" };
		case "network":
			return { ok: false, reason: "network" };
		case "timeout":
			return { ok: false, reason: "timeout" };
		case "output-limit":
			return { ok: false, reason: "output_limited" };
		case "invalid-response":
			return { ok: false, reason: "invalid_response" };
		case "not-found":
		case "http-error":
			return { ok: false, reason: "provider_error" };
	}
}

function pullRequestStatus(value: Record<string, unknown>): CodeHostPullRequestStatus | undefined {
	switch (value.status) {
		case "active":
			return value.isDraft === true ? "draft" : "open";
		case "completed":
			return "merged";
		case "abandoned":
			return "closed";
		default:
			return undefined;
	}
}

/** Whether a pull request Azure DevOps returned is in the repository it was read from. */
function inRepository(value: Record<string, unknown>, name: AzureDevOpsRepositoryName): boolean {
	return (
		isRecord(value.repository) &&
		isRecord(value.repository.project) &&
		sameAzureDevOpsName(value.repository.name, name.repository) &&
		sameAzureDevOpsName(value.repository.project.name, name.project)
	);
}

/**
 * Every pull request in the repository from its branch `branch`, in any state. Pull requests from forks are left
 * out: their source branch is in the fork, which no remote of the repository names.
 */
export async function listAzureDevOpsPullRequestsForHeadBranch(
	request: CodeHostHeadPullRequestListRequest,
): Promise<CodeHostHeadPullRequestListResult> {
	const name = azureDevOpsRepositoryNameOf(request.repository);
	if (!name) return { ok: false, reason: "invalid_response" };
	const response = await read(name, "/pullrequests", {
		query: {
			"searchCriteria.sourceRefName": `refs/heads/${request.branch}`,
			"searchCriteria.status": "all",
			$top: String(LIST_LIMIT),
		},
		maxBytes: LIST_MAX_BYTES,
		...(request.signal === undefined ? {} : { signal: request.signal }),
	});
	if (!response.ok) return response;
	const values = isRecord(response.value) ? response.value.value : undefined;
	if (!Array.isArray(values)) return { ok: false, reason: "invalid_response" };
	// A full page may leave matches out.
	if (values.length >= LIST_LIMIT) return { ok: false, reason: "output_limited" };
	const pullRequests: CodeHostHeadPullRequest[] = [];
	for (const value of values) {
		if (!isRecord(value) || !inRepository(value, name)) return { ok: false, reason: "invalid_response" };
		const number = value.pullRequestId;
		const status = pullRequestStatus(value);
		if (
			typeof number !== "number" ||
			!Number.isSafeInteger(number) ||
			number < 1 ||
			typeof value.title !== "string" ||
			typeof value.sourceRefName !== "string" ||
			!status
		) {
			return { ok: false, reason: "invalid_response" };
		}
		if (value.forkSource !== undefined && value.forkSource !== null) continue;
		const commit = isRecord(value.lastMergeSourceCommit) ? value.lastMergeSourceCommit.commitId : undefined;
		pullRequests.push({
			number,
			title: value.title,
			status,
			headRepository: request.repository,
			headBranch: value.sourceRefName.startsWith("refs/heads/")
				? value.sourceRefName.slice("refs/heads/".length)
				: value.sourceRefName,
			// Without a source commit, the pull request cannot match a head.
			headOid: typeof commit === "string" ? commit : "",
		});
	}
	return { ok: true, pullRequests };
}

async function refreshStatus(
	request: CodeHostPullRequestStatusRequest,
	target: CodeHostPullRequestStatusTarget,
): Promise<CodeHostPullRequestStatusOutcome> {
	const name = azureDevOpsRepositoryNameOf({
		providerId: AZURE_DEVOPS_PROVIDER_ID,
		host: request.host,
		path: target.path,
		canonicalId: `${AZURE_DEVOPS_PROVIDER_ID}:${request.host}/${target.path}`,
	});
	if (!name || !Number.isSafeInteger(target.number) || target.number < 1) {
		return { state: "unavailable", reason: "invalid_response" };
	}
	if (request.signal?.aborted) return { state: "unavailable", reason: "cancelled" };
	const response = await read(name, `/pullrequests/${target.number}`, {
		maxBytes: PULL_REQUEST_MAX_BYTES,
		...(request.signal === undefined ? {} : { signal: request.signal }),
	});
	if (!response.ok) return { state: "unavailable", reason: response.reason };
	const value = response.value;
	const status = isRecord(value) ? pullRequestStatus(value) : undefined;
	if (
		!isRecord(value) ||
		!inRepository(value, name) ||
		value.pullRequestId !== target.number ||
		typeof value.title !== "string" ||
		!status
	) {
		return { state: "unavailable", reason: "invalid_response" };
	}
	return { state: "resolved", status, title: value.title.slice(0, MAX_TITLE_CHARS) };
}

/** The current status of already-associated pull requests: one read each, a few at a time, in request order. */
export async function refreshAzureDevOpsPullRequestStatuses(
	request: CodeHostPullRequestStatusRequest,
): Promise<CodeHostPullRequestStatusOutcome[]> {
	const targets = request.pullRequests;
	const outcomes: CodeHostPullRequestStatusOutcome[] = targets.map(() => ({
		state: "unavailable",
		reason: "invalid_response",
	}));
	let next = 0;
	const refreshNext = async (): Promise<void> => {
		while (next < targets.length) {
			const index = next++;
			outcomes[index] = await refreshStatus(request, targets[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(STATUS_CONCURRENCY, targets.length) }, refreshNext));
	return outcomes;
}
