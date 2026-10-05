import type { AgentTool } from "@hansjm10/volt-agent-core";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "fs/promises";
import { dirname } from "path";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { LspOperationMetadata } from "../lsp/outcome.ts";
import { collectToolDiagnostics, type ToolDiagnosticsProvider } from "./diagnostics-provider.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";
import { presentWrite } from "./presenters.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
	lsp?: LspOperationMetadata;
	/** Formatted diagnostics collected after the write (e.g. from LSP) */
	diagnostics?: string;
}

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
export interface WriteOperations {
	/** Write content to a file */
	writeFile: (absolutePath: string, content: string) => Promise<void>;
	/** Create directory recursively */
	mkdir: (dir: string) => Promise<void>;
}

const defaultWriteOperations: WriteOperations = {
	writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
	mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};

export interface WriteToolOptions {
	/** Custom operations for file writing. Default: local filesystem */
	operations?: WriteOperations;
	/** Optional post-write diagnostics provider (e.g. LSP). Failures are ignored. */
	diagnosticsProvider?: ToolDiagnosticsProvider;
}

export function createWriteToolDefinition(
	cwd: string,
	options?: WriteToolOptions,
): ToolDefinition<typeof writeSchema, WriteToolDetails | undefined> {
	const ops = options?.operations ?? defaultWriteOperations;
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		promptSnippet: "Create or overwrite files",
		promptGuidelines: ["Use write only for new files or complete rewrites."],
		parameters: writeSchema,
		async execute(
			_toolCallId,
			{ path, content }: { path: string; content: string },
			signal?: AbortSignal,
			_onUpdate?,
			_ctx?,
		) {
			const absolutePath = resolveToCwd(path, cwd);
			const dir = dirname(absolutePath);
			return withFileMutationQueue(absolutePath, async () => {
				// Do not reject from an abort event listener here: that would release the
				// mutation queue while an in-flight filesystem operation may still finish.
				// Checking signal.aborted after each await observes the same aborts while
				// keeping the queue locked until the current operation has settled.
				const throwIfAborted = (): void => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};

				throwIfAborted();
				// Create parent directories if needed.
				await ops.mkdir(dir);
				throwIfAborted();

				// Write the file contents.
				await ops.writeFile(absolutePath, content);
				throwIfAborted();

				const { diagnostics, lsp } = await collectToolDiagnostics(
					options?.diagnosticsProvider,
					absolutePath,
					content,
					"write",
					signal,
				);

				return {
					content: [
						{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` },
						...(diagnostics ? [{ type: "text" as const, text: `Diagnostics:\n${diagnostics}` }] : []),
					],
					details: { lsp, ...(diagnostics ? { diagnostics } : {}) },
				};
			});
		},
		present: presentWrite,
	};
}

export function createWriteTool(
	cwd: string,
	options?: WriteToolOptions,
): AgentTool<typeof writeSchema, WriteToolDetails | undefined> {
	return wrapToolDefinition(createWriteToolDefinition(cwd, options));
}
