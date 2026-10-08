import { describe, expect, it } from "vitest";
import { cloneCanonicalData } from "../src/core/canonical-data.ts";
import { omitUndefined } from "../src/utils/json.ts";

describe("omitUndefined", () => {
	it("drops undefined properties and keeps every other value, including falsy ones", () => {
		const result = omitUndefined({ absent: undefined, none: null, zero: 0, empty: "", no: false, kept: "x" });
		expect(Object.keys(result)).toEqual(["none", "zero", "empty", "no", "kept"]);
		expect(result).toEqual({ none: null, zero: 0, empty: "", no: false, kept: "x" });
	});

	it("produces data the canonical JSON admission accepts", () => {
		const value = { size: undefined as number | undefined, name: "note" };
		expect(() => cloneCanonicalData(value, "With undefined")).toThrow("undefined is not permitted");
		expect(cloneCanonicalData(omitUndefined(value), "Without undefined")).toEqual({ name: "note" });
	});

	it("copies shallowly and leaves the input unchanged", () => {
		const nested = { inner: undefined as string | undefined };
		const input = { nested, absent: undefined };
		const result = omitUndefined(input);
		expect(result.nested).toBe(nested);
		expect("absent" in input).toBe(true);
		expect("absent" in result).toBe(false);
	});
});
