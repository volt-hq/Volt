import { Buffer } from "node:buffer";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
	formatReviewPath,
	normalizeReviewPath,
	reviewPathBytes,
	reviewPathFromBytes,
	reviewPathFromUtf8,
	reviewPathToUtf8,
} from "../src/core/review-path.ts";

const component = fc
	.array(
		fc.integer({ min: 1, max: 254 }).map((byte) => (byte >= 47 ? byte + 1 : byte)),
		{ maxLength: 32 },
	)
	.map((bytes) => Buffer.from([120, ...bytes]));
const paths = fc
	.array(component, { minLength: 1, maxLength: 5 })
	.map((parts) => Buffer.concat(parts.flatMap((part, index) => (index === 0 ? [part] : [Buffer.from("/"), part]))));

describe("canonical review paths", () => {
	it("round-trips arbitrary filename bytes and serializes stably", () => {
		fc.assert(
			fc.property(paths, (bytes) => {
				const path = reviewPathFromBytes(bytes);
				expect(reviewPathBytes(path)).toEqual(bytes);
				expect(normalizeReviewPath(path)).toBe(path);
				expect(JSON.parse(JSON.stringify(path))).toBe(path);
			}),
			{ numRuns: 500 },
		);
	});

	it("is injective and preserves component prefixes", () => {
		fc.assert(
			fc.property(paths, paths, (left, right) => {
				const a = reviewPathFromBytes(left);
				const b = reviewPathFromBytes(right);
				expect(a === b).toBe(left.equals(right));
				const prefix = reviewPathFromBytes(left.subarray(0, left.indexOf(47) < 0 ? left.length : left.indexOf(47)));
				expect(a === prefix || a.startsWith(`${prefix}/`)).toBe(true);
				expect(reviewPathFromBytes(Buffer.concat([left, Buffer.from("/child")]))).toBe(`${a}/child`);
			}),
			{ numRuns: 500 },
		);
	});

	it("keeps printable UTF-8 and spaces without normalizing Unicode", () => {
		for (const path of ["src/value.ts", "café/路径 🧪.ts", " leading / trailing ", "é", "e\u0301"]) {
			expect(reviewPathFromUtf8(path)).toBe(path);
			expect(reviewPathToUtf8(path)).toBe(path);
		}
		expect(reviewPathFromUtf8("é")).not.toBe(reviewPathFromUtf8("e\u0301"));
	});

	it("distinguishes invalid bytes, U+FFFD, and literal escape-like filenames", () => {
		const names = [
			Buffer.from([0xfe]),
			Buffer.from([0xff]),
			Buffer.from("�"),
			Buffer.from("%FF"),
			Buffer.from("\\xFF"),
		];
		expect(names.map(reviewPathFromBytes)).toEqual(["%FE", "%FF", "�", "%25FF", "%5CxFF"]);
		expect(new Set(names.map(reviewPathFromBytes)).size).toBe(names.length);
		expect(reviewPathToUtf8("%FF")).toBeUndefined();
		expect(reviewPathToUtf8("%25FF")).toBe("%FF");
	});

	it("escapes reserved characters and controls and displays safely", () => {
		expect(reviewPathFromUtf8("100%\\:\n\t\u0085\u202e")).toBe("100%25%5C%3A%0A%09%C2%85%E2%80%AE");
		expect(formatReviewPath("line%0Abreak")).toBe('"line\\nbreak"');
		expect(formatReviewPath("invalid-%FF")).toBe('"invalid-%FF"');
	});

	it("normalizes only optional relative spelling", () => {
		expect(normalizeReviewPath("./src/value.ts/")).toBe("src/value.ts");
		expect(() => normalizeReviewPath("src\\value.ts")).toThrow(/canonical/);
		expect(normalizeReviewPath("src%5Cvalue.ts")).toBe("src%5Cvalue.ts");
	});

	it.each([
		"",
		"/absolute",
		"a//b",
		".",
		"..",
		"a/../b",
		"%00",
		"%2F",
		"%2E",
		"%41",
		"%ff",
		"%",
		"%G0",
		"\ud800",
		"\udfff",
	])("rejects invalid reference %j", (path) => {
		expect(() => reviewPathBytes(path)).toThrow();
	});

	it("rejects invalid raw components and lone-surrogate filenames", () => {
		for (const path of ["", "/a", "a//b", ".", "..", "a/./b", "a/../b", "a\0b"]) {
			expect(() => reviewPathFromBytes(Buffer.from(path))).toThrow();
		}
		expect(() => reviewPathFromUtf8("\ud800")).toThrow(/surrogate/);
	});
});
