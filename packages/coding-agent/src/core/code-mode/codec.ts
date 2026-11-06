import { MAX_BRIDGE_JSON_DEPTH } from "./limits.ts";

/** Encodes and decodes values crossing the code mode bridge as JSON text without losing information. */
export interface LosslessCodec {
	/**
	 * Encodes `value`, or throws a `TypeError` naming the path of the first value JSON cannot represent
	 * exactly, for example `args.when: Date is not JSON; use .toISOString()`. `label` names the root.
	 */
	encode(value: unknown, label: string): string;
	/** Decodes text produced by `encode`, or throws a `SyntaxError`. */
	decode(text: string): unknown;
}

/**
 * Creates the bridge codec (section 5.9 of docs/code-mode-design.md).
 *
 * The prelude embeds this function's source in every VM, so it must stay self-contained: it may not
 * reference anything outside its own body, and it captures every built-in it uses when it is called.
 * In a VM it is called before any script runs, so later changes a script makes to globals or
 * prototypes do not affect it.
 */
export function createLosslessCodec(maxDepth: number): LosslessCodec {
	const call = Function.prototype.call;
	const uncurry = <F extends (this: never, ...args: never[]) => unknown>(fn: F) =>
		call.bind(fn) as unknown as (self: ThisParameterType<F>, ...args: Parameters<F>) => ReturnType<F>;

	const JSONParse = JSON.parse;
	const JSONStringify = JSON.stringify;
	const ObjectGetPrototypeOf = Object.getPrototypeOf;
	const ObjectGetOwnPropertySymbols = Object.getOwnPropertySymbols;
	const ObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
	const ObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
	const ObjectHasOwn = Object.hasOwn;
	const ObjectKeys = Object.keys;
	const ObjectIs = Object.is;
	const ObjectSetPrototypeOf = Object.setPrototypeOf;
	const ObjectPrototype = Object.prototype;
	const ObjectPrototypeToString = uncurry(Object.prototype.toString);
	const ObjectPrototypePropertyIsEnumerable = uncurry(Object.prototype.propertyIsEnumerable);
	const ArrayIsArray = Array.isArray;
	const ArrayPrototype = Array.prototype;
	const ArrayPrototypePush = uncurry(Array.prototype.push);
	const ArrayPrototypePop = uncurry(Array.prototype.pop);
	const ArrayPrototypeJoin = uncurry(Array.prototype.join);
	const ArrayPrototypeIncludes = uncurry(Array.prototype.includes);
	const NumberCtor = Number;
	const NumberIsFinite = Number.isFinite;
	const NumberIsInteger = Number.isInteger;
	const BigIntCtor = BigInt;
	const BigIntPrototypeToString = uncurry(BigInt.prototype.toString);
	const StringCtor = String;
	const StringPrototypeSlice = uncurry(String.prototype.slice);
	const StringPrototypeIndexOf = uncurry(String.prototype.indexOf);
	const RegExpPrototypeExec = uncurry(RegExp.prototype.exec);
	const TypeErrorCtor = TypeError;
	const SyntaxErrorCtor = SyntaxError;

	const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
	// Text without these cannot hold a number literal that needs the reviver: integer literals of up to
	// 15 digits and decimals of up to 15 significant digits round-trip through a double unchanged.
	const NEEDS_REVIVER = /\d[\d.]{15}|[eE][+-]?\d{3}/;
	const NUMBER_LITERAL = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;
	const MAX_SAFE = 2 ** 53;

	/**
	 * An array without a prototype. Pushing onto an ordinary array performs [[Set]], which runs setters a
	 * script may define on `Array.prototype` or `Object.prototype` indices; these lists have no prototype.
	 */
	function newList<T>(): T[] {
		return ObjectSetPrototypeOf([], null) as T[];
	}

	interface EncodeState {
		label: string;
		parts: string[];
		path: (string | number)[];
		ancestors: object[];
	}

	function formatPath(state: EncodeState): string {
		let text = state.label;
		for (let i = 0; i < state.path.length; i++) {
			const segment = state.path[i];
			if (typeof segment === "number") text += `[${segment}]`;
			else if (RegExpPrototypeExec(IDENTIFIER, segment) !== null) text += `.${segment}`;
			else text += `[${JSONStringify(segment)}]`;
		}
		return text;
	}

	function encodeError(state: EncodeState, reason: string): TypeError {
		return new TypeErrorCtor(`${formatPath(state)}: ${reason}`);
	}

	function constructorName(proto: object): string | undefined {
		const ctor = ObjectGetOwnPropertyDescriptor(proto, "constructor")?.value;
		if (typeof ctor !== "function") return undefined;
		const name = ObjectGetOwnPropertyDescriptor(ctor, "name")?.value;
		return typeof name === "string" && name !== "" ? name : undefined;
	}

	function describeNonPlain(value: object, proto: object): string {
		const tag = StringPrototypeSlice(ObjectPrototypeToString(value), 8, -1);
		switch (tag) {
			case "Date":
				return "Date is not JSON; use .toISOString()";
			case "Map":
				return "Map is not JSON; use Object.fromEntries(map)";
			case "Set":
				return "Set is not JSON; use Array.from(set)";
			case "RegExp":
				return "RegExp is not JSON; use .source";
			case "Error":
				return "Error is not JSON; use .message";
			case "Promise":
				return "Promise is not JSON; await it first";
			case "ArrayBuffer":
			case "SharedArrayBuffer":
				return `${tag} is not JSON; use Array.from(new Uint8Array(buffer))`;
			case "Number":
			case "String":
			case "Boolean":
			case "BigInt":
			case "Symbol":
				return `a boxed ${tag} is not JSON; use .valueOf()`;
		}
		if (tag !== "Array" && StringPrototypeSlice(tag, -5) === "Array") return `${tag} is not JSON; use Array.from()`;
		const name = constructorName(proto);
		return name === undefined
			? "an object with a custom prototype is not JSON; copy its fields into a plain object"
			: `a ${name} instance is not JSON; copy its fields into a plain object`;
	}

	function writeNumber(state: EncodeState, value: number): void {
		if (!NumberIsFinite(value)) throw encodeError(state, `${value} is not JSON`);
		if (ObjectIs(value, -0)) ArrayPrototypePush(state.parts, "-0");
		// Integers a double holds beyond 2^53 are written with all their digits, so the literal is the
		// double's exact value and decodes back to the same number.
		else if (NumberIsInteger(value) && (value >= MAX_SAFE || value <= -MAX_SAFE))
			ArrayPrototypePush(state.parts, BigIntPrototypeToString(BigIntCtor(value)));
		else ArrayPrototypePush(state.parts, JSONStringify(value));
	}

	function isElementIndex(name: string, length: number): boolean {
		const index = NumberCtor(name);
		return NumberIsInteger(index) && index >= 0 && index < length && StringCtor(index) === name;
	}

	/**
	 * Reads a property only while it is still an own enumerable property of `target`. A getter that ran
	 * earlier in the same encoding may have deleted it, and reading it with [[Get]] alone would then encode
	 * a value inherited from a prototype. Properties a getter adds during encoding are not part of the value.
	 */
	function readOwn(state: EncodeState, target: object, key: string | number, isElement: boolean): unknown {
		if (!ObjectPrototypePropertyIsEnumerable(target, key)) {
			if (!ObjectHasOwn(target, key)) {
				throw encodeError(
					state,
					isElement
						? "an array hole is not JSON; fill the array"
						: "a property deleted while the value was being encoded is not JSON",
				);
			}
			throw encodeError(
				state,
				isElement
					? "a non-enumerable element is not JSON; define it as an ordinary element"
					: "a non-enumerable property is not JSON; define it as an ordinary property",
			);
		}
		return (target as Record<string | number, unknown>)[key];
	}

	/**
	 * Throws for an array with a custom prototype, properties besides its elements, or holes, judged before any
	 * of its elements is read: a getter cannot fill a hole that existed when encoding started. `readOwn` catches
	 * holes a getter creates later.
	 */
	function checkArrayShape(state: EncodeState, array: unknown[], length: number): void {
		const proto = ObjectGetPrototypeOf(array);
		if (proto !== ArrayPrototype) {
			const name = proto === null ? undefined : constructorName(proto);
			throw encodeError(
				state,
				name === undefined
					? "an array with a custom prototype is not JSON; use Array.from(value)"
					: `a ${name} array is not JSON; use Array.from(value)`,
			);
		}
		if (ObjectGetOwnPropertySymbols(array).length > 0)
			throw encodeError(state, "symbol-keyed properties are not JSON");
		// Own string keys list integer indices first, in ascending order, then other keys such as `length`.
		// Exactly `length` indices followed by `length` means the array is dense with nothing else on it.
		const names = ObjectGetOwnPropertyNames(array);
		if (names.length === length + 1 && names[length] === "length") return;
		let elements = 0;
		for (let i = 0; i < names.length; i++) {
			const name = names[i];
			if (name === "length") continue;
			if (isElementIndex(name, length)) {
				elements++;
				continue;
			}
			ArrayPrototypePush(state.path, name);
			throw encodeError(state, "a property on an array is not JSON; move it into an object");
		}
		if (elements === length) return;
		for (let i = 0; i < length; i++) {
			if (!ObjectHasOwn(array, i)) {
				ArrayPrototypePush(state.path, i);
				throw encodeError(state, "an array hole is not JSON; fill the array");
			}
		}
	}

	function writeArray(state: EncodeState, array: unknown[], depth: number): void {
		const length = array.length;
		checkArrayShape(state, array, length);
		ArrayPrototypePush(state.parts, "[");
		for (let i = 0; i < length; i++) {
			if (i > 0) ArrayPrototypePush(state.parts, ",");
			ArrayPrototypePush(state.path, i);
			const element = readOwn(state, array, i, true);
			if (element === undefined) throw encodeError(state, "undefined in an array is not JSON; use null");
			write(state, element, depth + 1);
			ArrayPrototypePop(state.path);
		}
		ArrayPrototypePush(state.parts, "]");
	}

	function writeObject(state: EncodeState, object: object, depth: number): void {
		const proto = ObjectGetPrototypeOf(object);
		if (proto !== ObjectPrototype && proto !== null) throw encodeError(state, describeNonPlain(object, proto));
		if (ObjectGetOwnPropertySymbols(object).length > 0)
			throw encodeError(state, "symbol-keyed properties are not JSON");
		const keys = ObjectKeys(object);
		const names = ObjectGetOwnPropertyNames(object);
		if (names.length !== keys.length) {
			for (let i = 0; i < names.length; i++) {
				if (!ObjectPrototypePropertyIsEnumerable(object, names[i])) {
					ArrayPrototypePush(state.path, names[i]);
					throw encodeError(state, "a non-enumerable property is not JSON; define it as an ordinary property");
				}
			}
		}
		ArrayPrototypePush(state.parts, "{");
		let first = true;
		for (let i = 0; i < keys.length; i++) {
			const key = keys[i];
			ArrayPrototypePush(state.path, key);
			if (key === "__proto__") throw encodeError(state, 'a key named "__proto__" is not allowed');
			const property = readOwn(state, object, key, false);
			// Properties holding undefined are omitted: a missing field and undefined mean the same thing.
			if (property !== undefined) {
				if (!first) ArrayPrototypePush(state.parts, ",");
				first = false;
				ArrayPrototypePush(state.parts, JSONStringify(key));
				ArrayPrototypePush(state.parts, ":");
				write(state, property, depth + 1);
			}
			ArrayPrototypePop(state.path);
		}
		ArrayPrototypePush(state.parts, "}");
	}

	function write(state: EncodeState, value: unknown, depth: number): void {
		switch (typeof value) {
			case "string":
				ArrayPrototypePush(state.parts, JSONStringify(value));
				return;
			case "number":
				writeNumber(state, value);
				return;
			case "boolean":
				ArrayPrototypePush(state.parts, value ? "true" : "false");
				return;
			case "bigint":
				ArrayPrototypePush(state.parts, BigIntPrototypeToString(value));
				return;
			case "undefined":
				throw encodeError(state, "undefined is not JSON");
			case "function":
				throw encodeError(state, "a function is not JSON");
			case "symbol":
				throw encodeError(state, "a symbol is not JSON");
		}
		if (value === null) {
			ArrayPrototypePush(state.parts, "null");
			return;
		}
		const object = value as object;
		if (depth >= maxDepth) throw encodeError(state, `nesting is deeper than ${maxDepth} levels`);
		if (ArrayPrototypeIncludes(state.ancestors, object)) throw encodeError(state, "a circular reference is not JSON");
		ArrayPrototypePush(state.ancestors, object);
		if (ArrayIsArray(object)) writeArray(state, object, depth);
		else writeObject(state, object, depth);
		ArrayPrototypePop(state.ancestors);
	}

	function encode(value: unknown, label: string): string {
		// State is per call: a getter may call a binding, which encodes while this encoding is in progress.
		const state: EncodeState = { label, parts: newList(), path: newList(), ancestors: newList() };
		write(state, value, 0);
		return ArrayPrototypeJoin(state.parts, "");
	}

	interface Decimal {
		digits: string;
		exponent: number;
	}

	/** Splits a literal into its significant digits and a power of ten, without leading or trailing zeros. */
	function normalize(integer: string, fraction: string, exponent: number): Decimal {
		const digits = integer + fraction;
		let start = 0;
		while (start < digits.length && digits[start] === "0") start++;
		let end = digits.length;
		let power = exponent - fraction.length;
		while (end > start && digits[end - 1] === "0") {
			end--;
			power++;
		}
		return { digits: StringPrototypeSlice(digits, start, end), exponent: power };
	}

	function reviveNumber(source: string, value: number): number | bigint {
		const literal = RegExpPrototypeExec(NUMBER_LITERAL, source);
		if (literal === null) throw new SyntaxErrorCtor(`invalid number literal ${source}`);
		const negative = literal[1] === "-";
		const fraction = literal[3] ?? "";
		const exponentText = literal[4];
		if (fraction === "" && exponentText === undefined) {
			// An integer literal is a number when a double holds it exactly, and a BigInt otherwise.
			const exact = BigIntCtor(source);
			if (NumberIsFinite(value) && BigIntCtor(value) === exact) return value;
			return exact;
		}
		// A literal with a fraction or exponent must be the shortest form of the double it decodes to.
		if (NumberIsFinite(value)) {
			const parsed = normalize(literal[2], fraction, exponentText === undefined ? 0 : NumberCtor(exponentText));
			if (parsed.digits === "") return value;
			const canonical = RegExpPrototypeExec(
				NUMBER_LITERAL,
				StringPrototypeSlice(StringCtor(value), negative ? 1 : 0),
			);
			if (canonical !== null) {
				const expected = normalize(
					canonical[2],
					canonical[3] ?? "",
					canonical[4] === undefined ? 0 : NumberCtor(canonical[4]),
				);
				if (expected.digits === parsed.digits && expected.exponent === parsed.exponent) return value;
			}
		}
		throw new SyntaxErrorCtor(`number literal ${source} cannot be represented exactly`);
	}

	function revive(key: string, value: unknown, context?: { source?: unknown }): unknown {
		if (key === "__proto__") throw new SyntaxErrorCtor('a key named "__proto__" is not allowed');
		if (typeof value !== "number") return value;
		const source = context?.source;
		if (typeof source !== "string") throw new SyntaxErrorCtor("number literal source is unavailable");
		return reviveNumber(source, value);
	}

	function decode(text: string): unknown {
		// The reviver also rejects `__proto__` keys, which JSON can spell with escapes such as `\u005f`.
		if (
			RegExpPrototypeExec(NEEDS_REVIVER, text) === null &&
			StringPrototypeIndexOf(text, '"__proto__"') === -1 &&
			StringPrototypeIndexOf(text, "\\u") === -1
		) {
			return JSONParse(text);
		}
		return JSONParse(text, revive);
	}

	return { encode, decode };
}

const hostCodec = createLosslessCodec(MAX_BRIDGE_JSON_DEPTH);

/** Encodes a host value for the bridge. Throws a `TypeError` naming the path of an unrepresentable value. */
export function encodeBridgeValue(value: unknown, label: string): string {
	return hostCodec.encode(value, label);
}

/**
 * Decodes bridge text from a worker. Nesting is bounded by `maxDepth` levels before parsing, so a hostile
 * frame cannot exhaust the host's stack. Throws a `SyntaxError` for text the codec could not have produced.
 */
export function decodeBridgeValue(text: string, maxDepth: number = MAX_BRIDGE_JSON_DEPTH): unknown {
	if (exceedsJsonDepth(text, maxDepth)) throw new SyntaxError(`nesting is deeper than ${maxDepth} levels`);
	return hostCodec.decode(text);
}

function exceedsJsonDepth(text: string, maxDepth: number): boolean {
	let depth = 0;
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (inString) {
			if (code === 0x5c) i++;
			else if (code === 0x22) inString = false;
		} else if (code === 0x22) inString = true;
		else if (code === 0x7b || code === 0x5b) {
			depth++;
			if (depth > maxDepth) return true;
		} else if (code === 0x7d || code === 0x5d) depth--;
	}
	return false;
}
