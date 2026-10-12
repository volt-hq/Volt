import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpAuditLogger } from "../../../src/core/mcp/audit.ts";
import { sanitizeMcpArguments } from "../../../src/core/mcp/safety.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("issue #883: MCP redaction of secret flag values in argv-style arrays", () => {
	it("redacts the element after a flag named for a secret", () => {
		expect(sanitizeMcpArguments({ args: ["--token", "ghp_abc123"] })).toEqual({ args: ["--token", "[redacted]"] });
		expect(sanitizeMcpArguments({ args: ["--password", "hunter2"] })).toEqual({
			args: ["--password", "[redacted]"],
		});
		expect(sanitizeMcpArguments({ args: ["deploy", "--github-token", "ghp_abc", "--verbose"] })).toEqual({
			args: ["deploy", "--github-token", "[redacted]", "--verbose"],
		});
		expect(sanitizeMcpArguments({ args: ["login", "--API-KEY", "sk-abc"] })).toEqual({
			args: ["login", "--API-KEY", "[redacted]"],
		});
		expect(sanitizeMcpArguments({ args: ["keytool", "-password", "hunter2"] })).toEqual({
			args: ["keytool", "-password", "[redacted]"],
		});
		expect(sanitizeMcpArguments({ steps: [["--client-secret", "s3cr3t"]] })).toEqual({
			steps: [["--client-secret", "[redacted]"]],
		});
	});

	it("redacts flag values that are not strings", () => {
		expect(sanitizeMcpArguments({ args: ["--token", 123456, "--pin", 42] })).toEqual({
			args: ["--token", "[redacted]", "--pin", 42],
		});
		expect(sanitizeMcpArguments({ args: ["--secret", { value: "s3cr3t" }] })).toEqual({
			args: ["--secret", "[redacted]"],
		});
	});

	it("keeps the values of flags whose name does not end in a secret key name", () => {
		expect(sanitizeMcpArguments({ args: ["deploy", "--token-file", "/tmp/token", "--env", "prod"] })).toEqual({
			args: ["deploy", "--token-file", "/tmp/token", "--env", "prod"],
		});
	});

	it("keeps argv secrets out of the audit log", async () => {
		const directory = mkdtempSync(join(tmpdir(), "volt-883-"));
		directories.push(directory);
		await new McpAuditLogger(directory).write({
			callerSurface: "model",
			server: "fake",
			item: "run_command",
			kind: "tool",
			risk: "write",
			status: "completed",
			arguments: { command: "deploy", args: ["--github-token", "ghp_abc123", "--password", "hunter2"] },
		});
		const log = readFileSync(join(directory, "mcp", "audit.jsonl"), "utf-8");
		expect(log).not.toContain("ghp_abc123");
		expect(log).not.toContain("hunter2");
		const entry = JSON.parse(log) as { arguments: unknown };
		expect(entry.arguments).toEqual({
			command: "deploy",
			args: ["--github-token", "[redacted]", "--password", "[redacted]"],
		});
	});
});
