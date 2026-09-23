import { type Api, type CacheRetention, calculateCost, type Model, type Usage } from "@hansjm10/volt-ai";
import type { PromptCacheStatus } from "./prompt-cache-status.ts";
import type { SessionEntry } from "./session-manager.ts";

/** Custom session entry recording one successful refresh; it never enters model context. */
export const PROMPT_CACHE_REFRESH_ENTRY_TYPE = "prompt_cache_refresh";

export interface PromptCacheRefreshEntryData {
	provider: string;
	model: string;
	reason: PromptCacheRefreshReason;
	usage: Usage;
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Usage of a persisted refresh entry, or undefined for any other or malformed entry. */
export function getPromptCacheRefreshUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type !== "custom" || entry.customType !== PROMPT_CACHE_REFRESH_ENTRY_TYPE) return undefined;
	const data = entry.data as Partial<PromptCacheRefreshEntryData> | undefined;
	const usage = data?.usage;
	if (
		!usage ||
		!isCount(usage.input) ||
		!isCount(usage.output) ||
		!isCount(usage.cacheRead) ||
		!isCount(usage.cacheWrite) ||
		!isCount(usage.cost?.total)
	) {
		return undefined;
	}
	return usage;
}

/** Refresh this long before the documented expiry; the TTL counts from request start. */
export const PROMPT_CACHE_REFRESH_LEAD_MS = 60_000;

/**
 * A late timer (sleep, a blocked event loop) skips its refresh unless this much of the lead is left:
 * a refresh that reaches the provider after expiry pays for a full cache write.
 */
export const PROMPT_CACHE_REFRESH_MIN_MARGIN_MS = PROMPT_CACHE_REFRESH_LEAD_MS / 2;

/** Pricing volume for comparing a refresh with a miss; any size gives the same ratio. */
const PRICING_TOKENS = 1_000_000;

function price(model: Model<Api>, tokens: Partial<Pick<Usage, "input" | "cacheRead" | "cacheWrite" | "cacheWrite1h">>) {
	return calculateCost(model, {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...tokens,
	}).total;
}

/**
 * Most refreshes worth sending after one real request. Past this many, refreshing has cost more than
 * the cache miss it avoids, even if the next request is certain to come. Size-independent, since both
 * sides scale with the prefix. Zero when the model's prices do not bound the spend.
 */
export function promptCacheRefreshBudget(model: Model<Api>, retention: CacheRetention): number {
	if (retention === "none") return 0;
	const refreshCost = price(model, { cacheRead: PRICING_TOKENS });
	// A miss rewrites the prefix at the tier's write price, or reprocesses it as input when writes are not billed.
	const missCost =
		model.cost.cacheWrite > 0
			? price(
					model,
					retention === "long"
						? { cacheWrite: PRICING_TOKENS, cacheWrite1h: PRICING_TOKENS }
						: { cacheWrite: PRICING_TOKENS },
				)
			: price(model, { input: PRICING_TOKENS });
	if (!(refreshCost > 0) || !(missCost > refreshCost)) return 0;
	// The epsilon keeps exact ratios such as 24 from flooring to 23 on binary rounding.
	return Math.floor((missCost - refreshCost) / refreshCost + 1e-9);
}

export type PromptCacheRefreshReason = "in_flight" | "idle";

export interface PromptCacheKeepAliveSettings {
	enabled: boolean;
	/** How long after work settles to keep refreshing. 0 refreshes only while work runs. */
	idleWindowMs: number;
}

export type PromptCacheKeepAliveStop = "idle_window_elapsed" | "refresh_deadline_missed" | "refresh_budget_exhausted";

export interface PromptCacheKeepAliveHost {
	now(): number;
	settings(): PromptCacheKeepAliveSettings;
	/** Status of the prefix the next request would reuse, including earlier refreshes. */
	status(): PromptCacheStatus | undefined;
	/** Whether the current model and runtime can refresh without output. */
	canRefresh(): boolean;
	/** Refreshes allowed after each real request (see `promptCacheRefreshBudget`); 0 disables keepalive. */
	refreshBudget(): number;
	/** A turn, background job, or user shell command is running. */
	hasInFlightWork(): boolean;
	/** Refresh once. Resolves true only when the provider renewed the prefix. */
	refresh(reason: PromptCacheRefreshReason): Promise<boolean>;
	/** Keepalive stopped for the current request without a refresh failure. */
	stopped(reason: PromptCacheKeepAliveStop, status: PromptCacheStatus): void;
	/** keepAliveUntil changed; republish status. */
	changed(): void;
}

export interface PromptCacheKeepAliveTimers {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

const defaultTimers: PromptCacheKeepAliveTimers = {
	setTimeout: (callback, delayMs) => {
		const handle = setTimeout(callback, delayMs);
		handle.unref?.();
		return handle;
	},
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type RefreshableStatus = Extract<PromptCacheStatus, { kind: "retained" }> & { expiresAt: number };

/**
 * Keeps a renewing prompt cache warm: refreshes shortly before expiry while work runs, and for a
 * bounded window after the session goes idle, up to a price-derived budget per real request. A
 * failed or unsupported refresh stops keepalive until the next request, so errors never turn into
 * a retry loop.
 */
export class PromptCacheKeepAlive {
	private readonly host: PromptCacheKeepAliveHost;
	private readonly timers: PromptCacheKeepAliveTimers;
	private timer: unknown;
	/** When the session last became idle; undefined while work runs. */
	private idleSince: number | undefined;
	private refreshing = false;
	/** lastRequestAt of a status whose refresh failed or whose keepalive ended. */
	private haltedAt: number | undefined;
	/** Successful refreshes since the last real request. */
	private refreshesSinceRequest = 0;
	/** Advances with each real request, so a refresh that overlapped one is not charged to it. */
	private requestEpoch = 0;
	private disposed = false;

	constructor(host: PromptCacheKeepAliveHost, timers: PromptCacheKeepAliveTimers = defaultTimers) {
		this.host = host;
		this.timers = timers;
	}

	/** Re-read activity after a run, background job, or shell command starts or ends. */
	activityChanged(): void {
		const idle = !this.host.hasInFlightWork();
		const idleSince = idle ? (this.idleSince ?? this.host.now()) : undefined;
		if (idleSince !== this.idleSince) {
			this.idleSince = idleSince;
			this.host.changed();
		}
		this.update();
	}

	/** A real provider request started: it renews the prefix and restores the refresh budget. */
	requestStarted(): void {
		this.refreshesSinceRequest = 0;
		this.requestEpoch++;
		this.update();
	}

	/**
	 * Unix ms after which idle keepalive starts no further refresh: the end of the idle window, or
	 * earlier when the refresh budget runs out first. Undefined unless idle keepalive applies now.
	 */
	keepAliveUntil(): number | undefined {
		const idleWindowMs = this.host.settings().idleWindowMs;
		if (idleWindowMs <= 0 || this.idleSince === undefined) return undefined;
		const status = this.refreshableStatus();
		if (!status) return undefined;
		const remaining = this.host.refreshBudget() - this.refreshesSinceRequest;
		if (remaining <= 0) return undefined;
		// Each refresh renews the full TTL, so refreshes fall due one interval apart.
		const intervalMs = status.expiresAt - status.lastRequestAt - PROMPT_CACHE_REFRESH_LEAD_MS;
		const budgetEnd = status.expiresAt - PROMPT_CACHE_REFRESH_LEAD_MS + remaining * intervalMs;
		const until = Math.min(this.idleSince + idleWindowMs, budgetEnd);
		return until > this.host.now() ? until : undefined;
	}

	/** Reschedule from the current status. Call after requests, refreshes, compaction, and model changes. */
	update(): void {
		this.clearTimer();
		if (this.refreshing) return;
		const status = this.refreshableStatus();
		if (!status) return;
		const delay = Math.max(0, status.expiresAt - PROMPT_CACHE_REFRESH_LEAD_MS - this.host.now());
		this.timer = this.timers.setTimeout(() => {
			this.timer = undefined;
			void this.fire();
		}, delay);
	}

	dispose(): void {
		this.disposed = true;
		this.clearTimer();
	}

	private clearTimer(): void {
		if (this.timer === undefined) return;
		this.timers.clearTimeout(this.timer);
		this.timer = undefined;
	}

	/** The status keepalive can refresh, or undefined when keepalive does not apply to it. */
	private refreshableStatus(): RefreshableStatus | undefined {
		if (this.disposed || !this.host.settings().enabled) return undefined;
		const status = this.host.status();
		if (status?.kind !== "retained" || status.expiresAt === undefined) return undefined;
		// Below two leads, the refresh interval would be shorter than the lead and refreshes would chain.
		if (status.expiresAt - status.lastRequestAt < 2 * PROMPT_CACHE_REFRESH_LEAD_MS) return undefined;
		if (this.haltedAt === status.lastRequestAt || !this.host.canRefresh()) return undefined;
		if (this.host.refreshBudget() <= 0) return undefined;
		return { ...status, expiresAt: status.expiresAt };
	}

	private halt(status: RefreshableStatus): void {
		this.haltedAt = status.lastRequestAt;
		this.host.changed();
	}

	private async fire(): Promise<void> {
		const status = this.refreshableStatus();
		if (!status) return;
		const now = this.host.now();
		if (status.expiresAt - now < PROMPT_CACHE_REFRESH_MIN_MARGIN_MS) {
			this.halt(status);
			this.host.stopped("refresh_deadline_missed", status);
			return;
		}
		let reason: PromptCacheRefreshReason;
		if (this.host.hasInFlightWork()) reason = "in_flight";
		else if (this.idleSince !== undefined && now < this.idleSince + this.host.settings().idleWindowMs) {
			reason = "idle";
		} else {
			this.halt(status);
			this.host.stopped("idle_window_elapsed", status);
			return;
		}
		if (this.refreshesSinceRequest >= this.host.refreshBudget()) {
			this.halt(status);
			this.host.stopped("refresh_budget_exhausted", status);
			return;
		}
		const epoch = this.requestEpoch;
		this.refreshing = true;
		let renewed = false;
		try {
			renewed = await this.host.refresh(reason);
		} catch {
			renewed = false;
		} finally {
			this.refreshing = false;
		}
		if (this.disposed) return;
		if (!renewed) this.halt(status);
		else if (epoch === this.requestEpoch) this.refreshesSinceRequest++;
		this.update();
	}
}
