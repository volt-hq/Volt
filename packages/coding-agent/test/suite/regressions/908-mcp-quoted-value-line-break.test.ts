import { describe, expect, it } from "vitest";
import { redactMcpText, sanitizeMcpArguments } from "../../../src/core/mcp/safety.ts";

describe("issue #908: MCP redaction of a quoted secret value with a line break", () => {
	it("redacts a quoted value through its closing quote across line breaks", () => {
		expect(redactMcpText('token: "\nabc123"')).toBe('token: "[redacted]"');
		expect(redactMcpText("--password '\nsecret' --verbose")).toBe("--password '[redacted]' --verbose");
		expect(redactMcpText("password: 'first line\nsecond line' done")).toBe("password: '[redacted]' done");
		expect(sanitizeMcpArguments({ command: "login --password 'line one\nline two'" })).toEqual({
			command: "login --password '[redacted]'",
		});
	});

	it("redacts a quoted value that never closes to the end of the text", () => {
		expect(redactMcpText("password: 'abc\nrest of the message")).toBe("password: '[redacted]");
	});
});
