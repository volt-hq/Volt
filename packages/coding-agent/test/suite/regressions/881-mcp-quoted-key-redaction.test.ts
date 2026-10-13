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

describe("issue #881: MCP redaction covers quoted keys and API key", () => {
	it("redacts the value after a quoted secret key and keeps the quotes", () => {
		expect(redactMcpText('{"access_token":"abc123"}')).toBe('{"access_token":"[redacted]"}');
		expect(redactMcpText('{"client_secret": "xyz789"}')).toBe('{"client_secret": "[redacted]"}');
		expect(redactMcpText("{'token': 'abc123', 'user': 'bob'}")).toBe("{'token': '[redacted]', 'user': 'bob'}");
		expect(redactMcpText('"refresh_token" = "abc123"')).toBe('"refresh_token" = "[redacted]"');
		expect(redactMcpText('"token": abc123')).toBe('"token": [redacted]');
	});

	it("redacts the value after API key", () => {
		expect(redactMcpText("API key: sk-abc123")).toBe("API key: [redacted]");
		expect(redactMcpText("api key = sk-abc123")).toBe("api key = [redacted]");
		expect(redactMcpText('{"API key": "sk-abc123"}')).toBe('{"API key": "[redacted]"}');
	});

	it("redacts a quoted value whole, through its closing quote", () => {
		expect(redactMcpText('{"password": "correct horse, battery staple", "user": "bob"}')).toBe(
			'{"password": "[redacted]", "user": "bob"}',
		);
		expect(redactMcpText(String.raw`{"secret": "a\"b c", "user": "bob"}`)).toBe(
			'{"secret": "[redacted]", "user": "bob"}',
		);
		expect(redactMcpText('{"access_token":"abc123')).toBe('{"access_token":"[redacted]');
	});

	it("keeps a known scheme visible and redacts the rest of a quoted Authorization value", () => {
		expect(redactMcpText('{"Authorization": "Bearer abc123"}')).toBe('{"Authorization": "Bearer [redacted]"}');
		expect(redactMcpText('{"Authorization": "token ghp_abc123"}')).toBe('{"Authorization": "token [redacted]"}');
		expect(redactMcpText(String.raw`{"Authorization": "Digest username=\"u\", response=\"6629fae4\""}`)).toBe(
			'{"Authorization": "[redacted]"}',
		);
		expect(redactMcpText('"Authorization": Bearer abc123')).toBe('"Authorization": Bearer [redacted]');
		expect(redactMcpText('"Authorization": Bot MTk4NjIy.Cl2FMQ')).toBe('"Authorization": [redacted]');
		expect(redactMcpText('"Proxy-Authorization": Negotiate YIIGhgYG, "keep": 1')).toBe(
			'"Proxy-Authorization": [redacted], "keep": 1',
		);
	});

	it("redacts a JSON-encoded quoted key and value", () => {
		const body = JSON.stringify({
			error: JSON.stringify({ access_token: "abc123", user: "bob" }),
		});
		const redacted = redactMcpText(body);
		expect(redacted).not.toContain("abc123");
		expect(JSON.parse(JSON.parse(redacted).error)).toEqual({ access_token: "[redacted]", user: "bob" });

		const quotedPair = JSON.stringify({ error: JSON.stringify({ password: 'a "b" c', user: "bob" }) });
		expect(JSON.parse(JSON.parse(redactMcpText(quotedPair)).error)).toEqual({ password: "[redacted]", user: "bob" });
	});

	it("redacts an object or array value whole, whatever its keys", () => {
		expect(redactMcpText('{"credential": {"oauth": {"refresh": "r-abc"}}, "keep": "visible"}')).toBe(
			'{"credential": [redacted], "keep": "visible"}',
		);
		expect(redactMcpText('{"token": [["abc123"]], "keep": 1}')).toBe('{"token": [redacted], "keep": 1}');
		expect(redactMcpText('{"credential": {"value": "x}y", "more": "s3cret"}}')).toBe('{"credential": [redacted]}');
		const pretty = JSON.stringify({ credential: { value: "hunter2" }, keep: "visible" }, null, 2);
		expect(redactMcpText(pretty)).toBe('{\n  "credential": [redacted],\n  "keep": "visible"\n}');
		expect(redactMcpText('{"credential": {"value": "hunter2", "more": ')).toBe('{"credential": [redacted]');
		const encoded = JSON.stringify({ error: JSON.stringify({ credential: { a: "x}y", b: "s3cret" } }) });
		expect(redactMcpText(encoded)).not.toContain("s3cret");
	});

	it("does not take a quoted value or prose ending in a key name for a key", () => {
		expect(redactMcpText('grant_type: "refresh_token"\nrefresh_token: abc123')).toBe(
			'grant_type: "refresh_token"\nrefresh_token: [redacted]',
		);
		expect(redactMcpText("API key\ntoken: abc123")).toBe("API key\ntoken: [redacted]");
		expect(redactMcpText('{"token_type": "Bearer", "expires_in": 3600}')).toBe(
			'{"token_type": "Bearer", "expires_in": 3600}',
		);
		expect(redactMcpText('{"error": "invalid_token", "error_description": "expired"}')).toBe(
			'{"error": "invalid_token", "error_description": "expired"}',
		);
		expect(redactMcpText('{"token": ""}')).toBe('{"token": ""}');
	});

	it("leaves a value that starts another secret to that secret's rule", () => {
		expect(redactMcpText("API key: private sk-abc123")).toBe("API key: private [redacted]");
		expect(redactMcpText("API key: token: abc123")).toBe("API key: token: [redacted]");
		expect(redactMcpText("API key=Authorization abc123 def")).toBe("API key=Authorization [redacted] def");
		expect(redactMcpText('"Authorization": password\nhunter2-x')).toBe('"Authorization": password\n[redacted]');
	});

	it("leaves already redacted text unchanged", () => {
		for (const input of [
			'{"access_token":"abc123"}',
			'"Authorization": Bearer abc123',
			'"Authorization": Bot MTk4NjIy',
			'{"credential": {"oauth": {"refresh": "r-abc"}}}',
			"API key: sk-abc123",
		]) {
			const once = redactMcpText(input);
			expect(redactMcpText(once)).toBe(once);
		}
	});

	it("keeps quoted-key secrets out of the MCP audit log", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-881-"));
		directories.push(agentDir);
		const logger = new McpAuditLogger(agentDir);
		await logger.write({
			callerSurface: "model",
			server: "remote",
			item: "fetch",
			kind: "tool",
			risk: "read",
			status: "failed",
			arguments: { body: '{"client_secret": "arg-secret-123", "scope": "read"}' },
			error: 'token endpoint returned 400: {"access_token":"error-secret-456","credential":{"key":"error-secret-789"}}',
		});

		const log = readFileSync(join(agentDir, "mcp", "audit.jsonl"), "utf-8");
		expect(log).not.toContain("arg-secret-123");
		expect(log).not.toContain("error-secret-456");
		expect(log).not.toContain("error-secret-789");
		const entry = JSON.parse(log.trim()) as { arguments: unknown; error: string };
		expect(entry.arguments).toEqual({ body: '{"client_secret": "[redacted]", "scope": "read"}' });
		expect(entry.error).toBe('token endpoint returned 400: {"access_token":"[redacted]","credential":[redacted]}');
		expect(sanitizeMcpArguments(['{"api_key":"sk-abc123"}'])).toEqual(['{"api_key":"[redacted]"}']);
	});
});
