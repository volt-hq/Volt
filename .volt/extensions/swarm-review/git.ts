import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir, loadProjectContextFiles } from "@hansjm10/volt-coding-agent";
import type { DiffShard, ReviewTarget, TargetSpec } from "./types.ts";
import { SwarmCancelled } from "./util.ts";

export const MAX_SHARD_CHARS = 200_000;
const MAX_COMMAND_OUTPUT = 256 * 1024 * 1024;
const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const SNAPSHOT_IDENTITY = {
	GIT_AUTHOR_NAME: "Volt Swarm Review",
	GIT_AUTHOR_EMAIL: "swarm-review@localhost",
	GIT_COMMITTER_NAME: "Volt Swarm Review",
	GIT_COMMITTER_EMAIL: "swarm-review@localhost",
};

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Spawns a command with stdin closed. An abort always rejects with SwarmCancelled, so partial output never passes. */
export function runCommand(
	command: string,
	args: string[],
	options: { cwd: string; signal: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
	return new Promise((resolvePromise, reject) => {
		if (options.signal.aborted) {
			reject(new SwarmCancelled());
			return;
		}
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let overflow = false;
		let stderr = "";
		let settled = false;
		const onAbort = (): void => {
			child.kill("SIGTERM");
		};
		const settle = (action: () => void): void => {
			if (settled) return;
			settled = true;
			options.signal.removeEventListener("abort", onAbort);
			action();
		};
		options.signal.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_COMMAND_OUTPUT) {
				overflow = true;
				child.kill("SIGTERM");
			} else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 64_000) stderr += chunk.toString("utf8");
		});
		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", (code, signalName) =>
			settle(() => {
				if (options.signal.aborted) reject(new SwarmCancelled());
				else if (overflow) reject(new Error(`${command} output exceeded ${MAX_COMMAND_OUTPUT} bytes`));
				else if (code === null) reject(new Error(`${command} was terminated by ${signalName ?? "a signal"}`));
				else resolvePromise({ code, stdout: Buffer.concat(chunks).toString("utf8"), stderr });
			}),
		);
	});
}

function git(cwd: string, args: string[], signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
	return runCommand("git", ["-c", "core.quotepath=off", ...args], { cwd, signal, ...(env ? { env } : {}) });
}

async function gitOk(cwd: string, args: string[], signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
	const result = await git(cwd, args, signal, env);
	if (result.code !== 0)
		throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
	return result.stdout;
}

/** Environment that also resolves objects from the given extra object directories. */
function withAlternates(extra: string[]): NodeJS.ProcessEnv {
	if (extra.length === 0) return process.env;
	const inherited = process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
	return {
		...process.env,
		GIT_ALTERNATE_OBJECT_DIRECTORIES: [...extra, ...(inherited ? [inherited] : [])].join(delimiter),
	};
}

class TargetError extends Error {}

/** Untracked paths Git for Windows cannot index because a segment names the NUL device (as the built-in /review). */
async function untrackedNullDevicePathspecs(root: string, signal: AbortSignal): Promise<string[]> {
	if (process.platform !== "win32") return [];
	const untracked = await gitOk(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal);
	return untracked
		.split("\0")
		.filter((path) => path.split("/").some((segment) => /^nul(\..*)?$/i.test(segment)))
		.map((path) => `:(top,exclude,literal)${path}`);
}

interface Snapshot {
	tree: string;
	/** Temporary object directory holding the snapshot's new blobs and trees. */
	objects: string;
}

/**
 * Captures the working tree, including untracked files that are not ignored and staged force-added files, as a tree.
 * The real index is copied, not modified, and new objects go to a temporary object directory rather than the
 * repository's, as in the built-in /review.
 */
async function snapshotWorkingTree(root: string, commonObjects: string, signal: AbortSignal): Promise<Snapshot> {
	const indexDirectory = await mkdtemp(join(tmpdir(), "volt-swarm-index-"));
	const objects = await mkdtemp(join(tmpdir(), "volt-swarm-objects-"));
	try {
		const index = join(indexDirectory, "index");
		const env = {
			...process.env,
			GIT_INDEX_FILE: index,
			GIT_OBJECT_DIRECTORY: objects,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: commonObjects,
			GIT_OPTIONAL_LOCKS: "0",
		};
		const realIndex = resolve(root, (await gitOk(root, ["rev-parse", "--git-path", "index"], signal)).trim());
		if (existsSync(realIndex)) copyFileSync(realIndex, index);
		else await gitOk(root, ["read-tree", "HEAD"], signal, env);
		await gitOk(root, ["add", "-A", "--", ".", ...(await untrackedNullDevicePathspecs(root, signal))], signal, env);
		return { tree: (await gitOk(root, ["write-tree"], signal, env)).trim(), objects };
	} catch (error) {
		await rm(objects, { recursive: true, force: true });
		throw error;
	} finally {
		await rm(indexDirectory, { recursive: true, force: true });
	}
}

/** Normalizes GitHub-style remote URLs to host/owner/repo for comparison. */
function repositoryKey(url: string): string | undefined {
	const match =
		/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim()) ?? undefined;
	return match ? `${match[1]}/${match[2]}/${match[3]}`.toLowerCase() : undefined;
}

/** A local remote pointing at the repository, so configured credentials apply; otherwise the URL itself. */
async function fetchSource(root: string, repositoryUrl: string, signal: AbortSignal): Promise<string> {
	const wanted = repositoryKey(repositoryUrl);
	const remotes = await gitOk(root, ["remote", "-v"], signal);
	for (const line of remotes.split("\n")) {
		const [name, url] = line.split(/\s+/);
		if (name && url && wanted && repositoryKey(url) === wanted) return name;
	}
	return repositoryUrl;
}

interface ResolvedRevisions {
	baseRev: string;
	headTree: string;
	description: string;
	objects?: string;
}

async function resolveRevisions(
	root: string,
	commonObjects: string,
	spec: TargetSpec,
	signal: AbortSignal,
): Promise<ResolvedRevisions> {
	if (spec.kind === "worktree") {
		if ((await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], signal)).code !== 0) {
			throw new TargetError("Swarm review needs at least one commit.");
		}
		let baseRev = (await gitOk(root, ["rev-parse", "HEAD"], signal)).trim();
		let description = "uncommitted and untracked changes";
		if (spec.base) {
			const mergeBase = await git(root, ["merge-base", spec.base, "HEAD"], signal);
			if (mergeBase.code !== 0) throw new TargetError(`Could not find a merge base between ${spec.base} and HEAD.`);
			baseRev = mergeBase.stdout.trim();
			description = `changes since ${spec.base} (merge base ${baseRev.slice(0, 10)}), including uncommitted and untracked changes`;
		}
		const snapshot = await snapshotWorkingTree(root, commonObjects, signal);
		return { baseRev, headTree: snapshot.tree, description, objects: snapshot.objects };
	}
	if (spec.kind === "commit") {
		const commit = await git(root, ["rev-parse", "--verify", "--quiet", `${spec.rev}^{commit}`], signal);
		if (commit.code !== 0) throw new TargetError(`Unknown commit ${spec.rev}.`);
		const oid = commit.stdout.trim();
		const parent = await git(root, ["rev-parse", "--verify", "--quiet", `${oid}^`], signal);
		let baseRev = parent.stdout.trim();
		if (parent.code !== 0) {
			const shallow = resolve(root, (await gitOk(root, ["rev-parse", "--git-path", "shallow"], signal)).trim());
			if (existsSync(shallow) && readFileSync(shallow, "utf8").split("\n").includes(oid)) {
				throw new TargetError(
					`The parent of ${oid.slice(0, 10)} is not available in this shallow clone. Fetch more history first.`,
				);
			}
			// A true root commit: diff against the empty tree of this repository's object format.
			baseRev = (await gitOk(root, ["hash-object", "-t", "tree", "--stdin"], signal)).trim();
		}
		const subject = (await gitOk(root, ["log", "-1", "--format=%s", oid], signal)).trim();
		return {
			baseRev,
			headTree: (await gitOk(root, ["rev-parse", `${oid}^{tree}`], signal)).trim(),
			description: `commit ${oid.slice(0, 10)} "${subject}"`,
		};
	}
	const view = await runCommand(
		"gh",
		["pr", "view", String(spec.number), "--json", "title,baseRefName,headRefOid,url"],
		{ cwd: root, signal },
	).catch((error: unknown) => {
		if (error instanceof SwarmCancelled) throw error;
		throw new TargetError("--pr needs the GitHub CLI (gh) on PATH.");
	});
	if (view.code !== 0) throw new TargetError(`gh pr view failed: ${view.stderr.trim() || `exit code ${view.code}`}`);
	const pr = JSON.parse(view.stdout) as { title?: unknown; baseRefName?: unknown; url?: unknown };
	if (typeof pr.baseRefName !== "string" || pr.baseRefName.startsWith("-") || typeof pr.url !== "string") {
		throw new TargetError("gh pr view returned no usable base branch or URL.");
	}
	// Fetch from the PR's own repository (not necessarily origin) into temporary refs, leaving FETCH_HEAD untouched.
	const repositoryUrl = `${pr.url.split("/pull/")[0]}.git`;
	const source = await fetchSource(root, repositoryUrl, signal);
	const prefix = `refs/volt-swarm-review/${randomUUID()}`;
	try {
		const fetched = await git(
			root,
			[
				"fetch",
				"--no-tags",
				"--quiet",
				"--no-write-fetch-head",
				source,
				`+refs/heads/${pr.baseRefName}:${prefix}/base`,
				`+refs/pull/${spec.number}/head:${prefix}/head`,
			],
			signal,
			{ ...process.env, GIT_TERMINAL_PROMPT: "0" },
		);
		if (fetched.code !== 0) {
			throw new TargetError(`Could not fetch PR #${spec.number} from ${source}: ${fetched.stderr.trim()}`);
		}
		const baseTip = (await gitOk(root, ["rev-parse", `${prefix}/base`], signal)).trim();
		const headOid = (await gitOk(root, ["rev-parse", `${prefix}/head`], signal)).trim();
		const baseRev = (await gitOk(root, ["merge-base", baseTip, headOid], signal)).trim();
		return {
			baseRev,
			headTree: (await gitOk(root, ["rev-parse", `${headOid}^{tree}`], signal)).trim(),
			description: `PR #${spec.number} "${typeof pr.title === "string" ? pr.title : ""}" (${headOid.slice(0, 10)} vs ${pr.baseRefName})`,
		};
	} finally {
		for (const ref of [`${prefix}/base`, `${prefix}/head`]) {
			await git(root, ["update-ref", "-d", ref], new AbortController().signal).catch(() => undefined);
		}
	}
}

/** Reverses Git's C-style path quoting, including octal byte escapes. */
function unquote(quoted: string): string {
	const bytes: number[] = [];
	const escapes: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
	for (let index = 0; index < quoted.length; index++) {
		const char = quoted[index];
		if (char !== "\\") {
			bytes.push(...Buffer.from(char, "utf8"));
			continue;
		}
		const next = quoted[++index] ?? "";
		const octal = /^[0-7]{3}/.exec(quoted.slice(index));
		if (octal) {
			bytes.push(Number.parseInt(octal[0], 8));
			index += 2;
		} else bytes.push(escapes[next] ?? next.charCodeAt(0));
	}
	return Buffer.from(bytes).toString("utf8");
}

/** The post-change path from a `diff --git` header, handling quoted paths. */
function headerPath(header: string): string {
	const quoted = /"b\/((?:[^"\\]|\\.)*)"$/.exec(header);
	if (quoted) return unquote(quoted[1]);
	return /^diff --git (?:"(?:[^"\\]|\\.)*"|a\/.*?) b\/(.*)$/.exec(header)?.[1] ?? "(unknown)";
}

function splitSections(diff: string): Array<{ file: string; text: string }> {
	const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index ?? 0);
	if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);
	return starts
		.map((start, index) => {
			const text = diff.slice(start, starts[index + 1] ?? diff.length);
			const header = text.slice(0, text.indexOf("\n") === -1 ? undefined : text.indexOf("\n"));
			return { file: header.startsWith("diff --git ") ? headerPath(header) : "(unknown)", text };
		})
		.filter((section) => section.text.length > 0);
}

/** Packs whole file sections into shards; a single oversized section is cut and marked partial. */
function packShards(diff: string): { shards: DiffShard[]; fileDiffs: Map<string, string> } {
	const shards: DiffShard[] = [];
	const fileDiffs = new Map<string, string>();
	let current: DiffShard | undefined;
	for (const section of splitSections(diff)) {
		const partial = section.text.length > MAX_SHARD_CHARS;
		const text = partial ? section.text.slice(0, section.text.lastIndexOf("\n", MAX_SHARD_CHARS) + 1) : section.text;
		fileDiffs.set(section.file, text);
		if (!current || current.diff.length + text.length > MAX_SHARD_CHARS) {
			current = { index: shards.length, files: [], partialFiles: [], diff: "" };
			shards.push(current);
		}
		current.files.push(section.file);
		if (partial) current.partialFiles.push(section.file);
		current.diff += text;
	}
	return { shards, fileDiffs };
}

interface CheckoutSource {
	repoRoot: string;
	commonObjects: string;
	objectFormat?: string;
	headTree: string;
	extraObjects: string[];
}

/**
 * Extracts the tree into a throwaway repository that borrows objects through alternates, with HEAD at a snapshot
 * commit so Git-aware commands (for --exec) see a clean tree. Ignored node_modules directories are linked in.
 */
async function materialize(source: CheckoutSource, signal: AbortSignal): Promise<string> {
	const checkout = await mkdtemp(join(tmpdir(), "volt-swarm-review-"));
	try {
		await gitOk(
			checkout,
			["init", "-q", ...(source.objectFormat ? [`--object-format=${source.objectFormat}`] : [])],
			signal,
		);
		const inherited = join(source.commonObjects, "info", "alternates");
		const alternates = [
			...source.extraObjects,
			source.commonObjects,
			...(existsSync(inherited)
				? readFileSync(inherited, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((path) => resolve(source.commonObjects, path))
				: []),
		];
		await writeFile(join(checkout, ".git", "objects", "info", "alternates"), `${alternates.join("\n")}\n`);
		const commit = (
			await gitOk(checkout, ["commit-tree", source.headTree, "-m", "Volt swarm review snapshot"], signal, {
				...process.env,
				...SNAPSHOT_IDENTITY,
			})
		).trim();
		await gitOk(checkout, ["update-ref", "HEAD", commit], signal);
		await gitOk(checkout, ["read-tree", "HEAD"], signal);
		await gitOk(checkout, ["checkout-index", "-a", "-f", "-q"], signal);
		const ignored = await gitOk(
			source.repoRoot,
			["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
			signal,
		);
		for (const entry of ignored.split("\n")) {
			if (!entry.endsWith("node_modules/")) continue;
			const relativePath = entry.slice(0, -1);
			const link = join(checkout, relativePath);
			if (existsSync(link)) continue;
			try {
				mkdirSync(dirname(link), { recursive: true });
				// Junctions need no privilege on Windows; the type is ignored elsewhere.
				symlinkSync(join(source.repoRoot, relativePath), link, process.platform === "win32" ? "junction" : "dir");
			} catch {
				// Dependencies are a convenience; a checkout without them is still reviewable.
			}
		}
		return checkout;
	} catch (error) {
		await rm(checkout, { recursive: true, force: true });
		throw error;
	}
}

/** Returns the review target, or a user-facing message when there is nothing (or no way) to review. */
export async function resolveTarget(
	cwd: string,
	spec: TargetSpec,
	scope: string[],
	signal: AbortSignal,
): Promise<ReviewTarget | string> {
	const top = await git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"], signal);
	if (top.code !== 0) return "Swarm review needs a Git repository.";
	const [rootLine, commonLine] = top.stdout.split("\n");
	const repoRoot = rootLine.trim();
	const commonDir = realpathSync(resolve(cwd, commonLine.trim()));
	const commonObjects = join(commonDir, "objects");
	const format = await git(repoRoot, ["rev-parse", "--show-object-format"], signal);
	const objectFormat = format.code === 0 ? format.stdout.trim() : undefined;
	let revisions: ResolvedRevisions;
	try {
		revisions = await resolveRevisions(repoRoot, commonObjects, spec, signal);
	} catch (error) {
		if (error instanceof TargetError) return error.message;
		throw error;
	}
	const extraObjects = revisions.objects ? [revisions.objects] : [];
	const cleanup = async (): Promise<void> => {
		for (const directory of extraObjects) await rm(directory, { recursive: true, force: true });
	};
	try {
		const env = withAlternates(extraObjects);
		const pathspecs = scope.map((pattern) => `:(glob)${pattern}`);
		const range = [revisions.baseRev, revisions.headTree, "--", ...pathspecs];
		const flags = ["--no-color", "--no-ext-diff", "--no-textconv"];
		const [diff, stat] = await Promise.all([
			gitOk(repoRoot, ["diff", ...flags, "--find-renames", ...range], signal, env),
			gitOk(repoRoot, ["diff", ...flags, "--stat=160", ...range], signal, env),
		]);
		if (!diff.trim()) {
			await cleanup();
			return `No ${revisions.description}${scope.length > 0 ? " match --scope" : ""} to review.`;
		}
		const { shards, fileDiffs } = packShards(diff);
		const source: CheckoutSource = {
			repoRoot,
			commonObjects,
			...(objectFormat ? { objectFormat } : {}),
			headTree: revisions.headTree,
			extraObjects,
		};
		const checkout = await materialize(source, signal);
		return {
			repoRoot,
			checkout,
			baseRev: revisions.baseRev,
			headTree: revisions.headTree,
			description: revisions.description,
			stat: stat.trimEnd(),
			scope,
			shards,
			fileDiffs,
			complete: shards.length === 1 && shards[0].partialFiles.length === 0,
			submodules: /^[-+]Subproject commit /m.test(diff),
			commonDir,
			createCheckout: () => materialize(source, signal),
			dispose: async () => {
				await rm(checkout, { recursive: true, force: true });
				await cleanup();
			},
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}

/** Base-revision content of a repository-relative path, or undefined when absent (for example, an added file). */
export async function readBaseFile(
	target: ReviewTarget,
	path: string,
	signal: AbortSignal,
): Promise<string | undefined> {
	const result = await git(target.repoRoot, ["cat-file", "blob", `${target.baseRev}:${path}`], signal);
	return result.code === 0 ? result.stdout : undefined;
}

function insideRoot(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Global and above-repository context files come from disk. In-repository AGENTS/CLAUDE/REVIEW files come from the
 * base revision, as in the built-in /review, so the change under review cannot rewrite its own instructions.
 */
export async function loadContextFiles(
	target: ReviewTarget,
	cwd: string,
	signal: AbortSignal,
): Promise<Array<{ path: string; content: string }>> {
	const resolvedCwd = realpathSync(cwd);
	const files = loadProjectContextFiles({ cwd: resolvedCwd, agentDir: getAgentDir() }).filter(
		(file) => !insideRoot(target.repoRoot, file.path),
	);
	const userReviewPolicy = join(getAgentDir(), "REVIEW.md");
	if (existsSync(userReviewPolicy)) {
		files.push({ path: userReviewPolicy, content: readFileSync(userReviewPolicy, "utf8") });
	}
	const relativeCwd = relative(target.repoRoot, resolvedCwd);
	const segments = insideRoot(target.repoRoot, resolvedCwd) ? relativeCwd.split(sep).filter(Boolean) : [];
	const directories = ["", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
	const revision = target.baseRev.slice(0, 10);
	for (const directory of directories) {
		for (const name of CONTEXT_FILE_NAMES) {
			const path = directory ? `${directory}/${name}` : name;
			const content = await readBaseFile(target, path, signal);
			if (content !== undefined) {
				files.push({ path: `${revision}:${path}`, content });
				break;
			}
		}
		const reviewPath = directory ? `${directory}/REVIEW.md` : "REVIEW.md";
		const review = await readBaseFile(target, reviewPath, signal);
		if (review !== undefined) files.push({ path: `${revision}:${reviewPath}`, content: review });
	}
	return files;
}
