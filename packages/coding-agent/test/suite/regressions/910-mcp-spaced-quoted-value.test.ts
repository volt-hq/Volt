import { describe, expect, it } from "vitest";
import { redactMcpText } from "../../../src/core/mcp/safety.ts";

describe("issue #910: MCP redaction of a quoted value after a key and whitespace alone", () => {
	it("redacts the whole quoted value when it looks like a credential", () => {
		expect(redactMcpText('password "hunter2 x"')).toBe('password "[redacted]"');
		expect(redactMcpText("token 'ghp_abc123 extra' rejected")).toBe("token '[redacted]' rejected");
		expect(redactMcpText('invalid token "abc1"')).toBe('invalid token "[redacted]"');
	});

	it("keeps a quoted word after a key name that does not look like a credential", () => {
		for (const message of [
			'password "correct horse"',
			'password "reset" was requested',
			'token "endpoint" missing',
		]) {
			expect(redactMcpText(message)).toBe(message);
		}
	});
});
