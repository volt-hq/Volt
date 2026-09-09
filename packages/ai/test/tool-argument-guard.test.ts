import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolArgumentGuard, type ToolArgumentLimitFailure } from "../src/stream/tool-argument-guard.ts";
import type { JsonObject } from "../src/utils/json-value.ts";

afterEach(() => vi.useRealTimers());

describe("tool argument generation budgets", () => {
	it.each([undefined, {}])("allows continuing argument bytes beyond five minutes with defaults %j", (limits) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const failure = vi.fn();
		const guard = new ToolArgumentGuard(limits, failure);
		guard.start(0);
		for (let minute = 0; minute < 10; minute++) {
			vi.advanceTimersByTime(60_000);
			expect(guard.append(0, "Document section. ")).toBe(true);
		}
		expect(guard.complete(0)).toBe(true);
		expect(failure).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		guard.dispose();
	});

	it("expires after five minutes without argument bytes by default", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const failure = vi.fn();
		const guard = new ToolArgumentGuard(undefined, failure);
		guard.start(0);
		vi.advanceTimersByTime(300_000);
		expect(failure).toHaveBeenCalledOnce();
		expect(failure.mock.calls[0]?.[0].diagnostic.details).toMatchObject({
			limit: "maxIdleMs",
			limitValue: 300_000,
			elapsedMs: 300_000,
			idleMs: 300_000,
			bytes: 0,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("expires relative to the last nonempty delta despite empty updates", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxIdleMs: 100 }, failure);
		guard.start(0);
		vi.advanceTimersByTime(60);
		expect(guard.append(0, "x")).toBe(true);
		vi.advanceTimersByTime(60);
		expect(guard.append(0, "")).toBe(true);
		expect(failure).not.toHaveBeenCalled();
		vi.advanceTimersByTime(40);
		expect(failure).toHaveBeenCalledOnce();
		expect(failure.mock.calls[0]?.[0].diagnostic.details).toMatchObject({
			limit: "maxIdleMs",
			elapsedMs: 160,
			idleMs: 100,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each(["string", "object"] as const)("counts growth in %s replacements as progress", (kind) => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxIdleMs: 100 }, failure);
		guard.start(0);
		for (let index = 1; index <= 3; index++) {
			vi.advanceTimersByTime(60);
			const value = { text: "x".repeat(index) };
			expect(kind === "object" ? guard.replaceObject(0, value) : guard.replace(0, JSON.stringify(value))).toBe(true);
		}
		vi.advanceTimersByTime(60);
		const unchanged = { text: "xxx" };
		expect(kind === "object" ? guard.replaceObject(0, unchanged) : guard.replace(0, JSON.stringify(unchanged))).toBe(
			true,
		);
		vi.advanceTimersByTime(40);
		expect(failure).toHaveBeenCalledOnce();
		expect(failure.mock.calls[0]?.[0].diagnostic.details).toMatchObject({
			limit: "maxIdleMs",
			elapsedMs: 280,
			idleMs: 100,
		});
	});

	it("does not extend another interleaved call's idle deadline", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxIdleMs: 100 }, failure);
		guard.start(0);
		guard.start(1);
		vi.advanceTimersByTime(60);
		expect(guard.append(1, "progress")).toBe(true);
		vi.advanceTimersByTime(40);
		expect(failure).toHaveBeenCalledOnce();
		expect(failure.mock.calls[0]?.[0].diagnostic.details).toMatchObject({ contentIndex: 0, limit: "maxIdleMs" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("checks idle expiry when a late delta arrives before the timer callback", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxIdleMs: 100 }, failure);
		guard.start(0);
		const now = vi.spyOn(performance, "now").mockReturnValue(100);
		try {
			expect(guard.append(0, "too late")).toBe(false);
			expect(failure.mock.calls[0]?.[0].diagnostic.details).toMatchObject({ limit: "maxIdleMs", bytes: 0 });
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			now.mockRestore();
			guard.dispose();
		}
	});

	it("expires at the original deadline despite nonempty deltas", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
		const failures: ToolArgumentLimitFailure[] = [];
		const guard = new ToolArgumentGuard({ maxIdleMs: 25, maxDurationMs: 100 }, (failure) => failures.push(failure));
		guard.start(0);
		for (let index = 0; index < 9; index++) {
			vi.advanceTimersByTime(10);
			expect(guard.append(0, "x")).toBe(true);
		}
		vi.advanceTimersByTime(10);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.diagnostic.details).toMatchObject({ limit: "maxDurationMs", elapsedMs: 100, bytes: 9 });
		expect(guard.append(0, "x")).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not budget reasoning or time after a completed tool call", () => {
		vi.useFakeTimers();
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxDurationMs: 10 }, failure);
		vi.advanceTimersByTime(1000);
		guard.start(0);
		expect(guard.append(0, "{}")).toBe(true);
		guard.end(0);
		vi.advanceTimersByTime(1000);
		expect(failure).not.toHaveBeenCalled();
		guard.dispose();
	});

	it("bounds interleaved calls and retains completed calls in the aggregate budget", () => {
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxBytes: 8, maxTotalBytes: 10 }, failure);
		expect(guard.append(0, "12345")).toBe(true);
		expect(guard.append(1, "1234")).toBe(true);
		guard.end(0);
		expect(guard.append(1, "56")).toBe(false);
		expect(failure.mock.calls[0]?.[0].diagnostic.details).toMatchObject({ limit: "maxTotalBytes", totalBytes: 11 });
	});

	it("counts UTF-8 and a surrogate pair split across chunks", () => {
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxBytes: 6 }, failure);
		expect(guard.append(0, "é\ud83d")).toBe(true);
		expect(guard.append(0, "")).toBe(true);
		expect(guard.append(0, "\ude00")).toBe(true);
		expect(guard.append(0, "x")).toBe(false);
		expect(failure.mock.calls[0]?.[0].diagnostic.details).toMatchObject({ bytes: 7, limit: "maxBytes" });
	});

	it("checks final-only input and replacement payloads without double counting", () => {
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxBytes: 8, maxTotalBytes: 8 }, failure);
		expect(guard.append(0, '{"a":1}')).toBe(true);
		expect(guard.replace(0, '{"a":1}')).toBe(true);
		expect(guard.replace(0, '{"abc":1}')).toBe(false);
		expect(failure).toHaveBeenCalledOnce();
	});

	it("rejects a single enormous chunk after a bounded scan", () => {
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxBytes: 16 }, failure);
		expect(guard.replace(0, "x".repeat(1_000_000))).toBe(false);
		expect(failure.mock.calls[0]?.[0].diagnostic.details.bytes).toBe(17);
		expect(JSON.stringify(failure.mock.calls)).not.toContain("xxxxxxxx");
	});

	it("inspects a native preview before serialization without charging its ensuing delta twice", () => {
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxBytes: 7, maxTotalBytes: 7 }, failure);
		expect(guard.inspectObject(0, { a: 1 })).toBe(true);
		expect(guard.append(0, '{"a":1}')).toBe(true);
		expect(guard.replaceObject(0, { a: 1 })).toBe(true);
		expect(guard.complete(0)).toBe(true);
		expect(failure).not.toHaveBeenCalled();
		guard.dispose();
	});

	it.each<JsonObject>([
		{ path: "é😀", newText: 'quote"slash\\\u0000\n\ud800' },
		{ nested: [true, false, null, -1.5, { empty: [] }] },
	])("sizes structured arguments before cloning", (value) => {
		const expectedBytes = new TextEncoder().encode(JSON.stringify(value)).length;
		const allowed = new ToolArgumentGuard({ maxBytes: expectedBytes }, vi.fn());
		expect(allowed.replaceObject(0, value)).toBe(true);
		allowed.dispose();
		const failure = vi.fn();
		const rejected = new ToolArgumentGuard({ maxBytes: expectedBytes - 1 }, failure);
		expect(rejected.replaceObject(0, value)).toBe(false);
		expect(failure).toHaveBeenCalledOnce();
	});

	it.each([0, -1, NaN, Infinity, 0.5])("reports invalid configuration %s without throwing", (maxBytes) => {
		const guard = new ToolArgumentGuard({ maxBytes }, vi.fn());
		expect(guard.configurationError).toContain("maxBytes");
		guard.dispose();
	});

	it.each([0, -1, NaN, Infinity, 0.5, 2_147_483_648])("rejects invalid timeout %s", (value) => {
		for (const key of ["maxIdleMs", "maxDurationMs"] as const) {
			const guard = new ToolArgumentGuard({ [key]: value }, vi.fn());
			expect(guard.configurationError).toContain(key);
			guard.dispose();
		}
	});

	it("cleans all interleaved deadlines on cancellation", () => {
		vi.useFakeTimers();
		const failure = vi.fn();
		const guard = new ToolArgumentGuard({ maxDurationMs: 10 }, failure);
		guard.start(0);
		guard.start(1);
		guard.dispose();
		vi.runAllTimers();
		expect(failure).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});
