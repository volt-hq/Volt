/**
 * The orchestrator: one deterministic loop that owns every scheduling
 * decision. Each tick re-reads the workflow (keeping the last good one when it
 * breaks), stops the runs of issues that left the workflow, then works each
 * labeled issue by what it needs next (`phase.ts`): it starts an agent of the
 * phase's role in the issue's worktree, or a review of the pull request on a
 * review engine (`review.engine`), merges, or hands the issue to a human.
 * The orchestrator posts an engine's complete review with its verdict, and
 * files the review's follow-ups as issues. A run that ends wakes the loop at
 * once. An approved issue stays watched: once its pull request conflicts with
 * its base branch (another one merged), the approval is taken back and the
 * pull request updated.
 *
 * Its state is in memory only. GitHub is the source of truth: after a
 * restart the next tick finds each issue's phase again, and the checkouts of
 * the issues it is done with. Bounded by:
 * concurrency limits, `agent.max_attempts` runs of one phase of one head
 * commit, exponential backoff after a failed run, and `review.max_rounds`.
 */

import type { Issue, PullRequest, ReviewVerdict, Tracker } from "./github.ts";
import { reviewMarker } from "./github.ts";
import { inspectIssue, isRoutable, issueBranch, type Phase } from "./phase.ts";
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
	/** Rejects with an error whose message starts with `worktree_limit_reached` while the workspace has no room for it. */
	prepare(issue: Issue, config: WorkflowConfig): Promise<Workspace>;
	/** Release issue `number`'s checkout, keeping its branch; a checkout with changes is `kept`, one that fails tried again. */
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

/** The body of a follow-up's issue: the defect, where it is, where it was found, and its fingerprint. */
function followUpBody(followUp: ReviewFollowUp, issue: Issue, pr: PullRequest): string {
	return [
		followUp.body,
		"",
		`Location: \`${location(followUp)}\` (priority P${followUp.priority}).`,
		`Found outside the change while reviewing ${pr.url} for ${issue.identifier}.`,
		"",
		`Follow-up fingerprint: ${followUp.fingerprint}`,
		"",
		"_Volt issue orchestrator_",
	].join("\n");
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
			case "handoff":
				await this.handOff(tracker, config, issue, phase.label, phase.reason, phase.pr);
				return;
			case "merge":
				try {
					await tracker.merge(phase.pr.number, config.merge.method);
					this.log(`#${issue.number}: merged pull request #${phase.pr.number}`);
					this.finish(issue, `merged pull request #${phase.pr.number}`);
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
				const key = `${issue.number}:${phase.kind}:${"pr" in phase ? phase.pr.headSha : "-"}`;
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
		let workspace: Workspace;
		try {
			workspace = await this.options.workspaces.prepare(issue, config);
		} catch (error) {
			// The workspace may be full of checkouts of issues done with that this orchestrator does not know of.
			if (errorText(error).startsWith("worktree_limit_reached")) this.sweepDue = true;
			throw new Error(`setting up the checkout failed: ${errorText(error)}`);
		}
		const findings =
			phase.kind === "fix" && phase.runId !== undefined ? await this.findingsText(phase.runId) : undefined;
		const task = renderTemplate(
			role.prompt,
			this.variables(tracker, config, issue, phase, workspace, attempts, findings),
		);
		if (entry.cancelled) throw new Error("stopped before it started");
		return await this.options.agents.start({ agent: role.agent, task, cwd: workspace.path, limits: role.limits });
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
			ended: run.ended.then((result) => this.concludeReview(tracker, config, issue, phase.pr, run.id, result)),
		};
	}

	/**
	 * Post a complete review to its pull request, ending with the verdict the
	 * next tick reads, then file its follow-ups. An incomplete review gives no
	 * verdict: the run failed, and is tried again.
	 */
	private async concludeReview(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		pr: PullRequest,
		runId: string,
		result: ReviewResult,
	): Promise<AgentResult> {
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
		try {
			await this.options.reviews.publish(runId, {
				trailer: reviewMarker(verdict.headSha, verdict.value, runId),
				command: config.ghCommand,
			});
		} catch (error) {
			// Such as when the pull request moved on since: its new head is reviewed next.
			return { status: "failed", error: `posting the review failed: ${errorText(error)}`, usage };
		}
		this.log(`#${issue.number}: posted the review (${verdict.value}) on pull request #${pr.number}`);
		await this.fileFollowUps(tracker, config, issue, pr, result.followUps);
		return { status: "completed", usage };
	}

	/**
	 * File each follow-up as an issue the workflow works, labeled like the
	 * issues agents file, unless one names its fingerprint already. A follow-up
	 * that fails to file is logged; a later round may report it again.
	 */
	private async fileFollowUps(
		tracker: Tracker,
		config: WorkflowConfig,
		issue: Issue,
		pr: PullRequest,
		followUps: readonly ReviewFollowUp[],
	): Promise<void> {
		for (const followUp of followUps) {
			if (this.filedFollowUps.has(followUp.fingerprint)) continue;
			try {
				// GitHub's search lags a filing: what this run filed is remembered as well.
				if (!(await tracker.mentioned(followUp.fingerprint))) {
					const filed = await tracker.fileIssue({
						title: followUp.title,
						body: followUpBody(followUp, issue, pr),
						labels: [...config.tracker.labels, config.tracker.filedLabel],
					});
					this.log(`#${issue.number}: filed follow-up #${filed.number}: ${filed.url}`);
				}
				this.filedFollowUps.add(followUp.fingerprint);
			} catch (error) {
				this.log(`#${issue.number}: filing the follow-up "${followUp.title}" failed: ${errorText(error)}`);
			}
		}
	}

	/** The open findings of review `runId`, for a fixer's prompt; undefined when there are none to give. */
	private async findingsText(runId: string): Promise<string | undefined> {
		let findings: ReviewFinding[] | undefined;
		try {
			findings = await this.options.reviews.findings(runId);
		} catch (error) {
			this.log(`reading the findings of review ${runId} failed: ${errorText(error)}`);
			return undefined;
		}
		if (findings === undefined || findings.length === 0) return undefined;
		return [
			"The review's open findings:",
			...findings.map((finding) =>
				[
					`- [P${finding.priority}] ${finding.title} (${location(finding)})`,
					...finding.body.split("\n").map((line) => (line.length === 0 ? "" : `  ${line}`)),
				].join("\n"),
			),
		].join("\n");
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
	): Record<string, TemplateValue> {
		const pr = "pr" in phase ? phase.pr : undefined;
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
			tracker: {
				labels: [...config.tracker.labels],
				filed_labels: [...config.tracker.labels, config.tracker.filedLabel],
			},
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
