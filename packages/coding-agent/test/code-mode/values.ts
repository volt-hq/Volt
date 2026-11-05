import fc from "fast-check";

/** Values the bridge codec accepts: JSON with finite doubles (including -0), BigInt, and any UTF-16 string. */
const codeUnitString = fc.string({
	unit: fc.integer({ min: 0, max: 0xffff }).map((code) => String.fromCharCode(code)),
	maxLength: 20,
});

const number = fc.oneof(
	fc.double({ noNaN: true, noDefaultInfinity: true }),
	fc.integer(),
	fc.constantFrom(-0, 2 ** 53, 2 ** 53 + 2, -(2 ** 60), Number.MAX_VALUE, Number.MIN_VALUE),
);

const bigint = fc.oneof(
	fc.bigInt({ min: -(2n ** 200n), max: 2n ** 200n }),
	fc.constantFrom(2n ** 53n, 2n ** 53n + 1n, 2n ** 64n, -(2n ** 70n)),
);

const key = codeUnitString.filter((candidate) => candidate !== "__proto__");

export const bridgeValue: fc.Arbitrary<unknown> = fc.letrec<{ value: unknown }>((tie) => ({
	value: fc.oneof(
		{ depthSize: "small", withCrossShrink: true },
		fc.constant(null),
		fc.boolean(),
		number,
		bigint,
		codeUnitString,
		fc.array(tie("value"), { maxLength: 5 }),
		fc.dictionary(key, tie("value"), { maxKeys: 5 }),
	),
})).value;

/**
 * The value `decode(encode(value))` must produce. JSON has one number type, so the codec preserves values,
 * not the number/BigInt distinction: a BigInt that a double holds exactly arrives as a number.
 */
export function expectedAfterRoundTrip(value: unknown): unknown {
	if (typeof value === "bigint") {
		const number = Number(value);
		return Number.isFinite(number) && BigInt(number) === value ? number : value;
	}
	if (Array.isArray(value)) return value.map(expectedAfterRoundTrip);
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [entryKey, entryValue] of Object.entries(value)) result[entryKey] = expectedAfterRoundTrip(entryValue);
		return result;
	}
	return value;
}
