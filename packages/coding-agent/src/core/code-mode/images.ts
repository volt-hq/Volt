import { MAX_RETAINED_IMAGE_BYTES } from "./limits.ts";
import { CodeModeCallError } from "./runtime.ts";

/**
 * A reference to an image a nested call returned (section 5.9 of docs/code-mode-design.md). The bytes stay on
 * the host; the script shows the image by passing the reference to `image()`.
 */
export interface CodeModeImageRef {
	type: "image";
	ref: string;
	mimeType: string;
	width?: number;
	height?: number;
	/** Size of the image, in bytes. */
	bytes: number;
	/** The file the image came from, when there is one. */
	path?: string;
}

/** An image a nested call returned, as base64 data. */
export interface CodeModeImageInput {
	data: string;
	mimeType: string;
	path?: string;
}

/** An image the host retains for a script, and its reference. */
export interface CodeModeStoredImage {
	ref: CodeModeImageRef;
	data: string;
}

/**
 * The images of one script. References are `img_1`, `img_2`, and so on, valid only within the script that
 * received them. The bytes of all images together stay within `maxBytes`.
 */
export class CodeModeImageStore {
	private readonly maxBytes: number;
	private readonly images = new Map<string, CodeModeStoredImage>();
	private retained = 0;

	constructor(maxBytes: number = MAX_RETAINED_IMAGE_BYTES) {
		this.maxBytes = maxBytes;
	}

	/** Bytes of every image retained so far. */
	get retainedBytes(): number {
		return this.retained;
	}

	/**
	 * Retains the images of one nested call, all or none, and returns their references. Rejects the call with
	 * `failed` (`limit_exceeded`) when the images would exceed the script's limit.
	 */
	add(images: readonly CodeModeImageInput[]): CodeModeImageRef[] {
		const decoded = images.map((image) => ({ image, bytes: Buffer.from(image.data, "base64") }));
		const total = decoded.reduce((sum, entry) => sum + entry.bytes.length, 0);
		if (this.retained + total > this.maxBytes) {
			throw new CodeModeCallError(
				"failed",
				`the result's images are ${total} bytes, and the script already holds ${this.retained} of its ${this.maxBytes}-byte image limit`,
				"limit_exceeded",
			);
		}
		return decoded.map(({ image, bytes }) => {
			const dimensions = imageDimensions(bytes);
			const ref: CodeModeImageRef = {
				type: "image",
				ref: `img_${this.images.size + 1}`,
				mimeType: image.mimeType,
				...dimensions,
				bytes: bytes.length,
				...(image.path === undefined ? {} : { path: image.path }),
			};
			this.images.set(ref.ref, { ref, data: image.data });
			this.retained += bytes.length;
			return ref;
		});
	}

	has(ref: string): boolean {
		return this.images.has(ref);
	}

	get(ref: string): CodeModeStoredImage | undefined {
		return this.images.get(ref);
	}
}

/** Width and height from a PNG, GIF, JPEG, or WebP header, or undefined when the header does not give them. */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const ascii = (offset: number, length: number) =>
		offset + length <= bytes.length ? String.fromCharCode(...bytes.subarray(offset, offset + length)) : "";
	const size = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined);

	if (ascii(1, 3) === "PNG" && bytes[0] === 0x89 && ascii(12, 4) === "IHDR" && bytes.length >= 24) {
		return size(view.getUint32(16), view.getUint32(20));
	}
	if ((ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") && bytes.length >= 10) {
		return size(view.getUint16(6, true), view.getUint16(8, true));
	}
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegDimensions(bytes, view);
	if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP" && bytes.length >= 30) {
		switch (ascii(12, 4)) {
			case "VP8 ":
				return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
			case "VP8L": {
				const bits = view.getUint32(21, true);
				return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
			}
			case "VP8X":
				return size(
					1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)),
					1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)),
				);
		}
	}
	return undefined;
}

/** Reads the frame size from the first start-of-frame segment of a JPEG. */
function jpegDimensions(bytes: Uint8Array, view: DataView): { width: number; height: number } | undefined {
	let offset = 2;
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) return undefined;
		const marker = bytes[offset + 1];
		if (marker === 0xff) {
			offset++;
			continue;
		}
		// Markers without a segment: TEM and the restart markers.
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		const isStartOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
		if (isStartOfFrame) {
			if (offset + 9 > bytes.length) return undefined;
			const height = view.getUint16(offset + 5);
			const width = view.getUint16(offset + 7);
			return width > 0 && height > 0 ? { width, height } : undefined;
		}
		offset += 2 + view.getUint16(offset + 2);
	}
	return undefined;
}
