import type { TextContent } from "@hansjm10/volt-ai";
import { expect, it, vi } from "vitest";

vi.mock("../../src/utils/image-resize.ts", () => ({ resizeImage: vi.fn(async () => null) }));

import { type CodeModeRenderImage, renderCodeModeResult } from "../../src/core/code-mode/render.ts";
import { resizeImage } from "../../src/utils/image-resize.ts";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==";
/** A WebP header, which is all the format check reads. */
const WEBP = Buffer.from("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ", "latin1").toString("base64");

function received(data: string, mimeType: string, path: string): CodeModeRenderImage {
	return {
		stored: { ref: { type: "image", ref: "img_1", mimeType, bytes: Buffer.from(data, "base64").length, path }, data },
		source: `read ${path}`,
	};
}

it("captions an image that cannot be resized below the inline limits and sends no image block", async () => {
	const cases = [
		{
			image: received(PNG_1X1, "image/png", "/a.png"),
			format: "image/png",
			caption:
				"[image img_1: image/png, /a.png; not shown: it could not be resized below the inline image size limit]",
		},
		{
			image: received(WEBP, "image/webp", "/a.webp"),
			format: "image/webp",
			caption:
				"[image img_1: image/webp, /a.webp; not shown: WebP exceeds the inline limits and Volt does not include a local WebP resize codec]",
		},
	];
	for (const { image, format, caption } of cases) {
		vi.mocked(resizeImage).mockClear();
		const rendered = await renderCodeModeResult({
			result: {
				ok: true,
				hasValue: false,
				output: [{ type: "image", ref: "img_1" }],
				calls: [],
				durationMs: 5,
				storeWrites: { set: [], delete: [] },
			},
			calls: [],
			images: [image],
		});
		expect(vi.mocked(resizeImage)).toHaveBeenCalledWith(Buffer.from(image.stored.data, "base64"), format);
		expect(rendered.content).toStrictEqual<TextContent[]>([
			{ type: "text", text: `Script completed in 0.0s (0 tool calls)\n${caption}` },
		]);
		expect(rendered.shownImages).toStrictEqual([]);
	}
});
