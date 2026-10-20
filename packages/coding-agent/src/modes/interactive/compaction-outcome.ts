import type { CompactionStrategyReason } from "../../core/compaction/compaction.ts";
import { formatDuration } from "../../core/tools/render-utils.ts";

/** What a built-in compaction's details say about its result, beyond the size it started from. */
export interface CompactionOutcome {
	/** Estimated tokens of the rebuilt context. */
	tokensAfter?: number;
	/** Time from the first summarization request until the last one finished; under a second is not stated. */
	durationMs?: number;
	/** Summaries combined because the conversation was too long to summarize at once; at least two. */
	parts?: number;
}

const FALLBACK_REASONS = new Set<unknown>([
	"preflight_overflow",
	"provider_overflow",
] satisfies CompactionStrategyReason[]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The outcome a built-in compaction recorded in its details. Details may come
 * from imported sessions, so each value is validated and an unusable one is
 * left out. Extension details are the extension's own; do not read them.
 */
export function readCompactionOutcome(details: unknown): CompactionOutcome {
	if (!isRecord(details)) return {};
	const outcome: CompactionOutcome = {};
	if (isCount(details.tokensAfter)) outcome.tokensAfter = details.tokensAfter;
	const records: unknown[] = Array.isArray(details.requests) ? details.requests : [];
	const requests = records.filter(isRecord);

	const timed = requests.flatMap((request) => {
		if (!isCount(request.startedAt) || !isCount(request.durationMs)) return [];
		const end = request.startedAt + request.durationMs;
		return Number.isSafeInteger(end) ? [{ start: request.startedAt, end }] : [];
	});
	if (timed.length > 0 && timed.length === records.length) {
		const durationMs =
			Math.max(...timed.map((request) => request.end)) - Math.min(...timed.map((request) => request.start));
		if (durationMs >= 1000) outcome.durationMs = durationMs;
	}

	if (FALLBACK_REASONS.has(details.strategyReason)) {
		const parts = requests.filter(
			(request) => request.strategy === "chunked" && request.stopReason === "stop" && request.rejected === undefined,
		).length;
		if (parts >= 2) outcome.parts = parts;
	}
	return outcome;
}

/** "Compacted from 265,707 to ~41,230 tokens in 5m 15s", with whatever the outcome knows. */
export function compactionHeadline(tokensBefore: number, outcome: CompactionOutcome): string {
	const size =
		outcome.tokensAfter === undefined
			? `${tokensBefore.toLocaleString()} tokens`
			: `${tokensBefore.toLocaleString()} to ~${outcome.tokensAfter.toLocaleString()} tokens`;
	const time =
		outcome.durationMs === undefined ? "" : ` in ${formatDuration(outcome.durationMs, { wholeSeconds: true })}`;
	return `Compacted from ${size}${time}`;
}

/** Why the compaction took the longer route, when it did. */
export function compactionNote(outcome: CompactionOutcome): string | undefined {
	return outcome.parts === undefined
		? undefined
		: `The conversation was too long to summarize at once, so it was summarized in ${outcome.parts.toLocaleString()} parts.`;
}
