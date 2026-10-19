import type { StopReason, Usage } from "@hansjm10/volt-ai";
import type { CheckpointPurpose } from "../../core/compaction/checkpoint.ts";
import type { CompactionStrategyReason } from "../../core/compaction/compaction.ts";
import { formatDuration } from "../../core/tools/render-utils.ts";

const STOP_REASONS = new Set<string>(["stop", "length", "toolUse", "error", "aborted"] satisfies StopReason[]);
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const PURPOSE_LABELS: Record<CheckpointPurpose, string> = {
	native: "native",
	history: "history",
	turn_prefix: "turn prefix",
};
const STRATEGY_REASONS: Record<CompactionStrategyReason, string> = {
	native: "",
	preflight_overflow: " (too large for one request)",
	provider_overflow: " (provider rejected one request as too large)",
};
const FAILED_OUTCOMES: Record<Exclude<StopReason, "stop">, string> = {
	length: "output limit",
	toolUse: "tool call",
	error: "error",
	aborted: "aborted",
};

type RequestUsage = Pick<Usage, (typeof USAGE_FIELDS)[number]>;

/** A validated request record, with unusable optional fields dropped. */
interface RequestRecord {
	strategy: "native" | "chunked";
	attempt: number;
	purpose?: CheckpointPurpose;
	stopReason?: StopReason;
	rejected: boolean;
	textChars?: number;
	maxChars?: number;
	startedAt?: number;
	durationMs?: number;
	usage?: RequestUsage;
}

/** What the TUI shows below a built-in compaction. */
export interface CompactionUsageReport {
	/** The strategy and why, request outcomes, elapsed time, prompt tokens, and checkpoint size. */
	summary: string;
	/** One line per request, in dispatch order. */
	requests: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function isRequestUsage(value: unknown): value is RequestUsage {
	return isRecord(value) && USAGE_FIELDS.every((field) => isCount(value[field]));
}

function isStopReason(value: unknown): value is StopReason {
	return typeof value === "string" && STOP_REASONS.has(value);
}

function hasKey<T extends object>(map: T, key: unknown): key is keyof T {
	return typeof key === "string" && Object.hasOwn(map, key);
}

/** The record, or undefined when its identity is malformed. */
function readRequest(request: unknown): RequestRecord | undefined {
	if (
		!isRecord(request) ||
		(request.strategy !== "native" && request.strategy !== "chunked") ||
		typeof request.attempt !== "number" ||
		!Number.isSafeInteger(request.attempt) ||
		request.attempt < 1 ||
		typeof request.provider !== "string" ||
		request.provider.trim().length === 0 ||
		typeof request.model !== "string" ||
		request.model.trim().length === 0 ||
		(request.stopReason !== undefined && !isStopReason(request.stopReason))
	) {
		return undefined;
	}
	const count = (value: unknown): number | undefined => (isCount(value) ? value : undefined);
	return {
		strategy: request.strategy,
		attempt: request.attempt,
		purpose: hasKey(PURPOSE_LABELS, request.purpose) ? request.purpose : undefined,
		stopReason: isStopReason(request.stopReason) ? request.stopReason : undefined,
		rejected: request.rejected === "oversized",
		textChars: count(request.textChars),
		maxChars: count(request.maxChars),
		startedAt: count(request.startedAt),
		durationMs: count(request.durationMs),
		usage: isRequestUsage(request.usage) ? request.usage : undefined,
	};
}

/** Prompt tokens a request sent; output tokens do not take part in prompt caching. */
function promptTokens(usage: RequestUsage | undefined): number | undefined {
	if (!usage) return undefined;
	const tokens = usage.input + usage.cacheRead + usage.cacheWrite;
	return tokens > 0 && Number.isSafeInteger(tokens) ? tokens : undefined;
}

function cachedShare(cached: number, prompt: number): string {
	return `${((cached / prompt) * 100).toFixed(1)}% cached`;
}

function accepted(request: RequestRecord): boolean {
	return request.stopReason === "stop" && !request.rejected;
}

function outcome(request: RequestRecord): string {
	if (request.rejected) {
		return request.textChars !== undefined && request.maxChars !== undefined
			? `oversized (${request.textChars.toLocaleString()} of ${request.maxChars.toLocaleString()} chars)`
			: "oversized";
	}
	if (request.stopReason === undefined) return "no response";
	if (request.stopReason !== "stop") return FAILED_OUTCOMES[request.stopReason];
	return request.textChars === undefined ? "completed" : `${request.textChars.toLocaleString()} chars`;
}

function requestLine(request: RequestRecord, retry: boolean): string {
	const label = request.purpose === undefined ? request.strategy : PURPOSE_LABELS[request.purpose];
	const parts = [`${request.attempt}. ${label}${retry ? " retry" : ""}`, outcome(request)];
	if (request.durationMs !== undefined) parts.push(formatDuration(request.durationMs));
	const prompt = promptTokens(request.usage);
	if (prompt === undefined || !request.usage) {
		parts.push("usage unavailable");
	} else {
		// Each chunk is new source text, so only native requests and retries can reuse a cached prefix.
		const cache = request.strategy === "native" || retry ? `, ${cachedShare(request.usage.cacheRead, prompt)}` : "";
		parts.push(`${prompt.toLocaleString()} prompt tokens${cache}`);
	}
	return parts.join(" · ");
}

function plural(count: number, noun: string): string {
	return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The usage report of a built-in compaction, or undefined when its details
 * record no requests. Details may come from extensions or imported sessions,
 * so every field is validated and unusable records are skipped.
 */
export function formatCompactionUsage(details: unknown, checkpointChars: number): CompactionUsageReport | undefined {
	if (!isRecord(details) || !Array.isArray(details.requests)) return undefined;
	const records: unknown[] = details.requests;
	const requests = records.map(readRequest).filter((request) => request !== undefined);
	const last = requests.at(-1);
	if (!last) return undefined;

	// Requests run one at a time, so one that follows an unaccepted request for the same checkpoint repeats it.
	const lines = requests.map((request, index) => {
		const previous = requests[index - 1];
		const retry =
			previous !== undefined &&
			!accepted(previous) &&
			previous.strategy === request.strategy &&
			previous.purpose === request.purpose;
		return requestLine(request, retry);
	});

	const reason = hasKey(STRATEGY_REASONS, details.strategyReason) ? details.strategyReason : undefined;
	const strategy = reason === undefined ? last.strategy : reason === "native" ? "native" : "chunked";
	const oversized = requests.filter((request) => request.rejected).length;
	const failed = requests.filter((request) => !request.rejected && !accepted(request)).length;
	const outcomes = [
		...(oversized > 0 ? [`${oversized.toLocaleString()} oversized`] : []),
		...(failed > 0 ? [`${failed.toLocaleString()} failed`] : []),
	];
	const parts = [
		`${strategy === "native" ? "Native" : "Chunked"} compaction${reason === undefined ? "" : STRATEGY_REASONS[reason]}`,
		`${plural(requests.length, "request")}${outcomes.length > 0 ? ` (${outcomes.join(", ")})` : ""}`,
	];

	// Wall time from the first dispatch to the last settled request, retry waits included.
	if (requests.every((request) => request.startedAt !== undefined && request.durationMs !== undefined)) {
		const start = Math.min(...requests.map((request) => request.startedAt ?? 0));
		const end = Math.max(...requests.map((request) => (request.startedAt ?? 0) + (request.durationMs ?? 0)));
		if (Number.isSafeInteger(end)) parts.push(formatDuration(end - start));
	}

	let prompt = 0;
	let cached = 0;
	let unavailable = 0;
	for (const request of requests) {
		const tokens = promptTokens(request.usage);
		if (tokens === undefined || !request.usage) {
			unavailable++;
			continue;
		}
		prompt += tokens;
		cached += request.usage.cacheRead;
	}
	if (prompt > 0 && Number.isSafeInteger(prompt)) {
		const missing = unavailable > 0 ? `, ${plural(unavailable, "request")} without usage` : "";
		parts.push(`${prompt.toLocaleString()} prompt tokens, ${cachedShare(cached, prompt)}${missing}`);
	} else {
		parts.push("usage unavailable");
	}
	if (checkpointChars > 0) parts.push(`checkpoint ${checkpointChars.toLocaleString()} chars`);
	return { summary: parts.join(" · "), requests: lines };
}
