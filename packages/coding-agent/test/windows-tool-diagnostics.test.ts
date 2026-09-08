import { execFile } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeWindowsReviewDiagnostic } from "../src/core/windows-review-private-diagnostics.ts";

const mocks = vi.hoisted(() => ({ input: vi.fn(), errors: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: vi.fn(() => ({ stdin: { on: mocks.errors, end: mocks.input } })) }));

describe("Windows private tool capture", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});
	it("keeps content off arguments and waits asynchronously for ACL-aware creation", async () => {
		vi.stubEnv("SystemRoot", "C:\\Windows");
		const pending = writeWindowsReviewDiagnostic("C:\\agent\\debug\\capture.tmp", "private sample");
		const call = vi.mocked(execFile).mock.calls[0]!;
		const [program, args, options] = call;
		expect(program).toContain("powershell.exe");
		expect(JSON.stringify(args)).not.toContain("private sample");
		expect(options).toMatchObject({ timeout: 10_000 });
		expect(JSON.parse(mocks.input.mock.calls[0]![0])).toMatchObject({ content: "private sample" });
		const encoded = Array.isArray(args) ? args.at(-1) : undefined;
		expect(Buffer.from(String(encoded), "base64").toString("utf16le")).toContain(
			"SetAccessRuleProtection($true, $false)",
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
		const finish = call.at(-1);
		if (typeof finish !== "function") throw new Error("Expected process completion callback");
		finish(null, "", "");
		await pending;
	});
	it("fails closed without disclosing raw process errors", async () => {
		vi.stubEnv("SystemRoot", "C:\\Windows");
		const pending = writeWindowsReviewDiagnostic("capture.tmp", "private sample");
		const finish = vi.mocked(execFile).mock.calls[0]!.at(-1);
		if (typeof finish !== "function") throw new Error("Expected process completion callback");
		finish(new Error("private process detail"), "", "");
		await expect(pending).rejects.toThrow("Could not retain private Windows review diagnostics.");
	});
});
