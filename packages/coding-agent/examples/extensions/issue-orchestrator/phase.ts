/**
 * What an issue needs next, read from GitHub alone, so a restarted
 * orchestrator picks up where the last one stopped:
 *
 * - no pull request from the issue's branch: `implement`;
 * - an open one that conflicts with its base branch: `update`, before
 *   anything else, since every review and check of it would be redone;
 * - an open one whose head commit has no review verdict: `review`;
 * - a verdict of changes, or failing checks after a clean one: `fix`, until
 *   the pull request has had `review.max_rounds` reviews, then a human. The
 *   review of a head that only merged the base branch in is not a round: a
 *   conflict is not the pull request's fault;
 * - a clean verdict with green checks: `merge` (or a human, in handoff mode),
 *   once GitHub says it merges cleanly;
 * - checks still running, mergeability not known yet, or a pull request
 *   closed without merging: wait;
 * - a merged pull request or a closed issue: done.
 */

import type { ChecksState, Issue, PullRequest, ReviewMarker, Tracker } from "./github.ts";
import type { WorkflowConfig } from "./workflow.ts";

export type Phase =
	| { readonly kind: "implement" }
	| { readonly kind: "update"; readonly pr: PullRequest; readonly reason: string }
	| { readonly kind: "review"; readonly pr: PullRequest; readonly round: number }
	| {
			readonly kind: "fix";
			readonly pr: PullRequest;
			readonly round: number;
			readonly reason: string;
			readonly failing: readonly string[];
	  }
	| { readonly kind: "merge"; readonly pr: PullRequest }
	| { readonly kind: "wait"; readonly reason: string }
	| { readonly kind: "handoff"; readonly label: string; readonly reason: string }
	| { readonly kind: "done"; readonly reason: string };

/** The branch an issue's agents work on. */
export function issueBranch(number: number): string {
	return `volt/issue-${number}`;
}

/** The managed worktree an issue's agents work in. */
export function issueWorktree(number: number): string {
	return `issue-${number}`;
}

/** Whether the workflow works `issue`: it carries every required label and no excluded one. */
export function isRoutable(issue: Issue, config: WorkflowConfig): boolean {
	const has = (label: string) => issue.labels.includes(label.toLowerCase());
	return config.tracker.labels.every(has) && !config.tracker.excludeLabels.some(has);
}

/** The latest verdict on each reviewed head commit, oldest first. */
function verdictsByHead(reviews: readonly ReviewMarker[]): ReviewMarker[] {
	const latest = new Map<string, ReviewMarker>();
	for (const review of reviews) {
		latest.delete(review.headSha);
		latest.set(review.headSha, review);
	}
	return [...latest.values()];
}

/**
 * Decide what `issue` needs from its pull request, the verdicts on it, and
 * its checks. `updates` holds the reviewed heads that merged the base branch
 * in, whose reviews are not rounds.
 */
export function decidePhase(
	config: WorkflowConfig,
	issue: Issue,
	pr: PullRequest | undefined,
	reviews: readonly ReviewMarker[],
	checks: ChecksState | undefined,
	updates: ReadonlySet<string> = new Set(),
): Phase {
	if (!issue.open) return { kind: "done", reason: "the issue is closed" };
	if (pr === undefined) return { kind: "implement" };
	if (pr.state === "merged") return { kind: "done", reason: `pull request #${pr.number} merged` };
	if (pr.state === "closed") {
		return { kind: "wait", reason: `pull request #${pr.number} was closed without merging` };
	}
	if (pr.mergeable === "conflicting") {
		return {
			kind: "update",
			pr,
			reason: `pull request #${pr.number} conflicts with ${pr.baseRef || "its base branch"}`,
		};
	}
	const verdicts = verdictsByHead(reviews);
	const current = verdicts.find((review) => pr.headSha.startsWith(review.headSha));
	const reviewed = verdicts.filter((review) => !updates.has(review.headSha)).length;
	const fixOrStop = (reason: string, failing: readonly string[]): Phase =>
		reviewed >= config.review.maxRounds
			? {
					kind: "handoff",
					label: config.handoffLabel,
					reason: `The pull request did not converge after ${reviewed} review rounds (last: ${reason}).`,
				}
			: { kind: "fix", pr, round: reviewed, reason, failing };
	if (current === undefined) return { kind: "review", pr, round: reviewed + 1 };
	if (current.verdict === "changes") return fixOrStop("the review asked for changes", []);
	if (checks === undefined || checks.state === "pending") return { kind: "wait", reason: "CI checks are running" };
	if (checks.state === "failing") return fixOrStop(`CI checks failing: ${checks.failing.join(", ")}`, checks.failing);
	if (checks.state === "none" && config.merge.requireChecks) {
		return {
			kind: "handoff",
			label: config.handoffLabel,
			reason: `Pull request #${pr.number} was approved, but no CI checks ran on it.`,
		};
	}
	if (pr.mergeable === "unknown") {
		return { kind: "wait", reason: `GitHub is still checking whether pull request #${pr.number} merges cleanly` };
	}
	if (config.merge.mode === "handoff") {
		return {
			kind: "handoff",
			label: config.merge.readyLabel,
			reason: `Pull request #${pr.number} was reviewed clean and its checks pass: ready for a human to merge.`,
		};
	}
	if (pr.draft) {
		return { kind: "handoff", label: config.handoffLabel, reason: `Pull request #${pr.number} is a draft.` };
	}
	return { kind: "merge", pr };
}

/** Read what `issue` needs from `tracker`, asking only for what the decision uses. */
export async function inspectIssue(tracker: Tracker, config: WorkflowConfig, issue: Issue): Promise<Phase> {
	if (!issue.open) return decidePhase(config, issue, undefined, [], undefined);
	const pr = await tracker.pullRequest(issueBranch(issue.number));
	if (pr === undefined || pr.state !== "open") return decidePhase(config, issue, pr, [], undefined);
	if (pr.mergeable === "conflicting") return decidePhase(config, issue, pr, [], undefined);
	const reviews = await tracker.reviews(pr.number);
	const verdicts = verdictsByHead(reviews);
	const updates = new Set<string>();
	for (const review of verdicts) if (await tracker.isMergeCommit(review.headSha)) updates.add(review.headSha);
	const current = verdicts.find((review) => pr.headSha.startsWith(review.headSha));
	const checks = current?.verdict === "clean" ? await tracker.checks(pr.number) : undefined;
	return decidePhase(config, issue, pr, reviews, checks, updates);
}
