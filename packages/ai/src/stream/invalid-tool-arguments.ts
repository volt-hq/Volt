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
