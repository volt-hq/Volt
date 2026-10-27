import { runGitHubCli } from "./github-cli.ts";
import { canonicalizeGitHubRemoteUrl } from "./github-cli-discovery.ts";
import {
	reviewTargetFailure as failure,
	type ReviewTargetFailure,
	readReviewRemoteUrls,
	selectCurrentReviewRemote,
	selectNumberedReviewRemote,
} from "./review-remote.ts";
import type { CodeHostPullRequestSummary, ReviewCodeHostContextCaptureOptions } from "./types.ts";

interface GitHubPullRequestLocator {
	url: string;
	hostname: string;
	repository: string;
	number: number;
}

export function parseGitHubPullRequestUrl(value: string): GitHubPullRequestLocator | undefined {
	if (value.length > 2_000 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return undefined;
	try {
		const url = new URL(value);
		const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/.exec(url.pathname);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!match ||
			!Number.isSafeInteger(Number(match[3]))
		)
			return undefined;
		return {
			url: url.href,
			hostname: url.host,
			repository: `${url.host}/${match[1]}/${match[2]}`.toLowerCase(),
			number: Number(match[3]),
		};
	} catch {
		return undefined;
	}
}

type CurrentPullRequestTarget =
	| (CodeHostPullRequestSummary & {
			ok: true;
			kind: "current";
			id: string;
			headBranch: string;
			remote: string;
			remoteUrl: string;
	  })
	| ReviewTargetFailure;

async function resolveReviewRemoteRepository(
	remote: string,
	options: ReviewCodeHostContextCaptureOptions,
): Promise<{ ok: true; repository: string; remoteUrl: string } | ReviewTargetFailure> {
	const urls = await readReviewRemoteUrls(remote, options);
	if (!Array.isArray(urls)) return urls;
	const repositories = new Set<string>();
	for (const value of urls) {
		const repository = canonicalizeGitHubRemoteUrl(value);
		const locator = repository && parseGitHubPullRequestUrl(`https://${repository.host}/${repository.path}/pull/1`);
		if (!locator)
			return failure(
				"The review remote is not a supported credential-free GitHub URL. Check its configuration on the host.",
			);
		repositories.add(locator.repository);
	}
	if (repositories.size !== 1) {
		return failure(
			"The review remote does not identify one GitHub repository. Configure one unambiguous repository on the host.",
		);
	}
	// Git fetch uses the first URL; retain that exact validated transport, not just its repository name.
	return { ok: true, repository: repositories.values().next().value!, remoteUrl: urls[0]! };
}

/** Pin numbered lookups too: gh otherwise prefers a fork's parent repository. */
export async function resolveNumberedReviewPullRequest(
	options: ReviewCodeHostContextCaptureOptions,
): Promise<{ ok: true; kind: "numbered"; url: string; remote: string; remoteUrl: string } | ReviewTargetFailure> {
	try {
		const selected = await selectNumberedReviewRemote(options);
		if (!selected.ok) return selected;
		const { remote } = selected;
		const repository = await resolveReviewRemoteRepository(remote, options);
		if (!repository.ok) return repository;
		const locator = parseGitHubPullRequestUrl(`https://${repository.repository}/pull/${options.number}`);
		if (!locator || locator.number > options.maxPullRequestNumber)
			return failure("Specify a valid positive PR number within the supported range.");
		return { ok: true, kind: "numbered", url: locator.url, remote, remoteUrl: repository.remoteUrl };
	} catch {
		if (options.signal?.aborted) throw new Error("GitHub context capture was cancelled.");
		return failure(
			"Could not resolve the numbered PR repository safely. Check Git configuration on the host and retry.",
		);
	}
}

/** Resolve only in the tracked repository; never inherit gh's fork/default-repository selection. */
export async function resolveCurrentReviewPullRequest(
	options: ReviewCodeHostContextCaptureOptions,
): Promise<CurrentPullRequestTarget> {
	try {
		const selected = await selectCurrentReviewRemote(options);
		if (!selected.ok) return selected;
		const { remote, headBranch } = selected;
		const resolvedRepository = await resolveReviewRemoteRepository(remote, options);
		if (!resolvedRepository.ok) return resolvedRepository;
		const { repository } = resolvedRepository;
		const result = await runGitHubCli(
			[
				"pr",
				"list",
				"--repo",
				repository,
				"--head",
				headBranch,
				"--state",
				"all",
				"--limit",
				"100",
				"--json",
				"id,number,title,url,state,headRefName,headRepository,headRepositoryOwner",
			],
			{ cwd: options.cwd, signal: options.signal, stdoutMaxBytes: 256 * 1024 },
		);
		if (!result.ok) {
			return failure(
				"Could not look up the tracked branch's pull request. Check GitHub CLI installation, authentication, repository access, and connectivity on the host, then retry.",
			);
		}
		const values: unknown = JSON.parse(result.stdout.toString("utf8"));
		if (!Array.isArray(values) || values.length >= 100) {
			return failure(
				"Could not establish a unique pull request for the tracked branch. Specify a PR number or check the repository on the host.",
			);
		}
		const active = new Map<string, CodeHostPullRequestSummary & { id: string }>();
		const historical = new Map<string, CodeHostPullRequestSummary & { id: string }>();
		let hasUnavailableHistoricalHead = false;
		for (const item of values) {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error();
			const value = item as Record<string, unknown>;
			const locator = typeof value.url === "string" ? parseGitHubPullRequestUrl(value.url) : undefined;
			if (
				!locator ||
				locator.repository !== repository ||
				locator.number !== value.number ||
				locator.number > options.maxPullRequestNumber ||
				typeof value.title !== "string" ||
				typeof value.id !== "string" ||
				!value.id ||
				value.id.length > 500
			)
				throw new Error();
			const head = value.headRepository as Record<string, unknown> | null;
			const owner = value.headRepositoryOwner as Record<string, unknown> | null;
			if (
				(head !== null && (!head || typeof head.name !== "string")) ||
				(owner !== null && (!owner || typeof owner.login !== "string")) ||
				typeof value.headRefName !== "string"
			)
				throw new Error();
			if (head === null || owner === null) {
				if (value.state !== "CLOSED" && value.state !== "MERGED") throw new Error();
				// Deleted historical heads cannot compete with active matches, but make historical lookup uncertain.
				hasUnavailableHistoricalHead = true;
				continue;
			}
			if (
				`${locator.hostname}/${owner.login}/${head.name}`.toLowerCase() !== repository ||
				value.headRefName !== headBranch
			)
				continue;
			if (value.state !== "OPEN" && value.state !== "CLOSED" && value.state !== "MERGED") throw new Error();
			(value.state === "OPEN" ? active : historical).set(locator.url, {
				url: locator.url,
				id: value.id,
				number: locator.number,
				title: value.title,
			});
		}
		if (active.size === 0 && hasUnavailableHistoricalHead)
			return failure(
				"Could not establish a unique historical pull request because head repository metadata is unavailable. Specify the intended PR number.",
			);
		const matches = active.size > 0 ? active : historical;
		if (matches.size === 0)
			return failure(
				"No pull request matches the tracked branch in its repository. Open a PR there, correct the tracking branch, or specify a PR number.",
			);
		if (matches.size > 1)
			return failure("Multiple pull requests match the tracked branch. Specify the intended PR number.");
		return {
			ok: true,
			kind: "current",
			...matches.values().next().value!,
			headBranch,
			remote,
			remoteUrl: resolvedRepository.remoteUrl,
		};
	} catch {
		if (options.signal?.aborted) throw new Error("GitHub context capture was cancelled.");
		return failure(
			"Could not resolve the current pull request safely. Check Git tracking configuration and GitHub CLI on the host, then retry.",
		);
	}
}
