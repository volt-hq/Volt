import { afterEach, describe, expect, test, vi } from "vitest";
import {
	parseIntegratedDetachedRuntimeTtlMs,
	scheduleDetachedRuntimeRetention,
} from "../src/remote/integrated-runtime-retention.ts";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((innerResolve) => {
		resolve = innerResolve;
	});
	return { promise, resolve };
}

afterEach(() => {
	vi.useRealTimers();
});

describe("detached integrated runtime retention", () => {
	test("expires idle detached runtimes after the configured TTL", async () => {
		vi.useFakeTimers();
		const onExpire = vi.fn(async () => {});

		scheduleDetachedRuntimeRetention({
			ttlMs: 1000,
			isDetached: () => true,
			isActive: () => false,
			waitForIdle: async () => {},
			onExpire,
		});

		await vi.advanceTimersByTimeAsync(999);
		expect(onExpire).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(onExpire).toHaveBeenCalledOnce();
	});

	test("does not expire active detached runtimes until they become idle for the full TTL", async () => {
		vi.useFakeTimers();
		let active = true;
		const idle = createDeferred();
		const waitForIdle = vi.fn(() => idle.promise);
		const onExpire = vi.fn(async () => {});

		scheduleDetachedRuntimeRetention({
			ttlMs: 1000,
			isDetached: () => true,
			isActive: () => active,
			waitForIdle,
			onExpire,
		});

		await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledOnce());
		await vi.advanceTimersByTimeAsync(5000);
		expect(onExpire).not.toHaveBeenCalled();

		active = false;
		idle.resolve();
		await vi.advanceTimersByTimeAsync(999);
		expect(onExpire).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(onExpire).toHaveBeenCalledOnce();
	});

	test.each([
		{ outcome: "settles", wait: async () => {} },
		{
			outcome: "fails",
			wait: async () => {
				throw new Error("idle wait failed");
			},
		},
	])("backs off instead of spinning when the idle wait $outcome while still active", async ({ wait }) => {
		vi.useFakeTimers();
		let active = true;
		const onExpire = vi.fn(async () => {});
		// Stop a regressed microtask spin after 100 waits so the test fails instead of hanging.
		const waitForIdle = vi.fn(async () => {
			if (waitForIdle.mock.calls.length > 100) handle.cancel();
			await wait();
		});
		const handle = scheduleDetachedRuntimeRetention({
			ttlMs: 1000,
			isDetached: () => true,
			isActive: () => active,
			waitForIdle,
			onExpire,
		});

		await vi.advanceTimersByTimeAsync(10_000);
		expect(waitForIdle.mock.calls.length).toBeGreaterThan(1);
		expect(waitForIdle.mock.calls.length).toBeLessThanOrEqual(11);

		active = false;
		await vi.advanceTimersByTimeAsync(2000);
		expect(onExpire).toHaveBeenCalledOnce();
	});

	test("cancel prevents detached runtime expiry after reattach", async () => {
		vi.useFakeTimers();
		const onExpire = vi.fn(async () => {});
		const handle = scheduleDetachedRuntimeRetention({
			ttlMs: 1000,
			isDetached: () => true,
			isActive: () => false,
			waitForIdle: async () => {},
			onExpire,
		});

		handle.cancel();
		await vi.advanceTimersByTimeAsync(1000);

		expect(onExpire).not.toHaveBeenCalled();
	});

	test("parses non-negative finite TTL values", () => {
		expect(parseIntegratedDetachedRuntimeTtlMs("0")).toBe(0);
		expect(parseIntegratedDetachedRuntimeTtlMs("10.8")).toBe(10);
		expect(() => parseIntegratedDetachedRuntimeTtlMs("-1")).toThrow(
			"--detached-runtime-ttl-ms must be a non-negative finite number",
		);
		expect(() => parseIntegratedDetachedRuntimeTtlMs("Infinity")).toThrow(
			"--detached-runtime-ttl-ms must be a non-negative finite number",
		);
	});
});
