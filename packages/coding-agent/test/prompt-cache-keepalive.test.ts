import { getModels, type Model } from "@hansjm10/volt-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PromptCacheKeepAlive,
	type PromptCacheKeepAliveSettings,
	type PromptCacheRefreshReason,
	promptCacheRefreshBudget,
} from "../src/core/prompt-cache-keepalive.ts";
import type { PromptCacheStatus } from "../src/core/prompt-cache-status.ts";

const TTL_MS = 300_000;
const MINUTE = 60_000;

function createKeepAlive(
	options: { settings?: PromptCacheKeepAliveSettings; canRefresh?: boolean; budget?: number; ttlMs?: number } = {},
) {
	const ttlMs = options.ttlMs ?? TTL_MS;
	let status: PromptCacheStatus | undefined = { kind: "retained", lastRequestAt: 0, expiresAt: ttlMs };
	let inFlight = false;
	let renew = true;
	let hold: Promise<void> | undefined;
	let settings = options.settings ?? { enabled: true, idleWindowMs: 15 * MINUTE };
	const refreshes: Array<{ reason: PromptCacheRefreshReason; at: number }> = [];
	const stops: string[] = [];
	const keepAlive = new PromptCacheKeepAlive({
		now: () => Date.now(),
		settings: () => settings,
		status: () => status,
		canRefresh: () => options.canRefresh ?? true,
		refreshBudget: () => options.budget ?? 100,
		hasInFlightWork: () => inFlight,
		refresh: async (reason) => {
			const startedAt = Date.now();
			refreshes.push({ reason, at: startedAt });
			if (hold) await hold;
			if (!renew) return false;
			if (status?.kind === "retained" && status.lastRequestAt < startedAt) {
				status = { kind: "retained", lastRequestAt: startedAt, expiresAt: startedAt + ttlMs };
			}
			return true;
		},
		stopped: (reason) => stops.push(reason),
		changed: () => {},
	});
	return {
		keepAlive,
		refreshes,
		stops,
		setInFlight(value: boolean) {
			inFlight = value;
			keepAlive.activityChanged();
		},
		/** A real provider request starts now. */
		startRequest() {
			status = { kind: "retained", lastRequestAt: Date.now(), expiresAt: Date.now() + ttlMs };
			keepAlive.requestStarted();
		},
		failRefreshes() {
			renew = false;
		},
		/** Keep refreshes in flight until the returned release runs. */
		holdRefreshes() {
			let release!: () => void;
			hold = new Promise((resolve) => {
				release = () => {
					hold = undefined;
					resolve();
				};
			});
			return release;
		},
		setSettings(next: PromptCacheKeepAliveSettings) {
			settings = next;
			keepAlive.update();
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(0);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("PromptCacheKeepAlive", () => {
	it("refreshes a minute before expiry for as long as work runs", async () => {
		const harness = createKeepAlive();
		harness.setInFlight(true);

		await vi.advanceTimersByTimeAsync(60 * MINUTE);

		expect(harness.refreshes.length).toBe(15);
		expect(harness.refreshes.every((refresh) => refresh.reason === "in_flight")).toBe(true);
		expect(harness.refreshes.slice(0, 2).map((refresh) => refresh.at)).toEqual([4 * MINUTE, 8 * MINUTE]);
		expect(harness.stops).toEqual([]);
	});

	it("keeps an idle cache warm for the idle window, then stops", async () => {
		const harness = createKeepAlive();
		harness.setInFlight(false);
		expect(harness.keepAlive.keepAliveUntil()).toBe(15 * MINUTE);

		await vi.advanceTimersByTimeAsync(30 * MINUTE);

		expect(harness.refreshes.map((refresh) => refresh.at)).toEqual([4 * MINUTE, 8 * MINUTE, 12 * MINUTE]);
		expect(harness.refreshes.every((refresh) => refresh.reason === "idle")).toBe(true);
		expect(harness.stops).toEqual(["idle_window_elapsed"]);
		expect(harness.keepAlive.keepAliveUntil()).toBeUndefined();
	});

	it("refreshes only while work runs when the idle window is zero", async () => {
		const harness = createKeepAlive({ settings: { enabled: true, idleWindowMs: 0 } });
		harness.setInFlight(false);

		await vi.advanceTimersByTimeAsync(10 * MINUTE);

		expect(harness.refreshes).toEqual([]);
		expect(harness.stops).toEqual(["idle_window_elapsed"]);
		expect(harness.keepAlive.keepAliveUntil()).toBeUndefined();
	});

	it("does nothing when disabled, unsupported, unpriced, or the TTL is too short to refresh ahead", async () => {
		const harnesses = [
			createKeepAlive({ settings: { enabled: false, idleWindowMs: 15 * MINUTE } }),
			createKeepAlive({ canRefresh: false }),
			createKeepAlive({ budget: 0 }),
			createKeepAlive({ ttlMs: 90_000 }),
		];
		for (const harness of harnesses) harness.setInFlight(true);

		await vi.advanceTimersByTimeAsync(20 * MINUTE);

		for (const harness of harnesses) {
			expect(harness.refreshes).toEqual([]);
			expect(harness.stops).toEqual([]);
			harness.setInFlight(false);
			expect(harness.keepAlive.keepAliveUntil()).toBeUndefined();
		}
	});

	it("stops after a failed refresh until the next request", async () => {
		const harness = createKeepAlive();
		harness.failRefreshes();
		harness.setInFlight(true);

		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		expect(harness.refreshes.length).toBe(1);

		harness.startRequest();
		await vi.advanceTimersByTimeAsync(4 * MINUTE);
		expect(harness.refreshes.length).toBe(2);
	});

	it("stops once the refresh budget is spent, until the next request", async () => {
		const harness = createKeepAlive({ budget: 3 });
		harness.setInFlight(true);

		await vi.advanceTimersByTimeAsync(60 * MINUTE);
		expect(harness.refreshes.map((refresh) => refresh.at)).toEqual([4 * MINUTE, 8 * MINUTE, 12 * MINUTE]);
		expect(harness.stops).toEqual(["refresh_budget_exhausted"]);

		harness.startRequest();
		await vi.advanceTimersByTimeAsync(4 * MINUTE);
		expect(harness.refreshes.length).toBe(4);
	});

	it("ends idle keepalive when the budget runs out before the idle window", async () => {
		const harness = createKeepAlive({ budget: 2, settings: { enabled: true, idleWindowMs: 30 * MINUTE } });
		harness.setInFlight(false);
		// Refreshes fall due at 4m and 8m; the first one past the budget would be at 12m.
		expect(harness.keepAlive.keepAliveUntil()).toBe(12 * MINUTE);

		await vi.advanceTimersByTimeAsync(30 * MINUTE);

		expect(harness.refreshes.map((refresh) => refresh.at)).toEqual([4 * MINUTE, 8 * MINUTE]);
		expect(harness.stops).toEqual(["refresh_budget_exhausted"]);
		expect(harness.keepAlive.keepAliveUntil()).toBeUndefined();
	});

	it("does not charge the budget for a refresh that overlapped a real request", async () => {
		const harness = createKeepAlive({ budget: 1 });
		harness.setInFlight(true);
		const release = harness.holdRefreshes();

		await vi.advanceTimersByTimeAsync(4 * MINUTE);
		expect(harness.refreshes.length).toBe(1);
		harness.startRequest();
		release();
		await vi.advanceTimersByTimeAsync(4 * MINUTE);

		expect(harness.refreshes.map((refresh) => refresh.at)).toEqual([4 * MINUTE, 8 * MINUTE]);
		expect(harness.stops).toEqual([]);
	});

	it("does not refresh a cache that already expired", async () => {
		const harness = createKeepAlive();
		vi.setSystemTime(10 * MINUTE);
		harness.setInFlight(true);

		await vi.advanceTimersByTimeAsync(MINUTE);

		expect(harness.refreshes).toEqual([]);
		expect(harness.stops).toEqual(["refresh_deadline_missed"]);
	});

	it("skips a refresh whose timer fires too close to expiry", async () => {
		const harness = createKeepAlive();
		harness.setInFlight(true);
		// The clock jumps 40s (sleep) without running timers, so the 4m timer fires 20s before expiry.
		vi.setSystemTime(40_000);

		await vi.advanceTimersByTimeAsync(4 * MINUTE);

		expect(harness.refreshes).toEqual([]);
		expect(harness.stops).toEqual(["refresh_deadline_missed"]);
	});

	it("sizes the budget so refresh spend never exceeds the miss it avoids", () => {
		const base = getModels("anthropic")[0]! as Model<"anthropic-messages">;
		const priced = (cost: Model<"anthropic-messages">["cost"]) => ({ ...base, cost });
		const opus = priced({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });

		// (5 - 0.2) / 0.2 for 5-minute writes; 1-hour writes bill at twice input: (8 - 0.2) / 0.2.
		expect(promptCacheRefreshBudget(opus, "short")).toBe(24);
		expect(promptCacheRefreshBudget(opus, "long")).toBe(39);
		// Without a write charge, a miss reprocesses the prefix as input: (1.25 - 0.125) / 0.125.
		expect(
			promptCacheRefreshBudget(priced({ input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }), "short"),
		).toBe(9);
		expect(promptCacheRefreshBudget(priced({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), "short")).toBe(0);
		expect(promptCacheRefreshBudget(opus, "none")).toBe(0);
	});

	it("applies a disabled setting on the next update", async () => {
		const harness = createKeepAlive();
		harness.setInFlight(true);
		harness.setSettings({ enabled: false, idleWindowMs: 15 * MINUTE });

		await vi.advanceTimersByTimeAsync(10 * MINUTE);

		expect(harness.refreshes).toEqual([]);
	});
});
