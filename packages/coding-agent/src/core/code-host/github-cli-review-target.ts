import { runGitHubCli } from "./github-cli.ts";
import { canonicalizeGitHubRemoteUrl, unavailableReason } from "./github-cli-discovery.ts";
import { parseGitHubPullRequestUrl } from "./github-identity.ts";
import {
	reviewTargetFailure as failure,
	type ReviewTargetFailure,
	readReviewRemoteUrls,
	selectCurrentReviewRemote,
	selectNumberedReviewRemote,
} from "./review-remote.ts";
import type {
	CodeHostOpenPullRequest,
	CodeHostOpenPullRequestListRequest,
	CodeHostOpenPullRequestListResult,
	CodeHostPullRequestSummary,
	ReviewCodeHostContextCaptureOptions,
} from "./types.ts";

const MAX_PULL_REQUEST_NUMBER = 2_147_483_647;
const MAX_OPEN_LIST_LIMIT = 100;
const MAX_TITLE_CHARS = 512;
const MAX_AUTHOR_CHARS = 256;
const OPEN_LIST_FIELDS = "number,title,url,author,headRefName,isDraft,updatedAt";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

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
	options: Pick<ReviewCodeHostContextCaptureOptions, "cwd" | "signal">,
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

/** A pull request head branch a review checkout accepts: a valid Git branch name it can fetch and name. */
export function isReviewHeadRefName(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= 1024 &&
		!value.startsWith("-") &&
		!value.endsWith(".") &&
		!/[\u0000-\u0020\u007f~^:?*[\\]/u.test(value) &&
		!value.includes("..") &&
		!value.includes("@{") &&
		!value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDisplayText(value: string, maxChars: number): boolean {
	return value.length > 0 && value.length <= maxChars && !CONTROL_CHARACTER.test(value);
}

/**
 * The open pull requests of the repository a numbered review resolves in (its tracking remote, origin, or the only
 * remote), newest first. A response that names another repository, or is malformed, fails the whole list; a pull
 * request a review could not check out or show (by its head branch or title) is left out.
 */
export async function listOpenPullRequestsWithGitHubCli(
	request: CodeHostOpenPullRequestListRequest,
): Promise<CodeHostOpenPullRequestListResult> {
	const { cwd, limit, signal } = request;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OPEN_LIST_LIMIT) {
		return { ok: false, reason: "provider_error" };
	}
	try {
		const selected = await selectNumberedReviewRemote({ cwd, signal });
		if (!selected.ok) return { ok: false, reason: "unsupported_repository" };
		const resolved = await resolveReviewRemoteRepository(selected.remote, { cwd, signal });
		const base = resolved.ok ? canonicalizeGitHubRemoteUrl(resolved.remoteUrl) : null;
		if (!resolved.ok || !base) return { ok: false, reason: "unsupported_repository" };
		const result = await runGitHubCli(
			[
				"pr",
				"list",
				"--repo",
				resolved.repository,
				"--state",
				"open",
				"--limit",
				String(limit + 1),
				"--json",
				OPEN_LIST_FIELDS,
			],
			{
				cwd,
				signal,
				stdoutMaxBytes: 256 * 1024,
				stderrMaxBytes: 32 * 1024,
				timeoutMs: 15_000,
				cancellationMessage: "GitHub pull request listing was cancelled.",
			},
		);
		if (!result.ok) {
			return { ok: false, reason: unavailableReason(result.stderr, result.outputLimited, result.timedOut) };
		}
		let values: unknown;
		try {
			values = JSON.parse(result.stdout.toString("utf8"));
		} catch {
			return { ok: false, reason: "invalid_response" };
		}
		if (!Array.isArray(values) || values.length > limit + 1) return { ok: false, reason: "invalid_response" };
		const numbers = new Set<number>();
		const pullRequests: CodeHostOpenPullRequest[] = [];
		for (const item of values) {
			const locator =
				isRecord(item) && typeof item.url === "string" ? parseGitHubPullRequestUrl(item.url) : undefined;
			if (
				!isRecord(item) ||
				!locator ||
				locator.repository !== resolved.repository ||
				locator.number !== item.number ||
				locator.number > MAX_PULL_REQUEST_NUMBER ||
				numbers.has(locator.number) ||
				typeof item.title !== "string" ||
				typeof item.headRefName !== "string" ||
				typeof item.isDraft !== "boolean"
			) {
				return { ok: false, reason: "invalid_response" };
			}
			numbers.add(locator.number);
			if (!isDisplayText(item.title, MAX_TITLE_CHARS) || !isReviewHeadRefName(item.headRefName)) continue;
			const author =
				isRecord(item.author) &&
				typeof item.author.login === "string" &&
				isDisplayText(item.author.login, MAX_AUTHOR_CHARS)
					? item.author.login
					: undefined;
			const updatedAt = typeof item.updatedAt === "string" ? Date.parse(item.updatedAt) : Number.NaN;
			pullRequests.push({
				number: locator.number,
				title: item.title,
				url: locator.url,
				headRefName: item.headRefName,
				isDraft: item.isDraft,
				...(author === undefined ? {} : { author }),
				...(Number.isSafeInteger(updatedAt) && updatedAt >= 0 ? { updatedAt } : {}),
			});
		}
		return {
			ok: true,
			repository: base.path,
			pullRequests: pullRequests.slice(0, limit),
			truncated: values.length > limit,
		};
	} catch {
		return { ok: false, reason: signal?.aborted ? "cancelled" : "provider_error" };
	}
}
