import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CodeModeImageStore, imageDimensions } from "../../src/core/code-mode/images.ts";
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
		const [first, second] = store.add([
			{ data: PNG_1X1, mimeType: "image/png", path: "/repo/a.png" },
			{ data: GIF_1X1, mimeType: "image/gif" },
		]);
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
		const [unknown] = store.add([{ data: Buffer.from("not an image").toString("base64"), mimeType: "image/png" }]);
		expect(unknown.width).toBeUndefined();
		expect(unknown.height).toBeUndefined();
	});

	it("keeps all or none of a call's images, within the script's byte limit", () => {
		fc.assert(
			fc.property(fc.array(fc.array(fc.nat({ max: 400 }), { maxLength: 4 }), { maxLength: 12 }), (calls) => {
				const store = new CodeModeImageStore(1_000);
				const refs: string[] = [];
				for (const sizes of calls) {
					const before = store.retainedBytes;
					const images = sizes.map((size) => ({
						data: Buffer.alloc(size, 7).toString("base64"),
						mimeType: "image/png",
					}));
					const total = sizes.reduce((sum, size) => sum + size, 0);
					let added: string[] | undefined;
					try {
						added = store.add(images).map((image) => image.ref);
					} catch (error) {
						expect(error).toBeInstanceOf(CodeModeCallError);
						expect(error).toMatchObject({ kind: "failed", reason: "limit_exceeded" });
					}
					if (before + total <= 1_000) {
						expect(added).toHaveLength(sizes.length);
						expect(store.retainedBytes).toBe(before + total);
						refs.push(...(added ?? []));
					} else {
						expect(added).toBeUndefined();
						expect(store.retainedBytes).toBe(before);
					}
					expect(store.retainedBytes).toBeLessThanOrEqual(1_000);
				}
				expect(new Set(refs).size).toBe(refs.length);
				for (const ref of refs) expect(store.has(ref)).toBe(true);
			}),
			{ numRuns: 500 },
		);
	});
});
