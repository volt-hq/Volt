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

describe("issue #881: MCP redaction of quoted keys and API key", () => {
	it("redacts values after quoted JSON keys and keeps the surrounding JSON", () => {
		expect(redactMcpText('{"access_token":"abc123"}')).toBe('{"access_token":"[redacted]"}');
		expect(redactMcpText('{"client_secret": "xyz"}')).toBe('{"client_secret": "[redacted]"}');
		expect(redactMcpText('{"password": "correct horse battery", "user": "bob"}')).toBe(
			'{"password": "[redacted]", "user": "bob"}',
		);
		expect(redactMcpText('{"refresh_token":"a\\"b c","expires_in":3600}')).toBe(
			'{"refresh_token":"[redacted]","expires_in":3600}',
		);
		expect(redactMcpText("{'api_key': 'sk-abc'}")).toBe("{'api_key': '[redacted]'}");
	});

	it("redacts values after the two-word API key", () => {
		expect(redactMcpText("API key: sk-abc")).toBe("API key: [redacted]");
		expect(redactMcpText("api key=sk-abc")).toBe("api key=[redacted]");
		expect(redactMcpText('{"API key": "sk-abc"}')).toBe('{"API key": "[redacted]"}');
	});

	it("never leaves part of an unterminated quoted value visible", () => {
		expect(redactMcpText('token: "abc123')).toBe("token: [redacted]");
	});

	it("keeps serialized JSON secrets and API key object keys out of the audit log", async () => {
		const directory = mkdtempSync(join(tmpdir(), "volt-881-"));
		directories.push(directory);
		await new McpAuditLogger(directory).write({
			callerSurface: "model",
			server: "fake",
			item: "call_api",
			kind: "tool",
			risk: "write",
			status: "failed",
			arguments: { body: '{"grant_type":"refresh_token","client_secret": "s3cr3t value"}', "API key": "sk-abc" },
			error: 'HTTP 400: {"error":"invalid_grant","access_token":"tok123"}',
		});
		const log = readFileSync(join(directory, "mcp", "audit.jsonl"), "utf-8");
		expect(log).not.toContain("s3cr3t");
		expect(log).not.toContain("sk-abc");
		expect(log).not.toContain("tok123");
		const entry = JSON.parse(log) as { arguments: unknown; error: string };
		expect(entry.arguments).toEqual({
			body: '{"grant_type":"refresh_token","client_secret": "[redacted]"}',
			"API key": "[redacted]",
		});
		expect(entry.error).toBe('HTTP 400: {"error":"invalid_grant","access_token":"[redacted]"}');
		expect(sanitizeMcpArguments({ "API key": "sk-abc" })).toEqual({ "API key": "[redacted]" });
	});
});
