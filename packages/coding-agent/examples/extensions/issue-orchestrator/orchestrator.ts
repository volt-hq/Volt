/**
 * The orchestrator: one deterministic loop that owns every scheduling
 * decision. Each tick re-reads the workflow (keeping the last good one when it
 * breaks), stops the runs of issues that left the workflow, then works each
 * labeled issue by what it needs next (`phase.ts`): it starts an agent of the
 * phase's role in the issue's worktree, or a review of the pull request on a
 * review engine (`review.engine`), merges, or hands the issue to a human.
 * The orchestrator posts an engine's complete review with its verdict, and
 * files the review's follow-ups as issues. From the second round on, findings
 * the review marked pre-existing do not block a clean verdict; the human the
 * pull request goes to gets them listed. A review that finds new defects on
 * the lines the last fix changed marks the verdict regressed. A pull request
 * that regressed or ran out of rounds gets a triage agent, whose decision
 * (continue, restart from the base branch, or hand off) the orchestrator
 * posts and carries out. An implementation waits while another issue's
 * pull request changes the code its issue names. A run that ends wakes the
 * loop at once. An approved issue stays watched: once its pull request
 * conflicts with its base branch (another one merged), the approval is taken
 * back and the pull request updated.
 *
 * Its state is in memory only. GitHub is the source of truth: after a
 * restart the next tick finds each issue's phase again, and the checkouts of
 * the issues it is done with. Bounded by:
 * concurrency limits, `agent.max_attempts` runs of one phase of one head
 * commit, exponential backoff after a failed run, `review.max_rounds`, and
 * `triage.max_runs` and `triage.max_restarts`.
 */

import { createHash } from "node:crypto";
import type {
	ChangedLines,
	Issue,
	OpenPullRequest,
	PullRequest,
	ReviewVerdict,
	Tracker,
	TriageDecision,
} from "./github.ts";
import { restartMarker, reviewMarker, triageMarker } from "./github.ts";
import {
	branchCount,
	inspectIssue,
	isRoutable,
	issueBranch,
	type Phase,
	verdictsByHead,
	type Waived,
} from "./phase.ts";
import {
	type Role,
	type RoleLimits,
	renderTemplate,
	type TemplateValue,
	type Workflow,
	type WorkflowConfig,
} from "./workflow.ts";

export interface AgentResult {
	readonly status: "completed" | "failed" | "cancelled";
	readonly output?: string;
	readonly error?: string;
	readonly usage: { readonly tokens: number; readonly cost: number };
}

export interface AgentRun {
	readonly id: string;
	readonly ended: Promise<AgentResult>;
}

/** Runs the agents of the roles. */
export interface Agents {
	start(options: { agent: string; task: string; cwd: string; limits: RoleLimits }): Promise<AgentRun>;
	cancel(id: string): Promise<void>;
}

/** A finding of a review, as a fixer reads it. */
export interface ReviewFinding {
	/** The same for the same finding in each round that keeps it open. */
	readonly id?: string;
	/** Whether the change introduced it: false for a defect that predates the change; unknown when undefined. */
	readonly introduced?: boolean;
	readonly title: string;
	readonly body: string;
	/** 0 (most urgent) to 3. */
	readonly priority: number;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
}

/** A defect a review verified outside the pull request's change, for an issue of its own. */
export interface ReviewFollowUp extends ReviewFinding {
	/** The same for the same defect in every review that reports it. */
	readonly fingerprint: string;
}

/** How a review on a review engine ended. */
export interface ReviewResult {
	readonly status: "completed" | "failed" | "cancelled";
	readonly error?: string;
	/** A complete review's verdict on the head commit it reviewed; an incomplete review has none. */
	readonly verdict?: { readonly value: ReviewVerdict; readonly headSha: string };
	/** A complete review's open findings. */
	readonly findings?: readonly ReviewFinding[];
	readonly followUps: readonly ReviewFollowUp[];
	readonly usage: { readonly tokens: number; readonly cost: number };
}

export interface ReviewRun {
	readonly id: string;
	readonly ended: Promise<ReviewResult>;
}

/** Reviews pull requests on the conversation's review engines, as `/review` does. */
export interface Reviews {
	/**
	 * Review pull request `pr` on `engine`, collecting follow-ups, and following
	 * `previousRunId` (the previous round's run) where the conversation holds
	 * it. `setup` prepares the checkout a review that runs commands works in.
	 * Rejects when the conversation refuses the review, such as while it runs
	 * its most reviews at once.
	 */
	start(options: {
		pr: number;
		engine: string;
		previousRunId?: string;
		setup?: { command: string; timeoutMs: number };
	}): Promise<ReviewRun>;
	cancel(id: string): Promise<void>;
	/** Post complete review `id` to its pull request as the account GitHub CLI `command` is signed in as. */
	publish(id: string, options: { trailer: string; command: readonly string[] }): Promise<void>;
	/** The open findings of review `id`; undefined when the conversation does not hold it. */
	findings(id: string): Promise<ReviewFinding[] | undefined>;
}

/** An issue's checkout. */
export interface Workspace {
	readonly path: string;
	readonly branch: string;
}

/** What releasing an issue's checkout did: `retry` while something still holds it, `kept` when it must stay. */
export type ReleaseOutcome = "released" | "retry" | "kept";

/** Prepares the checkout an issue's agents work in, and releases it once the orchestrator is done with the issue. */
export interface Workspaces {
	/**
	 * The checkout of `issue` on `branch`, its own or a restart's. Rejects with an error whose message starts
	 * with `worktree_limit_reached` while the workspace has no room for it.
	 */
	prepare(issue: Issue, config: WorkflowConfig, branch: string): Promise<Workspace>;
	/**
	 * Release issue `number`'s checkouts, a restart's too, keeping their branches; a checkout with changes is
	 * `kept`, one that fails tried again.
	 */
	release(number: number): Promise<ReleaseOutcome>;
	/** The issues whose checkouts take room in the workspace now. */
	checkouts(): Promise<number[]>;
}

export interface OrchestratorOptions {
	loadWorkflow(): Promise<Workflow>;
	/** The tracker the workflow names; called each tick, so it may cache. */
	tracker(config: WorkflowConfig): Promise<Tracker>;
	agents: Agents;
	reviews: Reviews;
	workspaces: Workspaces;
	now?: () => number;
	/** Called whenever what the snapshot shows may have changed. */
	onChange?: (snapshot: OrchestratorSnapshot) => void;
	/** Called when something happens a human may want to follow on GitHub. */
	announce?: (event: OrchestratorEvent) => void;
	log?: (line: string) => void;
}

export interface RunningIssue {
	readonly issue: number;
	readonly title: string;
	readonly role: Role;
	readonly runId?: string;
	readonly startedAt: number;
}

export interface RetryingIssue {
	readonly issue: number;
	readonly title: string;
	readonly failures: number;
	readonly dueAt: number;
	readonly error: string;
}

export interface NotedIssue {
	readonly issue: number;
	readonly title: string;
	readonly reason: string;
}

/** An issue handed to a human: `ready` when its pull request was approved for them to merge, not stuck. */
export interface HandedOffIssue extends NotedIssue {
	readonly ready: boolean;
}

/** An issue or pull request an event links to. */
export type IssueLink = Pick<Issue, "number" | "title" | "url">;
export type PullRequestLink = Pick<PullRequest, "number" | "url">;

/**
 * Something a human may want to follow on GitHub: the orchestrator started
 * on an issue, an issue it implemented got a pull request, or it handed an
 * issue to a human, ready to merge or stuck.
 */
export type OrchestratorEvent =
	| { readonly kind: "picked_up"; readonly issue: IssueLink; readonly role: Role; readonly pr?: PullRequestLink }
	| { readonly kind: "pr_opened"; readonly issue: IssueLink; readonly pr: PullRequestLink }
	| {
			readonly kind: "handed_off";
			readonly issue: IssueLink;
			readonly ready: boolean;
			readonly reason: string;
			readonly pr?: PullRequestLink;
	  };

export interface OrchestratorSnapshot {
	readonly repo?: string;
	readonly workflowPath?: string;
	/** Why the last tick could not run in full. */
	readonly error?: string;
	readonly running: readonly RunningIssue[];
	readonly retrying: readonly RetryingIssue[];
	readonly waiting: readonly NotedIssue[];
	readonly handedOff: readonly HandedOffIssue[];
	readonly finished: readonly NotedIssue[];
	readonly totals: { readonly runs: number; readonly tokens: number; readonly cost: number };
	readonly lastTickAt?: number;
}

interface RunningEntry {
	issue: Issue;
	readonly role: Role;
	/** A review on a review engine, rather than an agent. */
	readonly engineReview: boolean;
	readonly startedAt: number;
	runId: string | undefined;
	/** Stopped by the orchestrator (the issue left the workflow, or the orchestrator stopped): no retry. */
	cancelled: boolean;
	ended: Promise<void>;
}

interface HandedOff {
	readonly title: string;
	readonly reason: string;
	/** The label applied: once a human removes it, the issue is worked again. */
	readonly label: string | undefined;
	/** Approved for a human to merge (`merge.ready_label`), rather than stuck. */
	readonly ready: boolean;
}

interface PendingRelease {
	/** Undefined for an issue GitHub no longer has. */
	readonly title: string | undefined;
	/** Why the last try failed, so a failure that lasts is logged once. */
	error?: string;
}

const BASE_RETRY_DELAY_MS = 10_000;
/** The longest a review's checkout setup may run: the host's limit. */
const MAX_REVIEW_SETUP_MS = 3_600_000;
/** The shortest pause between ticks, whatever is due. */
const MIN_TICK_DELAY_MS = 1_000;
const MAX_FINISHED = 20;

function issueLink(issue: Issue): IssueLink {
	return { number: issue.number, title: issue.title, url: issue.url };
}

function pullRequestLink(pr: PullRequest): PullRequestLink {
	return { number: pr.number, url: pr.url };
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** `path:line`, or `path:first-last`. */
function location(finding: ReviewFinding): string {
	const lines =
		finding.endLine > finding.startLine ? `${finding.startLine}-${finding.endLine}` : `${finding.startLine}`;
	return `${finding.path}:${lines}`;
}

/** How many lines apart two places in a file may be and still be the same site. */
const NEARBY_LINES = 3;

/** A place in the code an issue is about, as its body names it: `path:line` or `path:first-last`. */
interface IssueSite {
	readonly issue: number;
	readonly path: string;
	readonly startLine: number;
	readonly endLine: number;
}

/** `path:line` and `path:first-last` mentions, such as `packages/core/safety.ts:67-68` or `safety.ts:72`. */
const SITE_PATTERN = /([\w@.-]+(?:\/[\w@.-]+)*\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;

/** The sites `body`, the text of issue `issue`, names. */
function issueSites(issue: number, body: string): IssueSite[] {
	return [...body.matchAll(SITE_PATTERN)].map((match) => {
		const first = Number(match[2]);
		const last = match[3] === undefined ? first : Number(match[3]);
		return { issue, path: match[1] ?? "", startLine: Math.min(first, last), endLine: Math.max(first, last) };
	});
}

/** Whether `site` is about the code `followUp` is: the same file (a site may name it by its base name), nearby lines. */
function coversFollowUp(site: IssueSite, followUp: ReviewFollowUp): boolean {
	const sameFile = followUp.path === site.path || followUp.path.endsWith(`/${site.path}`);
	return (
		sameFile && site.startLine - NEARBY_LINES <= followUp.endLine && followUp.startLine - NEARBY_LINES <= site.endLine
	);
}

/** The comment that adds `followUp` to an issue already about its code; `found` says where it was found. */
function followUpComment(followUp: ReviewFollowUp, found: string): string {
	return [
		`Another defect at this issue's code. ${found}`,
		"",
		`**${followUp.title}**`,
		"",
		followUp.body,
		"",
		`Location: \`${location(followUp)}\` (priority P${followUp.priority}).`,
		"",
		`Follow-up fingerprint: ${followUp.fingerprint}`,
		"",
		"_Volt issue orchestrator_",
	].join("\n");
}

/**
 * The body of a follow-up's issue: the defect, where it is, where it was found (`found`), and its fingerprint.
 * `triage` says how a human has the orchestrator work it, for one filed without the workflow's labels.
 */
function followUpBody(followUp: ReviewFollowUp, found: string, triage?: string): string {
	return [
		followUp.body,
		"",
		`Location: \`${location(followUp)}\` (priority P${followUp.priority}).`,
		found,
		...(triage === undefined ? [] : ["", triage]),
		"",
		`Follow-up fingerprint: ${followUp.fingerprint}`,
		"",
		"_Volt issue orchestrator_",
	].join("\n");
}

/** Most problems one agent run reports outside its work. */
const MAX_REPORTED_PROBLEMS = 10;

/**
 * How an agent reports problems outside its work, for the orchestrator to
 * record them once each (`{{ out_of_scope }}` in a prompt). The agents never
 * file issues themselves, so every one goes through the same check.
 */
export const OUT_OF_SCOPE_INSTRUCTIONS = `Do not file issues yourself. End your final reply with each problem you found outside this work's scope (unrelated bugs, tech debt, wrong docs) as a JSON array between <out-of-scope> and </out-of-scope>, one object per problem: {"title": "...", "body": "what is wrong, and why it matters", "path": "repository-relative/file.ts", "startLine": 10, "endLine": 12, "priority": 2}, priority 0 (most urgent) to 3, at most ${MAX_REPORTED_PROBLEMS}. The orchestrator files each once, or adds it to the open issue already about that code. Leave the block out when there are none.`;

/**
 * How a triage agent reports its decision (`{{ triage.output }}` in its
 * prompt), for the orchestrator to post and carry out.
 */
export const TRIAGE_INSTRUCTIONS =
	'End your final reply with your decision as a JSON object between <triage> and </triage>: {"decision": "continue" | "restart" | "handoff", "diagnosis": "why the pull request is not converging, citing the findings", "guidance": "for restart, the approach the next implementation takes and what it avoids; else empty"}. The orchestrator posts it on the pull request and carries it out.';

/** What a triage agent decided, as its final reply says. */
export interface TriageReport {
	readonly decision: TriageDecision;
	readonly diagnosis: string;
	/** For a restart: how the next implementation goes about the issue. */
	readonly guidance: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The decision `output`, a triage agent's final reply, gives in its last `<triage>` block; else why there is none. */
export function triageReport(output: string): TriageReport | { readonly error: string } {
	const block = [...output.matchAll(/<triage>([\s\S]*?)<\/triage>/g)].at(-1)?.[1];
	if (block === undefined) return { error: "the triage reply has no <triage> block" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			block
				.trim()
				.replace(/^```(?:json)?\s*/, "")
				.replace(/\s*```$/, ""),
		);
	} catch {
		return { error: "the <triage> block is not JSON" };
	}
	const decision = isRecord(parsed) ? parsed.decision : undefined;
	const diagnosis = isRecord(parsed) && typeof parsed.diagnosis === "string" ? parsed.diagnosis.trim() : "";
	const guidance = isRecord(parsed) && typeof parsed.guidance === "string" ? parsed.guidance.trim() : "";
	if (decision !== "continue" && decision !== "restart" && decision !== "handoff") {
		return { error: "the <triage> block's decision is not continue, restart, or handoff" };
	}
	if (diagnosis.length === 0 || diagnosis.length > 4_000) {
		return { error: "the <triage> block needs a diagnosis of at most 4000 characters" };
	}
	if (guidance.length > 4_000) return { error: "the <triage> block's guidance exceeds 4000 characters" };
	if (decision === "restart" && guidance.length === 0) return { error: "a restart needs guidance" };
	return { decision, diagnosis, guidance };
}

/** The comment a triage's decision is posted as, on the pull request at head commit `headSha`. */
function triageComment(report: TriageReport, headSha: string): string {
	return [
		`**Triage: ${report.decision}.** ${report.diagnosis}`,
		...(report.guidance.length === 0 ? [] : ["", `Guidance for the next implementation: ${report.guidance}`]),
		"",
		"_Volt issue orchestrator_",
		triageMarker(headSha, report.decision),
	].join("\n");
}

/** `count noun`, with the noun plural unless the count is one. */
function counted(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Whether two paths name the same file, either by its base name or a tail of its path. */
function samePath(left: string, right: string): boolean {
	return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/** The issue whose work branch `headRef` is, by the orchestrator's branch names; undefined for any other branch. */
function branchIssue(headRef: string): number | undefined {
	const number = /^volt\/issue-(\d+)(?:-\d+)?$/.exec(headRef)?.[1];
	return number === undefined ? undefined : Number(number);
}

/**
 * The problems `output`, an agent's final reply, reports outside its work: its
 * last `<out-of-scope>` block, a JSON array. Each is checked (a title and body,
 * a repository-relative path, lines, a priority) and given a fingerprint of
 * its file and title; what is wrong with the rest is in `errors`.
 */
export function outOfScopeProblems(output: string): { problems: ReviewFollowUp[]; errors: string[] } {
	const block = [...output.matchAll(/<out-of-scope>([\s\S]*?)<\/out-of-scope>/g)].at(-1)?.[1];
	if (block === undefined) return { problems: [], errors: [] };
	let parsed: unknown;
	try {
		// A model may fence the JSON inside the block.
		parsed = JSON.parse(
			block
				.trim()
				.replace(/^```(?:json)?\s*/, "")
				.replace(/\s*```$/, ""),
		);
	} catch {
		return { problems: [], errors: ["the <out-of-scope> block is not JSON"] };
	}
	if (!Array.isArray(parsed)) return { problems: [], errors: ["the <out-of-scope> block is not a JSON array"] };
	const problems: ReviewFollowUp[] = [];
	const errors: string[] = [];
	for (const [index, item] of parsed.slice(0, MAX_REPORTED_PROBLEMS).entries()) {
		const text = (value: unknown, max: number): string | undefined =>
			typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : undefined;
		const line = (value: unknown): number | undefined =>
			typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
		const title = isRecord(item) ? text(item.title, 200) : undefined;
		const body = isRecord(item) ? text(item.body, 4_000) : undefined;
		const path = isRecord(item) ? text(item.path, 500) : undefined;
		const startLine = isRecord(item) ? line(item.startLine) : undefined;
		const endLine = isRecord(item) ? (line(item.endLine) ?? startLine) : undefined;
		const priority = isRecord(item) && item.priority !== undefined ? item.priority : 2;
		if (
			title === undefined ||
			body === undefined ||
			path === undefined ||
			path.startsWith("/") ||
			path.split("/").includes("..") ||
			startLine === undefined ||
			endLine === undefined ||
			endLine < startLine ||
			typeof priority !== "number" ||
			![0, 1, 2, 3].includes(priority)
		) {
			errors.push(`problem ${index + 1} needs a title, body, repository-relative path, lines, and a priority 0-3`);
			continue;
		}
		const fingerprint = createHash("sha256").update(`${path}\n${title.toLowerCase()}`).digest("hex");
		problems.push({ fingerprint, title, body, priority, path, startLine, endLine });
	}
	if (parsed.length > MAX_REPORTED_PROBLEMS)
		errors.push(`only the first ${MAX_REPORTED_PROBLEMS} problems were taken`);
	return { problems, errors };
}

/** Where problems found by an agent of `phase` on `issue` come from, as the issues and comments say. */
function foundBy(phase: Extract<Phase, { kind: Role }>, issue: Issue): string {
	if (!("pr" in phase)) return `Found outside the issue's scope while working on ${issue.identifier}.`;
	const doing = { review: "reviewing", fix: "fixing", update: "updating", triage: "triaging" }[phase.kind];
	return `Found outside the change while ${doing} ${phase.pr.url} for ${issue.identifier}.`;
}

export class Orchestrator {
	private readonly options: OrchestratorOptions;
	private readonly now: () => number;
	private workflow: Workflow | undefined;
	private repo: string | undefined;
	private error: string | undefined;
	private lastTickAt: number | undefined;
	private readonly running = new Map<number, RunningEntry>();
	private readonly retries = new Map<number, RetryingIssue>();
	/** Runs started per phase of an issue's head commit: `<issue>:<role>:<head>`. */
	private readonly attempts = new Map<string, number>();
	private waiting = new Map<number, NotedIssue>();
	private readonly handedOff = new Map<number, HandedOff>();
	/** Issues whose checkouts the orchestrator is done with and has yet to release. */
	private readonly pendingReleases = new Map<number, PendingRelease>();
	/**
	 * Whether to look for the checkouts of issues it is done with but does not
	 * know of: when it starts (an earlier run worked them), and once the
	 * workspace was full.
	 */
	private sweepDue = true;
	/** Issues it started agents for and is not done with, with their titles. */
	private readonly known = new Map<number, string>();
	/** Issues it started an implementer on that have no pull request yet. */
	private readonly awaitingPullRequest = new Set<number>();
	/** The fingerprints of the follow-ups it filed, or found filed, since it started. */
	private readonly filedFollowUps = new Set<string>();
	/** Recording follow-ups, one run's at a time: two runs that end together would file the same site twice. */
	private filing: Promise<void> = Promise.resolve();
	/** The repository's open pull requests, read once a tick when an implementation is due. */
	private openPullRequests: Promise<OpenPullRequest[]> | undefined;
	private readonly finished: NotedIssue[] = [];
	private totals = { runs: 0, tokens: 0, cost: 0 };
	private signal: AbortSignal | undefined;
	private wakeUp: (() => void) | undefined;
	private woken = false;

	constructor(options: OrchestratorOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
	}

	/** Run until `signal` aborts; then stop every run it started and wait for them to end. */
	async run(signal: AbortSignal): Promise<void> {
		this.signal = signal;
		const wake = (): void => this.wake();
		signal.addEventListener("abort", wake, { once: true });
		try {
			while (!signal.aborted) {
				await this.tick();
				if (signal.aborted) break;
				await this.sleep(this.nextDelay());
			}
		} finally {
			signal.removeEventListener("abort", wake);
			await this.stopAll();
			this.emit();
		}
	}

	/** Tick again now, instead of at the next poll. */
	wake(): void {
		this.woken = true;
		this.wakeUp?.();
	}

	snapshot(): OrchestratorSnapshot {
		return {
			...(this.repo === undefined ? {} : { repo: this.repo }),
			...(this.workflow === undefined ? {} : { workflowPath: this.workflow.path }),
			...(this.error === undefined ? {} : { error: this.error }),
			running: [...this.running.values()].map((entry) => ({
				issue: entry.issue.number,
				title: entry.issue.title,
				role: entry.role,
				...(entry.runId === undefined ? {} : { runId: entry.runId }),
				startedAt: entry.startedAt,
			})),
			retrying: [...this.retries.values()],
			waiting: [...this.waiting.values()],
			handedOff: [...this.handedOff.entries()].map(([issue, handoff]) => ({
				issue,
				title: handoff.title,
				reason: handoff.reason,
				ready: handoff.ready,
			})),
			finished: [...this.finished],
			totals: { ...this.totals },
			...(this.lastTickAt === undefined ? {} : { lastTickAt: this.lastTickAt }),
		};
	}

	/** One pass: reload the workflow, stop runs of issues that left it, and act on each labeled issue. */
	async tick(): Promise<void> {
		this.lastTickAt = this.now();
		this.woken = false;
		this.openPullRequests = undefined;
		const previous = this.error;
		const fail = (message: string): void => {
			this.error = message;
			// Logged when it starts, not on every tick it lasts.
			if (message !== previous) this.log(message);
		};
		try {
			this.workflow = await this.options.loadWorkflow();
			this.error = undefined;
		} catch (error) {
			// An invalid reload keeps the last good workflow.
			fail(`Workflow: ${errorText(error)}`);
		}
		const workflow = this.workflow;
		if (workflow === undefined) return this.emit();
		const config = workflow.config;
		let tracker: Tracker;
		try {
			tracker = await this.options.tracker(config);
			this.repo = tracker.repo;
		} catch (error) {
			fail(`GitHub: ${errorText(error)}`);
			return this.emit();
		}
		await this.reconcile(tracker, config);
		await this.releaseCheckouts();
		let candidates: Issue[];
		try {
			candidates = await tracker.candidates(config.tracker.labels);
		} catch (error) {
			fail(`GitHub: ${errorText(error)}`);
			return this.emit();
		}
		// An issue that left the candidates (closed, or unlabeled) is done with.
		const listed = new Set(candidates.map((issue) => issue.number));
		for (const [number, title] of this.known) {
			if (listed.has(number) || this.running.has(number)) continue;
			this.forget(number);
			this.pendingReleases.set(number, { title });
		}
		candidates = await this.recheckApproved(tracker, config, candidates);
		if (this.sweepDue) await this.sweepCheckouts(tracker, config, candidates);
		const waiting = new Map<number, NotedIssue>();
		this.waiting = waiting;
		const ordered = candidates
			.filter((issue) => isRoutable(issue, config))
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.number - right.number);
		// A retry of an issue that left the workflow is not coming.
		const worked = new Set(ordered.map((issue) => issue.number));
		for (const number of this.retries.keys()) {
			if (!worked.has(number) && !this.running.has(number)) this.retries.delete(number);
		}
		for (const issue of ordered) {
			if (this.signal?.aborted) break;
			if (this.running.has(issue.number)) continue;
			const handoff = this.handedOff.get(issue.number);
			if (handoff !== undefined) {
				// Labeled, and a human removed the label: work it again from a clean slate.
				if (handoff.label === undefined || issue.labels.includes(handoff.label.toLowerCase())) continue;
				this.forget(issue.number);
				// Its checkout is wanted again; one already released is created again on its branch.
				this.pendingReleases.delete(issue.number);
			}
			const retry = this.retries.get(issue.number);
			if (retry !== undefined && retry.dueAt > this.now()) continue;
			let phase: Phase;
			try {
				phase = await inspectIssue(tracker, config, issue);
			} catch (error) {
				waiting.set(issue.number, {
					issue: issue.number,
					title: issue.title,
					reason: `GitHub: ${errorText(error)}`,
				});
				continue;
			}
			await this.act(tracker, config, issue, phase, waiting);
			this.emit();
		}
		this.emit();
	}

	private async act(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Phase,
		waiting: Map<number, NotedIssue>,
	): Promise<void> {
		const note = (reason: string): void => {
			waiting.set(issue.number, { issue: issue.number, title: issue.title, reason });
		};
		const pr = "pr" in phase ? phase.pr : undefined;
		if (pr !== undefined && this.awaitingPullRequest.delete(issue.number)) {
			this.announce({ kind: "pr_opened", issue: issueLink(issue), pr: pullRequestLink(pr) });
		}
		switch (phase.kind) {
			case "done":
				this.finish(issue, phase.reason);
				return;
			case "wait":
				note(phase.reason);
				return;
			case "handoff": {
				const waived = phase.waived === undefined ? "" : await this.waivedText(phase.waived);
				await this.handOff(tracker, config, issue, phase.label, `${phase.reason}${waived}`, phase.pr);
				return;
			}
			case "restart":
				await this.restart(tracker, config, issue, phase, note);
				return;
			case "merge":
				try {
					await tracker.merge(phase.pr.number, config.merge.method);
					this.log(`#${issue.number}: merged pull request #${phase.pr.number}`);
					this.finish(issue, `merged pull request #${phase.pr.number}`);
					if (phase.waived !== undefined) {
						const waived = await this.waivedText(phase.waived);
						await tracker
							.comment(
								issue.number,
								`Merged pull request #${phase.pr.number}.${waived}\n\n_Volt issue orchestrator_`,
							)
							.catch((error: unknown) =>
								this.log(`#${issue.number}: listing the waived findings failed: ${errorText(error)}`),
							);
					}
				} catch (error) {
					await this.handOff(
						tracker,
						config,
						issue,
						config.handoffLabel,
						`Merging pull request #${phase.pr.number} failed: ${errorText(error)}`,
						phase.pr,
					);
				}
				return;
			default: {
				// An implementation is attempted per branch: a restart's starts its own count.
				const key = `${issue.number}:${phase.kind}:${"pr" in phase ? phase.pr.headSha : phase.branch}`;
				const attempts = this.attempts.get(key) ?? 0;
				if (attempts >= config.agent.maxAttempts) {
					await this.handOff(
						tracker,
						config,
						issue,
						config.handoffLabel,
						`The ${phase.kind} agent ran ${attempts} times without moving the issue on.`,
						pr,
					);
					return;
				}
				const role = config.roles[phase.kind];
				const busy = [...this.running.values()];
				if (busy.length >= config.agent.maxConcurrent) return note("waiting for a free agent slot");
				if (
					role.maxConcurrent !== undefined &&
					busy.filter((entry) => entry.role === phase.kind).length >= role.maxConcurrent
				) {
					return note(`waiting for a free ${phase.kind} slot`);
				}
				if (phase.kind === "implement") {
					const blocker = await this.sameCode(tracker, issue);
					if (blocker !== undefined) return note(blocker);
				}
				this.dispatch(tracker, config, issue, phase, key, attempts);
			}
		}
	}

	/**
	 * Start an agent of `phase`'s role on `issue` in the background; its slot is
	 * taken at once. Only an agent that started counts as an attempt of the
	 * phase (`key`): a checkout that could not be prepared is retried with
	 * backoff, never handed off for it.
	 */
	private dispatch(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Extract<Phase, { kind: Role }>,
		key: string,
		attempts: number,
	): void {
		const role = config.roles[phase.kind];
		const ended = Promise.withResolvers<void>();
		const engineReview = phase.kind === "review" && config.review.engine !== "agent";
		const entry: RunningEntry = {
			issue,
			role: phase.kind,
			engineReview,
			startedAt: this.now(),
			runId: undefined,
			cancelled: false,
			ended: ended.promise,
		};
		this.running.set(issue.number, entry);
		if (!this.known.has(issue.number)) {
			this.announce({
				kind: "picked_up",
				issue: issueLink(issue),
				role: phase.kind,
				...("pr" in phase ? { pr: pullRequestLink(phase.pr) } : {}),
			});
		}
		if (phase.kind === "implement") this.awaitingPullRequest.add(issue.number);
		this.known.set(issue.number, issue.title);
		this.log(`#${issue.number}: starting ${phase.kind} (${engineReview ? config.review.engine : role.agent})`);
		void (async () => {
			let result: AgentResult;
			try {
				const run =
					phase.kind === "review" && engineReview
						? await this.startEngineReview(tracker, config, issue, phase, entry)
						: await this.startAgent(tracker, config, issue, phase, attempts, entry);
				entry.runId = run.id;
				this.attempts.set(key, attempts + 1);
				this.emit();
				// Stopped while it started.
				if (entry.cancelled) await this.stopRun(entry, run.id);
				result = await run.ended;
			} catch (error) {
				result = { status: "failed", error: errorText(error), usage: { tokens: 0, cost: 0 } };
			}
			this.ended(entry, result, config);
			ended.resolve();
		})();
	}

	/** Start the agent of `phase`'s role in the issue's checkout. */
	private async startAgent(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Extract<Phase, { kind: Role }>,
		attempts: number,
		entry: RunningEntry,
	): Promise<AgentRun> {
		const role = config.roles[phase.kind];
		const branch = "pr" in phase ? phase.pr.headRef : phase.branch;
		let workspace: Workspace;
		try {
			workspace = await this.options.workspaces.prepare(issue, config, branch);
		} catch (error) {
			// The workspace may be full of checkouts of issues done with that this orchestrator does not know of.
			if (errorText(error).startsWith("worktree_limit_reached")) this.sweepDue = true;
			throw new Error(`setting up the checkout failed: ${errorText(error)}`);
		}
		const findings =
			phase.kind === "fix" && phase.runId !== undefined
				? await this.findingsText(phase.runId, phase.round)
				: undefined;
		const history = phase.kind === "triage" ? await this.triageHistory(tracker, phase.pr) : undefined;
		const task = renderTemplate(
			role.prompt,
			this.variables(tracker, config, issue, phase, workspace, attempts, findings, history),
		);
		if (entry.cancelled) throw new Error("stopped before it started");
		const run = await this.options.agents.start({
			agent: role.agent,
			task,
			cwd: workspace.path,
			limits: role.limits,
		});
		return {
			id: run.id,
			ended: run.ended.then((result) => this.concludeAgent(tracker, config, issue, phase, result)),
		};
	}

	/**
	 * Record the problems a finished agent reports outside its work, as a
	 * review's follow-ups are. A triage's decision is posted on the pull request
	 * for the next tick to carry out; a triage that gives none failed.
	 */
	private async concludeAgent(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Extract<Phase, { kind: Role }>,
		result: AgentResult,
	): Promise<AgentResult> {
		if (result.status !== "completed" || result.output === undefined) {
			return phase.kind === "triage" && result.status === "completed"
				? { ...result, status: "failed", error: "the triage gave no reply" }
				: result;
		}
		if (phase.kind === "triage") {
			const decision = triageReport(result.output);
			if ("error" in decision) return { ...result, status: "failed", error: decision.error };
			try {
				await tracker.comment(phase.pr.number, triageComment(decision, phase.pr.headSha));
			} catch (error) {
				return { ...result, status: "failed", error: `posting the triage failed: ${errorText(error)}` };
			}
			this.log(`#${issue.number}: triage decided ${decision.decision} for pull request #${phase.pr.number}`);
		}
		const report = outOfScopeProblems(result.output);
		for (const error of report.errors) this.log(`#${issue.number}: the ${phase.kind} agent's report: ${error}`);
		await this.recordFollowUps(tracker, config, issue, foundBy(phase, issue), report.problems);
		return result;
	}

	/**
	 * Start a review of the pull request on the workflow's review engine. It
	 * needs no checkout of the issue's: the host reviews the pull request's
	 * head in a checkout of its own, set up with the workflow's hook.
	 */
	private async startEngineReview(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Extract<Phase, { kind: "review" }>,
		entry: RunningEntry,
	): Promise<AgentRun> {
		if (entry.cancelled) throw new Error("stopped before it started");
		const setup = config.workspace.afterCreate;
		const run = await this.options.reviews.start({
			pr: phase.pr.number,
			engine: config.review.engine,
			...(phase.previousRunId === undefined ? {} : { previousRunId: phase.previousRunId }),
			...(setup === undefined
				? {}
				: { setup: { command: setup, timeoutMs: Math.min(config.workspace.hookTimeoutMs, MAX_REVIEW_SETUP_MS) } }),
		});
		return {
			id: run.id,
			ended: run.ended.then((result) => this.concludeReview(tracker, config, issue, phase, run.id, result)),
		};
	}

	/**
	 * Post a complete review to its pull request, ending with the verdict the
	 * next tick reads, then file its follow-ups. An incomplete review gives no
	 * verdict: the run failed, and is tried again.
	 *
	 * From the second round on, a review whose open findings (P0 to P2) all
	 * predate the change is posted clean: the first round's fix had its chance
	 * at them, and they are listed for the human the pull request goes to. A
	 * review that still asks for changes counts the new findings the change
	 * introduced on lines the last fix changed: the fix made it worse, which
	 * sends the pull request to a triage.
	 */
	private async concludeReview(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Extract<Phase, { kind: "review" }>,
		runId: string,
		result: ReviewResult,
	): Promise<AgentResult> {
		const pr = phase.pr;
		const usage = result.usage;
		if (result.status !== "completed") {
			return { status: result.status, ...(result.error === undefined ? {} : { error: result.error }), usage };
		}
		const verdict = result.verdict;
		if (verdict === undefined) {
			return {
				status: "failed",
				error: `the review is incomplete${result.error ? `: ${result.error}` : ""}`,
				usage,
			};
		}
		const open = (result.findings ?? []).filter((finding) => finding.priority <= 2);
		const waived =
			verdict.value === "changes" && phase.round > 1 && open.length > 0 && open.every((f) => f.introduced === false)
				? open.length
				: 0;
		const value: ReviewVerdict = waived > 0 ? "clean" : verdict.value;
		const regressed =
			value === "changes" && phase.previousRunId !== undefined && phase.previousHeadSha !== undefined
				? await this.regressions(tracker, issue, phase.previousRunId, phase.previousHeadSha, verdict.headSha, open)
				: 0;
		const notes = [
			...(waived > 0
				? [
						`The issue orchestrator does not block on this review's ${counted(waived, "finding")}: each predates the change, and round ${phase.round - 1} had its chance at them. They are listed for the maintainer.`,
					]
				: []),
			...(regressed > 0
				? [
						`${counted(regressed, "finding")} of this review ${regressed === 1 ? "is a new defect" : "are new defects"} on lines the last fix changed.`,
					]
				: []),
		];
		const marker = reviewMarker(verdict.headSha, value, runId, { waived, regressed });
		try {
			await this.options.reviews.publish(runId, {
				trailer: notes.length === 0 ? marker : `${notes.join("\n\n")}\n\n${marker}`,
				command: config.ghCommand,
			});
		} catch (error) {
			// Such as when the pull request moved on since: its new head is reviewed next.
			return { status: "failed", error: `posting the review failed: ${errorText(error)}`, usage };
		}
		const counts = [
			...(waived > 0 ? [`${waived} pre-existing waived`] : []),
			...(regressed > 0 ? [`${regressed} regressed`] : []),
		];
		this.log(
			`#${issue.number}: posted the review (${value}${counts.length === 0 ? "" : `, ${counts.join(", ")}`}) on pull request #${pr.number}`,
		);
		const found = `Found outside the change while reviewing ${pr.url} for ${issue.identifier}.`;
		await this.recordFollowUps(tracker, config, issue, found, result.followUps);
		return { status: "completed", usage };
	}

	/** {@link fileFollowUps}, after the filings already under way: two runs that end together would file a site twice. */
	private async recordFollowUps(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		found: string,
		followUps: readonly ReviewFollowUp[],
	): Promise<void> {
		if (followUps.length === 0) return;
		const filing = this.filing.then(() => this.fileFollowUps(tracker, config, issue, found, followUps));
		this.filing = filing;
		await filing;
	}

	/**
	 * Record each follow-up once, where the workflow works it: a review's, or a
	 * problem an agent reported outside its work, found as `found` says. One
	 * whose fingerprint an issue or comment names already is skipped. One at
	 * the code of an open issue the workflow works, other than `issue` (whose
	 * pull request closes it), is added to that issue as a comment, for its
	 * agents to address with it. Anything else is filed as an issue of its
	 * own, labeled `tracker.filed_label` besides the workflow's labels; but one
	 * found while working an issue an agent filed gets only `tracker.filed_label`,
	 * so a human decides whether the chain goes on. One that fails is logged; a
	 * later run may report it again.
	 */
	private async fileFollowUps(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		found: string,
		followUps: readonly ReviewFollowUp[],
	): Promise<void> {
		let sites: IssueSite[] | undefined;
		const chained = issue.labels.includes(config.tracker.filedLabel.toLowerCase());
		const triage = chained
			? `Filed without ${config.tracker.labels.map((label) => `\`${label}\``).join(" and ")}: it was found while working an issue an agent filed, so a human decides whether to have it worked by adding ${config.tracker.labels.length === 1 ? "that label" : "those labels"}.`
			: undefined;
		for (const followUp of followUps) {
			if (this.filedFollowUps.has(followUp.fingerprint)) continue;
			try {
				// GitHub's search lags a filing: what this run filed is remembered as well.
				if (!(await tracker.mentioned(followUp.fingerprint))) {
					// The issue under review closes with its pull request, and what it was told with it.
					sites ??= (await tracker.candidates(config.tracker.labels))
						.filter((candidate) => candidate.number !== issue.number)
						.flatMap((candidate) => issueSites(candidate.number, candidate.body));
					const existing = sites.find((site) => coversFollowUp(site, followUp));
					if (existing) {
						await tracker.comment(existing.issue, followUpComment(followUp, found));
						this.log(`#${issue.number}: added the follow-up at ${location(followUp)} to #${existing.issue}`);
					} else {
						const filed = await tracker.fileIssue({
							title: followUp.title,
							body: followUpBody(followUp, found, triage),
							labels: chained
								? [config.tracker.filedLabel]
								: [...config.tracker.labels, config.tracker.filedLabel],
						});
						sites.push({
							issue: filed.number,
							path: followUp.path,
							startLine: followUp.startLine,
							endLine: followUp.endLine,
						});
						this.log(`#${issue.number}: filed follow-up #${filed.number}: ${filed.url}`);
					}
				}
				this.filedFollowUps.add(followUp.fingerprint);
			} catch (error) {
				this.log(`#${issue.number}: filing the follow-up "${followUp.title}" failed: ${errorText(error)}`);
			}
		}
	}

	/**
	 * The open findings of review `runId`, for the fixer of round `round`'s
	 * prompt; undefined when there are none to give. From the second round on,
	 * the ones that predate the change no longer block it.
	 */
	private async findingsText(runId: string, round: number): Promise<string | undefined> {
		let findings: ReviewFinding[] | undefined;
		try {
			findings = await this.options.reviews.findings(runId);
		} catch (error) {
			this.log(`reading the findings of review ${runId} failed: ${errorText(error)}`);
			return undefined;
		}
		if (findings === undefined || findings.length === 0) return undefined;
		const optional = round > 1 && findings.some((finding) => finding.introduced === false);
		return [
			"The review's open findings:",
			...findings.map((finding) =>
				[
					`- [P${finding.priority}] ${finding.title} (${location(finding)})${finding.introduced === false ? " (pre-existing)" : ""}`,
					...finding.body.split("\n").map((line) => (line.length === 0 ? "" : `  ${line}`)),
				].join("\n"),
			),
			...(optional
				? [
						"",
						"Findings marked pre-existing predate the change and no longer block it: fix them only where that is small and safe, and never at the cost of the others.",
					]
				: []),
		].join("\n");
	}

	/**
	 * How many of `findings`, the open ones of a review that asked for changes,
	 * are new defects the change introduced on lines the fix since
	 * `previousHeadSha` (which review `previousRunId` reviewed) changed. Zero
	 * when that review's findings or the diff cannot be read.
	 */
	private async regressions(
		tracker: Tracker,
		issue: Issue,
		previousRunId: string,
		previousHeadSha: string,
		headSha: string,
		findings: readonly ReviewFinding[],
	): Promise<number> {
		try {
			const previous = await this.options.reviews.findings(previousRunId);
			// The conversation no longer holds the previous round: what is new cannot be told.
			if (previous === undefined) return 0;
			const known = new Set(previous.flatMap((finding) => (finding.id === undefined ? [] : [finding.id])));
			const fresh = findings.filter(
				(finding) => finding.introduced !== false && finding.id !== undefined && !known.has(finding.id),
			);
			if (fresh.length === 0) return 0;
			const changed: ChangedLines = await tracker.changedLines(previousHeadSha, headSha);
			return fresh.filter((finding) =>
				[...changed].some(
					([path, ranges]) =>
						samePath(path, finding.path) &&
						ranges.some((range) => range.startLine <= finding.endLine && finding.startLine <= range.endLine),
				),
			).length;
		} catch (error) {
			this.log(`#${issue.number}: telling the review's new defects from the fix's failed: ${errorText(error)}`);
			return 0;
		}
	}

	/** Each review round of pull request `pr`, with its verdict and the findings the conversation still holds, for a triage. */
	private async triageHistory(tracker: Tracker, pr: PullRequest): Promise<string> {
		const lines: string[] = [];
		let round = 0;
		for (const verdict of verdictsByHead((await tracker.markers(pr.number)).verdicts)) {
			const merge = await tracker.isMergeCommit(verdict.headSha);
			const counts = [
				...(verdict.waived ? [`${verdict.waived} pre-existing, not blocking`] : []),
				...(verdict.regressed ? [`${verdict.regressed} new on lines the fix before it changed`] : []),
			];
			lines.push(
				`- ${merge ? "After merging the base branch in" : `Round ${++round}`} (head ${verdict.headSha.slice(0, 12)}): ${verdict.verdict}${counts.length === 0 ? "" : ` (${counts.join("; ")})`}`,
			);
			if (verdict.runId === undefined) continue;
			const findings = await this.options.reviews.findings(verdict.runId).catch(() => undefined);
			for (const finding of findings ?? []) {
				lines.push(
					`  - [P${finding.priority}] ${finding.title} (${location(finding)})${finding.introduced === false ? ", pre-existing" : ""}`,
				);
			}
		}
		return lines.length === 0 ? "No review verdicts." : lines.join("\n");
	}

	/** The pre-existing findings a clean verdict did not block on, listed for the human the pull request goes to. */
	private async waivedText(waived: Waived): Promise<string> {
		const findings =
			waived.runId === undefined
				? undefined
				: await this.options.reviews.findings(waived.runId).catch(() => undefined);
		const listed = (findings ?? []).filter((finding) => finding.introduced === false);
		const lead = `\n\nThe review did not block on ${counted(waived.count, "finding")} that predate${waived.count === 1 ? "s" : ""} the change`;
		if (listed.length === 0) return `${lead}; the review on the pull request lists them.`;
		return `${lead}:\n${listed.map((finding) => `- [P${finding.priority}] ${finding.title} (${location(finding)})`).join("\n")}`;
	}

	/**
	 * Carry out a triage's restart of `issue`: record it on the issue, with the
	 * triage's guidance and the branch the next implementation takes, then
	 * close the pull request and release its checkout. A restart already
	 * recorded for the pull request (closing it failed) only closes it. Past
	 * `triage.max_restarts`, the issue goes to a human instead.
	 */
	private async restart(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Extract<Phase, { kind: "restart" }>,
		note: (reason: string) => void,
	): Promise<void> {
		const pr = phase.pr;
		const base = pr.baseRef || "the base branch";
		try {
			const restarts = await tracker.restarts(issue.number);
			if (!restarts.some((restart) => restart.pr === pr.number)) {
				if (restarts.length >= config.triage.maxRestarts) {
					await this.handOff(
						tracker,
						config,
						issue,
						config.handoffLabel,
						`A triage asked to restart pull request #${pr.number}, but the issue was restarted ${counted(restarts.length, "time")} already (triage.max_restarts).\n\n${phase.triage.text}`,
						pr,
					);
					return;
				}
				const branch = issueBranch(issue.number, branchCount(issue.number, pr.headRef) + 1);
				await tracker.comment(
					issue.number,
					[
						`Restarting this issue from ${base} on \`${branch}\`: a triage closed pull request #${pr.number}.`,
						"",
						phase.triage.text,
						"",
						restartMarker(branch, pr.number),
					].join("\n"),
				);
			}
			await tracker.closePullRequest(
				pr.number,
				`A triage restarts ${issue.identifier} from ${base} on a new branch: ${issue.url}\n\n_Volt issue orchestrator_`,
			);
		} catch (error) {
			note(`restarting failed, trying again: ${errorText(error)}`);
			this.log(`#${issue.number}: restarting failed: ${errorText(error)}`);
			return;
		}
		this.log(`#${issue.number}: closed pull request #${pr.number} and restarted the issue from ${base}`);
		// The closed pull request's checkout is done with; the next implementation gets one of its own.
		this.pendingReleases.set(issue.number, { title: issue.title });
		this.wake();
	}

	/**
	 * Why `issue`'s implementation waits, when another issue's work changes the
	 * code `issue` names (`path:line` sites in its text): an implementation of
	 * it running now, or its open pull request. Undefined when nothing does, or
	 * when the open pull requests cannot be read.
	 */
	private async sameCode(tracker: Tracker, issue: Issue): Promise<string | undefined> {
		const paths = [...new Set(issueSites(issue.number, issue.body).map((site) => site.path))];
		if (paths.length === 0) return undefined;
		const named = (path: string): boolean => paths.some((site) => samePath(site, path));
		for (const entry of this.running.values()) {
			if (entry.issue.number === issue.number || entry.role !== "implement") continue;
			const site = issueSites(entry.issue.number, entry.issue.body).find((other) => named(other.path));
			if (site !== undefined) return `waiting for #${entry.issue.number}, whose implementation changes ${site.path}`;
		}
		let open: OpenPullRequest[];
		try {
			this.openPullRequests ??= tracker.openPullRequests();
			open = await this.openPullRequests;
		} catch (error) {
			// Said once a tick: the issues after this one go ahead too.
			this.openPullRequests = Promise.resolve([]);
			this.log(`listing the open pull requests failed: ${errorText(error)}`);
			return undefined;
		}
		for (const pr of open) {
			const other = branchIssue(pr.headRef);
			if (other === undefined || other === issue.number) continue;
			const file = pr.files.find(named);
			if (file !== undefined) return `waiting for #${other}, whose pull request #${pr.number} changes ${file}`;
		}
		return undefined;
	}

	private ended(entry: RunningEntry, result: AgentResult, config: WorkflowConfig): void {
		const number = entry.issue.number;
		if (this.running.get(number) === entry) this.running.delete(number);
		if (entry.runId !== undefined) this.totals.runs += 1;
		this.totals.tokens += result.usage.tokens;
		this.totals.cost += result.usage.cost;
		this.log(`#${number}: ${entry.role} ${result.status}${result.error ? `: ${result.error}` : ""}`);
		if (entry.cancelled) {
			// The issue left the workflow, or the orchestrator stopped: nothing to retry.
		} else if (result.status === "completed") {
			// The next tick reads what the run changed and decides again.
			this.retries.delete(number);
		} else {
			const failures = (this.retries.get(number)?.failures ?? 0) + 1;
			const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (failures - 1), config.agent.maxRetryBackoffMs);
			this.retries.set(number, {
				issue: number,
				title: entry.issue.title,
				failures,
				dueAt: this.now() + delay,
				error: result.error ?? result.status,
			});
		}
		this.emit();
		this.wake();
	}

	/**
	 * Take back the approval of each approved issue whose pull request has come
	 * to conflict with its base branch, so it is worked again, from an update.
	 * Resolves with the candidates as they are after that.
	 */
	private async recheckApproved(tracker: Tracker, config: WorkflowConfig, candidates: Issue[]): Promise<Issue[]> {
		const ready = config.merge.readyLabel.toLowerCase();
		const result: Issue[] = [];
		for (const issue of candidates) {
			const unapproved = { ...issue, labels: issue.labels.filter((label) => label !== ready) };
			// Not approved, or excluded anyway (handed to a human as well, say).
			if (
				unapproved.labels.length === issue.labels.length ||
				!isRoutable(unapproved, config) ||
				this.signal?.aborted
			) {
				result.push(issue);
				continue;
			}
			try {
				const pr = await tracker.pullRequest(issueBranch(issue.number));
				if (pr?.state !== "open" || pr.mergeable !== "conflicting") {
					result.push(issue);
					continue;
				}
				const reason = `Pull request #${pr.number} now conflicts with ${pr.baseRef || "its base branch"}, so it is no longer ready to merge. The orchestrator is updating it.`;
				await tracker.takeBack(issue.number, config.merge.readyLabel, `${reason}\n\n_Volt issue orchestrator_`);
				this.log(`#${issue.number}: took the approval back: ${reason}`);
				result.push(unapproved);
			} catch (error) {
				this.log(`#${issue.number}: checking its approved pull request failed: ${errorText(error)}`);
				result.push(issue);
			}
		}
		return result;
	}

	/** Stop the runs of issues that closed, or lost a required label or gained an excluded one. */
	private async reconcile(tracker: Tracker, config: WorkflowConfig): Promise<void> {
		for (const entry of [...this.running.values()]) {
			if (entry.cancelled) continue;
			let issue: Issue | undefined;
			try {
				issue = await tracker.issue(entry.issue.number);
			} catch {
				// Unknown for now: keep it running and ask again next tick.
				continue;
			}
			if (issue?.open && isRoutable(issue, config)) {
				entry.issue = issue;
				continue;
			}
			this.log(`#${entry.issue.number}: stopping ${entry.role}: the issue left the workflow`);
			await this.cancel(entry);
		}
	}

	/**
	 * Release the checkouts of issues the orchestrator is done with: handed to a
	 * human (a checkout with changes stays for them), approved, or finished.
	 * One a conversation still holds, or whose release fails, is tried again
	 * next tick.
	 */
	private async releaseCheckouts(): Promise<void> {
		for (const [number, pending] of [...this.pendingReleases]) {
			if (this.running.has(number)) {
				this.pendingReleases.delete(number);
				continue;
			}
			let outcome: ReleaseOutcome;
			try {
				outcome = await this.options.workspaces.release(number);
			} catch (error) {
				// Such as while the daemon cannot set the checkout aside: a later tick may.
				const message = errorText(error);
				if (pending.error !== message)
					this.log(`#${number}: releasing the checkout failed, trying again: ${message}`);
				pending.error = message;
				continue;
			}
			if (outcome === "retry") continue;
			this.pendingReleases.delete(number);
			const issue = pending.title === undefined ? `#${number}` : `#${number} (${pending.title})`;
			this.log(`${issue}: ${outcome === "released" ? "released its checkout" : "kept its checkout"}`);
		}
	}

	/**
	 * Release the checkout of every issue GitHub shows the orchestrator is done
	 * with (closed, approved, handed off, or out of the workflow), including the
	 * ones an earlier run worked, which this one does not know of.
	 */
	private async sweepCheckouts(tracker: Tracker, config: WorkflowConfig, candidates: readonly Issue[]): Promise<void> {
		this.sweepDue = false;
		let numbers: number[];
		try {
			numbers = await this.options.workspaces.checkouts();
		} catch (error) {
			// Looked for again once the workspace is full.
			this.log(`listing the checkouts failed: ${errorText(error)}`);
			return;
		}
		const listed = new Map(candidates.map((issue) => [issue.number, issue]));
		for (const number of numbers) {
			if (this.running.has(number) || this.pendingReleases.has(number)) continue;
			let issue = listed.get(number);
			if (issue === undefined) {
				try {
					issue = await tracker.issue(number);
				} catch (error) {
					this.log(`#${number}: checking whether its checkout is still needed failed: ${errorText(error)}`);
					continue;
				}
			}
			if (issue?.open && isRoutable(issue, config)) continue;
			this.pendingReleases.set(number, { title: issue?.title });
		}
		await this.releaseCheckouts();
	}

	private async cancel(entry: RunningEntry): Promise<void> {
		entry.cancelled = true;
		if (entry.runId !== undefined) await this.stopRun(entry, entry.runId);
	}

	private async stopRun(entry: RunningEntry, id: string): Promise<void> {
		const runs = entry.engineReview ? this.options.reviews : this.options.agents;
		await runs.cancel(id).catch(() => undefined);
	}

	private async stopAll(): Promise<void> {
		const entries = [...this.running.values()];
		await Promise.all(entries.map((entry) => this.cancel(entry)));
		await Promise.all(entries.map((entry) => entry.ended));
	}

	private async handOff(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		label: string,
		reason: string,
		pr: PullRequest | undefined,
	): Promise<void> {
		let labeled = false;
		try {
			labeled = await tracker.handOff(issue.number, label, `${reason}\n\n_Volt issue orchestrator_`);
		} catch (error) {
			this.log(`#${issue.number}: handing off failed: ${errorText(error)}`);
		}
		this.handedOff.set(issue.number, {
			title: issue.title,
			reason,
			label: labeled ? label : undefined,
			ready: label === config.merge.readyLabel,
		});
		this.retries.delete(issue.number);
		this.pendingReleases.set(issue.number, { title: issue.title });
		this.log(`#${issue.number}: handed to a human: ${reason}`);
		this.announce({
			kind: "handed_off",
			issue: issueLink(issue),
			ready: label === config.merge.readyLabel,
			reason,
			...(pr === undefined ? {} : { pr: pullRequestLink(pr) }),
		});
	}

	private finish(issue: Issue, reason: string): void {
		this.forget(issue.number);
		this.pendingReleases.set(issue.number, { title: issue.title });
		if (this.finished.some((entry) => entry.issue === issue.number && entry.reason === reason)) return;
		this.finished.unshift({ issue: issue.number, title: issue.title, reason });
		this.finished.length = Math.min(this.finished.length, MAX_FINISHED);
	}

	/** Drop what the orchestrator remembers of an issue's runs. */
	private forget(number: number): void {
		this.retries.delete(number);
		this.handedOff.delete(number);
		this.known.delete(number);
		this.awaitingPullRequest.delete(number);
		for (const key of [...this.attempts.keys()]) if (key.startsWith(`${number}:`)) this.attempts.delete(key);
	}

	private variables(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		phase: Extract<Phase, { kind: Role }>,
		workspace: Workspace,
		attempts: number,
		findings: string | undefined,
		history: string | undefined,
	): Record<string, TemplateValue> {
		const pr = "pr" in phase ? phase.pr : undefined;
		const restart = phase.kind === "implement" ? phase.restart : undefined;
		const restartsLeft = Math.max(0, config.triage.maxRestarts - (branchCount(issue.number, workspace.branch) - 1));
		return {
			issue: {
				number: issue.number,
				identifier: issue.identifier,
				title: issue.title,
				body: issue.body,
				url: issue.url,
				labels: [...issue.labels],
			},
			repo: tracker.repo,
			gh: config.ghCommand.join(" "),
			tracker: { labels: [...config.tracker.labels] },
			out_of_scope: OUT_OF_SCOPE_INSTRUCTIONS,
			worktree: { path: workspace.path, branch: workspace.branch },
			attempt: attempts === 0 ? null : attempts + 1,
			round: "round" in phase ? phase.round : null,
			reason: "reason" in phase ? phase.reason : null,
			pr: {
				number: pr?.number ?? null,
				url: pr?.url ?? null,
				head_sha: pr?.headSha ?? null,
				base_ref: pr?.baseRef ?? null,
			},
			review: {
				max_rounds: config.review.maxRounds,
				clean_marker: pr === undefined ? null : reviewMarker(pr.headSha, "clean"),
				changes_marker: pr === undefined ? null : reviewMarker(pr.headSha, "changes"),
				findings: findings ?? null,
			},
			ci: { failing: "failing" in phase ? [...phase.failing] : [] },
			restart: {
				previous_pr: restart?.previousPr ?? null,
				guidance:
					restart === undefined
						? null
						: `This is a fresh start from the base branch: a triage closed the previous attempt, pull request #${restart.previousPr}, because its approach did not converge. Take the approach the triage gives instead of repeating that one:\n\n${restart.guidance}`,
			},
			triage: {
				reason: phase.kind === "triage" ? phase.reason : null,
				history: history ?? null,
				output: TRIAGE_INSTRUCTIONS,
				restarts_left: restartsLeft,
			},
		};
	}

	/** Until the next poll, or the next retry that comes due before it. */
	private nextDelay(): number {
		const interval = this.workflow?.config.polling.intervalMs ?? 60_000;
		const now = this.now();
		const dues = [...this.retries.values()].filter((retry) => retry.dueAt > now).map((retry) => retry.dueAt - now);
		return Math.max(MIN_TICK_DELAY_MS, Math.min(interval, ...dues));
	}

	private sleep(ms: number): Promise<void> {
		if (this.woken || this.signal?.aborted) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(done, ms);
			function done(): void {
				clearTimeout(timer);
				resolve();
			}
			this.wakeUp = () => {
				this.wakeUp = undefined;
				done();
			};
		});
	}

	private announce(event: OrchestratorEvent): void {
		try {
			this.options.announce?.(event);
		} catch (error) {
			// An observer that fails does not stop the loop.
			this.log(`announcing ${event.kind} failed: ${errorText(error)}`);
		}
	}

	private emit(): void {
		try {
			this.options.onChange?.(this.snapshot());
		} catch (error) {
			// An observer that fails does not stop the loop.
			this.log(`status update failed: ${errorText(error)}`);
		}
	}

	private log(line: string): void {
		this.options.log?.(line);
	}
}
