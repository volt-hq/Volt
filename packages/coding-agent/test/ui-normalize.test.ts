/**
 * Host normalization of `UiNode` data: ANSI styling to semantic tokens,
 * stripped controls, bounded terminal output, schema and structure checks,
 * the extension action allowlist, and size bounds.
 */

import {
	UI_NODE_LINE_MAX_CHARS,
	UI_NODE_TERMINAL_MAX_LINES,
	UI_NODE_TEXT_PATTERN,
	type UiNode,
	type UiNodeIntent,
	type UiNodeStyledText,
} from "@hansjm10/volt-protocol";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ansiToStyledLines, ansiToStyledText, stripTerminalControls } from "../src/core/ui/ansi-tokens.ts";
import {
	isAllowedUiIntent,
	normalizeStyledText,
	normalizeUiNode,
	normalizeUiNodes,
	UI_MAX_DEPTH,
	UI_PANEL_MAX_BYTES,
	type UiActionPolicy,
	UiNormalizeError,
	type UiNormalizeOptions,
} from "../src/core/ui/normalize.ts";

const HOST: UiNormalizeOptions = { policy: { owner: "host" }, maxBytes: UI_PANEL_MAX_BYTES };

function plainText(text: UiNodeStyledText): string {
	return typeof text === "string" ? text : text.map((span) => span.text).join("");
}

function extension(owned: readonly string[] = [], dropped: UiNodeIntent[] = []): UiNormalizeOptions {
	return {
		policy: { owner: "extension", extensionId: "deploy", ownsWork: (workId) => owned.includes(workId) },
		maxBytes: UI_PANEL_MAX_BYTES,
		onDroppedIntent: (intent) => dropped.push(intent),
	};
}

describe("ANSI to tokens", () => {
	it("maps SGR colors and emphasis to tokens and strips the rest", () => {
		expect(ansiToStyledText("\x1b[31mfail\x1b[0m ok")).toEqual([{ text: "fail", token: "error" }, { text: " ok" }]);
		expect(ansiToStyledText("\x1b[92mpass\x1b[39m")).toEqual([{ text: "pass", token: "success" }]);
		expect(ansiToStyledText("\x1b[33mwarn\x1b[93m!\x1b[m")).toEqual([{ text: "warn!", token: "warning" }]);
		for (const code of [34, 36, 94, 96]) {
			expect(ansiToStyledText(`\x1b[${code}mx`)).toEqual([{ text: "x", token: "info" }]);
		}
		expect(ansiToStyledText("\x1b[35ma\x1b[95mb")).toEqual([{ text: "ab", token: "accent" }]);
		expect(ansiToStyledText("\x1b[2mdim\x1b[22m \x1b[90mgray")).toEqual([
			{ text: "dim", token: "muted" },
			{ text: " " },
			{ text: "gray", token: "muted" },
		]);
		expect(ansiToStyledText("\x1b[1;3;4mall\x1b[24m no-u")).toEqual([
			{ text: "all", bold: true, italic: true, underline: true },
			{ text: " no-u", bold: true, italic: true },
		]);
		// A color token wins over dim.
		expect(ansiToStyledText("\x1b[2;31mx")).toEqual([{ text: "x", token: "error" }]);
	});

	it("strips other colors without misreading their arguments", () => {
		// 38;5;1 must not turn bold on, 38;2;1;3;4 must not set bold, italic, or underline.
		expect(ansiToStyledText("\x1b[38;5;1mx\x1b[38;2;1;3;4my\x1b[48;5;2mz")).toBe("xyz");
		expect(ansiToStyledText("\x1b[38:5:196mx\x1b[30my\x1b[37m\x1b[97mz\x1b[41mw")).toBe("xyzw");
		expect(ansiToStyledText("\x1b[31mred\x1b[38;5;9mplain")).toEqual([
			{ text: "red", token: "error" },
			{ text: "plain" },
		]);
		expect(ansiToStyledText("\x1b[4:3mcurly\x1b[4:0m")).toEqual([{ text: "curly", underline: true }]);
	});

	it("strips escape sequences, controls, and bidi overrides, keeping tabs and line feeds", () => {
		const text =
			"a\x1b]8;;https://x\x07link\x1b]8;;\x1b\\\x1b[2K\x1b[1Gb\x1b(B\x1b7c\x9b31md\x07\r\n‮E⁦F\x1bPdcs\x1b\\\x00\tG";
		expect(stripTerminalControls(text)).toBe("alinkbcd\nEF\tG");
		expect(ansiToStyledText(text)).toEqual([{ text: "alinkbc" }, { text: "d\nEF\tG", token: "error" }]);
		// Unterminated strings and a lone ESC are dropped.
		expect(stripTerminalControls("x\x1b]0;title")).toBe("x");
		expect(stripTerminalControls("x\x1b")).toBe("x");
	});

	it("splits output into lines, carrying styling across line feeds", () => {
		expect(ansiToStyledLines("\x1b[31mone\ntwo\x1b[0m\nthree")).toEqual([
			[{ text: "one", token: "error" }],
			[{ text: "two", token: "error" }],
			"three",
		]);
		expect(ansiToStyledLines("a\n\nb")).toEqual(["a", "", "b"]);
	});

	it("keeps the visible text and never emits controls (property)", () => {
		const pieces = fc.oneof(
			fc.string(),
			fc.constantFrom(
				"\x1b[31m",
				"\x1b[0m",
				"\x1b[1;2;3;4m",
				"\x1b[38;5;196m",
				"\x1b[38;2;1;2;3m",
				"\x1b]8;;u\x07",
				"\x1b[2K",
				"\x9b33m",
				"\x1b",
				"\r\n",
				"\t",
				"‮",
			),
		);
		const pattern = new RegExp(UI_NODE_TEXT_PATTERN, "u");
		fc.assert(
			fc.property(fc.array(pieces, { maxLength: 12 }), (parts) => {
				const input = parts.join("");
				const stripped = stripTerminalControls(input);
				const styled = ansiToStyledText(input);
				expect(plainText(styled)).toBe(stripped);
				expect(pattern.test(stripped)).toBe(true);
				expect(ansiToStyledLines(input).map(plainText).join("\n")).toBe(stripped);
			}),
		);
	});
});

describe("normalizeUiNode", () => {
	it("converts styled-text fields to tokens and strips every other text", () => {
		const node = normalizeUiNode(
			{
				type: "card",
				title: "\x1b[1mDeploy\x1b[0m",
				badges: [{ label: "\x1b[32mlive\x1b[0m", token: "success" }],
				sections: [
					{
						title: "\x1b[2mSteps",
						children: [
							{ type: "markdown", markdown: "**\x1b[31mbold\x1b[0m**" },
							{ type: "code", code: "\x1b[33mx\x1b[0m = 1", language: "ts" },
							{ type: "keyValue", items: [{ label: "Env", value: "\x1b[36mprod" }] },
						],
					},
				],
			},
			HOST,
		);
		expect(node).toEqual({
			type: "card",
			title: [{ text: "Deploy", bold: true }],
			badges: [{ label: "live", token: "success" }],
			sections: [
				{
					title: [{ text: "Steps", token: "muted" }],
					children: [
						{ type: "markdown", markdown: "**bold**" },
						{ type: "code", code: "x = 1", language: "ts" },
						{ type: "keyValue", items: [{ label: "Env", value: [{ text: "prod", token: "info" }] }] },
					],
				},
			],
		});

		const form = normalizeUiNode(
			{
				type: "form",
				fields: [
					{
						kind: "string",
						id: "name",
						label: "\x1b[1mName",
						value: "\x1b[2Jada",
						placeholder: "\x1b]0;t\x07who",
					},
					{ kind: "enum", id: "env", label: "Env", options: [{ value: "\x1b[31mprod" }], value: "\x1b[31mprod" },
					{ kind: "boolean", id: "dry", label: "Dry", value: true },
				],
				submit: { type: "save" },
			},
			HOST,
		);
		expect(form).toEqual({
			type: "form",
			fields: [
				{ kind: "string", id: "name", label: "Name", value: "ada", placeholder: "who" },
				{ kind: "enum", id: "env", label: "Env", options: [{ value: "prod" }], value: "prod" },
				{ kind: "boolean", id: "dry", label: "Dry", value: true },
			],
			submit: { type: "save" },
		});
	});

	it("splits terminal lines, keeps the newest, and cuts long lines", () => {
		const lines = Array.from({ length: UI_NODE_TERMINAL_MAX_LINES + 4 }, (_, index) => `line ${index}`);
		const node = normalizeUiNode(
			{
				type: "terminal",
				lines: ["\x1b[31ma\nb", ...lines, "x".repeat(UI_NODE_LINE_MAX_CHARS + 10)],
				omittedLines: 2,
			},
			HOST,
		);
		if (node?.type !== "terminal") throw new Error("expected a terminal node");
		expect(node.lines).toHaveLength(UI_NODE_TERMINAL_MAX_LINES);
		expect(node.omittedLines).toBe(2 + 7);
		expect(node.lines.at(-1)).toBe("x".repeat(UI_NODE_LINE_MAX_CHARS));
		expect(node.lines.at(-2)).toBe(`line ${UI_NODE_TERMINAL_MAX_LINES + 3}`);

		const short = normalizeUiNode({ type: "terminal", lines: ["\x1b[31ma\nb", [{ text: "c\x1b[1m\nd" }]] }, HOST);
		expect(short).toEqual({
			type: "terminal",
			lines: [[{ text: "a", token: "error" }], [{ text: "b", token: "error" }], [{ text: "c d" }]],
		});

		const diff = normalizeUiNode({ type: "diff", lines: [{ kind: "add", text: "\x1b[32m+a\nb" }] }, HOST);
		expect(diff).toEqual({ type: "diff", lines: [{ kind: "add", text: "+a b" }] });
	});

	it("rejects data the schema refuses, duplicate keys and ids, deep nesting, and unsafe patterns", () => {
		const invalid = (input: unknown) => () => normalizeUiNode(input, HOST);
		expect(invalid({ type: "widget" })).toThrow(/unknown node type "widget"/);
		expect(invalid({ type: "widget" })).toThrow(UiNormalizeError);
		expect(invalid({ type: "text", text: "x", color: "red" })).toThrow(
			/Invalid text node at \/: must not have additional/,
		);
		expect(invalid({ type: "list", items: [], ordered: "yes" })).toThrow(/does not match the list node schema/);
		expect(
			invalid({
				type: "list",
				items: [
					{ type: "text", text: "a" },
					{ type: "text", key: "k", text: [{ text: 1 }] },
				],
			}),
		).toThrow(/Invalid text node at \/items\/1\/text/);
		expect(
			invalid({
				type: "list",
				items: [
					{ type: "text", key: "a", text: "1" },
					{ type: "text", key: "a", text: "2" },
				],
			}),
		).toThrow(/Duplicate key "a"/);
		expect(
			invalid({
				type: "card",
				title: "t",
				sections: [
					{ key: "s", children: [] },
					{ key: "s", children: [] },
				],
			}),
		).toThrow(/Duplicate key "s"/);
		expect(
			invalid({
				type: "tree",
				items: [
					{ id: "a", label: "A", children: [{ id: "b", label: "B" }] },
					{ id: "b", label: "B again" },
				],
			}),
		).toThrow(/Duplicate tree item id "b"/);
		expect(
			invalid({
				type: "form",
				fields: [
					{ kind: "boolean", id: "f", label: "F" },
					{ kind: "boolean", id: "f", label: "G" },
				],
				submit: { type: "x" },
			}),
		).toThrow(/Duplicate field id "f"/);
		expect(
			invalid({
				type: "form",
				fields: [{ kind: "string", id: "name", label: "Name", pattern: "(a+)+$" }],
				submit: { type: "x" },
			}),
		).toThrow(/not safe to test/);

		let deep: unknown = { type: "text", text: "leaf" };
		for (let depth = 0; depth < UI_MAX_DEPTH; depth++) deep = { type: "list", items: [deep] };
		expect(invalid(deep)).toThrow(/nest deeper/);
		const cyclic: Record<string, unknown> = { type: "list" };
		cyclic.items = [cyclic];
		expect(invalid(cyclic)).toThrow(/not JSON/);
	});

	it("bounds the encoded size", () => {
		const options: UiNormalizeOptions = { policy: { owner: "host" }, maxBytes: 64 };
		expect(normalizeUiNode({ type: "text", text: "short" }, options)).toEqual({ type: "text", text: "short" });
		expect(() => normalizeUiNode({ type: "text", text: "x".repeat(80) }, options)).toThrow(/over the 64-byte bound/);
		// Far over the bound is refused before conversion.
		expect(() => normalizeUiNode({ type: "text", text: "x".repeat(1000) }, options)).toThrow(
			/exceeds the 64-byte bound/,
		);
	});
});

describe("action allowlist", () => {
	const policy: UiActionPolicy = { owner: "extension", extensionId: "deploy", ownsWork: (id) => id === "w1" };

	it("lets an extension bind only its own commands, intents, and work", () => {
		const allowed = (type: string, input?: Record<string, unknown>) =>
			isAllowedUiIntent({ type, ...(input === undefined ? {} : { input }) }, policy);
		expect(allowed("extension.command.deploy.ship")).toBe(true);
		expect(allowed("extension.intent.deploy.retry")).toBe(true);
		expect(allowed("extension.command.deploy.")).toBe(false);
		expect(allowed("extension.command.deploy-other.ship")).toBe(false);
		expect(allowed("extension.command.other.ship")).toBe(false);
		expect(allowed("new_session")).toBe(false);
		expect(allowed("open_work", { workId: "w1" })).toBe(true);
		expect(allowed("cancel_work", { workId: "w1" })).toBe(true);
		expect(allowed("cancel_work", { workId: "w2" })).toBe(false);
		expect(allowed("cancel_work")).toBe(false);
		expect(isAllowedUiIntent({ type: "new_session" }, { owner: "host" })).toBe(true);
	});

	it("drops disallowed actions and forms, and reports them", () => {
		const dropped: UiNodeIntent[] = [];
		const nodes = normalizeUiNodes(
			[
				{
					type: "actions",
					actions: [
						{ id: "ship", label: "Ship", intent: { type: "extension.command.deploy.ship" } },
						{ id: "wipe", label: "Wipe", intent: { type: "delete_session" } },
					],
				},
				{ type: "actions", actions: [{ id: "new", label: "New", intent: { type: "new_session" } }] },
				{
					type: "card",
					title: "Job",
					actions: [{ id: "cancel", label: "Cancel", intent: { type: "cancel_work", input: { workId: "w2" } } }],
					sections: [
						{
							children: [
								{
									type: "form",
									fields: [{ kind: "boolean", id: "dry", label: "Dry run" }],
									submit: { type: "extension.intent.deploy.configure" },
									cancel: { type: "abort" },
									cancelLabel: "Stop",
								},
								{
									type: "form",
									fields: [{ kind: "boolean", id: "x", label: "X" }],
									submit: { type: "set_fast_mode" },
								},
							],
						},
					],
				},
				{
					type: "list",
					items: [
						{
							type: "actions",
							actions: [{ id: "open", label: "Open", intent: { type: "open_work", input: { workId: "w1" } } }],
						},
					],
				},
			],
			extension(["w1"], dropped),
		);
		const expected: UiNode[] = [
			{
				type: "actions",
				actions: [{ id: "ship", label: "Ship", intent: { type: "extension.command.deploy.ship" } }],
			},
			{
				type: "card",
				title: "Job",
				sections: [
					{
						children: [
							{
								type: "form",
								fields: [{ kind: "boolean", id: "dry", label: "Dry run" }],
								submit: { type: "extension.intent.deploy.configure" },
							},
						],
					},
				],
			},
			{
				type: "list",
				items: [
					{
						type: "actions",
						actions: [{ id: "open", label: "Open", intent: { type: "open_work", input: { workId: "w1" } } }],
					},
				],
			},
		];
		expect(nodes).toEqual(expected);
		expect(dropped.map((intent) => intent.type)).toEqual([
			"delete_session",
			"new_session",
			"cancel_work",
			"abort",
			"set_fast_mode",
		]);
		// A root the policy removes whole normalizes to nothing.
		expect(
			normalizeUiNode(
				{ type: "actions", actions: [{ id: "new", label: "New", intent: { type: "new_session" } }] },
				extension(),
			),
		).toBeUndefined();
	});
});

describe("normalizeStyledText", () => {
	it("converts strings and strips spans", () => {
		expect(normalizeStyledText("\x1b[33mwait\x1b[0m", { maxBytes: 1024 })).toEqual([
			{ text: "wait", token: "warning" },
		]);
		expect(normalizeStyledText([{ text: "a\x1b[31mb", token: "accent" }], { maxBytes: 1024 })).toEqual([
			{ text: "ab", token: "accent" },
		]);
		expect(() => normalizeStyledText(42, { maxBytes: 1024 })).toThrow(UiNormalizeError);
		expect(() => normalizeStyledText("x".repeat(100), { maxBytes: 16 })).toThrow(UiNormalizeError);
	});
});
