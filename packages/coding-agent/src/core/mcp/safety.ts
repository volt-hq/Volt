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

// Secrets in MCP text (error messages, string arguments, and the MCP audit log) are redacted by rules that each
// find the spans of secret values; `redactMcpText` masks the union of every rule's spans. No rule consumes text that
// another needs, so a rule can only add to what is redacted, and each can be read and tested on its own. Key names,
// separators, quotes, and a known authorization scheme stay visible.

// A request signature (presigned URL `X-Amz-Signature`, Azure SAS `sig`, OAuth 1.0 `oauth_signature`) grants
// access like a bearer token until it expires. Short or common names (`sig`, `pwd`, `pass`, `auth`, `jwt`,
// `session_id`) count only as whole words, so `signal`, `bypass`, `OAuth`, `author`, and `passenger` stay visible.
const SECRET_KEY_PATTERN =
	/token|secret|password|passwd|passphrase|api[-_]?key|authorization|credential|private|signature|cookie|(?<![a-z0-9])(?:sig|pwd|pass|auth|jwt|session[-_]?id)(?![a-z0-9])/i;
// An argv element that is a flag named for a secret (`--token`, `--github-token`, `-password`). In argv-style
// arrays its value is the next element, which carries no key name of its own.
const SECRET_FLAG_PATTERN = new RegExp(String.raw`^--?[\w-]*(?:${SECRET_KEY_PATTERN.source})$`, "i");
const SECRET_KEY = `(?:${SECRET_KEY_PATTERN.source})`;

// A value follows a key in one of these forms, and is redacted whatever words it holds:
// - a key name and a `:` or `=` separator; the name may end a longer one (`token: abc`, `access_token=abc`,
//   `X-Amz-Signature: abc`, `token := abc`);
// - a quoted key, as in JSON, YAML, or a Python dict, also inside a JSON-encoded string, and a separator
//   (`"access_token": "abc"`, `'token': 'abc'`, `\"token\":\"abc\"`). The separator is required, so a quoted value or
//   prose that ends in a key name (`"grant_type": "refresh_token"`) is never taken for a key;
// - the two words `API key` and a separator;
// - a command-line flag whose name ends in a key name, and whitespace (`--token abc`, `--github-token abc`,
//   `-password abc`); `--token-file /tmp/token` names no secret.
const KEYED_VALUE = new RegExp(
	String.raw`(?<key>${SECRET_KEY})(?:\\?["'][ \t]*[:=]|\s*[:=])[\s:=]*|api[ \t]+key(?:\\?["'])?[ \t]*[:=][ \t:=]*|(?<![\w-])--?[\w-]*?(?<flag>${SECRET_KEY})\s+`,
	"gi",
);
// After whitespace alone a key name is usually prose ("token endpoint", "Refresh token expired"), so the value is
// redacted only when it looks like a credential: at least 6 characters including a digit, `_`, or `-`
// (`token ghp_abc123`, `x-api-key sk-live-123`, `password hunter2`), also after a known scheme, or when it is a quoted
// string that starts like one (`password "hunter2 x"`).
const SPACED_KEY = new RegExp(String.raw`${SECRET_KEY}\s+`, "gi");
const CREDENTIAL_LIKE = /(?=[^\s,;]{6})(?=[^\s,;]*[\d_-])[^\s,;]+/y;
// A known scheme stays visible before the credential it introduces (`Bearer abc`, `Basic dXNlcjpwYXNz`, GitHub's
// `token ghp_abc`). Any other first word cannot be told apart from a credential followed by text, so it is redacted
// with the rest: after a key other than `Authorization`, a capitalized word and a word that looks like a credential
// or like Base64 together (`token: Bot MTk4NjIy.Cl2FMQ`, `secret: Negotiate YIIGhgYG`), else the first word alone.
const VISIBLE_SCHEME = /(?:bearer|basic|token)\s+/iy;
const SCHEME_WORD = /[A-Z][A-Za-z0-9-]*[ \t]+/y;
const BARE_VALUE = /[^\s,;]+/y;
/** A word that looks like a credential: 6 or more characters with a digit, `_`, `-`, or `.`. */
const CREDENTIAL_WORD = /^(?=.{6})[^\s,;]*[\d_.-]/;
/**
 * A word that looks like Base64 rather than prose: 8 or more characters of the alphabet with a digit, `+`, `/`, or
 * `=`, or with two capital letters and one right after a small letter (`dXNlcjpwYXNz`, `YIIGhgYG`; not `Yesterday`).
 */
const BASE64_WORD = /^(?=[A-Za-z0-9+/]{8,}={0,2}$)(?:.*[0-9+/=]|(?=.*[a-z][A-Z])(?=(?:.*[A-Z]){2}))/;
// An `Authorization` value is a scheme followed by a single credential or by auth-params separated by commas or, in
// some logs, by spaces, whose values may be quoted and contain spaces or commas, including JSON-encoded quoted
// strings with escaped quotes and backslashes (RFC 9110 section 11.4: `Bearer abc`, `Digest username="u",
// nonce="n", response="..."`, OAuth 1.0 `OAuth oauth_nonce="...", oauth_signature="..."`, AWS `AWS4-HMAC-SHA256
// Credential=... SignedHeaders=... Signature=...`). After `Authorization:`, `=`, or `--authorization`, it is redacted
// through its last auth-param, or else up to `,`, `;`, a quote, or the end of the line, so the credential after any
// scheme (`Bot`, `Negotiate`, `DPoP`, `ApiKey`) is covered and text after the auth-params stays readable.
const HTTP_TOKEN = String.raw`[\w!#$%&*+.^|~-]+`;
// JSON-encoded `\"...\"` values are read before raw quoted or unquoted ones, so spaces, commas, and JSON-encoded
// quoted-pairs (`\\\"` or `\\\\`) cannot end a value before later auth-params.
const AUTH_PARAM = String.raw`${HTTP_TOKEN}[ \t]*=[ \t]*(?:\\"(?:\\\\\\[\\"]|\\\\|(?!\\")[^\n])*(?:\\")?|"(?:\\.|[^"\\\n])*"?|(?:\\.|[^\s,"\\])*)`;
const AUTH_PARAMS = String.raw`${AUTH_PARAM}(?:(?:[ \t]*,[ \t]*|[ \t]+)${AUTH_PARAM})*`;
const AUTHORIZATION_VALUE = new RegExp(
	String.raw`[^\s,;"']+(?:[ \t]+(?:${AUTH_PARAMS}|[^\s,;"']+(?:[ \t]+[^\s,;"']+)*))?`,
	"y",
);
// After whitespace alone `authorization` is usually prose (`authorization server https://auth-a.example`), so only a
// scheme followed by `name=` auth-params or by one whole token68 word that looks like a credential is redacted
// (`Authorization Bot MTk4NjIy`), and the text after it stays. A word that ends in a key name and has a value after it
// (`access_token ya29...`, `X-Api-Key sk-...`) is not that credential: the rules above redact that value, and the key
// name stays readable. `Bearer` is redacted by its own
// rule below, and `Basic` with a Base64 credential, which need not look like a credential otherwise
// (`Authorization Basic dXNlcjpwYXNz`).
const TOKEN68_CREDENTIAL = String.raw`(?![\w.~+/-]*${SECRET_KEY}(?![\w.~+/-])[ \t]+[^\s])(?=[^\s,;]{6})(?=[^\s,;]*[\d_-])[\w.~+/-]+=*(?=[\s,;"')\]}>]|$)`;
const SPACED_AUTHORIZATION = new RegExp(
	String.raw`(?<![a-z0-9])authorization[ \t]+(?!(?:bearer|basic|token)\s)(${HTTP_TOKEN}[ \t]+(?:(?=${HTTP_TOKEN}=)${AUTH_PARAMS}|${TOKEN68_CREDENTIAL}))`,
	"gi",
);
const SPACED_BASIC = /(?<![a-z0-9])authorization[ \t]+basic[ \t]+([A-Za-z0-9+/]+={0,2})(?=[\s,;"')\]}>]|$)/gi;
// A bearer token is a secret wherever it appears (`sent Bearer abc123`).
const BEARER_TOKEN = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
/** The rest of a word, after a closing quote or bracket. */
const WORD_TAIL = /[^\s,;]*/y;

/** Characters of value parsing per character of text before the rest of the text is redacted unread. */
const WORK_PER_CHARACTER = 32;

/** A range of text, from `start` to before `end`. */
interface Span {
	readonly start: number;
	readonly end: number;
	/** A quoted value's text or an object or array: what ends it is known. */
	readonly bounded?: boolean;
}

/** Text that holds a letter or digit: more than punctuation. */
const REVEALING = /[\p{L}\p{N}]/u;

/**
 * The index after the string that starts at `start`, quoted with `"`, `'`, or, inside a JSON-encoded string, `\"`.
 * A raw string may span lines (a shell argument may hold a line break); one that never closes runs to the end of
 * the text. A JSON-encoded one ends at the end of its line or of the enclosing string.
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

/** The span of `pattern`, a sticky expression, matched at `start`; undefined when it does not match there. */
function stickySpan(pattern: RegExp, text: string, start: number): Span | undefined {
	pattern.lastIndex = start;
	const match = pattern.exec(text);
	return match === null || match[0].length === 0 ? undefined : { start, end: start + match[0].length };
}

/** The length of the known scheme at `start`, which stays visible, or 0. */
function visibleScheme(text: string, start: number): number {
	VISIBLE_SCHEME.lastIndex = start;
	return VISIBLE_SCHEME.exec(text)?.[0].length ?? 0;
}

/** The spans `span` makes up: none when it is undefined. */
function spansOf(span: Span | undefined): Span[] {
	return span === undefined ? [] : [span];
}

/**
 * The rest of the word at `end`, after a closing quote or bracket, when it holds more than punctuation: what reading
 * the value as one word would redact (`"abc"def`, `[x]abc`), while `"}` or `\"}` after a value stays visible.
 */
function tailSpans(text: string, end: number): Span[] {
	WORD_TAIL.lastIndex = end;
	const tail = WORD_TAIL.exec(text)?.[0] ?? "";
	return REVEALING.test(tail) ? [{ start: end, end: end + tail.length }] : [];
}

/**
 * The spans of the quoted value at `start`: the text between the quotes, after a known scheme that a credential
 * follows inside them, and the rest of the word after the closing quote (see {@link tailSpans}). Undefined when no
 * value is quoted there; none for an empty one.
 */
function quotedSpans(text: string, start: number): Span[] | undefined {
	const first = text[start];
	const quote = text.startsWith('\\"', start) ? '\\"' : first === '"' || first === "'" ? first : undefined;
	if (quote === undefined) return undefined;
	const end = skipQuoted(text, start);
	const closed = end - quote.length > start && text.startsWith(quote, end - quote.length);
	const contentStart = start + quote.length;
	const contentEnd = closed ? end - quote.length : end;
	const tail = tailSpans(text, end);
	if (contentEnd <= contentStart) return tail;
	const scheme = visibleScheme(text, contentStart);
	const content = contentStart + scheme < contentEnd ? contentStart + scheme : contentStart;
	return [{ start: content, end: contentEnd, bounded: true }, ...tail];
}

/**
 * The spans of the secret value at `start`, after a key. An `Authorization` key's value is read as one, also when
 * it starts like an object, which an Authorization value never is.
 */
function keyedValueSpans(text: string, start: number, authorization: boolean): Span[] {
	const first = text[start];
	if (first === "{" || first === "[") {
		const end = skipContainer(text, start);
		const value = authorization ? spansOf(stickySpan(AUTHORIZATION_VALUE, text, start)) : [];
		return [{ start, end, bounded: true }, ...tailSpans(text, end), ...value];
	}
	const quoted = quotedSpans(text, start);
	if (quoted !== undefined) return quoted;
	const scheme = visibleScheme(text, start);
	if (scheme > 0) {
		const credential =
			quotedSpans(text, start + scheme) ??
			spansOf(stickySpan(authorization ? AUTHORIZATION_VALUE : BARE_VALUE, text, start + scheme));
		if (credential.length > 0) return credential;
	}
	if (authorization) return spansOf(stickySpan(AUTHORIZATION_VALUE, text, start));
	const schemeWord = stickySpan(SCHEME_WORD, text, start);
	const credential = schemeWord && stickySpan(BARE_VALUE, text, schemeWord.end);
	if (credential) {
		const word = text.slice(credential.start, credential.end);
		if (CREDENTIAL_WORD.test(word) || BASE64_WORD.test(word)) return [{ start, end: credential.end }];
	}
	return spansOf(stickySpan(BARE_VALUE, text, start));
}

/**
 * The spans of a credential-like value at `start`, after a key name and whitespace alone. A quoted value is redacted
 * whole when it, or the word its opening quote starts, looks like a credential.
 */
function spacedValueSpans(text: string, start: number): Span[] {
	const at = start + visibleScheme(text, start);
	const word = stickySpan(CREDENTIAL_LIKE, text, at);
	const quoted = quotedSpans(text, at);
	if (quoted === undefined) return spansOf(word);
	const content = quoted.find((span) => span.bounded);
	return word || (content && stickySpan(CREDENTIAL_LIKE, text, content.start)) ? quoted : [];
}

/**
 * The spans of the values after keys, keyed or separated by whitespace alone. Each key is read, also one inside
 * another's value, so no value hides a later one. Past a budget of value parsing (only nested or unterminated
 * values in adversarial text get there), the rest of the text is redacted unread.
 */
function valueSpans(text: string): Span[] {
	const spans: Span[] = [];
	let budget = WORK_PER_CHARACTER * text.length + 4_096;
	const add = (found: readonly Span[]): boolean => {
		for (const span of found) {
			budget -= span.end - span.start;
			if (budget < 0) {
				spans.push({ start: span.start, end: text.length });
				return false;
			}
			spans.push(span);
		}
		return true;
	};
	KEYED_VALUE.lastIndex = 0;
	for (let match = KEYED_VALUE.exec(text); match; match = KEYED_VALUE.exec(text)) {
		const key = match.groups?.key ?? match.groups?.flag ?? "";
		const start = match.index + match[0].length;
		if (start < text.length && !add(keyedValueSpans(text, start, /^authorization$/i.test(key)))) return spans;
	}
	SPACED_KEY.lastIndex = 0;
	for (let match = SPACED_KEY.exec(text); match; match = SPACED_KEY.exec(text)) {
		if (!add(spacedValueSpans(text, match.index + match[0].length))) return spans;
	}
	return spans;
}

/** The spans of the last group of each match of `pattern`, a global expression whose match ends with that group. */
function trailingGroupSpans(pattern: RegExp, text: string): Span[] {
	const spans: Span[] = [];
	pattern.lastIndex = 0;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
		const end = match.index + match[0].length;
		const group = match[match.length - 1] ?? "";
		spans.push({ start: end - group.length, end });
	}
	return spans;
}

export function redactMcpText(value: string): string {
	const spans = [
		...valueSpans(value),
		...trailingGroupSpans(SPACED_AUTHORIZATION, value),
		...trailingGroupSpans(SPACED_BASIC, value).filter((span) => BASE64_WORD.test(value.slice(span.start, span.end))),
		...[...value.matchAll(BEARER_TOKEN)].map(
			(match): Span => ({
				start: match.index + (match[1]?.length ?? 0),
				end: match.index + match[0].length,
			}),
		),
	]
		.filter((span) => span.end > span.start)
		// A bounded span first among those that start together, so the next step sees it.
		.sort(
			(left, right) => left.start - right.start || Number(right.bounded ?? false) - Number(left.bounded ?? false),
		);
	// A span that starts inside a quoted value or an object and runs past its end only over punctuation ends with
	// it, so `{"Authorization": "token ghp_abc"}` keeps its closing `"}`: nothing past the end is a secret.
	let bound = 0;
	for (const [index, span] of spans.entries()) {
		if (span.bounded) {
			bound = Math.max(bound, span.end);
		} else if (span.start < bound && span.end > bound && !REVEALING.test(value.slice(bound, span.end))) {
			spans[index] = { start: span.start, end: bound };
		}
	}
	let result = "";
	let copied = 0;
	for (let index = 0; index < spans.length; ) {
		const start = spans[index]?.start ?? 0;
		let end = start;
		// Spans that overlap or touch are masked as one.
		for (; index < spans.length && (spans[index]?.start ?? 0) <= end; index++) {
			end = Math.max(end, spans[index]?.end ?? 0);
		}
		result += `${value.slice(copied, start)}[redacted]`;
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
