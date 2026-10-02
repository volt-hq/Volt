import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	collectPromptImageAttachments,
	extractPathTokens,
	MAX_PROMPT_IMAGE_ATTACHMENTS,
} from "../src/modes/interactive/prompt-image-attachments.ts";

// Small 2x2 red PNG image (base64) - generated with ImageMagick
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURf8AAP///0EdNBEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gEOADM5Ddoh/wAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMS0xNFQwMDo1MTo1NyswMDowMOnKzHgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDEtMTRUMDA6NTE6NTcrMDA6MDCYl3TEAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAxLTE0VDAwOjUxOjU3KzAwOjAwz4JVGwAAAABJRU5ErkJggg==";

// Small 2x2 blue JPEG image (base64) - generated with ImageMagick
const TINY_JPEG =
	"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";

const visionModel = { input: ["text", "image"] as ("text" | "image")[] };
const textOnlyModel = { input: ["text"] as ("text" | "image")[] };

let dir: string;

beforeAll(async () => {
	dir = await mkdtemp(path.join(os.tmpdir(), "volt-prompt-images-"));
	await writeFile(path.join(dir, "shot.png"), Buffer.from(TINY_PNG, "base64"));
	await writeFile(path.join(dir, "with space.png"), Buffer.from(TINY_PNG, "base64"));
	await writeFile(path.join(dir, "photo.jpeg"), Buffer.from(TINY_JPEG, "base64"));
	await writeFile(path.join(dir, "notes.txt"), "just text");
	await writeFile(path.join(dir, "fake.png"), "not actually an image");
	await writeFile(path.join(dir, "empty.png"), "");
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

	it("caps the number of attachments and reports the overflow", async () => {
		const capDir = await mkdtemp(path.join(os.tmpdir(), "volt-prompt-images-cap-"));
		try {
			const names: string[] = [];
			for (let i = 0; i < MAX_PROMPT_IMAGE_ATTACHMENTS + 2; i++) {
				const name = `img-${String(i).padStart(2, "0")}.png`;
				await writeFile(path.join(capDir, name), Buffer.from(TINY_PNG, "base64"));
				names.push(name);
			}
			const result = await collectPromptImageAttachments(names.join(" "), capDir, visionModel);
			expect(result).not.toBeNull();
			expect(result!.images).toHaveLength(MAX_PROMPT_IMAGE_ATTACHMENTS);
			expect(result!.cappedPaths).toHaveLength(2);
		} finally {
			await rm(capDir, { recursive: true, force: true });
		}
	});
});
