import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalVoltExperimental = process.env.VOLT_EXPERIMENTAL;

	afterEach(() => {
		if (originalVoltExperimental === undefined) {
			delete process.env.VOLT_EXPERIMENTAL;
		} else {
			process.env.VOLT_EXPERIMENTAL = originalVoltExperimental;
		}
	});

	it("returns false when VOLT_EXPERIMENTAL is unset", () => {
		delete process.env.VOLT_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when VOLT_EXPERIMENTAL is empty", () => {
		process.env.VOLT_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when VOLT_EXPERIMENTAL is set to 1", () => {
		process.env.VOLT_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when VOLT_EXPERIMENTAL is set to 0", () => {
		process.env.VOLT_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when VOLT_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.VOLT_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
