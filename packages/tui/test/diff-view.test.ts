import assert from "node:assert";
import { describe, it } from "node:test";
import { type DiffLine, DiffView } from "../src/components/diff-view.ts";
import { PLAIN_SEMANTIC_THEME } from "../src/styled-text.ts";
import { visibleWidth } from "../src/utils.ts";
import { showTags, tagTheme } from "./semantic-test-theme.ts";

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

const lines: DiffLine[] = [
	{ kind: "meta", text: "src/app.ts" },
	{ kind: "hunk", text: "@@ -8,3 +8,3 @@" },
	{ kind: "context", text: "const a = 1;", oldLine: 8, newLine: 8 },
	{ kind: "remove", text: "const b = 2;", oldLine: 9 },
	{ kind: "add", text: "const b = 3; // updated value for the new release", newLine: 9 },
	{ kind: "context", text: "export { a, b };", oldLine: 10, newLine: 10 },
];

describe("DiffView", () => {
	it("renders a line-number gutter, signs, and truncated lines", () => {
		const diff = new DiffView(PLAIN_SEMANTIC_THEME, { lines });
		assert.deepStrictEqual(diff.render(36).lines.map(stripAnsi), [
			"      src/app.ts",
			"      @@ -8,3 +8,3 @@",
			" 8  8   const a = 1;",
			" 9    - const b = 2;",
			"    9 + const b = 3; // updated val…",
			"10 10   export { a, b };",
		]);
	});

	it("drops the gutter when narrow and stays within the width", () => {
		const diff = new DiffView(PLAIN_SEMANTIC_THEME, { lines });
		const narrow = diff.render(14).lines;
		assert.strictEqual(stripAnsi(narrow[3]!), "- const b = 2;");
		for (const width of [14, 3]) {
			for (const line of diff.render(width).lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		}
	});

	it("wraps long lines under the text column and limits the shown lines", () => {
		const diff = new DiffView(PLAIN_SEMANTIC_THEME, { lines, lineNumbers: false, wrap: true, maxLines: 5 });
		assert.deepStrictEqual(diff.render(24).lines.map(stripAnsi), [
			"src/app.ts",
			"@@ -8,3 +8,3 @@",
			"  const a = 1;",
			"- const b = 2;",
			"+ const b = 3; //",
			"  updated value for the",
			"  new release",
			"… 1 more diff line",
		]);
	});

	it("colors lines by kind", () => {
		const diff = new DiffView(tagTheme, { lines: lines.slice(1, 5), lineNumbers: false });
		assert.deepStrictEqual(diff.render(40).lines.map(showTags), [
			"<accent>@@ -8,3 +8,3 @@</accent>",
			"  const a = 1;",
			"<error>- </error><error>const b = 2;</error>",
			"<success>+ </success><success>const b = 3; // updated value for the…</success>",
		]);
	});
});
