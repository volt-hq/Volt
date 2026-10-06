import type { ConversationInfo } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../src/config.ts";
import { formatResumeCommand } from "../src/modes/interactive/interactive-mode.ts";

const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

afterEach(() => {
	if (originalStdoutIsTTY) {
		Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
	} else {
		Reflect.deleteProperty(process.stdout, "isTTY");
	}
});

function setStdoutIsTTY(value: boolean): void {
	Object.defineProperty(process.stdout, "isTTY", { configurable: true, value });
}

function conversationInfo(options: {
	persisted?: boolean;
	sessionId?: string;
	sessionDir?: string;
	usesDefaultSessionDir?: boolean;
}): ConversationInfo {
	return {
		id: options.sessionId ?? "0197f6e4-4cf9-7f44-a2d8-f8f7f49ee9d3",
		cwd: "/tmp/project",
		projectTrusted: true,
		sessionDir: options.sessionDir ?? "/tmp/volt-sessions",
		persisted: options.persisted ?? true,
		defaultSessionDir: options.usesDefaultSessionDir ?? true,
	};
}

describe("formatResumeCommand", () => {
	it("returns a session resume command for default session dirs", () => {
		setStdoutIsTTY(true);
		const info = conversationInfo({ sessionId: "test-session" });

		expect(formatResumeCommand(info)).toBe(`${APP_NAME} --session test-session`);
	});

	it("includes unquoted safe session dirs for non-default session dirs", () => {
		setStdoutIsTTY(true);
		const info = conversationInfo({
			sessionId: "test-session",
			sessionDir: "/tmp/custom-volt-sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(info)).toBe(
			`${APP_NAME} --session-dir /tmp/custom-volt-sessions --session test-session`,
		);
	});

	it("quotes session dirs containing spaces", () => {
		setStdoutIsTTY(true);
		const info = conversationInfo({
			sessionId: "test-session",
			sessionDir: "/tmp/custom volt sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(info)).toBe(
			`${APP_NAME} --session-dir '/tmp/custom volt sessions' --session test-session`,
		);
	});

	it("quotes session dirs containing single quotes", () => {
		setStdoutIsTTY(true);
		const info = conversationInfo({
			sessionId: "test-session",
			sessionDir: "/tmp/custom volt's sessions",
			usesDefaultSessionDir: false,
		});

		expect(formatResumeCommand(info)).toBe(
			`${APP_NAME} --session-dir '/tmp/custom volt'\\''s sessions' --session test-session`,
		);
	});

	it("returns undefined when stdout is not a TTY", () => {
		setStdoutIsTTY(false);
		const info = conversationInfo({});

		expect(formatResumeCommand(info)).toBeUndefined();
	});

	it("returns undefined for in-memory sessions", () => {
		setStdoutIsTTY(true);
		const info = conversationInfo({ persisted: false });

		expect(formatResumeCommand(info)).toBeUndefined();
	});
});
