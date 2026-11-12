import { Buffer, isUtf8 } from "node:buffer";

declare const reviewPathIdentity: unique symbol;

/** A byte-reversible Git path reference, not an OS filename or a display label. */
export type ReviewPath = string & { readonly [reviewPathIdentity]: true };

const ESCAPED_CHARACTERS = /[%\\:\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

/** Construct a canonical reference from the exact bytes Git returned. No Unicode normalization is performed. */
export function reviewPathFromBytes(value: Uint8Array): ReviewPath {
	const bytes = Buffer.from(value);
	if (bytes.length === 0 || bytes.includes(0)) throw new Error("Review paths must be nonempty and contain no NUL.");
	let start = 0;
	for (let index = 0; index <= bytes.length; index++) {
		if (index !== bytes.length && bytes[index] !== 47) continue;
		const component = bytes.subarray(start, index);
		if (component.length === 0 || (component.length <= 2 && component.every((byte) => byte === 46))) {
			throw new Error("Review paths must be relative and must not traverse empty, dot, or parent components.");
		}
		start = index + 1;
	}
	let reference = "";
	for (let index = 0; index < bytes.length; ) {
		const first = bytes[index];
		const length =
			first < 0x80
				? 1
				: first >= 0xc2 && first <= 0xdf
					? 2
					: first >= 0xe0 && first <= 0xef
						? 3
						: first >= 0xf0 && first <= 0xf4
							? 4
							: 1;
		const sequence = bytes.subarray(index, index + length);
		if (sequence.length !== length || !isUtf8(sequence)) {
			reference += `%${first.toString(16).toUpperCase().padStart(2, "0")}`;
			index++;
			continue;
		}
		const character = sequence.toString("utf8");
		reference += ESCAPED_CHARACTERS.test(character)
			? [...sequence].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`).join("")
			: character;
		index += length;
	}
	return reference as ReviewPath;
}

/** Decode a canonical reference. Aliases and escaped separators are refused, not silently normalized. */
export function reviewPathBytes(reference: string): Buffer {
	const parts: Buffer[] = [];
	for (let index = 0; index < reference.length; ) {
		if (reference[index] === "%") {
			const hex = reference.slice(index + 1, index + 3);
			if (!/^[0-9A-F]{2}$/.test(hex)) throw new Error("Review paths require uppercase %HH byte escapes.");
			const byte = Number.parseInt(hex, 16);
			if (byte === 47) throw new Error("Review paths must not contain an encoded slash.");
			parts.push(Buffer.from([byte]));
			index += 3;
		} else {
			const code = reference.codePointAt(index);
			if (code === undefined || (code >= 0xd800 && code <= 0xdfff)) {
				throw new Error("Review paths must not contain lone surrogates.");
			}
			const character = String.fromCodePoint(code);
			parts.push(Buffer.from(character, "utf8"));
			index += character.length;
		}
	}
	const bytes = Buffer.concat(parts);
	if (reviewPathFromBytes(bytes) !== reference) throw new Error("Review path is not canonical.");
	return bytes;
}

/** Encode an actual UTF-8 filename (for example from a checkout tool), not an already encoded reference. */
export function reviewPathFromUtf8(filename: string): ReviewPath {
	for (const character of filename) {
		const code = character.codePointAt(0)!;
		if (code >= 0xd800 && code <= 0xdfff) throw new Error("Review paths must not contain lone surrogates.");
	}
	return reviewPathFromBytes(Buffer.from(filename, "utf8"));
}

/** A native filename for a UTF-8-only boundary, or undefined when that boundary cannot represent the path. */
export function reviewPathToUtf8(reference: string): string | undefined {
	const bytes = reviewPathBytes(reference);
	return isUtf8(bytes) ? bytes.toString("utf8") : undefined;
}

/** Display only: quoting prevents control characters from affecting the terminal. Never use the result as identity. */
export function formatReviewPath(reference: string): string {
	return JSON.stringify(reviewPathToUtf8(reference) ?? reference).replace(
		/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
		(character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
	);
}

/** Normalize only optional repository-relative spelling, never filename bytes or backslashes. */
export function normalizeReviewPath(reference: string): ReviewPath {
	const normalized = reference.replace(/^\.\//, "").replace(/\/+$/, "");
	reviewPathBytes(normalized);
	return normalized as ReviewPath;
}
