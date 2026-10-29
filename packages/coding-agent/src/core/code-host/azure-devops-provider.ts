import {
	captureAzureDevOpsPullRequestContext,
	captureAzureDevOpsPullRequestIdentity,
	readAzureDevOpsPullRequestHead,
} from "./azure-devops-context.ts";
import {
	listAzureDevOpsPullRequestsForHeadBranch,
	refreshAzureDevOpsPullRequestStatuses,
} from "./azure-devops-discovery.ts";
import { azureDevOpsCodeHostIdentity } from "./azure-devops-identity.ts";
import { publishAzureDevOpsReview } from "./azure-devops-publish.ts";
import {
	AZURE_DEVOPS_PROVIDER_ID,
	canonicalizeAzureDevOpsRemoteUrl,
	parseAzureDevOpsPullRequestUrl,
} from "./azure-devops-remote.ts";
import { resolveCurrentAzureDevOpsPullRequest } from "./azure-devops-review-target.ts";
import type { CodeHostCommandOptions, CodeHostProvider, ReviewPullRequestIdentity } from "./types.ts";

/** The captured pull request's locator; a CLI command override is refused rather than ignored. */
function pullRequestLocator(pullRequest: ReviewPullRequestIdentity, options: CodeHostCommandOptions) {
	if (options.command !== undefined) {
		throw new Error("Azure DevOps pull requests are not reached through a code-host CLI, so no CLI command applies.");
	}
	const locator =
		pullRequest.providerId === AZURE_DEVOPS_PROVIDER_ID ? parseAzureDevOpsPullRequestUrl(pullRequest.url) : undefined;
	if (!locator || locator.number !== pullRequest.number) {
		throw new Error("The captured Azure DevOps pull request identity is invalid. Run a new review.");
	}
	return locator;
}

async function probeCurrentPullRequest(cwd: string, signal?: AbortSignal) {
	try {
		const target = await resolveCurrentAzureDevOpsPullRequest({
			cwd,
			signal,
			maxPullRequestNumber: Number.MAX_SAFE_INTEGER,
		});
		return target.ok && target.title !== undefined
			? { number: target.number, title: target.title, url: target.url }
			: undefined;
	} catch {
		return undefined;
	}
}

async function verifyPullRequestHead(
	_cwd: string,
	pullRequest: ReviewPullRequestIdentity,
	options: CodeHostCommandOptions = {},
): Promise<void> {
	const head = await readAzureDevOpsPullRequestHead(pullRequestLocator(pullRequest, options));
	if (!head.ok) throw new Error(head.error);
	if (head.headRefOid !== pullRequest.headRefOid) {
		throw new Error("The pull request head moved after this review was captured. Run a new review.");
	}
}

export const azureDevOpsCodeHostProvider: CodeHostProvider = {
	...azureDevOpsCodeHostIdentity,
	// Call through the module binding so remote canonicalization stays replaceable in tests.
	canonicalizeRemoteUrl: (url) => canonicalizeAzureDevOpsRemoteUrl(url),
	probeCurrentPullRequest,
	async resolvePullRequestCheckout() {
		const error =
			"Review worktrees are not supported for Azure DevOps pull requests yet. Review the pull request from its repository instead.";
		return { ok: false, error, remoteError: error };
	},
	capturePullRequestContext: captureAzureDevOpsPullRequestContext,
	capturePullRequestIdentity: captureAzureDevOpsPullRequestIdentity,
	verifyPullRequestHead,
	async publishPullRequestReview(request) {
		return publishAzureDevOpsReview(pullRequestLocator(request.pullRequest, request), request);
	},
	listPullRequestsForHeadBranch: listAzureDevOpsPullRequestsForHeadBranch,
	refreshPullRequestStatuses: refreshAzureDevOpsPullRequestStatuses,
};
