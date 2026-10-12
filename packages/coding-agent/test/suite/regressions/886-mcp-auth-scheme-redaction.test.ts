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

describe("issue #886: MCP redaction hides credentials after auth schemes and quoted keys", () => {
	it("redacts the credential after an auth scheme and keeps the scheme", () => {
		expect(redactMcpText("Authorization: Bearer ghp_abc123")).toBe("Authorization: Bearer [redacted]");
		expect(redactMcpText("authorization=Bearer ghp_abc123")).toBe("authorization=Bearer [redacted]");
		expect(redactMcpText("Authorization: Basic dXNlcjpwYXNz==")).toBe("Authorization: Basic [redacted]");
		expect(redactMcpText("Authorization: token ghp_abc123")).toBe("Authorization: token [redacted]");
		expect(redactMcpText("X-Auth-Token: Bearer ghp_abc123, retry")).toBe("X-Auth-Token: Bearer [redacted], retry");
		expect(redactMcpText("Authorization: Bearer")).toBe("Authorization: [redacted]");
	});

	it("redacts values of quoted keys and keeps the quotes", () => {
		expect(redactMcpText('{"access_token":"ghp_abc123","expires_in":3600}')).toBe(
			'{"access_token":"[redacted]","expires_in":3600}',
		);
		expect(redactMcpText('"password": "hunter2"')).toBe('"password": "[redacted]"');
		expect(redactMcpText('"password": "correct horse battery staple"')).toBe('"password": "[redacted]"');
		expect(redactMcpText('{"password":"ab\\"cd"}')).toBe('{"password":"[redacted]"}');
		expect(redactMcpText("{'api_key': 'sk-abc'}")).toBe("{'api_key': '[redacted]'}");
		expect(redactMcpText('{"Authorization": "Bearer ghp_abc123"}')).toBe('{"Authorization": "Bearer [redacted]"}');
	});

	it("redacts a quoted authorization header in a command argument", () => {
		expect(
			sanitizeMcpArguments({ command: "curl -H 'Authorization: Bearer ghp_abc123' https://api.example/repos" }),
		).toEqual({ command: "curl -H 'Authorization: Bearer [redacted]' https://api.example/repos" });
		expect(redactMcpText('curl -H "Authorization: Basic dXNlcjpwYXNz" https://api.example')).toBe(
			'curl -H "Authorization: Basic [redacted]" https://api.example',
		);
	});

	it("keeps the credential out of the MCP audit log", async () => {
		const directory = mkdtempSync(join(tmpdir(), "volt-886-"));
		directories.push(directory);
		await new McpAuditLogger(directory).write({
			callerSurface: "model",
			server: "github",
			item: "run_command",
			kind: "tool",
			risk: "write",
			status: "failed",
			arguments: { command: "curl -H 'Authorization: Bearer ghp_abc123' https://api.example" },
			error: 'HTTP 401 for {"access_token":"ghp_def456"}; Authorization: Bearer ghp_ghi789',
		});
		const log = readFileSync(join(directory, "mcp", "audit.jsonl"), "utf-8");
		expect(log).not.toMatch(/ghp_/);
		const entry = JSON.parse(log.trim());
		expect(entry.arguments).toEqual({
			command: "curl -H 'Authorization: Bearer [redacted]' https://api.example",
		});
		expect(entry.error).toBe('HTTP 401 for {"access_token":"[redacted]"}; Authorization: Bearer [redacted]');
	});
});
