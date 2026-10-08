/**
 * Starting a review on an engine (see review-engine.ts): the host resolves the snapshot, runs the engine as
 * the conversation's `review` work (the work id is the run id, as for the built-in pipeline), and writes the
 * run record when the engine returns. Whatever the engine does, the record ends the work: completed or
 * incomplete with the result the engine submitted, failed when the engine threw or submitted nothing, and
 * cancelled when the work was. The host disposes the snapshot after the engine returns.
 */

import { readPrReviewBinding } from "./pr-review-binding.ts";
import {
	controlsWithDefaults,
	createReviewWorkflowId,
	formatReviewWorkflowSummary,
	REMOTE_REVIEW_FAILURE_MESSAGE,
	type ReviewRunControls,
	type ReviewTarget,
	resolveBoundReviewSnapshot,
	reviewActionIdForTarget,
	reviewWorkTarget,
	verifyBoundPullRequest,
} from "./review.ts";
import { type ReviewEngineDeclaration, ReviewEngineRun } from "./review-engine.ts";
import {
	appendReviewRunDurably,
	assertReviewControlsPersistLosslessly,
	createReviewRunRecord,
	type ReviewRunStatus,
} from "./review-state.ts";
import { type ReviewWorkData, reviewWorkInput } from "./review-work.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SessionWriter } from "./session-writer.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { WorkContext, WorkExecution, WorkRegistry } from "./work/registry.ts";

export interface StartEngineReviewOptions {
	engine: ReviewEngineDeclaration;
	target: ReviewTarget;
	controls?: Partial<ReviewRunControls>;
	/** A paired remote device started it: the project must be trusted, and a failure is not described to clients. */
	remote: boolean;
	cwd: string;
	work: WorkRegistry;
	settingsManager: Pick<SettingsManager, "isProjectTrusted">;
	/** The conversation's log, which a pull request review's binding and the run's records belong to. */
	sessionManager: SessionManager;
	sessionWriter: SessionWriter;
}

/**
 * Resolve the target, then run `options.engine` on it as `review` work, and answer the work's id once the
 * work is started. Target and admission errors throw before any work exists.
 */
export async function startEngineReview(options: StartEngineReviewOptions): Promise<{ readonly workId: string }> {
	const { engine, remote } = options;
	if (!engine.targets.includes(options.target.kind)) {
		throw new Error(`The ${engine.label} engine does not review a ${options.target.kind} target`);
	}
	if (remote && !engine.remoteSafe) throw new Error(`The ${engine.label} engine is not available to remote clients`);
	if (remote && !options.settingsManager.isProjectTrusted()) {
		throw new Error("Project trust is required before running a remote review.");
	}
	const controls = controlsWithDefaults(options.controls);
	assertReviewControlsPersistLosslessly(controls);
	// An engine reviews a pull request's code, not its discussion: the snapshot has its identity only.
	const { target, resolution } = await resolveBoundReviewSnapshot({
		target: options.target,
		cwd: options.cwd,
		sessionManager: options.sessionManager,
		pullRequestContext: false,
		sanitizeRemoteErrors: remote,
	});
	const workId = createReviewWorkflowId();
	const startedAt = Date.now();
	const action = reviewActionIdForTarget(options.target);
	const shown = `${reviewWorkTarget(resolution)} with ${engine.label}`;

	const execute = async (work: WorkContext): Promise<WorkExecution> => {
		const run = new ReviewEngineRun({ snapshot: resolution, target, controls, cwd: options.cwd });
		let failure: Error | undefined;
		try {
			if (target.kind === "pr") {
				const binding = await readPrReviewBinding(options.sessionManager);
				if (binding) await verifyBoundPullRequest(binding, resolution, options.cwd, work.signal);
			}
			work.progress({ text: `Reviewing ${shown}` });
			await engine.run(
				run.context({
					signal: work.signal,
					progress: (progress, detail) => work.progress(progress, detail),
					checkpoint: (progress, detail) => work.checkpoint(progress, detail),
					output: (text) => work.output(text),
				}),
			);
		} catch (error) {
			failure = error instanceof Error ? error : new Error(String(error));
		} finally {
			run.end();
		}
		try {
			const parsed = run.result();
			let status: ReviewRunStatus;
			let errorMessage: string | undefined;
			if (work.signal.aborted) {
				status = "cancelled";
			} else if (failure || !parsed) {
				status = "failed";
				errorMessage = remote
					? REMOTE_REVIEW_FAILURE_MESSAGE
					: (failure?.message ?? `The ${engine.label} engine finished without a review result.`);
			} else {
				status = parsed.completionStatus === "complete" ? "completed" : "incomplete";
			}
			const record = createReviewRunRecord({
				workflowId: workId,
				workflowAction: action,
				engine: engine.id,
				startedAt,
				snapshot: resolution,
				controls,
				status,
				...(parsed && (status === "completed" || status === "incomplete") ? { result: parsed } : {}),
				...(errorMessage === undefined ? {} : { errorMessage }),
			});
			await appendReviewRunDurably(options.sessionWriter, record);
			if (status === "cancelled") return { outcome: "cancelled" };
			if (errorMessage !== undefined) return { outcome: "failed", error: errorMessage };
			const result = record.result;
			if (!result) return { outcome: "failed", error: REMOTE_REVIEW_FAILURE_MESSAGE };
			return {
				outcome: "completed",
				result: {
					summary: formatReviewWorkflowSummary({
						findingsCount: result.findings.length,
						completionStatus: result.completionStatus,
					}),
					data: {
						target: shown,
						findingsCount: result.findings.length,
						completionStatus: result.completionStatus,
					} satisfies ReviewWorkData,
				},
			};
		} finally {
			await resolution.dispose();
		}
	};

	try {
		await options.work.start("review", reviewWorkInput(action, shown), execute, { workId });
	} catch (error) {
		await resolution.dispose();
		throw error;
	}
	return { workId };
}
