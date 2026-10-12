/**
 * The orchestrator against an in-memory GitHub, whose agents do what the
 * real ones would: open a pull request, post a review verdict, push a fix.
 * Its review engine posts what the orchestrator publishes. Each test ticks
 * the loop by hand and finishes agent and review runs explicitly.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type ChecksState,
	type FiledIssue,
	type Issue,
	type PullRequest,
	parseReviewMarkers,
	type ReviewMarker,
	reviewMarker,
	type Tracker,
} from "../../examples/extensions/issue-orchestrator/github.ts";
import {
	type AgentResult,
	type Agents,
	Orchestrator,
	type OrchestratorEvent,
	outOfScopeProblems,
	type ReleaseOutcome,
	type ReviewFinding,
	type ReviewResult,
	type Reviews,
	type Workspaces,
} from "../../examples/extensions/issue-orchestrator/orchestrator.ts";
import { decidePhase, issueBranch } from "../../examples/extensions/issue-orchestrator/phase.ts";
import { parseWorkflow, type WorkflowConfig } from "../../examples/extensions/issue-orchestrator/workflow.ts";

const LABEL = "agent-ready";

function workflow(extra = "", fix = "Fix #{{ pr.number }}: {{ reason }} [{{ ci.failing }}]"): WorkflowConfig {
	return parseWorkflow(`---
tracker:
  repo: o/r
  labels: [${LABEL}]
${extra}
---
## implement
Implement {{ issue.identifier }} in {{ worktree.path }} on {{ worktree.branch }} (attempt {{ attempt }}).

## review
Review #{{ pr.number }} at {{ pr.head_sha }}, round {{ round }}: {{ review.clean_marker }}

## fix
${fix}

## update
Update #{{ pr.number }} from {{ pr.base_ref }}: {{ reason }}
`);
}

function sha(n: number): string {
	return n.toString(16).padStart(40, "0");
}

/** An in-memory GitHub repository. */
class FakeGitHub implements Tracker {
	readonly repo = "o/r";
	readonly issues = new Map<number, Issue>();
	readonly prs = new Map<string, PullRequest>();
	readonly verdicts = new Map<number, ReviewMarker[]>();
	readonly checkStates = new Map<number, ChecksState>();
	readonly merged: number[] = [];
	readonly handoffs: Array<{ issue: number; label: string; comment: string }> = [];
	readonly takenBack: Array<{ issue: number; label: string; comment: string }> = [];
	readonly filed: Array<{ title: string; body: string; labels: readonly string[] }> = [];
	readonly comments: Array<{ issue: number; body: string }> = [];
	/** The bodies of issues filed before the test: search finds text in them, not in the ones filed since. */
	readonly searchable: string[] = [];
	/** Head commits that merged the base branch in. */
	readonly mergeCommits = new Set<string>();
	labelsExist = true;
	/** How many times the labeled issues were listed: once per tick. */
	listings = 0;
	private commits = 0;

	addIssue(number: number, labels: string[] = [LABEL], body = `Body ${number}`): Issue {
		const issue: Issue = {
			number,
			identifier: `o/r#${number}`,
			title: `Issue ${number}`,
			body,
			url: `https://github.com/o/r/issues/${number}`,
			labels,
			open: true,
			createdAt: `2026-10-0${number % 10}T00:00:00Z`,
		};
		this.issues.set(number, issue);
		return issue;
	}

	setLabels(number: number, labels: string[]): void {
		const issue = this.issues.get(number);
		if (issue) this.issues.set(number, { ...issue, labels });
	}

	/**
	 * What an implementer or fixer does: push a commit to the issue's branch,
	 * opening its pull request first. An updater pushes a `merge` of the base
	 * branch, which resolves the conflict.
	 */
	push(number: number, options: { merge?: boolean } = {}): PullRequest {
		const branch = issueBranch(number);
		const existing = this.prs.get(branch);
		this.commits += 1;
		const pr: PullRequest = existing
			? { ...existing, headSha: sha(this.commits), mergeable: "mergeable" }
			: {
					number: 100 + number,
					url: `https://github.com/o/r/pull/${100 + number}`,
					state: "open",
					headSha: sha(this.commits),
					draft: false,
					baseRef: "main",
					mergeable: "mergeable",
				};
		if (options.merge) this.mergeCommits.add(pr.headSha);
		this.prs.set(branch, pr);
		return pr;
	}

	/** What another pull request merging does to this one, or what GitHub says before it knows. */
	setMergeable(number: number, mergeable: PullRequest["mergeable"]): void {
		const branch = issueBranch(number);
		const pr = this.prs.get(branch);
		if (pr) this.prs.set(branch, { ...pr, mergeable });
	}

	/** What a reviewer does: post a verdict on the head commit. */
	review(number: number, verdict: "clean" | "changes"): void {
		const pr = this.prs.get(issueBranch(number));
		if (!pr) throw new Error("no pull request");
		this.post(pr.number, reviewMarker(pr.headSha, verdict));
	}

	/** Post a review of pull request `number` whose body ends with `body`. */
	post(number: number, body: string): void {
		const list = this.verdicts.get(number) ?? [];
		list.push(...parseReviewMarkers(body, `t${list.length}`));
		this.verdicts.set(number, list);
	}

	async candidates(labels: readonly string[]): Promise<Issue[]> {
		this.listings += 1;
		return [...this.issues.values()].filter(
			(issue) => issue.open && labels.every((label) => issue.labels.includes(label)),
		);
	}
	async issue(number: number): Promise<Issue | undefined> {
		return this.issues.get(number);
	}
	async pullRequest(branch: string): Promise<PullRequest | undefined> {
		return this.prs.get(branch);
	}
	async reviews(number: number): Promise<ReviewMarker[]> {
		return this.verdicts.get(number) ?? [];
	}
	async checks(number: number): Promise<ChecksState> {
		return this.checkStates.get(number) ?? { state: "passing" };
	}
	async isMergeCommit(head: string): Promise<boolean> {
		return this.mergeCommits.has(head);
	}
	async merge(number: number): Promise<void> {
		this.merged.push(number);
		for (const [branch, pr] of this.prs) if (pr.number === number) this.prs.set(branch, { ...pr, state: "merged" });
	}
	async handOff(issue: number, label: string, comment: string): Promise<boolean> {
		this.handoffs.push({ issue, label, comment });
		if (!this.labelsExist) return false;
		const current = this.issues.get(issue);
		if (current) this.setLabels(issue, [...current.labels, label]);
		return true;
	}
	async comment(issue: number, body: string): Promise<void> {
		this.comments.push({ issue, body });
	}
	async fileIssue(issue: { title: string; body: string; labels: readonly string[] }): Promise<FiledIssue> {
		this.filed.push(issue);
		const number = 900 + this.filed.length;
		return { number, url: `https://github.com/o/r/issues/${number}` };
	}
	async mentioned(text: string): Promise<boolean> {
		return this.searchable.some((body) => body.includes(text));
	}
	async takeBack(issue: number, label: string, comment: string): Promise<void> {
		this.takenBack.push({ issue, label, comment });
		const current = this.issues.get(issue);
		if (current)
			this.setLabels(
				issue,
				current.labels.filter((existing) => existing !== label),
			);
	}
}

interface StartedRun {
	readonly id: string;
	readonly agent: string;
	readonly task: string;
	readonly cwd: string;
	finish(result?: Partial<AgentResult>): void;
}

/** Agents whose runs the test finishes; a cancelled run ends cancelled. */
function fakeAgents(): Agents & { started: StartedRun[]; cancelled: string[] } {
	const started: StartedRun[] = [];
	const cancelled: string[] = [];
	const finishers = new Map<string, (result: AgentResult) => void>();
	return {
		started,
		cancelled,
		start: async ({ agent, task, cwd }) => {
			const id = `run-${started.length + 1}`;
			const ended = Promise.withResolvers<AgentResult>();
			finishers.set(id, ended.resolve);
			started.push({
				id,
				agent,
				task,
				cwd,
				finish: (result = {}) =>
					ended.resolve({ status: "completed", usage: { tokens: 10, cost: 0.5 }, ...result }),
			});
			return { id, ended: ended.promise };
		},
		cancel: async (id) => {
			cancelled.push(id);
			finishers.get(id)?.({ status: "cancelled", usage: { tokens: 0, cost: 0 } });
		},
	};
}

interface StartedReview {
	readonly id: string;
	readonly pr: number;
	readonly engine: string;
	readonly previousRunId?: string;
	readonly setup?: { command: string; timeoutMs: number };
	finish(result?: Partial<ReviewResult>): void;
}

/**
 * A review engine whose runs the test finishes: publishing posts the review
 * to `github`, unless `failPublish` says why it cannot. A cancelled run ends
 * cancelled.
 */
function fakeReviews(github: FakeGitHub): Reviews & {
	started: StartedReview[];
	cancelled: string[];
	published: Array<{ id: string; trailer: string; command: readonly string[] }>;
	findingsOf: Map<string, ReviewFinding[]>;
	failPublish: string | undefined;
} {
	const finishers = new Map<string, (result: ReviewResult) => void>();
	const reviews = {
		started: [] as StartedReview[],
		cancelled: [] as string[],
		published: [] as Array<{ id: string; trailer: string; command: readonly string[] }>,
		findingsOf: new Map<string, ReviewFinding[]>(),
		failPublish: undefined as string | undefined,
		start: async (options: Omit<StartedReview, "id" | "finish">) => {
			const id = `review-${reviews.started.length + 1}`;
			const ended = Promise.withResolvers<ReviewResult>();
			finishers.set(id, ended.resolve);
			reviews.started.push({
				id,
				...options,
				finish: (result = {}) =>
					ended.resolve({ status: "completed", followUps: [], usage: { tokens: 100, cost: 1 }, ...result }),
			});
			return { id, ended: ended.promise };
		},
		cancel: async (id: string) => {
			reviews.cancelled.push(id);
			finishers.get(id)?.({ status: "cancelled", followUps: [], usage: { tokens: 0, cost: 0 } });
		},
		publish: async (id: string, options: { trailer: string; command: readonly string[] }) => {
			if (reviews.failPublish !== undefined) throw new Error(reviews.failPublish);
			reviews.published.push({ id, ...options });
			const review = reviews.started.find((started) => started.id === id);
			if (review) github.post(review.pr, `Volt review (${id})\n\n${options.trailer}`);
		},
		findings: async (id: string) => reviews.findingsOf.get(id),
	};
	return reviews;
}

/**
 * Checkouts in memory, `held` by the issues that have one: `prepare` fails
 * while `failPrepare` says why, or with `worktree_limit_reached` once
 * `capacity` checkouts are held; `release` throws `failRelease`, else answers
 * the next queued outcome (`released` by default).
 */
function fakeWorkspaces(): Workspaces & {
	prepared: number[];
	releases: number[];
	held: Set<number>;
	capacity: number;
	failPrepare: string | undefined;
	failRelease: string | undefined;
	outcomes: ReleaseOutcome[];
} {
	const workspaces = {
		prepared: [] as number[],
		releases: [] as number[],
		held: new Set<number>(),
		capacity: Number.POSITIVE_INFINITY,
		failPrepare: undefined as string | undefined,
		failRelease: undefined as string | undefined,
		outcomes: [] as ReleaseOutcome[],
		prepare: async (issue: Issue) => {
			if (workspaces.failPrepare !== undefined) throw new Error(workspaces.failPrepare);
			if (!workspaces.held.has(issue.number) && workspaces.held.size >= workspaces.capacity) {
				throw new Error("worktree_limit_reached");
			}
			workspaces.prepared.push(issue.number);
			workspaces.held.add(issue.number);
			return { path: `/worktrees/issue-${issue.number}`, branch: issueBranch(issue.number) };
		},
		release: async (number: number): Promise<ReleaseOutcome> => {
			workspaces.releases.push(number);
			if (workspaces.failRelease !== undefined) throw new Error(workspaces.failRelease);
			const outcome = workspaces.outcomes.shift() ?? "released";
			if (outcome === "released") workspaces.held.delete(number);
			return outcome;
		},
		checkouts: async () => [...workspaces.held],
	};
	return workspaces;
}

const workspaces = fakeWorkspaces();

function setup(config: WorkflowConfig = workflow(), options: { now?: () => number } = {}) {
	const github = new FakeGitHub();
	const agents = fakeAgents();
	const reviews = fakeReviews(github);
	const workspaces = fakeWorkspaces();
	const announced: OrchestratorEvent[] = [];
	const log: string[] = [];
	const orchestrator = new Orchestrator({
		loadWorkflow: async () => ({ path: "/repo/.volt/WORKFLOW.md", config }),
		tracker: async () => github,
		agents,
		reviews,
		workspaces,
		announce: (event) => announced.push(event),
		log: (line) => log.push(line),
		...(options.now === undefined ? {} : { now: options.now }),
	});
	/** Wait until `count` runs started. */
	const runs = async (count: number) => {
		await vi.waitFor(() => expect(agents.started).toHaveLength(count));
		return agents.started[count - 1] as StartedRun;
	};
	/** Finish `run` and wait until the orchestrator saw it end. */
	const finish = async (run: StartedRun, result?: Partial<AgentResult>) => {
		run.finish(result);
		await vi.waitFor(() => expect(orchestrator.snapshot().running.map((entry) => entry.runId)).not.toContain(run.id));
	};
	/** Wait until `count` reviews started. */
	const reviewRuns = async (count: number) => {
		await vi.waitFor(() => expect(reviews.started).toHaveLength(count));
		return reviews.started[count - 1] as StartedReview;
	};
	/** Finish review `run` and wait until the orchestrator posted it and filed its follow-ups. */
	const finishReview = async (run: StartedReview, result?: Partial<ReviewResult>) => {
		run.finish(result);
		await vi.waitFor(() => expect(orchestrator.snapshot().running.map((entry) => entry.runId)).not.toContain(run.id));
	};
	return {
		github,
		agents,
		reviews,
		workspaces,
		announced,
		log,
		orchestrator,
		runs,
		finish,
		reviewRuns,
		finishReview,
	};
}

describe("issue orchestrator", () => {
	it("works an issue from implementation through review until clean to merge", async () => {
		const { github, orchestrator, runs, finish, announced } = setup(workflow("merge:\n  mode: auto"));
		github.addIssue(12);
		const issue12 = { number: 12, title: "Issue 12", url: "https://github.com/o/r/issues/12" };

		await orchestrator.tick();
		const implement = await runs(1);
		expect(implement).toMatchObject({
			agent: "general",
			cwd: "/worktrees/issue-12",
			task: "Implement o/r#12 in /worktrees/issue-12 on volt/issue-12 (attempt ).",
		});
		expect(orchestrator.snapshot().running).toMatchObject([{ issue: 12, role: "implement", runId: "run-1" }]);
		// A running issue is not dispatched again.
		await orchestrator.tick();
		expect(github.prs.size).toBe(0);

		const first = github.push(12);
		await finish(implement);
		await orchestrator.tick();
		const review = await runs(2);
		expect(review.task).toBe(`Review #112 at ${first.headSha}, round 1: ${reviewMarker(first.headSha, "clean")}`);
		// Picked up once, then its pull request, linked; the later agents on it are not announced.
		expect(announced).toEqual([
			{ kind: "picked_up", issue: issue12, role: "implement" },
			{ kind: "pr_opened", issue: issue12, pr: { number: 112, url: "https://github.com/o/r/pull/112" } },
		]);

		github.review(12, "changes");
		await finish(review);
		await orchestrator.tick();
		const fix = await runs(3);
		expect(fix.task).toBe("Fix #112: the review asked for changes []");

		github.push(12);
		await finish(fix);
		await orchestrator.tick();
		const second = await runs(4);
		expect(second.task).toContain("round 2");

		github.review(12, "clean");
		await finish(second);
		await orchestrator.tick();
		expect(github.merged).toEqual([112]);
		expect(announced).toHaveLength(2);
		expect(orchestrator.snapshot()).toMatchObject({
			repo: "o/r",
			running: [],
			finished: [{ issue: 12, reason: "merged pull request #112" }],
			totals: { runs: 4, tokens: 40, cost: 2 },
		});
	});

	it("hands an approved, green pull request to a human by default", async () => {
		const { github, orchestrator, announced } = setup();
		github.addIssue(12);
		github.push(12);
		github.review(12, "clean");

		await orchestrator.tick();
		expect(github.merged).toEqual([]);
		expect(github.handoffs).toEqual([
			{
				issue: 12,
				label: "agent-approved",
				comment: expect.stringContaining("ready for a human to merge"),
			},
		]);
		expect(orchestrator.snapshot().handedOff).toMatchObject([{ issue: 12, ready: true }]);
		// Found approved: no agent ran, so only the handoff is announced, with its pull request.
		expect(announced).toEqual([
			{
				kind: "handed_off",
				issue: { number: 12, title: "Issue 12", url: "https://github.com/o/r/issues/12" },
				ready: true,
				reason: expect.stringContaining("ready for a human to merge"),
				pr: { number: 112, url: "https://github.com/o/r/pull/112" },
			},
		]);
		// Labeled, it is no longer a candidate.
		await orchestrator.tick();
		expect(github.handoffs).toHaveLength(1);
	});

	it("fixes failing checks, waits for running ones, and stops after the review rounds", async () => {
		const { github, orchestrator, runs, finish, agents, announced } = setup(workflow("review:\n  max_rounds: 2"));
		github.addIssue(12);
		const pr = github.push(12);
		github.review(12, "clean");
		github.checkStates.set(pr.number, { state: "pending" });

		await orchestrator.tick();
		expect(orchestrator.snapshot().waiting).toEqual([
			{ issue: 12, title: "Issue 12", reason: "CI checks are running" },
		]);
		expect(agents.started).toHaveLength(0);

		github.checkStates.set(pr.number, { state: "failing", failing: ["test", "lint"] });
		await orchestrator.tick();
		const fix = await runs(1);
		expect(fix.task).toBe("Fix #112: CI checks failing: test, lint [test, lint]");
		github.push(12);
		await finish(fix);

		github.review(12, "changes");
		await orchestrator.tick();
		// Two heads reviewed: the second fix is a round too many.
		expect(agents.started).toHaveLength(1);
		expect(github.handoffs).toEqual([
			{
				issue: 12,
				label: "agent-needs-human",
				comment: expect.stringContaining("did not converge after 2 review rounds"),
			},
		]);
		expect(orchestrator.snapshot().handedOff).toMatchObject([{ issue: 12, ready: false }]);
		expect(announced.at(-1)).toMatchObject({ kind: "handed_off", ready: false, pr: { number: 112 } });
	});

	it("respects the concurrency limits, oldest issue first", async () => {
		const { github, orchestrator, runs } = setup(
			workflow("agent:\n  max_concurrent: 2\nroles:\n  implement:\n    max_concurrent: 1"),
		);
		github.addIssue(3);
		github.addIssue(2);
		const pr = github.push(1);
		github.addIssue(1);
		expect(pr.number).toBe(101);

		await orchestrator.tick();
		await runs(2);
		expect(orchestrator.snapshot().running.map((entry) => [entry.issue, entry.role])).toEqual([
			[1, "review"],
			[2, "implement"],
		]);
		expect(orchestrator.snapshot().waiting).toEqual([
			{ issue: 3, title: "Issue 3", reason: "waiting for a free agent slot" },
		]);
	});

	it("stops the run of an issue that left the workflow, without retrying it", async () => {
		const { github, agents, orchestrator, runs } = setup();
		github.addIssue(12);
		await orchestrator.tick();
		const run = await runs(1);

		github.setLabels(12, []);
		await orchestrator.tick();
		expect(agents.cancelled).toEqual([run.id]);
		await vi.waitFor(() => expect(orchestrator.snapshot().running).toEqual([]));
		expect(orchestrator.snapshot().retrying).toEqual([]);
	});

	it("retries a failed run with backoff, then hands the issue off after its attempts", async () => {
		let now = 1_000_000;
		const { github, orchestrator, runs, finish } = setup(workflow("agent:\n  max_attempts: 2"), { now: () => now });
		github.addIssue(12);

		await orchestrator.tick();
		await finish(await runs(1), { status: "failed", error: "provider overloaded" });
		expect(orchestrator.snapshot().retrying).toEqual([
			{ issue: 12, title: "Issue 12", failures: 1, dueAt: now + 10_000, error: "provider overloaded" },
		]);
		// Not before it is due.
		await orchestrator.tick();
		expect(orchestrator.snapshot().running).toEqual([]);

		now += 10_000;
		await orchestrator.tick();
		const second = await runs(2);
		expect(second.task).toContain("(attempt 2)");
		// A run that completes without opening a pull request counts as an attempt too.
		await finish(second);
		await orchestrator.tick();
		expect(github.handoffs).toEqual([
			{ issue: 12, label: "agent-needs-human", comment: expect.stringContaining("ran 2 times without moving") },
		]);
	});

	it("runs its loop until stopped, without spinning on a retry it no longer needs", async () => {
		let now = 1_000_000;
		const { github, agents, orchestrator, runs, finish } = setup(workflow("agent:\n  max_attempts: 1"), {
			now: () => now,
		});
		github.addIssue(12);
		const stop = new AbortController();
		const loop = orchestrator.run(stop.signal);

		await finish(await runs(1), { status: "failed", error: "no model" });
		// The retry comes due; its attempts are spent, so the issue goes to a human and the retry with it.
		now += 10_000;
		orchestrator.wake();
		await vi.waitFor(() => expect(github.handoffs).toHaveLength(1));
		expect(orchestrator.snapshot().retrying).toEqual([]);
		const listings = github.listings;
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(github.listings - listings).toBeLessThanOrEqual(1);

		// Stopping cancels what runs and ends the loop.
		github.addIssue(13);
		orchestrator.wake();
		const running = await runs(2);
		stop.abort();
		await loop;
		expect(agents.cancelled).toEqual([running.id]);
		expect(orchestrator.snapshot().running).toEqual([]);
	});

	it("releases the checkout of an issue it handed off, once nothing holds it", async () => {
		const { github, workspaces, orchestrator } = setup();
		github.addIssue(12);
		github.push(12);
		github.review(12, "clean");
		workspaces.outcomes.push("retry");

		// Approved: handed to a human, its checkout released on the next tick (held once, so tried again).
		await orchestrator.tick();
		expect(github.handoffs).toMatchObject([{ issue: 12, label: "agent-approved" }]);
		await orchestrator.tick();
		await orchestrator.tick();
		expect(workspaces.releases).toEqual([12, 12]);
		await orchestrator.tick();
		expect(workspaces.releases).toEqual([12, 12]);
	});

	it("keeps a checkout the release refuses, and retries a checkout it cannot set up without handing the issue off", async () => {
		let now = 1_000_000;
		const { github, workspaces, orchestrator, agents, runs } = setup(workflow("agent:\n  max_attempts: 1"), {
			now: () => now,
		});
		github.addIssue(12);
		workspaces.failPrepare = "worktree_limit_reached";

		for (let round = 0; round < 3; round += 1) {
			await orchestrator.tick();
			await vi.waitFor(() => expect(orchestrator.snapshot().retrying).toHaveLength(1));
			now += 400_000;
		}
		expect(orchestrator.snapshot().retrying).toEqual([
			expect.objectContaining({
				issue: 12,
				failures: 3,
				error: "setting up the checkout failed: worktree_limit_reached",
			}),
		]);
		expect(github.handoffs).toEqual([]);
		expect(agents.started).toEqual([]);

		// Once there is room, the agent runs; only it counts as the phase's attempt.
		workspaces.failPrepare = undefined;
		await orchestrator.tick();
		const run = await runs(1);
		run.finish();
		await vi.waitFor(() => expect(orchestrator.snapshot().running).toEqual([]));
		workspaces.outcomes.push("kept");
		await orchestrator.tick();
		expect(github.handoffs).toEqual([
			{ issue: 12, label: "agent-needs-human", comment: expect.stringContaining("ran 1 times without moving") },
		]);
		await orchestrator.tick();
		await orchestrator.tick();
		// Kept (a checkout with changes stays for the human): not tried again.
		expect(workspaces.releases).toEqual([12]);
	});

	it("works an issue again once a human removes its handoff label", async () => {
		const { github, orchestrator, runs } = setup(workflow("agent:\n  max_attempts: 1"));
		github.addIssue(12);
		await orchestrator.tick();
		const first = await runs(1);
		first.finish();
		await vi.waitFor(() => expect(orchestrator.snapshot().running).toEqual([]));
		await orchestrator.tick();
		expect(github.handoffs).toHaveLength(1);
		expect(github.issues.get(12)?.labels).toEqual([LABEL, "agent-needs-human"]);

		github.setLabels(12, [LABEL]);
		await orchestrator.tick();
		await runs(2);
	});

	it("updates a conflicting pull request before reviewing it again, without spending a review round on the merge", async () => {
		const { github, orchestrator, runs, finish, agents } = setup(workflow("review:\n  max_rounds: 2"));
		github.addIssue(12);
		github.push(12);
		github.review(12, "changes");
		github.setMergeable(12, "conflicting");

		await orchestrator.tick();
		const update = await runs(1);
		expect(update.task).toBe("Update #112 from main: pull request #112 conflicts with main");

		const merge = github.push(12, { merge: true });
		await finish(update);
		await orchestrator.tick();
		const review = await runs(2);
		expect(review.task).toContain(`at ${merge.headSha}`);

		// Two heads reviewed, but one only merged main in: a fix is still within the two rounds.
		github.review(12, "changes");
		await finish(review);
		await orchestrator.tick();
		const fix = await runs(3);
		expect(fix.task).toBe("Fix #112: the review asked for changes []");
		expect(github.handoffs).toEqual([]);
		expect(agents.started.map((run) => run.cwd)).toEqual(Array(3).fill("/worktrees/issue-12"));
	});

	it("does not call a pull request ready before GitHub knows it merges cleanly", async () => {
		const { github, orchestrator } = setup();
		github.addIssue(12);
		github.push(12);
		github.review(12, "clean");
		github.setMergeable(12, "unknown");

		await orchestrator.tick();
		expect(github.handoffs).toEqual([]);
		expect(orchestrator.snapshot().waiting).toEqual([
			{ issue: 12, title: "Issue 12", reason: "GitHub is still checking whether pull request #112 merges cleanly" },
		]);
		github.setMergeable(12, "mergeable");
		await orchestrator.tick();
		expect(github.handoffs).toMatchObject([{ issue: 12, label: "agent-approved" }]);
	});

	it("takes an approval back once the pull request conflicts, and updates it", async () => {
		const { github, orchestrator, runs, agents } = setup();
		github.addIssue(12);
		github.push(12);
		github.review(12, "clean");
		await orchestrator.tick();
		expect(github.issues.get(12)?.labels).toEqual([LABEL, "agent-approved"]);

		// Still mergeable: left alone.
		await orchestrator.tick();
		expect(github.takenBack).toEqual([]);
		expect(agents.started).toEqual([]);

		// Another pull request merged.
		github.setMergeable(12, "conflicting");
		await orchestrator.tick();
		expect(github.takenBack).toEqual([
			{
				issue: 12,
				label: "agent-approved",
				comment: expect.stringContaining(
					"Pull request #112 now conflicts with main, so it is no longer ready to merge.",
				),
			},
		]);
		expect(github.issues.get(12)?.labels).toEqual([LABEL]);
		const update = await runs(1);
		expect(update.task).toBe("Update #112 from main: pull request #112 conflicts with main");

		// An issue handed to a human as well stays theirs.
		github.addIssue(13, [LABEL, "agent-approved", "agent-needs-human"]);
		github.push(13);
		github.setMergeable(13, "conflicting");
		await orchestrator.tick();
		expect(github.takenBack.map((entry) => entry.issue)).toEqual([12]);
	});

	it("releases the checkout of an issue that leaves the workflow, such as one an update closed as superseded", async () => {
		const { github, orchestrator, runs, finish, workspaces } = setup(
			parseWorkflow(`---\ntracker:\n  repo: o/r\n  labels: [${LABEL}]\n---\n`),
		);
		github.addIssue(12);
		github.push(12);
		github.setMergeable(12, "conflicting");

		await orchestrator.tick();
		const update = await runs(1);
		// The built-in prompt merges the base branch, and closes what it already has.
		expect(update.task).toContain("git merge origin/main");
		expect(update.task).toContain("If main already has the pull request's change");

		github.prs.set(issueBranch(12), { ...(github.prs.get(issueBranch(12)) as PullRequest), state: "closed" });
		github.issues.set(12, { ...(github.issues.get(12) as Issue), open: false });
		await finish(update);
		await orchestrator.tick();
		expect(workspaces.releases).toEqual([]);
		await orchestrator.tick();
		expect(workspaces.releases).toEqual([12]);
		// Once.
		await orchestrator.tick();
		expect(workspaces.releases).toEqual([12]);
	});

	it("tries a release that fails again on later ticks, saying why once", async () => {
		const { github, workspaces, orchestrator, log } = setup();
		github.addIssue(12);
		github.push(12);
		github.review(12, "clean");
		workspaces.held.add(12);
		workspaces.failRelease = "git_failed: worktree recovery quota of 32 checkouts is full";

		// Approved: handed to a human, then its checkout released, which fails until the daemon has room.
		await orchestrator.tick();
		await orchestrator.tick();
		await orchestrator.tick();
		expect(workspaces.releases).toEqual([12, 12]);
		expect(log.filter((line) => line.includes("releasing the checkout failed"))).toEqual([
			"#12: releasing the checkout failed, trying again: git_failed: worktree recovery quota of 32 checkouts is full",
		]);

		workspaces.failRelease = undefined;
		await orchestrator.tick();
		expect(workspaces.held).toEqual(new Set());
		expect(log.at(-1)).toBe("#12 (Issue 12): released its checkout");
		await orchestrator.tick();
		expect(workspaces.releases).toEqual([12, 12, 12]);
	});

	it("releases, when it starts, the checkouts of issues an earlier run was done with", async () => {
		const { github, workspaces, orchestrator, log } = setup();
		// An earlier run left checkouts of an approved issue, one handed off, a closed one, one taken out of
		// the workflow, one GitHub no longer has, and one still worked.
		github.addIssue(11, [LABEL, "agent-approved"]);
		github.addIssue(12, [LABEL, "agent-needs-human"]);
		github.addIssue(13);
		github.issues.set(13, { ...(github.issues.get(13) as Issue), open: false });
		github.addIssue(14, []);
		github.addIssue(15);
		for (const number of [11, 12, 13, 14, 16, 15]) workspaces.held.add(number);

		await orchestrator.tick();
		expect(workspaces.releases).toEqual([11, 12, 13, 14, 16]);
		expect(workspaces.held).toEqual(new Set([15]));
		expect(log).toContain("#11 (Issue 11): released its checkout");
		expect(log).toContain("#16: released its checkout");
		// Once.
		await orchestrator.tick();
		expect(workspaces.releases).toEqual([11, 12, 13, 14, 16]);
	});

	it("looks for checkouts to release once the workspace is full", async () => {
		let now = 1_000_000;
		const { github, workspaces, orchestrator, runs } = setup(workflow(), { now: () => now });
		// An earlier run's checkout of an issue whose checks still run when this one starts: it stays.
		github.addIssue(11);
		const pr = github.push(11);
		github.review(11, "clean");
		github.checkStates.set(pr.number, { state: "pending" });
		workspaces.held.add(11);
		workspaces.capacity = 1;
		await orchestrator.tick();
		expect(workspaces.releases).toEqual([]);

		// A human closes it, which an orchestrator that started no agent on it does not notice, and the
		// next issue finds the workspace full.
		github.issues.set(11, { ...(github.issues.get(11) as Issue), open: false });
		github.addIssue(12);
		await orchestrator.tick();
		await vi.waitFor(() =>
			expect(orchestrator.snapshot().retrying).toMatchObject([
				{ issue: 12, error: "setting up the checkout failed: worktree_limit_reached" },
			]),
		);
		expect(workspaces.releases).toEqual([]);

		// The next tick looks, and frees the room the retry needs.
		await orchestrator.tick();
		expect(workspaces.releases).toEqual([11]);
		now += 10_000;
		await orchestrator.tick();
		await runs(1);
		expect(workspaces.prepared).toEqual([12]);
	});

	it("keeps the last good workflow when a reload breaks, and says why", async () => {
		const github = new FakeGitHub();
		const agents = fakeAgents();
		const log: string[] = [];
		let broken: Error | undefined = new Error("workflow.tracker.labels must name at least one label");
		const orchestrator = new Orchestrator({
			loadWorkflow: async () => {
				if (broken) throw broken;
				return { path: "/repo/.volt/WORKFLOW.md", config: workflow() };
			},
			tracker: async () => github,
			agents,
			reviews: fakeReviews(github),
			workspaces,
			log: (line) => log.push(line),
		});
		github.addIssue(12);
		// No good workflow yet: nothing runs.
		await orchestrator.tick();
		expect(orchestrator.snapshot().error).toBe(`Workflow: ${broken.message}`);
		expect(agents.started).toEqual([]);
		// Logged once, not on every tick it lasts.
		await orchestrator.tick();
		expect(log).toEqual([`Workflow: ${broken.message}`]);

		broken = undefined;
		await orchestrator.tick();
		expect(orchestrator.snapshot().error).toBeUndefined();
		github.addIssue(13);
		broken = new Error("workflow.agent.max_concurrent must be a number of at least 1");
		await orchestrator.tick();
		expect(orchestrator.snapshot().error).toBe(`Workflow: ${broken.message}`);
		await vi.waitFor(() =>
			expect(agents.started.map((run) => run.cwd)).toEqual(["/worktrees/issue-12", "/worktrees/issue-13"]),
		);
	});

	it("reviews on a review engine: posts each verdict, follows the previous round, gives the fixer the findings, and files follow-ups once", async () => {
		const config = workflow(
			"review:\n  engine: standard\nworkspace:\n  hooks:\n    after_create: npm ci",
			"Fix #{{ pr.number }}:\n{{ review.findings }}",
		);
		const { github, orchestrator, reviews, workspaces, runs, finish, reviewRuns, finishReview, log } = setup(config);
		github.addIssue(12);
		const first = github.push(12);
		// An issue filed for this follow-up before.
		github.searchable.push("...\n\nFollow-up fingerprint: fp-known");

		await orchestrator.tick();
		const review = await reviewRuns(1);
		expect(review).toEqual({
			id: "review-1",
			pr: 112,
			engine: "standard",
			setup: { command: "npm ci", timeoutMs: 600_000 },
			finish: expect.any(Function),
		});
		// The host reviews in a checkout of its own: the issue's is not set up for it.
		expect(workspaces.prepared).toEqual([]);
		expect(orchestrator.snapshot().running).toMatchObject([{ issue: 12, role: "review", runId: "review-1" }]);

		reviews.findingsOf.set("review-1", [
			{
				title: "Off by one",
				body: "The loop skips\nthe last item.",
				priority: 1,
				path: "src/a.ts",
				startLine: 3,
				endLine: 4,
			},
		]);
		const followUp = {
			title: "Stale cache",
			body: "Never invalidated.",
			priority: 2,
			path: "src/cache.ts",
			startLine: 9,
			endLine: 9,
		};
		await finishReview(review, {
			verdict: { value: "changes", headSha: first.headSha },
			followUps: [
				{ ...followUp, fingerprint: "fp-1" },
				{ ...followUp, title: "Filed before", fingerprint: "fp-known" },
			],
		});
		expect(reviews.published).toEqual([
			{ id: "review-1", trailer: reviewMarker(first.headSha, "changes", "review-1"), command: ["gh"] },
		]);
		expect(github.filed).toEqual([
			{
				title: "Stale cache",
				labels: ["agent-ready", "agent-filed"],
				body: [
					"Never invalidated.",
					"",
					"Location: `src/cache.ts:9` (priority P2).",
					"Found outside the change while reviewing https://github.com/o/r/pull/112 for o/r#12.",
					"",
					"Follow-up fingerprint: fp-1",
					"",
					"_Volt issue orchestrator_",
				].join("\n"),
			},
		]);
		expect(log).toContain("#12: posted the review (changes) on pull request #112");
		expect(log).toContain("#12: filed follow-up #901: https://github.com/o/r/issues/901");

		// The fixer gets the findings, inline ones included, which the pull request's comments leave out.
		await orchestrator.tick();
		const fix = await runs(1);
		expect(fix.task).toBe(
			"Fix #112:\nThe review's open findings:\n- [P1] Off by one (src/a.ts:3-4)\n  The loop skips\n  the last item.",
		);

		const second = github.push(12);
		await finish(fix);
		await orchestrator.tick();
		const again = await reviewRuns(2);
		expect(again).toMatchObject({ pr: 112, previousRunId: "review-1" });
		// Reported again, and not found by search yet: filed once all the same.
		await finishReview(again, {
			verdict: { value: "clean", headSha: second.headSha },
			followUps: [{ ...followUp, fingerprint: "fp-1" }],
		});
		expect(github.filed).toHaveLength(1);

		await orchestrator.tick();
		expect(github.handoffs).toMatchObject([{ issue: 12, label: "agent-approved" }]);
		expect(orchestrator.snapshot().totals).toEqual({ runs: 3, tokens: 210, cost: 2.5 });
	});

	it("records each follow-up once where it is worked: on an open issue at its code, else as an issue of its own", async () => {
		const { github, orchestrator, reviewRuns, finishReview, log } = setup(workflow("review:\n  engine: standard"));
		// The issue under review names its own code; another open issue the workflow works names the cache's.
		github.addIssue(12, [LABEL], "Location: `src/own.ts:5`");
		github.addIssue(20, [LABEL], "The cache is never invalidated (cache.ts:8-10).");
		const pr = github.push(12);
		github.searchable.push("Follow-up fingerprint: fp-recorded");

		await orchestrator.tick();
		const followUp = (fingerprint: string, path: string, line: number) => ({
			fingerprint,
			title: `Defect ${fingerprint}`,
			body: `Details of ${fingerprint}.`,
			priority: 2,
			path,
			startLine: line,
			endLine: line,
		});
		await finishReview(await reviewRuns(1), {
			verdict: { value: "clean", headSha: pr.headSha },
			followUps: [
				// Within three lines of #20's site, in the same file, which #20 names by its base name.
				followUp("fp-cache", "src/cache.ts", 11),
				// At the code only the issue under review names: its pull request would close what it is told.
				followUp("fp-own", "src/own.ts", 5),
				// Next to the one just filed.
				followUp("fp-own-next", "src/own.ts", 7),
				followUp("fp-recorded", "src/other.ts", 1),
			],
		});
		expect(github.filed.map((issue) => issue.title)).toEqual(["Defect fp-own"]);
		expect(github.filed[0]?.body).toContain("Location: `src/own.ts:5` (priority P2).");
		expect(github.comments).toEqual([
			{ issue: 20, body: expect.stringContaining("**Defect fp-cache**\n\nDetails of fp-cache.") },
			{ issue: 901, body: expect.stringContaining("Location: `src/own.ts:7` (priority P2).") },
		]);
		expect(github.comments[0]?.body).toMatch(
			/^Another defect at this issue's code\. Found outside the change while reviewing https:\/\/github\.com\/o\/r\/pull\/112 for o\/r#12\./,
		);
		expect(log).toContain("#12: added the follow-up at src/cache.ts:11 to #20");
	});

	it("records the problems an agent reports outside its work through the same check, and logs a report it cannot read", async () => {
		const { github, agents, orchestrator, runs, finish, log } = setup();
		github.addIssue(12);
		github.addIssue(20, [LABEL], "Location: `src/cache.ts:8`");

		// Both issues get an implementer; #12's reports what it found outside its issue.
		await orchestrator.tick();
		await runs(2);
		const implement = agents.started.find((run) => run.task.includes("o/r#12"));
		if (!implement) throw new Error("Expected #12's implementer");
		const problem = (title: string, path: string, line: number) => ({
			title,
			body: `${title}, in detail.`,
			path,
			startLine: line,
			priority: 1,
		});
		await finish(implement, {
			output: [
				"Opened the pull request.",
				"<out-of-scope>",
				JSON.stringify([
					problem("Cache keeps stale entries", "src/cache.ts", 10),
					problem("Docs name a removed flag", "docs/usage.md", 40),
					{ title: "No location" },
				]),
				"</out-of-scope>",
			].join("\n"),
		});
		expect(github.comments).toEqual([{ issue: 20, body: expect.stringContaining("**Cache keeps stale entries**") }]);
		expect(github.filed).toEqual([
			{
				title: "Docs name a removed flag",
				labels: [LABEL, "agent-filed"],
				body: expect.stringContaining(
					"Location: `docs/usage.md:40` (priority P1).\nFound outside the issue's scope while working on o/r#12.",
				),
			},
		]);
		expect(log).toContain(
			"#12: the implement agent's report: problem 3 needs a title, body, repository-relative path, lines, and a priority 0-3",
		);
	});

	it("reads an agent's report of problems outside its work from its last block", () => {
		const item = { title: "Stale cache", body: "Never invalidated.", path: "src/cache.ts", startLine: 3 };
		expect(outOfScopeProblems("Done, nothing else.")).toEqual({ problems: [], errors: [] });
		// The last block counts, fenced or not; a missing end line and priority take their defaults.
		const fenced = outOfScopeProblems(
			`<out-of-scope>[]</out-of-scope>\n<out-of-scope>\n\`\`\`json\n${JSON.stringify([item])}\n\`\`\`\n</out-of-scope>`,
		);
		expect(fenced.problems).toEqual([
			{ ...item, endLine: 3, priority: 2, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
		]);
		// The fingerprint names the file and title, so the same report twice is one problem.
		expect(
			outOfScopeProblems(`<out-of-scope>${JSON.stringify([{ ...item, body: "Reworded." }])}</out-of-scope>`)
				.problems[0]?.fingerprint,
		).toBe(fenced.problems[0]?.fingerprint);
		expect(outOfScopeProblems("<out-of-scope>not json</out-of-scope>").errors).toEqual([
			"the <out-of-scope> block is not JSON",
		]);
		expect(outOfScopeProblems('<out-of-scope>{"title": "x"}</out-of-scope>').errors).toEqual([
			"the <out-of-scope> block is not a JSON array",
		]);
		const bad = outOfScopeProblems(
			`<out-of-scope>${JSON.stringify([
				{ ...item, path: "/etc/passwd" },
				{ ...item, path: "../outside.ts" },
				{ ...item, startLine: 5, endLine: 2 },
				{ ...item, priority: 7 },
			])}</out-of-scope>`,
		);
		expect(bad.problems).toEqual([]);
		expect(bad.errors).toHaveLength(4);
		const many = outOfScopeProblems(
			`<out-of-scope>${JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ ...item, title: `Problem ${index}` })))}</out-of-scope>`,
		);
		expect(many.problems).toHaveLength(10);
		expect(many.errors).toEqual(["only the first 10 problems were taken"]);
	});

	it("tries an engine review again when it is incomplete or cannot be posted, and cancels one whose issue left", async () => {
		let now = 1_000_000;
		const { github, orchestrator, reviews, reviewRuns, finishReview } = setup(
			workflow("review:\n  engine: ext:swarm-review/swarm"),
			{ now: () => now },
		);
		github.addIssue(12);
		const pr = github.push(12);

		await orchestrator.tick();
		const first = await reviewRuns(1);
		// Nothing to set up without the workflow's hook.
		expect(first).toEqual({
			id: "review-1",
			pr: 112,
			engine: "ext:swarm-review/swarm",
			finish: expect.any(Function),
		});
		await finishReview(first, { error: "a prior finding remains uncertain" });
		expect(reviews.published).toEqual([]);
		expect(orchestrator.snapshot().retrying).toMatchObject([
			{ issue: 12, failures: 1, error: "the review is incomplete: a prior finding remains uncertain" },
		]);

		now += 10_000;
		reviews.failPublish = "The pull request head changed since the review";
		await orchestrator.tick();
		await finishReview(await reviewRuns(2), { verdict: { value: "clean", headSha: pr.headSha } });
		expect(orchestrator.snapshot().retrying).toMatchObject([
			{ issue: 12, failures: 2, error: "posting the review failed: The pull request head changed since the review" },
		]);
		expect(github.verdicts.get(112)).toBeUndefined();

		now += 20_000;
		await orchestrator.tick();
		const third = await reviewRuns(3);
		github.setLabels(12, []);
		await orchestrator.tick();
		expect(reviews.cancelled).toEqual([third.id]);
		await vi.waitFor(() => expect(orchestrator.snapshot().running).toEqual([]));
		expect(orchestrator.snapshot().retrying).toEqual([]);
	});

	it("decides phases from GitHub alone", () => {
		const config = workflow("merge:\n  mode: auto");
		const issue = new FakeGitHub().addIssue(12);
		const pr: PullRequest = {
			number: 7,
			url: "u",
			state: "open",
			headSha: sha(2),
			draft: false,
			baseRef: "main",
			mergeable: "mergeable",
		};
		const verdict = (head: number, value: "clean" | "changes"): ReviewMarker => ({
			headSha: sha(head),
			verdict: value,
			createdAt: String(head),
		});
		expect(decidePhase(config, { ...issue, open: false }, pr, [], undefined)).toMatchObject({ kind: "done" });
		expect(decidePhase(config, issue, undefined, [], undefined)).toEqual({ kind: "implement" });
		expect(decidePhase(config, issue, { ...pr, state: "merged" }, [], undefined)).toMatchObject({ kind: "done" });
		expect(decidePhase(config, issue, { ...pr, state: "closed" }, [], undefined)).toMatchObject({ kind: "wait" });
		expect(decidePhase(config, issue, pr, [verdict(1, "changes")], undefined)).toEqual({
			kind: "review",
			pr,
			round: 2,
		});
		expect(decidePhase(config, issue, pr, [verdict(2, "clean")], { state: "passing" })).toEqual({
			kind: "merge",
			pr,
		});
		expect(
			decidePhase(config, issue, { ...pr, draft: true }, [verdict(2, "clean")], { state: "passing" }),
		).toMatchObject({
			kind: "handoff",
			reason: "Pull request #7 is a draft.",
		});
		expect(decidePhase(config, issue, pr, [verdict(2, "clean")], { state: "none" })).toMatchObject({
			kind: "handoff",
			reason: "Pull request #7 was approved, but no CI checks ran on it.",
		});
		// A conflict comes first; a review of a head that merged the base in is not a round.
		expect(decidePhase(config, issue, { ...pr, mergeable: "conflicting" }, [verdict(2, "clean")], undefined)).toEqual(
			{
				kind: "update",
				pr: { ...pr, mergeable: "conflicting" },
				reason: "pull request #7 conflicts with main",
			},
		);
		expect(decidePhase(config, issue, pr, [verdict(1, "changes"), verdict(2, "changes")], undefined)).toMatchObject({
			kind: "fix",
			round: 2,
		});
		expect(
			decidePhase(config, issue, pr, [verdict(1, "changes"), verdict(2, "changes")], undefined, new Set([sha(2)])),
		).toMatchObject({ kind: "fix", round: 1 });
		// Approved and green, but GitHub has yet to say it merges cleanly.
		expect(
			decidePhase(config, issue, { ...pr, mergeable: "unknown" }, [verdict(2, "clean")], { state: "passing" }),
		).toEqual({ kind: "wait", reason: "GitHub is still checking whether pull request #7 merges cleanly" });
		// A review follows the latest round a review engine gave; a fix gets the review that asked for it.
		expect(
			decidePhase(
				config,
				issue,
				pr,
				[{ ...verdict(0, "changes"), runId: "review-1" }, verdict(1, "changes")],
				undefined,
			),
		).toEqual({ kind: "review", pr, round: 3, previousRunId: "review-1" });
		expect(decidePhase(config, issue, pr, [{ ...verdict(2, "changes"), runId: "review-2" }], undefined)).toEqual({
			kind: "fix",
			pr,
			round: 1,
			reason: "the review asked for changes",
			failing: [],
			runId: "review-2",
		});
		// A short head in a verdict matches the full head.
		expect(
			decidePhase(config, issue, pr, [{ ...verdict(2, "changes"), headSha: sha(2).slice(0, 12) }], undefined),
		).toMatchObject({ kind: "fix", round: 1 });
	});
});
