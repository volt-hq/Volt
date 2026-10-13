import type { Tool as SdkTool } from "@modelcontextprotocol/sdk/types.js";
import type { McpRisk } from "./types.ts";

const TOKEN_START = "(?:^|[^a-z0-9])";
const TOKEN_END = "(?:$|[^a-z0-9])";
const DESTRUCTIVE_VERBS = [
	"delet(?:e|es|ed|ing)",
	"remov(?:e|es|ed|ing)",
	"rm",
	"destroy(?:s|ed|ing)?",
	"drop(?:s|ped|ping)?",
	"truncat(?:e|es|ed|ing)",
	"eras(?:e|es|ed|ing)",
	"reset(?:s|ting)?",
	"revok(?:e|es|ed|ing)",
	"terminat(?:e|es|ed|ing)",
	"kill(?:s|ed|ing)?",
	"purg(?:e|es|ed|ing)",
	"archiv(?:e|es|ed|ing)",
	"unarchiv(?:e|es|ed|ing)",
];
const WRITE_VERBS = [
	"creat(?:e|es|ed|ing)",
	"updat(?:e|es|ed|ing)",
	"writ(?:e|es|ten|ing)",
	"edit(?:s|ed|ing)?",
	"patch(?:es|ed|ing)?",
	"post(?:s|ed|ing)?",
	"put(?:s|ting)?",
	"send(?:s|ing)?",
	"sent",
	"submit(?:s|ted|ting)?",
	"comment(?:s|ed|ing)?",
	"merg(?:e|es|ed|ing)",
	"commit(?:s|ted|ting)?",
	"push(?:es|ed|ing)?",
	"publish(?:es|ed|ing)?",
	"upload(?:s|ed|ing)?",
	"insert(?:s|ed|ing)?",
	"set(?:s|ting)?",
	"add(?:s|ed|ing)?",
	"assign(?:s|ed|ing)?",
	"clos(?:e|es|ed|ing)",
	"reopen(?:s|ed|ing)?",
	"approv(?:e|es|ed|ing)",
	"reject(?:s|ed|ing)?",
	"execut(?:e|es|ed|ing)",
	"run(?:s|ning)?",
	"ran",
	"invok(?:e|es|ed|ing)",
	"trigger(?:s|ed|ing)?",
	"enabl(?:e|es|ed|ing)",
	"disabl(?:e|es|ed|ing)",
	"start(?:s|ed|ing)?",
	"stop(?:s|ped|ping)?",
	"cancel(?:s|ed|ing|led|ling)?",
];
const DESTRUCTIVE_NAME_PATTERN = new RegExp(`${TOKEN_START}(?:${DESTRUCTIVE_VERBS.join("|")})${TOKEN_END}`, "i");
const WRITE_NAME_PATTERN = new RegExp(`${TOKEN_START}(?:${WRITE_VERBS.join("|")})${TOKEN_END}`, "i");
const READ_NAME_PATTERN = new RegExp(
	`${TOKEN_START}(read|get|list|search|find|query|fetch|lookup|inspect|describe|show|view|download)${TOKEN_END}`,
	"i",
);
// A request signature (presigned URL `X-Amz-Signature`, Azure SAS `sig`, OAuth 1.0 `oauth_signature`) grants
// access like a bearer token until it expires. `sig` counts only as a whole word, so `signal` stays visible.
const SECRET_KEY_PATTERN =
	/token|secret|password|passwd|api[-_]?key|authorization|credential|private|signature|(?<![a-z0-9])sig(?![a-z0-9])/i;
// An argv element that is a flag named for a secret (`--token`, `--github-token`, `-password`). In argv-style
// arrays its value is the next element, which carries no key name of its own.
const SECRET_FLAG_PATTERN = new RegExp(String.raw`^--?[\w-]*(?:${SECRET_KEY_PATTERN.source})$`, "i");
// Secret key names are also ordinary prose ("token endpoint", "Refresh token expired"). A value is always
// redacted after a `:` or `=` separator (`token: abc`, `api_key=abc`) or after a command-line flag whose
// name ends in a key name (`--token abc`, `--github-token abc`). After whitespace alone it is redacted only
// when it looks like a credential: at least 6 characters including a digit, `_`, or `-`
// (`token ghp_abc123`, `x-api-key sk-live-123`, `password hunter2`).
// A secret value may start with an authorization scheme, optionally quoted (`token: Bearer abc`,
// `Basic dXNlcjpwYXNz`, GitHub's `token ghp_abc`, `"Bearer abc"`). The scheme stays visible and the
// credential after it is redacted.
// An `Authorization` value is a scheme followed by a single credential or by auth-params separated by commas
// or, in some logs, by spaces, whose values may be quoted and contain spaces or commas, including JSON-encoded
// quoted strings with escaped quotes and backslashes (RFC 9110 section 11.4: `Bearer
// abc`, `Digest username="u", nonce="n", response="..."`, OAuth 1.0 `OAuth oauth_nonce="...",
// oauth_signature="..."`, AWS `AWS4-HMAC-SHA256 Credential=... SignedHeaders=... Signature=...`). After `:`, `=`,
// or a flag, optionally inside quotes, it is redacted through its last auth-param, or else up to `,`, `;`, a
// quote, or the end of the line, so the credential after any scheme (`Bot`, `Negotiate`, `DPoP`, `ApiKey`) is
// covered. Only the schemes above stay visible: an unknown first word cannot be told apart from a credential
// followed by text. After whitespace alone `authorization` is usually prose (`authorization server
// https://auth-a.example`), so only a scheme followed by `name=` auth-params or by one whole token68 word that
// looks like a credential is redacted (`Authorization Bot MTk4NjIy`), and the text after it stays. A word that
// ends in a key name (`access_token`, `X-Api-Key`) is not that credential, so the key path below still
// redacts the value after it. The visible schemes are left to the key path as well.
// A key may also be quoted, as in JSON, YAML, or a Python dict (`"access_token": "abc"`, `'token': 'abc'`), also
// inside a JSON-encoded string (`\"token\": \"abc\"`), or be the two words `API key`. Such a key needs an explicit
// `:` or `=`, so a quoted value or prose that ends in a key name (`"grant_type": "refresh_token"`) is never taken
// for one; the value may start on the next line after a quoted key. The value after it is redacted whole: a quoted
// string through its closing quote, keeping the quotes and a leading scheme above with a credential after it
// (`"Bearer [redacted]"`); an object or array through its closing bracket, whatever its keys; any other value like the
// value of an unquoted key. A rule above that starts in such a value and reads past its end into more than closing
// punctuation applies instead, from where it starts (`API key: private sk-abc`), so the value never hides it.
const SECRET_KEY = `(?:${SECRET_KEY_PATTERN.source})`;
const AUTHORIZATION_SCHEME = String.raw`(?:bearer|basic|token)\s+`;
const SECRET_PREFIX = String.raw`(?:${SECRET_KEY}\s*[:=][\s:=]*|(?<![\w-])--?[\w-]*?${SECRET_KEY}\s+)(?:["']?${AUTHORIZATION_SCHEME})?`;
const CREDENTIAL_LIKE_VALUE = String.raw`(?=[^\s,;]{6})(?=[^\s,;]*[\d_-])`;
const HTTP_TOKEN = String.raw`[\w!#$%&*+.^|~-]+`;
// Read JSON-encoded `\"...\"` values before raw quoted or unquoted values, so spaces, commas, and
// JSON-encoded quoted-pairs (`\\\"` or `\\\\`) cannot end a value before later auth-params.
const AUTH_PARAM = String.raw`${HTTP_TOKEN}[ \t]*=[ \t]*(?:\\"(?:\\\\\\[\\"]|\\\\|(?!\\")[^\n])*(?:\\")?|"(?:\\.|[^"\\\n])*"?|(?:\\.|[^\s,"\\])*)`;
const AUTH_PARAMS = String.raw`${AUTH_PARAM}(?:(?:[ \t]*,[ \t]*|[ \t]+)${AUTH_PARAM})*`;
const TOKEN68_CREDENTIAL = String.raw`(?![\w.~+/-]*${SECRET_KEY}(?![\w.~+/-]))${CREDENTIAL_LIKE_VALUE}[\w.~+/-]+=*(?=[\s,;"')\]}>]|$)`;
const AUTHORIZATION_PREFIX = String.raw`(?:authorization\s*[:=][\s:=]*|(?<![\w-])--?[\w-]*?authorization\s+)["']?(?:${AUTHORIZATION_SCHEME})?`;
const AUTHORIZATION_VALUE = String.raw`[^\s,;"']+(?:[ \t]+(?:${AUTH_PARAMS}|[^\s,;"']+(?:[ \t]+[^\s,;"']+)*))?`;
const AUTHORIZATION_SPACE_PREFIX = String.raw`(?<![a-z0-9])authorization[ \t]+(?!${AUTHORIZATION_SCHEME})`;
const AUTHORIZATION_SPACE_VALUE = String.raw`${HTTP_TOKEN}[ \t]+(?:(?=${HTTP_TOKEN}=)${AUTH_PARAMS}|${TOKEN68_CREDENTIAL})`;
const EXPLICIT_KEY_PREFIX = String.raw`(?:${SECRET_KEY}\\?["'][ \t]*[:=]\s*|api[ \t]+key(?:\\?["'])?[ \t]*[:=][ \t]*)`;
const BEARER_VALUE = String.raw`(?<bearerPrefix>bearer\s+)[A-Za-z0-9._~+/=-]+`;
const AUTHORIZATION_KEY_VALUE = String.raw`(?<authorizationPrefix>${AUTHORIZATION_PREFIX})${AUTHORIZATION_VALUE}`;
const AUTHORIZATION_SPACE_KEY_VALUE = String.raw`(?<authorizationSpacePrefix>${AUTHORIZATION_SPACE_PREFIX})${AUTHORIZATION_SPACE_VALUE}`;
const KEY_VALUE = String.raw`(?<keyPrefix>${SECRET_PREFIX}|${SECRET_KEY}\s+(?:${AUTHORIZATION_SCHEME})?${CREDENTIAL_LIKE_VALUE})[^\s,;]+`;
const SECRET_VALUE_PATTERN = new RegExp(
	`${BEARER_VALUE}|${AUTHORIZATION_KEY_VALUE}|${AUTHORIZATION_SPACE_KEY_VALUE}|(?<explicitKeyPrefix>${EXPLICIT_KEY_PREFIX})|${KEY_VALUE}`,
	"gi",
);
const OTHER_VALUE_PATTERN = new RegExp(
	`${BEARER_VALUE}|${AUTHORIZATION_KEY_VALUE}|${AUTHORIZATION_SPACE_KEY_VALUE}|${KEY_VALUE}`,
	"gi",
);
const VISIBLE_SCHEME = new RegExp(AUTHORIZATION_SCHEME, "iy");
const QUOTED_VALUE_END = /[\s,;:)\]}\\"']/;
const BARE_VALUE = new RegExp(String.raw`(?<scheme>${AUTHORIZATION_SCHEME})?[^\s,;]+`, "iy");
const BARE_AUTHORIZATION_VALUE = new RegExp(
	String.raw`(?<scheme>${AUTHORIZATION_SCHEME})?${AUTHORIZATION_VALUE}`,
	"iy",
);
/** Text that holds a letter or digit: more than punctuation, so a rule that redacts it hides something. */
const REVEALING = /[\p{L}\p{N}]/u;

function tokenizeRiskText(value: string): string {
	return value
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[^a-zA-Z0-9]+/g, " ")
		.trim();
}

export function classifyMcpToolRisk(tool: Pick<SdkTool, "name" | "description" | "annotations">): McpRisk {
	if (tool.annotations?.destructiveHint === true) {
		return "destructive";
	}
	const haystack = tokenizeRiskText(`${tool.name} ${tool.description ?? ""}`);
	if (DESTRUCTIVE_NAME_PATTERN.test(haystack)) {
		return "destructive";
	}
	if (WRITE_NAME_PATTERN.test(haystack)) {
		return "write";
	}
	if (READ_NAME_PATTERN.test(haystack)) {
		return "read";
	}
	if (tool.annotations?.readOnlyHint === true) {
		return "read";
	}
	return "unknown";
}

export function isMcpToolTrustedReadCandidate(tool: Pick<SdkTool, "name" | "description" | "annotations">): boolean {
	return tool.annotations?.readOnlyHint === true && classifyMcpToolRisk(tool) === "read";
}

/**
 * The index after the string that starts at `start`, quoted with `"`, `'`, or, inside a JSON-encoded string, `\"`.
 * An unterminated string ends at the end of its line.
 */
function skipQuoted(text: string, start: number): number {
	if (text.startsWith('\\"', start)) {
		// One level of JSON escaping: `\\` is a backslash of the string and `\"` its quote, so `\\\"` is an escaped
		// quote inside it. A bare `"` ends the enclosing string.
		let escaped = false;
		let index = start + 2;
		while (index < text.length && text[index] !== '"' && text[index] !== "\n") {
			const decoded = text[index] === "\\" ? text[index + 1] : text[index];
			index += text[index] === "\\" ? 2 : 1;
			if (escaped) {
				escaped = false;
			} else if (decoded === "\\") {
				escaped = true;
			} else if (decoded === '"') {
				return index;
			}
		}
		return Math.min(index, text.length);
	}
	const quote = text[start];
	for (let index = start + 1; index < text.length; index++) {
		if (text[index] === "\\") {
			index++;
		} else if (text[index] === quote) {
			return index + 1;
		} else if (text[index] === "\n") {
			return index;
		}
	}
	return text.length;
}

/** The index after the object or array that starts at `start`, or the end of `text` when it does not close. */
function skipContainer(text: string, start: number): number {
	let depth = 0;
	let index = start;
	while (index < text.length) {
		const char = text[index];
		if (char === '"' || char === "'" || text.startsWith('\\"', index)) {
			index = skipQuoted(text, index);
			continue;
		}
		if (char === "{" || char === "[") {
			depth++;
		} else if ((char === "}" || char === "]") && --depth === 0) {
			return index + 1;
		}
		index++;
	}
	return text.length;
}

/**
 * The leftmost match of the rules other than an explicit key's at or after a position of `text`. One redaction asks
 * from positions that mostly move forward, and the leftmost match from an earlier position is also the leftmost from
 * a later one it does not start before, so a text with many explicit keys is not scanned to its end for each.
 */
function otherMatches(text: string): (from: number) => RegExpExecArray | null {
	let found: { from: number; match: RegExpExecArray | null } | undefined;
	return (from) => {
		if (found !== undefined && found.from <= from && (found.match === null || found.match.index >= from)) {
			return found.match;
		}
		OTHER_VALUE_PATTERN.lastIndex = from;
		found = { from, match: OTHER_VALUE_PATTERN.exec(text) };
		return found.match;
	};
}

/**
 * The redacted form of the value at `start` after a quoted key or `API key`, and the index after the value, unless a
 * rule other than an explicit key's starts in the value and reads past its end into more than punctuation: then the
 * value is redacted only up to where that rule starts, which applies from there, or not at all when only punctuation
 * comes before it.
 */
function redactExplicitKeyValue(
	text: string,
	start: number,
	authorization: boolean,
	others: (from: number) => RegExpExecArray | null,
): { text: string; end: number } | undefined {
	const value = explicitKeyValue(text, start, authorization);
	if (value === undefined) return undefined;
	for (
		let other = others(start);
		other !== null && other.index < value.end;
		other = others(other.index + other[0].length)
	) {
		const otherEnd = other.index + other[0].length;
		if (otherEnd > value.end && REVEALING.test(text.slice(value.end, otherEnd))) {
			return REVEALING.test(text.slice(start, other.index)) ? { text: "[redacted]", end: other.index } : undefined;
		}
	}
	return value;
}

/**
 * The redacted form of the value at `start` after a quoted key or `API key`, and the index after the value. A bare
 * value after an `authorization` key is redacted like one after `Authorization:`.
 */
function explicitKeyValue(
	text: string,
	start: number,
	authorization: boolean,
): { text: string; end: number } | undefined {
	const first = text[start];
	if (first === "{" || first === "[") {
		return { text: "[redacted]", end: skipContainer(text, start) };
	}
	const quote = text.startsWith('\\"', start) ? '\\"' : first === '"' || first === "'" ? first : undefined;
	const end = quote === undefined ? 0 : skipQuoted(text, start);
	const closed = quote !== undefined && end - quote.length > start && text.startsWith(quote, end - quote.length);
	// A closing quote that more of a word follows (`"Bearer "abc`) does not end the value, which is then read as bare.
	if (quote !== undefined && (!closed || end === text.length || QUOTED_VALUE_END.test(text[end]))) {
		const contentStart = start + quote.length;
		const contentEnd = closed ? end - quote.length : end;
		if (contentEnd <= contentStart) {
			return undefined;
		}
		VISIBLE_SCHEME.lastIndex = contentStart;
		const scheme = VISIBLE_SCHEME.exec(text)?.[0] ?? "";
		// Kept only with a credential after it inside the quotes.
		const visible = contentStart + scheme.length < contentEnd ? scheme : "";
		return { text: `${quote}${visible}[redacted]${closed ? quote : ""}`, end };
	}
	const barePattern = authorization ? BARE_AUTHORIZATION_VALUE : BARE_VALUE;
	barePattern.lastIndex = start;
	const bare = barePattern.exec(text);
	return bare ? { text: `${bare.groups?.scheme ?? ""}[redacted]`, end: start + bare[0].length } : undefined;
}

export function redactMcpText(value: string): string {
	let result = "";
	let copied = 0;
	const others = otherMatches(value);
	SECRET_VALUE_PATTERN.lastIndex = 0;
	for (let match = SECRET_VALUE_PATTERN.exec(value); match; match = SECRET_VALUE_PATTERN.exec(value)) {
		const { bearerPrefix, authorizationPrefix, authorizationSpacePrefix, explicitKeyPrefix, keyPrefix } =
			match.groups ?? {};
		let replacement = `${bearerPrefix ?? authorizationPrefix ?? authorizationSpacePrefix ?? keyPrefix ?? ""}[redacted]`;
		let end = match.index + match[0].length;
		if (explicitKeyPrefix !== undefined) {
			const secret = redactExplicitKeyValue(value, end, /authorization/i.test(explicitKeyPrefix), others);
			if (!secret) {
				continue;
			}
			replacement = `${explicitKeyPrefix}${secret.text}`;
			end = secret.end;
			SECRET_VALUE_PATTERN.lastIndex = end;
		}
		result += value.slice(copied, match.index) + replacement;
		copied = end;
	}
	return result + value.slice(copied);
}

export function sanitizeMcpArguments(value: unknown, depth = 0): unknown {
	if (depth > 4) {
		return "[redacted: nested]";
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		return redactMcpText(value);
	}
	if (Array.isArray(value)) {
		return value.slice(0, 20).map((entry, index, entries) => {
			const previous = entries[index - 1];
			return typeof previous === "string" && SECRET_FLAG_PATTERN.test(previous)
				? "[redacted]"
				: sanitizeMcpArguments(entry, depth + 1);
		});
	}
	if (typeof value !== "object") {
		return String(value);
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			result[key] = "[redacted]";
		} else {
			result[key] = sanitizeMcpArguments(entry, depth + 1);
		}
	}
	return result;
}
