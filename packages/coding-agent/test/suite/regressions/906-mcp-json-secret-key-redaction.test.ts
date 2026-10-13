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

describe("issue #906: MCP redaction covers JSON-style secret keys", () => {
	it("redacts the value of a quoted key name", () => {
		expect(redactMcpText('{"password":"correct horse"}')).toBe('{"password":"[redacted]"}');
		expect(redactMcpText('{"access_token":"abc123"}')).toBe('{"access_token":"[redacted]"}');
		expect(redactMcpText('{"client_secret": "s3cr3t-value"}')).toBe('{"client_secret": "[redacted]"}');
		expect(redactMcpText("{'password': 'hunter2'}")).toBe("{'password': '[redacted]'}");
		expect(redactMcpText('{"token": abc123, "user": "bob"}')).toBe('{"token": [redacted], "user": "bob"}');
		expect(redactMcpText('{"Authorization": "Bot MTk4NjIy.Cl2FMQ"}')).toBe('{"Authorization": "[redacted]"}');
		expect(redactMcpText('{"authorization":"Bearer abc123"}')).toBe('{"authorization":"Bearer [redacted]"}');
	});

	it("keeps the rest of a JSON body readable", () => {
		expect(
			redactMcpText('{"access_token":"ya29.a0","token_type":"Bearer","expires_in":3600,"max_tokens":4096}'),
		).toBe('{"access_token":"[redacted]","token_type":"Bearer","expires_in":3600,"max_tokens":4096}');
		expect(redactMcpText('{"password":"a\\"b c","user":"bob"}')).toBe('{"password":"[redacted]","user":"bob"}');
		for (const message of ['Missing field "token" in request', 'the "password" is: wrong']) {
			expect(redactMcpText(message)).toBe(message);
		}
	});

	it("redacts a quoted value up to its closing quote", () => {
		expect(redactMcpText('password: "correct horse battery staple"')).toBe('password: "[redacted]"');
		expect(redactMcpText('client_secret="abc,def" rejected')).toBe('client_secret="[redacted]" rejected');
		expect(redactMcpText("deploy --password 'a b; c' --verbose")).toBe("deploy --password '[redacted]' --verbose");
		expect(redactMcpText('token: "Bearer abc def"')).toBe('token: "Bearer [redacted]"');
		expect(redactMcpText('password: "correct horse\nnext line')).toBe('password: "[redacted]\nnext line');
	});

	it("redacts values in JSON whose quotes are backslash-escaped", () => {
		expect(redactMcpText('body: {\\"password\\":\\"correct horse battery\\"}')).toBe(
			'body: {\\"password\\":\\"[redacted]\\"}',
		);
		expect(redactMcpText('{\\"password\\":\\"a\\\\\\"b c\\",\\"user\\":\\"bob\\"}')).toBe(
			'{\\"password\\":\\"[redacted]\\",\\"user\\":\\"bob\\"}',
		);
		expect(redactMcpText('token: \\"a b\\"')).toBe('token: \\"[redacted]\\"');
		expect(redactMcpText('Authorization: \\"Bot MTk4NjIy\\"')).toBe('Authorization: \\"[redacted]\\"');
		expect(redactMcpText('{\\"Authorization\\":\\"Bearer abc def\\"}')).toBe(
			'{\\"Authorization\\":\\"Bearer [redacted]\\"}',
		);
		expect(redactMcpText('{\\"header\\":\\"Authorization: Bot MTk4NjIy\\"}')).toBe(
			'{\\"header\\":\\"Authorization: [redacted]\\"}',
		);
	});

	it("keeps JSON secrets out of the MCP audit log", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-906-"));
		directories.push(agentDir);
		await new McpAuditLogger(agentDir).write({
			callerSurface: "model",
			server: "remote",
			item: "http_request",
			kind: "tool",
			risk: "write",
			status: "failed",
			arguments: { body: '{"username":"bob","password":"arg horse battery"}' },
			error: 'HTTP 401: {"error":"invalid_grant","refresh_token":"error-secret-456"}; raw: {\\"client_secret\\":\\"escaped secret 789\\"}',
		});

		const log = readFileSync(join(agentDir, "mcp", "audit.jsonl"), "utf-8");
		for (const secret of ["horse", "battery", "error-secret-456", "escaped secret 789"]) {
			expect(log).not.toContain(secret);
		}
		const entry = JSON.parse(log.trim()) as { arguments: unknown; error: string };
		expect(entry.arguments).toEqual({ body: '{"username":"bob","password":"[redacted]"}' });
		expect(entry.error).toBe(
			'HTTP 401: {"error":"invalid_grant","refresh_token":"[redacted]"}; raw: {\\"client_secret\\":\\"[redacted]\\"}',
		);
		expect(sanitizeMcpArguments(['{"api_key":"sk-live 123"}'])).toEqual(['{"api_key":"[redacted]"}']);
	});
});
