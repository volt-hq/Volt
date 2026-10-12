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

describe("issue #884: MCP redaction removes the credential after an authorization scheme", () => {
	it("keeps the scheme and redacts the credential in an Authorization header value", () => {
		expect(redactMcpText("Authorization: Bearer abc123")).toBe("Authorization: Bearer [redacted]");
		expect(redactMcpText("authorization=bearer eyJhbGciOiJIUzI1NiJ9.e30.sig")).toBe(
			"authorization=bearer [redacted]",
		);
		expect(redactMcpText("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic [redacted]");
		expect(redactMcpText("Authorization: token ghp_abc123")).toBe("Authorization: token [redacted]");
		expect(redactMcpText("Proxy-Authorization: Bearer abc123")).toBe("Proxy-Authorization: Bearer [redacted]");
		expect(redactMcpText("401 (Authorization: Bearer abc123; retry later)")).toBe(
			"401 (Authorization: Bearer [redacted]; retry later)",
		);
	});

	it("still redacts schemeless values and standalone bearer tokens", () => {
		expect(redactMcpText("Authorization: lin_api_abc123 rejected")).toBe("Authorization: [redacted] rejected");
		expect(redactMcpText("Authorization: Bearer")).toBe("Authorization: [redacted]");
		expect(redactMcpText("sent Bearer abc123")).toBe("sent Bearer [redacted]");
	});

	it("keeps the bearer token out of the MCP audit log", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-884-"));
		directories.push(agentDir);
		const logger = new McpAuditLogger(agentDir);
		await logger.write({
			callerSurface: "model",
			server: "remote",
			item: "fetch",
			kind: "tool",
			risk: "read",
			status: "failed",
			arguments: { header: "Authorization: Bearer arg-secret-123" },
			error: "upstream rejected Authorization: Bearer error-secret-456",
		});

		const log = readFileSync(join(agentDir, "mcp", "audit.jsonl"), "utf-8");
		expect(log).not.toContain("arg-secret-123");
		expect(log).not.toContain("error-secret-456");
		const entry = JSON.parse(log.trim()) as { arguments: unknown; error: string };
		expect(entry.arguments).toEqual({ header: "Authorization: Bearer [redacted]" });
		expect(entry.error).toBe("upstream rejected Authorization: Bearer [redacted]");
		expect(sanitizeMcpArguments(["Authorization: Bearer abc123"])).toEqual(["Authorization: Bearer [redacted]"]);
	});
});
