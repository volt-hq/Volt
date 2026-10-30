/**
 * Review usage accounting schemas: per-attempt token and cost totals and their
 * summary, carried by review workflow results.
 */

import type { Usage } from "@hansjm10/volt-ai";
import { type Static, Type } from "typebox";
import type { Assert, MutualExtends } from "./helpers.ts";

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const availability = Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("unavailable")]);
/** Provider service tier a review request asked for or ran under. */
export const ReviewServiceTierSchema = Type.Union(
	["auto", "default", "flex", "scale", "priority"].map((value) => Type.Literal(value)),
);
export const ReviewUsageTokensSchema = Type.Object(
	{ input: count, output: count, cacheRead: count, cacheWrite: count },
	{ additionalProperties: false },
);
/**
 * Estimated cost in USD from the model price table: the priced components of volt-ai's `Usage["cost"]`.
 * Pinned below, so a component added to that cost fails typecheck until it is added here or excluded.
 */
export const ReviewUsageCostSchema = Type.Object(
	{
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
/** `priceVersion` identifies the rates a cost was priced with; review totals sum across rates, so it is not kept. */
type ReviewPricedCost = Omit<Usage["cost"], "priceVersion">;
type _reviewUsageCostKeys = Assert<MutualExtends<keyof Static<typeof ReviewUsageCostSchema>, keyof ReviewPricedCost>>;
type _reviewUsageCost = Assert<MutualExtends<Static<typeof ReviewUsageCostSchema>, ReviewPricedCost>>;
const totals = {
	requests: count,
	turns: count,
	pendingRequests: count,
	unavailableRequests: count,
	partialRequests: count,
	tokens: Type.Optional(ReviewUsageTokensSchema),
	estimatedCost: Type.Optional(ReviewUsageCostSchema),
};
export const ReviewUsageSummarySchema = Type.Object(
	{
		status: availability,
		costBasis: Type.Literal("model-priced-usd"),
		...totals,
	},
	{ additionalProperties: false },
);
const attempt = Type.Object(
	{
		passId: Type.Integer({ minimum: 1 }),
		phase: Type.Union([Type.Literal("discovery"), Type.Literal("verification"), Type.Literal("presentation")]),
		purpose: Type.Union([Type.Literal("findings"), Type.Literal("challenge")]),
		round: Type.Integer({ minimum: 1 }),
		attempt: Type.Integer({ minimum: 1 }),
		kind: Type.Union([Type.Literal("turn"), Type.Literal("compaction")]),
		provider: Type.String({ minLength: 1, maxLength: 256 }),
		model: Type.String({ minLength: 1, maxLength: 256 }),
		requestedTier: Type.Optional(ReviewServiceTierSchema),
		effectiveTier: Type.Optional(ReviewServiceTierSchema),
		...totals,
	},
	{ additionalProperties: false },
);
export const ReviewUsageAccountingSchema = Type.Object(
	{
		revision: count,
		updatedAt: count,
		finalized: Type.Boolean(),
		summary: ReviewUsageSummarySchema,
		attempts: Type.Array(attempt, { maxItems: 1024 }),
	},
	{ additionalProperties: false },
);
export type ReviewUsageAccounting = Static<typeof ReviewUsageAccountingSchema>;
export type ReviewUsageSummary = Static<typeof ReviewUsageSummarySchema>;
