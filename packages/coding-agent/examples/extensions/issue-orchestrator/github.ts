/**
 * The GitHub tracker, through GitHub CLI: the issues a maintainer labeled,
 * the pull request of an issue's branch, the review verdicts the review
 * author posted on it, its CI checks, and the writes the orchestrator makes
 * itself (merging, handing an issue to a human, taking an approval back, and
 * filing a review's follow-ups). Everything else GitHub sees, the agents do
 * with `gh` themselves; the host posts a review engine's reviews.
 */

import type { MergeMethod } from "./workflow.ts";

/** What running `gh` with some arguments gave. */
export interface GhResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

/** Runs GitHub CLI with `args`. */
export type GhRunner = (args: readonly string[]) => Promise<GhResult>;

export interface Issue {
	readonly number: number;
	/** `owner/name#number`. */
	readonly identifier: string;
	readonly title: string;
	readonly body: string;
	readonly url: string;
	/** Lowercase. */
	readonly labels: readonly string[];
	readonly open: boolean;
	readonly createdAt: string;
}

export interface PullRequest {
	readonly number: number;
	readonly url: string;
	readonly state: "open" | "closed" | "merged";
	readonly headSha: string;
	readonly draft: boolean;
	/** The branch it merges into. */
	readonly baseRef: string;
	/** Whether it merges into its base without conflicts; `unknown` while GitHub works it out. */
	readonly mergeable: "mergeable" | "conflicting" | "unknown";
}

export type ReviewVerdict = "clean" | "changes";

/** A review verdict the review author posted for one head commit. */
export interface ReviewMarker {
	readonly headSha: string;
	readonly verdict: ReviewVerdict;
	readonly createdAt: string;
	/** The review engine's run that gave it; none for a review agent's verdict. */
	readonly runId?: string;
}

/** An issue the orchestrator filed. */
export interface FiledIssue {
	readonly number: number;
	readonly url: string;
}

export type ChecksState =
	| { readonly state: "none" }
	| { readonly state: "pending" }
	| { readonly state: "failing"; readonly failing: readonly string[] }
	| { readonly state: "passing" };

/** What the orchestrator reads from and writes to the tracker. */
export interface Tracker {
	readonly repo: string;
	/** Open issues with every label in `labels`. */
	candidates(labels: readonly string[]): Promise<Issue[]>;
	/** The issue `number` now; undefined when it no longer exists. */
	issue(number: number): Promise<Issue | undefined>;
	/** The pull request whose head is `branch`: the open one, else the latest. */
	pullRequest(branch: string): Promise<PullRequest | undefined>;
	/** The review verdicts the review author posted on pull request `number`, oldest first. */
	reviews(number: number): Promise<ReviewMarker[]>;
	checks(number: number): Promise<ChecksState>;
	/** Whether commit `sha` has more than one parent: an agent merged the base branch into the pull request. */
	isMergeCommit(sha: string): Promise<boolean>;
	merge(number: number, method: MergeMethod): Promise<void>;
	/** Comment `comment` on issue `number` and label it `label`; resolves with whether the label was applied. */
	handOff(number: number, label: string, comment: string): Promise<boolean>;
	/** Comment `comment` on issue `number` and remove its label `label`, which a handoff applied. */
	takeBack(number: number, label: string, comment: string): Promise<void>;
	/** File an issue labeled `labels`. */
	fileIssue(issue: { title: string; body: string; labels: readonly string[] }): Promise<FiledIssue>;
	/** Whether an issue, open or closed, says `text` in its body: one filed for the same follow-up before. */
	mentioned(text: string): Promise<boolean>;
}

export class GhError extends Error {
	readonly args: readonly string[];

	constructor(args: readonly string[], result: GhResult) {
		super(
			`gh ${args.slice(0, 3).join(" ")} failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 500)}`,
		);
		this.name = "GhError";
		this.args = args;
	}
}

const MARKER =
	/<!--\s*volt-orchestrator review head=([0-9a-f]{7,40}) verdict=(clean|changes)(?: run=([\w.:-]{1,128}))?\s*-->/g;

/**
 * The line a review ends with to give `verdict` on head commit `headSha`; a
 * review engine's names its run, which the next round's review follows.
 */
export function reviewMarker(headSha: string, verdict: ReviewVerdict, runId?: string): string {
	return `<!-- volt-orchestrator review head=${headSha} verdict=${verdict}${runId === undefined ? "" : ` run=${runId}`} -->`;
}

/** The review verdicts in a comment's or review's body. */
export function parseReviewMarkers(body: string, createdAt: string): ReviewMarker[] {
	return [...body.matchAll(MARKER)].map((match) => ({
		headSha: match[1] ?? "",
		verdict: match[2] as ReviewVerdict,
		createdAt,
		...(match[3] === undefined ? {} : { runId: match[3] }),
	}));
}

/**
 * A login as GitHub's APIs disagree on it, made comparable: REST names an
 * app `volt-agent[bot]`, GraphQL (and so `gh pr view --json`) `volt-agent`,
 * and `gh` search `app/volt-agent`.
 */
export function sameLogin(left: string, right: string): boolean {
	const normalize = (login: string) =>
		login
			.trim()
			.toLowerCase()
			.replace(/^app\//, "")
			.replace(/\[bot\]$/, "");
	return normalize(left) === normalize(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

const ISSUE_FIELDS = "number,title,body,url,labels,state,createdAt";

export class GitHubTracker implements Tracker {
	readonly repo: string;
	private readonly run: GhRunner;
	private readonly reviewAuthor: string;
	/** Whether each commit asked about is a merge: a commit's parents never change. */
	private readonly merges = new Map<string, boolean>();

	constructor(run: GhRunner, repo: string, reviewAuthor: string) {
		this.run = run;
		this.repo = repo;
		this.reviewAuthor = reviewAuthor;
	}

	/** A tracker for `repo` and `reviewAuthor`, asking `gh` for the ones omitted. */
	static async connect(run: GhRunner, options: { repo?: string; reviewAuthor?: string }): Promise<GitHubTracker> {
		const repo =
			options.repo ?? text(await json(run, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]));
		const reviewAuthor = options.reviewAuthor ?? text(await json(run, ["api", "user", "--jq", ".login"]));
		if (!repo) throw new Error("Cannot tell the repository: set tracker.repo");
		if (!reviewAuthor) throw new Error("Cannot tell whose reviews count: set tracker.review_author");
		return new GitHubTracker(run, repo, reviewAuthor);
	}

	async candidates(labels: readonly string[]): Promise<Issue[]> {
		const args = ["issue", "list", "--repo", this.repo, "--state", "open", "--limit", "100", "--json", ISSUE_FIELDS];
		for (const label of labels) args.push("--label", label);
		const issues = await json(this.run, args);
		return Array.isArray(issues) ? issues.flatMap((issue) => this.toIssue(issue)) : [];
	}

	async issue(number: number): Promise<Issue | undefined> {
		const args = ["issue", "view", String(number), "--repo", this.repo, "--json", ISSUE_FIELDS];
		const result = await this.run(args);
		if (result.code !== 0) {
			if (/could not resolve|not found/i.test(result.stderr)) return undefined;
			throw new GhError(args, result);
		}
		return this.toIssue(parse(args, result))[0];
	}

	async pullRequest(branch: string): Promise<PullRequest | undefined> {
		const prs = await json(this.run, [
			"pr",
			"list",
			"--repo",
			this.repo,
			"--head",
			branch,
			"--state",
			"all",
			"--limit",
			"10",
			"--json",
			"number,url,state,headRefOid,isDraft,baseRefName,mergeable",
		]);
		const all = (Array.isArray(prs) ? prs : []).filter(isRecord).map(
			(pr): PullRequest => ({
				number: typeof pr.number === "number" ? pr.number : 0,
				url: text(pr.url),
				state: pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed",
				headSha: text(pr.headRefOid),
				draft: pr.isDraft === true,
				baseRef: text(pr.baseRefName),
				mergeable:
					pr.mergeable === "MERGEABLE" ? "mergeable" : pr.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
			}),
		);
		return all.find((pr) => pr.state === "open") ?? all.sort((left, right) => right.number - left.number)[0];
	}

	/** The verdicts in the review author's comments (a review agent's) and pull request reviews (a review engine's). */
	async reviews(number: number): Promise<ReviewMarker[]> {
		const pr = await json(this.run, [
			"pr",
			"view",
			String(number),
			"--repo",
			this.repo,
			"--json",
			"comments,reviews",
		]);
		const list = (key: string): Record<string, unknown>[] =>
			isRecord(pr) && Array.isArray(pr[key]) ? pr[key].filter(isRecord) : [];
		const byAuthor = (entry: Record<string, unknown>): boolean =>
			isRecord(entry.author) && sameLogin(text(entry.author.login), this.reviewAuthor);
		return [
			...list("comments")
				.filter(byAuthor)
				.flatMap((comment) => parseReviewMarkers(text(comment.body), text(comment.createdAt))),
			...list("reviews")
				.filter(byAuthor)
				.flatMap((review) => parseReviewMarkers(text(review.body), text(review.submittedAt))),
		].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	async checks(number: number): Promise<ChecksState> {
		const args = ["pr", "checks", String(number), "--repo", this.repo, "--json", "name,bucket"];
		const result = await this.run(args);
		// `gh pr checks` exits non-zero for failing and pending checks; its JSON still says which.
		let checks: unknown;
		try {
			checks = JSON.parse(result.stdout);
		} catch {
			if (/no checks reported/i.test(result.stderr)) return { state: "none" };
			throw new GhError(args, result);
		}
		const list = (Array.isArray(checks) ? checks : []).filter(isRecord);
		if (list.length === 0) return { state: "none" };
		const failing = list
			.filter((check) => check.bucket === "fail" || check.bucket === "cancel")
			.map((check) => text(check.name));
		if (failing.length > 0) return { state: "failing", failing };
		if (list.some((check) => check.bucket === "pending")) return { state: "pending" };
		return { state: "passing" };
	}

	async isMergeCommit(sha: string): Promise<boolean> {
		const known = this.merges.get(sha);
		if (known !== undefined) return known;
		const parents = await json(this.run, ["api", `repos/${this.repo}/commits/${sha}`, "--jq", ".parents | length"]);
		const merge = Number(parents) > 1;
		this.merges.set(sha, merge);
		return merge;
	}

	async merge(number: number, method: MergeMethod): Promise<void> {
		await json(this.run, ["pr", "merge", String(number), "--repo", this.repo, `--${method}`], false);
	}

	async handOff(number: number, label: string, comment: string): Promise<boolean> {
		await json(this.run, ["issue", "comment", String(number), "--repo", this.repo, "--body", comment], false);
		// A label the repository does not have fails; the comment still says why the orchestrator stopped.
		const labeled = await this.run(["issue", "edit", String(number), "--repo", this.repo, "--add-label", label]);
		return labeled.code === 0;
	}

	async takeBack(number: number, label: string, comment: string): Promise<void> {
		await json(this.run, ["issue", "comment", String(number), "--repo", this.repo, "--body", comment], false);
		await json(this.run, ["issue", "edit", String(number), "--repo", this.repo, "--remove-label", label], false);
	}

	async fileIssue(issue: { title: string; body: string; labels: readonly string[] }): Promise<FiledIssue> {
		const args = ["issue", "create", "--repo", this.repo, "--title", issue.title, "--body", issue.body];
		for (const label of issue.labels) args.push("--label", label);
		const result = await this.run(args);
		if (result.code !== 0) throw new GhError(args, result);
		// gh prints the new issue's address.
		const url = result.stdout.trim().split("\n").at(-1) ?? "";
		const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1]);
		if (!Number.isSafeInteger(number)) throw new GhError(args, { ...result, stderr: `no issue address: ${url}` });
		return { number, url };
	}

	async mentioned(text: string): Promise<boolean> {
		const issues = await json(this.run, [
			"issue",
			"list",
			"--repo",
			this.repo,
			"--state",
			"all",
			"--search",
			`"${text}" in:body`,
			"--limit",
			"1",
			"--json",
			"number",
		]);
		return Array.isArray(issues) && issues.length > 0;
	}

	private toIssue(value: unknown): Issue[] {
		if (!isRecord(value) || typeof value.number !== "number" || typeof value.title !== "string") return [];
		const labels = Array.isArray(value.labels) ? value.labels : [];
		return [
			{
				number: value.number,
				identifier: `${this.repo}#${value.number}`,
				title: value.title,
				body: text(value.body),
				url: text(value.url),
				labels: labels
					.map((label) => (isRecord(label) ? text(label.name) : text(label)).trim().toLowerCase())
					.filter((label) => label.length > 0),
				open: value.state === undefined || value.state === "OPEN",
				createdAt: text(value.createdAt),
			},
		];
	}
}

function parse(args: readonly string[], result: GhResult): unknown {
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new GhError(args, { ...result, stderr: `not JSON: ${result.stdout.slice(0, 200)}` });
	}
}

/** Run `gh` with `args`; a failure throws. With `parseOutput`, the output is JSON (or `--jq` text). */
async function json(run: GhRunner, args: readonly string[], parseOutput = true): Promise<unknown> {
	const result = await run(args);
	if (result.code !== 0) throw new GhError(args, result);
	if (!parseOutput) return undefined;
	if (args.includes("--jq")) return result.stdout.trim();
	return parse(args, result);
}
