import {
	type AzureDevOpsRepositoryName,
	azureDevOpsPullRequestUrl,
	azureDevOpsRepositoryNameOf,
	canonicalizeAzureDevOpsRemoteUrl,
	parseAzureDevOpsPullRequestUrl,
} from "./azure-devops-remote.ts";
import {
	AZURE_DEVOPS_REQUEST_CANCELLED,
	azureDevOpsFailureMessage,
	isRecord,
	requestAzureDevOps,
} from "./azure-devops-rest.ts";
import {
	reviewTargetFailure as failure,
	type ReviewTargetFailure,
	readReviewRemoteUrls,
	selectCurrentReviewRemote,
	selectNumberedReviewRemote,
} from "./review-remote.ts";
import type { CanonicalCodeHostRepository, ReviewCodeHostContextCaptureOptions } from "./types.ts";

const PULL_REQUEST_LIST_LIMIT = 100;

/** The pull request a review resolved to, in the repository of the selected review remote. */
export interface AzureDevOpsReviewTarget {
	ok: true;
	kind: "current" | "numbered";
	repository: CanonicalCodeHostRepository;
	name: AzureDevOpsRepositoryName;
	number: number;
	/** Web URL of the pull request, as built from the remote's repository names. */
	url: string;
	remote: string;
	remoteUrl: string;
	/** For the current branch's pull request: the tracked branch it must have as its source. */
	headBranch?: string;
	title?: string;
}

type TargetOptions = Pick<ReviewCodeHostContextCaptureOptions, "cwd" | "number" | "maxPullRequestNumber" | "signal">;

/** The REST path of a repository's resources, its segments encoded. */
export function azureDevOpsRepositoryPath(name: AzureDevOpsRepositoryName, repositoryId = name.repository): string {
	return `/${encodeURIComponent(name.project)}/_apis/git/repositories/${encodeURIComponent(repositoryId)}`;
}

/** Whether names an API reports are the repository a remote names; Azure DevOps names are case-insensitive. */
export function sameAzureDevOpsName(left: unknown, right: string): boolean {
	return typeof left === "string" && left.toLowerCase() === right.toLowerCase();
}

async function resolveRemoteRepository(
	remote: string,
	options: TargetOptions,
): Promise<
	| { ok: true; repository: CanonicalCodeHostRepository; name: AzureDevOpsRepositoryName; remoteUrl: string }
	| ReviewTargetFailure
> {
	const urls = await readReviewRemoteUrls(remote, options);
	if (!Array.isArray(urls)) return urls;
	const repositories = new Map<string, CanonicalCodeHostRepository>();
	for (const url of urls) {
		const repository = canonicalizeAzureDevOpsRemoteUrl(url);
		if (!repository)
			return failure(
				"The review remote is not a supported credential-free Azure DevOps URL. Check its configuration on the host.",
			);
		repositories.set(repository.canonicalId, repository);
	}
	const repository = repositories.size === 1 ? repositories.values().next().value : undefined;
	const name = repository && azureDevOpsRepositoryNameOf(repository);
	if (!repository || !name) {
		return failure(
			"The review remote does not identify one Azure DevOps repository. Configure one unambiguous repository on the host.",
		);
	}
	// Git fetch uses the first URL; retain that exact validated transport, not just its repository name.
	return { ok: true, repository, name, remoteUrl: urls[0]! };
}

function cancelledOr(options: TargetOptions, message: string): ReviewTargetFailure {
	if (options.signal?.aborted) throw new Error(AZURE_DEVOPS_REQUEST_CANCELLED);
	return failure(message);
}

export async function resolveNumberedAzureDevOpsPullRequest(
	options: TargetOptions,
): Promise<AzureDevOpsReviewTarget | ReviewTargetFailure> {
	try {
		const number = Number(options.number);
		if (
			!/^[1-9]\d*$/.test(options.number ?? "") ||
			!Number.isSafeInteger(number) ||
			number > options.maxPullRequestNumber
		) {
			return failure("Specify a valid positive PR number within the supported range.");
		}
		const selected = await selectNumberedReviewRemote(options);
		if (!selected.ok) return selected;
		const resolved = await resolveRemoteRepository(selected.remote, options);
		if (!resolved.ok) return resolved;
		return {
			ok: true,
			kind: "numbered",
			repository: resolved.repository,
			name: resolved.name,
			number,
			url: azureDevOpsPullRequestUrl(resolved.name, number),
			remote: selected.remote,
			remoteUrl: resolved.remoteUrl,
		};
	} catch {
		return cancelledOr(
			options,
			"Could not resolve the numbered PR repository safely. Check Git configuration on the host and retry.",
		);
	}
}

/** The tracked branch's pull request in the tracked remote's repository: one active match, else one historical. */
export async function resolveCurrentAzureDevOpsPullRequest(
	options: TargetOptions,
): Promise<AzureDevOpsReviewTarget | ReviewTargetFailure> {
	try {
		const selected = await selectCurrentReviewRemote(options);
		if (!selected.ok) return selected;
		const { remote, headBranch } = selected;
		const resolved = await resolveRemoteRepository(remote, options);
		if (!resolved.ok) return resolved;
		const { name } = resolved;
		const response = await requestAzureDevOps({
			organization: name.organization,
			path: `${azureDevOpsRepositoryPath(name)}/pullrequests`,
			query: {
				"searchCriteria.sourceRefName": `refs/heads/${headBranch}`,
				"searchCriteria.status": "all",
				$top: String(PULL_REQUEST_LIST_LIMIT),
			},
			signal: options.signal,
			maxBytes: 1024 * 1024,
		});
		if (!response.ok) {
			return failure(
				`Could not look up the tracked branch's pull request. ${azureDevOpsFailureMessage(response.failure)}`,
			);
		}
		const values = isRecord(response.value) ? response.value.value : undefined;
		if (!Array.isArray(values) || values.length >= PULL_REQUEST_LIST_LIMIT) {
			return failure(
				"Could not establish a unique pull request for the tracked branch. Specify a PR number or check the repository on the host.",
			);
		}
		const active = new Map<number, { number: number; title: string; url: string }>();
		const historical = new Map<number, { number: number; title: string; url: string }>();
		for (const value of values) {
			if (!isRecord(value) || !isRecord(value.repository) || !isRecord(value.repository.project)) throw new Error();
			const number = value.pullRequestId;
			if (
				typeof number !== "number" ||
				!Number.isSafeInteger(number) ||
				number < 1 ||
				number > options.maxPullRequestNumber ||
				typeof value.title !== "string" ||
				typeof value.status !== "string" ||
				!sameAzureDevOpsName(value.repository.name, name.repository) ||
				!sameAzureDevOpsName(value.repository.project.name, name.project)
			)
				throw new Error();
			// A fork's pull request has its source branch in the fork, not in the tracked repository.
			if (value.forkSource !== undefined && value.forkSource !== null) continue;
			if (value.sourceRefName !== `refs/heads/${headBranch}`) continue;
			// The web URL takes the names' casing from the host; parsing it back rejects names a URL cannot carry.
			const locator = parseAzureDevOpsPullRequestUrl(
				azureDevOpsPullRequestUrl(
					{
						organization: name.organization,
						project: String(value.repository.project.name),
						repository: String(value.repository.name),
					},
					number,
				),
			);
			if (!locator) throw new Error();
			const match = { number, title: value.title, url: locator.url };
			if (value.status === "active") active.set(number, match);
			else if (value.status === "completed" || value.status === "abandoned") historical.set(number, match);
			else throw new Error();
		}
		const matches = active.size > 0 ? active : historical;
		if (matches.size === 0)
			return failure(
				"No pull request matches the tracked branch in its repository. Open a PR there, correct the tracking branch, or specify a PR number.",
			);
		if (matches.size > 1)
			return failure("Multiple pull requests match the tracked branch. Specify the intended PR number.");
		const match = matches.values().next().value!;
		return {
			ok: true,
			kind: "current",
			repository: resolved.repository,
			name,
			number: match.number,
			url: match.url,
			remote,
			remoteUrl: resolved.remoteUrl,
			headBranch,
			title: match.title,
		};
	} catch {
		return cancelledOr(
			options,
			"Could not resolve the current pull request safely. Check Git tracking configuration and Azure DevOps access on the host, then retry.",
		);
	}
}
