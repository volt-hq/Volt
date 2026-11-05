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
 * Values the codec must reject, with the path suffix its error names relative to the value itself. Each is
 * created fresh, because some (cycles, holes) cannot be shared between runs.
 */
const rejectedLeaves: Record<string, { make: () => unknown; suffix: string }> = {
	nan: { make: () => Number.NaN, suffix: "" },
	infinity: { make: () => Number.NEGATIVE_INFINITY, suffix: "" },
	function: { make: () => () => {}, suffix: "" },
	symbol: { make: () => Symbol("s"), suffix: "" },
	date: { make: () => new Date(0), suffix: "" },
	map: { make: () => new Map(), suffix: "" },
	set: { make: () => new Set(), suffix: "" },
	regexp: { make: () => /x/, suffix: "" },
	typedArray: { make: () => new Uint8Array(1), suffix: "" },
	classInstance: { make: () => new (class Point {})(), suffix: "" },
	boxed: { make: () => Object(1), suffix: "" },
	arraySubclass: {
		make: () => {
			class Tagged extends Array {}
			return Tagged.from([1]);
		},
		suffix: "",
	},
	nullPrototypeArray: { make: () => Object.setPrototypeOf([1], null), suffix: "" },
	arrayProperty: { make: () => Object.assign([1], { tag: 1 }), suffix: ".tag" },
	arrayHole: {
		make: () => {
			const holey: unknown[] = [1];
			holey[2] = 3;
			return holey;
		},
		suffix: "[1]",
	},
	undefinedElement: { make: () => [1, undefined], suffix: "[1]" },
	nonEnumerable: { make: () => Object.defineProperty({}, "hidden", { value: 1 }), suffix: ".hidden" },
	symbolKey: { make: () => ({ [Symbol("s")]: 1 }), suffix: "" },
	protoKey: { make: () => JSON.parse('{"__proto__":1}'), suffix: ".__proto__" },
	cycle: {
		make: () => {
			const cyclic: Record<string, unknown> = {};
			cyclic.self = cyclic;
			return cyclic;
		},
		suffix: ".self",
	},
};

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function formatSegment(segment: string | number): string {
	if (typeof segment === "number") return `[${segment}]`;
	return IDENTIFIER.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`;
}

/** Wraps `leaf` in valid objects and arrays so it sits at `segments`; siblings are valid values. */
function place(segments: (string | number)[], leaf: unknown): unknown {
	let value = leaf;
	for (let i = segments.length - 1; i >= 0; i--) {
		const segment = segments[i];
		if (typeof segment === "number") {
			const array: unknown[] = Array.from({ length: segment + 2 }, (_, index) => index);
			array[segment] = value;
			value = array;
		} else {
			value = { sibling: [1, "two"], [segment]: value };
		}
	}
	return value;
}

/** A value holding exactly one rejected leaf, and the path the encoder's error must name (root `args`). */
export const rejectedValue: fc.Arbitrary<{ kind: string; make: () => unknown; path: string }> = fc
	.record({
		kind: fc.constantFrom(...Object.keys(rejectedLeaves)),
		segments: fc.array(fc.oneof(key, fc.nat({ max: 3 })), { maxLength: 4 }),
	})
	.map(({ kind, segments }) => ({
		kind,
		make: () => place(segments, rejectedLeaves[kind].make()),
		path: `args${segments.map(formatSegment).join("")}${rejectedLeaves[kind].suffix}`,
	}));

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
