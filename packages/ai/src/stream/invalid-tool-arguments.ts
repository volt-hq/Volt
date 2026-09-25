import type { AssistantMessage, UserMessage } from "../types.ts";

/** Content-free cause of a rejected JSON argument payload. */
export interface UnescapedControlCharacter {
	reason: "unescaped_control_character";
	codePoint: number;
}

const CONTROL_CHARACTER_ESCAPES: Readonly<Record<number, readonly [name: string, escape: string]>> = {
	8: ["backspace", "\\b"],
	9: ["tab", "\\t"],
	10: ["line feed", "\\n"],
	12: ["form feed", "\\f"],
	13: ["carriage return", "\\r"],
};

/** Find the first raw control character inside a JSON string literal. Returns no payload text. */
export function findUnescapedControlCharacter(raw: string): UnescapedControlCharacter | undefined {
	let inString = false;
	let escaped = false;
	for (let index = 0; index < raw.length; index++) {
		const code = raw.charCodeAt(index);
		if (!inString) {
			if (code === 0x22) inString = true;
			continue;
		}
		if (code < 0x20) return { reason: "unescaped_control_character", codePoint: code };
		if (escaped) escaped = false;
		else if (code === 0x5c) escaped = true;
		else if (code === 0x22) inString = false;
	}
	return undefined;
}

/** Describe an unescaped control character with the JSON escape that encodes it. */
export function describeUnescapedControlCharacter(codePoint: number): string {
	const hex = codePoint.toString(16).toUpperCase().padStart(4, "0");
	const [name, encoded] = CONTROL_CHARACTER_ESCAPES[codePoint] ?? ["control character", `\\u${hex}`];
	return `an unescaped ${name} (U+${hex}) inside a JSON string; encode it as ${encoded}`;
}

/**
 * Explain a response rejected for invalid tool arguments. Provider replay omits the response itself,
 * which would otherwise hide why nothing ran; the explanation never includes the call or its arguments.
 */
export function createRejectedToolCallFeedback(message: AssistantMessage): UserMessage | undefined {
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
