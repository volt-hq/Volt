import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES,
	RPC_CONVERSATION_INPUT_MAX_IMAGES,
} from "@hansjm10/volt-protocol/wire-limits";
import { createJimp } from "@jimp/core";
import jpeg from "@jimp/js-jpeg";
import png from "@jimp/js-png";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeClientInputPayload } from "../src/core/session-entry-codec.ts";
import { collectPromptImageAttachments, extractPathTokens } from "../src/modes/interactive/prompt-image-attachments.ts";
import { decodeImage } from "../src/utils/image-codec.ts";

// Small 2x2 red PNG image (base64) - generated with ImageMagick
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

// Small 2x2 blue JPEG image (base64) - generated with ImageMagick
const TINY_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";

const visionModel = { input: ["text", "image"] as ("text" | "image")[] };
const textOnlyModel = { input: ["text"] as ("text" | "image")[] };

let dir: string;
let noisyPng: Buffer;
let noisyJpeg: Buffer;

beforeAll(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "volt-prompt-images-"));
	await writeFile(path.join(dir, "shot.png"), Buffer.from(TINY_PNG, "base64"));
	await writeFile(path.join(dir, "with space.png"), Buffer.from(TINY_PNG, "base64"));
	await writeFile(path.join(dir, "photo.jpeg"), Buffer.from(TINY_JPEG, "base64"));
	await writeFile(path.join(dir, "notes.txt"), "just text");
	await writeFile(path.join(dir, "fake.png"), "not actually an image");
	await writeFile(path.join(dir, "empty.png"), "");

	// Deterministic, poorly compressible pixels reproduce a screenshot that is
	// within the dimension limits but exceeds the prompt's base64 byte budget.
	const pixels = Buffer.alloc(800 * 600 * 4);
	let seed = 123456;
	for (let index = 0; index < pixels.length; index++) {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		pixels[index] = index % 4 === 3 ? 255 : seed & 255;
	}
	const Image = createJimp({ formats: [png, jpeg], plugins: [] });
	const image = Image.fromBitmap({ width: 800, height: 600, data: pixels });
	noisyPng = await image.getBuffer("image/png");
	noisyJpeg = await image.getBuffer("image/jpeg", { quality: 80 });
	await writeFile(path.join(dir, "large.png"), noisyPng);
	await writeFile(path.join(dir, "large.jpeg"), noisyJpeg);
	await writeFile(path.join(dir, "large-copy.jpeg"), noisyJpeg);

	// A valid 1x1 WebP with a large ancillary chunk: WebP has no local resize codec.
	const tinyWebp = Buffer.from("UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA", "base64");
	const largeWebp = Buffer.alloc((RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES * 3) / 4 + 64);
	tinyWebp.copy(largeWebp);
	largeWebp.writeUInt32LE(largeWebp.length - 8, 4);
	largeWebp.write("JUNK", tinyWebp.length);
	largeWebp.writeUInt32LE(largeWebp.length - tinyWebp.length - 8, tinyWebp.length + 4);
	await writeFile(path.join(dir, "large.webp"), largeWebp);
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("extractPathTokens", () => {
	it("splits bare tokens on whitespace", () => {
		expect(extractPathTokens("describe shot.png please")).toEqual(["describe", "shot.png", "please"]);
	});

	it("keeps double-quoted segments with spaces as one token", () => {
		expect(extractPathTokens('look at "/tmp/my shot.png" now')).toEqual(["look", "at", "/tmp/my shot.png", "now"]);
	});

	it("keeps single-quoted segments as one token", () => {
		expect(extractPathTokens("see '/tmp/a b.png'")).toEqual(["see", "/tmp/a b.png"]);
	});

	it("strips the @ prefix from mentions", () => {
		expect(extractPathTokens("check @src/foo.png")).toEqual(["check", "src/foo.png"]);
	});

	it("handles @-prefixed quoted mentions", () => {
		expect(extractPathTokens('check @"my dir/a b.png" ok')).toEqual(["check", "my dir/a b.png", "ok"]);
	});

	it("treats an unterminated quote as a bare token", () => {
		expect(extractPathTokens('hello "world')).toEqual(["hello", '"world']);
	});
});

describe("collectPromptImageAttachments", () => {
	it("returns null for models without image support", async () => {
		const text = `describe ${dir}/shot.png`;
		expect(await collectPromptImageAttachments(text, dir, textOnlyModel)).toBeNull();
		expect(await collectPromptImageAttachments(text, dir, undefined)).toBeNull();
	});

	it("attaches an absolute image path for vision models", async () => {
		const result = await collectPromptImageAttachments(`describe ${dir}/shot.png please`, dir, visionModel);
		expect(result).not.toBeNull();
		expect(result!.images).toHaveLength(1);
		expect(result!.images[0].type).toBe("image");
		expect(result!.images[0].mimeType).toBe("image/png");
		expect(result!.attachedPaths).toEqual([path.join(dir, "shot.png")]);
	});

	it("attaches relative paths resolved from cwd", async () => {
		const result = await collectPromptImageAttachments("describe shot.png", dir, visionModel);
		expect(result).not.toBeNull();
		expect(result!.attachedPaths).toEqual([path.join(dir, "shot.png")]);
	});

	it("attaches @-mentioned paths", async () => {
		const result = await collectPromptImageAttachments(`check @${dir}/photo.jpeg`, dir, visionModel);
		expect(result).not.toBeNull();
		expect(result!.images[0].mimeType).toBe("image/jpeg");
	});

	it("attaches quoted paths containing spaces", async () => {
		const result = await collectPromptImageAttachments(`look at "${dir}/with space.png"`, dir, visionModel);
		expect(result).not.toBeNull();
		expect(result!.attachedPaths).toEqual([path.join(dir, "with space.png")]);
	});

	it("expands tilde paths", async () => {
		const fileName = `volt-prompt-images-test-${process.pid}.png`;
		const homePath = path.join(os.homedir(), fileName);
		await writeFile(homePath, Buffer.from(TINY_PNG, "base64"));
		try {
			const result = await collectPromptImageAttachments(`describe ~/${fileName}`, dir, visionModel);
			expect(result).not.toBeNull();
			expect(result!.attachedPaths).toEqual([homePath]);
		} finally {
			await rm(homePath, { force: true });
		}
	});

	it("ignores nonexistent files", async () => {
		expect(await collectPromptImageAttachments(`describe ${dir}/missing.png`, dir, visionModel)).toBeNull();
	});

	it("ignores non-image and mislabeled files", async () => {
		expect(await collectPromptImageAttachments(`read ${dir}/notes.txt`, dir, visionModel)).toBeNull();
		expect(await collectPromptImageAttachments(`see ${dir}/fake.png`, dir, visionModel)).toBeNull();
		expect(await collectPromptImageAttachments(`see ${dir}/empty.png`, dir, visionModel)).toBeNull();
	});

	it("ignores plain prose without path-like tokens", async () => {
		expect(await collectPromptImageAttachments("hello there, how are you today?", dir, visionModel)).toBeNull();
	});

	it("dedupes repeated paths", async () => {
		const result = await collectPromptImageAttachments(
			`compare ${dir}/shot.png with shot.png and @${dir}/shot.png`,
			dir,
			visionModel,
		);
		expect(result).not.toBeNull();
		expect(result!.images).toHaveLength(1);
	});

	it("resizes screenshots to the prompt's base64 byte limit", async () => {
		expect(noisyPng.toString("base64").length).toBeGreaterThan(RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES);
		const message = "describe large.png";
		const result = await collectPromptImageAttachments(message, dir, visionModel);
		expect(result?.attachedPaths).toEqual([path.join(dir, "large.png")]);
		expect(result?.failedPaths).toEqual([]);
		expect(result?.images).toHaveLength(1);
		const attachment = result!.images[0];
		expect(Buffer.byteLength(attachment.data, "utf8")).toBeLessThanOrEqual(
			RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES,
		);
		expect(await decodeImage(Buffer.from(attachment.data, "base64"))).toMatchObject({ width: 800, height: 600 });
		expect(() => normalizeClientInputPayload("prompt", { message, images: result!.images })).not.toThrow();
	});

	it("fits multiple images within the combined budget even when each already fits individually", async () => {
		const encodedBytes = noisyJpeg.toString("base64").length;
		expect(encodedBytes).toBeLessThanOrEqual(RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES);
		expect(encodedBytes * 2).toBeGreaterThan(RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES);
		const message = "compare large.jpeg large-copy.jpeg";
		const result = await collectPromptImageAttachments(message, dir, visionModel);
		expect(result?.attachedPaths).toEqual([path.join(dir, "large.jpeg"), path.join(dir, "large-copy.jpeg")]);
		expect(result?.failedPaths).toEqual([]);
		expect(result?.images).toHaveLength(2);
		let totalBytes = 0;
		for (const image of result!.images) {
			const dataBytes = Buffer.byteLength(image.data, "utf8");
			expect(dataBytes).toBeLessThanOrEqual(RPC_CONVERSATION_INPUT_IMAGE_DATA_MAX_UTF8_BYTES);
			totalBytes += dataBytes + Buffer.byteLength(image.mimeType, "utf8");
			expect(await decodeImage(Buffer.from(image.data, "base64"))).toMatchObject({ width: 800, height: 600 });
		}
		expect(totalBytes).toBeLessThanOrEqual(RPC_CONVERSATION_INPUT_IMAGES_MAX_UTF8_BYTES);
		for (const command of ["prompt", "steer", "follow_up"] as const) {
			expect(() => normalizeClientInputPayload(command, { message, images: result!.images })).not.toThrow();
		}
	});

	it.each(["large.jpeg shot.png", "shot.png large.jpeg"])(
		"keeps images unchanged when their combined size already fits: %s",
		async (message) => {
			const result = await collectPromptImageAttachments(message, dir, visionModel);
			expect(result?.failedPaths).toEqual([]);
			expect(result?.images).toHaveLength(2);
			expect(result!.images.map((image) => image.data)).toEqual(
				message.startsWith("large.jpeg")
					? [noisyJpeg.toString("base64"), TINY_PNG]
					: [TINY_PNG, noisyJpeg.toString("base64")],
			);
			expect(() => normalizeClientInputPayload("prompt", { message, images: result!.images })).not.toThrow();
		},
	);

	it("reports an image that cannot fit without blocking other attachments", async () => {
		const message = "compare large.webp shot.png";
		const result = await collectPromptImageAttachments(message, dir, visionModel);
		expect(result?.failedPaths).toEqual([path.join(dir, "large.webp")]);
		expect(result?.attachedPaths).toEqual([path.join(dir, "shot.png")]);
		expect(result?.images).toEqual([{ type: "image", mimeType: "image/png", data: TINY_PNG }]);
		expect(() => normalizeClientInputPayload("prompt", { message, images: result!.images })).not.toThrow();
	});

	it("caps the number of attachments at the protocol limit and reports the overflow", async () => {
		const capDir = await mkdtemp(path.join(os.tmpdir(), "volt-prompt-images-cap-"));
		try {
			const names: string[] = [];
			for (let i = 0; i < RPC_CONVERSATION_INPUT_MAX_IMAGES + 2; i++) {
				const name = `img-${String(i).padStart(2, "0")}.png`;
				await writeFile(path.join(capDir, name), Buffer.from(TINY_PNG, "base64"));
				names.push(name);
			}
			const result = await collectPromptImageAttachments(names.join(" "), capDir, visionModel);
			expect(result).not.toBeNull();
			expect(result!.images).toHaveLength(RPC_CONVERSATION_INPUT_MAX_IMAGES);
			expect(result!.cappedPaths).toEqual(
				names.slice(RPC_CONVERSATION_INPUT_MAX_IMAGES).map((name) => path.join(capDir, name)),
			);
			expect(() =>
				normalizeClientInputPayload("prompt", { message: names.join(" "), images: result!.images }),
			).not.toThrow();
		} finally {
			await rm(capDir, { recursive: true, force: true });
		}
	});
});
