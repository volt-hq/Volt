/**
 * The built-in tools' presenters (RFC §8.3, Q9): bash, read, write, and edit
 * present their calls as `UiNode` data, and the background decorator wraps a
 * call made with `background: true` in a job card. Each presenter is a pure
 * function of the call's arguments, state, result, and working directory: it
 * reads no files and keeps no state, so the same call presents the same way
 * on every client, live and in the log. Paths show as the call spells them:
 * the live lane redacts presentations as text, so a presenter never rewrites
 * a host path into a form redaction cannot recognize.
 */

import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import type { UiNode, UiNodeStyledText, UiNodeToken } from "@hansjm10/volt-protocol";
import * as Diff from "diff";
import { getReadmePath } from "../../config.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { SUBAGENT_REGISTRY_TOOL_NAME } from "../subagents/tool-names.ts";
import type { UiStyledLine } from "../ui/ansi-tokens.ts";
import { BUILTIN_MESSAGE_PRESENTERS } from "../ui/message-presenters.ts";
import { HOST_UI_POLICY, outputLines, type PresenterSet, resultText, type ToolPresenter } from "../ui/presentation.ts";
import { resolveToCwd } from "./path-utils.ts";
import { presentPlanning } from "./planning-presenters.ts";
import {
	type Args,
	activityOf,
	codeLines,
	codeNode,
	errorNode,
	isFailed,
	isRecord,
	moreLines,
	oneLine,
	plainText,
	stringArg,
	TITLE_TEXT_MAX_CHARS,
	textNode,
	titleOf,
} from "./present-utils.ts";
import {
	presentFind,
	presentGrep,
	presentInspect,
	presentLs,
	presentLsp,
	presentMcp,
	presentRequestUserInput,
	presentWebFetch,
	presentWebSearch,
} from "./query-presenters.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate.ts";
import { presentJobs, presentSubagent, presentSubagentRegistry } from "./work-presenters.ts";

/** Lines bash shows collapsed: the newest output. */
const BASH_SUMMARY_LINES = 5;
/** Lines read and write show collapsed: the start of the file. */
const FILE_SUMMARY_LINES = 10;
/** The bash tool's own bound on a requested timeout, in seconds. */
const MAX_TIMEOUT_SECONDS = 3600;

// ============================================================================
// bash
// ============================================================================

interface BashStatus {
	readonly text: string;
	readonly token: UiNodeToken;
}

/** The status line the bash tool appends to a failed command's output. */
function bashStatus(text: string): { output: string; status?: BashStatus } {
	const at = text.lastIndexOf("\n\n");
	const last = (at === -1 ? text : text.slice(at + 2)).trim();
	const output = at === -1 ? "" : text.slice(0, at);
	let match = /^Command exited with code (\d+)$/.exec(last);
	if (match) return { output, status: { text: `exit ${match[1]}`, token: "error" } };
	match = /^Command timed out after (\d+(?:\.\d+)?) seconds$/.exec(last);
	if (match) return { output, status: { text: `timed out after ${match[1]}s`, token: "warning" } };
	match = /^Command produced no output for (\d+(?:\.\d+)?) seconds and was killed as hung\./.exec(last);
	if (match) return { output, status: { text: `killed after ${match[1]}s without output`, token: "warning" } };
	if (last === "Command aborted") return { output, status: { text: "aborted", token: "warning" } };
	return { output: text };
}

/** Output without the footer the bash tool adds when it truncated it. */
function withoutTruncationFooter(text: string): string {
	return text.replace(/\n\n\[Showing (?:lines|last) [^\n]*\]$/, "");
}

function timeoutSeconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.min(value, MAX_TIMEOUT_SECONDS)
		: undefined;
}

function bashWarnings(details: unknown): UiNode[] {
	if (!isRecord(details)) return [];
	const warnings: string[] = [];
	if (typeof details.fullOutputPath === "string") warnings.push(`Full output: ${details.fullOutputPath}`);
	const truncation = details.truncation;
	if (isRecord(truncation) && truncation.truncated === true) {
		if (truncation.truncatedBy === "lines") {
			warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
		} else {
			const max = typeof truncation.maxBytes === "number" ? truncation.maxBytes : DEFAULT_MAX_BYTES;
			warnings.push(`Truncated: ${truncation.outputLines} lines shown (${formatSize(max)} limit)`);
		}
	}
	return warnings.length === 0 ? [] : [textNode("warning", `[${warnings.join(". ")}]`, "warning")];
}

/** Lines the tool dropped before its output: what the output's first line follows. */
function omittedBefore(details: unknown): number {
	const truncation = isRecord(details) ? details.truncation : undefined;
	if (!isRecord(truncation) || truncation.truncated !== true) return 0;
	const { totalLines, outputLines: kept } = truncation;
	return typeof totalLines === "number" && typeof kept === "number" && totalLines > kept ? totalLines - kept : 0;
}

/**
 * bash: `$ command` (with the timeout in force), the output as terminal
 * lines (collapsed, its newest five), and how a failed command ended. While
 * the command runs, a line it is still writing is kept apart, so new output
 * reaches clients as appended lines.
 */
export const presentBash: ToolPresenter = (input) => {
	const command = stringArg(input.args, "command");
	const timeout = timeoutSeconds(input.args.timeout);
	const title: UiNodeStyledText = [
		{ text: "$ ", bold: true },
		{ text: command === undefined ? "…" : oneLine(command) },
		...(timeout === undefined ? [] : [{ text: ` (timeout ${timeout}s)`, token: "muted" as const }]),
	];
	const commandNode: UiNode[] =
		command !== undefined && (command.includes("\n") || command.trim().length > TITLE_TEXT_MAX_CHARS)
			? [{ type: "code", key: "command", language: "bash", code: command }]
			: [];
	const result = input.result;
	const running = result?.partial === true;
	const raw = withoutTruncationFooter(resultText(result));
	const { output, status } = input.state === "done" && result?.isError ? bashStatus(raw) : { output: raw };
	const lines = outputLines(output);
	let partialLine: UiStyledLine | undefined;
	if (running && lines.length > 0 && !output.endsWith("\n")) {
		partialLine = lines.pop();
		if (partialLine !== undefined && plainText(partialLine) === "") partialLine = undefined;
	}
	const omitted = omittedBefore(result?.details);
	const all = partialLine === undefined ? lines : [...lines, partialLine];
	const tail = all.slice(-BASH_SUMMARY_LINES);
	const statusNode = status === undefined ? [] : [textNode("status", status.text, status.token)];
	const warnings = input.state === "done" ? bashWarnings(result?.details) : [];
	const summary: UiNode[] = [
		...(tail.length === 0
			? []
			: [
					{
						type: "terminal" as const,
						key: "tail",
						lines: tail,
						...(omitted + all.length - tail.length > 0
							? { omittedLines: omitted + all.length - tail.length }
							: {}),
					},
				]),
		...statusNode,
	];
	// Output the summary shows whole needs no body.
	const fits = commandNode.length === 0 && warnings.length === 0 && omitted === 0 && all.length <= BASH_SUMMARY_LINES;
	const body: UiNode[] = fits
		? []
		: [
				...commandNode,
				...(all.length === 0
					? []
					: [
							{
								type: "terminal" as const,
								key: "output",
								lines,
								...(omitted > 0 ? { omittedLines: omitted } : {}),
							},
						]),
				...(partialLine === undefined ? [] : [textNode("partial", partialLine)]),
				...statusNode,
				...warnings,
			];
	return {
		title,
		...(summary.length === 0 ? {} : { summary }),
		...(body.length === 0 ? {} : { body }),
		showsDuration: true,
	};
};

// ============================================================================
// read
// ============================================================================

interface CompactRead {
	readonly kind: "docs" | "resource" | "skill";
	readonly label: string;
}

const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);

/** Reads of skills, Volt's own docs, and context files, which show collapsed as one line. */
function compactRead(rawPath: string, cwd: string): CompactRead | undefined {
	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	const packageRoot = dirname(getReadmePath());
	const relativePath = relative(resolvePath(packageRoot), resolvePath(absolutePath));
	if (relativePath && relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) {
		const label = relativePath.split(sep).join("/");
		if (label === "README.md" || label.startsWith("docs/") || label.startsWith("examples/")) {
			return { kind: "docs", label };
		}
	}
	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}
	return undefined;
}

function lineRange(args: Args): string {
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	return `:${start}${limit === undefined ? "" : `-${start + limit - 1}`}`;
}

/**
 * The read tool's text without the note it appends for the model (where to
 * continue reading), and how many lines of the file follow what it read when
 * the note says so. A truncated read's note is shown by its truncation instead.
 */
function withoutReadFooter(text: string): { text: string; moreInFile?: number } {
	const match =
		/\n\n\[(?:(\d+) more lines in file|Showing lines \d+-\d+ of \d+(?: \([^)\]\n]*\))?)\. Use offset=\d+ to continue\.\]$/.exec(
			text,
		);
	if (!match) return { text };
	const more = match[1] === undefined ? undefined : Number.parseInt(match[1], 10);
	return { text: text.slice(0, match.index), ...(more === undefined ? {} : { moreInFile: more }) };
}

function readTruncation(details: unknown): UiNode[] {
	const truncation = isRecord(details) ? details.truncation : undefined;
	if (!isRecord(truncation) || truncation.truncated !== true) return [];
	const maxBytes = typeof truncation.maxBytes === "number" ? truncation.maxBytes : DEFAULT_MAX_BYTES;
	const maxLines = typeof truncation.maxLines === "number" ? truncation.maxLines : DEFAULT_MAX_LINES;
	const text =
		truncation.firstLineExceedsLimit === true
			? `[First line exceeds ${formatSize(maxBytes)} limit]`
			: truncation.truncatedBy === "lines"
				? `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${maxLines} line limit)]`
				: `[Truncated: ${truncation.outputLines} lines shown (${formatSize(maxBytes)} limit)]`;
	return [textNode("truncation", text, "warning")];
}

/**
 * read: the path and line range, the file's text as code (collapsed, its
 * first ten lines), and how it was truncated. Skills, Volt's docs, and
 * context files show collapsed as their title only.
 */
export const presentRead: ToolPresenter = (input) => {
	const rawPath = stringArg(input.args, "file_path", "path");
	const range = lineRange(input.args);
	const compact = rawPath === undefined ? undefined : compactRead(rawPath, input.cwd);
	const suffix = range ? [{ text: range, token: "muted" as const }] : undefined;
	const title =
		compact === undefined
			? titleOf("read", rawPath, suffix)
			: compact.kind === "skill"
				? [{ text: "[skill] ", token: "accent" as const, bold: true }, { text: compact.label }, ...(suffix ?? [])]
				: titleOf(`read ${compact.kind}`, compact.label, suffix);
	if (input.state !== "done") return { title };
	if (isFailed(input)) {
		const error = errorNode(input);
		return { title, ...(error.length === 0 ? {} : { summary: error, body: error }) };
	}
	const hasImage = input.result?.content.some((block) => block.type === "image") === true;
	const text = resultText(input.result);
	if (hasImage) {
		const note = text.trim() ? [textNode("note", text.trim(), "muted")] : [];
		return { title, ...(note.length === 0 ? {} : { summary: note }) };
	}
	const read = withoutReadFooter(text);
	const lines = codeLines(read.text);
	if (lines.length === 0) return { title };
	const truncation = readTruncation(input.result?.details);
	const rest =
		read.moreInFile === undefined ? [] : [textNode("rest", `[${read.moreInFile} more lines in file]`, "muted")];
	// A file the summary shows whole needs no body.
	const fits = compact === undefined && truncation.length === 0 && lines.length <= FILE_SUMMARY_LINES;
	const summary =
		compact === undefined
			? [
					codeNode("code", lines.slice(0, FILE_SUMMARY_LINES), rawPath),
					...moreLines(FILE_SUMMARY_LINES, lines.length),
					...truncation,
					...(fits ? rest : []),
				]
			: [];
	return {
		title,
		...(summary.length === 0 ? {} : { summary }),
		...(fits ? {} : { body: [codeNode("code", lines, rawPath), ...truncation, ...rest] }),
	};
};

// ============================================================================
// write
// ============================================================================

function diagnosticsNode(details: unknown): UiNode[] {
	const diagnostics = isRecord(details) ? details.diagnostics : undefined;
	return typeof diagnostics === "string" && diagnostics.trim()
		? [textNode("diagnostics", diagnostics.trim(), "warning")]
		: [];
}

/** write: the path, what it is doing while it runs, the content as code (collapsed, its first ten lines), and diagnostics. */
export const presentWrite: ToolPresenter = (input) => {
	const rawPath = stringArg(input.args, "file_path", "path");
	const title = titleOf("write", rawPath);
	const activity = activityOf(input, "Generating content", "Writing file");
	const content = input.args.content;
	const failure = isFailed(input) ? errorNode(input) : [];
	const diagnostics = input.state === "done" ? diagnosticsNode(input.result?.details) : [];
	let summary: UiNode[];
	let body: UiNode[];
	if (content !== undefined && typeof content !== "string") {
		summary = body = [textNode("invalid", "[invalid content arg - expected string]", "error")];
	} else {
		const lines = typeof content === "string" ? codeLines(content) : [];
		summary =
			lines.length === 0
				? []
				: [
						codeNode("code", lines.slice(0, FILE_SUMMARY_LINES), rawPath),
						...moreLines(FILE_SUMMARY_LINES, lines.length, `, ${lines.length} total`),
					];
		body = lines.length <= FILE_SUMMARY_LINES ? [] : [codeNode("code", lines, rawPath)];
	}
	summary = [...summary, ...failure, ...diagnostics];
	// Content the summary shows whole needs no body.
	body = body.length === 0 ? [] : [...body, ...failure, ...diagnostics];
	return {
		title,
		...(activity === undefined ? {} : { activity }),
		...(summary.length === 0 ? {} : { summary }),
		...(body.length === 0 ? {} : { body }),
	};
};

// ============================================================================
// edit
// ============================================================================

type DiffLine = Extract<UiNode, { type: "diff" }>["lines"][number];

/** The edit tool's display diff (`+12 text`, `-12 text`, ` 12 text`, `    ...`) as diff lines. */
export function parseEditDiff(diff: string): DiffLine[] {
	const lines: DiffLine[] = [];
	for (const raw of diff.split("\n")) {
		const match = /^([+\- ])(\s*\d*) (.*)$/.exec(raw);
		if (!match) {
			if (raw.trim()) lines.push({ kind: "meta", text: raw.replace(/\t/g, "   ") });
			continue;
		}
		const [, prefix, number, text] = match as unknown as [string, string, string, string];
		const line = Number.parseInt(number.trim(), 10);
		const content = text.replace(/\t/g, "   ");
		if (!number.trim() && content === "...") {
			lines.push({ kind: "hunk", text: "…" });
		} else if (prefix === "+") {
			lines.push({ kind: "add", text: content, ...(line > 0 ? { newLine: line } : {}) });
		} else if (prefix === "-") {
			lines.push({ kind: "remove", text: content, ...(line > 0 ? { oldLine: line } : {}) });
		} else {
			lines.push({ kind: "context", text: content, ...(line > 0 ? { oldLine: line } : {}) });
		}
	}
	return lines;
}

/** The edits a call names, as far as its arguments say: `edits[]`, or one legacy `oldText`/`newText`. */
function editsOf(args: Args): { oldText: string; newText: string }[] {
	const edits: { oldText: string; newText: string }[] = [];
	if (Array.isArray(args.edits)) {
		for (const edit of args.edits) {
			if (isRecord(edit) && typeof edit.oldText === "string" && typeof edit.newText === "string") {
				edits.push({ oldText: edit.oldText, newText: edit.newText });
			}
		}
	}
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		edits.push({ oldText: args.oldText, newText: args.newText });
	}
	return edits;
}

/** Most lines on either side of one replacement the preview diffs line by line; larger ones show as removed and added whole. */
const PREVIEW_DIFF_MAX_LINES = 400;

/** One replacement as diff lines: its lines diffed, or all removed then all added when it is large. */
function replacementLines(oldText: string, newText: string): DiffLine[] {
	const before = oldText.replace(/\r/g, "");
	const after = newText.replace(/\r/g, "");
	const split = (text: string): string[] => {
		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines.map((line) => line.replace(/\t/g, "   "));
	};
	const removed = split(before);
	const added = split(after);
	if (removed.length > PREVIEW_DIFF_MAX_LINES || added.length > PREVIEW_DIFF_MAX_LINES) {
		return [
			...removed.map((text): DiffLine => ({ kind: "remove", text })),
			...added.map((text): DiffLine => ({ kind: "add", text })),
		];
	}
	return Diff.diffLines(before, after).flatMap((part) => {
		const kind = part.added ? "add" : part.removed ? "remove" : "context";
		return split(part.value).map((text): DiffLine => ({ kind, text }));
	});
}

/** The replacements of a call before it ran, as diff lines: each edit's removed and added lines, without line numbers. */
function previewDiff(edits: readonly { oldText: string; newText: string }[]): DiffLine[] {
	const lines: DiffLine[] = [];
	edits.forEach((edit, index) => {
		if (edits.length > 1) lines.push({ kind: "hunk", text: `edit ${index + 1} of ${edits.length}` });
		lines.push(...replacementLines(edit.oldText, edit.newText));
	});
	return lines;
}

/** " +N -M": the lines a change adds and removes, after the path in the title; nothing when it changes no line. */
function changeCounts(lines: readonly DiffLine[]): UiNodeStyledText | undefined {
	const added = lines.filter((line) => line.kind === "add").length;
	const removed = lines.filter((line) => line.kind === "remove").length;
	if (added === 0 && removed === 0) return undefined;
	return [
		{ text: " " },
		{ text: `+${added}`, token: "success" },
		{ text: " " },
		{ text: `-${removed}`, token: "error" },
	];
}

/**
 * edit: the path with "+N -M", the change as a diff (before it runs, each
 * replacement's lines; once it ran, the file's diff with line numbers), and
 * diagnostics. The title names the file, so the diff does not again.
 */
export const presentEdit: ToolPresenter = (input) => {
	const rawPath = stringArg(input.args, "file_path", "path");
	const activity = activityOf(input, "Generating edits", "Applying edits");
	const details = input.result?.details;
	const resultDiff =
		input.state === "done" && isRecord(details) && typeof details.diff === "string" ? details.diff : undefined;
	const lines = isFailed(input)
		? []
		: resultDiff !== undefined
			? parseEditDiff(resultDiff)
			: previewDiff(editsOf(input.args));
	const title = titleOf("edit", rawPath, changeCounts(lines));
	const nodes: UiNode[] = isFailed(input)
		? errorNode(input)
		: lines.length === 0
			? []
			: [{ type: "diff", key: "diff", lines, lineNumbers: resultDiff !== undefined }];
	const summary = [...nodes, ...(input.state === "done" ? diagnosticsNode(details) : [])];
	return {
		title,
		...(activity === undefined ? {} : { activity }),
		...(summary.length === 0 ? {} : { summary }),
	};
};

// ============================================================================
// Background jobs
// ============================================================================

const JOB_STATUS: Readonly<Record<string, { label: string; token: UiNodeToken }>> = {
	running: { label: "Started", token: "warning" },
	cancelling: { label: "Cancelling", token: "warning" },
	completed: { label: "Completed", token: "success" },
	failed: { label: "Failed", token: "error" },
	cancelled: { label: "Cancelled", token: "muted" },
	interrupted: { label: "Interrupted", token: "muted" },
};

/** The job a background start's result names, when it names one. */
function jobOf(details: unknown): { id: string; tool: string; status: string } | undefined {
	const job = isRecord(details) ? details.job : undefined;
	if (!isRecord(job)) return undefined;
	const { id, tool, status } = job;
	return typeof id === "string" &&
		/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id) &&
		(tool === "bash" || tool === "subagent") &&
		typeof status === "string" &&
		Object.hasOwn(JOB_STATUS, status)
		? { id, tool, status }
		: undefined;
}

/**
 * The presenter of a tool the background decorator wraps: a call without
 * `background: true` presents as the tool does; one with it keeps the tool's
 * title and shows the job it started as a card, or how it failed to start. A
 * background call the tool answered itself, without a job, presents as the
 * tool does. The job's progress is the work item's, which clients show with
 * the call.
 */
export function presentBackground(inner: ToolPresenter): ToolPresenter {
	return (input) => {
		const { background, ...args } = input.args;
		if (background !== true) return inner({ ...input, args });
		const presented = inner({ args, argsComplete: input.argsComplete, state: "pending", cwd: input.cwd });
		const title = presented.title;
		if (input.state !== "done") {
			return { title, activity: input.state === "running" ? "Starting background job" : "Preparing background job" };
		}
		const job = jobOf(input.result?.details);
		// A call the tool answered without starting a job (a subagent spawn's confirmation preflight) presents as the tool does.
		if (!job && input.result?.isError !== true) return inner({ ...input, args });
		if (!job || input.result?.isError) {
			const output = resultText(input.result).trim();
			const failure = [
				textNode(
					"error",
					output ? `Background job failed to start\n${output}` : "Background job failed to start",
					"error",
				),
			];
			return { title, summary: failure, body: failure };
		}
		const status = JOB_STATUS[job.status] ?? { label: job.status, token: "muted" as const };
		const card: UiNode = {
			type: "card",
			key: "job",
			title: "Background job",
			badges: [{ label: status.label, token: status.token }],
			sections: [
				{
					key: "job",
					children: [
						{
							type: "keyValue",
							key: "job",
							items: [
								{ key: "id", label: "Job", value: job.id },
								{ key: "tool", label: "Tool", value: job.tool },
							],
						},
					],
				},
			],
		};
		return { title, summary: [card] };
	};
}

// ============================================================================
// The built-in presenter set
// ============================================================================

/** The built-in tools' presenters by tool name: what a call presents as when no other tool of its name is registered. */
export const BUILTIN_TOOL_PRESENTERS: ReadonlyMap<string, ToolPresenter> = new Map([
	["bash", presentBackground(presentBash)],
	["read", presentRead],
	["write", presentWrite],
	["edit", presentEdit],
	["grep", presentGrep],
	["find", presentFind],
	["ls", presentLs],
	["lsp", presentLsp],
	["inspect", presentInspect],
	["web_search", presentWebSearch],
	["web_fetch", presentWebFetch],
	["mcp", presentMcp],
	["request_user_input", presentRequestUserInput],
	["jobs", presentJobs],
	["subagent", presentBackground(presentSubagent)],
	[SUBAGENT_REGISTRY_TOOL_NAME, presentSubagentRegistry],
	["update_plan", presentPlanning("update_plan")],
	["submit_plan", presentPlanning("submit_plan")],
	["update_plan_progress", presentPlanning("update_plan_progress")],
	["request_replan", presentPlanning("request_replan")],
]);

/** The presenters of a log read without a runtime: the built-in tools' and the host's message types'. */
export const BUILTIN_PRESENTERS: PresenterSet = Object.freeze({
	generation: 0,
	tool: (toolName: string) => {
		const present = BUILTIN_TOOL_PRESENTERS.get(toolName);
		return present === undefined ? undefined : { present, policy: HOST_UI_POLICY };
	},
	message: (customType: string) => {
		const present = BUILTIN_MESSAGE_PRESENTERS.get(customType);
		return present === undefined ? undefined : { present, policy: HOST_UI_POLICY };
	},
});
