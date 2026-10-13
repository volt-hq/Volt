import { describe, expect, it } from "vitest";
import { redactMcpText, sanitizeMcpArguments } from "../../../src/core/mcp/safety.ts";

describe("issue #907: MCP redaction knows more credential key names", () => {
	it("redacts the values of cookie, passphrase, pwd, pass, auth, jwt, and session id keys in text", () => {
		expect(redactMcpText("Cookie: session=abc123")).toBe("Cookie: [redacted]");
		expect(redactMcpText("Set-Cookie: sid=abc123; Path=/")).toBe("Set-Cookie: [redacted]; Path=/");
		expect(redactMcpText("passphrase=hunter2")).toBe("passphrase=[redacted]");
		expect(redactMcpText("Server=db;Uid=sa;Pwd=s3cret;")).toBe("Server=db;Uid=sa;Pwd=[redacted];");
		expect(redactMcpText("db_pass: hunter2")).toBe("db_pass: [redacted]");
		expect(redactMcpText("proxy-auth: abc123")).toBe("proxy-auth: [redacted]");
		expect(redactMcpText('{"jwt": "eyJhbGciOiJIUzI1NiJ9.e30.sig"}')).toBe('{"jwt": "[redacted]"}');
		expect(redactMcpText("session_id=abc123 expired")).toBe("session_id=[redacted] expired");
	});

	it("redacts every pair in a Cookie header without consuming trailing text", () => {
		for (const [input, expected] of [
			["Cookie: sid=abc123; refresh=def456", "Cookie: [redacted]"],
			["Request failed: Cookie: sid=abc123; session=def456", "Request failed: Cookie: [redacted]"],
			["cookie: a=1; session=xyz789secret; empty=", "cookie: [redacted]"],
			["Cookie: sid=abc123; refresh=def456; retry later", "Cookie: [redacted]; retry later"],
			["Cookie: sid=abc123; refresh=def456\r\nAccept: */*", "Cookie: [redacted]\r\nAccept: */*"],
			['curl -H "Cookie: sid=abc123; refresh=def456" --verbose', 'curl -H "Cookie: [redacted]" --verbose'],
			['Cookie: sid="abc123"; refresh="def456"', "Cookie: [redacted]"],
			[String.raw`{"header":"Cookie: sid=\"abc123\"; refresh=def456"}`, '{"header":"Cookie: [redacted]"}'],
		]) {
			expect(redactMcpText(input)).toBe(expected);
			expect(sanitizeMcpArguments({ header: input })).toEqual({ header: expected });
			expect(redactMcpText(expected)).toBe(expected);
		}
	});

	it("keeps Set-Cookie attributes readable", () => {
		expect(redactMcpText("Set-Cookie: sid=abc123; Path=/; Domain=example.com; SameSite=Lax; Secure")).toBe(
			"Set-Cookie: [redacted]; Path=/; Domain=example.com; SameSite=Lax; Secure",
		);
	});

	it("keeps words that only contain those names readable", () => {
		for (const message of [
			"OAuth authorization failed",
			"the author passed the session",
			"bypass mode: on",
			"Session expired",
			"passenger list: full",
			"authority: example.com",
		]) {
			expect(redactMcpText(message)).toBe(message);
		}
	});

	it("redacts those keys and flags in MCP arguments", () => {
		expect(
			sanitizeMcpArguments({
				passphrase: "hunter2",
				cookie: "sid=abc",
				pwd: "x",
				pass: "y",
				auth: "z",
				sessionId: "s",
				jwt: "j",
				bypass: "keep",
				passenger: "keep",
				author: "keep",
				oauthFlow: "keep",
				args: ["--passphrase", "hunter2", "--pwd", "x", "--bypass", "keep"],
			}),
		).toEqual({
			passphrase: "[redacted]",
			cookie: "[redacted]",
			pwd: "[redacted]",
			pass: "[redacted]",
			auth: "[redacted]",
			sessionId: "[redacted]",
			jwt: "[redacted]",
			bypass: "keep",
			passenger: "keep",
			author: "keep",
			oauthFlow: "keep",
			args: ["--passphrase", "[redacted]", "--pwd", "[redacted]", "--bypass", "keep"],
		});
	});
});
