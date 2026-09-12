import { Buffer } from "node:buffer";
import {
	type ChildProcessWithoutNullStreams,
	type ExecFileException,
	type ExecFileOptions,
	spawn,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeWindowsReviewDiagnostic } from "../src/core/windows-review-private-diagnostics.ts";

type Completion = (error: ExecFileException | null, stdout: string, stderr: string) => void;
const processMocks = vi.hoisted(() => ({
	execFile:
		vi.fn<(file: string, args: string[], options: ExecFileOptions, callback: Completion) => { stdin: Writable }>(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal()),
	execFile: processMocks.execFile,
}));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	processMocks.execFile.mockReset();
});

describe("Windows diagnostic subprocess failure containment", () => {
	it.each(["timeout", "permission failure", "early pipe closure"])(
		"sanitizes %s and bounds subprocess work",
		async (failure) => {
			const systemRoot = join(tmpdir(), "windows-system-fixture");
			vi.stubEnv("SystemRoot", systemRoot);
			const path = join(tmpdir(), "private-path-marker", "review.jsonl");
			const content = "private-content-marker\n$(throw 'not code'); 界";
			const input = new PassThrough();
			const inputChunks: Buffer[] = [];
			input.on("data", (chunk: Buffer) => inputChunks.push(chunk));
			let completion: Completion | undefined;
			processMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
				completion = callback;
				return { stdin: input };
			});
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const pending = writeWindowsReviewDiagnostic(path, content);
			const rejection = expect(pending).rejects.toThrow(/^Could not retain private Windows review diagnostics\.$/);
			const invocation = processMocks.execFile.mock.calls[0];
			if (!invocation || !completion) throw new Error("Expected a diagnostic subprocess");
			expect(invocation[0]).toBe(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
			expect(invocation[2]).toEqual({ windowsHide: true, timeout: 10_000, maxBuffer: 8_192 });
			expect(invocation[1].slice(0, -1)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
			const executedScript = Buffer.from(invocation[1].at(-1)!, "base64").toString("utf16le");
			expect(executedScript).not.toContain("private-path-marker");
			expect(executedScript).not.toContain("private-content-marker");
			const request = Buffer.concat(inputChunks).toString("utf8");
			expect(request.split("\n")).toHaveLength(2);
			expect(request.endsWith("\n")).toBe(true);
			expect(JSON.parse(request)).toEqual({
				directory: dirname(path),
				path,
				content,
			});
			if (failure === "early pipe closure") {
				expect(() => input.emit("error", new Error(`EPIPE ${path} ${content}`))).not.toThrow();
			}
			const error: ExecFileException = Object.assign(new Error(`${path}: ${content}`), {
				code: failure === "timeout" ? "ETIMEDOUT" : "EACCES",
				...(failure === "timeout" ? { killed: true, signal: "SIGTERM" as const } : {}),
			});
			completion(error, "private stdout", "private stderr");
			await rejection;
			expect(processMocks.execFile).toHaveBeenCalledOnce();
			expect(warn).not.toHaveBeenCalled();
		},
	);

	it("refuses to search PATH when the Windows system directory is unavailable", async () => {
		vi.stubEnv("SystemRoot", undefined);
		await expect(writeWindowsReviewDiagnostic(join(tmpdir(), "private.jsonl"), "private")).rejects.toThrow(
			"Windows system directory is unavailable.",
		);
		expect(processMocks.execFile).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform !== "win32")("completes a framed request while its stdin pipe remains open", async () => {
		const root = mkdtempSync(join(tmpdir(), "volt-diagnostic-stdin-"));
		const path = join(root, "private '$(); 界", "capture.jsonl");
		const content = '$(throw \'not code\'); 界\r\n{"capture":"private"}\n';
		let child: ChildProcessWithoutNullStreams | undefined;
		processMocks.execFile.mockImplementation((file, args, options, callback) => {
			const running = spawn(file, args, options);
			child = running;
			running.stdout.resume();
			running.stderr.resume();
			running.on("error", (error) => callback(error, "", ""));
			running.on("close", (code) => {
				callback(code === 0 ? null : new Error("Diagnostic child failed or timed out"), "", "");
			});
			const input = new Writable({
				write(chunk, encoding, done) {
					running.stdin.write(chunk, encoding, done);
				},
				// Deliberately withhold EOF from the actual child. ReadToEnd would
				// block until the existing subprocess deadline kills it.
				final(done) {
					done();
				},
			});
			running.stdin.on("error", (error) => input.destroy(error));
			return { stdin: input };
		});
		try {
			await writeWindowsReviewDiagnostic(path, content);
			expect(child?.stdin.writableEnded).toBe(false);
			expect(readFileSync(path, "utf8")).toBe(content);
		} finally {
			child?.stdin.destroy();
			child?.kill();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
