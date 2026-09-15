import { runGitHubCli } from "./github-cli.ts";
import { capturePullRequestContextWithGitHubCli } from "./github-cli-context.ts";
import { parseGitHubPullRequestUrl } from "./github-cli-review-target.ts";
import type {
	CodeHostProvider,
	ReviewCodeHostInlineComment,
	ReviewCodeHostPublishRequest,
	ReviewPullRequestIdentity,
} from "./types.ts";

function parseJsonObject(text: string, label: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
		return parsed as Record<string, unknown>;
	} catch {
		throw new Error(`${label} returned malformed JSON.`);
	}
}

function githubPullRequestLocator(pullRequest: ReviewPullRequestIdentity) {
	if (pullRequest.providerId !== "github") {
		throw new Error(`GitHub CLI cannot operate on code-host provider ${JSON.stringify(pullRequest.providerId)}.`);
	}
	const locator = parseGitHubPullRequestUrl(pullRequest.url);
	if (!locator || locator.number !== pullRequest.number) {
		throw new Error("The captured GitHub pull request identity is invalid. Run a new review before publishing.");
	}
	return locator;
}

function githubInlineComment(comment: ReviewCodeHostInlineComment): Record<string, unknown> {
	const side = comment.side === "head" ? "RIGHT" : "LEFT";
	return {
		path: comment.path,
		line: comment.endLine,
		side,
		...(comment.startLine === comment.endLine ? {} : { start_line: comment.startLine, start_side: side }),
		body: comment.body,
	};
}

async function probeCurrentPullRequest(cwd: string, signal?: AbortSignal) {
	try {
		const result = await runGitHubCli(["pr", "view", "--json", "number,title"], {
			cwd,
			...(signal === undefined ? {} : { signal }),
			stdoutMaxBytes: 16 * 1024,
		});
		if (!result.ok) return undefined;
		const value = parseJsonObject(result.stdout.toString("utf8"), "gh pr view");
		if (
			typeof value.number !== "number" ||
			!Number.isSafeInteger(value.number) ||
			value.number < 1 ||
			typeof value.title !== "string"
		) {
			return undefined;
		}
		return { number: value.number, title: value.title };
	} catch {
		return undefined;
	}
}

async function verifyPullRequestHead(cwd: string, pullRequest: ReviewPullRequestIdentity): Promise<void> {
	const locator = githubPullRequestLocator(pullRequest);
	const result = await runGitHubCli(["pr", "view", locator.url, "--json", "headRefOid"], { cwd });
	if (!result.ok) throw new Error(`Could not verify the pull request head: ${result.stderr.trim()}`);
	const current = parseJsonObject(result.stdout.toString("utf8"), "gh pr view");
	if (current.headRefOid !== pullRequest.headRefOid) {
		throw new Error(
			"The pull request head moved after this review was captured. Run a new review before publishing.",
		);
	}
}

async function publishPullRequestReview(request: ReviewCodeHostPublishRequest) {
	const locator = githubPullRequestLocator(request.pullRequest);
	// The canonical repository includes its host; REST paths need only owner/name.
	const repository = locator.repository.slice(locator.repository.indexOf("/") + 1);
	const payload = JSON.stringify({
		commit_id: request.pullRequest.headRefOid,
		body: request.body,
		event: "COMMENT",
		comments: request.comments.map(githubInlineComment),
	});
	const published = await runGitHubCli(
		[
			"api",
			"--method",
			"POST",
			`repos/${repository}/pulls/${locator.number}/reviews`,
			"--hostname",
			locator.hostname,
			"--input",
			"-",
		],
		{ cwd: request.cwd, input: payload },
	);
	if (!published.ok) {
		throw new Error(`GitHub rejected the review; nothing was marked published: ${published.stderr.trim()}`);
	}
	const response = parseJsonObject(published.stdout.toString("utf8"), "gh api");
	return {
		...(typeof response.id === "number" ? { reviewId: response.id } : {}),
		...(typeof response.html_url === "string" ? { url: response.html_url } : {}),
	};
}

export const githubCliCodeHostProvider: CodeHostProvider = {
	id: "github",
	displayName: "GitHub",
	probeCurrentPullRequest,
	capturePullRequestContext: capturePullRequestContextWithGitHubCli,
	verifyPullRequestHead,
	publishPullRequestReview,
};
