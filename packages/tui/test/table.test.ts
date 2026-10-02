import assert from "node:assert";
import { describe, it } from "node:test";
import { Table } from "../src/components/table.ts";
import { PLAIN_SEMANTIC_THEME } from "../src/styled-text.ts";
import { visibleWidth } from "../src/utils.ts";
import { showTags, tagTheme } from "./semantic-test-theme.ts";

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

const props = {
	columns: [{ header: "Name" }, { header: "Status" }, { header: "Time", align: "right" as const }],
	rows: [
		["build", [{ text: "passed", token: "success" as const }], "12s"],
		["integration-tests", [{ text: "failed", token: "error" as const }], "4m 3s"],
	],
};

describe("Table", () => {
	it("aligns columns at their natural widths", () => {
		const table = new Table(PLAIN_SEMANTIC_THEME, props);
		assert.deepStrictEqual(table.render(60).lines, [
			"Name               Status   Time",
			"─────────────────  ──────  ─────",
			"build              passed    12s",
			"integration-tests  failed  4m 3s",
		]);
	});

	it("shrinks the widest columns with ellipses to fit narrow widths", () => {
		const table = new Table(PLAIN_SEMANTIC_THEME, {
			...props,
			columns: [{ header: "Name" }, { header: "Status", minWidth: 6 }, { header: "Time", align: "right" as const }],
		});
		const lines = table.render(22).lines.map(stripAnsi);
		assert.deepStrictEqual(lines, [
			"Name     Status   Time",
			"───────  ──────  ─────",
			"build    passed    12s",
			"integr…  failed  4m 3s",
		]);
		for (const width of [22, 9, 3]) {
			for (const line of table.render(width).lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
		}
	});

	it("resolves cell tokens through the theme and shows empty text", () => {
		const table = new Table(tagTheme, props);
		const lines = table.render(40).lines.map(showTags);
		assert.ok(lines[2]!.includes("<success>passed</success>"), lines[2]);
		assert.strictEqual(lines[0], "<b>Name</b>               <b>Status</b>   <b>Time</b>");

		table.setProps({ columns: props.columns, rows: [], emptyText: "No jobs" });
		assert.deepStrictEqual(table.render(40).lines.slice(2).map(showTags), ["<muted>No jobs</muted>"]);
	});
});
