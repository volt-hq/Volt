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

	it.each([
		['password " Basic Abcd1234"', 'password " Basic [redacted]"'],
		['password "\nBasic Abcd1234"', 'password "\nBasic [redacted]"'],
		["password '\r\n\tBaSiC Abcd1234 extra-secret' rejected", "password '\r\n\tBaSiC [redacted]' rejected"],
		[String.raw`password \" Basic Abcd1234 extra-secret\"`, String.raw`password \" Basic [redacted]\"`],
		['password " Bearer abc123 extra-secret"', 'password " Bearer [redacted]"'],
		['password " token abc123 extra-secret"', 'password " token [redacted]"'],
		['password " token abc123"', 'password " token [redacted]"'],
		['password " Basic Abcd1234', 'password " Basic [redacted]'],
	])("redacts the whole quoted credential after leading whitespace and a known scheme: %s", (input, expected) => {
		expect(redactMcpText(input)).toBe(expected);
		expect(sanitizeMcpArguments({ message: input })).toEqual({ message: expected });
		expect(redactMcpText(expected)).toBe(expected);
	});

	it.each([
		['password "Basic dXNlcjpwYXNz"', 'password "Basic [redacted]"'],
		['password " Basic dXNlcjpwYXNz"', 'password " Basic [redacted]"'],
		['password "\nBasic dXNlcjpwYXNz extra-secret"', 'password "\nBasic [redacted]"'],
		["password '\tBaSiC dXNlcjpwYXNz' rejected", "password '\tBaSiC [redacted]' rejected"],
		[String.raw`password \" Basic dXNlcjpwYXNz\"`, String.raw`password \" Basic [redacted]\"`],
		['password "Basic dXNlcjpwYXNz', 'password "Basic [redacted]'],
		['password Basic "dXNlcjpwYXNz"', 'password Basic "[redacted]"'],
		['password Basic " dXNlcjpwYXNz"', 'password Basic "[redacted]"'],
		["password Basic dXNlcjpwYXNz rejected", "password Basic [redacted] rejected"],
	])("redacts alphabet-only Base64 credentials after Basic: %s", (input, expected) => {
		expect(redactMcpText(input)).toBe(expected);
		expect(sanitizeMcpArguments({ message: input })).toEqual({ message: expected });
		expect(redactMcpText(expected)).toBe(expected);
	});

	it("keeps a quoted word after a key name that does not look like a credential", () => {
		for (const message of [
			'password "correct horse"',
			'password "reset" was requested',
			'token "endpoint" missing',
			'password "\nreset" was requested',
			'token " endpoint" missing',
			'password " " retry1',
			'password " Basic credentials missing"',
			'password " Basic " retry1',
			'password "Basic Yesterday"',
			'password Basic "credentials missing"',
			"password Basic credentials missing",
			'password "dXNlcjpwYXNz"',
		]) {
			expect(redactMcpText(message)).toBe(message);
		}
	});
});
