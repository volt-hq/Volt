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

describe("issue #902: MCP redaction removes request signatures", () => {
	it("redacts the signature query parameter of presigned URLs", () => {
		expect(
			redactMcpText(
				"GET https://bucket.s3.amazonaws.com/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc123 failed",
			),
		).toBe(
			"GET https://bucket.s3.amazonaws.com/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=[redacted] failed",
		);
		expect(redactMcpText("https://acct.blob.core.windows.net/c/b?sv=2022-11-02&ss=b&sig=AZSIG%3D")).toBe(
			"https://acct.blob.core.windows.net/c/b?sv=2022-11-02&ss=b&sig=[redacted]",
		);
		expect(redactMcpText("https://storage.googleapis.com/b/o?X-Goog-Signature=0f1e2d")).toBe(
			"https://storage.googleapis.com/b/o?X-Goog-Signature=[redacted]",
		);
		expect(redactMcpText("X-Amz-Signature: abc123")).toBe("X-Amz-Signature: [redacted]");
	});

	it("redacts OAuth 1.0 signatures in query strings, forms, and Authorization headers", () => {
		expect(redactMcpText("oauth_nonce=n1&oauth_signature=OSIG%3D")).toBe("oauth_nonce=n1&oauth_signature=[redacted]");
		expect(
			redactMcpText('Authorization: OAuth oauth_nonce="n1", oauth_signature="OSIG%3D", oauth_version="1.0"'),
		).not.toContain("OSIG");
		expect(
			redactMcpText(
				"Authorization: AWS4-HMAC-SHA256 Credential=AKIA/20240101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=fe5f80f7",
			),
		).not.toContain("fe5f80f7");
	});

	it("keeps prose and words that only contain sig readable", () => {
		for (const message of [
			"SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.",
			"Signature verification failed",
			"signal design assign sigma signed",
		]) {
			expect(redactMcpText(message)).toBe(message);
		}
	});

	it("redacts signature keys and flags in MCP arguments", () => {
		expect(
			sanitizeMcpArguments({
				"X-Amz-Signature": "abc123",
				sig: "AZSIG",
				oauth_signature: "OSIG",
				signal: "SIGTERM",
				design: "flat",
				args: ["--sig", "AZSIG", "--signature", "abc123", "--signal", "SIGTERM"],
			}),
		).toEqual({
			"X-Amz-Signature": "[redacted]",
			sig: "[redacted]",
			oauth_signature: "[redacted]",
			signal: "SIGTERM",
			design: "flat",
			args: ["--sig", "[redacted]", "--signature", "[redacted]", "--signal", "SIGTERM"],
		});
	});

	it("keeps presigned URL signatures out of the MCP audit log", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-902-"));
		directories.push(agentDir);
		await new McpAuditLogger(agentDir).write({
			callerSurface: "model",
			server: "storage",
			item: "fetch",
			kind: "tool",
			risk: "read",
			status: "failed",
			arguments: { url: "https://acct.blob.core.windows.net/c/b?sv=2022-11-02&sig=arg-sig-123" },
			error: "403 for https://bucket.s3.amazonaws.com/key?X-Amz-Signature=error-sig-456",
		});

		const log = readFileSync(join(agentDir, "mcp", "audit.jsonl"), "utf-8");
		expect(log).not.toContain("arg-sig-123");
		expect(log).not.toContain("error-sig-456");
		const entry = JSON.parse(log.trim()) as { arguments: unknown; error: string };
		expect(entry.arguments).toEqual({ url: "https://acct.blob.core.windows.net/c/b?sv=2022-11-02&sig=[redacted]" });
		expect(entry.error).toBe("403 for https://bucket.s3.amazonaws.com/key?X-Amz-Signature=[redacted]");
	});
});
