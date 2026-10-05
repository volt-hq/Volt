import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import path from "path";
import { type Static, Type } from "typebox";
import { spawnProcess } from "../../utils/child-process.ts";
import { ensureTool, getToolPath } from "../../utils/tools-manager.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { presentGrep } from "./query-presenters.ts";
import { getRepositoryObservationContext, RepositoryObservationError } from "./repository-observation.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: "Search file contents for patterns (respects .gitignore)",
		parameters: grepSchema,
		present: presentGrep,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const observation = getRepositoryObservationContext();
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						// ensureTool's boolean controls logging, not installation. Never install for managed reads.
						const rgPath = observation ? getToolPath("rg") : await ensureTool("rg", true);
						if (observation && signal?.aborted) throw new Error("Operation aborted");
						if (!rgPath) {
							settle(() =>
								reject(
									observation
										? new RepositoryObservationError(
												"unavailable",
												"backend_unavailable",
												"ripgrep (rg) is not available",
											)
										: new Error("ripgrep (rg) is not available and could not be downloaded"),
								),
							);
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							if (observation && signal?.aborted) throw new Error("Operation aborted");
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}
						if (observation && signal?.aborted) throw new Error("Operation aborted");

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const fileCache = new Map<string, string[]>();
						const getFileLines = async (filePath: string): Promise<string[]> => {
							if (observation && signal?.aborted) throw new Error("Operation aborted");
							let lines = fileCache.get(filePath);
							if (!lines) {
								try {
									const content = await ops.readFile(filePath);
									lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
								} catch {
									lines = [];
								}
								if (observation && signal?.aborted) throw new Error("Operation aborted");
								fileCache.set(filePath, lines);
							}
							return lines;
						};

						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						const useFixedStrings = literal || pattern.startsWith("-");
						if (useFixedStrings) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);
						args.push("--", pattern, searchPath);

						const child = spawnProcess(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let childError: Error | undefined;
						let matchCount = 0;
						let matchLimitReached = false;
						let linesTruncated = false;
						let aborted = false;
						let killedDueToLimit = false;
						let stopRequested = false;
						const outputLines: string[] = [];
						const observedMatches: Array<{ path: string; line: number; text: string; outputEndLine: number }> =
							[];
						let observedOutputLines = 0;
						let observationIncomplete = false;
						const observeLine = (
							filePath: string,
							relativePath: string,
							line: number,
							rawText: string,
							isMatch: boolean,
						) => {
							if (!observation) return;
							const text = rawText.slice(0, GREP_MAX_LINE_LENGTH);
							// Count from producer fields, including newlines in filenames, not rendered-text parsing.
							observedOutputLines += relativePath.split("\n").length + text.split("\n").length - 1;
							if (isMatch) {
								observedMatches.push({
									path: path.resolve(cwd, filePath),
									line,
									text,
									outputEndLine: observedOutputLines - 1,
								});
							}
						};

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed && !stopRequested) {
								stopRequested = true;
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						const formatBlock = async (filePath: string, lineNumber: number): Promise<string[]> => {
							const relativePath = formatPath(filePath);
							const lines = await getFileLines(filePath);
							if (!lines.length) {
								observationIncomplete = true;
								observeLine(filePath, relativePath, lineNumber, "(unable to read file)", false);
								return [`${relativePath}:${lineNumber}: (unable to read file)`];
							}
							if (lineNumber > lines.length) observationIncomplete = true;
							const block: string[] = [];
							const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
							const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
							for (let current = start; current <= end; current++) {
								const lineText = lines[current - 1] ?? "";
								const sanitized = lineText.replace(/\r/g, "");
								const isMatchLine = current === lineNumber;
								// Truncate long lines so grep output stays compact.
								const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
								if (wasTruncated) linesTruncated = true;
								observeLine(filePath, relativePath, current, sanitized, isMatchLine);
								if (isMatchLine) block.push(`${relativePath}:${current}: ${truncatedText}`);
								else block.push(`${relativePath}-${current}- ${truncatedText}`);
							}
							return block;
						};

						// Collect matches during streaming, then format them after rg exits.
						const matches: Array<{ filePath: string; lineNumber: number; lineText?: string }> = [];
						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								observationIncomplete = true;
								return;
							}
							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								if (filePath && typeof lineNumber === "number")
									matches.push({ filePath, lineNumber, lineText });
								if (!filePath || typeof lineNumber !== "number") observationIncomplete = true;
								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							childError = new Error(`Failed to run ripgrep: ${error.message}`);
							if (observation) {
								stopChild();
								return; // Await close even after spawn errors.
							}
							cleanup();
							settle(() => reject(childError));
						});
						child.on("close", (code) => {
							void (async () => {
								cleanup();
								if (aborted || (observation && signal?.aborted)) {
									settle(() => reject(new Error("Operation aborted")));
									return;
								}
								if (childError) {
									settle(() => reject(childError));
									return;
								}
								if (!killedDueToLimit && code !== 0 && code !== 1) {
									const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
									settle(() => reject(new Error(errorMsg)));
									return;
								}
								if (matchCount === 0) {
									observation?.capture({ kind: "grep", matches: [], truncated: observationIncomplete });
									settle(() => resolve({ content: [{ type: "text", text: "No matches found" }] }));
									return;
								}

								// Format matches after streaming finishes so custom readFile() backends can be async.
								for (const match of matches) {
									if (contextValue === 0 && match.lineText !== undefined) {
										const relativePath = formatPath(match.filePath);
										const sanitized = match.lineText
											.replace(/\r\n/g, "\n")
											.replace(/\r/g, "")
											.replace(/\n$/, "");
										const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
										if (wasTruncated) linesTruncated = true;
										observeLine(match.filePath, relativePath, match.lineNumber, sanitized, true);
										outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
									} else {
										const block = await formatBlock(match.filePath, match.lineNumber);
										if (observation && signal?.aborted) throw new Error("Operation aborted");
										outputLines.push(...block);
									}
								}

								const rawOutput = outputLines.join("\n");
								// Apply byte truncation. There is no line limit here because the match limit already capped rows.
								const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
								observation?.capture({
									kind: "grep",
									matches: observedMatches
										.filter((match) => match.outputEndLine < truncation.outputLines)
										.map(({ path, line, text }) => ({ path, line, text })),
									truncated:
										matchLimitReached || linesTruncated || truncation.truncated || observationIncomplete,
								});
								let output = truncation.content;
								const details: GrepToolDetails = {};
								// Build actionable notices for truncation and match limits.
								const notices: string[] = [];
								if (matchLimitReached) {
									notices.push(
										`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
									);
									details.matchLimitReached = effectiveLimit;
								}
								if (truncation.truncated) {
									notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
									details.truncation = truncation;
								}
								if (linesTruncated) {
									notices.push(
										`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
									);
									details.linesTruncated = true;
								}
								if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
								settle(() =>
									resolve({
										content: [{ type: "text", text: output }],
										...(Object.keys(details).length > 0 ? { details } : {}),
									}),
								);
							})().catch((error: unknown) => {
								settle(() => reject(observation && signal?.aborted ? new Error("Operation aborted") : error));
							});
						});
						if (observation && signal?.aborted) onAbort();
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
	};
}

export function createGrepTool(
	cwd: string,
	options?: GrepToolOptions,
): AgentTool<typeof grepSchema, GrepToolDetails | undefined> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
