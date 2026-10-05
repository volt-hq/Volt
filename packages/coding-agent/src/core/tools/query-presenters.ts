/**
 * Presenters of the built-in tools that query something and report it
 * (RFC §8.3, Q9): grep, find, ls, lsp, inspect, web_search, web_fetch, the
 * mcp gateway, and request_user_input. Each is a pure function of the call:
 * it reads its arguments and the result's details defensively (arguments
 * stream in incomplete and may hold values of the wrong type), shows paths
 * as the call spells them, and shows output as terminal lines, so ANSI
 * styling becomes semantic tokens and long output is trimmed from its oldest
 * lines when a presentation must fit a bound.
 */

import type { UiNode, UiNodeStyledText, UiNodeToken } from "@hansjm10/volt-protocol";
import { stripTerminalControls } from "../ui/ansi-tokens.ts";
import { outputLines, resultText, type ToolPresenter, type ToolPresentInput } from "../ui/presentation.ts";
import type { LspToolDetails } from "./lsp.ts";
import {
	type Args,
	activityOf,
	argSpan,
	byteLimitText,
	codeLines,
	failureOutput,
	isFailed,
	isRecord,
	linesOutput,
	moreLines,
	numberArg,
	oneLine,
	plainText,
	presentationOf,
	type StyledSpans,
	textNode,
	titleSpans,
	truncatedWarning,
	truncationOf,
	warningNode,
} from "./present-utils.ts";
import { formatSize } from "./truncate.ts";
import type { WebFetchToolDetails } from "./web-fetch.ts";
import type { WebSearchResult } from "./web-search.ts";

export { presentInspect } from "./inspect.ts";

/** Lines grep shows collapsed. */
const GREP_SUMMARY_LINES = 15;
/** Paths find shows collapsed. */
const FIND_SUMMARY_LINES = 20;
/** Entries ls shows collapsed. */
const LS_SUMMARY_LINES = 20;
/** Lines or diagnostics lsp shows collapsed. */
const LSP_SUMMARY_LINES = 10;
/** Lines web_search and web_fetch show collapsed when they show text. */
const WEB_SUMMARY_LINES = 16;
/** Result titles web_search lists collapsed. */
const WEB_SEARCH_SUMMARY_RESULTS = 5;
/** Lines of an mcp result's JSON shown collapsed. */
const MCP_SUMMARY_LINES = 18;

// ============================================================================
// Shared pieces
// ============================================================================

/** Output a tool ended with its notices in a `\n\n[…]` footer, without that footer when the details show them. */
function withoutNoticeFooter(text: string, hasNotice: boolean): string {
	return hasNotice ? text.replace(/\n\n\[[^\n]*\]\s*$/, "") : text;
}

function plural(count: number, singular: string, pluralText = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralText}`;
}

// ============================================================================
// grep, find, ls
// ============================================================================

/** grep: the pattern, path, glob, and limit; the match count; the matching lines (collapsed, the first 15); truncation. */
export const presentGrep: ToolPresenter = (input) => {
	const { args } = input;
	const pattern = argSpan(args, "pattern");
	const patternSpan = pattern.token === "accent" ? { ...pattern, text: `/${pattern.text}/` } : pattern;
	const spans: StyledSpans = [patternSpan, { text: "in" }, argSpan(args, "path", "text", ".")];
	const glob = args.glob;
	if (typeof glob === "string" && glob) spans.push({ text: `(${oneLine(glob)})` });
	const limit = numberArg(args, "limit");
	if (limit !== undefined) spans.push({ text: `limit ${limit}` });
	const titleText = titleSpans("grep", ...spans);
	if (input.state !== "done") return presentationOf(titleText, { showsDuration: true });
	if (isFailed(input))
		return presentationOf(titleText, { ...failureOutput(input, GREP_SUMMARY_LINES), showsDuration: true });
	const details = isRecord(input.result?.details) ? input.result.details : {};
	const matchLimit = numberArg(details, "matchLimitReached");
	const truncation = truncationOf(details);
	const linesTruncated = details.linesTruncated === true;
	const reasons = [
		...(matchLimit === undefined ? [] : [`${matchLimit} matches limit`]),
		...(truncation === undefined ? [] : [`${byteLimitText(truncation)} limit`]),
		...(linesTruncated ? ["some lines truncated"] : []),
	];
	const text = withoutNoticeFooter(resultText(input.result), reasons.length > 0).trim();
	if (text === "No matches found") {
		return presentationOf(titleText, {
			summary: [textNode("count", "No matches found", "muted")],
			showsDuration: true,
		});
	}
	const lines = outputLines(text);
	const matches = lines.filter((line) => /^.+?:\d+: /.test(plainText(line))).length;
	const count = textNode(
		"count",
		`${plural(matches, "match", "matches")}${matchLimit === undefined ? "" : " (limit reached)"}`,
		"muted",
	);
	return presentationOf(titleText, {
		...linesOutput(lines, GREP_SUMMARY_LINES, [count], truncatedWarning(reasons)),
		showsDuration: true,
	});
};

/** find: the pattern, path, and limit; the count; the paths found (collapsed, a list of the first 20); truncation. */
export const presentFind: ToolPresenter = (input) => {
	const { args } = input;
	const spans: StyledSpans = [argSpan(args, "pattern"), { text: "in" }, argSpan(args, "path", "text", ".")];
	const limit = numberArg(args, "limit");
	if (limit !== undefined) spans.push({ text: `(limit ${limit})` });
	const titleText = titleSpans("find", ...spans);
	if (input.state !== "done") return presentationOf(titleText, { showsDuration: true });
	if (isFailed(input))
		return presentationOf(titleText, { ...failureOutput(input, FIND_SUMMARY_LINES), showsDuration: true });
	const details = isRecord(input.result?.details) ? input.result.details : {};
	const resultLimit = numberArg(details, "resultLimitReached");
	const truncation = truncationOf(details);
	const reasons = [
		...(resultLimit === undefined ? [] : [`${resultLimit} results limit`]),
		...(truncation === undefined ? [] : [`${byteLimitText(truncation)} limit`]),
	];
	const text = withoutNoticeFooter(resultText(input.result), reasons.length > 0).trim();
	if (text === "No files found matching pattern" || text === "") {
		return presentationOf(titleText, {
			summary: [textNode("count", text || "No files found", "muted")],
			showsDuration: true,
		});
	}
	const paths = codeLines(text);
	const count = textNode(
		"count",
		`${plural(paths.length, "file")}${resultLimit === undefined ? "" : " (limit reached)"}`,
		"muted",
	);
	const warnings = truncatedWarning(reasons);
	const shown = paths.slice(0, FIND_SUMMARY_LINES);
	const summary: UiNode[] = [
		count,
		{
			type: "list",
			key: "paths",
			items: shown.map((path, index) => textNode(`path:${index}`, path)),
		},
		...moreLines(shown.length, paths.length),
		...warnings,
	];
	// Every path as terminal lines, which a bounded presentation trims from its oldest.
	const body: UiNode[] =
		paths.length <= FIND_SUMMARY_LINES ? [] : [count, { type: "terminal", key: "paths", lines: paths }, ...warnings];
	return presentationOf(titleText, { summary, body, showsDuration: true });
};

/** ls: the path and limit; the entries (collapsed, the first 20); truncation. */
export const presentLs: ToolPresenter = (input) => {
	const { args } = input;
	const spans: StyledSpans = [argSpan(args, "path", "accent", ".")];
	const limit = numberArg(args, "limit");
	if (limit !== undefined) spans.push({ text: `(limit ${limit})` });
	const titleText = titleSpans("ls", ...spans);
	if (input.state !== "done") return presentationOf(titleText, { showsDuration: true });
	if (isFailed(input))
		return presentationOf(titleText, { ...failureOutput(input, LS_SUMMARY_LINES), showsDuration: true });
	const details = isRecord(input.result?.details) ? input.result.details : {};
	const entryLimit = numberArg(details, "entryLimitReached");
	const truncation = truncationOf(details);
	const reasons = [
		...(entryLimit === undefined ? [] : [`${entryLimit} entries limit`]),
		...(truncation === undefined ? [] : [`${byteLimitText(truncation)} limit`]),
	];
	const text = withoutNoticeFooter(resultText(input.result), reasons.length > 0).trim();
	if (text === "(empty directory)") {
		return presentationOf(titleText, { summary: [textNode("empty", text, "muted")], showsDuration: true });
	}
	return presentationOf(titleText, {
		...linesOutput(outputLines(text), LS_SUMMARY_LINES, [], truncatedWarning(reasons)),
		showsDuration: true,
	});
};

// ============================================================================
// lsp
// ============================================================================

const SEVERITY_TOKENS: Readonly<Record<string, UiNodeToken>> = {
	error: "error",
	warning: "warning",
	info: "info",
	hint: "muted",
};

/** One diagnostic line as the LSP manager writes it: `path(line,col): severity: message [source code]`. */
const DIAGNOSTIC_LINE = /^(.*)\((\d+),(\d+)\): (error|warning|info|hint): (.*)$/;

interface DiagnosticRow {
	readonly location: string;
	readonly severity: string;
	readonly message: string;
}

/** Diagnostics output as table rows, with the lines around them; undefined when no line is a diagnostic. */
function diagnosticRows(text: string): { before: string[]; rows: DiagnosticRow[]; after: string[] } | undefined {
	const before: string[] = [];
	const rows: DiagnosticRow[] = [];
	const after: string[] = [];
	for (const line of codeLines(stripTerminalControls(text))) {
		const match = DIAGNOSTIC_LINE.exec(line);
		if (match) {
			const [, path, row, column, severity, message] = match as unknown as [
				string,
				string,
				string,
				string,
				string,
				string,
			];
			rows.push({ location: `${path}:${row}:${column}`, severity, message });
		} else if (line.trim()) {
			(rows.length === 0 ? before : after).push(line);
		}
	}
	return rows.length === 0 ? undefined : { before, rows, after };
}

function diagnosticsTable(key: string, rows: readonly DiagnosticRow[]): UiNode {
	return {
		type: "table",
		key,
		columns: [{ header: "Location" }, { header: "Severity" }, { header: "Message" }],
		rows: rows.map((row, index) => ({
			key: `diagnostic:${index}`,
			cells: [row.location, [{ text: row.severity, token: SEVERITY_TOKENS[row.severity] ?? "muted" }], row.message],
		})),
	};
}

/** The freshness of diagnostics the result reports, when it is not fresh evidence. */
function freshnessWarning(details: unknown): UiNode[] {
	const lsp = isRecord(details) ? (details as Partial<LspToolDetails>).lsp : undefined;
	if (!isRecord(lsp)) return [];
	const { freshness, source } = lsp;
	if (typeof freshness !== "string" || typeof source !== "string") return [];
	return freshness !== "fresh" && source !== "none"
		? [warningNode(`Diagnostics: ${freshness} (${source})`, "freshness")]
		: [];
}

/**
 * lsp: the action, path and line, symbol, new name, and fix title;
 * diagnostics as a table with severity tokens (collapsed, the first ten),
 * other results as terminal lines, and how fresh the diagnostics are.
 */
export const presentLsp: ToolPresenter = (input) => {
	const { args } = input;
	const spans: StyledSpans = [];
	const action = args.action;
	spans.push(
		typeof action === "string" ? { text: oneLine(action), token: "muted" } : argSpan(args, "action", "muted"),
	);
	const path = args.path;
	if (typeof path === "string" && path) {
		const line = numberArg(args, "line");
		spans.push({ text: `${oneLine(path)}${line === undefined ? "" : `:${line}`}`, token: "accent" });
	}
	const symbol = args.symbol;
	if (typeof symbol === "string" && symbol) spans.push({ text: oneLine(symbol) });
	const newName = args.newName;
	if (typeof newName === "string" && newName) spans.push({ text: "->", token: "muted" }, { text: oneLine(newName) });
	const fixTitle = args.title;
	if (typeof fixTitle === "string" && fixTitle) spans.push({ text: `"${oneLine(fixTitle)}"`, token: "muted" });
	const titleText = titleSpans("lsp", ...spans);
	if (input.state !== "done") return presentationOf(titleText, { showsDuration: true });
	const freshness = freshnessWarning(input.result?.details);
	if (isFailed(input)) {
		const failed = failureOutput(input, LSP_SUMMARY_LINES);
		return presentationOf(titleText, {
			summary: [...freshness, ...failed.summary],
			body: failed.body.length === 0 ? [] : [...freshness, ...failed.body],
			showsDuration: true,
		});
	}
	const text = resultText(input.result).trim();
	const diagnostics = diagnosticRows(text);
	if (diagnostics === undefined) {
		return presentationOf(titleText, {
			...linesOutput(outputLines(text), LSP_SUMMARY_LINES, freshness),
			showsDuration: true,
		});
	}
	const before = diagnostics.before.map((line, index) => textNode(`before:${index}`, line));
	const after = diagnostics.after.map((line, index) => textNode(`after:${index}`, line, "muted"));
	const shown = diagnostics.rows.slice(0, LSP_SUMMARY_LINES);
	const summary: UiNode[] = [
		...freshness,
		...before,
		diagnosticsTable("diagnostics", shown),
		...(shown.length < diagnostics.rows.length
			? [textNode("more", `… ${diagnostics.rows.length - shown.length} more diagnostics`, "muted")]
			: after),
	];
	const body: UiNode[] =
		shown.length === diagnostics.rows.length
			? []
			: [...freshness, ...before, diagnosticsTable("diagnostics", diagnostics.rows), ...after];
	return presentationOf(titleText, { summary, body, showsDuration: true });
};

// ============================================================================
// web_search, web_fetch
// ============================================================================

function searchResultsOf(details: unknown): WebSearchResult[] | undefined {
	const results = isRecord(details) ? details.results : undefined;
	if (!Array.isArray(results)) return undefined;
	const valid = results.filter(
		(result): result is WebSearchResult =>
			isRecord(result) && typeof result.title === "string" && typeof result.url === "string",
	);
	return valid.length === 0 ? undefined : valid;
}

/** One search result as a card: its title, URL, snippet, and when and where it was published. */
function resultCard(result: WebSearchResult, index: number): UiNode {
	const children: UiNode[] = [textNode("url", oneLine(result.url, 2_000), "accent")];
	if (typeof result.snippet === "string" && result.snippet.trim())
		children.push(textNode("snippet", result.snippet.trim()));
	const meta = [
		...(typeof result.publishedAt === "string" && result.publishedAt ? [`Published ${result.publishedAt}`] : []),
		...(typeof result.source === "string" && result.source ? [result.source] : []),
	];
	if (meta.length > 0) children.push(textNode("meta", oneLine(meta.join(" · "), 400), "muted"));
	return {
		type: "card",
		key: `result:${index}`,
		title: `[${index + 1}] ${oneLine(result.title, 400)}`,
		sections: [{ key: "result", children }],
	};
}

/**
 * web_search: the query, domains, recency, and limit; the results as cards
 * (collapsed, their count and the first five titles); the provider's text
 * when it returned no structured results; limits reached.
 */
export const presentWebSearch: ToolPresenter = (input) => {
	const { args } = input;
	const spans: StyledSpans = [argSpan(args, "query")];
	const domains = Array.isArray(args.domains)
		? args.domains.filter((domain): domain is string => typeof domain === "string" && domain.length > 0)
		: [];
	if (domains.length > 0) spans.push({ text: `(${oneLine(domains.join(", "))})` });
	const recency = numberArg(args, "recencyDays");
	if (recency !== undefined) spans.push({ text: recency === 1 ? "last day" : `last ${recency} days` });
	const limit = numberArg(args, "limit");
	if (limit !== undefined) spans.push({ text: `limit ${limit}` });
	const titleText = titleSpans("web_search", ...spans);
	if (input.state !== "done") {
		return presentationOf(titleText, {
			activity: input.state === "running" ? "Searching" : undefined,
			showsDuration: true,
		});
	}
	if (isFailed(input))
		return presentationOf(titleText, { ...failureOutput(input, WEB_SUMMARY_LINES), showsDuration: true });
	const details = isRecord(input.result?.details) ? input.result.details : {};
	const resultLimit = numberArg(details, "resultLimitReached");
	const truncation = truncationOf(details);
	const reasons = [
		...(resultLimit === undefined ? [] : [`${resultLimit} results limit`]),
		...(truncation === undefined
			? []
			: [
					truncation.truncatedBy === "lines"
						? `${String(truncation.maxLines)} lines limit`
						: `${byteLimitText(truncation)} limit`,
				]),
	];
	const warnings = truncatedWarning(reasons);
	const results = searchResultsOf(details);
	if (results === undefined) {
		const text = withoutNoticeFooter(resultText(input.result), reasons.length > 0).trim();
		return presentationOf(titleText, {
			...linesOutput(outputLines(text), WEB_SUMMARY_LINES, [], warnings),
			showsDuration: true,
		});
	}
	const provider = typeof details.provider === "string" && details.provider ? ` (${oneLine(details.provider)})` : "";
	const submitted =
		typeof details.submittedQuery === "string" && details.submittedQuery !== details.query
			? [textNode("submitted", `Submitted query: ${oneLine(details.submittedQuery, 500)}`, "muted")]
			: [];
	const count = textNode("count", `${plural(results.length, "result")}${provider}`, "muted");
	const shown = results.slice(0, WEB_SEARCH_SUMMARY_RESULTS);
	const summary: UiNode[] = [
		count,
		{
			type: "list",
			key: "titles",
			ordered: true,
			items: shown.map((result, index) => textNode(`title:${index}`, oneLine(result.title, 400))),
		},
		...(results.length > shown.length
			? [textNode("more", `… ${plural(results.length - shown.length, "more result")}`, "muted")]
			: []),
		...warnings,
	];
	const body: UiNode[] = [count, ...submitted, ...results.map(resultCard), ...warnings];
	return presentationOf(titleText, { summary, body, showsDuration: true });
};

/** Fetched text without the header and footers the tool writes around it. */
function fetchedContent(text: string): string {
	const lines = text.split("\n");
	let start = 0;
	if (lines[start]?.startsWith("Fetched: ")) start++;
	if (lines[start]?.startsWith("Title: ")) start++;
	if (start > 0 && lines[start] === "") start++;
	return lines
		.slice(start)
		.join("\n")
		.replace(/(?:\n\n\[(?:[^\n]* limit reached|Download truncated at [^\n]*)\])+\s*$/, "")
		.trim();
}

/**
 * web_fetch: the URL; the page's URL, title, and content type; its text as
 * literal lines (collapsed, the first lines; expanded, all of them, which a
 * bounded presentation trims); and how the text or download was truncated.
 * Fetched text is untrusted and shows as it is, never as Markdown, so a page
 * cannot style links or images into what the user sees.
 */
export const presentWebFetch: ToolPresenter = (input) => {
	const titleText = titleSpans("web_fetch", argSpan(input.args, "url"));
	if (input.state !== "done") {
		return presentationOf(titleText, {
			activity: input.state === "running" ? "Fetching" : undefined,
			showsDuration: true,
		});
	}
	if (isFailed(input))
		return presentationOf(titleText, { ...failureOutput(input, WEB_SUMMARY_LINES), showsDuration: true });
	const details = (isRecord(input.result?.details) ? input.result.details : {}) as Partial<
		Record<keyof WebFetchToolDetails, unknown>
	>;
	const items: { key: string; label: string; value: string }[] = [];
	if (typeof details.url === "string") items.push({ key: "url", label: "URL", value: oneLine(details.url, 2_000) });
	if (typeof details.requestedUrl === "string") {
		items.push({ key: "requested", label: "Requested", value: oneLine(details.requestedUrl, 2_000) });
	}
	if (typeof details.title === "string" && details.title) {
		items.push({ key: "title", label: "Title", value: oneLine(details.title, 400) });
	}
	if (typeof details.contentType === "string" && details.contentType) {
		items.push({ key: "type", label: "Content type", value: oneLine(details.contentType, 200) });
	}
	const info: UiNode[] = items.length === 0 ? [] : [{ type: "keyValue", key: "page", items }];
	const truncation = truncationOf(details);
	const download = isRecord(details.downloadTruncation) ? details.downloadTruncation : undefined;
	const warnings: UiNode[] = [
		...(truncation === undefined
			? []
			: [
					warningNode(
						`[Truncated: ${truncation.truncatedBy === "lines" ? `${String(truncation.maxLines)} lines` : byteLimitText(truncation)} limit]`,
						"truncation",
					),
				]),
		...(download === undefined
			? []
			: [
					warningNode(
						`[Download truncated: ${formatSize(typeof download.maxBytes === "number" ? download.maxBytes : 0)} limit]`,
						"download",
					),
				]),
	];
	const content = fetchedContent(resultText(input.result));
	if (!content) return presentationOf(titleText, { summary: [...info, ...warnings], showsDuration: true });
	return presentationOf(titleText, {
		...linesOutput(outputLines(content), WEB_SUMMARY_LINES, info, warnings, "text"),
		showsDuration: true,
	});
};

// ============================================================================
// mcp
// ============================================================================

/** The `server.tool` an mcp call names. */
function serverTool(args: Args): StyledSpans[number] {
	const server = args.server;
	const tool = args.tool;
	if ((server !== undefined && typeof server !== "string") || (tool !== undefined && typeof tool !== "string")) {
		return { text: "[invalid arg]", token: "error" };
	}
	return { text: oneLine(`${server || "…"}.${tool || "…"}`), token: "accent" };
}

/**
 * mcp: the gateway action (`mcp server.tool` for a call, `mcp search <query>`,
 * `mcp describe server.tool`, `mcp <action>`), and its result as JSON
 * (collapsed, its first 18 lines). An MCP server call running inside a tool
 * call (`{server, tool}` without an action) shows its progress.
 */
export const presentMcp: ToolPresenter = (input) => {
	const { args } = input;
	const action = args.action;
	let titleText: StyledSpans;
	if (action === undefined && (args.server !== undefined || args.tool !== undefined)) {
		return presentServerCall(input);
	}
	if (action === "call") titleText = titleSpans("mcp", serverTool(args));
	else if (action === "search") titleText = titleSpans("mcp search", argSpan(args, "query"));
	else if (action === "describe") titleText = titleSpans("mcp describe", serverTool(args));
	else titleText = titleSpans("mcp", argSpan(args, "action"));
	if (input.state !== "done") return presentationOf(titleText, { showsDuration: true });
	if (isFailed(input))
		return presentationOf(titleText, { ...failureOutput(input, MCP_SUMMARY_LINES), showsDuration: true });
	const details = input.result?.details;
	if (!isRecord(details) || !("result" in details)) {
		return presentationOf(titleText, {
			...linesOutput(outputLines(resultText(input.result).trim()), MCP_SUMMARY_LINES),
			showsDuration: true,
		});
	}
	let json: string;
	try {
		json = JSON.stringify(details.result, null, 2) ?? "null";
	} catch {
		json = "null";
	}
	const lines = codeLines(stripTerminalControls(json));
	const shown = lines.slice(0, MCP_SUMMARY_LINES);
	return presentationOf(titleText, {
		summary: [
			{ type: "code", key: "result", language: "json", code: shown.join("\n") },
			...moreLines(shown.length, lines.length),
		],
		body:
			lines.length <= MCP_SUMMARY_LINES
				? []
				: [{ type: "code", key: "result", language: "json", code: lines.join("\n") }],
		showsDuration: true,
	});
};

/** A server call running inside a tool call: its progress while it runs, its last message once it ended. */
function presentServerCall(input: ToolPresentInput) {
	const titleText = titleSpans("mcp", serverTool(input.args));
	const message = resultText(input.result).trim();
	const details = input.result?.details;
	const progress = isRecord(details) ? numberArg(details, "progress") : undefined;
	const total = isRecord(details) ? numberArg(details, "total") : undefined;
	const summary: UiNode[] = [];
	if (input.state !== "done" && progress !== undefined && progress >= 0 && total !== undefined && total > 0) {
		summary.push({
			type: "progress",
			key: "progress",
			kind: "determinate",
			value: Math.min(progress, total),
			max: total,
			...(message ? { label: oneLine(message, 400) } : {}),
		});
	} else if (message) {
		summary.push(textNode("message", oneLine(message, 2_000), isFailed(input) ? "error" : "muted"));
	}
	return presentationOf(titleText, { summary, showsDuration: true });
}

// ============================================================================
// request_user_input
// ============================================================================

/** Model-provided question text as plain text: terminal controls stripped, whitespace collapsed. */
function questionText(value: unknown): string {
	return typeof value === "string"
		? stripTerminalControls(value)
				.replace(/\p{Cc}/gu, " ")
				.replace(/\s+/g, " ")
				.trim()
		: "";
}

interface AskedQuestion {
	readonly id: string;
	readonly header: string;
	readonly question: string;
}

function questionsOf(value: unknown): AskedQuestion[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((question): AskedQuestion[] =>
		isRecord(question)
			? [
					{
						id: typeof question.id === "string" ? question.id : "",
						header: questionText(question.header),
						question: questionText(question.question),
					},
				]
			: [],
	);
}

/**
 * request_user_input: the questions' headers; the answers as key-value
 * pairs (expanded, each under its full question); a cancelled or
 * unavailable request as one muted line.
 */
export const presentRequestUserInput: ToolPresenter = (input) => {
	const asked = questionsOf(input.args.questions);
	const headers = asked.map((question) => question.header).filter(Boolean);
	const titleText: StyledSpans = [
		{ text: "ask user", bold: true },
		...(headers.length === 0 ? [] : [{ text: ` · ${oneLine(headers.join(" · "))}`, token: "muted" as const }]),
	];
	const activity = activityOf(input, "Writing questions", "Waiting for answers");
	if (input.state !== "done") return presentationOf(titleText, { ...(activity === undefined ? {} : { activity }) });
	const details = input.result?.details;
	if (isFailed(input) || !isRecord(details)) {
		const text = resultText(input.result).trim();
		return presentationOf(titleText, {
			summary: text ? [textNode("error", text, isFailed(input) ? "error" : undefined)] : [],
		});
	}
	if (details.status === "cancelled") {
		return presentationOf(titleText, { summary: [textNode("status", "Cancelled · turn stopped", "muted")] });
	}
	if (details.status === "unavailable") {
		return presentationOf(titleText, {
			summary: [textNode("status", "Question UI unavailable · no answers", "muted")],
		});
	}
	const questions = questionsOf(details.questions);
	const answers = isRecord(details.answers) ? details.answers : {};
	const answerOf = (question: AskedQuestion): UiNodeStyledText => {
		const entry = Object.hasOwn(answers, question.id) ? answers[question.id] : undefined;
		const values =
			isRecord(entry) && Array.isArray(entry.answers)
				? entry.answers.map(questionText).filter((answer) => answer.length > 0)
				: [];
		return values.length > 0 ? values.join(" · ") : [{ text: "Skipped · no answer", token: "muted" }];
	};
	const item = (question: AskedQuestion, index: number) => ({
		key: `answer:${index}`,
		label: [{ text: question.header || question.id, token: "accent" as const }],
		value: answerOf(question),
	});
	const summary: UiNode[] = [{ type: "keyValue", key: "answers", items: questions.map(item) }];
	const body: UiNode[] = questions.flatMap((question, index): UiNode[] => [
		textNode(`question:${index}`, question.question, "muted"),
		{ type: "keyValue", key: `answer:${index}`, items: [item(question, index)] },
	]);
	return presentationOf(titleText, { summary, body });
};
