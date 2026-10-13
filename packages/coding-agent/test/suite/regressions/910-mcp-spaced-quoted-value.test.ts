import { describe, expect, it } from "vitest";
import { redactMcpText, sanitizeMcpArguments } from "../../../src/core/mcp/safety.ts";

describe("issue #910: MCP redaction of a quoted value after a key and whitespace alone", () => {
	it("redacts the whole quoted value when it looks like a credential", () => {
		expect(redactMcpText('password "hunter2 x"')).toBe('password "[redacted]"');
		expect(redactMcpText("token 'ghp_abc123 extra' rejected")).toBe("token '[redacted]' rejected");
		expect(redactMcpText('invalid token "abc1"')).toBe('invalid token "[redacted]"');
		expect(redactMcpText('password "Bearer abc12"')).toBe('password "Bearer [redacted]"');
	});

	it("redacts quoted credentials after leading whitespace inside the quotes", () => {
		for (const [input, expected] of [
			['password "\nhunter2"', 'password "[redacted]"'],
			['password " hunter2"', 'password "[redacted]"'],
			["password '\r\n\thunter2 extra'", "password '[redacted]'"],
			[String.raw`password \" hunter2\"`, String.raw`password \"[redacted]\"`],
		]) {
			expect(redactMcpText(input)).toBe(expected);
			expect(sanitizeMcpArguments({ message: input })).toEqual({ message: expected });
			expect(redactMcpText(expected)).toBe(expected);
		}
	});

	it("keeps a quoted word after a key name that does not look like a credential", () => {
		for (const message of [
			'password "correct horse"',
			'password "reset" was requested',
			'token "endpoint" missing',
			'password "\nreset" was requested',
			'token " endpoint" missing',
			'password " " retry1',
		]) {
			expect(redactMcpText(message)).toBe(message);
		}
	});
});
