import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import type { AgentTool } from "@hansjm10/volt-agent-core";
import type { Api, ImageContent, Model, TextContent } from "@hansjm10/volt-ai";
import { constants } from "fs";
import { access as fsAccess, readFile as fsReadFile } from "fs/promises";
import { type Static, Type } from "typebox";
import { formatDimensionNote, resizeImage } from "../../utils/image-resize.ts";
import { detectSupportedImageMimeType, detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { presentRead } from "./presenters.ts";
import { getRepositoryObservationContext, RepositoryObservationError } from "./repository-observation.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
	truncation?: TruncationResult;
}

/**
 * Pluggable operations for the read tool.
 * Override these to delegate file reading to remote systems (for example SSH).
 */
export interface ReadOperations {
	/** Read file contents as a Buffer */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not) */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
};

export interface ReadToolOptions {
	/** Whether to auto-resize images to 2000x2000 max. Default: true */
	autoResizeImages?: boolean;
	/** Custom operations for file reading. Default: local filesystem */
	operations?: ReadOperations;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) {
		return undefined;
	}
	return "[Current model does not support images. The image will be omitted from this request.]";
}

export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const customOps = options?.operations;
	const ops = customOps ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		promptSnippet: "Read file contents",
		promptGuidelines: ["Use read to examine files instead of cat or sed."],
		parameters: readSchema,
		async execute(
			_toolCallId,
			{ path, offset, limit }: { path: string; offset?: number; limit?: number },
			signal?: AbortSignal,
			_onUpdate?,
			ctx?,
		) {
			const observation = getRepositoryObservationContext();
			return new Promise<{ content: (TextContent | ImageContent)[]; details?: ReadToolDetails }>(
				(resolve, reject) => {
					if (signal?.aborted) {
						reject(new Error("Operation aborted"));
						return;
					}
					let aborted = false;
					const onAbort = () => {
						aborted = true;
						// Managed work keeps ownership until the in-flight file operation has drained.
						if (!observation) reject(new Error("Operation aborted"));
					};
					signal?.addEventListener("abort", onAbort, { once: true });

					(async () => {
						try {
							const absolutePath =
								observation && customOps ? resolveToCwd(path, cwd) : await resolveReadPathAsync(path, cwd);
							if (aborted) throw new Error("Operation aborted");
							// Pin local managed reads to their canonical source. Custom backends must not
							// acquire local identity evidence for potentially unrelated remote content.
							const canonicalPath = observation && !customOps ? await realpath(absolutePath) : undefined;
							if (aborted) throw new Error("Operation aborted");
							const expected = observation?.expectedRead;
							if (expected && canonicalPath !== expected.path)
								throw new RepositoryObservationError(
									"invalidated",
									"resource_changed",
									"Skill resource identity changed",
								);
							const readPath = canonicalPath ?? absolutePath;
							// Check if file exists and is readable.
							await ops.access(readPath);
							if (aborted) throw new Error("Operation aborted");
							// Native managed reads sniff the actual read buffer, without a second file read.
							const mimeType =
								!canonicalPath && ops.detectImageMimeType ? await ops.detectImageMimeType(readPath) : undefined;
							if (aborted) throw new Error("Operation aborted");
							if (observation && mimeType) {
								throw new RepositoryObservationError(
									"unsupported",
									"non_text_input",
									"Binary and image reads are unsupported in repository observations",
								);
							}
							let content: (TextContent | ImageContent)[];
							let details: ReadToolDetails | undefined;
							const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
							if (mimeType) {
								// Read image as binary.
								const buffer = await ops.readFile(readPath);
								if (aborted) throw new Error("Operation aborted");
								if (autoResizeImages) {
									// Resize image if needed before sending it back to the model.
									const resized = await resizeImage(buffer, mimeType);
									if (aborted) throw new Error("Operation aborted");
									if (!resized) {
										const reason =
											mimeType === "image/webp"
												? "WebP exceeds the inline limits and Volt does not include a local WebP resize codec."
												: "Image could not be resized below the inline image size limit.";
										let textNote = `Read image file [${mimeType}]\n[Image omitted: ${reason}]`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [{ type: "text", text: textNote }];
									} else {
										const dimensionNote = formatDimensionNote(resized);
										let textNote = `Read image file [${resized.mimeType}]`;
										if (dimensionNote) textNote += `\n${dimensionNote}`;
										if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
										content = [
											{ type: "text", text: textNote },
											{ type: "image", data: resized.data, mimeType: resized.mimeType },
										];
									}
								} else {
									let textNote = `Read image file [${mimeType}]`;
									if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
									content = [
										{ type: "text", text: textNote },
										{ type: "image", data: buffer.toString("base64"), mimeType },
									];
								}
							} else {
								// Exact skill grants read only through a descriptor with the issued identity.
								let buffer: Buffer;
								if (expected) {
									const file = await open(readPath, "r");
									try {
										const stat = await file.stat();
										if (aborted) throw new Error("Operation aborted");
										if (stat.dev !== expected.device || stat.ino !== expected.inode)
											throw new RepositoryObservationError(
												"invalidated",
												"resource_changed",
												"Skill resource identity changed",
											);
										buffer = await file.readFile();
									} finally {
										await file.close();
									}
								} else buffer = await ops.readFile(readPath);
								if (aborted) throw new Error("Operation aborted");
								if (
									observation &&
									(detectSupportedImageMimeType(buffer) ||
										!isUtf8(buffer) ||
										buffer.some(
											(byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13,
										))
								) {
									throw new RepositoryObservationError(
										"unsupported",
										"non_text_input",
										"Binary and image reads are unsupported in repository observations",
									);
								}
								const textContent = buffer.toString("utf-8");
								const allLines = textContent.split("\n");
								const totalFileLines = allLines.length;
								// Apply offset if specified. Convert from 1-indexed input to 0-indexed array access.
								const startLine = offset ? Math.max(0, offset - 1) : 0;
								const startLineDisplay = startLine + 1;
								// Check if offset is out of bounds.
								if (startLine >= allLines.length) {
									throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
								}
								let selectedContent: string;
								let userLimitedLines: number | undefined;
								// If limit is specified by the user, honor it first. Otherwise truncateHead decides.
								if (limit !== undefined) {
									const endLine = Math.min(startLine + limit, allLines.length);
									selectedContent = allLines.slice(startLine, endLine).join("\n");
									userLimitedLines = endLine - startLine;
								} else {
									selectedContent = allLines.slice(startLine).join("\n");
								}
								// Apply truncation, respecting both line and byte limits.
								const truncation = truncateHead(selectedContent);
								if (observation && canonicalPath) {
									const currentPath = await realpath(absolutePath).catch(() => undefined);
									if (aborted) throw new Error("Operation aborted");
									// A retarget during the read makes identity unverifiable, not a local fallback.
									if (currentPath === canonicalPath) {
										observation.capture({
											kind: "read",
											path: canonicalPath,
											text: truncation.content,
											startLine: startLineDisplay,
											endLine: startLine + truncation.outputLines,
											revision: `sha256:${createHash("sha256").update(buffer).digest("hex")}`,
											truncated:
												truncation.truncated ||
												(userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length),
										});
									}
								}
								let outputText: string;
								if (truncation.firstLineExceedsLimit) {
									// First line alone exceeds the byte limit. Point the model at a bash fallback.
									const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
									outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
									details = { truncation };
								} else if (truncation.truncated) {
									// Truncation occurred. Build an actionable continuation notice.
									const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
									const nextOffset = endLineDisplay + 1;
									outputText = truncation.content;
									if (truncation.truncatedBy === "lines") {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
									} else {
										outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
									}
									details = { truncation };
								} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
									// User-specified limit stopped early, but the file still has more content.
									const remaining = allLines.length - (startLine + userLimitedLines);
									const nextOffset = startLine + userLimitedLines + 1;
									outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
								} else {
									// No truncation and no remaining user-limited content.
									outputText = truncation.content;
								}
								content = [{ type: "text", text: outputText }];
							}

							if (aborted) throw new Error("Operation aborted");
							resolve({ content, ...(details === undefined ? {} : { details }) });
						} catch (error) {
							if (observation || !aborted) reject(aborted ? new Error("Operation aborted") : error);
						} finally {
							signal?.removeEventListener("abort", onAbort);
						}
					})();
				},
			);
		},
		present: presentRead,
	};
}

export function createReadTool(
	cwd: string,
	options?: ReadToolOptions,
): AgentTool<typeof readSchema, ReadToolDetails | undefined> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
