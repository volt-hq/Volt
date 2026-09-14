import { Buffer } from "node:buffer";
import { spawnProcess } from "../../utils/child-process.ts";
import { terminateProcessTree } from "../../utils/shell.ts";
import { runGitHubCli } from "./github-cli.ts";
import { canonicalizeGitHubRemoteUrl } from "./github-cli-discovery.ts";
import type { ReviewCodeHostContextCaptureOptions } from "./types.ts";

interface GitHubPullRequestLocator {
	url: string;
	hostname: string;
	repository: string;
	number: number;
}

export function parseGitHubPullRequestUrl(value: string): GitHubPullRequestLocator | undefined {
	if (value.length > 2_000 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return undefined;
	try {
		const url = new URL(value);
		const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)$/.exec(url.pathname);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			!match ||
			!Number.isSafeInteger(Number(match[3]))
		)
			return undefined;
		return {
			url: url.href,
			hostname: url.host,
			repository: `${url.host}/${match[1]}/${match[2]}`.toLowerCase(),
			number: Number(match[3]),
		};
	} catch {
		return undefined;
	}
}

/** Local metadata only; never retain Git stderr, which can contain credential-bearing URLs. */
async function readGit(args: string[], cwd: string, signal?: AbortSignal): Promise<string | undefined> {
	if (signal?.aborted) throw new Error("GitHub context capture was cancelled.");
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
	if (signal?.aborted) throw new Error("GitHub context capture was cancelled.");
	return result;
}

type CurrentPullRequestTarget =
	| { ok: true; url: string; id: string; headBranch: string }
	| { ok: false; error: string; remoteError: string };

/** Resolve only in the tracked repository; never inherit gh's fork/default-repository selection. */
export async function resolveCurrentReviewPullRequest(
	options: ReviewCodeHostContextCaptureOptions,
): Promise<CurrentPullRequestTarget> {
	const failure = (message: string): CurrentPullRequestTarget => ({ ok: false, error: message, remoteError: message });
	try {
		const ref = await readGit(["symbolic-ref", "--quiet", "HEAD"], options.cwd, options.signal);
		if (!ref?.startsWith("refs/heads/") || /[\0\r\n]/.test(ref)) {
			return failure(
				"Current-PR review requires a checked-out branch. Check out the intended branch or specify a PR number.",
			);
		}
		const upstream = await readGit(
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
			!/^(?!-)[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remote) ||
			!remoteRef?.startsWith("refs/heads/") ||
			remoteRef.length <= "refs/heads/".length ||
			/[\0\r\n]/.test(remoteRef)
		) {
			return failure(
				"Current-PR review requires a remote tracking branch. Configure the intended upstream on the host or specify a PR number.",
			);
		}
		const urls = await readGit(["remote", "get-url", "--all", remote], options.cwd, options.signal);
		const repositories = new Set<string>();
		for (const value of urls?.split(/\r?\n/) ?? []) {
			const repository = canonicalizeGitHubRemoteUrl(value);
			const locator =
				repository &&
				parseGitHubPullRequestUrl(`https://${repository.host}/${repository.owner}/${repository.name}/pull/1`);
			if (!locator)
				return failure(
					"The tracking remote is not a supported credential-free GitHub URL. Check its configuration on the host.",
				);
			repositories.add(locator.repository);
		}
		if (repositories.size !== 1) {
			return failure(
				"The tracking remote does not identify one GitHub repository. Configure one unambiguous repository on the host.",
			);
		}
		const repository = repositories.values().next().value!;
		const headBranch = remoteRef.slice("refs/heads/".length);
		const result = await runGitHubCli(
			[
				"pr",
				"list",
				"--repo",
				repository,
				"--head",
				headBranch,
				"--state",
				"all",
				"--limit",
				"100",
				"--json",
				"id,number,url,state,headRefName,headRepository,headRepositoryOwner",
			],
			{ cwd: options.cwd, signal: options.signal, stdoutMaxBytes: 256 * 1024 },
		);
		if (!result.ok) {
			return failure(
				"Could not look up the tracked branch's pull request. Check GitHub CLI installation, authentication, repository access, and connectivity on the host, then retry.",
			);
		}
		const values: unknown = JSON.parse(result.stdout.toString("utf8"));
		if (!Array.isArray(values) || values.length >= 100) {
			return failure(
				"Could not establish a unique pull request for the tracked branch. Specify a PR number or check the repository on the host.",
			);
		}
		const active = new Map<string, { url: string; id: string }>();
		const historical = new Map<string, { url: string; id: string }>();
		for (const item of values) {
			if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error();
			const value = item as Record<string, unknown>;
			const locator = typeof value.url === "string" ? parseGitHubPullRequestUrl(value.url) : undefined;
			if (
				!locator ||
				locator.repository !== repository ||
				locator.number !== value.number ||
				locator.number > options.maxPullRequestNumber ||
				typeof value.id !== "string" ||
				!value.id ||
				value.id.length > 500
			)
				throw new Error();
			const head = value.headRepository as Record<string, unknown> | null;
			const owner = value.headRepositoryOwner as Record<string, unknown> | null;
			if (
				!head ||
				!owner ||
				typeof head.name !== "string" ||
				typeof owner.login !== "string" ||
				typeof value.headRefName !== "string"
			)
				throw new Error();
			if (
				`${locator.hostname}/${owner.login}/${head.name}`.toLowerCase() !== repository ||
				value.headRefName !== headBranch
			)
				continue;
			if (value.state !== "OPEN" && value.state !== "CLOSED" && value.state !== "MERGED") throw new Error();
			(value.state === "OPEN" ? active : historical).set(locator.url, { url: locator.url, id: value.id });
		}
		const matches = active.size > 0 ? active : historical;
		if (matches.size === 0)
			return failure(
				"No pull request matches the tracked branch in its repository. Open a PR there, correct the tracking branch, or specify a PR number.",
			);
		if (matches.size > 1)
			return failure("Multiple pull requests match the tracked branch. Specify the intended PR number.");
		return { ok: true, ...matches.values().next().value!, headBranch };
	} catch {
		if (options.signal?.aborted) throw new Error("GitHub context capture was cancelled.");
		return failure(
			"Could not resolve the current pull request safely. Check Git tracking configuration and GitHub CLI on the host, then retry.",
		);
	}
}
