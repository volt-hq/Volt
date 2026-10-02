import { describe, expect, test } from "vitest";
import { sanitizeIrohRemoteTranscriptText } from "../src/core/remote/iroh/index.ts";

describe("Iroh remote transcript text sanitizer", () => {
	test("preserves formatting for transcript message text", () => {
		const formatted = [
			"Here is the plan:\r\n",
			"- Keep Markdown lists\r\n",
			"- Keep\ttabs inside text\r\n",
			"```swift\r\n",
			'let file = "/Users/jordan/project/Sources/App.swift"\r\n',
			"```",
		].join("");

		const result = sanitizeIrohRemoteTranscriptText(formatted, {
			workspacePath: "/Users/jordan/project",
		});

		expect(result).toEqual({
			text: [
				"Here is the plan:\n",
				"- Keep Markdown lists\n",
				"- Keep\ttabs inside text\n",
				"```swift\n",
				'let file = "/workspace/Sources/App.swift"\n',
				"```",
			].join(""),
			truncated: false,
		});
	});

	test("preserves leading indentation and trailing newlines for message text", () => {
		const result = sanitizeIrohRemoteTranscriptText("\tindented line\n", { workspacePath: "/workspace" });

		expect(result).toEqual({
			text: "\tindented line\n",
			truncated: false,
		});
	});

	test("collapses formatting for compact transcript summaries", () => {
		const result = sanitizeIrohRemoteTranscriptText(
			"Read /Users/jordan/project/Sources/App.swift\n\tcompleted",
			{ workspacePath: "/Users/jordan/project" },
			"summary",
		);

		expect(result).toEqual({
			text: "Read /workspace/Sources/App.swift completed",
			truncated: false,
		});
	});
});
