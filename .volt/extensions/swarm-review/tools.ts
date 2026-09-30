import { constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	defineTool,
	type ToolDefinition,
	truncateHead,
} from "@hansjm10/volt-coding-agent";
import { type TSchema, Type } from "typebox";
import { readBaseFile } from "./git.ts";
import type { ReviewTarget } from "./types.ts";

export function insideRoot(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Throws unless the path, with symlinks resolved when it exists, stays inside one of the allowed roots. */
function assertInsideRoots(roots: readonly string[], absolutePath: string): void {
	let target = absolutePath;
	try {
		target = realpathSync(absolutePath);
	} catch {
		// Nonexistent paths are checked lexically; the tool reports them as missing.
	}
	if (!roots.some((root) => insideRoot(root, target))) {
		throw new Error(`Access outside the repository under review is not allowed: ${absolutePath}`);
	}
}

/** Returns the checkout-relative path of an existing file inside the checkout, or undefined. */
export function normalizeFile(checkout: string, raw: string): string | undefined {
	const absolute = resolve(checkout, raw.trim().replace(/^@/, ""));
	if (absolute === checkout || !insideRoot(checkout, absolute) || !existsSync(absolute)) return undefined;
	return relative(checkout, absolute).split(sep).join("/");
}

function pathArgument(params: unknown): string | undefined {
	return typeof params === "object" && params !== null && "path" in params && typeof params.path === "string"
		? params.path
		: undefined;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/**
 * Mirrors the built-in tools' resolveToCwd (normalizePath in packages/coding-agent/src/utils/paths.ts):
 * Unicode spaces become ASCII spaces, then `@` is stripped, then `~`, `~/`, `~\` (Windows), and file URLs expand.
 */
function resolveLikeBuiltinTools(root: string, raw: string): string {
	let path = raw.replace(UNICODE_SPACES, " ");
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") path = homedir();
	else if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
		path = join(homedir(), path.slice(2));
	} else if (path.startsWith("file://")) path = fileURLToPath(path);
	return resolve(root, path);
}

/**
 * Rejects `path` arguments that escape the allowed roots with a clear error. Both the raw spelling and the built-in
 * tools' normalized resolution are checked, so neither side of a normalization mismatch can escape.
 */
function confineTool<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails>,
	cwd: string,
	roots: readonly string[],
) {
	return defineTool({
		...tool,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const raw = pathArgument(params);
			if (raw) {
				assertInsideRoots(roots, resolve(cwd, raw));
				assertInsideRoots(roots, resolveLikeBuiltinTools(cwd, raw));
			}
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
	});
}

/**
 * Read-only inspection tools rooted at the frozen checkout. Paths may resolve into the checkout or the original
 * repository (where linked dependencies live), never elsewhere, so a prompt injection in the reviewed change cannot
 * pull host files into findings. read, grep, and ls also check the resolved paths they actually open; find relies
 * on confineTool alone because guarding its resolved path would require replacing the fd backend.
 */
export function createRepositoryTools(target: ReviewTarget) {
	const cwd = target.checkout;
	const roots = [target.checkout, target.repoRoot];
	const guard = (path: string): string => {
		assertInsideRoots(roots, path);
		return path;
	};
	return [
		confineTool(
			createReadToolDefinition(cwd, {
				operations: {
					access: (path) => access(guard(path), constants.R_OK),
					readFile: (path) => readFile(guard(path)),
				},
			}),
			cwd,
			roots,
		),
		confineTool(
			createGrepToolDefinition(cwd, {
				operations: {
					isDirectory: (path) => statSync(guard(path)).isDirectory(),
					readFile: (path) => readFileSync(guard(path), "utf8"),
				},
			}),
			cwd,
			roots,
		),
		confineTool(createFindToolDefinition(cwd), cwd, roots),
		confineTool(
			createLsToolDefinition(cwd, {
				// Only the listed directory is guarded. ls stats each entry just for a "/" suffix and skips entries whose
				// stat fails, so guarding stat would hide in-repository symlink entries without protecting anything.
				operations: {
					exists: (path) => existsSync(guard(path)),
					stat: (path) => statSync(path),
					readdir: (path) => readdirSync(guard(path)),
				},
			}),
			cwd,
			roots,
		),
		createReadBaseTool(target),
	];
}

export const REPOSITORY_TOOL_NAMES = ["read", "grep", "find", "ls", "read_base"];

/** Rejects absolute paths and `..` segments; returns a normalized repository-relative path. */
function repositoryPath(raw: string): string | undefined {
	const path = raw
		.trim()
		.replace(/^@/, "")
		.replace(/\\/g, "/")
		.replace(/^(\.\/)+/, "");
	if (!path || isAbsolute(path) || path.split("/").some((segment) => segment === "..")) return undefined;
	return path;
}

function createReadBaseTool(target: ReviewTarget) {
	return defineTool({
		name: "read_base",
		label: "Read base",
		description: `Read a file as it was before the change under review (the base revision). Use it for removed lines, deleted files, and previous behavior. Paths are repository-relative. Output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; use offset/limit for more.`,
		promptSnippet: "Read a file as it was before the change (removed lines, deleted files)",
		parameters: Type.Object({
			path: Type.String({ description: "Repository-relative path" }),
			offset: Type.Optional(
				Type.Integer({ minimum: 1, description: "Line number to start reading from (1-indexed)" }),
			),
			limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines to read" })),
		}),
		async execute(_toolCallId, params, signal) {
			const path = repositoryPath(params.path);
			if (!path) throw new Error(`read_base needs a repository-relative path: ${params.path}`);
			const content = await readBaseFile(target, path, signal ?? new AbortController().signal);
			if (content === undefined) {
				throw new Error(`${path} does not exist in the base revision (it may be new in this change).`);
			}
			const lines = content.split("\n");
			const start = (params.offset ?? 1) - 1;
			if (start >= lines.length) throw new Error(`Offset ${params.offset} is beyond the end of ${path}.`);
			const selected = lines.slice(start, params.limit === undefined ? undefined : start + params.limit);
			const truncation = truncateHead(selected.join("\n"));
			const shownEnd = start + truncation.outputLines;
			const note =
				truncation.truncated || shownEnd < lines.length
					? `\n\n[Showing lines ${start + 1}-${shownEnd} of ${lines.length}. Use offset=${shownEnd + 1} to continue.]`
					: "";
			return {
				content: [{ type: "text", text: `${truncation.content}${note}` }],
				details: { path, lines: lines.length },
			};
		},
	});
}
