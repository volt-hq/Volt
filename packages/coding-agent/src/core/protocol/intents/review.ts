/**
 * Review intents: starting reviews (detached workflows on hosts that run
 * them detached), lifecycle operations on durable review runs, and review
 * discussions. A review discussion's source owns the lifecycle operations.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createReviewFixHandoff } from "../../host/review-handoff.ts";
import { openNewSession } from "../../host/session-intents.ts";
import { listBaseBranches, type ReviewTarget, reviewTargetForRerun } from "../../review.ts";
import { ReviewDiscussionConfigurationError, type ReviewDiscussionService } from "../../review-discussions.ts";
import { publishReviewRun } from "../../review-publish.ts";
import {
	acknowledgeReviewRun,
	appendReviewPublication,
	exportCanonicalReviewFeedback,
	getCanonicalReviewRun,
	recordReviewFindingOutcome,
} from "../../review-state.ts";
import type { UiActionOptionDescriptor } from "../../rpc/types.ts";
import { targetOf } from "./conversation.ts";
import { boundedDisplayString, MAX_INTENT_COMPLETIONS, MAX_INTENT_LABEL_LENGTH } from "./dynamic.ts";
import { isIntentStateBusy } from "./state.ts";
import {
	defineIntent,
	INTENT_ENABLED,
	type IntentAvailability,
	type IntentContext,
	type IntentReviewOptions,
	type IntentView,
} from "./types.ts";

const control = ["conversation.control.v1"] as const;

/** A failure with a stable machine-readable code. */
export class CodedIntentError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "CodedIntentError";
		this.code = code;
	}
}

function reviewAvailability(view: IntentView): IntentAvailability {
	// Detached reviews run in an isolated session and never touch the current
	// conversation, so session busy states do not gate them.
	if (view.services.detachedReviews) return INTENT_ENABLED;
	const { state } = view;
	if (state.isStreaming) return { enabled: false, reason: "Review is not available while the agent is streaming" };
	if (isIntentStateBusy(state)) {
		return { enabled: false, reason: "Review is not available while an agent operation is running" };
	}
	if (state.isCompacting) return { enabled: false, reason: "Review is not available while compaction is running" };
	return INTENT_ENABLED;
}

interface ReviewControlsInput {
	focus?: string;
	scope?: string;
	effort?: "low" | "standard" | "high";
	includeOptional?: boolean;
	scopeMode?: "incremental" | "full";
}

/** Remote reviews confirm before they start, require project trust, and sanitize failures. */
function reviewOptions(ctx: IntentContext, input: ReviewControlsInput): IntentReviewOptions {
	const remote = ctx.profile.name === "remote";
	return {
		remote,
		requireConfirmation: remote,
		controls: {
			...(input.focus ? { focus: input.focus } : {}),
			...(input.scope
				? {
						scope: input.scope
							.split(",")
							.map((entry) => entry.trim())
							.filter(Boolean),
					}
				: {}),
			...(input.effort === undefined ? {} : { effort: input.effort }),
			...(input.includeOptional === undefined ? {} : { includeOptional: input.includeOptional }),
			...(input.scopeMode === undefined ? {} : { scopeMode: input.scopeMode }),
		},
	};
}

function runReview(ctx: IntentContext, target: ReviewTarget, options: IntentReviewOptions) {
	targetOf(ctx);
	const run = ctx.services.runReview;
	if (!run) throw new Error("Review actions are not available in this host");
	return run(target, options);
}

/** A started review answers its workflow id; a review a host runs to completion answers nothing. */
function acceptReview(outcome: Awaited<ReturnType<typeof runReview>>) {
	return outcome.status === "accepted" ? { result: { workflowId: outcome.workflowId } } : {};
}

const reviewStart = {
	category: "review",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	confirm: {},
	sourceOwned: true,
	available: reviewAvailability,
	accept: acceptReview,
} as const;

/**
 * Logical base branches from the workspace (the same collapsed local and
 * upstream set as the TUI picker), prefix-filtered and bounded. Not a git
 * repository: no candidates.
 */
async function completeBaseBranches(ctx: IntentContext, prefix: string): Promise<UiActionOptionDescriptor[]> {
	const branches = await listBaseBranches(targetOf(ctx).session.sessionManager.getCwd());
	if (!Array.isArray(branches)) return [];
	const normalizedPrefix = prefix.toLowerCase();
	return (
		branches
			.filter((branch) => branch.toLowerCase().startsWith(normalizedPrefix))
			// Keep only values that survive display bounding unchanged: a truncated or
			// redacted name would be an invalid completion value.
			.filter((branch) => boundedDisplayString(branch, MAX_INTENT_LABEL_LENGTH) === branch)
			.slice(0, MAX_INTENT_COMPLETIONS)
			.map((branch) => ({ value: branch }))
	);
}

export const reviewUncommittedIntent = defineIntent({
	...reviewStart,
	name: "review_uncommitted",
	label: "Review changes",
	description: "Review uncommitted workspace changes.",
	presentation: { kind: "card", group: "Review", priority: 100, icon: "magnifyingglass" },
	slash: { name: "review", example: "/review uncommitted" },
	run: (ctx, input) => runReview(ctx, { kind: "uncommitted" }, reviewOptions(ctx, input)),
});

export const reviewBranchIntent = defineIntent({
	...reviewStart,
	name: "review_branch",
	label: "Review branch",
	description:
		"Review the current branch against a refreshed upstream merge base using host Git credentials and network; full refs use local cached state.",
	presentation: {
		kind: "card",
		group: "Review",
		priority: 90,
		icon: "point.topleft.down.curvedto.point.bottomright.up",
	},
	slash: { name: "review", example: "/review branch [base]" },
	completions: ["base"],
	complete: (ctx, _field, prefix) => completeBaseBranches(ctx, prefix),
	run: (ctx, input) =>
		runReview(ctx, { kind: "branch", base: input.base?.trim() || undefined }, reviewOptions(ctx, input)),
});

export const reviewPrIntent = defineIntent({
	...reviewStart,
	name: "review_pr",
	label: "Review pull request",
	description:
		"Review a pull request using the built-in GitHub CLI code-host provider, host credentials, and network; its metadata, diff, authoritative linked issues, comments, submitted review summaries, and inline review threads are sent to discovery and verification, while retained finding prose is rendered separately without code-host context.",
	presentation: { kind: "card", group: "Review", priority: 80, icon: "arrow.triangle.pull" },
	slash: { name: "review", example: "/review pr [number]" },
	run: (ctx, input) =>
		runReview(ctx, { kind: "pr", number: input.number?.trim() || undefined }, reviewOptions(ctx, input)),
});

export const reviewCommitIntent = defineIntent({
	...reviewStart,
	name: "review_commit",
	label: "Review commit",
	description: "Review a commit from workspace history; its metadata and diff are sent to the review model.",
	presentation: { kind: "card", group: "Review", priority: 70, icon: "clock.arrow.circlepath" },
	slash: { name: "review", example: "/review commit <ref>" },
	run: (ctx, input) => runReview(ctx, { kind: "commit", sha: input.ref }, reviewOptions(ctx, input)),
});

async function durableReviewRun(ctx: IntentContext, runId: string) {
	const record = await getCanonicalReviewRun(targetOf(ctx).session.sessionManager, runId);
	ctx.assertCurrent?.();
	if (!record) throw new Error(`Unknown durable review run: ${runId}`);
	return record;
}

export const reviewRerunIntent = defineIntent({
	name: "review_rerun",
	label: "Re-run review",
	description: "Run an incremental or full review from a durable prior run.",
	category: "review",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	confirm: {},
	presentation: { kind: "detail", group: "Review", priority: 40 },
	sourceOwned: true,
	async run(ctx, input) {
		const record = await durableReviewRun(ctx, input.runId);
		// Reruns take the remote review options on every host, as they always have.
		return runReview(ctx, reviewTargetForRerun(record), {
			remote: true,
			requireConfirmation: true,
			controls: { ...record.options, scopeMode: input.mode === "full" ? "full" : "incremental" },
			parentRunId: record.runId,
		});
	},
	accept: acceptReview,
});

export const reviewCancelWorkflowIntent = defineIntent({
	name: "review_cancel_workflow",
	label: "Cancel review",
	description: "Cancel a running review workflow",
	category: "review",
	scope: "conversation",
	fence: "none",
	remote: "safe",
	requires: control,
	whileBusy: "run",
	async run(ctx, input) {
		targetOf(ctx).conversation.reviewWorkflows.cancel(input.workflowId);
	},
});

export const reviewOpenSessionIntent = defineIntent({
	name: "review_open_session",
	label: "Fix review findings",
	description: "Open a fresh session seeded with selected durable review findings.",
	category: "review",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "detail", group: "Review", priority: 60 },
	sourceOwned: true,
	async run(ctx, input) {
		const { host, client } = targetOf(ctx);
		const record = await durableReviewRun(ctx, input.runId);
		const result = record.result;
		if (!result) throw new Error(`Review run has no findings result: ${input.runId}`);
		const requestedIds = input.findingIds ?? result.findings.map((finding) => finding.id);
		const unknownIds = [...new Set(requestedIds)].filter(
			(findingId) => !result.findings.some((finding) => finding.id === findingId),
		);
		if (unknownIds.length > 0) throw new Error(`Unknown finding ids: ${unknownIds.join(", ")}`);
		const handoff = createReviewFixHandoff(record, input.findingIds);
		const opened = await openNewSession(host, client, {
			setup: (writer) => handoff.setup(writer),
			beforeMove: (source) => handoff.beforeMove(source),
			...(ctx.assertCurrent === undefined ? {} : { assertConversationGenerationCurrent: ctx.assertCurrent }),
		});
		return { opened, selectedCount: new Set(requestedIds).size };
	},
	accept: ({ opened }) =>
		opened.cancelled ? { result: { cancelled: true as const } } : { conversation: opened.sessionId },
});

export const reviewAcknowledgeIntent = defineIntent({
	name: "review_acknowledge",
	label: "Acknowledge review",
	description: "Mark a durable review run as seen",
	category: "review",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "run",
	sourceOwned: true,
	async run(ctx, input) {
		const acknowledgment = await acknowledgeReviewRun(targetOf(ctx).session.sessionWriter, input.runId);
		return { runId: acknowledgment.runId, acknowledgedAt: acknowledgment.acknowledgedAt };
	},
	accept: (result) => ({ result }),
});

export const reviewRecordFindingOutcomeIntent = defineIntent({
	name: "review_record_finding_outcome",
	label: "Label review finding",
	description: "Record an explicit local outcome for a durable review finding.",
	category: "review",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "detail", group: "Review", priority: 50 },
	sourceOwned: true,
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		const record = await getCanonicalReviewRun(session.sessionManager, input.runId);
		if (!record?.result?.findings.some((finding) => finding.id === input.findingId)) {
			throw new Error(`Unknown finding ${input.findingId} in review run ${input.runId}`);
		}
		if (input.status === "dismissed" && !input.reason) {
			throw new Error("Dismissed findings require an explicit reason.");
		}
		const { schemaVersion: _schemaVersion, ...transition } = await recordReviewFindingOutcome(
			session.sessionWriter,
			{
				runId: input.runId,
				findingId: input.findingId,
				status: input.status,
				...(input.reason ? { reason: input.reason } : {}),
				...(input.note ? { note: input.note } : {}),
			},
			{
				recordCanonicalOutcome: ctx.services.reviewDiscussions?.recordOutcome,
				...(ctx.assertCurrent === undefined ? {} : { assertCurrent: ctx.assertCurrent }),
			},
		);
		return { ...transition, status: input.status };
	},
	accept: (result) => ({ result }),
});

export const reviewPublishIntent = defineIntent({
	name: "review_publish",
	label: "Publish PR review",
	description: "Atomically publish a complete, non-stale pull request review.",
	category: "review",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "reject",
	confirm: {},
	presentation: { kind: "detail", group: "Review", priority: 30 },
	sourceOwned: true,
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		const record = await durableReviewRun(ctx, input.runId);
		const published = await publishReviewRun(session.sessionManager.getCwd(), record);
		await appendReviewPublication(session.sessionWriter, { runId: record.runId, ...published });
		return published;
	},
	accept: (result) => ({ result }),
});

export const reviewExportFeedbackIntent = defineIntent({
	name: "review_export_feedback",
	label: "Export review feedback",
	description: "Explicitly export locally recorded review outcomes for evaluation.",
	category: "review",
	scope: "conversation",
	fence: "branch",
	remote: "unsafe",
	requires: control,
	whileBusy: "reject",
	presentation: { kind: "detail", group: "Review", priority: 20 },
	sourceOwned: true,
	async run(ctx, input) {
		const { session } = targetOf(ctx);
		ctx.assertCurrent?.();
		const feedback = await exportCanonicalReviewFeedback(session.sessionManager);
		if (input.path === undefined) return feedback;
		if (!input.path.trim()) throw new Error("Review feedback export requires a non-empty path.");
		const outputPath = resolve(session.sessionManager.getCwd(), input.path.trim());
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, `${JSON.stringify(feedback, null, 2)}\n`, { mode: 0o600 });
		return { ...feedback, path: outputPath };
	},
	accept: (feedback) => ({ result: { ...feedback, outcomes: feedback.outcomes.map((outcome) => ({ ...outcome })) } }),
});

/** The host's review discussion service, or a stable error when this host has none. */
export function reviewDiscussionsOf(ctx: IntentContext): ReviewDiscussionService {
	const service = ctx.services.reviewDiscussions;
	if (!service) {
		throw new CodedIntentError("review_discussions_unavailable", "This backend has no daemon sibling service");
	}
	return service;
}

/** Run a review discussion operation; source changes surface as one stable error. */
export async function runReviewDiscussion<T>(
	ctx: IntentContext,
	operation: (service: ReviewDiscussionService) => Promise<T>,
): Promise<T> {
	const service = reviewDiscussionsOf(ctx);
	try {
		ctx.assertCurrent?.();
		return await operation(service);
	} catch (error) {
		if (error instanceof ReviewDiscussionConfigurationError) throw new Error(error.message);
		throw new CodedIntentError(
			"review_source_unavailable",
			"Review source identity, placement, or runtime admission changed",
		);
	}
}

export const reviewStartDiscussionsIntent = defineIntent({
	name: "review_start_discussions",
	label: "Discuss findings",
	description: "Start discussion sessions for selected review findings",
	category: "review",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "run",
	run: (ctx, input) =>
		runReviewDiscussion(ctx, (service) =>
			service.start(input.runId, input.findingIds, input.requestId, input.discussionConfiguration),
		),
	accept: (result) => ({ result }),
});

export const reviewResetDiscussionIntent = defineIntent({
	name: "review_reset_discussion",
	label: "Reset discussion",
	description: "Start a finding's discussion over in a fresh session",
	category: "review",
	scope: "conversation",
	fence: "branch",
	remote: "safe",
	requires: control,
	whileBusy: "run",
	run: (ctx, input) =>
		runReviewDiscussion(ctx, (service) =>
			service.reset(input.discussionId, input.expectedSessionId, input.requestId),
		),
	accept: (result) => ({ result }),
});
