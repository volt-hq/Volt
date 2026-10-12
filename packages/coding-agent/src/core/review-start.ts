/**
 * Starting a review as the conversation's `review` work: on the built-in pipeline, or on an engine an extension
 * registered. The `review` intent and an extension's `ctx.reviews.start` share it. Target and admission errors
 * throw before any work exists; the review then runs detached from the conversation's turns, and its work id is
 * the run id of the record it ends with.
 */

import type { AgentSession } from "./agent-session.ts";
import {
	type executeReviewWorkflow,
	type prepareReviewWorkflow,
	REMOTE_REVIEW_FAILURE_MESSAGE,
	REMOTE_REVIEW_TOOL_NAMES,
	type ReviewRunControls,
	type ReviewTarget,
	reviewWorkExecution,
	reviewWorkTarget,
} from "./review.ts";
import { startEngineReview } from "./review-engine-run.ts";
import { reviewWorkInput } from "./review-work.ts";

/** What of the conversation's session a review start uses. */
export type ReviewStartSession = Pick<
	AgentSession,
	| "work"
	| "reviewEngines"
	| "reviewPasses"
	| "modelRegistry"
	| "model"
	| "settingsManager"
	| "sessionManager"
	| "sessionWriter"
	| "thinkingLevel"
	| "fastModeEnabled"
	| "resourceLoader"
>;

/**
 * The built-in pipeline a start runs, as its caller imports it. `review.ts` imports the session (through
 * `sdk.ts`), so this module can be evaluated inside that import cycle; taking the pipeline from the caller keeps
 * the caller's binding of it, which is what a module mock of `review.ts` replaces.
 */
export interface ReviewPipeline {
	readonly prepare: typeof prepareReviewWorkflow;
	readonly execute: typeof executeReviewWorkflow;
}

/** Where the conversation runs: its working directory and the user's agent directory. */
export interface ReviewStartEnvironment {
	readonly cwd: string;
	readonly agentDir: string;
}

export interface ConversationReviewOptions {
	/** A paired remote device started it: the project must be trusted, and failures are not described. */
	readonly remote: boolean;
	/** The id of the extension engine to review with; none for the built-in pipeline. */
	readonly engine?: string;
	/** The engine's parameters as supplied; the engine's run checks them and fills in its defaults. */
	readonly engineParams?: Readonly<Record<string, unknown>>;
	readonly controls?: Partial<ReviewRunControls>;
	/** The earlier run of the built-in pipeline an incremental review builds on. */
	readonly parentRunId?: string;
	/**
	 * An earlier review of the same target this one follows: it reviews everything, decides each finding that run
	 * left open, and closes the ones it finds fixed.
	 */
	readonly previousRunId?: string;
	/** Auxiliary tools of the conversation the built-in pipeline's passes may use besides their snapshot tools. */
	readonly tools?: readonly string[];
	/** Running work the review belongs to: clients show it under that work. */
	readonly parentWorkId?: string;
}

export interface StartedConversationReview {
	readonly workId: string;
	/** Why the review uses another model than the one configured, for a local client. */
	readonly message?: string;
}

/** Start a review of `target` as `session`'s `review` work; resolves once the work is started. */
export async function startConversationReview(
	session: ReviewStartSession,
	environment: ReviewStartEnvironment,
	pipeline: ReviewPipeline,
	target: ReviewTarget,
	options: ConversationReviewOptions,
): Promise<StartedConversationReview> {
	if (options.engine !== undefined) {
		const engine = session.reviewEngines.get(options.engine);
		if (!engine) throw new Error(`Unknown review engine: ${options.engine}`);
		if (options.parentRunId !== undefined) {
			throw new Error(`A review on the ${engine.label} engine does not build on an earlier run`);
		}
		if (options.tools !== undefined) throw new Error("Auxiliary tools do not apply to an engine's review");
		return await startEngineReview({
			engine,
			target,
			controls: options.controls,
			...(options.engineParams === undefined ? {} : { params: options.engineParams }),
			remote: options.remote,
			cwd: environment.cwd,
			work: session.work,
			modelRegistry: session.modelRegistry,
			...(session.model === undefined ? {} : { model: session.model }),
			settingsManager: session.settingsManager,
			sessionManager: session.sessionManager,
			sessionWriter: session.sessionWriter,
			...(options.parentWorkId === undefined ? {} : { parentWorkId: options.parentWorkId }),
			...(options.previousRunId === undefined ? {} : { previousRunId: options.previousRunId }),
		});
	}
	// The fast preflight runs inline so target errors fail the start; the review then runs as the conversation's work.
	const prepared = await pipeline.prepare({
		target,
		controls: options.controls,
		...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
		...(options.previousRunId ? { previousRunId: options.previousRunId } : {}),
		cwd: environment.cwd,
		settingsManager: session.settingsManager,
		modelRegistry: session.modelRegistry,
		currentModel: session.model,
		sessionManager: session.sessionManager,
		requireProjectTrust: options.remote,
		sanitizeRemoteErrors: options.remote,
	});
	const thinkingLevel = session.thinkingLevel;
	const fastModeEnabled = session.fastModeEnabled;
	const modelRegistry = session.modelRegistry;
	const settingsManager = session.settingsManager;
	// Immutable snapshot tools only, unless a local caller named auxiliary tools of the conversation (never its
	// workspace file tools). A remote review gets no auxiliary or extension tools at all.
	const tools = options.remote ? REMOTE_REVIEW_TOOL_NAMES : (options.tools ?? REMOTE_REVIEW_TOOL_NAMES);
	const parentResourceLoader = options.remote ? undefined : session.resourceLoader;
	const reviewed = reviewWorkTarget(prepared.resolution);
	try {
		await session.work.start(
			"review",
			reviewWorkInput(prepared.action, reviewed),
			async (ctx) => {
				try {
					const result = await pipeline.execute({
						prepared,
						cwd: environment.cwd,
						agentDir: environment.agentDir,
						authStorage: modelRegistry.authStorage,
						modelRegistry,
						settingsManager,
						sessionWriter: session.sessionWriter,
						sanitizeRemoteErrors: options.remote,
						thinkingLevel,
						fastModeEnabled,
						parentResourceLoader,
						tools,
						signal: ctx.signal,
						passes: session.reviewPasses,
						work: ctx,
					});
					if (options.remote && result.status === "failed") {
						return { outcome: "failed", error: REMOTE_REVIEW_FAILURE_MESSAGE };
					}
					return reviewWorkExecution(result, reviewed);
				} catch (error) {
					if (options.remote) return { outcome: "failed", error: REMOTE_REVIEW_FAILURE_MESSAGE };
					throw error;
				}
			},
			{
				workId: prepared.workflowId,
				...(options.parentWorkId === undefined ? {} : { parentWorkId: options.parentWorkId }),
			},
		);
	} catch (error) {
		await prepared.resolution.dispose();
		throw error;
	}
	return {
		workId: prepared.workflowId,
		...(prepared.modelWarning === undefined || options.remote ? {} : { message: prepared.modelWarning }),
	};
}
