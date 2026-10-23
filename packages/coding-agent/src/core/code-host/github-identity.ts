import type { CodeHostIdentity, ResolvedPullRequestCheckout } from "./types.ts";

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
	isCanonicalPullRequestCheckout,
};
