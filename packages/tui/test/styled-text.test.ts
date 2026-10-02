import assert from "node:assert";
import { describe, it } from "node:test";
import {
	PLAIN_SEMANTIC_THEME,
	renderStyledText,
	type SemanticTheme,
	sanitizeText,
	styledTextToPlain,
	styledTextWidth,
	truncateStyledText,
	wrapStyledText,
} from "../src/styled-text.ts";
import { visibleWidth } from "../src/utils.ts";

const tagTheme: SemanticTheme = {
	text: (text) => `<text>${text}</text>`,
	muted: (text) => `<muted>${text}</muted>`,
	accent: (text) => `<accent>${text}</accent>`,
	success: (text) => `<success>${text}</success>`,
	warning: (text) => `<warning>${text}</warning>`,
	error: (text) => `<error>${text}</error>`,
	info: (text) => `<info>${text}</info>`,
	bold: (text) => `<b>${text}</b>`,
	italic: (text) => `<i>${text}</i>`,
	underline: (text) => `<u>${text}</u>`,
	code: (text) => `<code>${text}</code>`,
};

const ansiTheme: SemanticTheme = {
	...PLAIN_SEMANTIC_THEME,
	error: (text) => `\x1b[31m${text}\x1b[39m`,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};

describe("styled text", () => {
	it("resolves tokens and emphasis through the injected theme", () => {
		const rendered = renderStyledText(
			[
				{ text: "run " },
				{ text: "npm test", code: true, token: "accent" },
				{ text: " failed", token: "error", bold: true, italic: true, underline: true },
			],
			tagTheme,
		);

		assert.strictEqual(
			rendered,
			"<text>run </text><accent><code>npm test</code></accent><u><i><b><error> failed</error></b></i></u>",
		);
	});

	it("uses the base token for unstyled spans and plain strings", () => {
		assert.strictEqual(renderStyledText("hint", tagTheme, "muted"), "<muted>hint</muted>");
		assert.strictEqual(
			renderStyledText([{ text: "a" }, { text: "b", token: "info" }], tagTheme, "warning"),
			"<warning>a</warning><info>b</info>",
		);
	});

	it("strips terminal sequences and control characters from data", () => {
		const hostile = "\x1b[31mred\x1b[0m\x1b]8;;https://example.com\x07link\x1b]8;;\x07\x07\r\tend";
		assert.strictEqual(sanitizeText(hostile), "redlink   end");
		const rendered = renderStyledText([{ text: hostile, token: "error" }], PLAIN_SEMANTIC_THEME);
		assert.strictEqual(rendered.includes("\x1b"), false);
		assert.strictEqual(styledTextToPlain([{ text: "a\x1b[2Jb" }, { text: "\x9bc" }]), "abc");
	});

	it("styles each line of a multi-line span separately", () => {
		assert.strictEqual(
			renderStyledText([{ text: "one\ntwo", token: "success" }], tagTheme),
			"<success>one</success>\n<success>two</success>",
		);
	});

	it("wraps rendered text within the requested width", () => {
		const text = [{ text: "alpha beta gamma delta epsilon", token: "error" as const, bold: true }];
		for (const width of [8, 13]) {
			const lines = wrapStyledText(text, width, ansiTheme);
			assert.ok(lines.length > 1);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${JSON.stringify(line)} exceeds ${width}`);
			assert.strictEqual(
				lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join(" "),
				"alpha beta gamma delta epsilon",
			);
		}
	});

	it("truncates to one line with an ellipsis", () => {
		const text = [{ text: "first line\nsecond line", token: "error" as const }];
		const truncated = truncateStyledText(text, 12, ansiTheme);
		assert.strictEqual(visibleWidth(truncated), 12);
		assert.strictEqual(truncated.replace(/\x1b\[[0-9;]*m/g, ""), "first line …");
		assert.strictEqual(truncateStyledText("short", 12, ansiTheme), "short");
	});

	it("measures the width of the visible text", () => {
		assert.strictEqual(styledTextWidth([{ text: "ab", bold: true }, { text: "日本" }]), 6);
		assert.strictEqual(styledTextWidth("a\nb"), 3);
	});
});
