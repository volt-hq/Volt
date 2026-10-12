/**
 * Starting a review on an engine (see review-engine.ts): the host resolves the snapshot, runs the engine as
 * the conversation's `review` work (the work id is the run id, as for the built-in pipeline), and writes the
 * run record when the engine returns. Whatever the engine does, the record ends the work: completed or
 * incomplete with the result the engine submitted, failed when the engine threw or submitted nothing, and
 * cancelled when the work was. The host disposes the snapshot after the engine returns.
 */

import type { Api, Model } from "@hansjm10/volt-ai";
import type { ModelRegistry } from "./model-registry.ts";
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
import { type ReviewEngineDeclaration, ReviewEngineRun, resolveReviewEngineParameters } from "./review-engine.ts";
import {
	appendReviewRunDurably,
	assertFollowsReviewOf,
	assertReviewControlsPersistLosslessly,
	closeFixedFindings,
	createReviewRunRecord,
	followUpReviewPlan,
	getCanonicalReviewRun,
	type ReviewIncrementalPlan,
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
	/**
	 * The parameters the client supplied. They are checked here, against the engine that runs, for the client that
	 * asked: the engine may have been replaced since a client was told what it declares.
	 */
	params?: Readonly<Record<string, unknown>>;
	/** A paired remote device started it: the project must be trusted, and a failure is not described to clients. */
	remote: boolean;
	cwd: string;
	work: WorkRegistry;
	/** The conversation's models, which the engine's own sessions use. */
	modelRegistry: ModelRegistry;
	/** The conversation's current model. */
	model?: Model<Api>;
	settingsManager: Pick<SettingsManager, "isProjectTrusted">;
	/** The conversation's log, which a pull request review's binding and the run's records belong to. */
	sessionManager: SessionManager;
	sessionWriter: SessionWriter;
	/** Running work the review belongs to: clients show it under that work. */
	parentWorkId?: string;
	/**
	 * An earlier review of the same target this one follows: the engine gets the findings it left open to decide, and
	 * the ones it finds fixed are closed there.
	 */
	previousRunId?: string;
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
	const params = resolveReviewEngineParameters(engine, options.params, { remote });
	// A review that follows an earlier run reviews everything.
	const controls = controlsWithDefaults({
		...options.controls,
		...(options.previousRunId === undefined ? {} : { scopeMode: "full" as const }),
	});
	assertReviewControlsPersistLosslessly(controls);
	const previousRun =
		options.previousRunId === undefined
			? undefined
			: await getCanonicalReviewRun(options.sessionManager, options.previousRunId);
	if (options.previousRunId !== undefined && !previousRun) {
		throw new Error(`Unknown review run: ${options.previousRunId}`);
	}
	// An engine reviews a pull request's code, not its discussion: the snapshot has its identity only.
	const { target, resolution } = await resolveBoundReviewSnapshot({
		target: options.target,
		cwd: options.cwd,
		sessionManager: options.sessionManager,
		pullRequestContext: false,
		sanitizeRemoteErrors: remote,
	});
	let followUp: ReviewIncrementalPlan | undefined;
	try {
		if (previousRun) {
			assertFollowsReviewOf(previousRun, resolution);
			followUp = followUpReviewPlan(previousRun, resolution);
		}
	} catch (error) {
		await resolution.dispose();
		throw error;
	}
	const workId = createReviewWorkflowId();
	const startedAt = Date.now();
	const action = reviewActionIdForTarget(options.target);
	const shown = `${reviewWorkTarget(resolution)} with ${engine.label}`;

	const execute = async (work: WorkContext): Promise<WorkExecution> => {
		const run = new ReviewEngineRun({
			snapshot: resolution,
			target,
			controls,
			cwd: options.cwd,
			...(followUp === undefined ? {} : { previousFindings: followUp.priorOpenFindings }),
		});
		let failure: Error | undefined;
		try {
			if (target.kind === "pr") {
				const binding = await readPrReviewBinding(options.sessionManager);
				if (binding) await verifyBoundPullRequest(binding, resolution, options.cwd, work.signal);
			}
			work.progress({ text: `Reviewing ${shown}` });
			await engine.run(
				run.context({
					workId,
					params,
					signal: work.signal,
					modelRegistry: options.modelRegistry,
					model: options.model,
					isProjectTrusted: () => options.settingsManager.isProjectTrusted(),
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
				...(followUp === undefined ? {} : { incrementalPlan: followUp }),
			});
			await appendReviewRunDurably(options.sessionWriter, record);
			// A complete review closes what it found fixed; an incomplete one may not have settled the rest.
			if (status === "completed" && record.parentRunId) {
				await closeFixedFindings(options.sessionWriter, record.parentRunId, record.runId, run.fixedPriorFindings());
			}
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
		await options.work.start("review", reviewWorkInput(action, shown), execute, {
			workId,
			...(options.parentWorkId === undefined ? {} : { parentWorkId: options.parentWorkId }),
		});
	} catch (error) {
		await resolution.dispose();
		throw error;
	}
	return { workId };
}
