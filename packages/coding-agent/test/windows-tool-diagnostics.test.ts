import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeToolProgressCapture } from "../src/core/tool-progress-capture.ts";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal()),
	execFile: vi.fn(() => {
		throw new Error("Diagnostic writes must not start a subprocess");
	}),
}));

const roots: string[] = [];
afterEach(async () => {
	vi.clearAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "win32")("Windows private tool capture", () => {
	it("publishes a native capture atomically without launching PowerShell", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-native-tool-capture-"));
		roots.push(root);
		const directory = join(root, "debug");
		const path = join(directory, "capture.json");
		await writeToolProgressCapture(path, "first snapshot");
		await writeToolProgressCapture(path, "second snapshot 界");
		expect(await readFile(path, "utf8")).toBe("second snapshot 界");
		expect(await readdir(directory)).toEqual(["capture.json"]);
		expect(execFile).not.toHaveBeenCalled();
	});

	it("removes its temporary file if atomic publication fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "volt-native-tool-capture-"));
		roots.push(root);
		const directory = join(root, "debug");
		const path = join(directory, "capture.json");
		await mkdir(path, { recursive: true });
		await expect(writeToolProgressCapture(path, "private sample")).rejects.toThrow();
		expect(await readdir(directory)).toEqual(["capture.json"]);
		expect(await readdir(path)).toEqual([]);
		expect(execFile).not.toHaveBeenCalled();
	});
});
