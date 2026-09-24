import { Buffer } from "node:buffer";
import {
	ChildProcess,
	type ChildProcessWithoutNullStreams,
	type ExecFileException,
	type ExecFileOptions,
	type execFile,
	spawn,
} from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeWindowsReviewDiagnostic } from "../src/core/windows-review-private-diagnostics.ts";

type Completion = (error: ExecFileException | null, stdout: string, stderr: string) => void;
const processMocks = vi.hoisted(() => ({
	execFile: vi.fn<(file: string, args: string[], options: ExecFileOptions, callback: Completion) => ChildProcess>(),
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
				const child = new ChildProcess();
				child.stdin = input;
				return child;
			});
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const pending = writeWindowsReviewDiagnostic(path, content);
			const rejection = expect(pending).rejects.toThrow(/^Could not retain private Windows review diagnostics\.$/);
			const invocation = processMocks.execFile.mock.calls[0];
			if (!invocation || !completion) throw new Error("Expected a diagnostic subprocess");
			expect(invocation[0]).toBe(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
			expect(invocation[2]).toEqual({ windowsHide: true, timeout: 30_000, maxBuffer: 8_192 });
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

	it.each([0, 1])("settles exit code %s without waiting for inherited output pipes", async (code) => {
		vi.stubEnv("SystemRoot", join(tmpdir(), "windows-system-fixture"));
		const child = new ChildProcess();
		const input = new PassThrough();
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		child.stdin = input;
		child.stdout = stdout;
		child.stderr = stderr;
		processMocks.execFile.mockImplementation((_file, _args, _options, callback) => {
			// execFile's completion callback joins process exit and pipe closure.
			let closed = 0;
			for (const output of [stdout, stderr]) {
				output.once("close", () => {
					if (++closed === 2) callback(code === 0 ? null : new Error("private stderr"), "", "");
				});
			}
			return child;
		});
		const pending = writeWindowsReviewDiagnostic(join(tmpdir(), "private.jsonl"), "private");
		let outcome: string | undefined;
		const result = pending.then(
			() => {
				outcome = "written";
			},
			(error: Error) => {
				outcome = error.message;
			},
		);
		try {
			child.emit("exit", code, null);
			await vi.waitFor(() =>
				expect(outcome).toBe(code === 0 ? "written" : "Could not retain private Windows review diagnostics."),
			);
		} finally {
			input.destroy();
			stdout.destroy();
			stderr.destroy();
			await result;
		}
	});

	it("completes after a real child exits while a descendant retains its output handles", async () => {
		const actual = await vi.importActual<{ execFile: typeof execFile }>("node:child_process");
		const root = mkdtempSync(join(tmpdir(), "volt-diagnostic-exit-"));
		const script = join(root, "child.mjs");
		const pidPath = join(root, "descendant.pid");
		writeFileSync(
			script,
			[
				'import { spawn } from "node:child_process";',
				'import { writeFileSync } from "node:fs";',
				'const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000); process.send(1); process.disconnect();"], {',
				'  stdio: ["ignore", process.stdout, process.stderr, "ipc"], windowsHide: true, detached: true,',
				"});",
				'child.once("message", () => {',
				"  writeFileSync(process.argv[2], String(child.pid));",
				"  child.unref();",
				"});",
			].join("\n"),
		);
		// The Node fixture inherits this environment: retain the real system path on Windows.
		vi.stubEnv("SystemRoot", process.env.SystemRoot ?? root);
		let fixtureFailure: string | undefined;
		processMocks.execFile.mockImplementation((_file, _args, options, callback) =>
			actual.execFile(
				process.execPath,
				[script, pidPath],
				{ ...options, encoding: "utf8" },
				(error, stdout, stderr) => {
					if (error) fixtureFailure = `${error.code}: ${stderr}`;
					callback(error, stdout, stderr);
				},
			),
		);
		try {
			const failure = await writeWindowsReviewDiagnostic(join(root, "capture.jsonl"), "private").catch(
				(error: unknown) => error,
			);
			expect(fixtureFailure).toBeUndefined();
			expect(failure).toBeUndefined();
			// Completion must not require the descendant's 30-second lifetime to end.
			process.kill(Number(readFileSync(pidPath, "utf8")), 0);
		} finally {
			try {
				process.kill(Number(readFileSync(pidPath, "utf8")));
			} catch (error) {
				expect(["ENOENT", "ESRCH"]).toContain((error as NodeJS.ErrnoException).code);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	}, 15_000);

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
		const stages: string[] = [];
		let inputWritten = false;
		let exitCode: number | null | undefined;
		let exitSignal: NodeJS.Signals | null | undefined;
		const startedAt = performance.now();
		processMocks.execFile.mockImplementation((file, args, options, callback) => {
			// Report only fixed markers and process facts, never private paths, input, or raw stderr.
			const marker = (stage: string) => `[Console]::Out.WriteLine('VOLT_DIAGNOSTIC_STAGE:${stage}')`;
			const script = `${marker("entered")}\n${Buffer.from(args.at(-1)!, "base64").toString("utf16le")}`
				.replace("$stream = $null", `${marker("input_encoding")}\n$stream = $null`)
				.replace("    $directory =", `    ${marker("request_read")}\n    $directory =`)
				.replace("    $fileSecurity =", `    ${marker("directory_secured")}\n    $fileSecurity =`)
				.replace("    $stream.Flush($true)", `    $stream.Flush($true)\n    ${marker("file_flushed")}`);
			const running = spawn(
				file,
				[...args.slice(0, -1), Buffer.from(script, "utf16le").toString("base64")],
				options,
			);
			child = running;
			let output = "";
			running.stdout.setEncoding("utf8");
			running.stdout.on("data", (chunk: string) => {
				output = `${output}${chunk}`.slice(-4096);
				for (const stage of ["entered", "input_encoding", "request_read", "directory_secured", "file_flushed"])
					if (output.includes(`VOLT_DIAGNOSTIC_STAGE:${stage}`) && !stages.includes(stage)) stages.push(stage);
			});
			running.stderr.resume();
			running.on("error", (error) => callback(error, "", ""));
			running.on("close", (code, signal) => {
				exitCode = code;
				exitSignal = signal;
				callback(code === 0 ? null : new Error("Diagnostic child failed or timed out"), "", "");
			});
			const input = new Writable({
				write(chunk, encoding, done) {
					running.stdin.write(chunk, encoding, (error) => {
						inputWritten = !error;
						done(error);
					});
				},
				// Deliberately withhold EOF from the actual child. ReadToEnd would
				// block until the existing subprocess deadline kills it.
				final(done) {
					done();
				},
			});
			running.stdin.on("error", (error) => input.destroy(error));
			const observed = new ChildProcess();
			observed.stdin = input;
			observed.stdout = running.stdout;
			observed.stderr = running.stderr;
			running.on("exit", (code, signal) => observed.emit("exit", code, signal));
			return observed;
		});
		try {
			const failure = await writeWindowsReviewDiagnostic(path, content).then(
				() => false,
				() => true,
			);
			expect(
				failure,
				JSON.stringify({ stages, inputWritten, exitCode, exitSignal, elapsedMs: performance.now() - startedAt }),
			).toBe(false);
			expect(child?.stdin.writableEnded).toBe(false);
			expect(readFileSync(path, "utf8")).toBe(content);
		} finally {
			child?.stdin.destroy();
			child?.kill();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
