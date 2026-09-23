import type { Usage } from "@hansjm10/volt-ai";
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

export type PromptCacheRefreshReason = "in_flight" | "idle";

export interface PromptCacheKeepAliveSettings {
	enabled: boolean;
	/** How long after work settles to keep refreshing. 0 refreshes only while work runs. */
	idleWindowMs: number;
}

export type PromptCacheKeepAliveStop = "idle_window_elapsed" | "expired_before_refresh";

export interface PromptCacheKeepAliveHost {
	now(): number;
	settings(): PromptCacheKeepAliveSettings;
	/** Status of the prefix the next request would reuse, including earlier refreshes. */
	status(): PromptCacheStatus | undefined;
	/** Whether the current model and runtime can refresh without output. */
	canRefresh(): boolean;
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

/**
 * Keeps a renewing prompt cache warm: refreshes shortly before expiry while work runs, and for a
 * bounded window after the session goes idle. A failed or unsupported refresh stops keepalive
 * until the next request, so errors never turn into a retry loop.
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

	/** Unix ms until which idle refreshes continue, when idle keepalive applies now. */
	keepAliveUntil(): number | undefined {
		const settings = this.host.settings();
		if (!settings.enabled || settings.idleWindowMs <= 0 || this.idleSince === undefined) return undefined;
		const status = this.host.status();
		if (status?.kind !== "retained" || status.expiresAt === undefined || this.haltedAt === status.lastRequestAt) {
			return undefined;
		}
		if (!this.host.canRefresh()) return undefined;
		const until = this.idleSince + settings.idleWindowMs;
		return until > this.host.now() ? until : undefined;
	}

	/** Reschedule from the current status. Call after requests, refreshes, compaction, and model changes. */
	update(): void {
		this.clearTimer();
		if (this.disposed || this.refreshing || !this.host.settings().enabled) return;
		const status = this.host.status();
		if (status?.kind !== "retained" || status.expiresAt === undefined) return;
		if (this.haltedAt === status.lastRequestAt || !this.host.canRefresh()) return;
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

	private halt(status: PromptCacheStatus & { kind: "retained" }): void {
		this.haltedAt = status.lastRequestAt;
		this.host.changed();
	}

	private async fire(): Promise<void> {
		const settings = this.host.settings();
		if (this.disposed || !settings.enabled) return;
		const status = this.host.status();
		if (status?.kind !== "retained" || status.expiresAt === undefined || !this.host.canRefresh()) return;
		const now = this.host.now();
		if (now >= status.expiresAt) {
			this.halt(status);
			this.host.stopped("expired_before_refresh", status);
			return;
		}
		let reason: PromptCacheRefreshReason;
		if (this.host.hasInFlightWork()) reason = "in_flight";
		else if (this.idleSince !== undefined && now < this.idleSince + settings.idleWindowMs) reason = "idle";
		else {
			this.halt(status);
			this.host.stopped("idle_window_elapsed", status);
			return;
		}
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
		this.update();
	}
}
