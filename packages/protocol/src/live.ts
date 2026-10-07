/**
 * The live lane (RFC §6.1): ephemeral state carried by `live{subscriptionId,
 * basedOn, seq, reset?, items}` frames.
 *
 * Streaming items (assistant start/delta/end, the presentations of the tool
 * calls it streams, and tool progress) are scoped by `basedOn`, the ordinal
 * they build on: a client discards them when a frame
 * arrives with a different `basedOn`, or when it applies the entry that
 * commits them (the assistant message, the tool result). Keyed state (`set`
 * and `clear`) persists until the host clears it, replaces it, or resets the
 * lane, so a commit never drops a pending dialog. A frame with `reset: true`
 * replaces the client's whole live state; `seq` restarts at 1 with every reset
 * and a gap in `seq` means the client must resubscribe after its position.
 *
 * Keys name a value family and, for keyed families, an id:
 * `phase`, `git`, `prompt_cache`, `usage`, `intents`, `presence`, `ext_title`, `bash`, or
 * `host_request/<requestId>`, `ext_status/<extension>/<name>`,
 * `ext_panel/<extension>/<name>`, `work/<workId>`. A value's `kind` is its
 * key's family, and an extension's status items and panels are keyed by its
 * manifest id. A `patch` item updates the node of an `ext_panel`, `work`, or
 * `bash` value in place (ui-patch.ts); a client that cannot apply it
 * resubscribes after its position.
 *
 * Host requests (dialogs, forms, approvals, MCP authorization, the
 * request_user_input tool's questions) are live values until answered; any
 * client that accepts the request's kind may answer with a `host_response`
 * frame, and the first answer wins.
 */

import {
	AssistantMessageSchema,
	ImageContentSchema,
	TextContentSchema,
	ToolCallSchema,
} from "@hansjm10/volt-ai/schemas";
import { type Static, Type } from "typebox";
import { LogEntryIdSchema } from "./entries.ts";
import { ExtensionIdSchema, RESERVED_EXTENSION_IDS } from "./extensions.ts";
import { RpcGitContextSchema } from "./git-context.ts";
import { stringEnum } from "./helpers.ts";
import { IntentAvailabilitySchema } from "./intents.ts";
import { ToolPresentationPatchSchema, ToolPresentationSchema } from "./presentation.ts";
import { RpcConversationIdentifierSchema } from "./primitives.ts";
import {
	RpcActiveAgentRunSchema,
	RpcActiveCompactionSchema,
	RpcActiveRetrySchema,
	RpcPromptCacheStatusSchema,
} from "./session.ts";
import {
	UI_NODE_LINE_PATTERN,
	UiNodeActionSchema,
	UiNodeFormFieldSchema,
	UiNodeSchema,
	UiNodeStyledTextSchema,
	UiNodeTextSchema,
	UiNodeTokenSchema,
	UiTerminalNodeSchema,
} from "./ui-node.ts";
import { UiPatchSchema } from "./ui-patch.ts";
import { WorkProgressSchema } from "./work.ts";

const closed = { additionalProperties: false } as const;

const timeoutMs = Type.Optional(Type.Integer({ minimum: 0 }));

// ============================================================================
// Host requests
// ============================================================================

export const HOST_REQUEST_KINDS = [
	"select",
	"confirm",
	"input",
	"editor",
	"form",
	"dialog",
	"approval",
	"mcp_auth",
	"provider_auth",
	"editor_text",
	"user_input",
] as const;

/** The kinds of host request a client may accept in `hello.accepts.hostRequests`. */
export const HostRequestKindSchema = stringEnum(HOST_REQUEST_KINDS);
export type HostRequestKind = Static<typeof HostRequestKindSchema>;

/** A dialog button: answering with its id. */
export const HostDialogActionSchema = Type.Object(
	{
		id: UiNodeActionSchema.properties.id,
		label: UiNodeTextSchema,
		token: Type.Optional(UiNodeTokenSchema),
		destructive: Type.Optional(Type.Boolean()),
	},
	closed,
);

/** One choice of a request_user_input question. */
export const UserInputOptionSchema = Type.Object(
	{
		label: Type.String({ minLength: 1, maxLength: 100, pattern: UI_NODE_LINE_PATTERN }),
		description: Type.String({ minLength: 1, maxLength: 300, pattern: UI_NODE_LINE_PATTERN }),
	},
	closed,
);

/**
 * One question of the request_user_input tool: a short `header`, the
 * `question`, and its choices. The client also offers a free-form answer and
 * skipping; `id` keys the answer.
 */
export const UserInputQuestionSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-z][a-z0-9_]*$", maxLength: 64 }),
		header: Type.String({ minLength: 1, maxLength: 24, pattern: UI_NODE_LINE_PATTERN }),
		question: Type.String({ minLength: 1, maxLength: 500, pattern: UI_NODE_LINE_PATTERN }),
		options: Type.Array(UserInputOptionSchema, { minItems: 2, maxItems: 3 }),
	},
	closed,
);

/**
 * The answer to one question: a choice's label, optionally followed by the
 * user's notes on it, or the user's own answer.
 */
export const UserInputAnswerSchema = Type.Object(
	{ answers: Type.Array(Type.String(), { minItems: 1, maxItems: 2 }) },
	closed,
);

const HostSelectRequestSchema = Type.Object(
	{
		kind: Type.Literal("select"),
		title: Type.String(),
		options: Type.Array(Type.String(), { minItems: 1 }),
		timeoutMs,
	},
	closed,
);
const HostConfirmRequestSchema = Type.Object(
	{ kind: Type.Literal("confirm"), title: Type.String(), message: Type.String(), timeoutMs },
	closed,
);
/** With `secret`, the client masks what the user types and keeps it out of any history; the host asks only one client. */
const HostInputRequestSchema = Type.Object(
	{
		kind: Type.Literal("input"),
		title: Type.String(),
		placeholder: Type.Optional(Type.String()),
		secret: Type.Optional(Type.Boolean()),
		timeoutMs,
	},
	closed,
);

/** A host request that asks the user a question in words: `select`, `confirm`, or `input`. */
export const HostPromptRequestSchema = Type.Union([
	HostSelectRequestSchema,
	HostConfirmRequestSchema,
	HostInputRequestSchema,
]);
export type HostPromptRequest = Static<typeof HostPromptRequestSchema>;

/**
 * A question the host asks a client. Answers: `select`, `input`, and `editor`
 * take `{value}`; `confirm` takes `{confirmed}`; `form` takes `{values}`;
 * `dialog` takes `{value}` with an action id; `approval` takes `{decision}`;
 * `provider_auth` takes `{value}` only for its `manual` flow; `editor_text`
 * takes `{value}` with the client's editor text; `user_input` takes
 * `{status: "answered", answers}` with an answer to every question by its id,
 * or `{status: "skipped", answers: {}}`; every kind may be answered
 * `{cancelled}`.
 */
export const HostRequestSchema = Type.Union([
	HostSelectRequestSchema,
	HostConfirmRequestSchema,
	HostInputRequestSchema,
	Type.Object({ kind: Type.Literal("editor"), title: Type.String(), prefill: Type.Optional(Type.String()) }, closed),
	Type.Object(
		{
			kind: Type.Literal("form"),
			title: Type.String(),
			fields: Type.Array(UiNodeFormFieldSchema, { minItems: 1 }),
			timeoutMs,
		},
		closed,
	),
	/** UI data and the buttons that answer it. */
	Type.Object(
		{
			kind: Type.Literal("dialog"),
			title: UiNodeTextSchema,
			body: Type.Array(UiNodeSchema),
			actions: Type.Array(HostDialogActionSchema, { minItems: 1 }),
			timeoutMs,
		},
		closed,
	),
	/** A host action (a command, a push) waiting for the user's approval; `requestId` is its `host_action` work id. */
	Type.Object(
		{
			kind: Type.Literal("approval"),
			action: Type.String(),
			title: Type.String(),
			message: Type.Optional(Type.String()),
			confirmLabel: Type.Optional(Type.String()),
			cancelLabel: Type.Optional(Type.String()),
			commandPreview: Type.Optional(Type.String()),
			blocking: Type.Optional(Type.Boolean()),
			destructive: Type.Optional(Type.Boolean()),
			metadata: Type.Optional(
				Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()])),
			),
			timeoutMs,
		},
		closed,
	),
	/** An MCP server's OAuth flow waiting for the user: open the URL or enter the code. */
	Type.Object(
		{
			kind: Type.Literal("mcp_auth"),
			server: Type.String(),
			flow: stringEnum(["browser", "device"]),
			authorizationUrl: Type.Optional(Type.String()),
			redirectUrl: Type.Optional(Type.String()),
			verificationUri: Type.Optional(Type.String()),
			verificationUriComplete: Type.Optional(Type.String()),
			userCode: Type.Optional(Type.String()),
			expiresAt: Type.Optional(Type.String()),
			intervalMs: Type.Optional(Type.Integer({ minimum: 0 })),
			message: Type.Optional(Type.String()),
		},
		closed,
	),
	/**
	 * A provider sign-in waiting for the user, asked only of the client that
	 * started it: `browser` (open `url` and sign in), `device` (enter
	 * `userCode` at `url`), or `manual` (open `url`, then paste the redirect URL
	 * or code it shows as the answer, unless the host receives it first). The
	 * host ends the request when the sign-in ends; cancelling it cancels the
	 * sign-in.
	 */
	Type.Object(
		{
			kind: Type.Literal("provider_auth"),
			provider: Type.String(),
			flow: stringEnum(["browser", "device", "manual"]),
			url: Type.Optional(Type.String()),
			userCode: Type.Optional(Type.String()),
			instructions: Type.Optional(Type.String()),
		},
		closed,
	),
	/** The text in the client's editor, which the client answers without asking the user. */
	Type.Object({ kind: Type.Literal("editor_text"), timeoutMs }, closed),
	/** The request_user_input tool's preference questions; an answer grants no tool or execution authority. */
	Type.Object(
		{
			kind: Type.Literal("user_input"),
			questions: Type.Array(UserInputQuestionSchema, { minItems: 1, maxItems: 3 }),
		},
		closed,
	),
]);
export type HostRequest = Static<typeof HostRequestSchema>;

/** A client's answer to a host request. */
export const HostResponseSchema = Type.Union([
	Type.Object({ value: Type.String() }, closed),
	Type.Object({ confirmed: Type.Boolean() }, closed),
	Type.Object(
		{ values: Type.Record(Type.String(), Type.Union([Type.String(), Type.Boolean(), Type.Integer()])) },
		closed,
	),
	Type.Object(
		{ decision: stringEnum(["approved", "denied", "dismissed"]), message: Type.Optional(Type.String()) },
		closed,
	),
	Type.Object(
		{
			status: stringEnum(["answered", "skipped"]),
			answers: Type.Record(Type.String(), UserInputAnswerSchema),
		},
		closed,
	),
	Type.Object({ cancelled: Type.Literal(true) }, closed),
]);
export type HostResponse = Static<typeof HostResponseSchema>;

// ============================================================================
// Live values
// ============================================================================

/** Run state: the single busy state and the active operation, run, compaction, and retry. */
export const LivePhaseValueSchema = Type.Object(
	{
		kind: Type.Literal("phase"),
		busy: Type.Boolean(),
		operation: Type.Union([stringEnum(["turn", "compaction", "navigation", "host"]), Type.Null()]),
		run: Type.Optional(RpcActiveAgentRunSchema),
		compaction: Type.Optional(RpcActiveCompactionSchema),
		retry: Type.Optional(RpcActiveRetrySchema),
	},
	closed,
);

/** Path-free Git metadata of the conversation's working tree; null outside a usable worktree. */
export const LiveGitValueSchema = Type.Object(
	{ kind: Type.Literal("git"), gitContext: Type.Union([RpcGitContextSchema, Type.Null()]) },
	closed,
);

/** The current model's prompt-cache retention; null when nothing is cached. */
export const LivePromptCacheValueSchema = Type.Object(
	{ kind: Type.Literal("prompt_cache"), promptCache: Type.Union([RpcPromptCacheStatusSchema, Type.Null()]) },
	closed,
);

/** Lifetime token use and cost, and the retained context's size. */
export const LiveUsageValueSchema = Type.Object(
	{
		kind: Type.Literal("usage"),
		tokens: Type.Object(
			{
				input: Type.Number(),
				output: Type.Number(),
				cacheRead: Type.Number(),
				cacheWrite: Type.Number(),
				total: Type.Number(),
			},
			closed,
		),
		cost: Type.Number(),
		contextUsage: Type.Optional(
			Type.Object(
				{
					tokens: Type.Union([Type.Number(), Type.Null()]),
					contextWindow: Type.Number(),
					percent: Type.Union([Type.Number(), Type.Null()]),
				},
				closed,
			),
		),
	},
	closed,
);

/** Availability and state of the intents whose availability depends on the conversation. */
export const LiveIntentsValueSchema = Type.Object(
	{ kind: Type.Literal("intents"), availability: Type.Array(IntentAvailabilitySchema) },
	closed,
);

/** Who else is attached to the conversation: how many paired remote devices. */
export const LivePresenceValueSchema = Type.Object(
	{ kind: Type.Literal("presence"), remote: Type.Integer({ minimum: 0 }) },
	closed,
);

/** A pending host request; the host clears it once answered, cancelled, or timed out. */
export const LiveHostRequestValueSchema = Type.Object(
	{ kind: Type.Literal("host_request"), requestId: RpcConversationIdentifierSchema, request: HostRequestSchema },
	closed,
);

/** Largest extension status text, as serialized JSON in UTF-8 bytes. */
export const EXTENSION_STATUS_MAX_SERIALIZED_BYTES = 1024;
/** Longest extension window title, in characters. */
export const EXTENSION_TITLE_MAX_CHARS = 256;

/** An extension status item, and the extension that set it. */
export const LiveExtensionStatusValueSchema = Type.Object(
	{ kind: Type.Literal("ext_status"), extension: ExtensionIdSchema, text: UiNodeStyledTextSchema },
	closed,
);

/** Where a client shows an extension panel; clients without a sidebar show `sidebar` panels above the editor. */
export const ExtensionPanelPlacementSchema = stringEnum(["aboveEditor", "belowEditor", "sidebar"]);

/** A named extension panel: UI data an extension placed beside the conversation. */
export const LiveExtensionPanelValueSchema = Type.Object(
	{
		kind: Type.Literal("ext_panel"),
		extension: ExtensionIdSchema,
		title: Type.Optional(UiNodeStyledTextSchema),
		placement: ExtensionPanelPlacementSchema,
		node: UiNodeSchema,
	},
	closed,
);

/** A title an extension set for the conversation's window, and the extension that set it. */
export const LiveExtensionTitleValueSchema = Type.Object(
	{
		kind: Type.Literal("ext_title"),
		extension: ExtensionIdSchema,
		title: Type.String({ maxLength: EXTENSION_TITLE_MAX_CHARS, pattern: UI_NODE_LINE_PATTERN }),
	},
	closed,
);

/**
 * Work this host runs (RFC §7.1): set when the work's executor attaches and
 * cleared once it detaches, so open work without this value is suspended.
 * Carries fine-grained progress; the `work_*` entries hold the rest, and
 * `output` says how much output the `work_output` query can read.
 */
export const LiveWorkValueSchema = Type.Object(
	{
		kind: Type.Literal("work"),
		workId: LogEntryIdSchema,
		progress: Type.Optional(WorkProgressSchema),
		detail: Type.Optional(UiNodeSchema),
		/** Output the work produced so far, in UTF-8 bytes, older output included. */
		output: Type.Optional(Type.Object({ bytes: Type.Integer({ minimum: 0 }) }, closed)),
	},
	closed,
);

/**
 * A user shell command (`!`, or `!!` with `excludeFromContext`) and its
 * output so far: set when it starts and cleared once its `bashExecution` entry
 * commits; `output` grows by `append_lines` patches. It has an `exitCode` or
 * `cancelled` once the command ended, while its entry waits for the running
 * turn.
 */
export const LiveBashValueSchema = Type.Object(
	{
		kind: Type.Literal("bash"),
		command: Type.String(),
		excludeFromContext: Type.Optional(Type.Boolean()),
		output: UiTerminalNodeSchema,
		exitCode: Type.Optional(Type.Integer()),
		cancelled: Type.Optional(Type.Boolean()),
		truncated: Type.Optional(Type.Boolean()),
	},
	closed,
);

/** Every live value, keyed by kind. */
export const LIVE_VALUE_SCHEMAS = {
	phase: LivePhaseValueSchema,
	git: LiveGitValueSchema,
	prompt_cache: LivePromptCacheValueSchema,
	usage: LiveUsageValueSchema,
	intents: LiveIntentsValueSchema,
	presence: LivePresenceValueSchema,
	host_request: LiveHostRequestValueSchema,
	ext_status: LiveExtensionStatusValueSchema,
	ext_panel: LiveExtensionPanelValueSchema,
	ext_title: LiveExtensionTitleValueSchema,
	work: LiveWorkValueSchema,
	bash: LiveBashValueSchema,
} as const;

export type LiveValueKind = keyof typeof LIVE_VALUE_SCHEMAS;

export const LiveValueSchema = Type.Union([
	LivePhaseValueSchema,
	LiveGitValueSchema,
	LivePromptCacheValueSchema,
	LiveUsageValueSchema,
	LiveIntentsValueSchema,
	LivePresenceValueSchema,
	LiveHostRequestValueSchema,
	LiveExtensionStatusValueSchema,
	LiveExtensionPanelValueSchema,
	LiveExtensionTitleValueSchema,
	LiveWorkValueSchema,
	LiveBashValueSchema,
]);
export type LiveValue = Static<typeof LiveValueSchema>;

/** Families with one value per conversation: the key is the kind. */
export const LIVE_SINGLETON_KINDS = [
	"phase",
	"git",
	"prompt_cache",
	"usage",
	"intents",
	"presence",
	"ext_title",
	"bash",
] as const satisfies readonly LiveValueKind[];

/** Families with one value per id: the key is `<kind>/<id>`. */
export const LIVE_KEYED_KINDS = [
	"host_request",
	"ext_status",
	"ext_panel",
	"work",
] as const satisfies readonly LiveValueKind[];

/** Keyed families an extension declares: the id is `<extension id>/<name>`, and the value names the extension. */
export const LIVE_EXTENSION_KINDS = [
	"ext_status",
	"ext_panel",
] as const satisfies readonly (typeof LIVE_KEYED_KINDS)[number][];

/** Longest id in a keyed live key, in characters. */
export const LIVE_KEY_ID_MAX_CHARS = 256;

/** Longest name of an extension's status item or panel, in characters. */
export const LIVE_EXTENSION_NAME_MAX_CHARS = 128;

const KEY_ID = `[^\\u0000-\\u001f\\u007f]{1,${LIVE_KEY_ID_MAX_CHARS}}`;
/** An extension id followed by `/`, without the id pattern's anchors. */
const EXTENSION_ID_PREFIX = `(?!(?:${RESERVED_EXTENSION_IDS.join("|")})/)[a-z0-9][a-z0-9-]{0,63}/`;
const EXTENSION_KEY_ID = `${EXTENSION_ID_PREFIX}[^\\u0000-\\u001f\\u007f]{1,${LIVE_EXTENSION_NAME_MAX_CHARS}}`;
const GENERIC_KEYED_KINDS = LIVE_KEYED_KINDS.filter(
	(kind) => !(LIVE_EXTENSION_KINDS as readonly string[]).includes(kind),
);

export const LiveKeySchema = Type.String({
	pattern: `^(?:(?:${LIVE_SINGLETON_KINDS.join("|")})|(?:${GENERIC_KEYED_KINDS.join("|")})/${KEY_ID}|(?:${LIVE_EXTENSION_KINDS.join("|")})/${EXTENSION_KEY_ID})$`,
	"x-volt-expected": "be a live key",
});

// ============================================================================
// Live items
// ============================================================================

/** A streaming assistant message begins; `message` is the partial message so far, bounded by the profile. */
export const LiveAssistantStartItemSchema = Type.Object(
	{ type: Type.Literal("assistant_start"), message: AssistantMessageSchema },
	closed,
);

const contentIndex = Type.Integer();

/**
 * The nine incremental assistant events: the volt-ai `AssistantMessageEvent`
 * content variants without their `seq`, `snapshot`, and `toolState` fields.
 */
export const LiveAssistantEventSchema = Type.Union([
	Type.Object({ type: Type.Literal("text_start"), contentIndex }, closed),
	Type.Object({ type: Type.Literal("text_delta"), contentIndex, delta: Type.String() }, closed),
	Type.Object({ type: Type.Literal("text_end"), contentIndex, content: Type.String() }, closed),
	Type.Object({ type: Type.Literal("thinking_start"), contentIndex, redacted: Type.Optional(Type.Boolean()) }, closed),
	Type.Object({ type: Type.Literal("thinking_delta"), contentIndex, delta: Type.String() }, closed),
	Type.Object(
		{
			type: Type.Literal("thinking_end"),
			contentIndex,
			content: Type.String(),
			redacted: Type.Optional(Type.Boolean()),
		},
		closed,
	),
	Type.Object({ type: Type.Literal("toolcall_start"), contentIndex, id: Type.String(), name: Type.String() }, closed),
	Type.Object(
		{
			type: Type.Literal("toolcall_delta"),
			contentIndex,
			argsTextDelta: Type.String(),
			id: Type.Optional(Type.String()),
			name: Type.Optional(Type.String()),
		},
		closed,
	),
	Type.Object({ type: Type.Literal("toolcall_end"), contentIndex, toolCall: ToolCallSchema }, closed),
]);

/** One incremental assistant event. */
export const LiveAssistantDeltaItemSchema = Type.Object(
	{ type: Type.Literal("assistant_delta"), event: LiveAssistantEventSchema },
	closed,
);

/** The streaming assistant message finished; the entry that commits it follows. */
export const LiveAssistantEndItemSchema = Type.Object({ type: Type.Literal("assistant_end") }, closed);

/**
 * How a tool call of the streaming assistant message looks while its
 * arguments stream: the host presents it as they stand, at most every 100 ms,
 * until the call runs and its `tool` items carry its presentation. It leaves
 * with the streaming message. Local clients only.
 */
export const LiveToolCallPresentationItemSchema = Type.Object(
	{ type: Type.Literal("toolcall_presentation"), toolCallId: Type.String(), presentation: ToolPresentationSchema },
	closed,
);

/** A partial tool result's content; how the call looks is its presentation. */
export const LiveToolPartialSchema = Type.Object(
	{ content: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])) },
	closed,
);

/**
 * A tool execution starts, reports progress, or ends; its result entry follows
 * the end. `presentation` replaces the call's presentation; `patch` updates
 * the one the client holds.
 */
export const LiveToolItemSchema = Type.Object(
	{
		type: Type.Literal("tool"),
		op: stringEnum(["start", "update", "end"]),
		toolCallId: Type.String(),
		toolName: Type.String(),
		args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		partial: Type.Optional(LiveToolPartialSchema),
		isError: Type.Optional(Type.Boolean()),
		presentation: Type.Optional(ToolPresentationSchema),
		patch: Type.Optional(ToolPresentationPatchSchema),
	},
	closed,
);

/** Set or replace one keyed value. */
export const LiveSetItemSchema = Type.Object(
	{ type: Type.Literal("set"), key: LiveKeySchema, value: LiveValueSchema },
	closed,
);

/** Remove one keyed value. */
export const LiveClearItemSchema = Type.Object({ type: Type.Literal("clear"), key: LiveKeySchema }, closed);

/** Values whose node a `patch` item updates: a panel's `node`, a work item's `detail`, and a shell command's `output`. */
export const LIVE_PATCHABLE_KINDS = ["ext_panel", "work", "bash"] as const satisfies readonly LiveValueKind[];

export const LivePatchKeySchema = Type.String({
	pattern: `^(?:bash|work/${KEY_ID}|ext_panel/${EXTENSION_KEY_ID})$`,
	"x-volt-expected": "be the live key of a panel, work item, or shell command",
});

/**
 * Update one value's node in place. `ops` apply to the node as a one-node
 * tree: an `ext_panel` value's `node`, which stays one node; a `work` value's
 * `detail` (the empty tree without one), which stays at most one node; or a
 * `bash` value's `output`, which stays one terminal node.
 */
export const LivePatchItemSchema = Type.Object(
	{ type: Type.Literal("patch"), key: LivePatchKeySchema, ops: UiPatchSchema },
	closed,
);

/**
 * The `source` of a notice the host raised itself, such as a failed
 * compaction or a retry that gave up; a reserved extension id, so no
 * extension's notice carries it.
 */
export const HOST_NOTICE_SOURCE = "host";

/** A transient message for the user: a notification or an error. */
export const LiveNoticeItemSchema = Type.Object(
	{
		type: Type.Literal("notice"),
		level: stringEnum(["info", "warning", "error"]),
		message: UiNodeStyledTextSchema,
		/** What raised it: an extension's id, or {@link HOST_NOTICE_SOURCE}. */
		source: Type.Optional(Type.String()),
		/** Diagnostic detail, such as the stack of an extension's error. Local clients only. */
		detail: Type.Optional(Type.String()),
	},
	closed,
);

/**
 * A one-shot instruction for an interactive client: `set_editor_text`
 * replaces its editor text, `insert_editor_text` pastes at the cursor, and
 * `set_theme` asks it to show the theme `name` (an extension's
 * `ctx.ui.setTheme`), unless its user picked a theme there. Local clients only.
 */
export const LiveDirectiveItemSchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal("directive"),
			directive: stringEnum(["set_editor_text", "insert_editor_text"]),
			text: Type.String(),
		},
		closed,
	),
	Type.Object(
		{ type: Type.Literal("directive"), directive: Type.Literal("set_theme"), name: Type.String({ minLength: 1 }) },
		closed,
	),
]);

/** Every live item, keyed by type. */
export const LIVE_ITEM_SCHEMAS = {
	assistant_start: LiveAssistantStartItemSchema,
	assistant_delta: LiveAssistantDeltaItemSchema,
	assistant_end: LiveAssistantEndItemSchema,
	toolcall_presentation: LiveToolCallPresentationItemSchema,
	tool: LiveToolItemSchema,
	set: LiveSetItemSchema,
	clear: LiveClearItemSchema,
	patch: LivePatchItemSchema,
	notice: LiveNoticeItemSchema,
	directive: LiveDirectiveItemSchema,
} as const;

export const LiveItemSchema = Type.Union([
	LiveAssistantStartItemSchema,
	LiveAssistantDeltaItemSchema,
	LiveAssistantEndItemSchema,
	LiveToolCallPresentationItemSchema,
	LiveToolItemSchema,
	LiveSetItemSchema,
	LiveClearItemSchema,
	LivePatchItemSchema,
	LiveNoticeItemSchema,
	LiveDirectiveItemSchema,
]);
export type LiveItem = Static<typeof LiveItemSchema>;
