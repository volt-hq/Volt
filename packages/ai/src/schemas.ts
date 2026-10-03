/**
 * Runtime schemas for the ai data model: messages, content blocks, usage, stop
 * reasons, provider errors, assistant diagnostics, stream tool state, and model metadata. Every
 * object schema is closed. The hand-written types are pinned to these schemas
 * by the exact-equality assertions at the end of this module, so changing a
 * type fails typecheck until its schema follows (and the version is bumped).
 */

import { type Static, Type } from "typebox";
import type {
	ActiveToolCallState,
	Api,
	AssistantMessage,
	ImageContent,
	KnownApi,
	Message,
	Model,
	ProviderError,
	ProviderErrorKind,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "./types.ts";
import type { AssistantMessageDiagnostic, DiagnosticErrorInfo } from "./utils/diagnostics.ts";
import type { JsonObject } from "./utils/json-value.ts";
import { StringEnum } from "./utils/typebox-helpers.ts";

/** Version of the schemas in this module. Bump it whenever any of them changes shape. */
export const AI_SCHEMA_VERSION = 2;

const KNOWN_APIS = [
	"openai-completions",
	"mistral-conversations",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-vertex",
] as const;

/** Open string: the known values document the built-in APIs, and custom provider APIs still validate. */
export const ApiSchema = Type.Unsafe<Api>({ type: "string", "x-volt-known-values": [...KNOWN_APIS] });

export const StopReasonSchema = StringEnum(["stop", "length", "toolUse", "error", "aborted"] as const);

const jsonObjectSchema = Type.Unsafe<JsonObject>(Type.Record(Type.String(), Type.Unknown()));

// ============================================================================
// Content blocks
// ============================================================================

export const TextContentSchema = Type.Object(
	{
		type: Type.Literal("text"),
		text: Type.String(),
		textSignature: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const ThinkingContentSchema = Type.Object(
	{
		type: Type.Literal("thinking"),
		thinking: Type.String(),
		thinkingSignature: Type.Optional(Type.String()),
		redacted: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const ImageContentSchema = Type.Object(
	{
		type: Type.Literal("image"),
		data: Type.String(),
		mimeType: Type.String(),
	},
	{ additionalProperties: false },
);

export const ToolCallSchema = Type.Object(
	{
		type: Type.Literal("toolCall"),
		id: Type.String(),
		name: Type.String(),
		arguments: jsonObjectSchema,
		thoughtSignature: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const AssistantContentSchema = Type.Union([TextContentSchema, ThinkingContentSchema, ToolCallSchema]);

const textOrImageContentSchema = Type.Union([TextContentSchema, ImageContentSchema]);

// ============================================================================
// Usage and diagnostics
// ============================================================================

const serviceTierSchema = StringEnum(["auto", "default", "flex", "scale", "priority"] as const);

export const UsageSchema = Type.Object(
	{
		availability: Type.Optional(StringEnum(["complete", "partial", "unavailable"] as const)),
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		cacheWrite1h: Type.Optional(Type.Number()),
		totalTokens: Type.Number(),
		cost: Type.Object(
			{
				input: Type.Number(),
				output: Type.Number(),
				cacheRead: Type.Number(),
				cacheWrite: Type.Number(),
				total: Type.Number(),
				priceVersion: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
		serviceTier: Type.Optional(
			Type.Object(
				{
					requested: Type.Optional(serviceTierSchema),
					effective: Type.Optional(serviceTierSchema),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const DiagnosticErrorInfoSchema = Type.Object(
	{
		name: Type.Optional(Type.String()),
		message: Type.String(),
		stack: Type.Optional(Type.String()),
		code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
	},
	{ additionalProperties: false },
);

export const AssistantMessageDiagnosticSchema = Type.Object(
	{
		type: Type.String(),
		timestamp: Type.Number(),
		error: Type.Optional(DiagnosticErrorInfoSchema),
		details: Type.Optional(jsonObjectSchema),
	},
	{ additionalProperties: false },
);

export const ProviderErrorKindSchema = StringEnum([
	"rate_limit",
	"overloaded",
	"server",
	"network",
	"timeout",
	"quota",
	"auth",
	"invalid_request",
	"context_overflow",
	"refusal",
	"invalid_tool_call",
	"stream_limit",
	"aborted",
	"unknown",
] as const);

export const ProviderErrorSchema = Type.Object(
	{
		kind: ProviderErrorKindSchema,
		retryable: Type.Boolean(),
		providerCode: Type.Optional(Type.String()),
		message: Type.String(),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Messages
// ============================================================================

export const UserMessageSchema = Type.Object(
	{
		role: Type.Literal("user"),
		content: Type.Union([Type.String(), Type.Array(textOrImageContentSchema)]),
		timestamp: Type.Number(),
	},
	{ additionalProperties: false },
);

export const AssistantMessageSchema = Type.Object(
	{
		role: Type.Literal("assistant"),
		content: Type.Array(AssistantContentSchema),
		api: ApiSchema,
		provider: Type.String(),
		model: Type.String(),
		responseModel: Type.Optional(Type.String()),
		responseId: Type.Optional(Type.String()),
		diagnostics: Type.Optional(Type.Array(AssistantMessageDiagnosticSchema)),
		usage: UsageSchema,
		stopReason: StopReasonSchema,
		error: Type.Optional(ProviderErrorSchema),
		timestamp: Type.Number(),
	},
	{ additionalProperties: false },
);

export const ToolResultMessageSchema = Type.Object(
	{
		role: Type.Literal("toolResult"),
		toolCallId: Type.String(),
		toolName: Type.String(),
		content: Type.Array(textOrImageContentSchema),
		details: Type.Optional(Type.Unknown()),
		isError: Type.Boolean(),
		timestamp: Type.Number(),
	},
	{ additionalProperties: false },
);

export const MessageSchema = Type.Union([UserMessageSchema, AssistantMessageSchema, ToolResultMessageSchema]);

/** Raw state of an in-flight tool call, carried next to streaming snapshots. */
export const ActiveToolCallStateSchema = Type.Object(
	{
		contentIndex: Type.Integer(),
		argsText: Type.String(),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Model metadata
// ============================================================================

const nullableStringSchema = Type.Union([Type.String(), Type.Null()]);

const promptCacheRetentionTierSchema = Type.Object(
	{ ttlSeconds: Type.Optional(Type.Number()) },
	{ additionalProperties: false },
);

/**
 * Model metadata. `compat` is validated only as an object: its provider-specific
 * tuning fields are interpreted by the provider implementations alone.
 */
export const ModelSchema = Type.Object(
	{
		id: Type.String(),
		name: Type.String(),
		api: ApiSchema,
		provider: Type.String(),
		baseUrl: Type.String(),
		reasoning: Type.Boolean(),
		thinkingLevelMap: Type.Optional(
			Type.Object(
				{
					off: Type.Optional(nullableStringSchema),
					minimal: Type.Optional(nullableStringSchema),
					low: Type.Optional(nullableStringSchema),
					medium: Type.Optional(nullableStringSchema),
					high: Type.Optional(nullableStringSchema),
					xhigh: Type.Optional(nullableStringSchema),
					max: Type.Optional(nullableStringSchema),
				},
				{ additionalProperties: false },
			),
		),
		input: Type.Array(StringEnum(["text", "image"] as const)),
		promptCache: Type.Optional(
			Type.Object(
				{
					modes: Type.Unsafe<readonly ("implicit" | "explicit")[]>(
						Type.Array(StringEnum(["implicit", "explicit"] as const)),
					),
					retention: Type.Object(
						{
							short: promptCacheRetentionTierSchema,
							long: Type.Optional(promptCacheRetentionTierSchema),
						},
						{ additionalProperties: false },
					),
					refreshesOnHit: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
		cost: Type.Object(
			{
				input: Type.Number(),
				output: Type.Number(),
				cacheRead: Type.Number(),
				cacheWrite: Type.Number(),
			},
			{ additionalProperties: false },
		),
		contextWindow: Type.Number(),
		maxTokens: Type.Number(),
		headers: Type.Optional(Type.Record(Type.String(), Type.String())),
		compat: Type.Optional(Type.Unsafe<NonNullable<Model<Api>["compat"]>>(Type.Record(Type.String(), Type.Unknown()))),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Type pins
// ============================================================================

/** Exact type identity: optionality, readonly, and extra optional keys all count. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

type _knownApis = Assert<Equals<(typeof KNOWN_APIS)[number], KnownApi>>;
type _api = Assert<Equals<Static<typeof ApiSchema>, Api>>;
type _stopReason = Assert<Equals<Static<typeof StopReasonSchema>, StopReason>>;
type _textContent = Assert<Equals<Static<typeof TextContentSchema>, TextContent>>;
type _thinkingContent = Assert<Equals<Static<typeof ThinkingContentSchema>, ThinkingContent>>;
type _imageContent = Assert<Equals<Static<typeof ImageContentSchema>, ImageContent>>;
type _toolCall = Assert<Equals<Static<typeof ToolCallSchema>, ToolCall>>;
type _assistantContent = Assert<Equals<Static<typeof AssistantContentSchema>, AssistantMessage["content"][number]>>;
type _usage = Assert<Equals<Static<typeof UsageSchema>, Usage>>;
type _providerErrorKind = Assert<Equals<Static<typeof ProviderErrorKindSchema>, ProviderErrorKind>>;
type _providerError = Assert<Equals<Static<typeof ProviderErrorSchema>, ProviderError>>;
type _diagnosticErrorInfo = Assert<Equals<Static<typeof DiagnosticErrorInfoSchema>, DiagnosticErrorInfo>>;
type _assistantMessageDiagnostic = Assert<
	Equals<Static<typeof AssistantMessageDiagnosticSchema>, AssistantMessageDiagnostic>
>;
type _userMessage = Assert<Equals<Static<typeof UserMessageSchema>, UserMessage>>;
type _assistantMessage = Assert<Equals<Static<typeof AssistantMessageSchema>, AssistantMessage>>;
type _toolResultMessage = Assert<Equals<Static<typeof ToolResultMessageSchema>, ToolResultMessage>>;
type _message = Assert<Equals<Static<typeof MessageSchema>, Message>>;
type _activeToolCallState = Assert<Equals<Static<typeof ActiveToolCallStateSchema>, ActiveToolCallState>>;
type _model = Assert<Equals<Static<typeof ModelSchema>, Model<Api>>>;
