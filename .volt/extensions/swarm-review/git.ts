import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir, loadProjectContextFiles } from "@hansjm10/volt-coding-agent";
import { SwarmCancelled } from "./util.ts";

const MAX_COMMAND_OUTPUT = 256 * 1024 * 1024;
const CONTEXT_FILE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

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

export function git(cwd: string, args: string[], signal: AbortSignal, env?: NodeJS.ProcessEnv): Promise<CommandResult> {
	return runCommand("git", ["-c", "core.quotepath=off", ...args], { cwd, signal, ...(env ? { env } : {}) });
}

/** The repository the review runs in: its top-level directory and the Git common directory that identifies it across worktrees. */
export async function repositoryOf(
	cwd: string,
	signal: AbortSignal,
): Promise<{ repoRoot: string; commonDir: string } | undefined> {
	const top = await git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"], signal);
	if (top.code !== 0) return undefined;
	const [rootLine = "", commonLine = ""] = top.stdout.split("\n");
	return { repoRoot: rootLine.trim(), commonDir: realpathSync(resolve(cwd, commonLine.trim())) };
}

function insideRoot(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Global and above-repository context files come from disk. In-repository AGENTS/CLAUDE/REVIEW files come from the
 * base of the change, as in the built-in /review, so the change under review cannot rewrite its own instructions.
 */
export async function loadContextFiles(
	repoRoot: string,
	readBase: (path: string, signal: AbortSignal) => Promise<string | undefined>,
	cwd: string,
	signal: AbortSignal,
): Promise<Array<{ path: string; content: string }>> {
	const resolvedCwd = realpathSync(cwd);
	const files = loadProjectContextFiles({ cwd: resolvedCwd, agentDir: getAgentDir() }).filter(
		(file) => !insideRoot(repoRoot, file.path),
	);
	const userReviewPolicy = join(getAgentDir(), "REVIEW.md");
	if (existsSync(userReviewPolicy)) {
		files.push({ path: userReviewPolicy, content: readFileSync(userReviewPolicy, "utf8") });
	}
	const relativeCwd = relative(repoRoot, resolvedCwd);
	const segments = insideRoot(repoRoot, resolvedCwd) ? relativeCwd.split(sep).filter(Boolean) : [];
	const directories = ["", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
	for (const directory of directories) {
		for (const name of CONTEXT_FILE_NAMES) {
			const path = directory ? `${directory}/${name}` : name;
			const content = await readBase(path, signal);
			if (content !== undefined) {
				files.push({ path: `base:${path}`, content });
				break;
			}
		}
		const reviewPath = directory ? `${directory}/REVIEW.md` : "REVIEW.md";
		const review = await readBase(reviewPath, signal);
		if (review !== undefined) files.push({ path: `base:${reviewPath}`, content: review });
	}
	return files;
}
