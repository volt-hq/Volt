import { describe, expect, it } from "vitest";
import { formatDuration } from "../src/core/tools/render-utils.ts";

describe("formatDuration", () => {
	it("shows tenths of a second under a minute, truncated", () => {
		expect(formatDuration(0)).toBe("0.0s");
		expect(formatDuration(1_234)).toBe("1.2s");
		expect(formatDuration(32_100)).toBe("32.1s");
		expect(formatDuration(59_999)).toBe("59.9s");
		expect(formatDuration(-500)).toBe("0.0s");
	});

	it("shows whole seconds under a minute when asked", () => {
		expect(formatDuration(42_900, { wholeSeconds: true })).toBe("42s");
		expect(formatDuration(-500, { wholeSeconds: true })).toBe("0s");
	});

	it("shows minutes and seconds past a minute", () => {
		expect(formatDuration(60_000)).toBe("1m");
		expect(formatDuration(95_000)).toBe("1m 35s");
		expect(formatDuration(192_400)).toBe("3m 12s");
		expect(formatDuration(2_820_000)).toBe("47m");
		expect(formatDuration(3_599_999)).toBe("59m 59s");
	});

	it("shows hours and minutes past an hour, then days and hours past a day", () => {
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(3_725_000)).toBe("1h 2m");
		expect(formatDuration(47 * 3_600_000 + 12 * 60_000)).toBe("1d 23h");
		expect(formatDuration(51 * 3_600_000)).toBe("2d 3h");
		expect(formatDuration(48 * 3_600_000 + 59 * 60_000)).toBe("2d");
	});

	it("formats past a minute the same with or without whole seconds", () => {
		for (const ms of [60_000, 192_400, 3_725_000, 51 * 3_600_000]) {
			expect(formatDuration(ms, { wholeSeconds: true })).toBe(formatDuration(ms));
		}
	});
});
