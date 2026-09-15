import { Buffer } from "node:buffer";
import { devNull } from "node:os";
import { spawnProcess } from "../utils/child-process.ts";
import { terminateProcessTree } from "../utils/shell.ts";
import type { WorktreeGitRunner } from "./worktree-manager.ts";

/** Bounded, noninteractive Git for checkout preparation. No shell or repository hooks. */
export const runPrReviewGit: WorktreeGitRunner = async (args, cwd, options = {}) => {
	options.signal?.throwIfAborted();
	const filterOverrides: string[] = [];
	if (args[0] !== "config") {
		const filters = await runPrReviewGit(
			["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|smudge|process|required)$"],
			cwd,
			options,
		);
		if (!filters.ok && filters.code !== 1) return filters;
		for (const key of filters.stdout.split("\n").filter(Boolean)) {
			if (!/^filter\.[^\s=\x00-\x1f]+\.(clean|smudge|process|required)$/.test(key))
				return { ok: false, code: null, stdout: "", stderr: "Invalid checkout filter configuration." };
			filterOverrides.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
		}
	}
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (
			/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|CONFIG(?:_.*)?|TRACE.*)$/.test(
				key,
			)
		)
			delete env[key];
	}
	Object.assign(env, {
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_PAGER: "cat",
		GIT_LFS_SKIP_SMUDGE: "1",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
	});
	return new Promise((resolve) => {
		const child = spawnProcess(
			"git",
			["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", ...filterOverrides, ...args],
			{
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const chunks: Buffer[] = [];
		let bytes = 0;
		let stderrBytes = 0;
		let failed = false;
		let settled = false;
		const terminate = () => {
			failed = true;
			if (child.pid) void terminateProcessTree(child.pid);
			else child.kill();
		};
		const timer = setTimeout(terminate, 30_000);
		timer.unref?.();
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", terminate);
			resolve({
				ok: !failed && code === 0,
				code,
				stdout: failed ? "" : Buffer.concat(chunks).toString("utf8"),
				stderr: code === 0 && !failed ? "" : "PR checkout Git operation failed.",
			});
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 1024 * 1024) terminate();
			else if (!failed) chunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > 64 * 1024) terminate();
		});
		child.once("error", () => {
			failed = true;
			finish(null);
		});
		child.once("close", finish);
		options.signal?.addEventListener("abort", terminate, { once: true });
		if (options.signal?.aborted) terminate();
	});
};
