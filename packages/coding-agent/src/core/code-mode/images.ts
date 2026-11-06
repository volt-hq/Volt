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
	/** The image as canonical base64. */
	data: string;
}

/** Where a nested call puts the images of its value (`CodeModeCall.images`). */
export interface CodeModeCallImages {
	/**
	 * Retains images of the call's value, all or none, and returns their references for the value to carry. The
	 * images reach the script only with the value: the runtime keeps them when it delivers the value and drops
	 * them otherwise. Rejects with `failed`: `limit_exceeded` when the script's images would exceed its limit, and
	 * without a reason for an image that is empty or not base64.
	 */
	add(images: readonly CodeModeImageInput[]): CodeModeImageRef[];
}

/** The images of one nested call until the runtime delivers its value or drops it. */
export interface CodeModeImageStaging extends CodeModeCallImages {
	/** References of the images added so far. */
	readonly refs: readonly string[];
	/** Keeps the images: their value reached the script. */
	commit(): void;
	/** Drops the images: their value never reached the script. */
	release(): void;
}

// ASCII whitespace, which base64 decoders skip (WHATWG forgiving-base64, and so the MCP SDK's check).
const BASE64_WHITESPACE = /[\t\n\f\r ]/;
const BASE64_WHITESPACE_RUNS = /[\t\n\f\r ]+/g;

/**
 * Whether `data` is `canonical`, the base64 of the bytes it decoded to, apart from whitespace and missing
 * padding. Anything else the lenient decoder skipped or misread, such as other characters, base64url, or a
 * `data:` prefix, would change the bytes.
 */
function isBase64Of(data: string, canonical: string): boolean {
	const stripped = BASE64_WHITESPACE.test(data) ? data.replace(BASE64_WHITESPACE_RUNS, "") : data;
	if (stripped === canonical) return true;
	const padding = canonical.length - stripped.length;
	return padding > 0 && padding <= 2 && canonical.endsWith("=".repeat(padding)) && canonical.startsWith(stripped);
}

/**
 * The images of one script. References are `img_1`, `img_2`, and so on, valid only within the script that
 * received them. The bytes of all images, retained or staged by calls in flight, stay within `maxBytes`.
 */
export class CodeModeImageStore {
	private readonly maxBytes: number;
	private readonly images = new Map<string, CodeModeStoredImage>();
	private retained = 0;
	private staged = 0;
	private lastRef = 0;

	constructor(maxBytes: number = MAX_RETAINED_IMAGE_BYTES) {
		this.maxBytes = maxBytes;
	}

	/** Bytes of the images delivered to the script. */
	get retainedBytes(): number {
		return this.retained;
	}

	/** Opens the images of one nested call. Its images count toward the limit from when they are added. */
	stage(): CodeModeImageStaging {
		const pending: CodeModeStoredImage[] = [];
		let pendingBytes = 0;
		let open = true;
		const close = () => {
			open = false;
			this.staged -= pendingBytes;
		};
		return {
			get refs() {
				return pending.map((image) => image.ref.ref);
			},
			add: (images) => {
				if (!open) throw new CodeModeCallError("cancelled", "the call ended before its images were added");
				const prepared = this.prepare(images);
				for (const image of prepared) {
					pending.push(image);
					pendingBytes += image.ref.bytes;
					this.staged += image.ref.bytes;
				}
				return prepared.map((image) => image.ref);
			},
			commit: () => {
				if (!open) return;
				close();
				for (const image of pending) this.images.set(image.ref.ref, image);
				this.retained += pendingBytes;
			},
			release: () => {
				if (open) close();
			},
		};
	}

	has(ref: string): boolean {
		return this.images.has(ref);
	}

	get(ref: string): CodeModeStoredImage | undefined {
		return this.images.get(ref);
	}

	/**
	 * Checks and measures images for retention, all or none. The limit is checked first against an upper bound
	 * that needs no decoding, the size the base64 length allows, so data over the limit is never decoded.
	 */
	private prepare(images: readonly CodeModeImageInput[]): CodeModeStoredImage[] {
		const held = this.retained + this.staged;
		const bound = images.reduce((sum, image) => sum + Buffer.byteLength(image.data, "base64"), 0);
		if (held + bound > this.maxBytes) {
			throw new CodeModeCallError(
				"failed",
				`the result's images are up to ${bound} bytes, and the script already holds ${held} of its ${this.maxBytes}-byte image limit`,
				"limit_exceeded",
			);
		}
		return images.map((image, index) => {
			const bytes = Buffer.from(image.data, "base64");
			const data = bytes.toString("base64");
			if (bytes.length === 0 || !isBase64Of(image.data, data)) {
				throw new CodeModeCallError("failed", `image ${index + 1} of the result is empty or not base64`);
			}
			const ref: CodeModeImageRef = {
				type: "image",
				ref: `img_${++this.lastRef}`,
				mimeType: image.mimeType,
				...imageDimensions(bytes),
				bytes: bytes.length,
				...(image.path === undefined ? {} : { path: image.path }),
			};
			return { ref, data };
		});
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
