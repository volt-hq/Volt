/**
 * The GitHub tracker, through GitHub CLI: the issues a maintainer labeled,
 * the pull request of an issue's branch, the review verdicts and triage
 * decisions the review author posted on it, its CI checks, what changed
 * between commits, and the writes the orchestrator makes itself (merging,
 * handing an issue to a human, taking an approval back, restarting an issue,
 * and filing a review's follow-ups). Everything else GitHub sees, the agents
 * do with `gh` themselves; the host posts a review engine's reviews.
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
	/** The branch it merges from. */
	readonly headRef: string;
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
	/** The open findings the review marked pre-existing, which the orchestrator did not block a `clean` verdict on. */
	readonly waived?: number;
	/** The new findings the change introduced on lines the last fix changed: the fix made the change worse. */
	readonly regressed?: number;
}

/** What a triage of a pull request that does not converge decided. */
export type TriageDecision = "continue" | "restart" | "handoff";

/** A triage decision the review author posted on a pull request, for its head commit. */
export interface TriageMarker {
	readonly headSha: string;
	readonly decision: TriageDecision;
	readonly createdAt: string;
	/** The comment's text before the marker: the triage's diagnosis, and for a restart its guidance. */
	readonly text: string;
}

/** The review author's markers on a pull request, each list oldest first. */
export interface PullRequestMarkers {
	readonly verdicts: readonly ReviewMarker[];
	readonly triages: readonly TriageMarker[];
}

/** A restart the review author recorded on an issue: its work continues from the base branch on `branch`. */
export interface RestartMarker {
	readonly branch: string;
	/** The pull request the restart closed. */
	readonly pr: number;
	readonly createdAt: string;
	/** The comment's text before the marker: why, and the guidance for the next implementation. */
	readonly text: string;
}

/** A range of lines, both ends included. */
export interface LineRange {
	readonly startLine: number;
	readonly endLine: number;
}

/** The lines one commit's tree changed against another's, by path in the newer tree. */
export type ChangedLines = ReadonlyMap<string, readonly LineRange[]>;

/** An open pull request and the files it changes. */
export interface OpenPullRequest {
	readonly number: number;
	readonly headRef: string;
	readonly files: readonly string[];
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
	/** The review verdicts and triage decisions the review author posted on pull request `number`. */
	markers(number: number): Promise<PullRequestMarkers>;
	/** The restarts the review author recorded on issue `number`, oldest first. */
	restarts(number: number): Promise<RestartMarker[]>;
	checks(number: number): Promise<ChecksState>;
	/** Whether commit `sha` has more than one parent: an agent merged the base branch into the pull request. */
	isMergeCommit(sha: string): Promise<boolean>;
	/** The lines commit `to` changed since commit `from`, an ancestor of it. */
	changedLines(from: string, to: string): Promise<ChangedLines>;
	/** The files pull request `pr` changes that its base branch changed too since the pull request branched from it. */
	staleFiles(pr: PullRequest): Promise<string[]>;
	/** The repository's open pull requests, with the files each changes. */
	openPullRequests(): Promise<OpenPullRequest[]>;
	merge(number: number, method: MergeMethod): Promise<void>;
	/** Close pull request `number` without merging it, commenting `comment`. */
	closePullRequest(number: number, comment: string): Promise<void>;
	/** Comment `comment` on issue `number` and label it `label`; resolves with whether the label was applied. */
	handOff(number: number, label: string, comment: string): Promise<boolean>;
	/** Comment `comment` on issue `number` and remove its label `label`, which a handoff applied. */
	takeBack(number: number, label: string, comment: string): Promise<void>;
	/** File an issue labeled `labels`. */
	fileIssue(issue: { title: string; body: string; labels: readonly string[] }): Promise<FiledIssue>;
	/** Comment `body` on issue `number`. */
	comment(number: number, body: string): Promise<void>;
	/** Whether an issue, open or closed, says `text` in its body or a comment: a follow-up recorded before. */
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
	/<!--\s*volt-orchestrator review head=([0-9a-f]{7,40}) verdict=(clean|changes)(?: run=([\w.:-]{1,128}))?(?: waived=(\d{1,4}))?(?: regressed=(\d{1,4}))?\s*-->/g;
const TRIAGE_MARKER =
	/<!--\s*volt-orchestrator triage head=([0-9a-f]{7,40}) decision=(continue|restart|handoff)\s*-->/g;
const RESTART_MARKER = /<!--\s*volt-orchestrator restart branch=([\w./-]{1,200}) pr=(\d{1,10})\s*-->/g;

/**
 * The line a review ends with to give `verdict` on head commit `headSha`; a
 * review engine's names its run, which the next round's review follows, and
 * how many of its findings the orchestrator `waived` as pre-existing or
 * found `regressed` by the last fix.
 */
export function reviewMarker(
	headSha: string,
	verdict: ReviewVerdict,
	runId?: string,
	counts: { waived?: number; regressed?: number } = {},
): string {
	const attributes = [
		`head=${headSha}`,
		`verdict=${verdict}`,
		...(runId === undefined ? [] : [`run=${runId}`]),
		...(counts.waived ? [`waived=${counts.waived}`] : []),
		...(counts.regressed ? [`regressed=${counts.regressed}`] : []),
	];
	return `<!-- volt-orchestrator review ${attributes.join(" ")} -->`;
}

/** The line a triage comment ends with: what it decided for the pull request at head commit `headSha`. */
export function triageMarker(headSha: string, decision: TriageDecision): string {
	return `<!-- volt-orchestrator triage head=${headSha} decision=${decision} -->`;
}

/** The line a restart comment on an issue ends with: its work continues on `branch`, and pull request `pr` closed. */
export function restartMarker(branch: string, pr: number): string {
	return `<!-- volt-orchestrator restart branch=${branch} pr=${pr} -->`;
}

/** The review verdicts in a comment's or review's body. */
export function parseReviewMarkers(body: string, createdAt: string): ReviewMarker[] {
	return [...body.matchAll(MARKER)].map((match) => ({
		headSha: match[1] ?? "",
		verdict: match[2] as ReviewVerdict,
		createdAt,
		...(match[3] === undefined ? {} : { runId: match[3] }),
		...(match[4] === undefined ? {} : { waived: Number(match[4]) }),
		...(match[5] === undefined ? {} : { regressed: Number(match[5]) }),
	}));
}

/** The text of `body` before its first marker. */
function textBefore(body: string, index: number): string {
	return body.slice(0, index).trim();
}

/** The triage decisions in a comment's body. */
export function parseTriageMarkers(body: string, createdAt: string): TriageMarker[] {
	return [...body.matchAll(TRIAGE_MARKER)].map((match) => ({
		headSha: match[1] ?? "",
		decision: match[2] as TriageDecision,
		createdAt,
		text: textBefore(body, match.index),
	}));
}

/** The restarts in a comment's body. */
export function parseRestartMarkers(body: string, createdAt: string): RestartMarker[] {
	return [...body.matchAll(RESTART_MARKER)].map((match) => ({
		branch: match[1] ?? "",
		pr: Number(match[2]),
		createdAt,
		text: textBefore(body, match.index),
	}));
}

/**
 * The lines of the newer side a unified diff `patch` changed: each added line,
 * and the line a removal left its place at. Adjacent lines make one range.
 */
export function patchLines(patch: string): LineRange[] {
	const lines: number[] = [];
	let line = 0;
	for (const row of patch.split("\n")) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
		if (hunk) {
			line = Number(hunk[1]);
		} else if (row.startsWith("+")) {
			lines.push(line);
			line += 1;
		} else if (row.startsWith("-")) {
			lines.push(line);
		} else if (!row.startsWith("\\")) {
			line += 1;
		}
	}
	const ranges: LineRange[] = [];
	for (const changed of lines) {
		const last = ranges.at(-1);
		if (last !== undefined && changed <= last.endLine + 1) {
			ranges[ranges.length - 1] = { startLine: last.startLine, endLine: Math.max(last.endLine, changed) };
		} else {
			ranges.push({ startLine: changed, endLine: changed });
		}
	}
	return ranges;
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
				headRef: branch,
				headSha: text(pr.headRefOid),
				draft: pr.isDraft === true,
				baseRef: text(pr.baseRefName),
				mergeable:
					pr.mergeable === "MERGEABLE" ? "mergeable" : pr.mergeable === "CONFLICTING" ? "conflicting" : "unknown",
			}),
		);
		return all.find((pr) => pr.state === "open") ?? all.sort((left, right) => right.number - left.number)[0];
	}

	/**
	 * The verdicts in the review author's comments (a review agent's) and pull
	 * request reviews (a review engine's), and the triage decisions in its comments.
	 */
	async markers(number: number): Promise<PullRequestMarkers> {
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
		const comments = list("comments").filter((entry) => this.byAuthor(entry));
		const verdicts = [
			...comments.flatMap((comment) => parseReviewMarkers(text(comment.body), text(comment.createdAt))),
			...list("reviews")
				.filter((entry) => this.byAuthor(entry))
				.flatMap((review) => parseReviewMarkers(text(review.body), text(review.submittedAt))),
		].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
		const triages = comments
			.flatMap((comment) => parseTriageMarkers(text(comment.body), text(comment.createdAt)))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
		return { verdicts, triages };
	}

	async restarts(number: number): Promise<RestartMarker[]> {
		const issue = await json(this.run, ["issue", "view", String(number), "--repo", this.repo, "--json", "comments"]);
		const comments = isRecord(issue) && Array.isArray(issue.comments) ? issue.comments.filter(isRecord) : [];
		return comments
			.filter((comment) => this.byAuthor(comment))
			.flatMap((comment) => parseRestartMarkers(text(comment.body), text(comment.createdAt)))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	/** Whether `entry`, a comment or review, is the review author's: only its markers count. */
	private byAuthor(entry: Record<string, unknown>): boolean {
		return isRecord(entry.author) && sameLogin(text(entry.author.login), this.reviewAuthor);
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

	async changedLines(from: string, to: string): Promise<ChangedLines> {
		const files = await this.compare(from, to);
		return new Map(files.map((file) => [text(file.filename), patchLines(text(file.patch))]));
	}

	async staleFiles(pr: PullRequest): Promise<string[]> {
		// From where the pull request branched to the base branch now: what the base changed since.
		const base = new Set((await this.compare(pr.headSha, pr.baseRef)).map((file) => text(file.filename)));
		if (base.size === 0) return [];
		const view = await json(this.run, ["pr", "view", String(pr.number), "--repo", this.repo, "--json", "files"]);
		const files = isRecord(view) && Array.isArray(view.files) ? view.files.filter(isRecord) : [];
		return files.map((file) => text(file.path)).filter((path) => base.has(path));
	}

	async openPullRequests(): Promise<OpenPullRequest[]> {
		const prs = await json(this.run, [
			"pr",
			"list",
			"--repo",
			this.repo,
			"--state",
			"open",
			"--limit",
			"100",
			"--json",
			"number,headRefName,files",
		]);
		return (Array.isArray(prs) ? prs : []).filter(isRecord).map((pr) => ({
			number: typeof pr.number === "number" ? pr.number : 0,
			headRef: text(pr.headRefName),
			files: (Array.isArray(pr.files) ? pr.files : []).filter(isRecord).map((file) => text(file.path)),
		}));
	}

	/** The files commit `to` changed since the merge base of `from` and `to`, with their patches. */
	private async compare(from: string, to: string): Promise<Record<string, unknown>[]> {
		const result = await json(this.run, ["api", `repos/${this.repo}/compare/${from}...${to}`]);
		return isRecord(result) && Array.isArray(result.files) ? result.files.filter(isRecord) : [];
	}

	async merge(number: number, method: MergeMethod): Promise<void> {
		await json(this.run, ["pr", "merge", String(number), "--repo", this.repo, `--${method}`], false);
	}

	async closePullRequest(number: number, comment: string): Promise<void> {
		await json(this.run, ["pr", "close", String(number), "--repo", this.repo, "--comment", comment], false);
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

	async comment(number: number, body: string): Promise<void> {
		await json(this.run, ["issue", "comment", String(number), "--repo", this.repo, "--body", body], false);
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
			`"${text}" in:body,comments`,
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
