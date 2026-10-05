import * as fc from "fast-check";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import { type UiNode, UiNodeSchema, type UiNodeStyledText, type UiTerminalNode } from "../src/ui-node.ts";
import { applyUiPatch, diffUiTree, type UiPatchOp, UiPatchSchema } from "../src/ui-patch.ts";
import { deepFreeze } from "./projected-log.ts";

const PROPERTY_SEED = 6_051_003;
const RUNS = { seed: PROPERTY_SEED, numRuns: 500 };

// ============================================================================
// Trees
// ============================================================================

/** A few keys, so edits often reuse or swap them, and some nodes stay unkeyed. */
const keyArbitrary = fc.option(fc.constantFrom("a", "b", "c", "d", "e", "f"), { nil: undefined, freq: 8 });
const wordArbitrary = fc.constantFrom("", "one", "two", "three", "done");
const styledArbitrary: fc.Arbitrary<UiNodeStyledText> = fc.oneof(
	wordArbitrary,
	fc.array(fc.record({ text: wordArbitrary, token: fc.constantFrom("muted" as const, "error" as const) }), {
		maxLength: 2,
	}),
);
const styledLine: UiTerminalNode["lines"][number] = [{ text: "FAIL", token: "error", bold: true }];
const lineArbitrary = fc.oneof(
	fc.constantFrom<UiTerminalNode["lines"][number]>("$ npm test", "PASS a.test.ts", "FAIL b.test.ts", "line"),
	fc.constant(styledLine),
);
const linesArbitrary = fc.array(lineArbitrary, { maxLength: 6 });

function withKey(key: string | undefined, node: UiNode): UiNode {
	const keyed: UiNode = { ...node };
	if (key === undefined) delete keyed.key;
	else keyed.key = key;
	return keyed;
}

const leafArbitrary: fc.Arbitrary<UiNode> = fc.oneof(
	fc.record({ key: keyArbitrary, text: styledArbitrary }).map(({ key, text }) => withKey(key, { type: "text", text })),
	fc
		.record({ key: keyArbitrary, markdown: wordArbitrary })
		.map(({ key, markdown }) => withKey(key, { type: "markdown", markdown })),
	fc
		.record({
			key: keyArbitrary,
			lines: linesArbitrary,
			omitted: fc.option(fc.nat({ max: 20 }), { nil: undefined }),
			title: fc.option(wordArbitrary, { nil: undefined }),
		})
		.map(({ key, lines, omitted, title }) =>
			withKey(key, {
				type: "terminal",
				lines,
				...(omitted === undefined ? {} : { omittedLines: omitted }),
				...(title === undefined ? {} : { title }),
			}),
		),
	fc
		.record({ key: keyArbitrary, startedAt: fc.nat({ max: 1_000 }), status: fc.constantFrom("active", "done") })
		.map(({ key, startedAt, status }) =>
			withKey(key, {
				type: "progress",
				kind: "steps",
				steps: [
					{ key: "s", label: "Step", status, startedAt, ...(status === "done" ? { endedAt: startedAt + 5 } : {}) },
				],
			}),
		),
	fc
		.record({ key: keyArbitrary, code: wordArbitrary })
		.map(({ key, code }) => withKey(key, { type: "code", language: "ts", code })),
);

const { forest: forestArbitrary } = fc.letrec<{ node: UiNode; forest: UiNode[]; list: UiNode; card: UiNode }>(
	(tie) => ({
		node: fc.oneof(
			{ maxDepth: 3, depthIdentifier: "ui-tree", withCrossShrink: true },
			leafArbitrary,
			tie("list"),
			tie("card"),
		),
		// Siblings mostly have distinct keys, as presenters key them; edits add repeats.
		forest: fc.uniqueArray(tie("node"), {
			maxLength: 4,
			depthIdentifier: "ui-tree",
			selector: (node) => node.key ?? {},
		}),
		list: fc
			.record({ key: keyArbitrary, ordered: fc.boolean(), items: tie("forest") })
			.map(({ key, ordered, items }) => withKey(key, { type: "list", ordered, items })),
		card: fc
			.record({
				key: keyArbitrary,
				title: styledArbitrary,
				sections: fc.option(
					fc.array(
						fc.record({
							key: keyArbitrary,
							title: fc.option(wordArbitrary, { nil: undefined }),
							children: tie("forest"),
						}),
						{ maxLength: 2 },
					),
					{ nil: undefined },
				),
			})
			.map(({ key, title, sections }) =>
				withKey(key, {
					type: "card",
					title,
					...(sections === undefined
						? {}
						: {
								sections: sections.map((section) => ({
									children: section.children,
									...(section.key === undefined ? {} : { key: section.key }),
									...(section.title === undefined ? {} : { title: section.title }),
								})),
							}),
				}),
			),
	}),
);

// ============================================================================
// Edits: next trees that share most of the previous tree
// ============================================================================

interface Edit {
	kind: "replace" | "append" | "insert" | "remove" | "move" | "rekey";
	container: number;
	child: number;
	node: UiNode;
	lines: UiTerminalNode["lines"];
	drop: number;
	key: string | undefined;
}

const editArbitrary: fc.Arbitrary<Edit> = fc.record({
	kind: fc.constantFrom("replace", "append", "append", "insert", "remove", "move", "rekey"),
	container: fc.nat(),
	child: fc.nat(),
	node: leafArbitrary,
	lines: fc.array(lineArbitrary, { minLength: 1, maxLength: 4 }),
	drop: fc.nat({ max: 3 }),
	key: keyArbitrary,
});

/** Every child list of a tree: the roots, list items, and section children. */
function containersOf(roots: UiNode[]): UiNode[][] {
	const containers: UiNode[][] = [roots];
	const visit = (nodes: UiNode[]): void => {
		for (const node of nodes) {
			if (node.type === "list") {
				containers.push(node.items);
				visit(node.items);
			} else if (node.type === "card") {
				for (const section of node.sections ?? []) {
					containers.push(section.children);
					visit(section.children);
				}
			}
		}
	};
	visit(roots);
	return containers;
}

function edited(prev: readonly UiNode[], edits: readonly Edit[]): UiNode[] {
	const roots = structuredClone(prev) as UiNode[];
	for (const edit of edits) {
		const containers = containersOf(roots);
		const container = containers[edit.container % containers.length] as UiNode[];
		const index = container.length === 0 ? 0 : edit.child % container.length;
		const target = container[index];
		switch (edit.kind) {
			case "insert":
				container.splice(index, 0, edit.node);
				break;
			case "remove":
				if (target) container.splice(index, 1);
				break;
			case "move":
				if (target && container.length > 1) {
					container.splice(index, 1);
					container.splice((index + 1 + edit.drop) % (container.length + 1), 0, target);
				}
				break;
			case "replace":
				if (target) container[index] = withKey(target.key, edit.node);
				break;
			case "append":
				if (target?.type === "terminal") {
					const lines = [...target.lines, ...edit.lines];
					const drop = Math.min(edit.drop, lines.length);
					container[index] = {
						...target,
						lines: lines.slice(drop),
						...(drop > 0 ? { omittedLines: (target.omittedLines ?? 0) + drop } : {}),
					};
				}
				break;
			case "rekey":
				if (target) container[index] = withKey(edit.key, target);
				break;
		}
	}
	return roots;
}

const treePairArbitrary = forestArbitrary.chain((prev) =>
	fc.oneof(
		{ arbitrary: fc.record({ prev: fc.constant(prev), next: forestArbitrary }), weight: 1 },
		{
			arbitrary: fc.array(editArbitrary, { minLength: 1, maxLength: 4 }).map((edits) => ({
				prev,
				next: edited(prev, edits),
			})),
			weight: 4,
		},
	),
);

// ============================================================================
// Properties
// ============================================================================

const encoder = new TextEncoder();
const bytes = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;

/** Replacing the whole tree: what a patch is bounded by. */
function replacement(next: readonly UiNode[]): UiPatchOp[] {
	const [first, ...rest] = next;
	if (first === undefined) return [{ op: "remove", path: [] }];
	return [
		{ op: "replace", path: [], node: first },
		...rest.map((node): UiPatchOp => ({ op: "insert", path: [], node })),
	];
}

describe("diffUiTree and applyUiPatch", () => {
	it("generate schema-valid trees", () => {
		fc.assert(
			fc.property(treePairArbitrary, ({ prev, next }) => {
				for (const node of [...prev, ...next]) expect(Check(UiNodeSchema, node), JSON.stringify(node)).toBe(true);
			}),
			{ ...RUNS, numRuns: 100 },
		);
	});

	it("apply(prev, diff(prev, next)) equals next", () => {
		fc.assert(
			fc.property(treePairArbitrary, ({ prev, next }) => {
				deepFreeze(prev);
				deepFreeze(next);
				const ops = diffUiTree(prev, next);
				expect(applyUiPatch(prev, ops)).toEqual(next);
			}),
			RUNS,
		);
	});

	it("diff(x, x) is empty", () => {
		fc.assert(
			fc.property(forestArbitrary, (tree) => {
				expect(diffUiTree(tree, tree)).toEqual([]);
				expect(diffUiTree(tree, structuredClone(tree))).toEqual([]);
			}),
			RUNS,
		);
	});

	it("keeps patches within the node bounds and never larger than replacing the tree", () => {
		fc.assert(
			fc.property(treePairArbitrary, ({ prev, next }) => {
				const ops = diffUiTree(prev, next);
				if (ops.length === 0) return;
				expect(Check(UiPatchSchema, ops), JSON.stringify(ops)).toBe(true);
				expect(bytes(ops)).toBeLessThanOrEqual(bytes(replacement(next)));
				for (const node of applyUiPatch(prev, ops)) expect(Check(UiNodeSchema, node)).toBe(true);
			}),
			RUNS,
		);
	});

	it("patches keyed trees in place", () => {
		let patched = 0;
		fc.assert(
			fc.property(treePairArbitrary, ({ prev, next }) => {
				if (diffUiTree(prev, next).some((op) => op.path.length > 0)) patched++;
			}),
			RUNS,
		);
		expect(patched).toBeGreaterThan(RUNS.numRuns / 10);
	});

	it("streams output a terminal gained as appended lines", () => {
		const streamArbitrary = fc.record({
			others: forestArbitrary,
			lines: fc.array(lineArbitrary, { minLength: 1, maxLength: 6 }),
			omitted: fc.option(fc.nat({ max: 20 }), { nil: undefined }),
			added: fc.array(lineArbitrary, { minLength: 1, maxLength: 4 }),
			drop: fc.nat({ max: 8 }),
		});
		fc.assert(
			fc.property(streamArbitrary, ({ others, lines, omitted, added, drop }) => {
				const terminal: UiNode = {
					type: "terminal",
					key: "output",
					title: "npm test",
					lines,
					...(omitted === undefined ? {} : { omittedLines: omitted }),
				};
				const dropped = Math.min(drop, lines.length);
				const grown: UiNode = {
					...terminal,
					lines: [...lines, ...added].slice(dropped),
					...(dropped > 0 ? { omittedLines: (omitted ?? 0) + dropped } : {}),
				};
				const card = (child: UiNode): UiNode => ({
					type: "card",
					key: "bash",
					title: "$ npm test",
					sections: [{ key: "body", children: [child] }],
				});
				// Keyed siblings, so the card is addressable.
				const siblings = others.filter((node) => node.key !== undefined && node.key !== "bash");
				const prev = [...siblings, card(terminal)];
				const next = [...siblings, card(grown)];
				const ops = diffUiTree(prev, next);
				expect(ops).toEqual([
					{
						op: "append_lines",
						path: ["bash", "body", "output"],
						lines: added,
						...(grown.type === "terminal" && grown.omittedLines !== omitted
							? { omittedLines: grown.omittedLines }
							: {}),
					},
				]);
				expect(applyUiPatch(prev, ops)).toEqual(next);
			}),
			RUNS,
		);
	});
});
