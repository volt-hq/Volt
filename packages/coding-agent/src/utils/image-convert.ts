import { decodeImageToPng } from "./image-codec.ts";

/**
 * Convert image to PNG format for terminal display.
 * Kitty graphics protocol requires PNG format (f=100).
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	try {
		const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
		const pngBuffer = await decodeImageToPng(bytes);
		if (!pngBuffer) return null;
		return {
			data: Buffer.from(pngBuffer).toString("base64"),
			mimeType: "image/png",
		};
	} catch {
		// Conversion failed
		return null;
	}
}
