import type { Api, AssistantMessage, ImageContent, Message, Model, TextContent, ToolCall } from "../types.ts";

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
 * Model-dependent normalization of replayed messages for one request, applied by providers after
 * callers applied `applyReplayPolicy`: images become placeholders for models without image input,
 * tool call IDs are normalized for the target API (OpenAI Responses IDs are 450+ characters with
 * `|`; Anthropic requires ^[a-zA-Z0-9_-]+$, at most 64 characters), and thinking from another model
 * becomes plain text or is dropped when it is opaque.
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Map original tool call IDs to normalized IDs so their results follow.
	const toolCallIdMap = new Map<string, string>();
	return downgradeUnsupportedImages(messages, model).map((msg) => {
		if (msg.role === "user") {
			return msg;
		}

		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			return normalizedId && normalizedId !== msg.toolCallId ? { ...msg, toolCallId: normalizedId } : msg;
		}

		const isSameModel = msg.provider === model.provider && msg.api === model.api && msg.model === model.id;

		const transformedContent = msg.content.flatMap((block) => {
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

			let normalizedToolCall: ToolCall = block;

			if (!isSameModel && block.thoughtSignature) {
				normalizedToolCall = { ...block };
				delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
			}

			if (!isSameModel && normalizeToolCallId) {
				const normalizedId = normalizeToolCallId(block.id, model, msg);
				if (normalizedId !== block.id) {
					toolCallIdMap.set(block.id, normalizedId);
					normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
				}
			}

			return normalizedToolCall;
		});

		return {
			...msg,
			content: transformedContent,
		};
	});
}
