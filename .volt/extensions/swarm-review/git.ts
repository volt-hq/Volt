import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir, loadProjectContextFiles } from "@hansjm10/volt-coding-agent";
import type { DiffShard, ReviewTarget, TargetSpec } from "./types.ts";
import { SwarmCancelled } from "./util.ts";

export const MAX_SHARD_CHARS = 200_000;
const MAX_COMMAND_OUTPUT = 256 * 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

export interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Spawns a command. An abort always rejects with SwarmCancelled, so partial output never passes as success. */
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

class TargetError extends Error {}

/** Captures the working tree, including untracked files that are not ignored, as a tree object without touching the index. */
async function snapshotWorkingTree(root: string, signal: AbortSignal): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "volt-swarm-index-"));
	try {
		const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index"), GIT_OPTIONAL_LOCKS: "0" };
		await gitOk(root, ["read-tree", "HEAD"], signal, env);
		await gitOk(root, ["add", "-A", "--", "."], signal, env);
		return (await gitOk(root, ["write-tree"], signal, env)).trim();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

interface ResolvedRevisions {
	baseRev: string;
	headTree: string;
	description: string;
}

async function resolveRevisions(root: string, spec: TargetSpec, signal: AbortSignal): Promise<ResolvedRevisions> {
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
		return { baseRev, headTree: await snapshotWorkingTree(root, signal), description };
	}
	if (spec.kind === "commit") {
		const commit = await git(root, ["rev-parse", "--verify", "--quiet", `${spec.rev}^{commit}`], signal);
		if (commit.code !== 0) throw new TargetError(`Unknown commit ${spec.rev}.`);
		const oid = commit.stdout.trim();
		const parent = await git(root, ["rev-parse", "--verify", "--quiet", `${oid}^`], signal);
		const subject = (await gitOk(root, ["log", "-1", "--format=%s", oid], signal)).trim();
		return {
			baseRev: parent.code === 0 ? parent.stdout.trim() : EMPTY_TREE,
			headTree: (await gitOk(root, ["rev-parse", `${oid}^{tree}`], signal)).trim(),
			description: `commit ${oid.slice(0, 10)} "${subject}"`,
		};
	}
	const view = await runCommand(
		"gh",
		["pr", "view", String(spec.number), "--json", "number,title,baseRefName,headRefOid"],
		{ cwd: root, signal },
	).catch((error: unknown) => {
		if (error instanceof SwarmCancelled) throw error;
		throw new TargetError("--pr needs the GitHub CLI (gh) on PATH.");
	});
	if (view.code !== 0) throw new TargetError(`gh pr view failed: ${view.stderr.trim() || `exit code ${view.code}`}`);
	const pr = JSON.parse(view.stdout) as { title?: unknown; baseRefName?: unknown };
	if (typeof pr.baseRefName !== "string" || pr.baseRefName.startsWith("-")) {
		throw new TargetError("gh pr view returned no usable base branch.");
	}
	const fetchHead = async (ref: string): Promise<string> => {
		await gitOk(root, ["fetch", "--no-tags", "--quiet", "origin", ref], signal);
		return (await gitOk(root, ["rev-parse", "FETCH_HEAD"], signal)).trim();
	};
	const baseTip = await fetchHead(`refs/heads/${pr.baseRefName}`);
	const headOid = await fetchHead(`refs/pull/${spec.number}/head`);
	const baseRev = (await gitOk(root, ["merge-base", baseTip, headOid], signal)).trim();
	return {
		baseRev,
		headTree: (await gitOk(root, ["rev-parse", `${headOid}^{tree}`], signal)).trim(),
		description: `PR #${spec.number} "${typeof pr.title === "string" ? pr.title : ""}" (${headOid.slice(0, 10)} vs ${pr.baseRefName})`,
	};
}

function splitSections(diff: string): Array<{ file: string; text: string }> {
	const headers = [...diff.matchAll(/^diff --git a\/.* b\/(.*)$/gm)];
	return headers.map((header, index) => ({
		file: header[1] ?? "",
		text: diff.slice(header.index ?? 0, headers[index + 1]?.index ?? diff.length),
	}));
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

/** Extracts the tree into a throwaway directory sharing the repository's object store, like the built-in /review. */
async function materialize(
	repoRoot: string,
	commonDir: string,
	headTree: string,
	signal: AbortSignal,
): Promise<string> {
	const checkout = await mkdtemp(join(tmpdir(), "volt-swarm-review-"));
	try {
		await gitOk(checkout, ["init", "-q"], signal);
		const objects = join(commonDir, "objects");
		const inherited = join(objects, "info", "alternates");
		const alternates = [
			objects,
			...(existsSync(inherited)
				? readFileSync(inherited, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((path) => resolve(objects, path))
				: []),
		];
		await writeFile(join(checkout, ".git", "objects", "info", "alternates"), `${alternates.join("\n")}\n`);
		await gitOk(checkout, ["read-tree", headTree], signal);
		await gitOk(checkout, ["checkout-index", "-a", "-f", "-q"], signal);
		// Dependencies are ignored and absent from the snapshot; link them so reviewers (and --exec) can use them.
		const ignored = await gitOk(
			repoRoot,
			["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
			signal,
		);
		for (const entry of ignored.split("\n")) {
			if (!entry.endsWith("node_modules/")) continue;
			const relativePath = entry.slice(0, -1);
			const link = join(checkout, relativePath);
			if (existsSync(link)) continue;
			mkdirSync(dirname(link), { recursive: true });
			symlinkSync(join(repoRoot, relativePath), link, "dir");
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
	let revisions: ResolvedRevisions;
	try {
		revisions = await resolveRevisions(repoRoot, spec, signal);
	} catch (error) {
		if (error instanceof TargetError) return error.message;
		throw error;
	}
	const pathspecs = scope.map((pattern) => `:(glob)${pattern}`);
	const range = [revisions.baseRev, revisions.headTree, "--", ...pathspecs];
	const [diff, stat] = await Promise.all([
		gitOk(repoRoot, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", ...range], signal),
		gitOk(repoRoot, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--stat=160", ...range], signal),
	]);
	if (!diff.trim()) return `No ${revisions.description}${scope.length > 0 ? " match --scope" : ""} to review.`;
	const { shards, fileDiffs } = packShards(diff);
	const checkout = await materialize(repoRoot, commonDir, revisions.headTree, signal);
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
		commonDir,
		dispose: () => rm(checkout, { recursive: true, force: true }),
	};
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
