import { createJimp } from "@jimp/core";
import bmp, { msBmp } from "@jimp/js-bmp";
import gif from "@jimp/js-gif";
import jpeg from "@jimp/js-jpeg";
import png from "@jimp/js-png";
import { ResizeStrategy, methods as resizeMethods } from "@jimp/plugin-resize";

const Image = createJimp({
	formats: [png, jpeg, gif, bmp, msBmp],
	plugins: [resizeMethods],
});

export interface DecodedImage {
	readonly width: number;
	readonly height: number;
	readonly mime?: string;
	clone(): DecodedImage;
	resize(options: { w: number; h: number; mode: ResizeStrategy }): DecodedImage;
	getBuffer(mimeType: "image/png"): Promise<Buffer>;
	getBuffer(mimeType: "image/jpeg", options: { quality: number }): Promise<Buffer>;
}

export async function decodeImage(bytes: Uint8Array): Promise<DecodedImage> {
	return Image.fromBuffer(Buffer.from(bytes));
}

export function resizeDecodedImage(image: DecodedImage, width: number, height: number): DecodedImage {
	return image.clone().resize({
		w: width,
		h: height,
		mode: ResizeStrategy.BICUBIC,
	});
}

export async function encodePng(image: DecodedImage): Promise<Buffer> {
	return image.getBuffer("image/png");
}

export async function encodeJpeg(image: DecodedImage, quality: number): Promise<Buffer> {
	return image.getBuffer("image/jpeg", { quality });
}

export async function decodeImageToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	try {
		return await encodePng(await decodeImage(bytes));
	} catch {
		return null;
	}
}
