import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeBridgeValue, encodeBridgeValue } from "../../src/core/code-mode/codec.ts";
import {
	CodeModeProtocolError,
	parseCallPayload,
	parseDonePayload,
	parseOutputPayload,
	parseWorkerMessage,
} from "../../src/core/code-mode/protocol.ts";
import { bridgeValue, expectedAfterRoundTrip, rejectedValue } from "./values.ts";

describe("code mode bridge codec", () => {
	it("writes the expected wire text", () => {
		expect(encodeBridgeValue({ a: [1, "x", null, true], b: { c: -0 } }, "value")).toBe(
			'{"a":[1,"x",null,true],"b":{"c":-0}}',
		);
		expect(encodeBridgeValue(12345678901234567890n, "value")).toBe("12345678901234567890");
		// Integer doubles beyond 2^53 are written with all their digits, not the shortest digits.
		expect(encodeBridgeValue(2 ** 60, "value")).toBe("1152921504606846976");
		expect(encodeBridgeValue(1e300, "value")).toBe(BigInt(1e300).toString());
		expect(encodeBridgeValue(0.1, "value")).toBe("0.1");
		expect(encodeBridgeValue(1.5e-7, "value")).toBe("1.5e-7");
		expect(encodeBridgeValue({ omitted: undefined, kept: 1 }, "value")).toBe('{"kept":1}');
		expect(encodeBridgeValue("\ud800", "value")).toBe('"\\ud800"');
	});

	it("decodes integers a double cannot hold as BigInt and the rest as numbers", () => {
		expect(decodeBridgeValue("9007199254740993")).toBe(9007199254740993n);
		expect(decodeBridgeValue("9007199254740992")).toBe(9007199254740992);
		expect(decodeBridgeValue("1152921504606846976")).toBe(2 ** 60);
		expect(decodeBridgeValue("1000000000000000000000000")).toBe(10n ** 24n);
		expect(decodeBridgeValue("1e+24")).toBe(1e24);
		expect(Object.is(decodeBridgeValue("-0"), -0)).toBe(true);
		expect(decodeBridgeValue(`1${"0".repeat(400)}`)).toBe(10n ** 400n);
		expect(decodeBridgeValue("0.30000000000000004")).toBe(0.1 + 0.2);
		expect(decodeBridgeValue('"\\ud800"')).toBe("\ud800");
	});

	it("rejects literals the encoder cannot produce", () => {
		expect(() => decodeBridgeValue("0.1000000000000000055511151231257827")).toThrow(SyntaxError);
		expect(() => decodeBridgeValue("1e400")).toThrow(SyntaxError);
		expect(() => decodeBridgeValue('{"__proto__":{"polluted":true}}')).toThrow(/__proto__/);
		expect(() => decodeBridgeValue(String.raw`{"\u005f_proto__":{"polluted":true}}`)).toThrow(/__proto__/);
		expect(decodeBridgeValue('["__proto__"]')).toStrictEqual(["__proto__"]);
		expect(decodeBridgeValue(String.raw`{"\u0061":"\u0062"}`)).toStrictEqual({ a: "b" });
	});

	it("bounds nesting before parsing", () => {
		const deep = (levels: number) => `${"[".repeat(levels)}${"]".repeat(levels)}`;
		expect(decodeBridgeValue(deep(64))).toBeDefined();
		expect(() => decodeBridgeValue(deep(65))).toThrow(/deeper than 64/);
		expect(() => decodeBridgeValue(deep(100_000))).toThrow(/deeper than 64/);
		expect(decodeBridgeValue(`"${"[".repeat(100)}"`)).toBe("[".repeat(100));
	});

	it("names the path of a value JSON cannot represent", () => {
		const cases: [unknown, string][] = [
			[{ when: new Date(0) }, "args.when: Date is not JSON; use .toISOString()"],
			[{ m: new Map() }, "args.m: Map is not JSON; use Object.fromEntries(map)"],
			[{ list: [1, Number.NaN] }, "args.list[1]: NaN is not JSON"],
			[{ list: [1, undefined] }, "args.list[1]: undefined in an array is not JSON; use null"],
			[{ "odd key": () => {} }, 'args["odd key"]: a function is not JSON'],
			[{ bytes: new Uint8Array(1) }, "args.bytes: Uint8Array is not JSON; use Array.from()"],
			[
				{ instance: new (class Point {})() },
				"args.instance: a Point instance is not JSON; copy its fields into a plain object",
			],
			[JSON.parse('{"__proto__":1}'), 'args.__proto__: a key named "__proto__" is not allowed'],
			[{ [Symbol("s")]: 1 }, "args: symbol-keyed properties are not JSON"],
			[Infinity, "args: Infinity is not JSON"],
		];
		for (const [value, message] of cases) expect(() => encodeBridgeValue(value, "args")).toThrow(message);
		const holey: unknown[] = [1];
		holey[2] = 3;
		expect(() => encodeBridgeValue(holey, "args")).toThrow("args[1]: an array hole is not JSON; fill the array");
		// The array's shape is checked before its elements are read, so the extra property is found first.
		const holeyWithExtra = Object.assign(holey.slice(), { x: 1 });
		expect(() => encodeBridgeValue(holeyWithExtra, "args")).toThrow("args.x: a property on an array is not JSON");
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => encodeBridgeValue(cycle, "args")).toThrow("args.self: a circular reference is not JSON");
		let nested: unknown = 1;
		for (let i = 0; i < 65; i++) nested = [nested];
		expect(() => encodeBridgeValue(nested, "args")).toThrow(/nesting is deeper than 64 levels/);
	});

	it("rejects array properties, array prototypes, and non-enumerable properties instead of dropping them", () => {
		expect(() => encodeBridgeValue({ list: Object.assign([1], { tag: 2 }) }, "args")).toThrow(
			"args.list.tag: a property on an array is not JSON; move it into an object",
		);
		expect(() => encodeBridgeValue(Object.assign([1], { [Symbol("x")]: 3 }), "args")).toThrow(
			"args: symbol-keyed properties are not JSON",
		);
		class Tagged extends Array {}
		expect(() => encodeBridgeValue({ list: Tagged.from([1, 2]) }, "args")).toThrow(
			"args.list: a Tagged array is not JSON; use Array.from(value)",
		);
		expect(() => encodeBridgeValue(Object.setPrototypeOf([1], null), "args")).toThrow(
			"args: an array with a custom prototype is not JSON; use Array.from(value)",
		);
		const hidden = { visible: 1 };
		Object.defineProperty(hidden, "path", { value: "file.ts" });
		expect(() => encodeBridgeValue({ nested: hidden }, "args")).toThrow(
			"args.nested.path: a non-enumerable property is not JSON; define it as an ordinary property",
		);
		const hiddenElement = [1];
		Object.defineProperty(hiddenElement, "0", { value: 1, enumerable: false });
		expect(() => encodeBridgeValue({ list: hiddenElement }, "args")).toThrow(
			"args.list[0]: a non-enumerable element is not JSON; define it as an ordinary element",
		);
		const bigArray = Array.from({ length: 100_000 }, (_, i) => i);
		expect(decodeBridgeValue(encodeBridgeValue(bigArray, "args"))).toStrictEqual(bigArray);
	});

	it("reads only properties that are still own and enumerable when a getter changes the value", () => {
		const deletesLater = {
			get a() {
				delete (this as { b?: number }).b;
				return 1;
			},
			b: 2,
		};
		expect(() => encodeBridgeValue(deletesLater, "args")).toThrow(
			"args.b: a property deleted while the value was being encoded is not JSON",
		);
		const hidesLater = {
			get a() {
				Object.defineProperty(this, "b", { enumerable: false });
				return 1;
			},
			b: 2,
		};
		expect(() => encodeBridgeValue(hidesLater, "args")).toThrow("args.b: a non-enumerable property is not JSON");
		const list = [1, 2];
		Object.defineProperty(list, 0, {
			enumerable: true,
			get() {
				list.length = 1;
				return 1;
			},
		});
		expect(() => encodeBridgeValue(list, "args")).toThrow("args[1]: an array hole is not JSON; fill the array");
		// A hole present when encoding starts stays a hole, even if a getter fills it before it is read.
		const sparse: unknown[] = new Array(2);
		Object.defineProperty(sparse, 0, {
			enumerable: true,
			get() {
				sparse[1] = 42;
				return 1;
			},
		});
		expect(() => encodeBridgeValue(sparse, "args")).toThrow("args[1]: an array hole is not JSON; fill the array");
	});

	it("never calls toJSON", () => {
		expect(() => encodeBridgeValue({ toJSON: () => "converted" }, "args")).toThrow(
			"args.toJSON: a function is not JSON",
		);
	});

	it("rejects every value with one unrepresentable part, naming the path of that part", () => {
		fc.assert(
			fc.property(rejectedValue, ({ make, path }) => {
				let thrown: unknown;
				try {
					encodeBridgeValue(make(), "args");
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(TypeError);
				expect((thrown as TypeError).message.startsWith(`${path}: `)).toBe(true);
			}),
			{ numRuns: 500 },
		);
	});

	it("round-trips every accepted value exactly", () => {
		fc.assert(
			fc.property(bridgeValue, (value) => {
				expect(decodeBridgeValue(encodeBridgeValue(value, "value"))).toStrictEqual(expectedAfterRoundTrip(value));
			}),
			{ numRuns: 500 },
		);
	});
});

describe("code mode protocol parsing", () => {
	it("accepts well-formed worker messages and rejects malformed ones", () => {
		expect(parseWorkerMessage({ type: "call", id: 3, payload: "{}" })).toStrictEqual({
			type: "call",
			id: 3,
			payload: "{}",
		});
		expect(parseWorkerMessage({ type: "stopped", id: 3, reason: "compute_budget" })?.type).toBe("stopped");
		expect(parseWorkerMessage({ type: "call", id: -1, payload: "{}" })).toBeUndefined();
		expect(parseWorkerMessage({ type: "call", id: 1, payload: 5 })).toBeUndefined();
		expect(parseWorkerMessage({ type: "stopped", id: 1, reason: "other" })).toBeUndefined();
		expect(parseWorkerMessage({ type: "unknown", id: 1 })).toBeUndefined();
		expect(parseWorkerMessage(null)).toBeUndefined();
	});

	it("parses call frames and rejects forged ones", () => {
		expect(parseCallPayload('{"seq":1,"binding":"read","args":{"n":9007199254740993}}')).toStrictEqual({
			seq: 1,
			binding: "read",
			args: { n: 9007199254740993n },
		});
		for (const payload of [
			"not json",
			'{"seq":0,"binding":"read","args":{}}',
			'{"seq":1.5,"binding":"read","args":{}}',
			'{"seq":1,"binding":"","args":{}}',
			`{"seq":1,"binding":"${"x".repeat(257)}","args":{}}`,
			`{"seq":1,"binding":"read","args":${"[".repeat(65)}${"]".repeat(65)}}`,
			String.raw`{"seq":1,"binding":"read","args":{"\u005f_proto__":{"p":1}}}`,
		]) {
			expect(() => parseCallPayload(payload)).toThrow(CodeModeProtocolError);
		}
	});

	it("parses output and done frames", () => {
		expect(parseOutputPayload('{"type":"console","level":"warn","text":"x"}')).toStrictEqual({
			type: "console",
			level: "warn",
			text: "x",
		});
		expect(() => parseOutputPayload('{"type":"console","level":"trace","text":"x"}')).toThrow(CodeModeProtocolError);
		expect(() => parseOutputPayload(`{"type":"image","ref":"${"x".repeat(65)}"}`)).toThrow(CodeModeProtocolError);
		expect(parseDonePayload('{"ok":true}')).toStrictEqual({ ok: true, hasValue: false });
		expect(parseDonePayload('{"ok":true,"value":null}')).toStrictEqual({ ok: true, hasValue: true, value: null });
		expect(() => parseDonePayload('{"ok":false,"phase":"run","error":{"name":"E"}}')).toThrow(CodeModeProtocolError);
		const done = (error: Record<string, unknown>) =>
			JSON.stringify({
				ok: false,
				phase: "run",
				error: { name: "Error", summary: "Error: x", text: "Error: x", outOfMemory: false, ...error },
			});
		expect(parseDonePayload(done({ text: "Error: x\n    at f (script.js:1:1)" }))).toMatchObject({ ok: false });
		for (const forged of [
			{ name: "N".repeat(129) },
			{ name: "Bad\nName" },
			{ summary: "s".repeat(1025) },
			{ summary: "Error: line\nNested tool calls: 0" },
			{ summary: "Error: line\u2028more" },
			{ text: "t".repeat(8193) },
		]) {
			expect(() => parseDonePayload(done(forged))).toThrow("error description exceeds its limits");
		}
	});
});
