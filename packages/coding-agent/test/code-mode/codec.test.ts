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
import { bridgeValue, expectedAfterRoundTrip } from "./values.ts";

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
		expect(decodeBridgeValue('["__proto__"]')).toStrictEqual(["__proto__"]);
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
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => encodeBridgeValue(cycle, "args")).toThrow("args.self: a circular reference is not JSON");
		let nested: unknown = 1;
		for (let i = 0; i < 65; i++) nested = [nested];
		expect(() => encodeBridgeValue(nested, "args")).toThrow(/nesting is deeper than 64 levels/);
	});

	it("never calls toJSON", () => {
		expect(() => encodeBridgeValue({ toJSON: () => "converted" }, "args")).toThrow(
			"args.toJSON: a function is not JSON",
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
	});
});
