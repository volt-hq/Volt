import Anthropic, { APIConnectionError, APIConnectionTimeoutError } from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
	RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/messages.js";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import {
	classifyProviderCode,
	classifyProviderError,
	createProviderError,
	ProviderStreamError,
} from "../stream/provider-errors.ts";
import { createProviderStream, type StopReasonMapping } from "../stream/runner.ts";
import type {
	AnthropicMessagesCompat,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	PromptCacheRefreshFunction,
	ProviderEnv,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair } from "../utils/json-parse.ts";
import type { JsonObject } from "../utils/json-value.ts";
import { ANTHROPIC_OAUTH_BETA, ANTHROPIC_OAUTH_USER_AGENT } from "../utils/oauth/anthropic-client.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

import { canRefreshAnthropicPromptCache } from "./anthropic-capabilities.ts";
import { resolveCloudflareBaseUrl } from "./cloudflare.ts";
import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import { resolvePromptCacheRetention, supportsPromptCacheMode } from "./prompt-cache.ts";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolvePromptCacheRetention(model, cacheRetention);
	if (retention === "none" || !supportsPromptCacheMode(model, "explicit")) {
		return { retention };
	}
	const ttl = retention === "long" ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Claude Code 2.x tool names (canonical casing)
// Source: https://cchistory.mariozechner.at/data/prompts-2.1.11.md
// To update: https://github.com/badlogic/cchistory
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<Omit<AnthropicMessagesCompat, "forceAdaptiveThinking">> {
	// Auto-detect session affinity and cache control support from provider
	const isFireworks = model.provider === "fireworks";
	const isCloudflareAiGatewayAnthropic =
		model.provider === "cloudflare-ai-gateway" && model.baseUrl.includes("anthropic");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? !isFireworks,
		sendSessionAffinityHeaders:
			model.compat?.sendSessionAffinityHeaders ?? !!(isFireworks || isCloudflareAiGatewayAnthropic),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? !isFireworks,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
	};
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For adaptive thinking models: the model decides when/how much to think.
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 * Default: undefined (thinking is omitted unless `streamSimpleAnthropic()` maps
	 * a simple reasoning level to this option, or callers set it explicitly).
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for adaptive thinking models.
	 * Default: 1024 when `thinkingEnabled` is true and no budget is provided.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking models.
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7+, Fable 5)
	 * - "high": Always thinks, deep reasoning
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 * Default: omitted unless `streamSimpleAnthropic()` maps a simple reasoning
	 * level to this option.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text.
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 * Default: "summarized" when thinking is enabled.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Whether to request the interleaved thinking beta header for non-adaptive
	 * thinking models. Adaptive thinking models have interleaved thinking built in,
	 * so the header is skipped for them regardless of this setting.
	 * Default: true.
	 */
	interleavedThinking?: boolean;
	/**
	 * Anthropic tool choice behavior. String values map to Anthropic's built-in
	 * choices; `{ type: "tool", name }` forces a specific tool.
	 * Default: omitted (Anthropic default behavior, currently equivalent to auto).
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (Record<string, string | null> | undefined)[]): Record<string, string | null> {
	const merged: Record<string, string | null> = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";
	const onAbort = () => {
		void reader.cancel().catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (signal?.aborted) throw new Error("Request was aborted");
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		try {
			await reader.cancel();
		} catch {}
		reader.releaseLock();
	}
}

function invalidToolInputError(): ProviderStreamError {
	return new ProviderStreamError(
		"invalid_tool_call",
		"Anthropic returned malformed JSON for tool arguments. No tools were executed.",
		{ diagnostics: [{ type: "invalid_tool_arguments", timestamp: Date.now(), details: { code: "invalid_json" } }] },
	);
}

/** Classify an SSE `error` event, whose data is the provider's JSON error body. */
function anthropicStreamError(data: string): ProviderStreamError {
	let type: string | undefined;
	try {
		const body = JSON.parse(data) as { error?: { type?: unknown } };
		if (typeof body.error?.type === "string") type = body.error.type;
	} catch {
		// Unparseable bodies keep the raw data as their message.
	}
	const error = classifyProviderCode(type, data);
	return new ProviderStreamError(error.kind, data, {
		...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
	});
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw anthropicStreamError(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (
				(event.type === "content_block_start" && event.content_block.type === "tool_use") ||
				(event.type === "content_block_delta" && event.delta.type === "input_json_delta")
			) {
				// Repairing the outer event could silently change authoritative tool input.
				try {
					JSON.parse(sse.data);
				} catch {
					throw invalidToolInputError();
				}
			}
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			if (error instanceof ProviderStreamError) throw error;
			// If decoding failed before the block type became available, a content
			// event may still contain tool input. Fail closed without echoing its raw
			// payload or allowing argument text to influence retry classification.
			if (sse.event === "content_block_start" || sse.event === "content_block_delta") {
				throw invalidToolInputError();
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new ProviderStreamError("network", "Anthropic stream ended before message_stop");
	}
}

interface AnthropicStop {
	reason: Anthropic.Messages.StopReason | string;
	details?: RefusalStopDetails | null;
}

type AnthropicUsageCounts = Omit<Usage, "totalTokens" | "cost">;

type AnthropicBlockKind = "text" | "thinking" | "toolCall";

export const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = createProviderStream<
	"anthropic-messages",
	AnthropicOptions,
	MessageCreateParamsStreaming,
	{ response: Response; isOAuth: boolean },
	AnthropicStop,
	AnthropicUsageCounts
>({
	buildRequest({ model, context, options }) {
		const { client, isOAuthToken: isOAuth } = createRequestClient(model, context, options);
		const payload = buildParams(model, context, isOAuth, options);
		return {
			payload,
			async send(params, { signal }) {
				const response = await client.messages
					.create(
						{ ...params, stream: true },
						{
							signal,
							...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
							maxRetries: 0,
						},
					)
					.asResponse();
				return {
					response: { status: response.status, headers: headersToRecord(response.headers) },
					body: { response, isOAuth },
				};
			},
		};
	},

	async parse({ response, isOAuth }, sink, { context, options }) {
		let hasReportedInput = false;
		let usage: AnthropicUsageCounts = {
			availability: "unavailable",
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		};
		let nextContentIndex = 0;
		const blocksByRawIndex = new Map<number, { contentIndex: number; kind: AnthropicBlockKind }>();
		const toolArgumentSeeds = new Map<number, string>();
		const registerBlock = (rawIndex: number, kind: AnthropicBlockKind) => {
			const block = { contentIndex: nextContentIndex, kind };
			nextContentIndex += 1;
			blocksByRawIndex.set(rawIndex, block);
			return block.contentIndex;
		};
		const resolveBlock = (rawIndex: number, kind: AnthropicBlockKind) => {
			const block = blocksByRawIndex.get(rawIndex);
			return block?.contentIndex ?? registerBlock(rawIndex, kind);
		};

		for await (const event of iterateAnthropicEvents(response, options.signal)) {
			if (event.type === "message_start") {
				sink.push({ type: "meta", patch: { responseId: event.message.id } });
				// Capture initial token usage from message_start event
				// This ensures we have input token counts even if the stream is aborted early
				if (
					event.message.usage &&
					[
						event.message.usage.input_tokens,
						event.message.usage.output_tokens,
						event.message.usage.cache_read_input_tokens,
						event.message.usage.cache_creation_input_tokens,
					].some((value) => typeof value === "number")
				) {
					hasReportedInput = typeof event.message.usage.input_tokens === "number";
					usage = {
						availability: "partial",
						input: event.message.usage.input_tokens || 0,
						output: event.message.usage.output_tokens || 0,
						cacheRead: event.message.usage.cache_read_input_tokens || 0,
						cacheWrite: event.message.usage.cache_creation_input_tokens || 0,
						cacheWrite1h: event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0,
					};
					sink.usage(usage);
				}
			} else if (event.type === "content_block_start") {
				if (event.content_block.type === "text") {
					const contentIndex = registerBlock(event.index, "text");
					sink.push({ type: "text_start", contentIndex });
				} else if (event.content_block.type === "thinking") {
					const contentIndex = registerBlock(event.index, "thinking");
					sink.push({ type: "thinking_start", contentIndex });
				} else if (event.content_block.type === "redacted_thinking") {
					const contentIndex = registerBlock(event.index, "thinking");
					sink.push({
						type: "thinking_start",
						contentIndex,
						content: "[Reasoning redacted]",
						thinkingSignature: event.content_block.data,
						redacted: true,
					});
				} else if (event.content_block.type === "tool_use") {
					const contentIndex = registerBlock(event.index, "toolCall");
					sink.push({
						type: "toolcall_start",
						contentIndex,
						id: event.content_block.id,
						name: isOAuth
							? fromClaudeCodeName(event.content_block.name, context.tools)
							: event.content_block.name,
					});
					const seededInput = event.content_block.input as JsonObject;
					if (!sink.checkToolArgumentsObject(contentIndex, seededInput)) return;
					const seededArgs = JSON.stringify(seededInput) ?? "";
					toolArgumentSeeds.set(contentIndex, seededArgs);
					if (seededArgs !== "{}") {
						sink.push({ type: "toolcall_delta", contentIndex, argsTextDelta: seededArgs });
					}
				}
			} else if (event.type === "content_block_delta") {
				if (event.delta.type === "text_delta") {
					const contentIndex = resolveBlock(event.index, "text");
					sink.push({ type: "text_delta", contentIndex, delta: event.delta.text });
				} else if (event.delta.type === "thinking_delta") {
					const contentIndex = resolveBlock(event.index, "thinking");
					sink.push({ type: "thinking_delta", contentIndex, delta: event.delta.thinking });
				} else if (event.delta.type === "input_json_delta") {
					const contentIndex = resolveBlock(event.index, "toolCall");
					if (event.delta.partial_json.length > 0) toolArgumentSeeds.delete(contentIndex);
					sink.push({
						type: "toolcall_delta",
						contentIndex,
						argsTextDelta: event.delta.partial_json,
					});
				} else if (event.delta.type === "signature_delta") {
					const contentIndex = resolveBlock(event.index, "thinking");
					sink.push({
						type: "thinking_delta",
						contentIndex,
						delta: "",
						signatureDelta: event.delta.signature,
					});
				}
			} else if (event.type === "content_block_stop") {
				const block = blocksByRawIndex.get(event.index);
				if (block?.kind === "text") {
					sink.push({ type: "text_end", contentIndex: block.contentIndex });
				} else if (block?.kind === "thinking") {
					sink.push({ type: "thinking_end", contentIndex: block.contentIndex });
				} else if (block?.kind === "toolCall") {
					sink.push({
						type: "toolcall_end",
						contentIndex: block.contentIndex,
						argumentsText: toolArgumentSeeds.get(block.contentIndex),
					});
					toolArgumentSeeds.delete(block.contentIndex);
				}
			} else if (event.type === "message_delta") {
				if (event.delta.stop_reason) {
					sink.stop({ reason: event.delta.stop_reason, details: event.delta.stop_details });
				}
				// Only update usage fields if present (not null).
				// Preserves input_tokens from message_start when proxies omit it in message_delta.
				if (
					event.usage &&
					[
						event.usage.input_tokens,
						event.usage.output_tokens,
						event.usage.cache_read_input_tokens,
						event.usage.cache_creation_input_tokens,
					].some((value) => typeof value === "number")
				) {
					hasReportedInput ||= typeof event.usage.input_tokens === "number";
					usage = {
						...usage,
						availability:
							event.delta.stop_reason && hasReportedInput && typeof event.usage.output_tokens === "number"
								? "complete"
								: "partial",
						input: event.usage.input_tokens ?? usage.input,
						output: event.usage.output_tokens ?? usage.output,
						cacheRead: event.usage.cache_read_input_tokens ?? usage.cacheRead,
						cacheWrite: event.usage.cache_creation_input_tokens ?? usage.cacheWrite,
					};
					sink.usage(usage);
				}
			}
		}
	},

	mapStopReason: (stop) => mapStopReason(stop?.reason ?? "end_turn", stop?.details),

	mapUsage: (counts, { model }) => anthropicUsage(model, counts),

	mapError(error) {
		if (error instanceof APIConnectionTimeoutError) return createProviderError("timeout", error.message);
		if (error instanceof APIConnectionError) return createProviderError("network", error.message);
		return classifyProviderError(error);
	},
});

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is only valid on Opus 4.6, while Opus 4.7+ and Fable 5 support "xhigh".
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const effectiveLevel = level === "max" ? clampThinkingLevel(model, level) : level;
	const mapped = effectiveLevel ? model.thinkingLevelMap?.[effectiveLevel] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (effectiveLevel) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

/** Map provider-neutral simple options to the exact AnthropicOptions `streamSimpleAnthropic` sends. */
function resolveSimpleAnthropicOptions(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): AnthropicOptions {
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	if (!options?.reasoning) {
		return { ...base, thinkingEnabled: false };
	}

	// Thinking counts against max_tokens in both modes, so an explicit output cap gets the level's
	// thinking budget on top. Undefined means the caller did not request an output cap; let the helper
	// use the model cap. Do not coerce to 0 here, or the thinking budget would become the entire
	// max_tokens value.
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	// For models with adaptive thinking: use an effort level.
	// For older models: use budget-based thinking.
	if (model.compat?.forceAdaptiveThinking === true) {
		return {
			...base,
			maxTokens: adjusted.maxTokens,
			thinkingEnabled: true,
			effort: mapThinkingLevelToEffort(model, options.reasoning),
		};
	}

	return {
		...base,
		maxTokens: adjusted.maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: adjusted.thinkingBudget,
	};
}

export const streamSimpleAnthropic: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => streamAnthropic(model, context, resolveSimpleAnthropicOptions(model, options));

/**
 * Replay the `streamSimpleAnthropic` request with `max_tokens: 0`, which reads (and renews) the
 * cached prefix without generating output. Requests the API would reject that way, or that would
 * need a different prefix to be accepted, report "unsupported" without being sent.
 */
export const refreshPromptCacheAnthropic: PromptCacheRefreshFunction<"anthropic-messages"> = async (
	model,
	context,
	simpleOptions,
) => {
	if (!canRefreshAnthropicPromptCache(model, simpleOptions)) {
		return { status: "unsupported", reason: "budget-based thinking cannot be refreshed without output" };
	}
	const options = resolveSimpleAnthropicOptions(model, simpleOptions);
	if (!getCacheControl(model, options.cacheRetention).cacheControl) {
		return { status: "unsupported", reason: "request has no cache breakpoints" };
	}
	const { client, isOAuthToken } = createRequestClient(model, context, options);
	let params = buildParams(model, context, isOAuthToken, options);
	const nextParams = await options.onPayload?.(params, model);
	if (nextParams !== undefined) {
		params = nextParams as MessageCreateParamsStreaming;
	}
	const toolChoice = params.tool_choice?.type;
	if (toolChoice === "any" || toolChoice === "tool" || params.output_config?.format) {
		return { status: "unsupported", reason: "forced tool choice or structured output requires output" };
	}
	const { data, response } = await client.messages
		.create(
			{ ...params, stream: false, max_tokens: 0 },
			{
				...(options.signal ? { signal: options.signal } : {}),
				...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options.maxRetries ?? 0,
			},
		)
		.withResponse();
	await options.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
	const usage = anthropicUsage(model, {
		availability: "complete",
		input: data.usage.input_tokens ?? 0,
		output: data.usage.output_tokens ?? 0,
		cacheRead: data.usage.cache_read_input_tokens ?? 0,
		cacheWrite: data.usage.cache_creation_input_tokens ?? 0,
		cacheWrite1h: data.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
	});
	return { status: "refreshed", usage };
};

/** Anthropic reports no total, so the total and the cost both derive from the component counts. */
function anthropicUsage(model: Model<"anthropic-messages">, counts: Omit<Usage, "totalTokens" | "cost">): Usage {
	return {
		...counts,
		totalTokens: counts.input + counts.output + counts.cacheRead + counts.cacheWrite,
		cost: calculateCost(model, counts),
	};
}

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

/** Client and auth mode for one request; streaming and cache refresh must build the same payload. */
function createRequestClient(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): { client: Anthropic; isOAuthToken: boolean } {
	if (options?.client) return { client: options.client, isOAuthToken: false };
	const apiKey = options?.apiKey;
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	let copilotDynamicHeaders: Record<string, string> | undefined;
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		copilotDynamicHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages,
		});
	}

	return createClient(
		model,
		apiKey,
		options?.interleavedThinking ?? true,
		shouldUseFineGrainedToolStreamingBeta(model, context),
		options?.headers,
		copilotDynamicHeaders,
		options?.sessionId,
		options?.env,
		options?.cacheRetention,
	);
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	optionsHeaders?: Record<string, string>,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
	env?: ProviderEnv,
	cacheRetention?: CacheRetention,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models have interleaved thinking built in, so skip the beta header.
	const needsInterleavedBeta = interleavedThinking && model.compat?.forceAdaptiveThinking !== true;
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}

	if (model.provider === "cloudflare-ai-gateway") {
		const client = new Anthropic({
			apiKey: null,
			authToken: null,
			baseURL: resolveCloudflareBaseUrl(model, env),
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"cf-aig-authorization": `Bearer ${apiKey}`,
					"x-api-key": null,
					Authorization: null,
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// Copilot: Bearer auth, selective betas.
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: match Claude Code's subscription request conventions, not its private
	// runtime features. Leave SDK/platform headers truthful and opaque headers unset.
	if (isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			defaultQuery: { beta: "true" },
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": ["claude-code-20250219", ANTHROPIC_OAUTH_BETA, ...betaFeatures].join(","),
					"user-agent": ANTHROPIC_OAUTH_USER_AGENT,
					"x-app": "cli",
					...(sessionId ? { "x-claude-code-session-id": sessionId } : {}),
					"x-client-request-id": globalThis.crypto.randomUUID(),
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API-key cache affinity is disabled with caching; OAuth session identity above is not.
	const cacheSessionId = resolvePromptCacheRetention(model, cacheRetention) === "none" ? undefined : sessionId;
	const sessionAffinityHeaders: Record<string, string | null> =
		cacheSessionId && getAnthropicCompat(model).sendSessionAffinityHeaders
			? { "x-session-affinity": cacheSessionId }
			: {};
	const client = new Anthropic({
		apiKey,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: mergeHeaders(
			{
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
			},
			sessionAffinityHeaders,
			model.headers,
			optionsHeaders,
		),
	});

	return { client, isOAuthToken: false };
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): MessageCreateParamsStreaming {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention);
	const compat = getAnthropicCompat(model);
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(context.messages, model, isOAuthToken, cacheControl, compat.allowEmptySignature),
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
	};

	// For OAuth tokens, we MUST include Claude Code identity
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(cacheControl ? { cache_control: cacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	if (options?.temperature !== undefined && !options?.thinkingEnabled && compat.supportsTemperature) {
		params.temperature = options.temperature;
	}

	if (context.tools && context.tools.length > 0) {
		params.tools = convertTools(
			context.tools,
			isOAuthToken,
			compat.supportsEagerToolInputStreaming,
			compat.supportsCacheControlOnTools ? cacheControl : undefined,
		);
	}

	// Configure thinking mode: adaptive, budget-based, or explicitly disabled.
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
			// older Claude 4 models (whose API default is also "summarized").
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (model.compat?.forceAdaptiveThinking === true) {
				// Adaptive thinking: Claude decides when and how much to think.
				params.thinking = { type: "adaptive", display };
				if (options.effort) {
					// The Anthropic SDK types can lag newly supported effort values such as "xhigh".
					params.output_config =
						options.effort === "xhigh"
							? ({ effort: options.effort } as unknown as NonNullable<
									MessageCreateParamsStreaming["output_config"]
								>)
							: { effort: options.effort };
				}
			} else {
				// Budget-based thinking for older models
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
			params.thinking = { type: "disabled" };
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	return params;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertMessages(
	messages: Message[],
	model: Model<"anthropic-messages">,
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
): MessageParam[] {
	const params: MessageParam[] = [];

	// Transform messages for cross-provider compatibility
	const transformedMessages = transformMessages(messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					params.push({
						role: "user",
						content: sanitizeSurrogates(msg.content),
					});
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks,
				});
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					if (block.thinking.trim().length === 0) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
					if (!block.thinkingSignature || block.thinkingSignature.trim().length === 0) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: block.thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks,
			});
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint
			const toolResults: ContentBlockParam[] = [];

			// Add the current tool result
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			// Look ahead for consecutive toolResult messages
			let j = i + 1;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const nextMsg = transformedMessages[j] as ToolResultMessage; // We know it's a toolResult
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}

			// Skip the messages we've already processed
			i = j - 1;

			// Add a single user message with all tool results
			params.push({
				role: "user",
				content: toolResults,
			});
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	cacheControl?: CacheControlEphemeral,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const schema = tool.parameters as { properties?: unknown; required?: string[] };

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			input_schema: {
				type: "object",
				properties: schema.properties ?? {},
				required: schema.required ?? [],
			},
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(
	reason: Anthropic.Messages.StopReason | string,
	stopDetails?: RefusalStopDetails | null,
): StopReasonMapping {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				error: createProviderError(
					"refusal",
					stopDetails?.explanation || `The model refused to complete the request`,
					{ providerCode: reason },
				),
			};
		case "pause_turn": // Stop is good enough -> resubmit
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return {
				stopReason: "error",
				error: createProviderError("refusal", "The response was flagged by safety filters", {
					providerCode: reason,
				}),
			};
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			return {
				stopReason: "error",
				error: createProviderError("unknown", `Unhandled stop reason: ${reason}`, { providerCode: reason }),
			};
	}
}
