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
	normalizeReviewPath,
	reviewPathFromUtf8,
	type ReviewEngineContext,
	type ToolDefinition,
	truncateHead,
} from "@hansjm10/volt-coding-agent";
import { type TSchema, Type } from "typebox";
import type { Checkout, ReviewTarget } from "./types.ts";

export function insideRoot(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The allowed roots as given and with symlinks resolved (as given when a root cannot be resolved). */
interface Roots {
	given: readonly string[];
	resolved: readonly string[];
}

function rootsOf(paths: readonly string[]): Roots {
	const resolved = paths.map((path) => {
		try {
			return realpathSync(path);
		} catch {
			return path;
		}
	});
	return { given: paths, resolved };
}

/**
 * Throws unless the path stays inside one of the allowed roots. An existing path is resolved and compared with the
 * resolved roots, so a root reached through a symlink (macOS's /var -> /private/var) keeps its files while an
 * in-root symlink to elsewhere does not. A nonexistent path is checked lexically against both spellings of the roots.
 */
function assertInsideRoots(roots: Roots, absolutePath: string): void {
	let target: string | undefined;
	try {
		target = realpathSync(absolutePath);
	} catch {
		// Nonexistent paths are checked lexically; the tool reports them as missing.
	}
	const inside =
		target === undefined
			? [...roots.given, ...roots.resolved].some((root) => insideRoot(root, absolutePath))
			: roots.resolved.some((root) => insideRoot(root, target));
	if (!inside) throw new Error(`Access outside the repository under review is not allowed: ${absolutePath}`);
}

/**
 * Validate the path a report names against the immutable head, not a possibly unrepresentable checkout filename:
 * it must be the canonical reference of a text file there. The host is asked whether that file exists, which reads
 * nothing as far as the review's coverage goes. A reviewer that read the file with a checkout tool may report the
 * name it saw there; the error then names the reference to report instead.
 */
export async function canonicalHeadPath(engine: Pick<ReviewEngineContext, "hasTextFile">, raw: string): Promise<string> {
	let failure: string;
	try {
		const path = normalizeReviewPath(raw);
		if (path !== raw) failure = `Report the canonical snapshot path reference ${path}.`;
		else if (await engine.hasTextFile(path, "head")) return path;
		else failure = `${path} does not exist in the head snapshot, or is not a text file the host can read.`;
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	}
	let encoded: string | undefined;
	try {
		encoded = reviewPathFromUtf8(raw);
	} catch {
		// Not a filename either.
	}
	if (encoded !== undefined && encoded !== raw && (await engine.hasTextFile(encoded, "head"))) {
		throw new Error(
			`${JSON.stringify(raw)} is the checkout's filename, not a canonical snapshot path reference. Report ${encoded}.`,
		);
	}
	throw new Error(failure);
}

function pathArgument(params: unknown): string | undefined {
	return typeof params === "object" && params !== null && "path" in params && typeof params.path === "string"
		? params.path
		: undefined;
}

/** The spaces the built-in tools rewrite to an ASCII space before they resolve a path (utils/paths.ts). */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/;

const SNAPSHOT_TOOLS = "Read it with review_file, search it with review_search, or list it with review_tree.";

/**
 * Where the built-in tools resolve `argument` when it is in one of the forms they read as a native OS path: an
 * absolute path, a `file://` URL, `~`, `~/`, `~\` on Windows, or one that climbs out with `../` or `..\`. Undefined
 * for any other argument, which names something in the checkout. This is the one place that decides which it is, and
 * it follows normalizePath and resolvePath in packages/coding-agent/src/utils/paths.ts, Unicode spaces included. Their
 * leading `@` is left out on purpose: an argument that starts with one is a name in the checkout here.
 */
function nativeArgument(argument: string, cwd: string): string | undefined {
	const path = argument.replace(new RegExp(UNICODE_SPACES, "g"), " ");
	if (path === "~") return homedir();
	if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
		return join(homedir(), path.slice(2));
	}
	if (path.startsWith("file://")) return fileURLToPath(path);
	if (isAbsolute(path)) return resolve(path);
	if (path.startsWith("../") || path.startsWith("..\\")) return resolve(cwd, path);
	return undefined;
}

/** What {@link resolveCheckoutPath} asks of the filesystem. */
export interface CheckoutPathProbe {
	/** Throws unless `path` stays inside the roots the tools may reach. Called for a path before anything else is. */
	confine(path: string): void;
	exists(path: string): boolean;
}

/** What a checkout tool does with its `path` argument. */
export type CheckoutPath =
	| {
			/** The argument to give the built-in tool. */
			path: string;
			/** The canonical reference of what it opens, when that is in the checkout and is not what was typed. */
			reference?: string;
	  }
	| { refusal: string };

/**
 * Decide what a checkout tool opens for `argument`. The tools print the checkout's own filenames, and a reviewer
 * copies references out of the diff, so both spellings are taken:
 *
 * - A native form (see {@link nativeArgument}) goes to the tool as typed, once where it leads is confined.
 * - Anything else is first a name in the checkout, as `ls`, `find`, and `grep` print it. When it is also a canonical
 *   reference that decodes to another name (`100%25.ts` for the file `100%.ts`), that is a second reading. The one
 *   that exists is opened. When both exist the argument is refused, since guessing could read the wrong file.
 * - A canonical reference the checkout does not serve is refused, whether or not some file has those characters
 *   for a name: the reviewer most likely means the head's path, and the snapshot tools read that.
 *
 * Whatever is chosen inside the checkout must be a path the host says the checkout serves under that name: otherwise
 * the file there is not the head's (a case alias, a name Windows shortens), and it is refused. A name in the
 * checkout goes to the tool as `./name`, so the tool's own `@` and `~` handling cannot apply, and one with a Unicode
 * space the tool would rewrite is refused. Only that name is checked, never the checkout's own directory.
 *
 * A path nothing is at is refused too, in either form. The built-in read tool looks for a file it does not find under
 * other spellings of its name (resolveReadPath in packages/coding-agent/src/core/tools/path-utils.ts), and the file it
 * then opened would be one that nothing here checked, shown under the name asked for.
 */
export function resolveCheckoutPath(argument: string, checkout: Checkout, probe: CheckoutPathProbe): CheckoutPath {
	const cwd = checkout.path;
	/** The canonical reference of `absolute` when it is inside the checkout and not its root, or why it has none. */
	const referenceOf = (absolute: string): { reference?: string; refusal?: string } => {
		if (absolute === cwd || !insideRoot(cwd, absolute)) return {};
		let reference: string;
		try {
			reference = reviewPathFromUtf8(relative(cwd, absolute).split(sep).join("/"));
		} catch {
			return { refusal: `No canonical reference names ${JSON.stringify(argument)}. ${SNAPSHOT_TOOLS}` };
		}
		return checkout.nativePath(reference) === undefined
			? {
					refusal: `The checkout does not hold ${reference} under a name these tools can open. ${SNAPSHOT_TOOLS}`,
				}
			: { reference };
	};
	const typed = argument.replace(/^\.\//, "").replace(/\/+$/, "");

	const native = nativeArgument(argument, cwd);
	if (native !== undefined) {
		// The tool would open the rewritten path, not the one typed: a checkout under such a directory is reached by
		// names relative to it instead.
		if (UNICODE_SPACES.test(argument)) {
			return {
				refusal:
					"These tools rewrite a Unicode space other than the ASCII one in a native path. Pass a path relative to the checkout instead.",
			};
		}
		probe.confine(native);
		const { reference, refusal } = referenceOf(native);
		if (refusal !== undefined) return { refusal };
		if (!probe.exists(native)) return { refusal: `Nothing is at ${JSON.stringify(argument)}.` };
		return { path: argument, ...(reference === undefined ? {} : { reference }) };
	}

	const named = resolve(cwd, argument);
	probe.confine(named);
	let asReference: string | undefined;
	try {
		asReference = normalizeReviewPath(argument);
	} catch {
		// Not a canonical reference: a name only.
	}
	// Where the argument leads when read as a reference, if that is another file than the one of its name.
	let decoded: string | undefined;
	if (asReference !== undefined) {
		const served = checkout.nativePath(asReference);
		if (served === undefined) {
			const literal = probe.exists(named) && referenceOf(named).refusal === undefined;
			return {
				refusal: `The checkout does not hold ${asReference} under a name these tools can open. ${SNAPSHOT_TOOLS}${literal ? ` For the checkout's own file named ${JSON.stringify(argument)}, pass its absolute path ${JSON.stringify(named)}.` : ""}`,
			};
		}
		if (referenceOf(named).reference !== asReference) decoded = served;
	}
	let chosen = named;
	// Whether something is at `chosen`, once that has been asked.
	let present: boolean | undefined;
	if (decoded !== undefined) {
		probe.confine(decoded);
		if (probe.exists(decoded)) {
			if (probe.exists(named)) {
				return {
					refusal: `${JSON.stringify(argument)} names two files in this checkout: the file of that name, and the file that reference names. Pass an absolute path: ${JSON.stringify(named)} for the first, or ${JSON.stringify(decoded)} for the second.`,
				};
			}
			chosen = decoded;
			present = true;
		}
	}
	const { reference, refusal } = referenceOf(chosen);
	if (refusal !== undefined) return { refusal };
	const name = relative(cwd, chosen);
	if (UNICODE_SPACES.test(name)) {
		return {
			refusal: `These tools cannot open a name with a Unicode space other than the ASCII one. ${SNAPSHOT_TOOLS}${reference === undefined ? "" : ` Its canonical reference is ${reference}.`}`,
		};
	}
	if (!(present ?? probe.exists(chosen))) {
		return { refusal: `Nothing is at ${JSON.stringify(argument)} in this checkout.` };
	}
	return {
		// A path on another drive has no relative spelling.
		path: name === "" ? "." : isAbsolute(name) ? chosen : `./${name}`,
		...(reference === undefined || reference === typed ? {} : { reference }),
	};
}

/**
 * Gives a built-in tool the `path` {@link resolveCheckoutPath} settles on, refuses what it refuses, and adds the
 * canonical reference of what was opened when that is not what was typed.
 */
function confineTool<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails>,
	checkout: Checkout,
	roots: Roots,
) {
	const probe: CheckoutPathProbe = { confine: (path) => assertInsideRoots(roots, path), exists: existsSync };
	return defineTool({
		...tool,
		description: `${tool.description} A relative path is a name in this checkout, as these tools print it. A canonical review reference (%HH escapes) is accepted too: when it decodes to another name, the file that exists is opened, and it is refused when both do. Printed names are the checkout's filenames, not references; the result names the reference of the path you pass when it is not what you typed. Use review_file, review_search, and review_tree for what this checkout does not hold.`,
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const argument = pathArgument(params);
			if (!argument) return tool.execute(toolCallId, params, signal, onUpdate, ctx);
			const resolved = resolveCheckoutPath(argument, checkout, probe);
			if ("refusal" in resolved) throw new Error(resolved.refusal);
			const result = await tool.execute(
				toolCallId,
				{ ...params, path: resolved.path } as typeof params,
				signal,
				onUpdate,
				ctx,
			);
			if (resolved.reference === undefined) return result;
			return {
				...result,
				content: [
					...result.content,
					{
						type: "text" as const,
						text: `Canonical reference for the requested checkout path: ${resolved.reference}`,
					},
				],
			};
		},
	});
}

/**
 * Read-only inspection tools rooted at the frozen checkout. Paths may resolve into the checkout or the original
 * repository (where linked dependencies live), never elsewhere, so a prompt injection in the reviewed change cannot
 * pull host files into findings. read, grep, and ls also check the resolved paths they actually open; find relies
 * on confineTool alone because guarding its resolved path would require replacing the fd backend.
 */
export function createRepositoryTools(target: ReviewTarget, checkout: Checkout) {
	const cwd = checkout.path;
	const roots = rootsOf([cwd, target.repoRoot]);
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
			checkout,
			roots,
		),
		confineTool(
			createGrepToolDefinition(cwd, {
				operations: {
					isDirectory: (path) => statSync(guard(path)).isDirectory(),
					readFile: (path) => readFileSync(guard(path), "utf8"),
				},
			}),
			checkout,
			roots,
		),
		confineTool(createFindToolDefinition(cwd), checkout, roots),
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
			checkout,
			roots,
		),
		createReadBaseTool(target),
	];
}

export const REPOSITORY_TOOL_NAMES = ["read", "grep", "find", "ls", "read_base"];

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
			const path = normalizeReviewPath(params.path);
			const content = await target.readBase(path, signal ?? new AbortController().signal);
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
