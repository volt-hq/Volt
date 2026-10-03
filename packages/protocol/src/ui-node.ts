/**
 * `UiNode`: declarative UI as data (RFC §8.3). Extensions, built-in tools,
 * and the host describe status items, panels, dialogs, tool and message
 * presentation, and work detail as `UiNode` trees; every client renders the
 * same data. The TUI and phone mappings live in their clients.
 *
 * Styling is semantic only: text names a token (`text`, `muted`, `accent`,
 * `success`, `warning`, `error`, `info`) plus emphasis. Text never carries
 * ANSI or other terminal control sequences; the host converts or strips them
 * before building a node. Every node and repeated item accepts an optional
 * `key` so live-lane updates can patch a tree by key instead of resending it.
 *
 * Interactive nodes bind to intents by intent type and input. Pressing an
 * action sends its intent. Submitting a form sends the form's `submit` intent
 * with the field values merged over its `input`, keyed by field id.
 */

import { type Static, Type } from "typebox";
import { type Assert, type MutualExtends, stringEnum } from "./helpers.ts";

const closed = { additionalProperties: false } as const;

/** Longest node or item key, in characters. */
export const UI_NODE_KEY_MAX_CHARS = 256;
/** Longest intent type, action id, form field id, or tree item id, in characters. */
export const UI_NODE_ID_MAX_CHARS = 160;
/** Most output lines one terminal node carries; older lines are counted in `omittedLines`. */
export const UI_NODE_TERMINAL_MAX_LINES = 2_000;
/** Longest terminal or diff line, in characters. */
export const UI_NODE_LINE_MAX_CHARS = 4_096;
/** Longest inline base64 image payload, in characters. */
export const UI_NODE_IMAGE_DATA_MAX_CHARS = 1024 * 1024;

/** Text: any characters except C0/C1 controls other than tab and line feed. Rejects ESC and CSI, so no ANSI. */
const UI_TEXT_PATTERN = "^[^\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]*$";
/** One line: as text, without line feeds. */
const UI_LINE_PATTERN = "^[^\\u0000-\\u0008\\u000a-\\u001f\\u007f-\\u009f]*$";

// ============================================================================
// Text and styling
// ============================================================================

export const UiNodeTokenSchema = stringEnum(["text", "muted", "accent", "success", "warning", "error", "info"]);
export type UiNodeToken = Static<typeof UiNodeTokenSchema>;

export const UiNodeTextSchema = Type.String({
	pattern: UI_TEXT_PATTERN,
	"x-volt-expected": "be text without terminal control sequences",
});

export const UiNodeLineSchema = Type.String({
	maxLength: UI_NODE_LINE_MAX_CHARS,
	pattern: UI_LINE_PATTERN,
	"x-volt-expected": "be one line without terminal control sequences",
});

const emphasis = {
	token: Type.Optional(UiNodeTokenSchema),
	bold: Type.Optional(Type.Boolean()),
	italic: Type.Optional(Type.Boolean()),
	underline: Type.Optional(Type.Boolean()),
	code: Type.Optional(Type.Boolean()),
};

/** A run of text with one semantic token and optional emphasis. */
export const UiNodeStyledSpanSchema = Type.Object({ text: UiNodeTextSchema, ...emphasis }, closed);

/** Plain text, or a sequence of styled spans. */
export const UiNodeStyledTextSchema = Type.Union([UiNodeTextSchema, Type.Array(UiNodeStyledSpanSchema)]);
export type UiNodeStyledText = Static<typeof UiNodeStyledTextSchema>;

/** One output line, plain or styled. */
export const UiNodeStyledLineSchema = Type.Union([
	UiNodeLineSchema,
	Type.Array(Type.Object({ text: UiNodeLineSchema, ...emphasis }, closed)),
]);

export const UiNodeKeySchema = Type.String({ minLength: 1, maxLength: UI_NODE_KEY_MAX_CHARS });

const identifier = Type.String({
	minLength: 1,
	maxLength: UI_NODE_ID_MAX_CHARS,
	pattern: "^[^\\s\\u0000-\\u001f\\u007f]+$",
});
const key = Type.Optional(UiNodeKeySchema);

// ============================================================================
// Intents and actions
// ============================================================================

/** An intent to send: its type and the input the host validates against that intent's schema. */
export const UiNodeIntentSchema = Type.Object(
	{
		type: identifier,
		input: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	closed,
);
export type UiNodeIntent = Static<typeof UiNodeIntentSchema>;

export const UiNodeActionSchema = Type.Object(
	{
		id: identifier,
		label: UiNodeTextSchema,
		token: Type.Optional(UiNodeTokenSchema),
		disabled: Type.Optional(Type.Boolean()),
		destructive: Type.Optional(Type.Boolean()),
		intent: UiNodeIntentSchema,
	},
	closed,
);
export type UiNodeAction = Static<typeof UiNodeActionSchema>;

// ============================================================================
// Forms
// ============================================================================

const fieldBase = {
	id: identifier,
	label: UiNodeTextSchema,
	description: Type.Optional(UiNodeStyledTextSchema),
};

export const UiNodeFormFieldSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("string"),
			...fieldBase,
			value: Type.Optional(Type.String()),
			placeholder: Type.Optional(UiNodeTextSchema),
			required: Type.Optional(Type.Boolean()),
			minLength: Type.Optional(Type.Integer({ minimum: 0 })),
			maxLength: Type.Optional(Type.Integer({ minimum: 0 })),
			/** ECMAScript pattern the whole value must match. */
			pattern: Type.Optional(Type.String()),
			multiline: Type.Optional(Type.Boolean()),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("boolean"),
			...fieldBase,
			value: Type.Optional(Type.Boolean()),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("enum"),
			...fieldBase,
			options: Type.Array(
				Type.Object(
					{
						value: Type.String(),
						label: Type.Optional(UiNodeTextSchema),
						description: Type.Optional(UiNodeTextSchema),
					},
					closed,
				),
				{ minItems: 1 },
			),
			value: Type.Optional(Type.String()),
			required: Type.Optional(Type.Boolean()),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("integer"),
			...fieldBase,
			value: Type.Optional(Type.Integer()),
			min: Type.Optional(Type.Integer()),
			max: Type.Optional(Type.Integer()),
			required: Type.Optional(Type.Boolean()),
		},
		closed,
	),
]);
export type UiNodeFormField = Static<typeof UiNodeFormFieldSchema>;

// ============================================================================
// Leaf nodes
// ============================================================================

export const UiTextNodeSchema = Type.Object(
	{ type: Type.Literal("text"), key, text: UiNodeStyledTextSchema, token: Type.Optional(UiNodeTokenSchema) },
	closed,
);

export const UiMarkdownNodeSchema = Type.Object(
	{ type: Type.Literal("markdown"), key, markdown: UiNodeTextSchema },
	closed,
);

export const UiTableNodeSchema = Type.Object(
	{
		type: Type.Literal("table"),
		key,
		columns: Type.Array(
			Type.Object({ header: UiNodeStyledTextSchema, align: Type.Optional(stringEnum(["left", "right"])) }, closed),
			{ minItems: 1 },
		),
		rows: Type.Array(Type.Object({ key, cells: Type.Array(UiNodeStyledTextSchema) }, closed)),
		emptyText: Type.Optional(UiNodeStyledTextSchema),
	},
	closed,
);

export const UiKeyValueNodeSchema = Type.Object(
	{
		type: Type.Literal("keyValue"),
		key,
		items: Type.Array(Type.Object({ key, label: UiNodeStyledTextSchema, value: UiNodeStyledTextSchema }, closed)),
	},
	closed,
);

/** Determinate progress (`value` of `max`, default 1) or a list of steps. */
export const UiProgressNodeSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("progress"),
			key,
			kind: Type.Literal("determinate"),
			value: Type.Number({ minimum: 0 }),
			max: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
			label: Type.Optional(UiNodeStyledTextSchema),
			token: Type.Optional(UiNodeTokenSchema),
		},
		closed,
	),
	Type.Object(
		{
			type: Type.Literal("progress"),
			key,
			kind: Type.Literal("steps"),
			title: Type.Optional(UiNodeStyledTextSchema),
			steps: Type.Array(
				Type.Object(
					{
						key,
						label: UiNodeStyledTextSchema,
						status: stringEnum(["pending", "active", "done", "failed", "skipped"]),
						detail: Type.Optional(UiNodeStyledTextSchema),
					},
					closed,
				),
			),
		},
		closed,
	),
]);

export const UiFormNodeSchema = Type.Object(
	{
		type: Type.Literal("form"),
		key,
		title: Type.Optional(UiNodeStyledTextSchema),
		fields: Type.Array(UiNodeFormFieldSchema, { minItems: 1 }),
		submit: UiNodeIntentSchema,
		submitLabel: Type.Optional(UiNodeTextSchema),
		cancel: Type.Optional(UiNodeIntentSchema),
		cancelLabel: Type.Optional(UiNodeTextSchema),
	},
	closed,
);

export const UiActionsNodeSchema = Type.Object(
	{ type: Type.Literal("actions"), key, actions: Type.Array(UiNodeActionSchema, { minItems: 1 }) },
	closed,
);

export const UiDiffNodeSchema = Type.Object(
	{
		type: Type.Literal("diff"),
		key,
		path: Type.Optional(UiNodeTextSchema),
		lines: Type.Array(
			Type.Object(
				{
					kind: stringEnum(["context", "add", "remove", "hunk", "meta"]),
					text: UiNodeLineSchema,
					oldLine: Type.Optional(Type.Integer({ minimum: 1 })),
					newLine: Type.Optional(Type.Integer({ minimum: 1 })),
				},
				closed,
			),
		),
		lineNumbers: Type.Optional(Type.Boolean()),
	},
	closed,
);

/** Bounded command output: the newest lines, with older ones counted in `omittedLines`. */
export const UiTerminalNodeSchema = Type.Object(
	{
		type: Type.Literal("terminal"),
		key,
		title: Type.Optional(UiNodeStyledTextSchema),
		lines: Type.Array(UiNodeStyledLineSchema, { maxItems: UI_NODE_TERMINAL_MAX_LINES }),
		omittedLines: Type.Optional(Type.Integer({ minimum: 0 })),
	},
	closed,
);

export const UiCodeNodeSchema = Type.Object(
	{
		type: Type.Literal("code"),
		key,
		title: Type.Optional(UiNodeStyledTextSchema),
		language: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9_+#.-]+$" })),
		code: UiNodeTextSchema,
	},
	closed,
);

export const UiImageNodeSchema = Type.Object(
	{
		type: Type.Literal("image"),
		key,
		mimeType: stringEnum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
		/** Base64-encoded image bytes. */
		data: Type.String({ maxLength: UI_NODE_IMAGE_DATA_MAX_CHARS, pattern: "^[A-Za-z0-9+/]*={0,2}$" }),
		alt: Type.Optional(UiNodeTextSchema),
	},
	closed,
);

export type UiTextNode = Static<typeof UiTextNodeSchema>;
export type UiMarkdownNode = Static<typeof UiMarkdownNodeSchema>;
export type UiTableNode = Static<typeof UiTableNodeSchema>;
export type UiKeyValueNode = Static<typeof UiKeyValueNodeSchema>;
export type UiProgressNode = Static<typeof UiProgressNodeSchema>;
export type UiFormNode = Static<typeof UiFormNodeSchema>;
export type UiActionsNode = Static<typeof UiActionsNodeSchema>;
export type UiDiffNode = Static<typeof UiDiffNodeSchema>;
export type UiTerminalNode = Static<typeof UiTerminalNodeSchema>;
export type UiCodeNode = Static<typeof UiCodeNodeSchema>;
export type UiImageNode = Static<typeof UiImageNodeSchema>;

// ============================================================================
// Recursive nodes
// ============================================================================

/** One tree item. Recursive, so hand-written; `UiTreeItemSchema` is pinned to it below. */
export interface UiTreeItem {
	id: string;
	label: UiNodeStyledText;
	description?: UiNodeStyledText;
	children?: UiTreeItem[];
}

const uiTreeItemCyclic = Type.Cyclic(
	{
		UiTreeItem: Type.Object(
			{
				id: identifier,
				label: UiNodeStyledTextSchema,
				description: Type.Optional(UiNodeStyledTextSchema),
				children: Type.Optional(Type.Array(Type.Ref("UiTreeItem"))),
			},
			closed,
		),
	},
	"UiTreeItem",
);
export const UiTreeItemSchema = Type.Unsafe<UiTreeItem>(uiTreeItemCyclic);
type _uiTreeItem = Assert<MutualExtends<Static<typeof uiTreeItemCyclic>, UiTreeItem>>;

export const UiTreeNodeSchema = Type.Object(
	{
		type: Type.Literal("tree"),
		key,
		items: Type.Array(UiTreeItemSchema),
		/** Ids of the items shown expanded. */
		expanded: Type.Optional(Type.Array(identifier)),
	},
	closed,
);
export type UiTreeNode = Static<typeof UiTreeNodeSchema>;

export interface UiListNode {
	type: "list";
	key?: string;
	ordered?: boolean;
	items: UiNode[];
}

export interface UiCardBadge {
	label: string;
	token?: UiNodeToken;
}

export interface UiCardSection {
	key?: string;
	title?: UiNodeStyledText;
	children: UiNode[];
}

export interface UiCardNode {
	type: "card";
	key?: string;
	title: UiNodeStyledText;
	token?: UiNodeToken;
	badges?: UiCardBadge[];
	sections?: UiCardSection[];
	actions?: UiNodeAction[];
}

/** Any UI node. */
export type UiNode =
	| UiTextNode
	| UiMarkdownNode
	| UiListNode
	| UiTableNode
	| UiKeyValueNode
	| UiProgressNode
	| UiFormNode
	| UiActionsNode
	| UiCardNode
	| UiDiffNode
	| UiTerminalNode
	| UiCodeNode
	| UiImageNode
	| UiTreeNode;

const uiNodeCyclic = Type.Cyclic(
	{
		UiNode: Type.Union([
			UiTextNodeSchema,
			UiMarkdownNodeSchema,
			Type.Object(
				{
					type: Type.Literal("list"),
					key,
					ordered: Type.Optional(Type.Boolean()),
					items: Type.Array(Type.Ref("UiNode")),
				},
				closed,
			),
			UiTableNodeSchema,
			UiKeyValueNodeSchema,
			UiProgressNodeSchema,
			UiFormNodeSchema,
			UiActionsNodeSchema,
			Type.Object(
				{
					type: Type.Literal("card"),
					key,
					title: UiNodeStyledTextSchema,
					token: Type.Optional(UiNodeTokenSchema),
					badges: Type.Optional(
						Type.Array(Type.Object({ label: UiNodeTextSchema, token: Type.Optional(UiNodeTokenSchema) }, closed)),
					),
					sections: Type.Optional(
						Type.Array(
							Type.Object(
								{
									key,
									title: Type.Optional(UiNodeStyledTextSchema),
									children: Type.Array(Type.Ref("UiNode")),
								},
								closed,
							),
						),
					),
					actions: Type.Optional(Type.Array(UiNodeActionSchema)),
				},
				closed,
			),
			UiDiffNodeSchema,
			UiTerminalNodeSchema,
			UiCodeNodeSchema,
			UiImageNodeSchema,
			UiTreeNodeSchema,
		]),
	},
	"UiNode",
);
/** Any UI node. Recursive through list items and card sections, so pinned to the hand-written `UiNode`. */
export const UiNodeSchema = Type.Unsafe<UiNode>(uiNodeCyclic);
type _uiNode = Assert<MutualExtends<Static<typeof uiNodeCyclic>, UiNode>>;

/** The `x-volt-limits` block for UiNode bounds. */
export const UI_NODE_LIMITS = {
	keyMaxChars: UI_NODE_KEY_MAX_CHARS,
	idMaxChars: UI_NODE_ID_MAX_CHARS,
	terminalMaxLines: UI_NODE_TERMINAL_MAX_LINES,
	lineMaxChars: UI_NODE_LINE_MAX_CHARS,
	imageDataMaxChars: UI_NODE_IMAGE_DATA_MAX_CHARS,
} as const;
