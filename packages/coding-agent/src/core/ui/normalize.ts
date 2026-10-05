/**
 * Host normalization of `UiNode` data (RFC §8.3): what an extension or a
 * tool declares as UI becomes data every client can render. Normalizing
 *
 * - converts ANSI styling in styled-text fields to semantic tokens and strips
 *   terminal controls from every other text (`ansi-tokens.ts`);
 * - splits terminal output at line feeds, keeps its newest
 *   `UI_NODE_TERMINAL_MAX_LINES` lines (counting the rest in `omittedLines`),
 *   and cuts terminal and diff lines to `UI_NODE_LINE_MAX_CHARS`;
 * - validates the result against the `UiNode` schema, with keys unique among
 *   siblings, ids unique within their node, form patterns that are safe to
 *   test, and nesting at most {@link UI_MAX_DEPTH} levels deep;
 * - drops the actions its producer may not bind ({@link UiActionPolicy});
 * - and bounds the encoded size: callers pass the protocol's bound
 *   (`PANEL_MAX_SERIALIZED_BYTES`, `PRESENTATION_MAX_SERIALIZED_BYTES`, or
 *   `PRESENTATION_REMOTE_MAX_SERIALIZED_BYTES`).
 *
 * Data that is invalid or too large throws {@link UiNormalizeError} and never
 * reaches a client.
 */

import {
	EXTENSION_ID_PATTERN,
	UI_NODE_LINE_MAX_CHARS,
	UI_NODE_TERMINAL_MAX_LINES,
	UI_PATCH_PATH_MAX_KEYS,
	UiActionsNodeSchema,
	UiCodeNodeSchema,
	UiDiffNodeSchema,
	UiFormNodeSchema,
	UiImageNodeSchema,
	UiKeyValueNodeSchema,
	UiMarkdownNodeSchema,
	type UiNode,
	type UiNodeAction,
	type UiNodeIntent,
	UiNodeSchema,
	type UiNodeStyledText,
	UiNodeStyledTextSchema,
	UiProgressNodeSchema,
	UiTableNodeSchema,
	UiTerminalNodeSchema,
	UiTextNodeSchema,
	type UiTreeItem,
	UiTreeNodeSchema,
} from "@hansjm10/volt-protocol";
import type { TSchema } from "typebox";
import { Compile, type Validator } from "typebox/compile";
import { isSafeFormPattern } from "../host/live-state.ts";
import { ansiToStyledLines, ansiToStyledText, stripTerminalControls, type UiStyledLine } from "./ansi-tokens.ts";

/**
 * Deepest nesting, counted as patch paths count it: a root node is level 1,
 * and a list's items, a card's sections, and a section's children are one
 * level below their parent. Every node of a normalized tree is then within
 * reach of a patch path. Tree items nest at most as deep.
 */
export const UI_MAX_DEPTH = UI_PATCH_PATH_MAX_KEYS;
const EXTENSION_ID = new RegExp(EXTENSION_ID_PATTERN);
/** Input this many times over the byte bound is refused before it is converted. */
const INPUT_BUDGET_FACTOR = 8;

/**
 * Which intents a producer's actions and forms may send. Host code (built-in
 * tools, work detail) binds any intent. An extension binds only its own
 * commands and intents (`extension.command.<id>.*`, `extension.intent.<id>.*`)
 * and `open_work` or `cancel_work` for work it owns; other actions are dropped.
 * An extension id that does not match `EXTENSION_ID_PATTERN` binds nothing.
 */
export type UiActionPolicy =
	| { readonly owner: "host" }
	| {
			readonly owner: "extension";
			readonly extensionId: string;
			/** Whether work `workId` belongs to the extension. */
			readonly ownsWork: (workId: string) => boolean;
	  };

export interface UiNormalizeOptions {
	readonly policy: UiActionPolicy;
	/** Largest normalized data, in UTF-8 bytes of its JSON. */
	readonly maxBytes: number;
	/** Called for each action or form the policy dropped, with the intent it would have sent. */
	readonly onDroppedIntent?: (intent: UiNodeIntent) => void;
}

/** UI data that cannot be normalized: invalid, nested too deeply, or too large. */
export class UiNormalizeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UiNormalizeError";
	}
}

type JsonObject = Record<string, unknown>;

/** Compiled validators by node type, `node` for the whole schema, and `styledText`. */
const validators = new Map<string, Validator>();

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A JSON copy of `input`, refused when it is not JSON or far over the byte bound. */
function cloneJson(input: unknown, maxBytes: number): unknown {
	let json: string | undefined;
	try {
		json = JSON.stringify(input);
	} catch (error) {
		throw new UiNormalizeError(`UI data is not JSON: ${errorMessage(error)}`);
	}
	if (json === undefined) throw new UiNormalizeError("UI data is not JSON");
	if (json.length > maxBytes * INPUT_BUDGET_FACTOR) {
		throw new UiNormalizeError(`UI data exceeds the ${maxBytes}-byte bound`);
	}
	return JSON.parse(json);
}

function assertSize(value: unknown, maxBytes: number): void {
	const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
	if (bytes > maxBytes) throw new UiNormalizeError(`UI data is ${bytes} bytes, over the ${maxBytes}-byte bound`);
}

// ============================================================================
// Conversion: text fields of untrusted JSON, before validation
// ============================================================================

/**
 * At most `max` UTF-16 units, without splitting a surrogate pair; cut text
 * ends in "…", so a remote profile's redaction drops a root the cut split.
 */
function cutChars(text: string, max: number): string {
	if (text.length <= max) return text;
	const end = /[\ud800-\udbff]/.test(text.charAt(max - 2)) ? max - 2 : max - 1;
	return `${text.slice(0, end)}…`;
}

function styled(value: unknown): unknown {
	if (typeof value === "string") return ansiToStyledText(value);
	if (!Array.isArray(value)) return value;
	return value.map((span) =>
		isObject(span) && typeof span.text === "string" ? { ...span, text: stripTerminalControls(span.text) } : span,
	);
}

function plain(value: unknown): unknown {
	return typeof value === "string" ? stripTerminalControls(value) : value;
}

/** One line: controls stripped, line feeds as spaces, cut to the line bound. */
function plainLine(value: unknown): unknown {
	return typeof value === "string"
		? cutChars(stripTerminalControls(value).replace(/\n/g, " "), UI_NODE_LINE_MAX_CHARS)
		: value;
}

/** A styled line cut to the line bound across its spans; a cut line ends in "…". */
function cutLine(line: UiStyledLine): UiStyledLine {
	if (typeof line === "string") return cutChars(line, UI_NODE_LINE_MAX_CHARS);
	if (line.reduce((length, span) => length + span.text.length, 0) <= UI_NODE_LINE_MAX_CHARS) return line;
	const spans: Exclude<UiStyledLine, string> = [];
	let room = UI_NODE_LINE_MAX_CHARS - 1;
	for (const span of line) {
		if (room <= 0) break;
		const end =
			span.text.length <= room
				? span.text.length
				: /[\ud800-\udbff]/.test(span.text.charAt(room - 1))
					? room - 1
					: room;
		const text = span.text.slice(0, end);
		room -= text.length;
		if (text.length > 0) spans.push({ ...span, text });
	}
	const last = spans.at(-1);
	if (last) spans[spans.length - 1] = { ...last, text: `${last.text}…` };
	else spans.push({ text: "…" });
	return spans;
}

function convertField(record: JsonObject, field: string, convert: (value: unknown) => unknown): void {
	if (Object.hasOwn(record, field)) record[field] = convert(record[field]);
}

function eachObject(value: unknown, visit: (item: JsonObject) => void): void {
	if (!Array.isArray(value)) return;
	for (const item of value) if (isObject(item)) visit(item);
}

function convertTerminalLines(node: JsonObject): void {
	if (!Array.isArray(node.lines)) return;
	const lines: unknown[] = [];
	for (const line of node.lines) {
		if (typeof line === "string") lines.push(...ansiToStyledLines(line).map(cutLine));
		else if (Array.isArray(line)) {
			const spans = line.map((span) =>
				isObject(span) && typeof span.text === "string"
					? { ...span, text: stripTerminalControls(span.text).replace(/\n/g, " ") }
					: span,
			);
			lines.push(spans.every(isObject) ? cutLine(spans as Exclude<UiStyledLine, string>) : spans);
		} else lines.push(line);
	}
	const excess = lines.length - UI_NODE_TERMINAL_MAX_LINES;
	if (excess > 0) {
		lines.splice(0, excess);
		const omitted = node.omittedLines ?? 0;
		if (typeof omitted === "number") node.omittedLines = omitted + excess;
	}
	node.lines = lines;
}

function convertTreeItems(items: unknown, depth: number): void {
	if (depth > UI_MAX_DEPTH) throw new UiNormalizeError(`UI tree items nest deeper than ${UI_MAX_DEPTH} levels`);
	eachObject(items, (item) => {
		convertField(item, "label", styled);
		convertField(item, "description", styled);
		convertTreeItems(item.children, depth + 1);
	});
}

function convertActions(actions: unknown): void {
	eachObject(actions, (action) => convertField(action, "label", plain));
}

/** Convert the text fields of a node (in place) by its type; validation judges the rest. */
function convertNode(value: unknown, depth: number): void {
	if (depth > UI_MAX_DEPTH) throw new UiNormalizeError(`UI nodes nest deeper than ${UI_MAX_DEPTH} levels`);
	if (!isObject(value)) return;
	switch (value.type) {
		case "text":
			convertField(value, "text", styled);
			return;
		case "markdown":
			convertField(value, "markdown", plain);
			return;
		case "list":
			if (Array.isArray(value.items)) for (const item of value.items) convertNode(item, depth + 1);
			return;
		case "table":
			eachObject(value.columns, (column) => convertField(column, "header", styled));
			eachObject(value.rows, (row) => {
				if (Array.isArray(row.cells)) row.cells = row.cells.map(styled);
			});
			convertField(value, "emptyText", styled);
			return;
		case "keyValue":
			eachObject(value.items, (item) => {
				convertField(item, "label", styled);
				convertField(item, "value", styled);
			});
			return;
		case "progress":
			convertField(value, "label", styled);
			convertField(value, "title", styled);
			eachObject(value.steps, (step) => {
				convertField(step, "label", styled);
				convertField(step, "detail", styled);
			});
			return;
		case "form":
			convertField(value, "title", styled);
			convertField(value, "submitLabel", plain);
			convertField(value, "cancelLabel", plain);
			eachObject(value.fields, (field) => {
				convertField(field, "label", plain);
				convertField(field, "description", styled);
				convertField(field, "placeholder", plain);
				// Clients show string and enum values as typed text.
				convertField(field, "value", plain);
				eachObject(field.options, (option) => {
					convertField(option, "value", plain);
					convertField(option, "label", plain);
					convertField(option, "description", plain);
				});
			});
			return;
		case "actions":
			convertActions(value.actions);
			return;
		case "card":
			convertField(value, "title", styled);
			eachObject(value.badges, (badge) => convertField(badge, "label", plain));
			eachObject(value.sections, (section) => {
				convertField(section, "title", styled);
				if (Array.isArray(section.children)) for (const child of section.children) convertNode(child, depth + 2);
			});
			convertActions(value.actions);
			return;
		case "diff":
			convertField(value, "path", plain);
			eachObject(value.lines, (line) => convertField(line, "text", plainLine));
			return;
		case "terminal":
			convertField(value, "title", styled);
			convertTerminalLines(value);
			return;
		case "code":
			convertField(value, "title", styled);
			convertField(value, "code", plain);
			return;
		case "image":
			convertField(value, "alt", plain);
			return;
		case "tree":
			convertTreeItems(value.items, depth + 1);
			return;
		default:
			return;
	}
}

// ============================================================================
// Checks the schema cannot express
// ============================================================================

/** Throw when two of `items` share an explicit key. */
function uniqueKeys(items: readonly { readonly key?: string }[], path: string): void {
	const seen = new Set<string>();
	for (const { key } of items) {
		if (key === undefined) continue;
		if (seen.has(key)) throw new UiNormalizeError(`Duplicate key "${key}" at ${path}`);
		seen.add(key);
	}
}

/** Throw when two of `items` share an id. */
function uniqueIds(items: readonly { readonly id: string }[], what: string, path: string): void {
	const seen = new Set<string>();
	for (const { id } of items) {
		if (seen.has(id)) throw new UiNormalizeError(`Duplicate ${what} id "${id}" at ${path}`);
		seen.add(id);
	}
}

/** Tree item ids are unique across the whole tree. */
function treeItems(items: readonly UiTreeItem[]): UiTreeItem[] {
	return items.flatMap((item) => [item, ...treeItems(item.children ?? [])]);
}

function checkNodes(nodes: readonly UiNode[], path: string): void {
	uniqueKeys(nodes, path || "/");
	for (const [index, node] of nodes.entries()) checkNode(node, `${path}/${index}`);
}

function checkNode(node: UiNode, path: string): void {
	switch (node.type) {
		case "list":
			checkNodes(node.items, `${path}/items`);
			return;
		case "card":
			uniqueKeys(node.sections ?? [], `${path}/sections`);
			for (const [index, section] of (node.sections ?? []).entries()) {
				checkNodes(section.children, `${path}/sections/${index}/children`);
			}
			uniqueIds(node.actions ?? [], "action", `${path}/actions`);
			return;
		case "table":
			uniqueKeys(node.rows, `${path}/rows`);
			return;
		case "keyValue":
			uniqueKeys(node.items, `${path}/items`);
			return;
		case "progress":
			if (node.kind === "steps") uniqueKeys(node.steps, `${path}/steps`);
			return;
		case "actions":
			uniqueIds(node.actions, "action", `${path}/actions`);
			return;
		case "form":
			uniqueIds(node.fields, "field", `${path}/fields`);
			for (const field of node.fields) {
				if (field.kind === "string" && field.pattern !== undefined && !isSafeFormPattern(field.pattern)) {
					throw new UiNormalizeError(`Form field "${field.id}" at ${path} has a pattern that is not safe to test`);
				}
			}
			return;
		case "tree":
			uniqueIds(treeItems(node.items), "tree item", `${path}/items`);
			return;
		default:
			return;
	}
}

// ============================================================================
// Action policy
// ============================================================================

/** Whether `policy` lets a producer bind `intent` to an action or form. */
export function isAllowedUiIntent(intent: UiNodeIntent, policy: UiActionPolicy): boolean {
	if (policy.owner === "host") return true;
	const { extensionId } = policy;
	if (!EXTENSION_ID.test(extensionId)) return false;
	for (const prefix of [`extension.command.${extensionId}.`, `extension.intent.${extensionId}.`]) {
		if (intent.type.startsWith(prefix) && intent.type.length > prefix.length) return true;
	}
	if (intent.type !== "open_work" && intent.type !== "cancel_work") return false;
	const workId = intent.input?.workId;
	return typeof workId === "string" && policy.ownsWork(workId);
}

class PolicyFilter {
	private readonly policy: UiActionPolicy;
	private readonly onDropped: ((intent: UiNodeIntent) => void) | undefined;

	constructor(options: UiNormalizeOptions) {
		this.policy = options.policy;
		this.onDropped = options.onDroppedIntent;
	}

	private allows(intent: UiNodeIntent): boolean {
		if (isAllowedUiIntent(intent, this.policy)) return true;
		this.onDropped?.(intent);
		return false;
	}

	private actions(actions: readonly UiNodeAction[]): UiNodeAction[] {
		return actions.filter((action) => this.allows(action.intent));
	}

	nodes(nodes: readonly UiNode[]): UiNode[] {
		return nodes.flatMap((node) => {
			const kept = this.node(node);
			return kept === undefined ? [] : [kept];
		});
	}

	node(node: UiNode): UiNode | undefined {
		switch (node.type) {
			case "list":
				return { ...node, items: this.nodes(node.items) };
			case "card": {
				const { actions, sections, ...card } = node;
				const kept = actions === undefined ? [] : this.actions(actions);
				return {
					...card,
					...(sections === undefined
						? {}
						: { sections: sections.map((section) => ({ ...section, children: this.nodes(section.children) })) }),
					...(kept.length === 0 ? {} : { actions: kept }),
				};
			}
			case "actions": {
				const kept = this.actions(node.actions);
				return kept.length === 0 ? undefined : { ...node, actions: kept };
			}
			case "form": {
				if (!this.allows(node.submit)) return undefined;
				if (node.cancel === undefined || this.allows(node.cancel)) return node;
				const { cancel: _cancel, cancelLabel: _cancelLabel, ...form } = node;
				return form;
			}
			default:
				return node;
		}
	}
}

// ============================================================================
// Entry points
// ============================================================================

/** Schemas of the node types without child nodes, for errors that name the field at fault. */
const LEAF_SCHEMAS: Readonly<Record<string, TSchema>> = {
	text: UiTextNodeSchema,
	markdown: UiMarkdownNodeSchema,
	table: UiTableNodeSchema,
	keyValue: UiKeyValueNodeSchema,
	progress: UiProgressNodeSchema,
	form: UiFormNodeSchema,
	actions: UiActionsNodeSchema,
	diff: UiDiffNodeSchema,
	terminal: UiTerminalNodeSchema,
	code: UiCodeNodeSchema,
	image: UiImageNodeSchema,
	tree: UiTreeNodeSchema,
};

function validator(type: string, schema: TSchema): Validator {
	let compiled = validators.get(type);
	if (compiled === undefined) {
		compiled = Compile(schema);
		validators.set(type, compiled);
	}
	return compiled;
}

/**
 * Validate a node against the `UiNode` schema: a leaf against its type's
 * schema, a list or card against the schema with its child nodes left out,
 * and each child node in turn.
 */
function validateNode(value: unknown, path: string): asserts value is UiNode {
	const at = path || "/";
	if (!isObject(value) || typeof value.type !== "string") {
		throw new UiNormalizeError(`Invalid UI node at ${at}: must be an object with a node type`);
	}
	const { type } = value;
	if (type === "list" || type === "card") {
		let own: JsonObject = value;
		if (type === "list" && Array.isArray(value.items)) {
			for (const [index, item] of value.items.entries()) validateNode(item, `${path}/items/${index}`);
			own = { ...value, items: [] };
		}
		if (type === "card" && Array.isArray(value.sections)) {
			for (const [index, section] of value.sections.entries()) {
				if (!isObject(section) || !Array.isArray(section.children)) continue;
				for (const [childIndex, child] of section.children.entries()) {
					validateNode(child, `${path}/sections/${index}/children/${childIndex}`);
				}
			}
			own = {
				...value,
				sections: value.sections.map((section) => (isObject(section) ? { ...section, children: [] } : section)),
			};
		}
		if (!validator("node", UiNodeSchema).Check(own)) {
			throw new UiNormalizeError(`Invalid UI node at ${at}: does not match the ${type} node schema`);
		}
		return;
	}
	const schema = LEAF_SCHEMAS[type];
	if (schema === undefined) throw new UiNormalizeError(`Invalid UI node at ${at}: unknown node type "${type}"`);
	const leaf = validator(type, schema);
	if (leaf.Check(value)) return;
	const [error] = leaf.Errors(value);
	throw new UiNormalizeError(
		`Invalid ${type} node at ${`${path}${error?.instancePath ?? ""}` || "/"}: ${error?.message ?? "does not match its schema"}`,
	);
}

/**
 * Normalize sibling nodes (a presentation's summary or body). Nodes the
 * policy removed whole are left out.
 */
export function normalizeUiNodes(input: unknown, options: UiNormalizeOptions): UiNode[] {
	if (!Array.isArray(input)) throw new UiNormalizeError("UI nodes must be an array");
	const data = cloneJson(input, options.maxBytes) as unknown[];
	for (const value of data) convertNode(value, 1);
	for (const [index, value] of data.entries()) validateNode(value, `/${index}`);
	const nodes = data as UiNode[];
	checkNodes(nodes, "");
	const kept = options.policy.owner === "host" ? nodes : new PolicyFilter(options).nodes(nodes);
	assertSize(kept, options.maxBytes);
	return kept;
}

/** Normalize one node (a panel or work detail); undefined when the policy removed it whole. */
export function normalizeUiNode(input: unknown, options: UiNormalizeOptions): UiNode | undefined {
	const data = cloneJson(input, options.maxBytes);
	convertNode(data, 1);
	validateNode(data, "");
	const node = data;
	checkNode(node, "");
	const kept = options.policy.owner === "host" ? node : new PolicyFilter(options).node(node);
	if (kept !== undefined) assertSize(kept, options.maxBytes);
	return kept;
}

/** Normalize styled text (a status item, notification, or title): ANSI styling to tokens, other controls stripped. */
export function normalizeStyledText(input: unknown, options: { readonly maxBytes: number }): UiNodeStyledText {
	const text = styled(cloneJson(input, options.maxBytes));
	if (!validator("styledText", UiNodeStyledTextSchema).Check(text)) {
		throw new UiNormalizeError("Styled text must be a string or an array of styled spans");
	}
	assertSize(text, options.maxBytes);
	return text as UiNodeStyledText;
}
