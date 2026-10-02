import assert from "node:assert";
import { describe, it } from "node:test";
import { ProgressBar, StepProgress } from "../src/components/progress.ts";
import { PLAIN_SEMANTIC_THEME } from "../src/styled-text.ts";
import { visibleWidth } from "../src/utils.ts";
import { showTags, tagTheme } from "./semantic-test-theme.ts";

describe("ProgressBar", () => {
	it("fills the bar proportionally and fits the label and percentage", () => {
		const bar = new ProgressBar(PLAIN_SEMANTIC_THEME, { value: 3, max: 10, label: "Upload" });
		assert.deepStrictEqual(bar.render(27).lines, ["Upload █████░░░░░░░░░░  30%"]);
		assert.strictEqual(bar.render(9).lines[0], "█░░░  30%");
		for (const width of [27, 9, 4]) assert.ok(visibleWidth(bar.render(width).lines[0]!) <= width);
	});

	it("clamps values, handles invalid maxima, and styles the filled part", () => {
		const bar = new ProgressBar(tagTheme, { value: 5, max: 4, token: "success", showPercent: false });
		assert.strictEqual(bar.getFraction(), 1);
		assert.strictEqual(showTags(bar.render(4).lines[0]!), "<success>████</success>");
		bar.setProps({ value: 1, max: 0 });
		assert.strictEqual(bar.getFraction(), 0);
		bar.setProps({ value: -2 });
		assert.strictEqual(bar.getFraction(), 0);
	});
});

describe("StepProgress", () => {
	const steps = [
		{ label: "Fetch", status: "done" as const, detail: "1.2s" },
		{ label: "Build", status: "active" as const, detail: "compiling 12 packages" },
		{ label: "Test", status: "failed" as const },
		{ label: "Deploy", status: "pending" as const },
		{ label: "Notify", status: "skipped" as const },
	];

	it("renders a status icon, label, and detail per step with a counted title", () => {
		const progress = new StepProgress(PLAIN_SEMANTIC_THEME, { steps, title: "Release" });
		assert.deepStrictEqual(progress.render(40).lines, [
			"Release (1/5)",
			"✓ Fetch  1.2s",
			"● Build  compiling 12 packages",
			"✗ Test",
			"○ Deploy",
			"– Notify",
		]);
		const narrow = progress.render(12).lines;
		assert.strictEqual(narrow[2], "● Build");
		for (const line of narrow) assert.ok(visibleWidth(line) <= 12, line);
	});

	it("resolves step status tokens", () => {
		const progress = new StepProgress(tagTheme, { steps });
		const lines = progress.render(40).lines.map(showTags);
		assert.strictEqual(lines[0], "<success>✓</success> Fetch  <muted>1.2s</muted>");
		assert.strictEqual(lines[2], "<error>✗</error> Test");
		assert.strictEqual(lines[3], "<muted>○</muted> <muted>Deploy</muted>");
	});
});
