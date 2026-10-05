import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { UI_NODE_TERMINAL_MAX_LINES, type UiNode } from "../src/ui-node.ts";
import {
	applyUiPatch,
	diffUiTree,
	UI_PATCH_PATH_MAX_KEYS,
	UiPatchError,
	type UiPatchOp,
	UiPatchOpSchema,
	UiPatchSchema,
} from "../src/ui-patch.ts";
import { deepFreeze } from "./projected-log.ts";

const text = (key: string, value: string): UiNode => ({ type: "text", key, text: value });

function job(lines: string[], omittedLines?: number): UiNode[] {
	return deepFreeze([
		text("status", "running"),
		{
			type: "card",
			key: "job",
			title: "$ npm test",
			sections: [
				{
					key: "output",
					children: [
						{ type: "terminal", key: "log", lines, ...(omittedLines === undefined ? {} : { omittedLines }) },
					],
				},
			],
		},
		{ type: "list", key: "files", items: [text("a", "a.ts"), text("b", "b.ts")] },
	]);
}

describe("UiPatch schema", () => {
	it("accepts the four operations with key paths", () => {
		const ops: UiPatchOp[] = [
			{ op: "replace", path: ["status"], node: text("status", "done") },
			{ op: "remove", path: ["files", "a"] },
			{ op: "insert", path: ["files"], before: "b", node: text("c", "c.ts") },
			{ op: "append_lines", path: ["job", "output", "log"], lines: ["PASS"], omittedLines: 3 },
			{ op: "replace", path: [], node: text("root", "x") },
			{ op: "remove", path: [] },
		];
		expect(Check(UiPatchSchema, ops)).toBe(true);
	});

	it("rejects unknown operations, empty keys, deep paths, and terminal input", () => {
		expect(Check(UiPatchSchema, [])).toBe(false);
		expect(Check(UiPatchOpSchema, { op: "move", path: ["a"] })).toBe(false);
		expect(Check(UiPatchOpSchema, { op: "remove", path: [""] })).toBe(false);
		expect(Check(UiPatchOpSchema, { op: "remove", path: Array(UI_PATCH_PATH_MAX_KEYS + 1).fill("k") })).toBe(false);
		expect(Check(UiPatchOpSchema, { op: "append_lines", path: [], lines: ["x"] })).toBe(false);
		expect(Check(UiPatchOpSchema, { op: "append_lines", path: ["log"], lines: [] })).toBe(false);
		expect(Check(UiPatchOpSchema, { op: "append_lines", path: ["log"], lines: ["\u001b[31mred"] })).toBe(false);
		expect(Check(UiPatchOpSchema, { op: "replace", path: ["a"], node: { type: "html" } })).toBe(false);
	});
});

describe("applyUiPatch", () => {
	it("replaces, removes, and inserts by key without changing the input", () => {
		const tree = job(["$ npm test"]);
		const next = applyUiPatch(tree, [
			{ op: "replace", path: ["status"], node: text("status", "done") },
			{ op: "remove", path: ["files", "a"] },
			{ op: "insert", path: ["files"], before: "b", node: text("c", "c.ts") },
			{ op: "insert", path: ["files"], node: text("d", "d.ts") },
			{ op: "insert", path: ["job", "output"], node: text("exit", "exit 0") },
			{ op: "insert", path: [], before: "status", node: text("first", "first") },
		]);
		expect(next).toEqual([
			text("first", "first"),
			text("status", "done"),
			{
				type: "card",
				key: "job",
				title: "$ npm test",
				sections: [
					{
						key: "output",
						children: [{ type: "terminal", key: "log", lines: ["$ npm test"] }, text("exit", "exit 0")],
					},
				],
			},
			{ type: "list", key: "files", items: [text("c", "c.ts"), text("b", "b.ts"), text("d", "d.ts")] },
		]);
		expect(tree).toEqual(job(["$ npm test"]));
		expect(next[3]).not.toBe(tree[2]);
		expect(applyUiPatch(tree, [{ op: "remove", path: ["status"] }])[1]).toBe(tree[2]);
	});

	it("replaces or empties the whole tree at the empty path", () => {
		const tree = job([]);
		expect(applyUiPatch(tree, [{ op: "replace", path: [], node: text("x", "x") }])).toEqual([text("x", "x")]);
		expect(applyUiPatch(tree, [{ op: "remove", path: [] }])).toEqual([]);
		expect(applyUiPatch([], [{ op: "insert", path: [], node: text("x", "x") }])).toEqual([text("x", "x")]);
	});

	it("appends lines and counts the oldest ones as omitted", () => {
		const log = (tree: UiNode[]) => {
			const card = tree[1];
			return card?.type === "card" ? card.sections?.[0]?.children[0] : undefined;
		};
		const path = ["job", "output", "log"];
		expect(log(applyUiPatch(job(["a"]), [{ op: "append_lines", path, lines: ["b", "c"] }]))).toEqual({
			type: "terminal",
			key: "log",
			lines: ["a", "b", "c"],
		});
		expect(
			log(applyUiPatch(job(["a", "b"], 5), [{ op: "append_lines", path, lines: ["c"], omittedLines: 6 }])),
		).toEqual({ type: "terminal", key: "log", lines: ["b", "c"], omittedLines: 6 });
	});

	it("rejects operations that do not apply", () => {
		const tree = job(["a"]);
		const rejects = (op: UiPatchOp, message: RegExp) =>
			expect(() => applyUiPatch(tree, [op])).toThrow(
				expect.objectContaining({ name: "UiPatchError", message: expect.stringMatching(message) }),
			);
		rejects({ op: "remove", path: ["missing"] }, /no child is keyed "missing"/);
		rejects({ op: "remove", path: ["status", "x"] }, /text node has no children/);
		rejects({ op: "insert", path: ["status"], node: text("x", "x") }, /takes no inserts/);
		rejects({ op: "insert", path: ["job"], node: text("x", "x") }, /takes no inserts/);
		rejects({ op: "remove", path: ["job", "output"] }, /takes inserts only/);
		rejects({ op: "insert", path: ["files"], before: "z", node: text("x", "x") }, /no child is keyed "z"/);
		rejects({ op: "append_lines", path: ["status"], lines: ["x"] }, /has no lines/);
		rejects({ op: "append_lines", path: ["job", "output", "log"], lines: ["x"], omittedLines: 3 }, /does not follow/);
		expect(() => applyUiPatch([text("k", "1"), text("k", "2")], [{ op: "remove", path: ["k"] }])).toThrow(
			/more than one child is keyed "k"/,
		);
		const full = Array.from({ length: UI_NODE_TERMINAL_MAX_LINES }, (_, index) => `line ${index}`);
		expect(() =>
			applyUiPatch(
				[{ type: "terminal", key: "log", lines: full }],
				[{ op: "append_lines", path: ["log"], lines: ["x"] }],
			),
		).toThrow(UiPatchError);
		expect(
			applyUiPatch(
				[{ type: "terminal", key: "log", lines: full }],
				[{ op: "append_lines", path: ["log"], lines: ["x"], omittedLines: 1 }],
			)[0],
		).toEqual({ type: "terminal", key: "log", lines: [...full.slice(1), "x"], omittedLines: 1 });
	});
});

describe("diffUiTree", () => {
	it("is empty for equal trees", () => {
		expect(diffUiTree(job(["a"]), job(["a"]))).toEqual([]);
		expect(diffUiTree([], [])).toEqual([]);
	});

	it("appends a terminal's new lines by key path", () => {
		expect(diffUiTree(job(["a", "b"]), job(["a", "b", "c"]))).toEqual([
			{ op: "append_lines", path: ["job", "output", "log"], lines: ["c"] },
		]);
		expect(diffUiTree(job(["a", "b"], 2), job(["b", "c", "d"], 3))).toEqual([
			{ op: "append_lines", path: ["job", "output", "log"], lines: ["c", "d"], omittedLines: 3 },
		]);
	});

	it("moves, inserts, and removes keyed children", () => {
		const file = (key: string) => text(key, `${key}.ts: ${"changed lines ".repeat(8)}`);
		const prev: UiNode[] = [{ type: "list", key: "files", items: ["a", "b", "c", "d"].map(file) }];
		const next: UiNode[] = [{ type: "list", key: "files", items: ["b", "a", "e", "c"].map(file) }];
		const ops = diffUiTree(prev, next);
		expect(ops.filter((op) => op.op === "remove").map((op) => op.path)).toEqual([
			["files", "b"],
			["files", "d"],
		]);
		expect(applyUiPatch(prev, ops)).toEqual(next);
	});

	it("replaces the whole tree when its roots are unkeyed or share a key", () => {
		const prev: UiNode[] = [{ type: "text", text: "a" }];
		expect(diffUiTree(prev, [{ type: "text", text: "b" }])).toEqual([
			{ op: "replace", path: [], node: { type: "text", text: "b" } },
		]);
		expect(diffUiTree([text("k", "1"), text("k", "2")], [text("k", "1")])).toEqual([
			{ op: "replace", path: [], node: text("k", "1") },
		]);
		expect(diffUiTree(prev, [])).toEqual([{ op: "remove", path: [] }]);
	});
});
