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

	it("does not let a quoted value or a bare API key take the next key name as its value", () => {
		expect(redactMcpText('grant_type: "refresh_token"\nrefresh_token: abc123')).toBe(
			'grant_type: "refresh_token"\nrefresh_token: [redacted]',
		);
		expect(redactMcpText('grant_type: "refresh_token"\npassword: "hunter2"')).toBe(
			'grant_type: "refresh_token"\npassword: "[redacted]"',
		);
		expect(redactMcpText("API key\ntoken: abc")).toBe("API key\ntoken: [redacted]");
		expect(redactMcpText("Set your API key in settings")).toBe("Set your API key in settings");
	});

	it("never leaves part of an unterminated quoted value visible", () => {
		expect(redactMcpText('token: "abc123')).toBe("token: [redacted]");
	});

	it("redacts the token after a Bearer or Basic scheme when the value is not a closed string", () => {
		expect(redactMcpText('{"Authorization":"Bearer abc123')).toBe('{"Authorization":[redacted]');
		expect(redactMcpText('"Authorization": f"Bearer abc123"')).toBe('"Authorization": [redacted]');
		expect(redactMcpText('"Authorization": Bearer abc123')).toBe('"Authorization": [redacted]');
		expect(redactMcpText("API key: Bearer abc123")).toBe("API key: [redacted]");
		expect(redactMcpText("Authorization: Bearer abc123")).toBe("Authorization: [redacted]");
		expect(redactMcpText("authorization: Basic dXNlcjpwYXNz")).toBe("authorization: [redacted]");
	});

	it("redacts an object or array value under a secret key without exposing nested secrets", () => {
		expect(redactMcpText('{"credential": {"password": "hunter2"}}')).toBe('{"credential": [redacted]}');
		expect(redactMcpText('{"credential":{"password":"hunter2"}}')).toBe('{"credential":[redacted]}');
		expect(redactMcpText('{"token": ["abc", "d]ef"]}')).toBe('{"token": [redacted]}');
		expect(redactMcpText("token: [abc, def]")).toBe("token: [redacted]");
		expect(redactMcpText('{"credential": {"meta": {"password": "hunter2"}}}')).toBe(
			'{"credential": {"meta": {"password": "[redacted]"}}}',
		);
		expect(redactMcpText('{"token": [{"password": "hunter2"}, {"id": 1}]}')).toBe(
			'{"token": [{"password": "[redacted]"}, {"id": 1}]}',
		);
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
