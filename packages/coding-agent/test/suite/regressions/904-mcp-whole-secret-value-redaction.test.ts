import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpAuditLogger } from "../../../src/core/mcp/audit.ts";
import { redactMcpText, sanitizeMcpArguments } from "../../../src/core/mcp/safety.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("issue #904: MCP redaction of whole secret values after any key", () => {
	it("redacts a quoted value through its closing quote after an unquoted key or a flag", () => {
		expect(redactMcpText('password: "correct horse battery"')).toBe('password: "[redacted]"');
		expect(redactMcpText("--password 'a b c' --verbose")).toBe("--password '[redacted]' --verbose");
		expect(redactMcpText('api_key="sk;live123", retry')).toBe('api_key="[redacted]", retry');
		expect(redactMcpText('token: "Bearer abc123"')).toBe('token: "Bearer [redacted]"');
	});

	it("redacts the credential after an unknown scheme with the scheme", () => {
		expect(redactMcpText("token: Bot MTk4NjIy.Cl2FMQ")).toBe("token: [redacted]");
		expect(redactMcpText("secret: Negotiate YIIGhgYG rejected")).toBe("secret: [redacted] rejected");
		// A first word that is not followed by a credential is the value alone.
		expect(redactMcpText("token: abc123 rejected")).toBe("token: [redacted] rejected");
		expect(redactMcpText("token: Expired Yesterday")).toBe("token: [redacted] Yesterday");
	});

	it("redacts quoted credentials after an unknown scheme", () => {
		for (const credential of ['"YIIGhgYG"', "'YIIGhgYGKwYB'", String.raw`\"YIIGhgYG\"`, '"MTk4NjIy.Cl2FMQ"']) {
			const input = `token: Negotiate ${credential} rejected`;
			const expected = "token: [redacted] rejected";
			expect(redactMcpText(input)).toBe(expected);
			expect(sanitizeMcpArguments({ message: input })).toEqual({ message: expected });
			expect(redactMcpText(expected)).toBe(expected);
		}
		expect(redactMcpText('token: Expired "Yesterday"')).toBe('token: [redacted] "Yesterday"');
		expect(redactMcpText('token: Negotiate "" retry123')).toBe('token: [redacted] "" retry123');
	});

	it("redacts an object or array after an unquoted key", () => {
		expect(redactMcpText('credential: {"user": "u", "key": "s3cret"} done')).toBe("credential: [redacted] done");
		expect(redactMcpText("token=[a b c]; next")).toBe("token=[redacted]; next");
		// A closing bracket that more of a word follows does not end the value.
		expect(redactMcpText("token: [x]abc123 rejected")).toBe("token: [redacted] rejected");
	});

	it("redacts a Base64 Basic credential after Authorization and whitespace alone", () => {
		expect(redactMcpText("Authorization Basic dXNlcjpwYXNz")).toBe("Authorization Basic [redacted]");
		for (const message of ["Authorization Basic credentials missing", "Authorization basic auth failed"]) {
			expect(redactMcpText(message)).toBe(message);
		}
	});

	it("redacts a value that one rule reads and another's ends before", () => {
		// The auth-params end at `token=`; the key path reads the value after it.
		expect(redactMcpText("Authorization: Digest token=\nabc123")).toBe("Authorization: [redacted]\n[redacted]");
		expect(redactMcpText('Authorization: x password: "a, b"')).toBe('Authorization: [redacted] "[redacted]"');
		expect(redactMcpText("token=token=token=abc")).toBe("token=[redacted]");
	});

	it("redacts the whole text when overlapping values exhaust the parsing budget", () => {
		for (const prefix of ["password hunter2 ", 'password "hunter2" ', "Cookie: sid=abc123; session=def456 "]) {
			const input = `${prefix}${"token=".repeat(100)}abc`;
			expect(redactMcpText(input)).toBe("[redacted]");
			expect(sanitizeMcpArguments({ message: input })).toEqual({ message: "[redacted]" });
		}
		expect(redactMcpText(`password hunter2 ${"token=".repeat(10)}abc`)).toBe("password [redacted] token=[redacted]");
	});

	it.each([
		{ input: 'password "\nhunter2"', expected: 'password "[redacted]"', secret: "hunter2" },
		{ input: "Cookie: sid=abc123; refresh=def456", expected: "Cookie: [redacted]", secret: "def456" },
		{
			input: "Request failed: Cookie: sid=abc123; session=def456",
			expected: "Request failed: Cookie: [redacted]",
			secret: "def456",
		},
		{ input: `password hunter2 ${"token=".repeat(100)}abc`, expected: "[redacted]", secret: "hunter2" },
		{ input: 'token: Negotiate "YIIGhgYG"', expected: "token: [redacted]", secret: "YIIGhgYG" },
	])(
		"keeps the credential in $input out of audit errors and string arguments",
		async ({ input, expected, secret }) => {
			const agentDir = mkdtempSync(join(tmpdir(), "volt-904-"));
			directories.push(agentDir);
			await new McpAuditLogger(agentDir).write({
				callerSurface: "model",
				server: "remote",
				item: "fetch",
				kind: "tool",
				risk: "read",
				status: "failed",
				arguments: { message: input },
				error: input,
			});
			const log = readFileSync(join(agentDir, "mcp", "audit.jsonl"), "utf-8");
			expect(log).not.toContain(secret);
			const entry = JSON.parse(log.trim()) as { arguments: unknown; error: string };
			expect(entry.arguments).toEqual({ message: expected });
			expect(entry.error).toBe(expected);
		},
	);

	it("keeps whole secret values out of the MCP audit log", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-904-"));
		directories.push(agentDir);
		await new McpAuditLogger(agentDir).write({
			callerSurface: "model",
			server: "db",
			item: "connect",
			kind: "tool",
			risk: "write",
			status: "failed",
			arguments: { command: "db login --password 'correct horse battery'" },
			error: "rejected token: Bot MTk4NjIy.Cl2FMQ",
		});
		const log = readFileSync(join(agentDir, "mcp", "audit.jsonl"), "utf-8");
		expect(log).not.toContain("horse");
		expect(log).not.toContain("MTk4NjIy");
		const entry = JSON.parse(log.trim()) as { arguments: unknown; error: string };
		expect(entry.arguments).toEqual({ command: "db login --password '[redacted]'" });
		expect(entry.error).toBe("rejected token: [redacted]");
	});
});
