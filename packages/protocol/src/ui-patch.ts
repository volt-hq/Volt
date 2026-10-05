/**
 * Keyed patches for `UiNode` trees (RFC §8.3): live-lane presentation updates
 * change a tree a client already holds instead of resending it, so streaming
 * output appends lines instead of resending a whole card.
 *
 * A tree is the list of root nodes a patch applies to. A path is a chain of
 * keys from the roots: each key selects the one child with that key, where a
 * node's children are a list's items, a card's sections, and a section's
 * children. The empty path names the roots themselves.
 *
 * - `replace{path, node}` replaces the node at `path`; at the roots, the tree
 *   becomes that one node.
 * - `remove{path}` removes the node at `path`; at the roots, the tree becomes
 *   empty.
 * - `insert{path, before?, node}` inserts `node` into the roots, a list, or a
 *   card section at `path`: before its child keyed `before`, or last.
 * - `append_lines{path, lines, omittedLines?}` appends output lines to the
 *   terminal node at `path`. `omittedLines`, when present, is the node's new
 *   `omittedLines`: the oldest lines it newly counts are dropped from the front.
 *
 * Hosts compute patches with {@link diffUiTree}; clients apply them with
 * {@link applyUiPatch}. A patch that does not apply means the client's tree
 * diverged: the client resubscribes after its position.
 */

import { type Static, Type } from "typebox";
import {
	UI_NODE_TERMINAL_MAX_LINES,
	type UiCardNode,
	type UiCardSection,
	type UiNode,
	UiNodeKeySchema,
	UiNodeSchema,
	UiNodeStyledLineSchema,
	type UiTerminalNode,
} from "./ui-node.ts";

const closed = { additionalProperties: false } as const;

/** Most keys in a patch path. Deeper changes replace an ancestor instead. */
export const UI_PATCH_PATH_MAX_KEYS = 32;

/** The `x-volt-limits` block for UI patches. */
export const UI_PATCH_LIMITS = { pathMaxKeys: UI_PATCH_PATH_MAX_KEYS } as const;

/** A chain of node and section keys from the roots; empty for the roots themselves. */
export const UiPatchPathSchema = Type.Array(UiNodeKeySchema, { maxItems: UI_PATCH_PATH_MAX_KEYS });

export const UiPatchOpSchema = Type.Union([
	Type.Object({ op: Type.Literal("replace"), path: UiPatchPathSchema, node: UiNodeSchema }, closed),
	Type.Object({ op: Type.Literal("remove"), path: UiPatchPathSchema }, closed),
	Type.Object(
		{
			op: Type.Literal("insert"),
			path: UiPatchPathSchema,
			before: Type.Optional(UiNodeKeySchema),
			node: UiNodeSchema,
		},
		closed,
	),
	Type.Object(
		{
			op: Type.Literal("append_lines"),
			path: Type.Array(UiNodeKeySchema, { minItems: 1, maxItems: UI_PATCH_PATH_MAX_KEYS }),
			lines: Type.Array(UiNodeStyledLineSchema, { minItems: 1, maxItems: UI_NODE_TERMINAL_MAX_LINES }),
			omittedLines: Type.Optional(Type.Integer({ minimum: 0 })),
		},
		closed,
	),
]);
export type UiPatchOp = Static<typeof UiPatchOpSchema>;

/** The operations of one patch, applied in order. */
export const UiPatchSchema = Type.Array(UiPatchOpSchema, { minItems: 1 });
export type UiPatch = Static<typeof UiPatchSchema>;

type AppendLinesOp = Extract<UiPatchOp, { op: "append_lines" }>;
type InsertOp = Extract<UiPatchOp, { op: "insert" }>;

/** A patch that does not apply to the tree it was given. */
export class UiPatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UiPatchError";
	}
}

// ============================================================================
// Apply
// ============================================================================

/**
 * The tree after `ops`, applied in order. Pure: the input tree is not changed
 * and unchanged subtrees are shared. Throws {@link UiPatchError} when an
 * operation does not apply: a key names no child or more than one, the node
 * at a path cannot take the operation, or appended output exceeds the
 * terminal bound.
 */
export function applyUiPatch(tree: readonly UiNode[], ops: readonly UiPatchOp[]): UiNode[] {
	let roots: UiNode[] = [...tree];
	for (const op of ops) roots = applyOp(roots, op);
	return roots;
}

function applyOp(roots: readonly UiNode[], op: UiPatchOp): UiNode[] {
	if (op.path.length === 0) {
		switch (op.op) {
			case "replace":
				return [op.node];
			case "remove":
				return [];
			case "insert":
				return insertInto(roots, op);
			case "append_lines":
				throw new UiPatchError("append_lines needs a terminal node's path");
		}
	}
	return editChildren(roots, op, 0);
}

/** Apply `op` within `children`, where `op.path[index]` keys one of them. */
function editChildren(children: readonly UiNode[], op: UiPatchOp, index: number): UiNode[] {
	const at = keyedIndex(children, op.path[index] ?? "");
	const node = children[at] as UiNode;
	if (index < op.path.length - 1) return replaceAt(children, at, editNode(node, op, index + 1));
	switch (op.op) {
		case "replace":
			return replaceAt(children, at, op.node);
		case "remove":
			return [...children.slice(0, at), ...children.slice(at + 1)];
		case "insert":
			if (node.type !== "list") throw new UiPatchError(`${node.type} node at ${pathText(op.path)} takes no inserts`);
			return replaceAt(children, at, { ...node, items: insertInto(node.items, op) });
		case "append_lines":
			return replaceAt(children, at, appendLines(node, op));
	}
}

/** Apply `op` below `node`, where `op.path[index]` keys one of its children. */
function editNode(node: UiNode, op: UiPatchOp, index: number): UiNode {
	if (node.type === "list") return { ...node, items: editChildren(node.items, op, index) };
	if (node.type !== "card") throw new UiPatchError(`${node.type} node has no children at ${pathText(op.path)}`);
	const sections = node.sections ?? [];
	const at = keyedIndex(sections, op.path[index] ?? "");
	const section = sections[at] as UiCardSection;
	let children: UiNode[];
	if (index < op.path.length - 1) {
		children = editChildren(section.children, op, index + 1);
	} else if (op.op === "insert") {
		children = insertInto(section.children, op);
	} else {
		throw new UiPatchError(`a card section at ${pathText(op.path)} takes inserts only`);
	}
	return { ...node, sections: replaceAt(sections, at, { ...section, children }) };
}

function insertInto(children: readonly UiNode[], op: InsertOp): UiNode[] {
	const at = op.before === undefined ? children.length : keyedIndex(children, op.before);
	return [...children.slice(0, at), op.node, ...children.slice(at)];
}

function appendLines(node: UiNode, op: AppendLinesOp): UiTerminalNode {
	if (node.type !== "terminal") throw new UiPatchError(`${node.type} node at ${pathText(op.path)} has no lines`);
	const lines = [...node.lines, ...op.lines];
	if (op.omittedLines === undefined) {
		if (lines.length > UI_NODE_TERMINAL_MAX_LINES) throw new UiPatchError("appended lines exceed the terminal bound");
		return { ...node, lines };
	}
	const drop = op.omittedLines - (node.omittedLines ?? 0);
	if (drop < 0 || drop > lines.length) {
		throw new UiPatchError(`omittedLines ${op.omittedLines} does not follow ${node.omittedLines ?? 0}`);
	}
	const kept = lines.slice(drop);
	if (kept.length > UI_NODE_TERMINAL_MAX_LINES) throw new UiPatchError("appended lines exceed the terminal bound");
	return { ...node, lines: kept, omittedLines: op.omittedLines };
}

/** The index of the one item keyed `key`. */
function keyedIndex(items: readonly { readonly key?: string }[], key: string): number {
	let found = -1;
	for (let index = 0; index < items.length; index++) {
		if (items[index]?.key !== key) continue;
		if (found !== -1) throw new UiPatchError(`more than one child is keyed ${JSON.stringify(key)}`);
		found = index;
	}
	if (found === -1) throw new UiPatchError(`no child is keyed ${JSON.stringify(key)}`);
	return found;
}

function replaceAt<T>(items: readonly T[], at: number, item: T): T[] {
	const copy = [...items];
	copy[at] = item;
	return copy;
}

function pathText(path: readonly string[]): string {
	return JSON.stringify(path);
}

// ============================================================================
// Diff
// ============================================================================

const encoder = new TextEncoder();

function jsonBytes(value: unknown): number {
	return encoder.encode(JSON.stringify(value)).byteLength;
}

/**
 * Operations that turn `prev` into `next`: `applyUiPatch(prev, diffUiTree(prev,
 * next))` equals `next`, and equal trees give no operations. Children are
 * matched by key; a terminal that only gained lines becomes `append_lines`.
 * Where children are unkeyed or share a key, or a patch would be no smaller,
 * the nearest addressable node is replaced, or the whole tree. A patch is
 * never larger than replacing the whole tree.
 */
export function diffUiTree(prev: readonly UiNode[], next: readonly UiNode[]): UiPatchOp[] {
	if (jsonEqual(prev, next)) return [];
	const replacement = replaceTree(next);
	const ops: UiPatchOp[] = [];
	if (!diffChildren(prev, next, [], ops)) return replacement;
	return jsonBytes(ops) < jsonBytes(replacement) ? ops : replacement;
}

/** Operations that replace the whole tree with `next`. */
function replaceTree(next: readonly UiNode[]): UiPatchOp[] {
	const [first, ...rest] = next;
	if (first === undefined) return [{ op: "remove", path: [] }];
	return [
		{ op: "replace", path: [], node: first },
		...rest.map((node): UiPatchOp => ({ op: "insert", path: [], node })),
	];
}

/**
 * Add to `ops` the operations that turn the children at `path` from `prev`
 * into `next`, matching them by key. False, with nothing added, when a child
 * is unkeyed, a key repeats, or the children's paths would be too deep.
 */
function diffChildren(prev: readonly UiNode[], next: readonly UiNode[], path: string[], ops: UiPatchOp[]): boolean {
	if (jsonEqual(prev, next)) return true;
	if (path.length + 1 > UI_PATCH_PATH_MAX_KEYS) return false;
	const prevIndex = uniqueKeys(prev);
	const nextIndex = uniqueKeys(next);
	if (!prevIndex || !nextIndex) return false;

	// Children kept in place: the longest run of kept keys whose order did not change.
	const kept = next.flatMap((node) => {
		const at = prevIndex.get(node.key as string);
		return at === undefined ? [] : [at];
	});
	const inPlace = new Set(longestIncreasing(kept).map((at) => prev[at]?.key as string));

	for (const node of prev) {
		const key = node.key as string;
		if (!inPlace.has(key)) ops.push({ op: "remove", path: [...path, key] });
	}
	// Each child that is not in place goes before the next in-place child, or last.
	const anchors: (string | undefined)[] = [];
	let anchor: string | undefined;
	for (let index = next.length - 1; index >= 0; index--) {
		anchors[index] = anchor;
		const key = next[index]?.key as string;
		if (inPlace.has(key)) anchor = key;
	}
	next.forEach((node, index) => {
		const key = node.key as string;
		if (inPlace.has(key)) {
			diffNode(prev[prevIndex.get(key) as number] as UiNode, node, [...path, key], ops);
			return;
		}
		const before = anchors[index];
		ops.push({ op: "insert", path, ...(before === undefined ? {} : { before }), node });
	});
	return true;
}

/** Add to `ops` the operations that turn the node at `path` from `prev` into `next`. */
function diffNode(prev: UiNode, next: UiNode, path: string[], ops: UiPatchOp[]): void {
	if (jsonEqual(prev, next)) return;
	const replace: UiPatchOp = { op: "replace", path, node: next };
	const patch = patchNode(prev, next, path);
	ops.push(...(patch !== undefined && jsonBytes(patch) < jsonBytes([replace]) ? patch : [replace]));
}

/** Operations that change `prev` into `next` below `path`, when their children or lines can say it. */
function patchNode(prev: UiNode, next: UiNode, path: string[]): UiPatchOp[] | undefined {
	if (prev.type === "terminal" && next.type === "terminal") {
		const append = appendOf(prev, next, path);
		return append && [append];
	}
	if (prev.type === "list" && next.type === "list") {
		if (!jsonEqual({ ...prev, items: undefined }, { ...next, items: undefined })) return undefined;
		const ops: UiPatchOp[] = [];
		return diffChildren(prev.items, next.items, path, ops) ? ops : undefined;
	}
	if (prev.type === "card" && next.type === "card") return patchCard(prev, next, path);
	return undefined;
}

/** A card whose own fields and section keys and titles stay the same patches its sections' children. */
function patchCard(prev: UiCardNode, next: UiCardNode, path: string[]): UiPatchOp[] | undefined {
	if (!jsonEqual({ ...prev, sections: undefined }, { ...next, sections: undefined })) return undefined;
	const prevSections = prev.sections;
	const nextSections = next.sections;
	if (prevSections === undefined || nextSections === undefined || prevSections.length !== nextSections.length) {
		return undefined;
	}
	if (!uniqueKeys(prevSections)) return undefined;
	const ops: UiPatchOp[] = [];
	for (let index = 0; index < prevSections.length; index++) {
		const before = prevSections[index] as UiCardSection;
		const after = nextSections[index] as UiCardSection;
		if (!jsonEqual({ ...before, children: undefined }, { ...after, children: undefined })) return undefined;
		if (!diffChildren(before.children, after.children, [...path, before.key as string], ops)) return undefined;
	}
	return ops;
}

/** `append_lines` when `next` is `prev` with lines appended and possibly older lines counted as omitted. */
function appendOf(prev: UiTerminalNode, next: UiTerminalNode, path: string[]): UiPatchOp | undefined {
	const frame = (node: UiTerminalNode) => ({ ...node, lines: undefined, omittedLines: undefined });
	if (!jsonEqual(frame(prev), frame(next))) return undefined;
	if (next.omittedLines === undefined && prev.omittedLines !== undefined) return undefined;
	const drop = (next.omittedLines ?? 0) - (prev.omittedLines ?? 0);
	if (drop < 0 || drop > prev.lines.length) return undefined;
	const kept = prev.lines.length - drop;
	if (next.lines.length <= kept) return undefined;
	for (let index = 0; index < kept; index++) {
		if (!jsonEqual(prev.lines[drop + index], next.lines[index])) return undefined;
	}
	return {
		op: "append_lines",
		path,
		lines: next.lines.slice(kept),
		...(next.omittedLines === prev.omittedLines ? {} : { omittedLines: next.omittedLines }),
	};
}

/** Each item's index by key, or undefined when an item is unkeyed or a key repeats. */
function uniqueKeys(items: readonly { readonly key?: string }[]): Map<string, number> | undefined {
	const index = new Map<string, number>();
	for (let at = 0; at < items.length; at++) {
		const key = items[at]?.key;
		if (key === undefined || index.has(key)) return undefined;
		index.set(key, at);
	}
	return index;
}

/** One longest strictly increasing subsequence of `values`. */
function longestIncreasing(values: readonly number[]): number[] {
	// tails[k]: the position in `values` ending the smallest-tailed increasing run of length k + 1.
	const tails: number[] = [];
	const previous: number[] = [];
	values.forEach((value, position) => {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((values[tails[middle] as number] as number) < value) low = middle + 1;
			else high = middle;
		}
		previous[position] = low > 0 ? (tails[low - 1] as number) : -1;
		tails[low] = position;
	});
	const run: number[] = [];
	for (let position = tails.at(-1) ?? -1; position !== -1; position = previous[position] as number) {
		run.push(values[position] as number);
	}
	return run.reverse();
}

/** Equality of JSON data, where an undefined property equals an absent one. */
function jsonEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		return left.every((item, index) => jsonEqual(item, right[index]));
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
	const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
	return leftKeys.length === rightKeys.length && leftKeys.every((key) => jsonEqual(leftRecord[key], rightRecord[key]));
}
