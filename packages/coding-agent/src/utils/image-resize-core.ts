import { decodeImage, encodeJpeg, encodePng, resizeDecodedImage } from "./image-codec.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2000
	maxHeight?: number; // Default: 2000
	maxBytes?: number; // Default: 4.5MB of base64 payload (below Anthropic's 5MB limit)
	jpegQuality?: number; // Default: 80
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
};

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function matchesAscii(bytes: Uint8Array, offset: number, value: string): boolean {
	if (offset + value.length > bytes.length) return false;
	for (let i = 0; i < value.length; i++) {
		if (bytes[offset + i] !== value.charCodeAt(i)) return false;
	}
	return true;
}

function readWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 20 || !matchesAscii(bytes, 0, "RIFF") || !matchesAscii(bytes, 8, "WEBP")) {
		return null;
	}

	const riffSize = readUint32LE(bytes, 4);
	if (riffSize < 12 || riffSize + 8 > bytes.length) {
		return null;
	}

	let offset = 12;
	const riffEnd = riffSize + 8;
	while (offset + 8 <= riffEnd) {
		const chunkSize = readUint32LE(bytes, offset + 4);
		const dataStart = offset + 8;
		const dataEnd = dataStart + chunkSize;
		if (dataEnd > riffEnd || dataEnd > bytes.length) return null;

		if (matchesAscii(bytes, offset, "VP8X") && chunkSize >= 10) {
			return {
				width: readUint24LE(bytes, dataStart + 4) + 1,
				height: readUint24LE(bytes, dataStart + 7) + 1,
			};
		}

		if (matchesAscii(bytes, offset, "VP8L") && chunkSize >= 5 && bytes[dataStart] === 0x2f) {
			const dimensions = readUint32LE(bytes, dataStart + 1);
			return {
				width: (dimensions & 0x3fff) + 1,
				height: ((dimensions >>> 14) & 0x3fff) + 1,
			};
		}

		if (
			matchesAscii(bytes, offset, "VP8 ") &&
			chunkSize >= 10 &&
			bytes[dataStart + 3] === 0x9d &&
			bytes[dataStart + 4] === 0x01 &&
			bytes[dataStart + 5] === 0x2a
		) {
			const width = (bytes[dataStart + 6] | (bytes[dataStart + 7] << 8)) & 0x3fff;
			const height = (bytes[dataStart + 8] | (bytes[dataStart + 9] << 8)) & 0x3fff;
			return width > 0 && height > 0 ? { width, height } : null;
		}

		offset = dataEnd + (chunkSize % 2);
	}

	return null;
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * Uses a pure-JavaScript Jimp codec set for PNG, JPEG, GIF, and BMP. WebP is
 * passed through when it already satisfies the limits because the standalone
 * distribution intentionally does not carry a WebP native or WASM codec.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Try both PNG and JPEG formats, pick the smaller one
 * 3. If still too large, try JPEG with decreasing quality
 * 4. If still too large, progressively reduce dimensions until 1x1
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;
	const normalizedMimeType = mimeType.split(";")[0]?.trim().toLowerCase() || mimeType;

	if (normalizedMimeType === "image/webp") {
		const dimensions = readWebpDimensions(inputBytes);
		if (
			dimensions &&
			dimensions.width <= opts.maxWidth &&
			dimensions.height <= opts.maxHeight &&
			inputBase64Size < opts.maxBytes
		) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: normalizedMimeType,
				originalWidth: dimensions.width,
				originalHeight: dimensions.height,
				width: dimensions.width,
				height: dimensions.height,
				wasResized: false,
			};
		}
		return null;
	}

	try {
		const image = await decodeImage(inputBytes);
		const originalWidth = image.width;
		const originalHeight = image.height;

		// Check if already within all limits (dimensions AND encoded size)
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: normalizedMimeType || image.mime || "image/png",
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		// Calculate initial dimensions respecting max limits
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.max(1, Math.round((targetHeight * opts.maxWidth) / targetWidth));
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.max(1, Math.round((targetWidth * opts.maxHeight) / targetHeight));
			targetHeight = opts.maxHeight;
		}

		async function tryEncodings(width: number, height: number, jpegQualities: number[]): Promise<EncodedCandidate[]> {
			const resized = resizeDecodedImage(image, width, height);
			const candidates: EncodedCandidate[] = [encodeCandidate(await encodePng(resized), "image/png")];
			for (const quality of jpegQualities) {
				candidates.push(encodeCandidate(await encodeJpeg(resized, quality), "image/jpeg"));
			}
			return candidates;
		}

		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		while (true) {
			const candidates = await tryEncodings(currentWidth, currentHeight, qualitySteps);
			for (const candidate of candidates) {
				if (candidate.encodedSize < opts.maxBytes) {
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: currentWidth,
						height: currentHeight,
						wasResized: true,
					};
				}
			}

			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return null;
	} catch {
		return null;
	}
}
