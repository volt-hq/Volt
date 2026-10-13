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

describe("issue #904: MCP redaction covers the whole value of a secret key", () => {
	it("redacts a quoted value up to its closing quote", () => {
		expect(redactMcpText('password: "correct horse battery"')).toBe('password: "[redacted]"');
		expect(redactMcpText("--password 'a b c'")).toBe("--password '[redacted]'");
		expect(redactMcpText('api_key="sk;live123"')).toBe('api_key="[redacted]"');
		expect(redactMcpText("client_secret='s3cr3t, with comma' rejected")).toBe("client_secret='[redacted]' rejected");
		expect(redactMcpText('password: "a\\"b c" rejected')).toBe('password: "[redacted]" rejected');
		expect(redactMcpText("curl --password 'p@ss w;rd' https://api.example")).toBe(
			"curl --password '[redacted]' https://api.example",
		);
		expect(redactMcpText('token: "Bearer abc def"')).toBe('token: "Bearer [redacted]"');
		expect(redactMcpText("token: 'Bot MTk4NjIy.Cl2FMQ'")).toBe("token: '[redacted]'");
	});

	it("redacts an unclosed quoted value up to the end of the line", () => {
		expect(redactMcpText('password: "correct horse battery\nnext line')).toBe('password: "[redacted]\nnext line');
	});

	it("redacts the credential after an unknown scheme", () => {
		expect(redactMcpText("token: Bot MTk4NjIy.Cl2FMQ")).toBe("token: [redacted]");
		expect(redactMcpText("api_key=ApiKey sk_live_abc, status 401")).toBe("api_key=[redacted], status 401");
		expect(redactMcpText("deploy --token DPoP eyJhbGciOiJFUzI1NiJ9.e30.sig --verbose")).toBe(
			"deploy --token [redacted] --verbose",
		);
		expect(redactMcpText("token: Bearer abc123 rejected")).toBe("token: Bearer [redacted] rejected");
	});

	it("keeps the text after a single-word value", () => {
		expect(redactMcpText("token:abc123 rejected")).toBe("token:[redacted] rejected");
		expect(redactMcpText("token=abc123 request_id=req-42")).toBe("token=[redacted] request_id=req-42");
		expect(redactMcpText("deploy --token abc123 --verbose")).toBe("deploy --token [redacted] --verbose");
		expect(redactMcpText("password: expired for user 42")).toBe("password: [redacted] for user 42");
	});

	it("keeps whole quoted and scheme values out of the MCP audit log", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-904-"));
		directories.push(agentDir);
		await new McpAuditLogger(agentDir).write({
			callerSurface: "model",
			server: "remote",
			item: "run_command",
			kind: "tool",
			risk: "write",
			status: "failed",
			arguments: { command: "db connect --password 'arg horse battery'" },
			error: 'upstream rejected token: Bot error-secret-456; password: "error horse battery"',
		});

		const log = readFileSync(join(agentDir, "mcp", "audit.jsonl"), "utf-8");
		for (const secret of ["horse", "battery", "error-secret-456"]) {
			expect(log).not.toContain(secret);
		}
		const entry = JSON.parse(log.trim()) as { arguments: unknown; error: string };
		expect(entry.arguments).toEqual({ command: "db connect --password '[redacted]'" });
		expect(entry.error).toBe('upstream rejected token: [redacted]; password: "[redacted]"');
		expect(sanitizeMcpArguments(['api_key="sk;live123"'])).toEqual(['api_key="[redacted]"']);
	});
});
