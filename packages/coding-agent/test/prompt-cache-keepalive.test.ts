import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PromptCacheKeepAlive,
	type PromptCacheKeepAliveSettings,
	type PromptCacheRefreshReason,
} from "../src/core/prompt-cache-keepalive.ts";
import type { PromptCacheStatus } from "../src/core/prompt-cache-status.ts";

const TTL_MS = 300_000;
const MINUTE = 60_000;

function createKeepAlive(options: { settings?: PromptCacheKeepAliveSettings; canRefresh?: boolean } = {}) {
	let status: PromptCacheStatus | undefined = { kind: "retained", lastRequestAt: 0, expiresAt: TTL_MS };
	let inFlight = false;
	let renew = true;
	let settings = options.settings ?? { enabled: true, idleWindowMs: 15 * MINUTE };
	const refreshes: Array<{ reason: PromptCacheRefreshReason; at: number }> = [];
	const stops: string[] = [];
	const keepAlive = new PromptCacheKeepAlive({
		now: () => Date.now(),
		settings: () => settings,
		status: () => status,
		canRefresh: () => options.canRefresh ?? true,
		hasInFlightWork: () => inFlight,
		refresh: async (reason) => {
			refreshes.push({ reason, at: Date.now() });
			if (!renew) return false;
			status = { kind: "retained", lastRequestAt: Date.now(), expiresAt: Date.now() + TTL_MS };
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
		setStatus(next: PromptCacheStatus | undefined) {
			status = next;
			keepAlive.update();
		},
		failRefreshes() {
			renew = false;
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

	it("does nothing when disabled or unsupported", async () => {
		const disabled = createKeepAlive({ settings: { enabled: false, idleWindowMs: 15 * MINUTE } });
		const unsupported = createKeepAlive({ canRefresh: false });
		disabled.setInFlight(true);
		unsupported.setInFlight(true);

		await vi.advanceTimersByTimeAsync(20 * MINUTE);

		expect(disabled.refreshes).toEqual([]);
		expect(unsupported.refreshes).toEqual([]);
		expect(unsupported.keepAlive.keepAliveUntil()).toBeUndefined();
	});

	it("stops after a failed refresh until the next request", async () => {
		const harness = createKeepAlive();
		harness.failRefreshes();
		harness.setInFlight(true);

		await vi.advanceTimersByTimeAsync(20 * MINUTE);
		expect(harness.refreshes.length).toBe(1);

		harness.setStatus({ kind: "retained", lastRequestAt: Date.now(), expiresAt: Date.now() + TTL_MS });
		await vi.advanceTimersByTimeAsync(4 * MINUTE);
		expect(harness.refreshes.length).toBe(2);
	});

	it("does not refresh a cache that already expired", async () => {
		const harness = createKeepAlive();
		vi.setSystemTime(10 * MINUTE);
		harness.setInFlight(true);

		await vi.advanceTimersByTimeAsync(MINUTE);

		expect(harness.refreshes).toEqual([]);
		expect(harness.stops).toEqual(["expired_before_refresh"]);
	});

	it("applies a disabled setting on the next update", async () => {
		const harness = createKeepAlive();
		harness.setInFlight(true);
		harness.setSettings({ enabled: false, idleWindowMs: 15 * MINUTE });

		await vi.advanceTimersByTimeAsync(10 * MINUTE);

		expect(harness.refreshes).toEqual([]);
	});
});
