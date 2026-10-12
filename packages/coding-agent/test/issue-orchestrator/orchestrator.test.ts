/**
 * The orchestrator against an in-memory GitHub, whose agents do what the
 * real ones would: open a pull request, post a review verdict, push a fix.
 * Each test ticks the loop by hand and finishes agent runs explicitly.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type ChecksState,
	type Issue,
	type PullRequest,
	type ReviewMarker,
	reviewMarker,
	type Tracker,
} from "../../examples/extensions/issue-orchestrator/github.ts";
import {
	type AgentResult,
	type Agents,
	Orchestrator,
	type ReleaseOutcome,
	type Workspaces,
} from "../../examples/extensions/issue-orchestrator/orchestrator.ts";
import { decidePhase, issueBranch } from "../../examples/extensions/issue-orchestrator/phase.ts";
import { parseWorkflow, type WorkflowConfig } from "../../examples/extensions/issue-orchestrator/workflow.ts";

const LABEL = "agent-ready";

function workflow(extra = ""): WorkflowConfig {
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
Fix #{{ pr.number }}: {{ reason }} [{{ ci.failing }}]

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
	/** Head commits that merged the base branch in. */
	readonly mergeCommits = new Set<string>();
	labelsExist = true;
	/** How many times the labeled issues were listed: once per tick. */
	listings = 0;
	private commits = 0;

	addIssue(number: number, labels: string[] = [LABEL]): Issue {
		const issue: Issue = {
			number,
			identifier: `o/r#${number}`,
			title: `Issue ${number}`,
			body: `Body ${number}`,
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
		const list = this.verdicts.get(pr.number) ?? [];
		list.push({ headSha: pr.headSha, verdict, createdAt: `t${list.length}` });
		this.verdicts.set(pr.number, list);
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

/**
 * Checkouts in memory: `prepare` fails while `failPrepare` says why, and
 * `release` answers the next queued outcome (`released` by default).
 */
function fakeWorkspaces(): Workspaces & {
	prepared: number[];
	releases: number[];
	failPrepare: string | undefined;
	outcomes: ReleaseOutcome[];
} {
	const workspaces = {
		prepared: [] as number[],
		releases: [] as number[],
		failPrepare: undefined as string | undefined,
		outcomes: [] as ReleaseOutcome[],
		prepare: async (issue: Issue) => {
			if (workspaces.failPrepare !== undefined) throw new Error(workspaces.failPrepare);
			workspaces.prepared.push(issue.number);
			return { path: `/worktrees/issue-${issue.number}`, branch: issueBranch(issue.number) };
		},
		release: async (number: number): Promise<ReleaseOutcome> => {
			workspaces.releases.push(number);
			return workspaces.outcomes.shift() ?? "released";
		},
	};
	return workspaces;
}

const workspaces = fakeWorkspaces();

function setup(config: WorkflowConfig = workflow(), options: { now?: () => number } = {}) {
	const github = new FakeGitHub();
	const agents = fakeAgents();
	const workspaces = fakeWorkspaces();
	const orchestrator = new Orchestrator({
		loadWorkflow: async () => ({ path: "/repo/.volt/WORKFLOW.md", config }),
		tracker: async () => github,
		agents,
		workspaces,
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
	return {
		github,
		agents,
		workspaces,
		orchestrator,
		runs,
		finish,
	};
}

describe("issue orchestrator", () => {
	it("works an issue from implementation through review until clean to merge", async () => {
		const { github, orchestrator, runs, finish } = setup(workflow("merge:\n  mode: auto"));
		github.addIssue(12);

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
		expect(orchestrator.snapshot()).toMatchObject({
			repo: "o/r",
			running: [],
			finished: [{ issue: 12, reason: "merged pull request #112" }],
			totals: { runs: 4, tokens: 40, cost: 2 },
		});
	});

	it("hands an approved, green pull request to a human by default", async () => {
		const { github, orchestrator } = setup();
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
		// Labeled, it is no longer a candidate.
		await orchestrator.tick();
		expect(github.handoffs).toHaveLength(1);
	});

	it("fixes failing checks, waits for running ones, and stops after the review rounds", async () => {
		const { github, orchestrator, runs, finish, agents } = setup(workflow("review:\n  max_rounds: 2"));
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

	it("keeps the last good workflow when a reload breaks, and says why", async () => {
		const github = new FakeGitHub();
		const agents = fakeAgents();
		let broken: Error | undefined = new Error("workflow.tracker.labels must name at least one label");
		const orchestrator = new Orchestrator({
			loadWorkflow: async () => {
				if (broken) throw broken;
				return { path: "/repo/.volt/WORKFLOW.md", config: workflow() };
			},
			tracker: async () => github,
			agents,
			workspaces,
		});
		github.addIssue(12);
		// No good workflow yet: nothing runs.
		await orchestrator.tick();
		expect(orchestrator.snapshot().error).toBe(`Workflow: ${broken.message}`);
		expect(agents.started).toEqual([]);

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
		// A short head in a verdict matches the full head.
		expect(
			decidePhase(config, issue, pr, [{ ...verdict(2, "changes"), headSha: sha(2).slice(0, 12) }], undefined),
		).toMatchObject({ kind: "fix", round: 1 });
	});
});
