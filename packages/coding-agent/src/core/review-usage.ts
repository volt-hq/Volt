import { isDeepStrictEqual } from "node:util";
import type { Api, Model } from "@hansjm10/volt-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { InferenceAccountingRequest } from "./inference-accounting.ts";

const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const availability = Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("unavailable")]);
const tier = Type.Union(["auto", "default", "flex", "scale", "priority"].map((value) => Type.Literal(value)));
const tokens = Type.Object(
	{ input: count, output: count, cacheRead: count, cacheWrite: count },
	{ additionalProperties: false },
);
const cost = Type.Object(
	{
		input: Type.Number({ minimum: 0 }),
		output: Type.Number({ minimum: 0 }),
		cacheRead: Type.Number({ minimum: 0 }),
		cacheWrite: Type.Number({ minimum: 0 }),
		total: Type.Number({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
const totals = {
	requests: count,
	turns: count,
	pendingRequests: count,
	unavailableRequests: count,
	partialRequests: count,
	tokens: Type.Optional(tokens),
	estimatedCost: Type.Optional(cost),
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
		requestedTier: Type.Optional(tier),
		effectiveTier: Type.Optional(tier),
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
type Attempt = Static<typeof attempt>;
type Totals = Omit<ReviewUsageSummary, "status" | "costBasis">;
export type ReviewUsageAttempt = Pick<Attempt, "passId" | "phase" | "purpose" | "round" | "attempt" | "kind">;

const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const emptyCost = () => ({ ...emptyTokens(), total: 0 });
const emptyTotals = (): Totals => ({
	requests: 0,
	turns: 0,
	pendingRequests: 0,
	unavailableRequests: 0,
	partialRequests: 0,
});
export const UNAVAILABLE_REVIEW_USAGE = { status: "unavailable" as const };

function add(target: Totals, source: Totals): void {
	for (const key of ["requests", "turns", "pendingRequests", "unavailableRequests", "partialRequests"] as const)
		target[key] += source[key];
	if (source.tokens) {
		target.tokens ??= emptyTokens();
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
			target.tokens[key] += source.tokens[key];
	}
	if (source.estimatedCost) {
		target.estimatedCost ??= emptyCost();
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const)
			target.estimatedCost[key] += source.estimatedCost[key];
	}
}

function summarize(attempts: Attempt[], finalized: boolean): ReviewUsageSummary {
	const result = emptyTotals();
	for (const entry of attempts) add(result, entry);
	if (finalized && result.requests === 0) {
		result.tokens = emptyTokens();
		result.estimatedCost = emptyCost();
	}
	const complete =
		finalized && result.pendingRequests === 0 && result.unavailableRequests === 0 && result.partialRequests === 0;
	return {
		...result,
		status: complete ? "complete" : result.tokens || result.estimatedCost ? "partial" : "unavailable",
		costBasis: "model-priced-usd",
	};
}

export function createEmptyReviewUsage(): ReviewUsageAccounting {
	return { revision: 0, updatedAt: Date.now(), finalized: true, summary: summarize([], true), attempts: [] };
}

function validNumbers(value: unknown): boolean {
	if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
	if (typeof value === "object" && value !== null) return Object.values(value).every(validNumbers);
	return true;
}

export function parseReviewUsage(value: unknown): ReviewUsageAccounting | undefined {
	if (!Check(ReviewUsageAccountingSchema, value) || !validNumbers(value)) return undefined;
	if (
		value.attempts.some(
			(entry) =>
				entry.pendingRequests > entry.requests ||
				entry.turns > entry.requests ||
				entry.unavailableRequests + entry.partialRequests > entry.requests,
		)
	)
		return undefined;
	if (!isDeepStrictEqual(summarize(value.attempts, value.finalized), value.summary)) return undefined;
	return structuredClone(value);
}

export class ReviewAccountingError extends Error {
	constructor(cause: unknown) {
		super("Review accounting could not be retained; further inference was stopped.", { cause });
	}
}

/** Bounded aggregates plus active requests; completed request closures reject duplicate delivery. */
export class ReviewUsageCollector {
	private readonly settled = new Map<string, Attempt>();
	private readonly active = new Map<number, Attempt>();
	private nextRequest = 0;
	private revision = 0;
	private updatedAt = Date.now();
	private finalized = false;
	private failure?: ReviewAccountingError;
	private tail: Promise<void> = Promise.resolve();
	private readonly persist?: (usage: ReviewUsageAccounting) => Promise<void>;

	constructor(persist?: (usage: ReviewUsageAccounting) => Promise<void>) {
		this.persist = persist;
	}

	assertHealthy(): void {
		if (this.failure) throw this.failure;
	}

	snapshot(): ReviewUsageAccounting {
		const buckets = new Map<string, Attempt>();
		for (const entry of [...this.settled.values(), ...this.active.values()]) {
			const key = this.key(entry);
			const previous = buckets.get(key);
			if (previous) add(previous, entry);
			else buckets.set(key, structuredClone(entry));
		}
		const attempts = [...buckets.values()].sort((left, right) => this.key(left).localeCompare(this.key(right)));
		return {
			revision: this.revision,
			updatedAt: this.updatedAt,
			finalized: this.finalized,
			summary: summarize(attempts, this.finalized),
			attempts,
		};
	}

	async checkpoint(): Promise<void> {
		this.assertHealthy();
		this.revision++;
		this.updatedAt = Date.now();
		const value = this.snapshot();
		if (!parseReviewUsage(value)) {
			this.failure = new ReviewAccountingError(new Error("Review usage exceeds accounting bounds"));
			throw this.failure;
		}
		this.tail = this.tail
			.then(async () => {
				this.assertHealthy();
				await this.persist?.(value);
			})
			.catch((cause: unknown) => {
				this.failure ??= new ReviewAccountingError(cause);
				throw this.failure;
			});
		return this.tail;
	}

	async finish(): Promise<ReviewUsageAccounting> {
		this.assertHealthy();
		await this.tail;
		if (!this.finalized) {
			this.finalized = true;
			this.revision++;
			this.updatedAt = Date.now();
		}
		return this.snapshot();
	}

	async start(identity: ReviewUsageAttempt, model: Model<Api>): Promise<InferenceAccountingRequest> {
		this.assertHealthy();
		if (this.finalized) throw new ReviewAccountingError(new Error("Review accounting is finalized"));
		const id = ++this.nextRequest;
		const base = { ...identity, provider: model.provider, model: model.id };
		let lastSequence = -1;
		let lastValue = "";
		let ended = false;
		this.active.set(id, { ...base, ...emptyTotals(), requests: 1, pendingRequests: 1, unavailableRequests: 1 });
		await this.checkpoint();
		return {
			observe: async (usage, sequence, terminal, response) => {
				this.assertHealthy();
				if (ended || this.finalized || sequence <= lastSequence) return;
				lastSequence = sequence;
				const entry: Attempt = {
					...base,
					...emptyTotals(),
					requests: 1,
					pendingRequests: terminal ? 0 : 1,
					turns: terminal && response && identity.kind === "turn" ? 1 : 0,
				};
				const reported = usage?.availability === "complete" || usage?.availability === "partial";
				if (reported && usage) {
					const observedTokens = {
						input: usage.input,
						output: usage.output,
						cacheRead: usage.cacheRead,
						cacheWrite: usage.cacheWrite,
					};
					if (Check(tokens, observedTokens) && validNumbers(observedTokens)) entry.tokens = observedTokens;
					if (entry.tokens && Check(cost, usage.cost) && validNumbers(usage.cost))
						entry.estimatedCost = { ...usage.cost };
					if (Check(tier, usage.serviceTier?.requested)) entry.requestedTier = usage.serviceTier.requested;
					if (Check(tier, usage.serviceTier?.effective)) entry.effectiveTier = usage.serviceTier.effective;
				}
				if (!entry.tokens) {
					const previous = this.active.get(id);
					if (previous?.tokens) {
						entry.tokens = { ...previous.tokens };
						if (previous.estimatedCost) entry.estimatedCost = { ...previous.estimatedCost };
						entry.partialRequests = 1;
					} else entry.unavailableRequests = 1;
				} else if (usage?.availability !== "complete" || !entry.estimatedCost) entry.partialRequests = 1;
				const encoded = JSON.stringify(entry);
				if (encoded === lastValue) return;
				lastValue = encoded;
				if (terminal) {
					ended = true;
					this.active.delete(id);
					const key = this.key(entry);
					const previous = this.settled.get(key);
					if (previous) add(previous, entry);
					else this.settled.set(key, entry);
				} else this.active.set(id, entry);
				await this.checkpoint();
			},
		};
	}

	private key(entry: Attempt): string {
		return JSON.stringify([
			entry.passId,
			entry.phase,
			entry.purpose,
			entry.round,
			entry.attempt,
			entry.kind,
			entry.provider,
			entry.model,
			entry.requestedTier ?? null,
			entry.effectiveTier ?? null,
		]);
	}
}
