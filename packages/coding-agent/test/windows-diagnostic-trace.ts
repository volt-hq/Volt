import { Buffer } from "node:buffer";
import * as childProcess from "node:child_process";
import { vi } from "vitest";

interface DiagnosticProcessEvent {
	event: string;
	elapsedMs: number;
	code?: string | number | null;
	signal?: NodeJS.Signals | null;
	killed?: boolean;
}

/** Temporary CI tracing: never retain command arguments, paths, content, or raw process errors. */
export function traceWindowsDiagnosticWrites(): DiagnosticProcessEvent[][] {
	const traces: DiagnosticProcessEvent[][] = [];
	const original = childProcess.execFile;
	vi.spyOn(childProcess, "execFile").mockImplementation((...invocation) => {
		const [file, args, options, callback] = invocation;
		if (!Array.isArray(args) || !args.includes("-EncodedCommand") || !callback) return original(...invocation);
		const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
		if (!script.includes("Could not retain private Windows review diagnostics.")) return original(...invocation);
		const trace: DiagnosticProcessEvent[] = [];
		traces.push(trace);
		const startedAt = performance.now();
		const record = (event: string, details: Omit<DiagnosticProcessEvent, "event" | "elapsedMs"> = {}) => {
			trace.push({ event, elapsedMs: Math.round(performance.now() - startedAt), ...details });
		};
		const marker = (stage: string) => `[Console]::Out.WriteLine('VOLT_DIAGNOSTIC_STAGE:${stage}')`;
		const instrumented = `${marker("entered")}\n${script}`
			.replace("$stream = $null", `${marker("input_encoding")}\n$stream = $null`)
			.replace("    $directory =", `    ${marker("request_read")}\n    $directory =`)
			.replace("    $fileSecurity =", `    ${marker("directory_secured")}\n    $fileSecurity =`)
			.replace("    $stream.Flush($true)", `    $stream.Flush($true)\n    ${marker("file_flushed")}`);
		record("invoked");
		const child = original(
			file,
			[...args.slice(0, -1), Buffer.from(instrumented, "utf16le").toString("base64")],
			options,
			(error, stdout, stderr) => {
				const code = error?.code;
				record(error ? "callback_error" : "callback_success", {
					code:
						typeof code !== "string" || ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT"].includes(code)
							? code
							: "other",
					signal: error?.signal,
					killed: error?.killed,
				});
				callback(error, stdout, stderr);
			},
		);
		let output = "";
		const seen = new Set<string>();
		child.stdout?.on("data", (chunk: Buffer | string) => {
			output = `${output}${chunk.toString()}`.slice(-4096);
			for (const stage of ["entered", "input_encoding", "request_read", "directory_secured", "file_flushed"]) {
				if (output.includes(`VOLT_DIAGNOSTIC_STAGE:${stage}`) && !seen.has(stage)) {
					seen.add(stage);
					record(stage);
				}
			}
		});
		child.once("spawn", () => record("spawn"));
		child.stdin?.once("finish", () => record("stdin_finished"));
		child.once("exit", (code, signal) => record("exit", { code, signal }));
		child.once("close", (code, signal) => record("close", { code, signal }));
		return child;
	});
	return traces;
}
