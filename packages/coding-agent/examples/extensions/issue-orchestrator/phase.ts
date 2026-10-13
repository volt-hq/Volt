/**
 * What an issue needs next, read from GitHub alone, so a restarted
 * orchestrator picks up where the last one stopped:
 *
 * - no pull request from the issue's branch: `implement`. The branch is the
 *   issue's own, or the latest restart's once a triage restarted the issue;
 * - an open one that conflicts with its base branch: `update`, before
 *   anything else, since every review and check of it would be redone;
 * - a triage's decision on the head commit: carry out a `restart`, or hand
 *   the issue to a human;
 * - an open one whose head commit has no review verdict: `review`;
 * - a verdict of changes, or failing checks after a clean one: `fix`, until
 *   the pull request has had `review.max_rounds` reviews, or a fix introduced
 *   new defects (`regressed`); then `triage`, which decides whether it
 *   continues, restarts, or goes to a human, while `triage.max_runs` allows,
 *   else a human. The review of a head that only merged the base branch in is
 *   not a round: the base moving is not the pull request's fault;
 * - before a review or a fix, a base branch that changed files the pull
 *   request changes too: `update`, so both see the code as it is now;
 * - a clean verdict with green checks: `merge` (or a human, in handoff mode),
 *   once GitHub says it merges cleanly;
 * - checks still running, mergeability not known yet, or a pull request
 *   closed without merging: wait;
 * - a merged pull request or a closed issue: done.
 *
 * A review engine's verdict names its run: the next review follows the
 * latest such run, and a fix for changes it asked for gets its findings.
 */

import type { ChecksState, Issue, PullRequest, ReviewMarker, Tracker, TriageMarker } from "./github.ts";
import type { WorkflowConfig } from "./workflow.ts";

/** An implementation that starts over from the base branch, after a triage closed the previous pull request. */
export interface Restart {
	/** Which implementation of the issue this is: 2 for the first restart. */
	readonly count: number;
	/** The pull request the restart closed. */
	readonly previousPr: number;
	/** Why, and how the next implementation should go about it, as the restart comment says. */
	readonly guidance: string;
}

/** The pre-existing findings a clean verdict did not block on, for the human the pull request goes to. */
export interface Waived {
	readonly count: number;
	/** The review engine's run that found them. */
	readonly runId?: string;
}

export type Phase =
	| { readonly kind: "implement"; readonly branch: string; readonly restart?: Restart }
	| { readonly kind: "update"; readonly pr: PullRequest; readonly reason: string }
	| {
			readonly kind: "review";
			readonly pr: PullRequest;
			readonly round: number;
			/** The review engine's run of the latest round with one, which this review follows. */
			readonly previousRunId?: string;
			/** The head commit that run reviewed: what the fix since changed is the diff from it. */
			readonly previousHeadSha?: string;
	  }
	| {
			readonly kind: "fix";
			readonly pr: PullRequest;
			readonly round: number;
			readonly reason: string;
			readonly failing: readonly string[];
			/** The review engine's run that asked for the changes. */
			readonly runId?: string;
	  }
	| {
			readonly kind: "triage";
			readonly pr: PullRequest;
			readonly round: number;
			/** Why the pull request is not converging. */
			readonly reason: string;
	  }
	| { readonly kind: "restart"; readonly pr: PullRequest; readonly triage: TriageMarker }
	| { readonly kind: "merge"; readonly pr: PullRequest; readonly waived?: Waived }
	| { readonly kind: "wait"; readonly reason: string }
	| {
			readonly kind: "handoff";
			readonly label: string;
			readonly reason: string;
			readonly pr?: PullRequest;
			readonly waived?: Waived;
	  }
	| { readonly kind: "done"; readonly reason: string };

/** What GitHub says about an issue's work, as {@link decidePhase} reads it. */
export interface IssueState {
	/** The branch the issue's work is on: its own, or the latest restart's. */
	readonly branch: string;
	/** Set once a triage restarted the issue. */
	readonly restart?: Restart;
	/** The pull request from `branch`. */
	readonly pr?: PullRequest;
	/** The review author's verdicts on the pull request, oldest first. */
	readonly verdicts: readonly ReviewMarker[];
	/** The review author's triage decisions on the pull request, oldest first. */
	readonly triages: readonly TriageMarker[];
	readonly checks?: ChecksState;
	/** Reviewed heads that merged the base branch in, whose reviews are not rounds. */
	readonly updates?: ReadonlySet<string>;
	/** Files the pull request changes that its base branch changed too since it branched. */
	readonly staleFiles?: readonly string[];
}

/** The branch of an issue's `count`th implementation: `volt/issue-<n>`, then `volt/issue-<n>-<count>` after restarts. */
export function issueBranch(number: number, count = 1): string {
	return count === 1 ? `volt/issue-${number}` : `volt/issue-${number}-${count}`;
}

/** The managed worktree of an issue's branch, named like it: `issue-<n>`, then `issue-<n>-<count>` after restarts. */
export function issueWorktree(number: number, count = 1): string {
	return count === 1 ? `issue-${number}` : `issue-${number}-${count}`;
}

/** Which implementation of issue `number` `branch` is (see {@link issueBranch}): 1 for any other branch. */
export function branchCount(number: number, branch: string): number {
	const count = new RegExp(`^volt/issue-${number}-(\\d+)$`).exec(branch)?.[1];
	return count === undefined ? 1 : Number(count);
}

/** Whether the workflow works `issue`: it carries every required label and no excluded one. */
export function isRoutable(issue: Issue, config: WorkflowConfig): boolean {
	const has = (label: string) => issue.labels.includes(label.toLowerCase());
	return config.tracker.labels.every(has) && !config.tracker.excludeLabels.some(has);
}

/** The latest verdict on each reviewed head commit, oldest first. */
export function verdictsByHead(reviews: readonly ReviewMarker[]): ReviewMarker[] {
	const latest = new Map<string, ReviewMarker>();
	for (const review of reviews) {
		latest.delete(review.headSha);
		latest.set(review.headSha, review);
	}
	return [...latest.values()];
}

/** `count noun`, with the noun plural unless the count is one. */
function counted(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Decide what `issue` needs from its branch, pull request, the review author's markers on it, and its checks. */
export function decidePhase(config: WorkflowConfig, issue: Issue, state: IssueState): Phase {
	if (!issue.open) return { kind: "done", reason: "the issue is closed" };
	const pr = state.pr;
	if (pr === undefined) {
		return {
			kind: "implement",
			branch: state.branch,
			...(state.restart === undefined ? {} : { restart: state.restart }),
		};
	}
	if (pr.state === "merged") return { kind: "done", reason: `pull request #${pr.number} merged` };
	if (pr.state === "closed") {
		return { kind: "wait", reason: `pull request #${pr.number} was closed without merging` };
	}
	const base = pr.baseRef || "its base branch";
	if (pr.mergeable === "conflicting") {
		return { kind: "update", pr, reason: `pull request #${pr.number} conflicts with ${base}` };
	}
	// What a triage decided for this head stands until the head moves.
	const triage = state.triages.findLast((marker) => pr.headSha.startsWith(marker.headSha));
	if (triage?.decision === "restart") return { kind: "restart", pr, triage };
	if (triage?.decision === "handoff") {
		return {
			kind: "handoff",
			label: config.handoffLabel,
			reason: `A triage of pull request #${pr.number} handed it to a human.\n\n${triage.text}`,
			pr,
		};
	}
	const stale = state.staleFiles ?? [];
	const update: Phase | undefined =
		stale.length > 0
			? {
					kind: "update",
					pr,
					reason: `${base} changed ${stale.join(", ")} since pull request #${pr.number} branched from it`,
				}
			: undefined;
	const verdicts = verdictsByHead(state.verdicts);
	const current = verdicts.find((review) => pr.headSha.startsWith(review.headSha));
	const updates = state.updates ?? new Set<string>();
	const reviewed = verdicts.filter((review) => !updates.has(review.headSha)).length;
	const fixOrTriage = (reason: string, failing: readonly string[], runId?: string, regressed = 0): Phase => {
		// A triage that let the pull request continue grants this head its fix.
		if (triage?.decision !== "continue" && (regressed > 0 || reviewed >= config.review.maxRounds)) {
			const why =
				regressed > 0
					? `the last fix introduced ${counted(regressed, "new defect")} on the lines it changed, which the review found`
					: `the pull request did not converge after ${counted(reviewed, "review round")} (last: ${reason})`;
			if (state.triages.length < config.triage.maxRuns) return { kind: "triage", pr, round: reviewed, reason: why };
			const triaged =
				config.triage.maxRuns > 0 ? ` It was triaged ${counted(state.triages.length, "time")} already.` : "";
			return {
				kind: "handoff",
				label: config.handoffLabel,
				reason: `${why.charAt(0).toUpperCase()}${why.slice(1)}.${triaged}`,
				pr,
			};
		}
		return update ?? { kind: "fix", pr, round: reviewed, reason, failing, ...(runId === undefined ? {} : { runId }) };
	};
	if (current === undefined) {
		if (update !== undefined) return update;
		const previous = verdicts.findLast((review) => review.runId !== undefined);
		return {
			kind: "review",
			pr,
			round: reviewed + 1,
			...(previous?.runId === undefined ? {} : { previousRunId: previous.runId, previousHeadSha: previous.headSha }),
		};
	}
	if (current.verdict === "changes") {
		return fixOrTriage("the review asked for changes", [], current.runId, current.regressed);
	}
	if (state.checks === undefined || state.checks.state === "pending") {
		return { kind: "wait", reason: "CI checks are running" };
	}
	if (state.checks.state === "failing") {
		return fixOrTriage(`CI checks failing: ${state.checks.failing.join(", ")}`, state.checks.failing);
	}
	if (state.checks.state === "none" && config.merge.requireChecks) {
		return {
			kind: "handoff",
			label: config.handoffLabel,
			reason: `Pull request #${pr.number} was approved, but no CI checks ran on it.`,
			pr,
		};
	}
	if (pr.mergeable === "unknown") {
		return { kind: "wait", reason: `GitHub is still checking whether pull request #${pr.number} merges cleanly` };
	}
	const waived: Waived | undefined = current.waived
		? { count: current.waived, ...(current.runId === undefined ? {} : { runId: current.runId }) }
		: undefined;
	if (config.merge.mode === "handoff") {
		return {
			kind: "handoff",
			label: config.merge.readyLabel,
			reason: `Pull request #${pr.number} was reviewed clean and its checks pass: ready for a human to merge.`,
			pr,
			...(waived === undefined ? {} : { waived }),
		};
	}
	if (pr.draft) {
		return { kind: "handoff", label: config.handoffLabel, reason: `Pull request #${pr.number} is a draft.`, pr };
	}
	return { kind: "merge", pr, ...(waived === undefined ? {} : { waived }) };
}

/**
 * Read what `issue` needs from `tracker`, asking only for what the decision
 * uses: the restarts only once the issue's first pull request closed without
 * merging, and the base branch's changes only before a review or a fix.
 */
export async function inspectIssue(tracker: Tracker, config: WorkflowConfig, issue: Issue): Promise<Phase> {
	let state: IssueState = { branch: issueBranch(issue.number), verdicts: [], triages: [] };
	if (!issue.open) return decidePhase(config, issue, state);
	let pr = await tracker.pullRequest(state.branch);
	if (pr?.state === "closed") {
		// A restart closes the pull request it replaces; the latest restart's branch is the work now.
		const restarts = await tracker.restarts(issue.number);
		const latest = restarts.at(-1);
		if (latest !== undefined) {
			const restart: Restart = { count: restarts.length + 1, previousPr: latest.pr, guidance: latest.text };
			state = { ...state, branch: latest.branch, restart };
			pr = await tracker.pullRequest(latest.branch);
		}
	}
	if (pr === undefined) return decidePhase(config, issue, state);
	state = { ...state, pr };
	if (pr.state !== "open" || pr.mergeable === "conflicting") return decidePhase(config, issue, state);
	const markers = await tracker.markers(pr.number);
	const updates = new Set<string>();
	for (const review of verdictsByHead(markers.verdicts)) {
		if (await tracker.isMergeCommit(review.headSha)) updates.add(review.headSha);
	}
	const current = verdictsByHead(markers.verdicts).find((review) => pr.headSha.startsWith(review.headSha));
	const checks = current?.verdict === "clean" ? await tracker.checks(pr.number) : undefined;
	state = {
		...state,
		verdicts: markers.verdicts,
		triages: markers.triages,
		updates,
		...(checks === undefined ? {} : { checks }),
	};
	const phase = decidePhase(config, issue, state);
	if (phase.kind !== "review" && phase.kind !== "fix") return phase;
	const staleFiles = await tracker.staleFiles(pr);
	return staleFiles.length === 0 ? phase : decidePhase(config, issue, { ...state, staleFiles });
}
