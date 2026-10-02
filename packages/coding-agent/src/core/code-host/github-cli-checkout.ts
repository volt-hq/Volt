import { runGitHubCli } from "./github-cli.ts";
import { canonicalizeGitHubRemoteUrl } from "./github-cli-discovery.ts";
import {
	parseGitHubPullRequestUrl,
	resolveCurrentReviewPullRequest,
	resolveNumberedReviewPullRequest,
} from "./github-cli-review-target.ts";
import type { ResolvePullRequestCheckoutOptions, ResolvePullRequestCheckoutResult } from "./types.ts";

function failure(error: string): ResolvePullRequestCheckoutResult {
	return { ok: false, error, remoteError: error };
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Resolve only checkout metadata. No review capture, agent initialization, or Git fetch. */
export async function resolvePullRequestCheckoutWithGitHubCli(
	options: ResolvePullRequestCheckoutOptions,
): Promise<ResolvePullRequestCheckoutResult> {
	try {
		if (options.signal?.aborted) return failure("Pull request checkout resolution was cancelled.");
		if (
			!Number.isSafeInteger(options.maxPullRequestNumber) ||
			options.maxPullRequestNumber < 1 ||
			(options.number !== undefined &&
				(!/^[1-9]\d*$/.test(options.number) ||
					!Number.isSafeInteger(Number(options.number)) ||
					Number(options.number) > options.maxPullRequestNumber))
		) {
			return failure("Specify a valid positive PR number within the supported range.");
		}
		const selected =
			options.number !== undefined
				? await resolveNumberedReviewPullRequest(options)
				: await resolveCurrentReviewPullRequest(options);
		if (!selected.ok) return selected;
		if (options.expectedUrl !== undefined) {
			const expected = parseGitHubPullRequestUrl(options.expectedUrl);
			if (!expected || expected.url.toLowerCase() !== selected.url.toLowerCase()) {
				return failure(
					"The selected pull request does not match the resolved checkout target. Reopen the review picker and select it again.",
				);
			}
		}
		const result = await runGitHubCli(
			[
				"pr",
				"view",
				selected.url,
				"--json",
				"id,number,title,url,headRefName,headRefOid,headRepository,headRepositoryOwner",
			],
			{
				cwd: options.cwd,
				signal: options.signal,
				stdoutMaxBytes: 64 * 1024,
				stderrMaxBytes: 16 * 1024,
				timeoutMs: 15_000,
			},
		);
		if (!result.ok) {
			return failure(
				"Could not load the pull request checkout target. Check GitHub CLI installation, authentication, repository access, and connectivity on the host, then retry.",
			);
		}
		const value = object(JSON.parse(result.stdout.toString("utf8")) as unknown);
		const locator = typeof value?.url === "string" ? parseGitHubPullRequestUrl(value.url) : undefined;
		const repository = canonicalizeGitHubRemoteUrl(selected.remoteUrl);
		if (
			!value ||
			!locator ||
			!repository ||
			locator.repository !== `${repository.host}/${repository.owner}/${repository.name}` ||
			locator.url.toLowerCase() !== selected.url.toLowerCase() ||
			locator.number !== value.number ||
			locator.number > options.maxPullRequestNumber ||
			typeof value.id !== "string" ||
			!value.id ||
			value.id.length > 500 ||
			typeof value.title !== "string" ||
			value.title.length > 512 ||
			/[\u0000-\u001f\u007f]/u.test(value.title) ||
			typeof value.headRefOid !== "string" ||
			(value.headRefOid.length !== 40 && value.headRefOid.length !== 64) ||
			/[^0-9a-f]/.test(value.headRefOid) ||
			typeof value.headRefName !== "string" ||
			!value.headRefName ||
			value.headRefName.length > 1024 ||
			value.headRefName.startsWith("-") ||
			value.headRefName.endsWith(".") ||
			/[\u0000-\u0020\u007f~^:?*[\\]/u.test(value.headRefName) ||
			value.headRefName.includes("..") ||
			value.headRefName.includes("@{") ||
			value.headRefName.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock")) ||
			(selected.kind === "current" && (value.id !== selected.id || value.headRefName !== selected.headBranch))
		) {
			return failure(
				"Pull request checkout identity could not be verified. Check the target on the host and retry.",
			);
		}
		const head = object(value.headRepository);
		const owner = object(value.headRepositoryOwner);
		if (
			typeof head?.name !== "string" ||
			typeof owner?.login !== "string" ||
			![head.name, owner.login].every(
				(part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part) && part !== "." && part !== "..",
			) ||
			(head.nameWithOwner !== undefined &&
				(typeof head.nameWithOwner !== "string" ||
					head.nameWithOwner.toLowerCase() !== `${owner.login}/${head.name}`.toLowerCase()))
		) {
			return failure(
				"The pull request head repository is unavailable or invalid. Check whether the source repository was deleted and select an available PR.",
			);
		}
		const headRepository = canonicalizeGitHubRemoteUrl(`https://${repository.host}/${owner.login}/${head.name}`);
		if (
			!headRepository ||
			headRepository.owner !== owner.login.toLowerCase() ||
			headRepository.name !== head.name.toLowerCase() ||
			(selected.kind === "current" && headRepository.canonicalId !== repository.canonicalId)
		) {
			return failure(
				"Pull request head repository identity could not be verified. Check the target on the host and retry.",
			);
		}
		return {
			ok: true,
			target: {
				pullRequest: {
					provider: "github",
					url: locator.url,
					number: locator.number,
					title: value.title,
					repository: `${repository.owner}/${repository.name}`,
					headRefName: value.headRefName,
					headRefOid: value.headRefOid,
				},
				repository,
				headRepository,
				remote: selected.remote,
				remoteUrl: selected.remoteUrl,
				headRef: `refs/pull/${locator.number}/head`,
			},
		};
	} catch {
		return failure(
			options.signal?.aborted
				? "Pull request checkout resolution was cancelled."
				: "Could not resolve the pull request checkout safely. Check Git tracking configuration and GitHub CLI on the host, then retry.",
		);
	}
}
