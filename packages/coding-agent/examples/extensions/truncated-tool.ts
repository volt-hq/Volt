/**
 * Truncated Tool Example - Demonstrates proper output truncation for custom tools
 *
 * Custom tools MUST truncate their output to avoid overwhelming the LLM context.
 * The built-in limit is 50KB (~10k tokens) and 2000 lines, whichever is hit first.
 *
 * This example shows how to:
 * 1. Use the built-in truncation utilities
 * 2. Write full output to a temp file when truncated
 * 3. Inform the LLM where to find the complete output
 * 4. Present calls as UI data with present()
 *
 * The `rg` tool here wraps ripgrep with proper truncation. Compare this to the
 * built-in `grep` tool in src/core/tools/grep.ts for a more complete implementation.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineManifest,
	type ExtensionAPI,
	formatSize,
	type TruncationResult,
	truncateHead,
	withFileMutationQueue,
} from "@hansjm10/volt-coding-agent";
import type { UiNode, UiNodeStyledText } from "@hansjm10/volt-protocol";
import { execSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { Type } from "typebox";

const RgParams = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex)" }),
	path: Type.Optional(Type.String({ description: "Directory to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "File glob pattern, e.g. '*.ts'" })),
});

interface RgDetails {
	pattern: string;
	path?: string;
	glob?: string;
	matchCount: number;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export const manifest = defineManifest({
	id: "truncated-tool",
	displayName: "Truncated Tool",
	description: "Demonstrates proper output truncation for custom tools.",
});

export default function (volt: ExtensionAPI) {
	volt.registerTool({
		name: "rg",
		label: "ripgrep",
		// Document the truncation limits in the tool description so the LLM knows
		description: `Search file contents using ripgrep. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). If truncated, full output is saved to a temp file.`,
		parameters: RgParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { pattern, path: searchPath, glob } = params;
			// Details hold only JSON data: optional fields are left out rather than undefined
			const where = { ...(searchPath ? { path: searchPath } : {}), ...(glob ? { glob } : {}) };

			// Build the ripgrep command
			const args = ["rg", "--line-number", "--color=never"];
			if (glob) args.push("--glob", glob);
			args.push(pattern);
			args.push(searchPath || ".");

			let output: string;
			try {
				output = execSync(args.join(" "), {
					cwd: ctx.cwd,
					encoding: "utf-8",
					maxBuffer: 100 * 1024 * 1024, // 100MB buffer to capture full output
				});
			} catch (err: any) {
				// ripgrep exits with 1 when no matches found
				if (err.status === 1) {
					return {
						content: [{ type: "text", text: "No matches found" }],
						details: { pattern, ...where, matchCount: 0 } as RgDetails,
					};
				}
				throw new Error(`ripgrep failed: ${err.message}`);
			}

			if (!output.trim()) {
				return {
					content: [{ type: "text", text: "No matches found" }],
					details: { pattern, ...where, matchCount: 0 } as RgDetails,
				};
			}

			// Apply truncation using built-in utilities
			// truncateHead keeps the first N lines/bytes (good for search results)
			// truncateTail keeps the last N lines/bytes (good for logs/command output)
			const truncation = truncateHead(output, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});

			// Count matches (each non-empty line with a match)
			const matchCount = output.split("\n").filter((line) => line.trim()).length;

			const details: RgDetails = {
				pattern,
				...where,
				matchCount,
			};

			let resultText = truncation.content;

			if (truncation.truncated) {
				// Save full output to a temp file so LLM can access it if needed
				const tempDir = await mkdtemp(join(tmpdir(), "volt-rg-"));
				const tempFile = join(tempDir, "output.txt");
				await withFileMutationQueue(tempFile, async () => {
					await writeFile(tempFile, output, "utf8");
				});

				details.truncation = truncation;
				details.fullOutputPath = tempFile;

				// Add truncation notice - this helps the LLM understand the output is incomplete
				const truncatedLines = truncation.totalLines - truncation.outputLines;
				const truncatedBytes = truncation.totalBytes - truncation.outputBytes;

				resultText += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
				resultText += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
				resultText += ` ${truncatedLines} lines (${formatSize(truncatedBytes)}) omitted.`;
				resultText += ` Full output saved to: ${tempFile}]`;
			}

			return {
				content: [{ type: "text", text: resultText }],
				details,
			};
		},

		// How a call looks on every client: the search as the title, the match count
		// collapsed, and the first matches expanded.
		present({ args, state, result }) {
			const title: UiNodeStyledText = [
				{ text: "rg ", bold: true },
				{ text: `"${args.pattern ?? "…"}"`, token: "accent" },
				...(args.path ? [{ text: ` in ${args.path}`, token: "muted" as const }] : []),
				...(args.glob ? [{ text: ` --glob ${args.glob}`, token: "muted" as const }] : []),
			];
			if (state !== "done" || !result) return { title, activity: "Searching…" };

			const output = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			if (result.isError) return { title, summary: [{ type: "text", text: output, token: "error" }] };
			const details = result.details as RgDetails | undefined;
			if (!details || details.matchCount === 0) {
				return { title, summary: [{ type: "text", text: "No matches found", token: "muted" }] };
			}
			const count: UiNodeStyledText = [
				{ text: `${details.matchCount} matches`, token: "success" },
				...(details.truncation?.truncated ? [{ text: " (truncated)", token: "warning" as const }] : []),
			];
			const lines = output.trimEnd().split("\n");
			const body: UiNode[] = [
				{ type: "text", key: "count", text: count },
				// The first 20 matches, as the tool returns them
				{ type: "code", key: "matches", code: lines.slice(0, 20).join("\n") },
			];
			if (lines.length > 20) {
				body.push({ type: "text", key: "more", text: "... (use read tool to see full output)", token: "muted" });
			}
			if (details.fullOutputPath) {
				body.push({ type: "text", key: "full", text: `Full output: ${details.fullOutputPath}`, token: "muted" });
			}
			return { title, summary: [{ type: "text", key: "count", text: count }], body };
		},
	});
}
