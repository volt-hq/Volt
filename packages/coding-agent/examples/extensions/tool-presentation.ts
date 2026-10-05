/**
 * Tool Presentation Example - Compact presentation for built-in tools
 *
 * Re-registers the built-in read, bash, edit, and write tools under their own
 * names, delegating execution to the original implementations, and gives each
 * a compact `present()`: how a call looks as UI data every client renders.
 *
 * How it works:
 * - registerTool() with the same name as a built-in replaces it entirely
 * - createReadTool(), etc. create the original tools; execute() delegates
 * - present() is pure: it reads the call's arguments, state, and result and
 *   returns a title, a collapsed `summary`, and an expanded `body`
 * - Clients draw the rest: the call's state, elapsed time, and expanding
 *   (ctrl+o in the TUI)
 * - Styling uses semantic tokens (`accent`, `success`, `error`, ...), never ANSI
 *
 * Usage:
 *   volt -e ./tool-presentation.ts
 */

import {
	type BashToolDetails,
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	defineManifest,
	type EditToolDetails,
	type ExtensionAPI,
	type ReadToolDetails,
	type ToolPresentResult,
} from "@hansjm10/volt-coding-agent";
import type { UiDiffNode, UiNode, UiNodeStyledText, UiNodeToken } from "@hansjm10/volt-protocol";

export const manifest = defineManifest({
	id: "tool-presentation",
	displayName: "Tool Presentation",
	description: "Compact presentation for built-in tools.",
});

/** The text of a result's text content. */
function resultText(result: ToolPresentResult | undefined): string {
	return (result?.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** A title: the tool's name in bold, then its target accented. */
function title(name: string, target: string | undefined, suffix?: string): UiNodeStyledText {
	return [
		{ text: `${name} `, bold: true },
		{ text: target ?? "…", token: "accent" },
		...(suffix ? [{ text: ` ${suffix}`, token: "muted" as const }] : []),
	];
}

function text(key: string, value: UiNodeStyledText, token?: UiNodeToken): UiNode {
	return { type: "text", key, text: value, ...(token ? { token } : {}) };
}

/** The first `max` lines of `output`, and how many more there are. */
function head(key: string, output: string, max: number, language?: string): UiNode[] {
	const lines = output.split("\n");
	const shown: UiNode[] = [
		{ type: "code", key, code: lines.slice(0, max).join("\n"), ...(language ? { language } : {}) },
	];
	if (lines.length > max) shown.push(text(`${key}-more`, `… ${lines.length - max} more lines`, "muted"));
	return shown;
}

/** One line of the edit tool's diff (`+ 12 text`, `- 12 text`, `  12 text`) as a diff node line. */
function diffLine(line: string): UiDiffNode["lines"][number] {
	const match = /^([+\- ])\s*(\d*) (.*)$/.exec(line);
	if (!match) return { kind: "meta", text: line };
	const [, sign, number, content] = match;
	const lineNumber = number ? Number(number) : undefined;
	if (sign === "+") return { kind: "add", text: content, ...(lineNumber ? { newLine: lineNumber } : {}) };
	if (sign === "-") return { kind: "remove", text: content, ...(lineNumber ? { oldLine: lineNumber } : {}) };
	return { kind: "context", text: content, ...(lineNumber ? { oldLine: lineNumber } : {}) };
}

export default function (volt: ExtensionAPI) {
	const cwd = process.cwd();

	// --- read: the path and the line count ---
	const originalRead = createReadTool(cwd);
	volt.registerTool({
		name: "read",
		label: "read",
		description: originalRead.description,
		parameters: originalRead.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalRead.execute(toolCallId, params, signal, onUpdate);
		},

		present({ args, state, result }) {
			const range = [args.offset ? `offset=${args.offset}` : "", args.limit ? `limit=${args.limit}` : ""]
				.filter(Boolean)
				.join(", ");
			const heading = title("read", args.path, range ? `(${range})` : undefined);
			if (state !== "done" || !result) return { title: heading, activity: "Reading…" };
			if (result.isError) return { title: heading, summary: [text("error", resultText(result), "error")] };
			if (result.content.some((part) => part.type === "image")) {
				return { title: heading, summary: [text("image", "Image loaded", "success")] };
			}
			const output = resultText(result);
			const details = result.details as ReadToolDetails | undefined;
			const count: UiNodeStyledText = [
				{ text: `${output.split("\n").length} lines`, token: "success" },
				...(details?.truncation?.truncated
					? [{ text: ` (truncated from ${details.truncation.totalLines})`, token: "warning" as const }]
					: []),
			];
			return {
				title: heading,
				summary: [text("count", count)],
				body: [text("count", count), ...head("lines", output, 15)],
			};
		},
	});

	// --- bash: the command and how it ended ---
	const originalBash = createBashTool(cwd);
	volt.registerTool({
		name: "bash",
		label: "bash",
		description: originalBash.description,
		parameters: originalBash.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalBash.execute(toolCallId, params, signal, onUpdate);
		},

		present({ args, state, result }) {
			const command = args.command ?? "…";
			const heading: UiNodeStyledText = [
				{ text: "$ ", bold: true },
				{ text: command.length > 80 ? `${command.slice(0, 77)}...` : command, token: "accent" },
				...(args.timeout ? [{ text: ` (timeout: ${args.timeout}s)`, token: "muted" as const }] : []),
			];
			// The host shows how long the command has run.
			if (state !== "done" || !result) return { title: heading, activity: "Running…", showsDuration: true };
			const output = resultText(result);
			const exit = /exited with code (\d+)/.exec(output)?.[1];
			const details = result.details as BashToolDetails | undefined;
			const status: UiNodeStyledText = [
				result.isError
					? { text: exit ? `exit ${exit}` : "failed", token: "error" }
					: { text: "done", token: "success" },
				{ text: ` (${output.split("\n").filter((line) => line.trim()).length} lines)`, token: "muted" },
				...(details?.truncation?.truncated ? [{ text: " [truncated]", token: "warning" as const }] : []),
			];
			const lines = output.split("\n");
			return {
				title: heading,
				showsDuration: true,
				summary: [text("status", status)],
				body: [
					text("status", status),
					{
						// The newest 20 lines; the terminal node counts the earlier ones
						type: "terminal",
						key: "output",
						lines: lines.slice(-20),
						...(lines.length > 20 ? { omittedLines: lines.length - 20 } : {}),
					},
				],
			};
		},
	});

	// --- edit: the path and the diff stats ---
	const originalEdit = createEditTool(cwd);
	volt.registerTool({
		name: "edit",
		label: "edit",
		description: originalEdit.description,
		parameters: originalEdit.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalEdit.execute(toolCallId, params, signal, onUpdate);
		},

		present({ args, state, result }) {
			const heading = title("edit", args.path);
			if (state !== "done" || !result) return { title: heading, activity: "Editing…" };
			if (result.isError) {
				return { title: heading, summary: [text("error", resultText(result).split("\n")[0] ?? "", "error")] };
			}
			const diff = (result.details as EditToolDetails | undefined)?.diff;
			if (!diff) return { title: heading, summary: [text("applied", "Applied", "success")] };
			const lines = diff.split("\n");
			const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
			const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
			const stats = text("stats", [
				{ text: `+${added}`, token: "success" },
				{ text: " / ", token: "muted" },
				{ text: `-${removed}`, token: "error" },
			]);
			return {
				title: heading,
				summary: [stats],
				body: [
					stats,
					{
						type: "diff",
						key: "diff",
						path: args.path,
						lines: lines.slice(0, 30).map(diffLine),
					},
					...(lines.length > 30 ? [text("more", `… ${lines.length - 30} more diff lines`, "muted")] : []),
				],
			};
		},
	});

	// --- write: the path and the size ---
	const originalWrite = createWriteTool(cwd);
	volt.registerTool({
		name: "write",
		label: "write",
		description: originalWrite.description,
		parameters: originalWrite.parameters,

		async execute(toolCallId, params, signal, onUpdate) {
			return originalWrite.execute(toolCallId, params, signal, onUpdate);
		},

		present({ args, state, result }) {
			const lineCount = typeof args.content === "string" ? `(${args.content.split("\n").length} lines)` : undefined;
			const heading = title("write", args.path, lineCount);
			if (state !== "done" || !result) return { title: heading, activity: "Writing…" };
			if (result.isError) {
				return { title: heading, summary: [text("error", resultText(result).split("\n")[0] ?? "", "error")] };
			}
			return { title: heading, summary: [text("written", "Written", "success")] };
		},
	});
}
