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

const DIGEST =
	'Digest username="Mufasa", realm="http-auth@example.org", uri="/dir/index.html", algorithm=SHA-256, ' +
	'nonce="7ypf/xlj9XXwfDPEoM4URrv", nc=00000001, cnonce="f2/wE4q74E6zIJEt", qop=auth, ' +
	'response="753927fa0e85d155564e2e272a28d180", opaque="FQhe/qaU925kfnzjCev0"';
const OAUTH1 =
	'OAuth realm="Example", oauth_consumer_key="0685bd9184jfhq22", oauth_token="ad180jjd733klru7", ' +
	'oauth_signature_method="HMAC-SHA1", oauth_signature="wOJIO9A2W5mFwDgiDvZbTSMK%2FPY%3D", ' +
	'oauth_timestamp="137131200", oauth_nonce="4572616e48616d6d65724c61686176", oauth_version="1.0"';

describe("issue #900: MCP redaction of Authorization values with auth-params", () => {
	it("redacts every auth-param of a Digest or OAuth 1.0 Authorization value", () => {
		expect(redactMcpText('Authorization: Digest username="u", realm="r", nonce="n", response="6629fae4"')).toBe(
			"Authorization: [redacted]",
		);
		expect(redactMcpText(`Authorization: ${DIGEST}`)).toBe("Authorization: [redacted]");
		expect(redactMcpText(`Proxy-Authorization: ${DIGEST}`)).toBe("Proxy-Authorization: [redacted]");
		expect(redactMcpText(`authorization=${OAUTH1}`)).toBe("authorization=[redacted]");
		expect(
			redactMcpText(
				"Authorization: AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
					"SignedHeaders=host;range;x-amz-date, Signature=fe5f80f77d5fa3beca038a248ff027d0",
			),
		).toBe("Authorization: [redacted]");
		expect(redactMcpText(`Authorization: Digest username*=UTF-8''J%C3%A4s%C3%B8n, response="abc123"`)).toBe(
			"Authorization: [redacted]",
		);
		expect(redactMcpText('Authorization: Digest response="6629fae4')).toBe("Authorization: [redacted]");
	});

	it("keeps the text after the Authorization value", () => {
		expect(redactMcpText(`401 (Authorization: ${DIGEST}; retry later)`)).toBe(
			"401 (Authorization: [redacted]; retry later)",
		);
		expect(redactMcpText('Authorization: Digest response="abc123" was rejected')).toBe(
			"Authorization: [redacted] was rejected",
		);
		expect(redactMcpText("Authorization: Digest response=abc123, status 401")).toBe(
			"Authorization: [redacted], status 401",
		);
		expect(redactMcpText("Authorization: Bearer abc123; retry")).toBe("Authorization: Bearer [redacted]; retry");
	});

	it("redacts a quoted or escaped Authorization value up to its closing quote", () => {
		expect(redactMcpText(`curl -H 'Authorization: ${DIGEST}' https://api.example`)).toBe(
			"curl -H 'Authorization: [redacted]' https://api.example",
		);
		expect(redactMcpText('{"header":"Authorization: Digest username=\\"u\\", response=\\"abc123\\""}')).toBe(
			'{"header":"Authorization: [redacted]"}',
		);
		expect(redactMcpText('authorization="Digest username=u, response=abc123"')).toBe('authorization="[redacted]"');
		expect(redactMcpText(`deploy --authorization '${OAUTH1}' --verbose`)).toBe(
			"deploy --authorization '[redacted]' --verbose",
		);
	});

	it("redacts an Authorization value after whitespace when it has a scheme and a credential", () => {
		expect(redactMcpText("Authorization Bot MTk4NjIy.Cl2FMQ.ZnCjm1XV")).toBe("Authorization [redacted]");
		expect(redactMcpText(`Authorization ${DIGEST}`)).toBe("Authorization [redacted]");
		expect(redactMcpText("Authorization Bot MTk4NjIy.Cl2FMQ.ZnCjm1XV was rejected")).toBe(
			"Authorization [redacted] was rejected",
		);
		expect(redactMcpText('Authorization Digest username="u", response="abc123" was rejected')).toBe(
			"Authorization [redacted] was rejected",
		);
		for (const message of [
			"Existing OAuth client information is required when exchanging an authorization code",
			"MCP OAuth device authorization failed: invalid_grant (400)",
			"Device authorization expired after 900 seconds",
			"authorization_pending",
			"MCP OAuth client information is bound to authorization server https://auth-a.example and is not presented to https://auth-b.example",
			"authorization endpoint https://auth-a.example/authorize returned 503",
		]) {
			expect(redactMcpText(message)).toBe(message);
		}
	});

	it("keeps Digest and OAuth 1.0 auth-params out of the MCP audit log", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "volt-900-"));
		directories.push(agentDir);
		await new McpAuditLogger(agentDir).write({
			callerSurface: "model",
			server: "remote",
			item: "fetch",
			kind: "tool",
			risk: "read",
			status: "failed",
			arguments: { headers: [`Authorization: ${OAUTH1}`] },
			error: `upstream rejected Authorization: ${DIGEST}`,
		});

		const log = readFileSync(join(agentDir, "mcp", "audit.jsonl"), "utf-8");
		for (const secret of ["753927fa0e85", "7ypf/xlj9XXw", "f2/wE4q74E6z", "wOJIO9A2W5mF", "4572616e4861"]) {
			expect(log).not.toContain(secret);
		}
		const entry = JSON.parse(log.trim()) as { arguments: unknown; error: string };
		expect(entry.arguments).toEqual({ headers: ["Authorization: [redacted]"] });
		expect(entry.error).toBe("upstream rejected Authorization: [redacted]");
		expect(sanitizeMcpArguments({ args: ["-H", `Authorization: ${DIGEST}`] })).toEqual({
			args: ["-H", "Authorization: [redacted]"],
		});
	});
});
