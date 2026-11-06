import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type CodeModeImageStaging, CodeModeImageStore, imageDimensions } from "../../src/core/code-mode/images.ts";
import { CodeModeCallError } from "../../src/core/code-mode/runtime.ts";
import { decodeImage, encodeJpeg, encodePng, resizeDecodedImage } from "../../src/utils/image-codec.ts";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
const GIF_1X1 = "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const WEBP_LOSSY_1X1 = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
const WEBP_LOSSLESS_1X1 = "UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==";
const WEBP_EXTENDED_1X1 =
	"UklGRkoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAARBxAR/Q9ERP8DAABWUDggGAAAABQBAJ0BKgEAAQAAAP4AAA3AAP7mtQAAAA==";

function bytes(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, "base64"));
}

/** A copy of `source` with its header changed by `edit`. */
function patched(source: Uint8Array, edit: (view: DataView) => void): Uint8Array {
	const copy = new Uint8Array(source);
	edit(new DataView(copy.buffer));
	return copy;
}

function setUint24(view: DataView, offset: number, value: number): void {
	view.setUint8(offset, value & 0xff);
	view.setUint8(offset + 1, (value >> 8) & 0xff);
	view.setUint8(offset + 2, (value >> 16) & 0xff);
}

describe("code mode image dimensions", () => {
	it("reads the size of PNG and JPEG images", async () => {
		const image = resizeDecodedImage(await decodeImage(bytes(PNG_1X1)), 37, 21);
		expect(imageDimensions(await encodePng(image))).toStrictEqual({ width: 37, height: 21 });
		expect(imageDimensions(await encodeJpeg(image, 80))).toStrictEqual({ width: 37, height: 21 });
		expect(imageDimensions(bytes(PNG_1X1))).toStrictEqual({ width: 1, height: 1 });
	});

	it("reads the size of GIF and WebP images", () => {
		expect(imageDimensions(bytes(GIF_1X1))).toStrictEqual({ width: 1, height: 1 });
		const gif = patched(bytes(GIF_1X1), (view) => {
			view.setUint16(6, 300, true);
			view.setUint16(8, 200, true);
		});
		expect(imageDimensions(gif)).toStrictEqual({ width: 300, height: 200 });
		for (const base64 of [WEBP_LOSSY_1X1, WEBP_LOSSLESS_1X1, WEBP_EXTENDED_1X1]) {
			expect(imageDimensions(bytes(base64)), base64).toStrictEqual({ width: 1, height: 1 });
		}
		const lossy = patched(bytes(WEBP_LOSSY_1X1), (view) => {
			view.setUint16(26, (view.getUint16(26, true) & 0xc000) | 1920, true);
			view.setUint16(28, (view.getUint16(28, true) & 0xc000) | 1080, true);
		});
		expect(imageDimensions(lossy)).toStrictEqual({ width: 1920, height: 1080 });
		const lossless = patched(bytes(WEBP_LOSSLESS_1X1), (view) => {
			const flags = view.getUint32(21, true) & 0xf0000000;
			view.setUint32(21, (flags | ((600 - 1) << 14) | (800 - 1)) >>> 0, true);
		});
		expect(imageDimensions(lossless)).toStrictEqual({ width: 800, height: 600 });
		const extended = patched(bytes(WEBP_EXTENDED_1X1), (view) => {
			setUint24(view, 24, 4096 - 1);
			setUint24(view, 27, 2160 - 1);
		});
		expect(imageDimensions(extended)).toStrictEqual({ width: 4096, height: 2160 });
	});

	it("gives no size for data that is not a complete image header, and never throws", () => {
		expect(imageDimensions(new Uint8Array())).toBeUndefined();
		expect(imageDimensions(bytes(PNG_1X1).subarray(0, 20))).toBeUndefined();
		expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeUndefined();
		const samples = [PNG_1X1, GIF_1X1, WEBP_LOSSY_1X1, WEBP_LOSSLESS_1X1, WEBP_EXTENDED_1X1].map(bytes);
		fc.assert(
			fc.property(
				fc.oneof(
					fc.uint8Array({ maxLength: 64 }),
					// A real header, cut short and with one byte changed.
					fc
						.record({
							sample: fc.constantFrom(...samples),
							cut: fc.nat({ max: 80 }),
							at: fc.nat({ max: 80 }),
							value: fc.integer({ min: 0, max: 255 }),
						})
						.map(({ sample, cut, at, value }) => {
							const copy = new Uint8Array(sample.subarray(0, cut));
							if (at < copy.length) copy[at] = value;
							return copy;
						}),
				),
				(data) => {
					const size = imageDimensions(data);
					if (size !== undefined) expect(size.width > 0 && size.height > 0).toBe(true);
				},
			),
			{ numRuns: 2000 },
		);
	});
});

describe("code mode image store", () => {
	it("issues sequential references with each image's type, size, and file", () => {
		const store = new CodeModeImageStore();
		const call = store.stage();
		const [first, second] = call.add([
			{ data: PNG_1X1, mimeType: "image/png", path: "/repo/a.png" },
			{ data: GIF_1X1, mimeType: "image/gif" },
		]);
		call.commit();
		expect(first).toStrictEqual({
			type: "image",
			ref: "img_1",
			mimeType: "image/png",
			width: 1,
			height: 1,
			bytes: bytes(PNG_1X1).length,
			path: "/repo/a.png",
		});
		expect(second).toMatchObject({ ref: "img_2", mimeType: "image/gif", bytes: bytes(GIF_1X1).length });
		expect(second.path).toBeUndefined();
		expect(store.get("img_1")).toStrictEqual({ ref: first, data: PNG_1X1 });
		expect([store.has("img_2"), store.has("img_3")]).toStrictEqual([true, false]);
		// An image whose header gives no size has none.
		const next = store.stage();
		const [unknown] = next.add([{ data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }]);
		expect(unknown).toMatchObject({ ref: "img_3" });
		expect(unknown.width).toBeUndefined();
		expect(unknown.height).toBeUndefined();
	});

	it("keeps a call's images only once committed, and counts staged images toward the limit", () => {
		// Each call: the sizes of its images, then whether its value reaches the script.
		const call = fc.record({
			sizes: fc.array(fc.integer({ min: 1, max: 400 }), { maxLength: 4 }),
			delivered: fc.boolean(),
		});
		fc.assert(
			fc.property(fc.array(call, { maxLength: 12 }), fc.nat({ max: 3 }), (calls, inFlight) => {
				const store = new CodeModeImageStore(1_000);
				// Calls overlap: up to `inFlight` earlier calls are still open when the next one adds its images.
				const open: { staging: CodeModeImageStaging; bytes: number; delivered: boolean }[] = [];
				const kept: string[] = [];
				const dropped: string[] = [];
				let retained = 0;
				const settleOldest = () => {
					const oldest = open.shift();
					if (!oldest) return;
					if (oldest.delivered) {
						kept.push(...oldest.staging.refs);
						oldest.staging.commit();
						retained += oldest.bytes;
					} else {
						dropped.push(...oldest.staging.refs);
						oldest.staging.release();
					}
				};
				for (const { sizes, delivered } of calls) {
					while (open.length > inFlight) settleOldest();
					const held = retained + open.reduce((sum, entry) => sum + entry.bytes, 0);
					const total = sizes.reduce((sum, size) => sum + size, 0);
					const staging = store.stage();
					const images = sizes.map((size) => ({
						data: Buffer.alloc(size, 7).toString("base64"),
						mimeType: "image/png",
					}));
					if (held + total <= 1_000) {
						expect(staging.add(images)).toHaveLength(sizes.length);
						open.push({ staging, bytes: total, delivered });
					} else {
						expect(() => staging.add(images)).toThrow(
							expect.objectContaining({ kind: "failed", reason: "limit_exceeded" }),
						);
						expect(staging.refs).toStrictEqual([]);
						staging.release();
					}
					// Staged images are not the script's until committed.
					for (const ref of staging.refs) expect(store.has(ref)).toBe(false);
					expect(store.retainedBytes).toBe(retained);
				}
				while (open.length > 0) settleOldest();
				expect(store.retainedBytes).toBe(retained);
				expect(store.retainedBytes).toBeLessThanOrEqual(1_000);
				expect(new Set([...kept, ...dropped]).size).toBe(kept.length + dropped.length);
				for (const ref of kept) expect(store.has(ref)).toBe(true);
				for (const ref of dropped) expect(store.get(ref)).toBeUndefined();
			}),
			{ numRuns: 500 },
		);
	});

	it("accepts base64 with whitespace or without padding, keeps it canonical, and rejects other data", () => {
		const store = new CodeModeImageStore();
		const wrapped = `${PNG_1X1.slice(0, 40)}\r\n${PNG_1X1.slice(40)}\n`;
		const unpadded = GIF_1X1.replace(/=+$/, "");
		const call = store.stage();
		const refs = call.add([
			{ data: wrapped, mimeType: "image/png" },
			{ data: unpadded, mimeType: "image/gif" },
		]);
		call.commit();
		expect(refs.map((ref) => store.get(ref.ref)?.data)).toStrictEqual([PNG_1X1, GIF_1X1]);
		expect(refs[0]).toMatchObject({ width: 1, height: 1, bytes: bytes(PNG_1X1).length });
		const rejected = [
			"",
			`data:image/png;base64,${PNG_1X1}`,
			Buffer.from(bytes(PNG_1X1)).toString("base64url"),
			`${PNG_1X1.slice(0, 20)}!${PNG_1X1.slice(20)}`,
			`QQ==${PNG_1X1}`,
			// Bits after the last byte that a canonical encoder leaves zero.
			"QR==",
		];
		for (const data of rejected) {
			const staging = store.stage();
			expect(
				() =>
					staging.add([
						{ data: PNG_1X1, mimeType: "image/png" },
						{ data, mimeType: "image/png" },
					]),
				data,
			).toThrow(
				expect.objectContaining({ kind: "failed", message: "image 2 of the result is empty or not base64" }),
			);
			expect(staging.refs, data).toStrictEqual([]);
		}
	});

	it("checks the limit against the base64 length before decoding", () => {
		// Decoding skips whitespace, so this decodes to 3 bytes; it is counted as what its length allows.
		const padded = `${" ".repeat(4_000)}QUJD`;
		const staging = new CodeModeImageStore(1_000).stage();
		expect(() => staging.add([{ data: padded, mimeType: "image/png" }])).toThrow(
			expect.objectContaining({ kind: "failed", reason: "limit_exceeded" }),
		);
		expect(() => staging.add([{ data: "QUJD", mimeType: "image/png" }])).not.toThrow();
	});

	it("rejects images added after the call settled", () => {
		const store = new CodeModeImageStore();
		const staging = store.stage();
		staging.release();
		expect(() => staging.add([{ data: PNG_1X1, mimeType: "image/png" }])).toThrow(CodeModeCallError);
		staging.commit();
		expect(store.retainedBytes).toBe(0);
	});
});
