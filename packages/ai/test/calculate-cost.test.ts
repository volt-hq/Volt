import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { calculateCost, getModel, getPriceVersion } from "../src/models.ts";
import { UsageSchema } from "../src/schemas.ts";
import type { Usage } from "../src/types.ts";

function deepFreeze<T extends object>(value: T): T {
	for (const child of Object.values(value)) {
		if (typeof child === "object" && child !== null) deepFreeze(child);
	}
	return Object.freeze(value);
}

describe("calculateCost", () => {
	it("derives a new cost from token counts without modifying the usage", () => {
		// claude-opus-4-8: input 5, output 25, cacheRead 0.5, cacheWrite (5m) 6.25 per Mtok.
		const model = getModel("anthropic", "claude-opus-4-8");
		const usage: Usage = deepFreeze({
			availability: "complete",
			input: 1_000_000,
			output: 1_000_000,
			cacheRead: 1_000_000,
			cacheWrite: 1_000_000,
			cacheWrite1h: 400_000,
			totalTokens: 4_000_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});
		const before = structuredClone(usage);

		const cost = calculateCost(model, usage);

		expect(usage).toEqual(before);
		expect(cost).not.toBe(usage.cost);
		expect(cost.input).toBeCloseTo(5, 10);
		expect(cost.output).toBeCloseTo(25, 10);
		expect(cost.cacheRead).toBeCloseTo(0.5, 10);
		// 600k at the 5m write rate plus 400k at twice the input rate.
		expect(cost.cacheWrite).toBeCloseTo(3.75 + 4, 10);
		expect(cost.total).toBeCloseTo(5 + 25 + 0.5 + 7.75, 10);
		expect(calculateCost(model, usage)).toEqual(cost);
		expect(Value.Check(UsageSchema, { ...usage, cost })).toBe(true);
	});

	it("records the version of the price table the cost was derived from", () => {
		const model = getModel("anthropic", "claude-opus-4-8");
		const cost = calculateCost(model, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });

		expect(cost.priceVersion).toBe(getPriceVersion(model.cost));
		expect(cost.priceVersion).toMatch(/^[0-9a-f]{8}$/);
	});
});

describe("getPriceVersion", () => {
	it("is stable for equal rates and changes when any rate changes", () => {
		const prices = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
		const version = getPriceVersion(prices);

		expect(getPriceVersion({ ...prices })).toBe(version);
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			expect(getPriceVersion({ ...prices, [key]: prices[key] + 0.01 }), key).not.toBe(version);
		}
		expect(getPriceVersion({ ...prices, input: prices.output, output: prices.input })).not.toBe(version);
	});
});
