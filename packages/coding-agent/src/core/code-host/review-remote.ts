import { Buffer } from "node:buffer";
import { spawnProcess } from "../../utils/child-process.ts";
import { terminateProcessTree } from "../../utils/shell.ts";
import type { ReviewCodeHostContextCaptureOptions } from "./types.ts";

export const REVIEW_TARGET_CANCELLED = "Code-host context capture was cancelled.";

const REMOTE_NAME_PATTERN = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type ReviewTargetFailure = { ok: false; error: string; remoteError: string };

type ReviewRemoteOptions = Pick<ReviewCodeHostContextCaptureOptions, "cwd" | "signal">;

export function reviewTargetFailure(message: string): ReviewTargetFailure {
	return { ok: false, error: message, remoteError: message };
}

/** Local metadata only; never retain Git stderr, which can contain credential-bearing URLs. */
export async function readReviewGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	if (signal?.aborted) throw new Error(REVIEW_TARGET_CANCELLED);
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (
			/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CEILING_DIRECTORIES|CONFIG(?:_.*)?)$/.test(
				key,
			)
		)
			delete env[key];
	}
	env.GIT_TERMINAL_PROMPT = "0";
	env.GIT_OPTIONAL_LOCKS = "0";
	env.GIT_PAGER = "cat";
	const result = await new Promise<string | undefined>((resolve, reject) => {
		const child = spawnProcess("git", args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let failed = false;
		const terminate = (): void => {
			failed = true;
			if (child.pid) void terminateProcessTree(child.pid);
			else child.kill();
		};
		const timeout = setTimeout(terminate, 2_500);
		timeout.unref?.();
		const finish = (code: number | null): void => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", terminate);
			if (failed)
				reject(new Error("Could not inspect Git tracking configuration. Check Git on the host and retry."));
			else resolve(code === 0 ? Buffer.concat(chunks, bytes).toString("utf8").trim() : undefined);
		};
		child.stdout?.on("data", (chunk: Buffer) => {
			if (failed) return;
			bytes += chunk.length;
			if (bytes > 64 * 1024) terminate();
			else chunks.push(chunk);
		});
		child.once("error", () => {
			failed = true;
			finish(null);
		});
		child.once("close", finish);
		signal?.addEventListener("abort", terminate, { once: true });
		if (signal?.aborted) terminate();
	});
	if (signal?.aborted) throw new Error(REVIEW_TARGET_CANCELLED);
	return result;
}

/** Select the tracked remote branch for current-PR review. Throws when Git metadata cannot be read. */
export async function selectCurrentReviewRemote(
	options: ReviewRemoteOptions,
): Promise<{ ok: true; remote: string; headBranch: string } | ReviewTargetFailure> {
	const ref = await readReviewGit(["symbolic-ref", "--quiet", "HEAD"], options.cwd, options.signal);
	if (!ref?.startsWith("refs/heads/") || /[\0\r\n]/.test(ref)) {
		return reviewTargetFailure(
			"Current-PR review requires a checked-out branch. Check out the intended branch or specify a PR number.",
		);
	}
	const upstream = await readReviewGit(
		["for-each-ref", "--format=%(refname)%00%(upstream:remotename)%00%(upstream:remoteref)", ref],
		options.cwd,
		options.signal,
	);
	const [observedRef, remote, remoteRef, extra] = upstream?.split("\0") ?? [];
	if (
		observedRef !== ref ||
		extra !== undefined ||
		!remote ||
		remote === "." ||
		!REMOTE_NAME_PATTERN.test(remote) ||
		!remoteRef?.startsWith("refs/heads/") ||
		remoteRef.length <= "refs/heads/".length ||
		/[\0\r\n]/.test(remoteRef)
	) {
		return reviewTargetFailure(
			"Current-PR review requires a remote tracking branch. Configure the intended upstream on the host or specify a PR number.",
		);
	}
	return { ok: true, remote, headBranch: remoteRef.slice("refs/heads/".length) };
}

/** Select the base repository remote for a numbered PR. Throws when Git metadata cannot be read. */
export async function selectNumberedReviewRemote(
	options: ReviewRemoteOptions,
): Promise<{ ok: true; remote: string } | ReviewTargetFailure> {
	const ref = await readReviewGit(["symbolic-ref", "--quiet", "HEAD"], options.cwd, options.signal);
	let remote: string | undefined;
	if (ref !== undefined) {
		if (!ref.startsWith("refs/heads/") || /[\0\r\n]/.test(ref)) throw new Error("Invalid HEAD reference.");
		remote = await readReviewGit(
			["config", "--get", `branch.${ref.slice("refs/heads/".length)}.remote`],
			options.cwd,
			options.signal,
		);
	}
	if (!remote || remote === ".") {
		const names = (await readReviewGit(["remote"], options.cwd, options.signal))?.split(/\r?\n/) ?? [];
		remote = names.includes("origin") ? "origin" : names.length === 1 ? names[0] : undefined;
		if (!remote)
			return reviewTargetFailure(
				"Could not select a repository for the numbered PR. Configure a tracking remote, origin, or a single remote on the host.",
			);
	}
	return { ok: true, remote };
}

/** Every configured URL of a selected review remote; Git fetch uses the first. */
export async function readReviewRemoteUrls(
	remote: string,
	options: ReviewRemoteOptions,
): Promise<string[] | ReviewTargetFailure> {
	if (!REMOTE_NAME_PATTERN.test(remote)) {
		return reviewTargetFailure("The review remote is invalid. Check its configuration on the host.");
	}
	return (
		(await readReviewGit(["remote", "get-url", "--all", remote], options.cwd, options.signal))?.split(/\r?\n/) ?? []
	);
}
