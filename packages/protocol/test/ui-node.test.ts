import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { UI_NODE_TERMINAL_MAX_LINES, type UiNode, UiNodeSchema } from "../src/ui-node.ts";

const intent = { type: "set_agent_mode", input: { mode: "plan" } };

const EVERY_NODE: UiNode[] = [
	{ type: "text", key: "status", text: [{ text: "Ready", token: "success", bold: true }, { text: " now" }] },
	{ type: "markdown", markdown: "# Title\n\nBody with `code`." },
	{
		type: "list",
		ordered: true,
		items: [
			{ type: "text", text: "one" },
			{ type: "text", text: "two" },
		],
	},
	{
		type: "table",
		columns: [{ header: "File" }, { header: "Lines", align: "right" }],
		rows: [{ key: "a", cells: ["a.ts", "12"] }],
		emptyText: "No files",
	},
	{ type: "keyValue", items: [{ key: "model", label: "Model", value: [{ text: "claude", token: "accent" }] }] },
	{ type: "progress", kind: "determinate", value: 3, max: 10, label: "Indexing", token: "info" },
	{
		type: "progress",
		kind: "steps",
		title: "Review",
		steps: [
			{
				key: "discover",
				label: "Discover",
				status: "done",
				startedAt: 1_760_000_000_000,
				endedAt: 1_760_000_004_000,
			},
			{ key: "verify", label: "Verify", status: "active", detail: "2 of 5", startedAt: 1_760_000_004_000 },
		],
	},
	{
		type: "form",
		title: "Settings",
		fields: [
			{ kind: "string", id: "name", label: "Name", required: true, minLength: 1, maxLength: 64, pattern: "^\\w+$" },
			{ kind: "boolean", id: "enabled", label: "Enabled", value: true },
			{ kind: "enum", id: "effort", label: "Effort", options: [{ value: "low" }, { value: "high", label: "High" }] },
			{ kind: "integer", id: "limit", label: "Limit", min: 1, max: 50, value: 10 },
		],
		submit: { type: "ext:acme/save-settings" },
		submitLabel: "Save",
	},
	{
		type: "actions",
		actions: [
			{ id: "plan", label: "Plan", intent },
			{ id: "stop", label: "Stop", destructive: true, intent: { type: "abort" } },
		],
	},
	{
		type: "card",
		key: "job-1",
		title: "Background job",
		token: "accent",
		badges: [{ label: "running", token: "info" }],
		sections: [{ key: "output", title: "Output", children: [{ type: "terminal", lines: ["$ npm test"] }] }],
		actions: [{ id: "cancel", label: "Cancel", intent: { type: "cancel_work", input: { workId: "w1" } } }],
	},
	{
		type: "diff",
		path: "src/a.ts",
		lines: [
			{ kind: "hunk", text: "@@ -1 +1 @@" },
			{ kind: "remove", text: "old", oldLine: 1 },
			{ kind: "add", text: "new", newLine: 1 },
		],
		lineNumbers: true,
	},
	{
		type: "terminal",
		title: "npm test",
		lines: ["PASS a.test.ts", [{ text: "FAIL", token: "error", bold: true }, { text: " b.test.ts" }]],
		omittedLines: 120,
	},
	{ type: "code", language: "ts", code: "const x = 1;\n" },
	{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=", alt: "logo" },
	{
		type: "tree",
		items: [{ id: "src", label: "src", children: [{ id: "src/a.ts", label: "a.ts", description: "12 lines" }] }],
		expanded: ["src"],
	},
];

describe("UiNode", () => {
	it("accepts every node type", () => {
		for (const node of EVERY_NODE) {
			expect(Check(UiNodeSchema, node), `${node.type}: ${JSON.stringify(node)}`).toBe(true);
		}
	});

	it("nests nodes through list items and card sections", () => {
		const nested: UiNode = {
			type: "card",
			title: "Outer",
			sections: [{ children: [{ type: "list", items: [{ type: "card", title: "Inner", sections: [] }] }] }],
		};
		expect(Check(UiNodeSchema, nested)).toBe(true);
		expect(
			Check(UiNodeSchema, {
				type: "list",
				items: [{ type: "list", items: [{ type: "text", text: "deep", unknown: 1 }] }],
			}),
		).toBe(false);
	});

	it("rejects ANSI and other terminal control sequences in every text position", () => {
		const ansi = "\u001b[31mred\u001b[0m";
		const csi = "\u009b31m";
		for (const node of [
			{ type: "text", text: ansi },
			{ type: "text", text: [{ text: csi, token: "error" }] },
			{ type: "markdown", markdown: `bell\u0007` },
			{ type: "terminal", lines: [ansi] },
			{ type: "terminal", lines: [[{ text: ansi }]] },
			{ type: "diff", lines: [{ kind: "add", text: ansi }] },
			{ type: "code", code: "carriage\rreturn" },
			{ type: "card", title: "ok", badges: [{ label: ansi }] },
			{ type: "tree", items: [{ id: "a", label: ansi }] },
		]) {
			expect(Check(UiNodeSchema, node), JSON.stringify(node)).toBe(false);
		}
		expect(Check(UiNodeSchema, { type: "text", text: "tab\tand\nnewline are text" })).toBe(true);
		expect(Check(UiNodeSchema, { type: "terminal", lines: ["one\ntwo"] })).toBe(false);
	});

	it("styles text with semantic tokens only", () => {
		expect(Check(UiNodeSchema, { type: "text", text: "x", token: "error" })).toBe(true);
		expect(Check(UiNodeSchema, { type: "text", text: "x", token: "red" })).toBe(false);
		expect(Check(UiNodeSchema, { type: "text", text: [{ text: "x", color: "#ff0000" }] })).toBe(false);
	});

	it("rejects unknown node types and unknown fields", () => {
		expect(Check(UiNodeSchema, { type: "html", html: "<b>x</b>" })).toBe(false);
		expect(Check(UiNodeSchema, { type: "text", text: "x", onClick: "run()" })).toBe(false);
		expect(Check(UiNodeSchema, { type: "actions", actions: [{ id: "a", label: "A", intent, run: "x" }] })).toBe(
			false,
		);
		expect(
			Check(UiNodeSchema, { type: "form", fields: [{ kind: "date", id: "d", label: "D" }], submit: intent }),
		).toBe(false);
	});

	it("binds actions and forms to intents", () => {
		expect(Check(UiNodeSchema, { type: "actions", actions: [{ id: "a", label: "A" }] })).toBe(false);
		expect(Check(UiNodeSchema, { type: "actions", actions: [{ id: "a", label: "A", intent: { type: "" } }] })).toBe(
			false,
		);
		expect(Check(UiNodeSchema, { type: "form", fields: [{ kind: "boolean", id: "b", label: "B" }] })).toBe(false);
	});

	it("bounds terminal output, progress, and images", () => {
		const lines = Array.from({ length: UI_NODE_TERMINAL_MAX_LINES + 1 }, (_, index) => `line ${index}`);
		expect(Check(UiNodeSchema, { type: "terminal", lines: lines.slice(1) })).toBe(true);
		expect(Check(UiNodeSchema, { type: "terminal", lines })).toBe(false);
		expect(Check(UiNodeSchema, { type: "progress", kind: "determinate", value: -1 })).toBe(false);
		expect(Check(UiNodeSchema, { type: "progress", kind: "determinate", value: 1, max: 0 })).toBe(false);
		const step = { key: "s", label: "Step", status: "done" };
		expect(Check(UiNodeSchema, { type: "progress", kind: "steps", steps: [{ ...step, startedAt: -1 }] })).toBe(false);
		expect(Check(UiNodeSchema, { type: "progress", kind: "steps", steps: [{ ...step, endedAt: 1.5 }] })).toBe(false);
		expect(Check(UiNodeSchema, { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" })).toBe(false);
		expect(Check(UiNodeSchema, { type: "image", mimeType: "image/png", data: "not base64!" })).toBe(false);
	});

	it("accepts keys on every node and repeated item for keyed patches", () => {
		expect(Check(UiNodeSchema, { type: "markdown", key: "notes", markdown: "x" })).toBe(true);
		expect(Check(UiNodeSchema, { type: "markdown", key: "", markdown: "x" })).toBe(false);
	});
});
