/**
 * Review run projections: the durable review runs, findings, coverage, and
 * target metadata clients read with the review queries.
 */

import { Type } from "typebox";
import { stringEnum } from "./helpers.ts";
import { RpcSafeNonNegativeIntegerSchema } from "./primitives.ts";
import { ReviewUsageAccountingSchema, ReviewUsageSummarySchema } from "./review-usage.ts";

const reviewPullRequestReferenceProperties = {
	provider: Type.String({ minLength: 1, maxLength: 64, pattern: "^[^\\s\\x00-\\x1f\\x7f]+$" }),
	number: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
};

export const RpcReviewPullRequestMetadataSchema = Type.Object(
	{
		...reviewPullRequestReferenceProperties,
		title: Type.String({ minLength: 1, maxLength: 512 }),
		url: Type.String({ minLength: 1, maxLength: 2_000 }),
		baseRefName: Type.String({ minLength: 1, maxLength: 1_024 }),
		headRefName: Type.String({ minLength: 1, maxLength: 1_024 }),
		headRefOid: Type.String({ pattern: "^(?:[0-9a-f]{40}|[0-9a-f]{64})$" }),
		author: Type.Optional(
			Type.Object(
				{
					login: Type.String({ minLength: 1, maxLength: 256 }),
					avatarUrl: Type.Optional(Type.String({ maxLength: 2_000, pattern: "^https://" })),
				},
				{ additionalProperties: false },
			),
		),
		reviewState: Type.Optional(stringEnum(["draft", "ready", "merged", "closed"])),
		mergeability: Type.Optional(stringEnum(["mergeable", "conflicting", "unknown"])),
		checks: Type.Optional(
			Type.Object(
				{
					state: stringEnum(["passing", "pending", "failing", "none", "unknown"]),
					totalCount: RpcSafeNonNegativeIntegerSchema,
					passedCount: RpcSafeNonNegativeIntegerSchema,
					pendingCount: RpcSafeNonNegativeIntegerSchema,
					failedCount: RpcSafeNonNegativeIntegerSchema,
					neutralCount: RpcSafeNonNegativeIntegerSchema,
					unknownCount: RpcSafeNonNegativeIntegerSchema,
				},
				{ additionalProperties: false },
			),
		),
		observedAt: Type.Optional(RpcSafeNonNegativeIntegerSchema),
	},
	{ additionalProperties: false },
);

export const RpcReviewFileMetadataSchema = Type.Object(
	{
		totalCount: RpcSafeNonNegativeIntegerSchema,
		projectedCount: RpcSafeNonNegativeIntegerSchema,
		omittedCount: RpcSafeNonNegativeIntegerSchema,
		additions: RpcSafeNonNegativeIntegerSchema,
		deletions: RpcSafeNonNegativeIntegerSchema,
		isComplete: Type.Boolean(),
		items: Type.Array(
			Type.Object(
				{
					path: Type.String({ minLength: 1, maxLength: 4_096 }),
					previousPath: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
					status: stringEnum(["added", "modified", "deleted", "renamed", "copied", "type-changed"]),
					additions: RpcSafeNonNegativeIntegerSchema,
					deletions: RpcSafeNonNegativeIntegerSchema,
				},
				{ additionalProperties: false },
			),
			{ maxItems: 200 },
		),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Review runs
// ============================================================================

export const RpcReviewRunStatusSchema = stringEnum(["completed", "incomplete", "cancelled", "failed"]);
export const RpcReviewCompletionStatusSchema = stringEnum(["complete", "incomplete"]);
export const RpcReviewCorrectnessSchema = stringEnum(["correct", "incorrect"]);
export const RpcReviewFindingStatusSchema = stringEnum(["open", "accepted", "fixed", "dismissed", "uncertain"]);

export const RpcReviewLocationSchema = Type.Object(
	{
		path: Type.String(),
		side: stringEnum(["base", "head"]),
		startLine: Type.Integer({ minimum: 1 }),
		endLine: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

/** Complete wire projection of core/review-report.ts ReviewFinding. */
export const RpcReviewFindingSchema = Type.Object(
	{
		id: Type.String(),
		fingerprint: Type.String(),
		status: RpcReviewFindingStatusSchema,
		title: Type.String(),
		body: Type.String(),
		trigger: Type.String(),
		impact: Type.String(),
		category: Type.String(),
		rootCauseKey: Type.String(),
		priority: Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
		confidence: Type.Number({ minimum: 0, maximum: 1 }),
		changeLocation: RpcReviewLocationSchema,
		evidenceLocations: Type.Array(RpcReviewLocationSchema),
		verification: Type.Object(
			{
				outcome: Type.Literal("accepted"),
				method: Type.String(),
				rationale: Type.String(),
				confidence: Type.Number({ minimum: 0, maximum: 1 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

/** Host-observed review coverage; no model-authored compatibility fields. */
export const RpcReviewCoverageSchema = Type.Object(
	{
		changedFileInventoryComplete: Type.Boolean(),
		context: Type.Optional(
			Type.Object(
				{
					captureStatus: stringEnum(["complete", "incomplete"]),
					linkedIssueCount: Type.Integer({ minimum: 0 }),
					discussionEntryCount: Type.Integer({ minimum: 0 }),
					limitationCodes: Type.Array(Type.String()),
					fingerprint: Type.String(),
					discoveryInspectionComplete: Type.Boolean(),
					verificationInspectionComplete: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
		filesInspected: Type.Array(Type.String()),
		hunksInspected: Type.Array(Type.String()),
		commandsRun: Type.Array(Type.String()),
		failedVerificationAttempts: Type.Array(Type.String()),
		exclusions: Type.Array(
			Type.Object({ path: Type.String(), reason: Type.String() }, { additionalProperties: false }),
		),
		uncheckedAreas: Type.Array(Type.String()),
		residualRisk: Type.Array(Type.String()),
		modelReportedLimitations: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcReviewOptionsSchema = Type.Object(
	{
		focus: Type.Optional(Type.String()),
		scope: Type.Array(Type.String()),
		effort: stringEnum(["low", "standard", "high"]),
		includeOptional: Type.Boolean(),
		scopeMode: stringEnum(["incremental", "full"]),
	},
	{ additionalProperties: false },
);

export const RpcReviewTargetIdentitySchema = Type.Object(
	{
		kind: stringEnum(["uncommitted", "branch", "branch_uncommitted", "pr", "commit"]),
		baseTree: Type.String(),
		headTree: Type.String(),
		baseCommit: Type.Optional(Type.String()),
		mergeBaseCommit: Type.Optional(Type.String()),
		headCommit: Type.Optional(Type.String()),
		pullRequest: Type.Optional(
			Type.Object(
				{
					number: Type.Integer(),
					title: Type.String(),
					body: Type.Optional(Type.String()),
					url: Type.String(),
					baseRefName: Type.String(),
					headRefName: Type.String(),
					baseRefOid: Type.String(),
					headRefOid: Type.String(),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

const reviewRunProperties = {
	runId: Type.String(),
	workflowAction: Type.String(),
	status: RpcReviewRunStatusSchema,
	startedAt: Type.Number(),
	endedAt: Type.Number(),
	usage: Type.Optional(
		Type.Union([
			ReviewUsageSummarySchema,
			Type.Object({ status: Type.Literal("unavailable") }, { additionalProperties: false }),
		]),
	),
	usageUpdatedAt: Type.Optional(Type.Number()),
	acknowledgedAt: Type.Optional(Type.Number()),
	target: Type.Object(
		{
			description: Type.String(),
			diffCommand: Type.String(),
			identity: RpcReviewTargetIdentitySchema,
			pullRequest: Type.Optional(RpcReviewPullRequestMetadataSchema),
			files: RpcReviewFileMetadataSchema,
			context: Type.Optional(
				Type.Object(
					{
						captureStatus: stringEnum(["complete", "incomplete"]),
						linkedIssueCount: Type.Integer({ minimum: 0 }),
						discussionEntryCount: Type.Integer({ minimum: 0 }),
						renderedLinkedIssueCount: Type.Integer({ minimum: 0 }),
						renderedDiscussionEntryCount: Type.Integer({ minimum: 0 }),
						renderedBytes: Type.Integer({ minimum: 0 }),
						limitationCodes: Type.Array(Type.String()),
						fingerprint: Type.String(),
					},
					{ additionalProperties: false },
				),
			),
		},
		{ additionalProperties: false },
	),
	options: RpcReviewOptionsSchema,
	parentRunId: Type.Optional(Type.String()),
	incrementalFallbackReason: Type.Optional(Type.String()),
	errorMessage: Type.Optional(Type.String()),
};

export const RpcReviewWorkflowResultResponseSchema = Type.Object(
	{
		...reviewRunProperties,
		usageBreakdown: Type.Optional(ReviewUsageAccountingSchema.properties.attempts),
		completionStatus: Type.Optional(RpcReviewCompletionStatusSchema),
		summary: Type.Optional(Type.String()),
		findings: Type.Optional(Type.Array(RpcReviewFindingSchema)),
		coverage: Type.Optional(RpcReviewCoverageSchema),
		overallCorrectness: Type.Optional(RpcReviewCorrectnessSchema),
		overallExplanation: Type.Optional(Type.String()),
		verificationChallenge: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcReviewRunDescriptorSchema = Type.Object(
	{
		...reviewRunProperties,
		completionStatus: Type.Optional(RpcReviewCompletionStatusSchema),
		findingsCount: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	{ additionalProperties: false },
);

export const RpcReviewWorkflowListResponseSchema = Type.Object(
	{
		runs: Type.Array(RpcReviewRunDescriptorSchema),
		nextCursor: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcReviewAcknowledgmentResponseSchema = Type.Object(
	{
		runId: Type.String(),
		acknowledgedAt: Type.Number(),
	},
	{ additionalProperties: false },
);
