import { Buffer } from "node:buffer";
import { spawnProcess } from "../utils/child-process.ts";
import {
	getPrReviewGitArgs,
	getPrReviewGitEnvironment,
	PR_REVIEW_GIT_CONFIG_ARGS,
} from "../utils/pr-review-git-policy.ts";
import { terminateProcessTree } from "../utils/shell.ts";
import type { WorktreeGitRunner } from "./worktree-manager.ts";

/** Bounded, noninteractive Git for checkout preparation. No shell or repository hooks. */
export const runPrReviewGit: WorktreeGitRunner = async (args, cwd, options = {}) => {
	options.signal?.throwIfAborted();
	let configKeys = "";
	if (args[0] !== "config") {
		const config = await runPrReviewGit(PR_REVIEW_GIT_CONFIG_ARGS, cwd, options);
		if (!config.ok) return config;
		configKeys = config.stdout;
	}
	let argv: string[];
	try {
		argv = getPrReviewGitArgs(args, configKeys);
	} catch {
		return { ok: false, code: null, stdout: "", stderr: "Invalid checkout filter configuration." };
	}
	const env = getPrReviewGitEnvironment("transport");
	return new Promise((resolve) => {
		const child = spawnProcess("git", argv, {
			cwd,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
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
