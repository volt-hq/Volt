/**
 * Projection-truncation metadata and workflow event schemas. The recursive
 * `RpcProjectionTruncation` keeps its hand-written interface in types.ts and
 * is pinned here via `Type.Unsafe` + `Type.Cyclic` — the one place recursion
 * makes a derived static type more fragile than the source of truth.
 */

import { Type } from "typebox";
import type { RpcProjectionTruncation } from "../types.ts";
import { openStringEnum, stringEnum } from "./helpers.ts";

export const RpcWorkflowKindSchema = openStringEnum(["review"]);
export const RpcWorkflowStatusSchema = openStringEnum(["running", "finalizing", "completed", "cancelled", "failed"]);

/** Describes a value whose wire projection was reduced to satisfy a byte budget. */
export const RpcProjectionTruncationSchema = Type.Unsafe<RpcProjectionTruncation>(
	Type.Cyclic(
		{
			RpcProjectionTruncation: Type.Object(
				{
					truncated: Type.Literal(true),
					originalBytes: Type.Union([Type.Number(), Type.Null()]),
					projectedBytes: Type.Number(),
					omittedEntries: Type.Optional(Type.Number()),
					fields: Type.Optional(Type.Record(Type.String(), Type.Ref("RpcProjectionTruncation"))),
				},
				{ additionalProperties: false },
			),
		},
		"RpcProjectionTruncation",
	),
);

/** Describes a bounded ordered collection. Included entries always retain source order. */
export const RpcProjectionCollectionTruncationSchema = Type.Object(
	{
		truncated: Type.Literal(true),
		originalBytes: Type.Union([Type.Number(), Type.Null()]),
		projectedBytes: Type.Number(),
		omittedEntries: Type.Optional(Type.Number()),
		fields: Type.Optional(Type.Record(Type.String(), RpcProjectionTruncationSchema)),
		totalCount: Type.Number(),
		projectedCount: Type.Number(),
		omittedCount: Type.Number(),
		truncatedItems: Type.Optional(
			Type.Array(
				Type.Object(
					{
						index: Type.Number(),
						originalBytes: Type.Union([Type.Number(), Type.Null()]),
						projectedBytes: Type.Number(),
					},
					{ additionalProperties: false },
				),
			),
		),
		/** Stable source identifiers for entries omitted after the projected prefix. */
		omittedItemIds: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

export const RpcWorkflowEventSchema = Type.Object(
	{
		type: stringEnum(["workflow_start", "workflow_update", "workflow_end"]),
		workflowId: Type.String(),
		kind: RpcWorkflowKindSchema,
		action: Type.Optional(Type.String()),
		title: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
		status: Type.Optional(RpcWorkflowStatusSchema),
		projection: Type.Optional(RpcProjectionTruncationSchema),
	},
	{ additionalProperties: false },
);

export const RpcWorkflowToolEventSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("tool_execution_start"),
			workflowId: Type.String(),
			workflowKind: RpcWorkflowKindSchema,
			workflowAction: Type.String(),
			toolCallId: Type.String(),
			toolName: Type.String(),
			args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
			projection: Type.Optional(RpcProjectionTruncationSchema),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			type: Type.Literal("tool_execution_end"),
			workflowId: Type.String(),
			workflowKind: RpcWorkflowKindSchema,
			workflowAction: Type.String(),
			toolCallId: Type.String(),
			toolName: Type.String(),
			isError: Type.Boolean(),
			projection: Type.Optional(RpcProjectionTruncationSchema),
		},
		{ additionalProperties: false },
	),
]);

// ============================================================================
// Detached review workflows
// ============================================================================

export const RpcReviewWorkflowLifecycleStatusSchema = stringEnum(["running", "completed", "cancelled", "failed"]);

const reviewWorkflowDescriptorProperties = {
	workflowId: Type.String(),
	/** Review host-action id, e.g. `review.branch`. */
	action: Type.String(),
	status: RpcReviewWorkflowLifecycleStatusSchema,
	target: Type.Object({ description: Type.String(), diffCommand: Type.String() }, { additionalProperties: false }),
	findingsCount: Type.Optional(Type.Number()),
	errorMessage: Type.Optional(Type.String()),
	startedAt: Type.Number(),
	endedAt: Type.Optional(Type.Number()),
};

export const RpcReviewWorkflowDescriptorSchema = Type.Object(reviewWorkflowDescriptorProperties, {
	additionalProperties: false,
});

/** Wire projection of core/review.ts ReviewFinding (pinned in type-assertions.ts). */
export const RpcReviewFindingSchema = Type.Object(
	{
		title: Type.String(),
		body: Type.String(),
		/** 0 = must fix, 1 = should fix, 2 = worth fixing, 3 = optional. */
		priority: Type.Optional(Type.Number()),
		/** 0.0 - 1.0 */
		confidence: Type.Optional(Type.Number()),
		file: Type.Optional(Type.String()),
		line: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/** Wire projection of core/review.ts ReviewCoverage (pinned in type-assertions.ts). */
export const RpcReviewCoverageSchema = Type.Object(
	{
		filesReviewed: Type.Array(Type.String()),
		commandsRun: Type.Array(Type.String()),
		uncheckedAreas: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcReviewWorkflowResultResponseSchema = Type.Object(
	{
		...reviewWorkflowDescriptorProperties,
		findings: Type.Optional(Type.Array(RpcReviewFindingSchema)),
		coverage: Type.Optional(RpcReviewCoverageSchema),
		overallCorrectness: Type.Optional(Type.String()),
		overallExplanation: Type.Optional(Type.String()),
		/** Bounded raw reviewer text; present only when the report had no parseable findings payload. */
		raw: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const RpcReviewWorkflowListResponseSchema = Type.Object(
	{ workflows: Type.Array(RpcReviewWorkflowDescriptorSchema) },
	{ additionalProperties: false },
);
