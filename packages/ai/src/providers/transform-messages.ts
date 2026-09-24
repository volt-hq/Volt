import { describeUnescapedControlCharacter } from "../stream/invalid-tool-arguments.ts";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import type { ToolResultPayloadTracker } from "./tool-result-payload.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	if (model.input.includes("image")) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
			};
		}

		return msg;
	});
}

/**
 * Explain a response rejected for invalid tool arguments. Omitting the response from replay would
 * otherwise hide why nothing ran; the explanation never includes the call or its arguments.
 */
function createRejectedToolCallFeedback(message: AssistantMessage): Message | undefined {
	if (message.stopReason !== "error") return undefined;
	const diagnostic = message.diagnostics?.find((entry) => entry.type === "invalid_tool_arguments");
	if (!diagnostic) return undefined;
	const details = diagnostic.details ?? {};
	const block = typeof details.contentIndex === "number" ? message.content[details.contentIndex] : undefined;
	const target = block?.type === "toolCall" && block.name ? `the \`${block.name}\` tool call` : "a tool call";
	const codePoint = details.codePoint;
	let cause: string;
	if (
		details.reason === "unescaped_control_character" &&
		typeof codePoint === "number" &&
		Number.isInteger(codePoint) &&
		codePoint >= 0 &&
		codePoint < 0x20
	) {
		cause = `The arguments for ${target} contained ${describeUnescapedControlCharacter(codePoint)}.`;
	} else if (details.code === "length_limit") {
		cause = "It reached the output length limit before its tool calls were complete.";
	} else if (details.code === "missing_completion") {
		cause = `The provider did not complete ${target}.`;
	} else {
		cause = `The arguments for ${target} were not a complete, valid JSON object.`;
	}
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `Your previous response was discarded and none of its tool calls were executed. ${cause}`,
			},
		],
		timestamp: message.timestamp,
	};
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
	toolResultPayload?: ToolResultPayloadTracker,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	const imageAwareMessages = downgradeUnsupportedImages(messages, model);

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	const transformed = imageAwareMessages.map((msg, index) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			// A distinct object per input position keeps repeated references distinguishable.
			const result =
				toolResultPayload || (normalizedId && normalizedId !== msg.toolCallId)
					? { ...msg, toolCallId: normalizedId ?? msg.toolCallId }
					: msg;
			toolResultPayload?.recordSource(result, index);
			return result;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Redacted thinking is opaque encrypted content, only valid for the same model.
					// Drop it for cross-model to avoid API errors.
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// For same model: keep thinking blocks with signatures (needed for replay)
					// even if the thinking text is empty (OpenAI encrypted reasoning)
					if (isSameModel && block.thinkingSignature) return block;
					// Skip empty thinking blocks, convert others to plain text
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// Second pass: omit interrupted calls and their results, explain calls rejected for invalid arguments,
	// and synthesize missing results for completed calls.
	// This only changes provider replay; the original diagnostic history remains intact.
	const result: Message[] = [];
	const omittedToolCallIds = new Set<string>();
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			insertSyntheticToolResults();

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				for (const block of assistantMsg.content) {
					if (block.type === "toolCall") omittedToolCallIds.add(block.id);
				}
				// Read content indices from the untransformed message; the first pass may drop blocks.
				const feedback = createRejectedToolCallFeedback(messages[i] as AssistantMessage);
				if (feedback) result.push(feedback);
				continue;
			}

			// Track tool calls from this assistant message
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			// A later completed call can reuse an ID from an interrupted attempt.
			for (const toolCall of toolCalls) omittedToolCallIds.delete(toolCall.id);
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			// IDs have already been normalized for both calls and results in the first pass.
			if (omittedToolCallIds.has(msg.toolCallId)) continue;
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// User message interrupts tool flow - insert synthetic results for orphaned calls
			insertSyntheticToolResults();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	insertSyntheticToolResults();

	return result;
}
