/**
 * Transcript comparison for the spike's acceptance checks: the complete
 * expected phrase must appear, in order, in the provider's user transcript.
 * Only booleans and ratios derived here are written to the report.
 */

const DIGIT_WORDS: Record<string, string> = {
	"0": "zero",
	"1": "one",
	"2": "two",
	"3": "three",
	"4": "four",
	"5": "five",
	"6": "six",
	"7": "seven",
	"8": "eight",
	"9": "nine",
};

export function normalizeTokens(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[0-9]/g, (digit) => ` ${DIGIT_WORDS[digit] ?? digit} `)
		.replace(/[^a-z\s]/g, " ")
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

export interface TranscriptMatch {
	/** Every expected token appears in order. */
	readonly matched: boolean;
	/** Fraction of expected tokens found in order (longest in-order prefix walk). */
	readonly coverage: number;
	readonly expectedTokens: number;
	readonly actualTokens: number;
}

export function matchTranscript(expected: string, actual: string): TranscriptMatch {
	const expectedTokens = normalizeTokens(expected);
	const actualTokens = normalizeTokens(actual);
	let found = 0;
	let cursor = 0;
	for (const token of expectedTokens) {
		const index = actualTokens.indexOf(token, cursor);
		if (index === -1) continue;
		found += 1;
		cursor = index + 1;
	}
	return {
		matched: expectedTokens.length > 0 && found === expectedTokens.length,
		coverage: expectedTokens.length === 0 ? 0 : found / expectedTokens.length,
		expectedTokens: expectedTokens.length,
		actualTokens: actualTokens.length,
	};
}

/** Whether a distinctive marker (any of its spellings) appears in the text. */
export function containsMarker(text: string, markers: readonly string[]): boolean {
	const tokens = normalizeTokens(text).join(" ");
	return markers.some((marker) => tokens.includes(normalizeTokens(marker).join(" ")));
}
