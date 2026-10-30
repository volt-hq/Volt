import type { CodeHostIdentity, ResolvedPullRequestCheckout } from "./types.ts";

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

function isCanonicalPullRequestCheckout(
	pullRequest: ResolvedPullRequestCheckout["pullRequest"],
	repositoryId: string,
	headRepositoryId: string,
): boolean {
	let url: URL;
	try {
		url = new URL(pullRequest.url);
	} catch {
		return false;
	}
	const { repository } = pullRequest;
	return (
		pullRequest.provider === "github" &&
		url.protocol === "https:" &&
		url.href === pullRequest.url &&
		!url.username &&
		!url.password &&
		!url.port &&
		!url.search &&
		!url.hash &&
		/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
		url.pathname.toLowerCase() === `/${repository}/pull/${pullRequest.number}`.toLowerCase() &&
		repositoryId === `github:${url.hostname}/${repository}`.toLowerCase() &&
		/^github:[a-z0-9.-]+\/[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(headRepositoryId) &&
		headRepositoryId.startsWith(`github:${url.hostname}/`)
	);
}

export const githubCodeHostIdentity: CodeHostIdentity = {
	id: "github",
	displayName: "GitHub",
	avatarHosts: ["avatars.githubusercontent.com"],
	parsePullRequestUrl(url) {
		const locator = parseGitHubPullRequestUrl(url);
		return locator && { url: locator.url, number: locator.number };
	},
	isCanonicalPullRequestCheckout,
};
