import assert from "node:assert";
import { describe, it } from "node:test";
import { TerminalOutput } from "../src/components/terminal-output.ts";
import { PLAIN_SEMANTIC_THEME, type SemanticTheme, type StyledText } from "../src/styled-text.ts";
import { visibleWidth } from "../src/utils.ts";
import { showTags, tagTheme } from "./semantic-test-theme.ts";

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

function countingTheme(): { theme: SemanticTheme; styled: string[] } {
	const styled: string[] = [];
	return {
		styled,
		theme: {
			...PLAIN_SEMANTIC_THEME,
			text: (text) => {
				styled.push(text);
				return text;
			},
		},
	};
}

describe("TerminalOutput", () => {
	it("wraps or truncates lines to the width", () => {
		const output = new TerminalOutput(PLAIN_SEMANTIC_THEME, { lines: ["short", "a long line of output text"] });
		assert.deepStrictEqual(output.render(12).lines, ["short", "a long line", "of output", "text"]);
		output.setProps({ lines: ["short", "a long line of output text"], wrap: false });
		assert.deepStrictEqual(output.render(12).lines.map(stripAnsi), ["short", "a long line…"]);
		for (const width of [12, 1]) {
			for (const line of output.render(width).lines) assert.ok(visibleWidth(line) <= width, line);
		}
	});

	it("renders only appended lines when props extend the previous lines", () => {
		const { theme, styled } = countingTheme();
		const first: StyledText[] = ["one", "two"];
		const output = new TerminalOutput(theme, { lines: first });
		output.render(20);
		assert.deepStrictEqual(styled, ["one", "two"]);

		output.setProps({ lines: [...first, "three"] });
		output.appendLines(["four"]);
		assert.deepStrictEqual(output.render(20).lines, ["one", "two", "three", "four"]);
		assert.deepStrictEqual(styled, ["one", "two", "three", "four"]);

		output.setProps({ lines: ["replaced"] });
		assert.deepStrictEqual(output.render(20).lines, ["replaced"]);
		output.render(30);
		assert.deepStrictEqual(styled.slice(4), ["replaced", "replaced"]);
	});

	it("bounds retained lines and reports hidden lines", () => {
		const output = new TerminalOutput(tagTheme, {
			lines: Array.from({ length: 6 }, (_, index) => `line ${index + 1}`),
			maxLines: 4,
			omittedLines: 10,
		});
		assert.strictEqual(output.getLineCount(), 4);
		assert.deepStrictEqual(output.render(30).lines.map(showTags), [
			"<muted>… 12 earlier lines</muted>",
			"line 3",
			"line 4",
			"line 5",
			"line 6",
		]);

		output.setProps({ lines: ["a", "b", "c", "d", "e"], maxVisibleRows: 3 });
		assert.deepStrictEqual(output.render(30).lines.map(showTags), ["<muted>… 3 earlier lines</muted>", "d", "e"]);
	});

	it("styles output spans through the theme", () => {
		const output = new TerminalOutput(tagTheme, {
			lines: [[{ text: "error: ", token: "error", bold: true }, { text: "boom" }]],
		});
		assert.deepStrictEqual(output.render(30).lines.map(showTags), ["<b><error>error: </error></b>boom"]);
	});
});
