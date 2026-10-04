/**
 * The live lane (RFC §6.1): ephemeral state carried by `live{subscriptionId,
 * basedOn, seq, reset?, items}` frames.
 *
 * Streaming items (assistant start/delta/end and tool progress) are scoped by
 * `basedOn`, the ordinal they build on: a client discards them when a frame
 * arrives with a different `basedOn`, or when it applies the entry that
 * commits them (the assistant message, the tool result). Keyed state (`set`
 * and `clear`) persists until the host clears it, replaces it, or resets the
 * lane, so a commit never drops a pending dialog. A frame with `reset: true`
 * replaces the client's whole live state; `seq` restarts at 1 with every reset
 * and a gap in `seq` means the client must resubscribe after its position.
 *
 * Keys name a value family and, for keyed families, an id:
 * `phase`, `git`, `prompt_cache`, `usage`, `intents`, `ext_title`, `jobs`, or
 * `host_request/<requestId>`, `ext_status/<key>`, `ext_widget/<key>`,
 * `workflow/<workflowId>`, `subagent/<subagentId>`, `host_action/<id>`.
 * A value's `kind` is its key's family. `jobs`, `workflow`, `subagent`, and
 * `host_action` are interim values until work items replace them (Phase 4).
 *
 * Host requests (dialogs, forms, approvals, MCP authorization) are live values
 * until answered; any client that accepts the request's kind may answer with
 * a `host_response` frame, and the first answer wins.
 */

import {
	AssistantMessageSchema,
	ImageContentSchema,
	TextContentSchema,
	ToolCallSchema,
} from "@hansjm10/volt-ai/schemas";
import { type Static, Type } from "typebox";
import { RpcBackgroundJobsSchema } from "./background-jobs.ts";
import { LogSessionIdSchema } from "./entries.ts";
import { RpcGitContextSchema } from "./git-context.ts";
import { opaque, stringEnum } from "./helpers.ts";
import { IntentAvailabilitySchema } from "./intents.ts";
import { RpcConversationIdentifierSchema } from "./primitives.ts";
import { RpcWorkflowEventSchema, RpcWorkflowToolEventSchema } from "./projections.ts";
import {
	RpcActiveAgentRunSchema,
	RpcActiveCompactionSchema,
	RpcActiveRetrySchema,
	RpcPromptCacheStatusSchema,
} from "./session.ts";
import { UiNodeFormFieldSchema } from "./ui-node.ts";

const closed = { additionalProperties: false } as const;

const timeoutMs = Type.Optional(Type.Integer({ minimum: 0 }));

// ============================================================================
// Host requests
// ============================================================================

export const HOST_REQUEST_KINDS = ["select", "confirm", "input", "editor", "form", "approval", "mcp_auth"] as const;

/** The kinds of host request a client may accept in `hello.accepts.hostRequests`. */
export const HostRequestKindSchema = stringEnum(HOST_REQUEST_KINDS);
export type HostRequestKind = Static<typeof HostRequestKindSchema>;

/**
 * A question the host asks a client. Answers: `select`, `input`, and `editor`
 * take `{value}`; `confirm` takes `{confirmed}`; `form` takes `{values}`;
 * `approval` takes `{decision}`; every kind may be answered `{cancelled}`.
 */
export const HostRequestSchema = Type.Union([
	Type.Object(
		{
			kind: Type.Literal("select"),
			title: Type.String(),
			options: Type.Array(Type.String(), { minItems: 1 }),
			timeoutMs,
		},
		closed,
	),
	Type.Object({ kind: Type.Literal("confirm"), title: Type.String(), message: Type.String(), timeoutMs }, closed),
	Type.Object(
		{ kind: Type.Literal("input"), title: Type.String(), placeholder: Type.Optional(Type.String()), timeoutMs },
		closed,
	),
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
	/** A host action (a command, a push) waiting for the user's approval. */
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

/** A pending host request; the host clears it once answered, cancelled, or timed out. */
export const LiveHostRequestValueSchema = Type.Object(
	{ kind: Type.Literal("host_request"), requestId: RpcConversationIdentifierSchema, request: HostRequestSchema },
	closed,
);

/** An extension status line. */
export const LiveExtensionStatusValueSchema = Type.Object(
	{ kind: Type.Literal("ext_status"), text: Type.String() },
	closed,
);

/** An extension widget: plain lines above or below the editor. */
export const LiveExtensionWidgetValueSchema = Type.Object(
	{
		kind: Type.Literal("ext_widget"),
		lines: Type.Array(Type.String()),
		placement: stringEnum(["aboveEditor", "belowEditor"]),
	},
	closed,
);

/** A title an extension set for the conversation's window. */
export const LiveExtensionTitleValueSchema = Type.Object(
	{ kind: Type.Literal("ext_title"), title: Type.String() },
	closed,
);

/** The conversation's background jobs (interim until work items). */
export const LiveJobsValueSchema = Type.Object({ kind: Type.Literal("jobs"), jobs: RpcBackgroundJobsSchema }, closed);

/** A review workflow's latest event and running tools (interim until work items). */
export const LiveWorkflowValueSchema = Type.Object(
	{
		kind: Type.Literal("workflow"),
		event: RpcWorkflowEventSchema,
		activeTools: Type.Array(RpcWorkflowToolEventSchema),
	},
	closed,
);

/** A subagent child conversation's run status (interim until work items). Subscribe to `conversation` for its log. */
export const LiveSubagentValueSchema = Type.Object(
	{
		kind: Type.Literal("subagent"),
		subagentId: Type.String(),
		conversation: LogSessionIdSchema,
		agent: Type.Optional(Type.String()),
		status: stringEnum(["running", "completed", "failed", "aborted"]),
		error: Type.Optional(Type.String()),
	},
	closed,
);

/** A host action's progress after approval (interim until work items). */
export const LiveHostActionValueSchema = Type.Object(
	{
		kind: Type.Literal("host_action"),
		action: Type.String(),
		status: stringEnum(["running", "completed", "failed", "cancelled"]),
		message: Type.Optional(Type.String()),
		exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
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
	host_request: LiveHostRequestValueSchema,
	ext_status: LiveExtensionStatusValueSchema,
	ext_widget: LiveExtensionWidgetValueSchema,
	ext_title: LiveExtensionTitleValueSchema,
	jobs: LiveJobsValueSchema,
	workflow: LiveWorkflowValueSchema,
	subagent: LiveSubagentValueSchema,
	host_action: LiveHostActionValueSchema,
} as const;

export type LiveValueKind = keyof typeof LIVE_VALUE_SCHEMAS;

export const LiveValueSchema = Type.Union([
	LivePhaseValueSchema,
	LiveGitValueSchema,
	LivePromptCacheValueSchema,
	LiveUsageValueSchema,
	LiveIntentsValueSchema,
	LiveHostRequestValueSchema,
	LiveExtensionStatusValueSchema,
	LiveExtensionWidgetValueSchema,
	LiveExtensionTitleValueSchema,
	LiveJobsValueSchema,
	LiveWorkflowValueSchema,
	LiveSubagentValueSchema,
	LiveHostActionValueSchema,
]);
export type LiveValue = Static<typeof LiveValueSchema>;

/** Families with one value per conversation: the key is the kind. */
export const LIVE_SINGLETON_KINDS = [
	"phase",
	"git",
	"prompt_cache",
	"usage",
	"intents",
	"ext_title",
	"jobs",
] as const satisfies readonly LiveValueKind[];

/** Families with one value per id: the key is `<kind>/<id>`. */
export const LIVE_KEYED_KINDS = [
	"host_request",
	"ext_status",
	"ext_widget",
	"workflow",
	"subagent",
	"host_action",
] as const satisfies readonly LiveValueKind[];

/** Longest id in a keyed live key, in characters. */
export const LIVE_KEY_ID_MAX_CHARS = 256;

export const LiveKeySchema = Type.String({
	pattern: `^(?:(?:${LIVE_SINGLETON_KINDS.join("|")})|(?:${LIVE_KEYED_KINDS.join("|")})/[^\\u0000-\\u001f\\u007f]{1,${LIVE_KEY_ID_MAX_CHARS}})$`,
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

/** A partial tool result. */
export const LiveToolPartialSchema = Type.Object(
	{
		content: Type.Array(Type.Union([TextContentSchema, ImageContentSchema])),
		details: Type.Optional(opaque<unknown>("tool-specific JSON details, until tools present UiNode data (Phase 5)")),
	},
	closed,
);

/** A tool execution starts, reports progress, or ends; its result entry follows the end. */
export const LiveToolItemSchema = Type.Object(
	{
		type: Type.Literal("tool"),
		op: stringEnum(["start", "update", "end"]),
		toolCallId: Type.String(),
		toolName: Type.String(),
		args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		partial: Type.Optional(LiveToolPartialSchema),
		isError: Type.Optional(Type.Boolean()),
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

/** A transient message for the user: a notification or an error. */
export const LiveNoticeItemSchema = Type.Object(
	{
		type: Type.Literal("notice"),
		level: stringEnum(["info", "warning", "error"]),
		message: Type.String(),
		/** What raised it, such as an extension. */
		source: Type.Optional(Type.String()),
	},
	closed,
);

/** A one-shot instruction for an interactive client. */
export const LiveDirectiveItemSchema = Type.Object(
	{ type: Type.Literal("directive"), directive: Type.Literal("set_editor_text"), text: Type.String() },
	closed,
);

/** Every live item, keyed by type. */
export const LIVE_ITEM_SCHEMAS = {
	assistant_start: LiveAssistantStartItemSchema,
	assistant_delta: LiveAssistantDeltaItemSchema,
	assistant_end: LiveAssistantEndItemSchema,
	tool: LiveToolItemSchema,
	set: LiveSetItemSchema,
	clear: LiveClearItemSchema,
	notice: LiveNoticeItemSchema,
	directive: LiveDirectiveItemSchema,
} as const;

export const LiveItemSchema = Type.Union([
	LiveAssistantStartItemSchema,
	LiveAssistantDeltaItemSchema,
	LiveAssistantEndItemSchema,
	LiveToolItemSchema,
	LiveSetItemSchema,
	LiveClearItemSchema,
	LiveNoticeItemSchema,
	LiveDirectiveItemSchema,
]);
export type LiveItem = Static<typeof LiveItemSchema>;
