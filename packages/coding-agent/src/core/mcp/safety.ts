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
// A key name may be quoted before its separator, as in JSON or a dict repr (`{"password":"abc"}`,
// `{'api_key': 'abc'}`), also with backslash-escaped quotes when the JSON is itself inside a string
// (`{\"password\":\"abc\"}`).
// A quoted value, also one whose quotes are backslash-escaped, is redacted up to its closing quote: the
// first quote escaped like the opening one and not preceded by a further backslash, or the end of the line
// when there is none (`password: "correct horse"`, `client_secret="abc,def"`, `{"password":"a\"b"}`). A
// value that ends in an escaped backslash therefore runs on to the next such quote. An unquoted value is
// redacted up to whitespace, `,`, or `;`.
// A secret value may start with an authorization scheme, optionally quoted (`token: Bearer abc`,
// `Basic dXNlcjpwYXNz`, GitHub's `token ghp_abc`, `"Bearer abc"`). The scheme stays visible and the
// credential after it is redacted.
// An `Authorization` value after `:`, `=`, or a flag is redacted up to `,`, `;`, a quote (escaped or not),
// or the end of the line, so the credential after any scheme (`Bot`, `Negotiate`, `DPoP`, `ApiKey`) is
// covered. Only the schemes above stay visible: an unknown first word cannot be told apart from a credential
// followed by text.
const SECRET_KEY = `(?:${SECRET_KEY_PATTERN.source})`;
const OPTIONAL_QUOTE = String.raw`(?:\\*["'])?`;
const AUTHORIZATION_SCHEME = String.raw`(?:bearer|basic|token)\s+`;
const AUTHORIZATION_PREFIX = String.raw`(?:authorization${OPTIONAL_QUOTE}\s*[:=][\s:=]*|(?<![\w-])--?[\w-]*?authorization\s+)${OPTIONAL_QUOTE}(?:${AUTHORIZATION_SCHEME})?`;
const AUTHORIZATION_WORD = String.raw`(?:[^\s,;"'\\]|\\+(?![\\"']))+`;
const AUTHORIZATION_VALUE = String.raw`${AUTHORIZATION_WORD}(?:[ \t]+${AUTHORIZATION_WORD})*`;
const SECRET_PREFIX = String.raw`(?:${SECRET_KEY}${OPTIONAL_QUOTE}\s*[:=][\s:=]*|(?<![\w-])--?[\w-]*?${SECRET_KEY}\s+)`;
const QUOTED_SECRET_PREFIX = String.raw`${SECRET_PREFIX}(?<quoteEscape>\\*)(?<quote>["'])(?:${AUTHORIZATION_SCHEME})?`;
const QUOTED_SECRET_VALUE = String.raw`(?:(?!(?<!\\)\k<quoteEscape>\k<quote>)[^\n])*`;
const CREDENTIAL_LIKE_VALUE = String.raw`(?=[^\s,;]{6})(?=[^\s,;]*[\d_-])`;
const SECRET_VALUE_PATTERN = new RegExp(
	String.raw`(bearer\s+)[A-Za-z0-9._~+/=-]+|(${AUTHORIZATION_PREFIX})${AUTHORIZATION_VALUE}|(${QUOTED_SECRET_PREFIX})${QUOTED_SECRET_VALUE}|(${SECRET_PREFIX}(?:${AUTHORIZATION_SCHEME})?|${SECRET_KEY}\s+(?:${AUTHORIZATION_SCHEME})?${CREDENTIAL_LIKE_VALUE})[^\s,;]+`,
	"gi",
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

export function redactMcpText(value: string): string {
	return value.replace(
		SECRET_VALUE_PATTERN,
		(
			_match,
			bearerPrefix: string | undefined,
			authorizationPrefix: string | undefined,
			quotedPrefix: string | undefined,
			_quoteEscape: string | undefined,
			_quote: string | undefined,
			keyPrefix: string | undefined,
		) => {
			if (bearerPrefix) {
				return `${bearerPrefix}[redacted]`;
			}
			if (authorizationPrefix) {
				return `${authorizationPrefix}[redacted]`;
			}
			if (quotedPrefix) {
				return `${quotedPrefix}[redacted]`;
			}
			if (keyPrefix) {
				return `${keyPrefix}[redacted]`;
			}
			return "[redacted]";
		},
	);
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
