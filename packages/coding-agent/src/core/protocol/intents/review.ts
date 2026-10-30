/**
 * Review intents: starting reviews (`review` work items on hosts that run
 * them detached), lifecycle operations on durable review runs, and review
 * discussions. A review discussion's source owns the lifecycle operations.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { IntentOption } from "@hansjm10/volt-protocol";
import { parseCodeHostPullRequestUrl } from "../../code-host/identity.ts";
import { openReviewFindings } from "../../host/review-handoff.ts";
import {
	type CurrentBranchPullRequest,
	linkedCurrentBranchPullRequest,
	listBaseBranches,
	listRecentCommits,
	MUTABLE_WORKSPACE_REVIEW_TOOLS,
	probeCurrentBranchPullRequest,
	type ReviewTarget,
	reviewTargetForRerun,
} from "../../review.ts";
import {
	ReviewDiscussionConfigurationError,
	ReviewDiscussionRequestConflictError,
	type ReviewDiscussionService,
} from "../../review-discussions.ts";
import { ReviewEngineParametersError, resolveReviewEngineParameters } from "../../review-engine.ts";
import { ReviewSourceUnavailableError } from "../../review-links.ts";
import { publishReviewRun } from "../../review-publish.ts";
import {
	acknowledgeReviewRun,
	appendReviewPublication,
	exportCanonicalReviewFeedback,
	getCanonicalReviewRun,
	recordReviewFindingOutcome,
	reviewRunEngine,
	reviewRunEngineLabel,
	STANDARD_REVIEW_ENGINE,
} from "../../review-state.ts";
import { localOnlyInput, targetOf } from "./conversation.ts";
import { boundedDisplayString, MAX_INTENT_COMPLETIONS, MAX_INTENT_LABEL_LENGTH } from "./dynamic.ts";
import { isIntentStateBusy } from "./state.ts";
import {
	defineIntent,
	INTENT_ENABLED,
	type IntentAvailability,
	type IntentContext,
	IntentRejectedError,
	type IntentReviewOptions,
	type IntentView,
	missingCapability,
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
	/** The review engine: the built-in pipeline when absent or `standard`. */
	engine?: string;
	/** The engine's own options by parameter name. */
	engineParams?: Record<string, string | boolean | number>;
	focus?: string;
	scope?: string;
	effort?: "low" | "standard" | "high";
	includeOptional?: boolean;
	scopeMode?: "incremental" | "full";
	tools?: string[];
	setup?: { command: string; timeoutMs?: number };
	/** A pull request review's pinned pull request. */
	url?: string;
}

/** A review start: the target and the fields that belong to one target, with the controls every target takes. */
interface ReviewStartInput extends ReviewControlsInput {
	target: "uncommitted" | "branch" | "branch_uncommitted" | "pr" | "commit";
	/** A branch review's base: for `branch` and `branch_uncommitted`. */
	base?: string;
	/** A pull request review's number. */
	number?: string;
	/** A commit review's ref. */
	ref?: string;
}

/**
 * A review start: refused on remote profiles that name auxiliary tools, a checkout setup, or pin a pull request, else
 * as reviews are available.
 */
function reviewStartAvailability(view: IntentView, input?: ReviewControlsInput): IntentAvailability {
	const localOnly = localOnlyInput<ReviewControlsInput>(["tools", "setup", "url"])(view, input);
	return localOnly.enabled ? reviewAvailability(view) : localOnly;
}

/**
 * The auxiliary tools a local client named for a review: tools of the
 * conversation besides its workspace file tools (read, grep, find, ls, edit,
 * write), as the TUI's review tools are. With any, the passes run in a
 * disposable checkout of the reviewed head; a command-capable tool such as
 * `bash` is otherwise unrestricted, and sees what the review's prompts carry
 * (a pull request's text included). The immutable snapshot tools are always on.
 */
function reviewTools(ctx: IntentContext, tools: readonly string[] | undefined): readonly string[] | undefined {
	if (tools === undefined) return undefined;
	const available = new Set(
		targetOf(ctx)
			.session.getAllTools()
			.map((tool) => tool.name),
	);
	const refused = tools.filter((name) => !available.has(name) || MUTABLE_WORKSPACE_REVIEW_TOOLS.has(name));
	if (refused.length > 0) {
		throw new IntentRejectedError("invalid_input", `Not available to reviews: ${refused.join(", ")}`);
	}
	return tools;
}

/**
 * The extension engine a review start names, or none for the built-in pipeline. The conversation must have the
 * engine, it must review the target, and a remote device may start only an engine that allows it. Auxiliary tools
 * reach an engine as they do the built-in pipeline.
 */
function reviewEngineOf(
	ctx: IntentContext,
	input: ReviewControlsInput,
	target: ReviewTarget,
): { id: string; params: Readonly<Record<string, string | boolean | number>> | undefined } | undefined {
	if (input.engine === undefined || input.engine === STANDARD_REVIEW_ENGINE) {
		if (input.engineParams !== undefined) {
			throw new IntentRejectedError("invalid_input", "Engine options need an engine other than standard");
		}
		return undefined;
	}
	const engine = targetOf(ctx).session.reviewEngines.get(input.engine);
	if (!engine) throw new IntentRejectedError("invalid_input", `Unknown review engine: ${input.engine}`);
	if (!engine.targets.includes(target.kind)) {
		throw new IntentRejectedError(
			"invalid_input",
			`The ${engine.label} engine does not review a ${target.kind} target`,
		);
	}
	if (ctx.profile.name === "remote" && !engine.remoteSafe) {
		throw new IntentRejectedError("not_allowed", `The ${engine.label} engine is not available to remote clients`);
	}
	try {
		// Checked here to refuse early and by name; the run checks them again against the engine it runs.
		resolveReviewEngineParameters(engine, input.engineParams, { remote: ctx.profile.name === "remote" });
		return { id: engine.id, params: input.engineParams };
	} catch (error) {
		if (error instanceof ReviewEngineParametersError) {
			throw new IntentRejectedError(error.reason === "local_only" ? "not_allowed" : "invalid_input", error.message);
		}
		throw error;
	}
}

/** Remote reviews confirm before they start, require project trust, and sanitize failures. */
function reviewOptions(
	ctx: IntentContext,
	input: ReviewControlsInput,
	engine?: { id: string; params: Readonly<Record<string, string | boolean | number>> | undefined },
): IntentReviewOptions {
	const remote = ctx.profile.name === "remote";
	const tools = remote ? undefined : reviewTools(ctx, input.tools);
	const setup = remote ? undefined : input.setup;
	// A setup prepares the checkout auxiliary tools run in: without them there is none.
	if (setup !== undefined && (tools === undefined || tools.length === 0)) {
		throw new IntentRejectedError(
			"invalid_input",
			"A review's setup applies with auxiliary tools: name them in tools",
		);
	}
	return {
		remote,
		requireConfirmation: remote,
		...(engine === undefined ? {} : { engine: engine.id }),
		...(engine?.params === undefined ? {} : { engineParams: engine.params }),
		...(tools === undefined ? {} : { tools }),
		...(setup === undefined ? {} : { setup }),
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

/** A started review answers its work id; a review a host runs to completion answers nothing. */
function acceptReview(outcome: Awaited<ReturnType<typeof runReview>>) {
	return outcome.status === "accepted" ? { result: { workId: outcome.workId } } : {};
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
	available: reviewStartAvailability,
	accept: acceptReview,
} as const;

/**
 * Logical base branches from the workspace (the same collapsed local and
 * upstream set as the TUI picker), prefix-filtered and bounded. Not a git
 * repository: no candidates.
 */
async function completeBaseBranches(ctx: IntentContext, prefix: string): Promise<IntentOption[]> {
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

/**
 * Reads by key, in flight or fresh for `ttlMs`: completing as a user types
 * reads each once.
 */
function cachedReads<T>(ttlMs: number): (key: string, read: () => Promise<T>) => Promise<T> {
	const reads = new Map<string, { readonly at: number; readonly value: Promise<T> }>();
	return (key, read) => {
		const now = Date.now();
		for (const [cachedKey, cached] of reads) {
			if (now - cached.at >= ttlMs) reads.delete(cachedKey);
		}
		const cached = reads.get(key);
		if (cached) return cached.value;
		const value = read();
		reads.set(key, { at: now, value });
		return value;
	};
}

/** Reads of the workspace's Git history and code host, by cwd. */
function readsPerCwd<T>(ttlMs: number, read: (cwd: string) => Promise<T>): (cwd: string) => Promise<T> {
	const reads = cachedReads<T>(ttlMs);
	return (cwd) => reads(cwd, () => read(cwd));
}

const recentCommits = readsPerCwd(5_000, (cwd) => listRecentCommits(cwd).catch(() => ({ error: "git log failed" })));

/** The current branch's pull request, probed through the code host at most every 30 seconds. */
const currentPullRequest = readsPerCwd(30_000, (cwd) => probeCurrentBranchPullRequest(cwd).catch(() => undefined));

/** The pull request the host's change association linked a conversation to, read at most every 5 seconds. */
const linkedPullRequests = cachedReads<CurrentBranchPullRequest | undefined>(5_000);

/**
 * The current branch's pull request: the one the host's change association
 * linked the conversation to, when the host has it and it still applies,
 * else probed through the code host.
 */
async function currentBranchPullRequest(ctx: IntentContext): Promise<CurrentBranchPullRequest | undefined> {
	const { session, conversation } = targetOf(ctx);
	const cwd = session.sessionManager.getCwd();
	const changePullRequest = ctx.services.changePullRequest;
	const linked =
		changePullRequest &&
		(await linkedPullRequests(conversation.id, () =>
			changePullRequest()
				.then((pullRequest) =>
					linkedCurrentBranchPullRequest(cwd, session.gitContextProvider.getSnapshot(), pullRequest),
				)
				.catch(() => undefined),
		));
	return linked ?? currentPullRequest(cwd);
}

/**
 * Whether completing may read the workspace's Git history or code host for
 * the client: a remote client only with the capabilities a review start
 * needs, in a trusted project, as a remote review requires.
 */
function readsWorkspace(ctx: IntentContext): boolean {
	if (ctx.profile.name === "local") return true;
	return (
		missingCapability(ctx.profile.grant, control) === undefined &&
		targetOf(ctx).session.settingsManager.isProjectTrusted()
	);
}

/**
 * Recent commits of the workspace (the TUI picker's list), newest first, by
 * abbreviated hash prefix, bounded. Not a git repository: no candidates.
 */
async function completeCommits(ctx: IntentContext, prefix: string): Promise<IntentOption[]> {
	if (!readsWorkspace(ctx)) return [];
	const commits = await recentCommits(targetOf(ctx).session.sessionManager.getCwd());
	if (!Array.isArray(commits)) return [];
	const normalizedPrefix = prefix.toLowerCase();
	return commits
		.filter((commit) => /^[0-9a-f]+$/i.test(commit.sha) && commit.sha.toLowerCase().startsWith(normalizedPrefix))
		.slice(0, MAX_INTENT_COMPLETIONS)
		.map((commit) => {
			const label = boundedDisplayString(commit.subject, MAX_INTENT_LABEL_LENGTH);
			const description = boundedDisplayString(commit.date, MAX_INTENT_LABEL_LENGTH);
			return {
				value: commit.sha,
				...(label === undefined ? {} : { label }),
				...(description === undefined ? {} : { description }),
			};
		});
}

/** The current branch's pull request (the TUI picker's first choice), when its number starts with `prefix`. */
async function completePullRequests(ctx: IntentContext, prefix: string): Promise<IntentOption[]> {
	if (!readsWorkspace(ctx)) return [];
	const pullRequest = await currentBranchPullRequest(ctx);
	if (!pullRequest) return [];
	const value = String(pullRequest.number);
	if (!value.startsWith(prefix.trim())) return [];
	const label = boundedDisplayString(`#${value} ${pullRequest.title}`, MAX_INTENT_LABEL_LENGTH);
	return [{ value, ...(label === undefined ? {} : { label }), description: "Current branch" }];
}

/**
 * The current branch's pull request by its URL, which pins it for a local
 * client's review (`review{target: "pr", url}`), when the URL starts with `prefix`.
 */
async function completePullRequestUrls(ctx: IntentContext, prefix: string): Promise<IntentOption[]> {
	if (ctx.profile.name !== "local") return [];
	const pullRequest = await currentBranchPullRequest(ctx);
	if (!pullRequest?.url.startsWith(prefix.trim())) return [];
	const label = boundedDisplayString(`#${pullRequest.number} — ${pullRequest.title}`, MAX_INTENT_LABEL_LENGTH);
	return [{ value: pullRequest.url, ...(label === undefined ? {} : { label }), description: "Current branch" }];
}

/**
 * The pull request a review targets: by number, or the one `url` pins, which
 * the code host must resolve the same (its number, when both are given).
 */
function pullRequestTarget(input: { number?: string; url?: string }): ReviewTarget {
	const number = input.number?.trim() || undefined;
	if (input.url === undefined) return { kind: "pr", number };
	const pinned = parseCodeHostPullRequestUrl(input.url);
	if (!pinned) throw new IntentRejectedError("invalid_input", "Not a supported pull request URL");
	if (number !== undefined && number !== String(pinned.number)) {
		throw new IntentRejectedError("invalid_input", "The pull request number does not match its URL");
	}
	return { kind: "pr", number: String(pinned.number), expectedUrl: pinned.url };
}

/** The input fields that belong to one review target; a field of another target is refused. */
const REVIEW_TARGET_FIELDS = {
	uncommitted: [],
	branch: ["base"],
	branch_uncommitted: ["base"],
	pr: ["number", "url"],
	commit: ["ref"],
} as const satisfies Record<ReviewStartInput["target"], readonly string[]>;

/** The target a review start names, refusing a field of another target and a commit review without a ref. */
function reviewTargetOf(input: ReviewStartInput): ReviewTarget {
	const applies: readonly string[] = REVIEW_TARGET_FIELDS[input.target];
	for (const field of ["base", "number", "url", "ref"] as const) {
		if (input[field] !== undefined && !applies.includes(field)) {
			throw new IntentRejectedError("invalid_input", `${field} does not apply to a ${input.target} review`);
		}
	}
	switch (input.target) {
		case "uncommitted":
			return { kind: "uncommitted" };
		case "branch":
			return { kind: "branch", base: input.base?.trim() || undefined };
		case "branch_uncommitted":
			return { kind: "branch_uncommitted", base: input.base?.trim() || undefined };
		case "pr":
			return pullRequestTarget(input);
		case "commit":
			if (input.ref === undefined) throw new IntentRejectedError("invalid_input", "A commit review needs a ref");
			return { kind: "commit", sha: input.ref };
	}
}

export const reviewIntent = defineIntent({
	...reviewStart,
	name: "review",
	label: "Review",
	description:
		"Review code changes. uncommitted: the uncommitted workspace changes. branch: the current branch against a refreshed upstream merge base, using host Git credentials and network; full refs use local cached state. branch_uncommitted: the same comparison, plus the uncommitted and untracked changes in the workspace. pr: a pull request using the built-in code-host provider that matches the repository remote (GitHub CLI, or the Azure DevOps REST API), host credentials, and network; its metadata, diff, authoritative linked issues, comments, submitted review summaries, and inline review threads are sent to discovery and verification, while retained finding prose is rendered separately without code-host context. commit: a commit from workspace history; its metadata and diff are sent to the review model.",
	presentation: { kind: "card", group: "Review", priority: 100, icon: "magnifyingglass" },
	slash: {
		name: "review",
		example: "/review uncommitted | branch [base] | branch-uncommitted [base] | pr [number] | commit [ref]",
	},
	completions: ["base", "number", "url", "ref"],
	complete: async (ctx, field, prefix) => {
		switch (field) {
			case "base":
				return await completeBaseBranches(ctx, prefix);
			case "number":
				return await completePullRequests(ctx, prefix);
			case "url":
				return await completePullRequestUrls(ctx, prefix);
			case "ref":
				return await completeCommits(ctx, prefix);
			default:
				return [];
		}
	},
	run: (ctx, input) => {
		const target = reviewTargetOf(input);
		return runReview(ctx, target, reviewOptions(ctx, input, reviewEngineOf(ctx, input, target)));
	},
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
		// A rerun replays the built-in pipeline: an engine's run is not one it can reproduce.
		if (reviewRunEngine(record) !== STANDARD_REVIEW_ENGINE) {
			throw new IntentRejectedError(
				"invalid_input",
				`This review ran on the ${reviewRunEngineLabel(record)} engine and cannot be rerun`,
			);
		}
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
		const { host, client, session } = targetOf(ctx);
		return await openReviewFindings(
			{ host, client, sessionManager: session.sessionManager },
			input.runId,
			input.findingIds,
			ctx.assertCurrent,
		);
	},
	accept: (opened) =>
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
	description: "Publish a complete, non-stale pull request review.",
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

/**
 * Run a review discussion operation. A source that changed or is unavailable
 * surfaces as one stable error, and a reset request id reused for another
 * predecessor as a conflict; any other failure, a stale branch included,
 * surfaces as it is.
 */
export async function runReviewDiscussion<T>(
	ctx: IntentContext,
	operation: (service: ReviewDiscussionService) => Promise<T>,
): Promise<T> {
	const service = reviewDiscussionsOf(ctx);
	ctx.assertCurrent?.();
	try {
		return await operation(service);
	} catch (error) {
		if (error instanceof ReviewDiscussionConfigurationError) throw new Error(error.message);
		if (error instanceof ReviewDiscussionRequestConflictError) {
			throw new IntentRejectedError("conflict", error.message);
		}
		if (error instanceof ReviewSourceUnavailableError) {
			throw new CodedIntentError(
				"review_source_unavailable",
				"Review source identity, placement, or runtime admission changed",
			);
		}
		throw error;
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
