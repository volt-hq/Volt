import { describe, expect, it } from "vitest";
import { getModels } from "../src/models.ts";

describe("Xiaomi MiMo models", () => {
	it.each(["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const)(
		"omits mimo-v2-flash from %s",
		(provider) => {
			expect(getModels(provider).some((model) => model.id === "mimo-v2-flash")).toBe(false);
		},
	);
});
