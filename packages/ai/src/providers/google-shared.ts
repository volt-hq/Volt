/**
 * Shared utilities for Google Generative AI and Google Vertex providers.
 */

import {
	type Content,
	FinishReason,
	FunctionCallingConfigMode,
	type GenerateContentResponse,
	type GenerateContentResponseUsageMetadata,
	type Part,
} from "@google/genai";
import { calculateCost } from "../models.ts";
import { createProviderError } from "../stream/provider-errors.ts";
import type { ProviderStreamSink, StopReasonMapping } from "../stream/runner.ts";
import type {
	Context,
	ImageContent,
	Model,
	ProviderErrorKind,
	StopReason,
	TextContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import type { JsonObject } from "../utils/json-value.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { transformMessages } from "./transform-messages.ts";

type GoogleApiType = "google-generative-ai" | "google-vertex";

/**
 * Thinking level for Gemini 3 models.
 * Mirrors Google's ThinkingLevel enum values.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

function isValidThoughtSignature(signature: string | undefined): boolean {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Models via Google APIs that require explicit tool call IDs in function calls/responses.
 */
export function requiresToolCallId(modelId: string): boolean {
	return modelId.startsWith("claude-") || modelId.startsWith("gpt-oss-");
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const normalizeToolCallId = (id: string): string => {
		if (!requiresToolCallId(model.id)) return id;
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({
					role: "user",
					parts: [{ text: sanitizeSurrogates(msg.content) }],
				});
			} else {
				const parts: Part[] = msg.content.map((item) => {
					if (item.type === "text") {
						return { text: sanitizeSurrogates(item.text) };
					} else {
						return {
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						};
					}
				});
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// Check if message is from same provider and model - only then keep thinking blocks
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					// Skip empty text blocks
					if (!block.text || block.text.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({
						text: sanitizeSurrogates(block.text),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// Skip empty thinking blocks
					if (!block.thinking || block.thinking.trim() === "") continue;
					// Only keep as thinking block if same provider AND same model
					// Otherwise convert to plain text (no tags to avoid model mimicking them)
					if (isSameProviderAndModel) {
						const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
						parts.push({
							thought: true,
							text: sanitizeSurrogates(block.thinking),
							...(thoughtSignature && { thoughtSignature }),
						});
					} else {
						parts.push({
							text: sanitizeSurrogates(block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(requiresToolCallId(model.id) ? { id: block.id } : {}),
						},
						...(thoughtSignature && { thoughtSignature }),
					};
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map((c) => c.text).join("\n");
			const imageContent = model.input.includes("image")
				? msg.content.filter((c): c is ImageContent => c.type === "image")
				: [];

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ models support multimodal function responses with images nested inside
			// functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
			// Gemini < 3 still needs a separate user image turn.
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// Use "output" key for success, "error" key for errors as per SDK documentation
			const responseValue = hasText ? sanitizeSurrogates(textResult) : hasImages ? "(see attached image)" : "";

			const imageParts: Part[] = imageContent.map((imageBlock) => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = requiresToolCallId(model.id);
			const functionResponsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some((p) => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// For Gemini < 3, add images in a separate user message
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				contents.push({
					role: "user",
					parts: [{ text: "Tool result image:" }, ...imageParts],
				});
			}
		}
	}

	return contents;
}

const JSON_SCHEMA_META_DECLARATIONS = new Set([
	"$schema",
	"$id",
	"$anchor",
	"$dynamicAnchor",
	"$vocabulary",
	"$comment",
	"$defs",
	"definitions", // pre-draft-2019-09 equivalent of $defs
]);

/**
 * Strip meta-declarations from a schema obj
 */
function sanitizeForOpenApi(schema: unknown): unknown {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
		return schema;
	}

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(schema)) {
		if (JSON_SCHEMA_META_DECLARATIONS.has(key)) continue;
		result[key] = sanitizeForOpenApi(value);
	}
	return result;
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * By default uses `parametersJsonSchema` which supports full JSON Schema (including
 * anyOf, oneOf, const, etc.). Set `useParameters` to true to use the legacy `parameters`
 * field instead (OpenAPI 3.03 Schema). This is needed for Cloud Code Assist with Claude
 * models, where the API translates `parameters` into Anthropic's `input_schema`.
 */
export function convertTools(
	tools: Tool[],
	useParameters = false,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				...(useParameters
					? { parameters: sanitizeForOpenApi(tool.parameters as unknown) }
					: { parametersJsonSchema: tool.parameters }),
			})),
		},
	];
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return FunctionCallingConfigMode.AUTO;
		case "none":
			return FunctionCallingConfigMode.NONE;
		case "any":
			return FunctionCallingConfigMode.ANY;
		default:
			return FunctionCallingConfigMode.AUTO;
	}
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): Extract<StopReason, "stop" | "length" | "error"> {
	switch (reason) {
		case FinishReason.STOP:
			return "stop";
		case FinishReason.MAX_TOKENS:
			return "length";
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.IMAGE_OTHER:
		case FinishReason.RECITATION:
		case FinishReason.FINISH_REASON_UNSPECIFIED:
		case FinishReason.OTHER:
		case FinishReason.LANGUAGE:
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
		case FinishReason.NO_IMAGE:
			return "error";
		default: {
			const _exhaustive: never = reason;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

/** Terminal evidence of a Gemini stream, mapped by `mapGoogleStopReason`. */
export interface GoogleStreamStop {
	finishReason: FinishReason | undefined;
	hasToolCalls: boolean;
}

/** Usage evidence of a Gemini stream, mapped by `mapGoogleUsage`. */
export interface GoogleUsageReport {
	usageMetadata: GenerateContentResponseUsageMetadata;
	hasFinishReason: boolean;
}

// Counter for generating unique tool call IDs
let toolCallCounter = 0;

/** Parse a Gemini or Vertex content stream into fragments. */
export async function parseGoogleStream(
	googleStream: AsyncIterable<GenerateContentResponse>,
	sink: ProviderStreamSink<GoogleStreamStop, GoogleUsageReport>,
): Promise<void> {
	let responseId: string | undefined;
	let nextContentIndex = 0;
	let currentBlock: { type: "text" | "thinking"; contentIndex: number; signature?: string } | undefined;
	const toolCallIds = new Set<string>();
	let hasToolCalls = false;
	let finishReason: FinishReason | undefined;

	const closeCurrentBlock = () => {
		if (!currentBlock) {
			return;
		}
		if (currentBlock.type === "text") {
			sink.push({
				type: "text_end",
				contentIndex: currentBlock.contentIndex,
				textSignature: currentBlock.signature,
			});
		} else {
			sink.push({
				type: "thinking_end",
				contentIndex: currentBlock.contentIndex,
				thinkingSignature: currentBlock.signature,
			});
		}
		currentBlock = undefined;
	};

	for await (const chunk of googleStream) {
		// @google/genai documents GenerateContentResponse.responseId as an output-only field
		// used to identify each response. Keep the first non-empty one from the stream.
		if (!responseId && chunk.responseId) {
			responseId = chunk.responseId;
			sink.push({ type: "meta", patch: { responseId } });
		}
		const candidate = chunk.candidates?.[0];
		if (candidate?.content?.parts) {
			for (const part of candidate.content.parts) {
				if (part.text !== undefined) {
					const isThinking = isThinkingPart(part);
					const blockType = isThinking ? "thinking" : "text";
					if (!currentBlock || currentBlock.type !== blockType) {
						closeCurrentBlock();
						currentBlock = { type: blockType, contentIndex: nextContentIndex++ };
						sink.push({ type: `${blockType}_start`, contentIndex: currentBlock.contentIndex });
					}
					currentBlock.signature = retainThoughtSignature(currentBlock.signature, part.thoughtSignature);
					sink.push({
						type: `${blockType}_delta`,
						contentIndex: currentBlock.contentIndex,
						delta: part.text,
					});
				}

				if (part.functionCall) {
					closeCurrentBlock();

					// Generate unique ID if not provided or if it's a duplicate
					const providedId = part.functionCall.id;
					const needsNewId = !providedId || toolCallIds.has(providedId);
					const toolCallId = needsNewId
						? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
						: providedId;
					toolCallIds.add(toolCallId);
					hasToolCalls = true;
					const contentIndex = nextContentIndex++;
					const args = (part.functionCall.args === undefined ? {} : part.functionCall.args) as JsonObject;
					const toolCall: ToolCall = {
						type: "toolCall",
						id: toolCallId,
						name: part.functionCall.name || "",
						arguments: args,
						...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
					};
					sink.push({
						type: "toolcall_start",
						contentIndex,
						id: toolCall.id,
						name: toolCall.name,
					});
					if (!sink.checkToolArgumentsObject(contentIndex, args)) return;
					sink.push({
						type: "toolcall_delta",
						contentIndex,
						argsTextDelta: JSON.stringify(args),
					});
					sink.push({ type: "toolcall_end", contentIndex, toolCall });
				}
			}
		}

		if (candidate?.finishReason) {
			finishReason = candidate.finishReason;
		}

		if (
			chunk.usageMetadata &&
			[
				chunk.usageMetadata.promptTokenCount,
				chunk.usageMetadata.candidatesTokenCount,
				chunk.usageMetadata.thoughtsTokenCount,
				chunk.usageMetadata.cachedContentTokenCount,
				chunk.usageMetadata.totalTokenCount,
			].some((value) => typeof value === "number")
		) {
			sink.usage({ usageMetadata: chunk.usageMetadata, hasFinishReason: finishReason !== undefined });
		}
	}

	closeCurrentBlock();
	sink.stop({ finishReason, hasToolCalls });
}

/** Map a Gemini stream's finish reason. `label` names the provider in the missing-finish-reason error. */
export function mapGoogleStopReason(stop: GoogleStreamStop | undefined, label: string): StopReasonMapping {
	if (!stop?.finishReason) {
		return stop?.hasToolCalls
			? { stopReason: "error", error: createProviderError("network", `${label} stream ended without finishReason`) }
			: { stopReason: "stop" };
	}
	const stopReason = mapStopReason(stop.finishReason);
	if (stopReason === "error") {
		return {
			stopReason: "error",
			error: createProviderError(finishReasonErrorKind(stop.finishReason), "An unknown error occurred", {
				providerCode: stop.finishReason,
			}),
		};
	}
	return { stopReason: stop.hasToolCalls && stopReason === "stop" ? "toolUse" : stopReason };
}

function finishReasonErrorKind(reason: FinishReason): ProviderErrorKind {
	switch (reason) {
		case FinishReason.BLOCKLIST:
		case FinishReason.PROHIBITED_CONTENT:
		case FinishReason.SPII:
		case FinishReason.SAFETY:
		case FinishReason.IMAGE_SAFETY:
		case FinishReason.IMAGE_PROHIBITED_CONTENT:
		case FinishReason.IMAGE_RECITATION:
		case FinishReason.RECITATION:
			return "refusal";
		case FinishReason.MALFORMED_FUNCTION_CALL:
		case FinishReason.UNEXPECTED_TOOL_CALL:
			return "invalid_tool_call";
		default:
			return "unknown";
	}
}

/** Map Gemini usage metadata; thoughts count as output and cached content as cache reads. */
export function mapGoogleUsage<T extends GoogleApiType>(report: GoogleUsageReport, model: Model<T>): Usage {
	const { usageMetadata, hasFinishReason } = report;
	const counts = {
		availability:
			hasFinishReason &&
			typeof usageMetadata.promptTokenCount === "number" &&
			typeof usageMetadata.candidatesTokenCount === "number"
				? "complete"
				: "partial",
		input: (usageMetadata.promptTokenCount || 0) - (usageMetadata.cachedContentTokenCount || 0),
		output: (usageMetadata.candidatesTokenCount || 0) + (usageMetadata.thoughtsTokenCount || 0),
		cacheRead: usageMetadata.cachedContentTokenCount || 0,
		cacheWrite: 0,
		totalTokens: usageMetadata.totalTokenCount || 0,
	} satisfies Omit<Usage, "cost">;
	return { ...counts, cost: calculateCost(model, counts) };
}
