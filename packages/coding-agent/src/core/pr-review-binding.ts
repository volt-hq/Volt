import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ReviewPullRequestIdentity } from "./code-host/types.ts";
import type { PrReviewPlacement } from "./pr-review-placement.ts";
import { ReviewSourceUnavailableError, resolveCanonicalReviewSource } from "./review-anchors.ts";
import { listReviewRuns } from "./review-state.ts";
import { SessionManager } from "./session-manager.ts";

export const PR_CHECKOUT_CHANGED = "PR checkout changed; prepare a new review.";

/** Display run ids are lookup hints only. Only the exact host-owned anchor grants linkage. */
export async function readPrReviewBinding(
	manager: SessionManager | undefined,
	parentRunId?: string,
): Promise<PrReviewPlacement | undefined> {
	if (!manager) return undefined;
	const direct = manager.getPrReviewBinding();
	if (direct) {
		if (resolve(manager.getCwd()) !== resolve(direct.cwd)) throw new Error(PR_CHECKOUT_CHANGED);
		return direct;
	}
	const ref = manager.getSessionRef();
	if (!ref) return undefined;
	const cwd = manager.getCwd();
	const assertCurrent = (): void => {
		manager.assertConversationAuthorityAvailable();
		if (!isDeepStrictEqual(ref, manager.getSessionRef()) || cwd !== manager.getCwd()) {
			throw new ReviewSourceUnavailableError("The review conversation changed during lookup.");
		}
	};
	let cursor: string | undefined;
	do {
		const page = parentRunId
			? { runs: [{ runId: parentRunId }], nextCursor: undefined }
			: listReviewRuns(manager, { cursor, limit: 50 });
		for (const { runId } of page.runs) {
			const sourceRef = await resolveCanonicalReviewSource(manager, runId);
			assertCurrent();
			if (!sourceRef) continue;
			let source: SessionManager;
			try {
				source = await SessionManager.open(sourceRef);
			} catch (cause) {
				throw new ReviewSourceUnavailableError(undefined, { cause });
			}
			try {
				const binding = source.getPrReviewBinding();
				const current = await resolveCanonicalReviewSource(manager, runId);
				assertCurrent();
				if (!isDeepStrictEqual(current, sourceRef)) throw new ReviewSourceUnavailableError();
				if (binding) return binding;
			} finally {
				await source.closePersistence();
				assertCurrent();
			}
		}
		cursor = page.nextCursor;
	} while (cursor);
	return undefined;
}

/** Fixed argv-only local reads. No transport, shell, hooks, fsmonitor, or injected Git environment. */
async function readGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
	const filterOverrides: string[] = [];
	if (args[0] !== "config") {
		const keys = await readGit(cwd, ["config", "--list", "--name-only"], signal);
		for (const key of keys.split("\n")) {
			if (/^filter\.[^\s=\x00-\x1f]+\.(clean|smudge|process|required)$/.test(key)) {
				filterOverrides.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
			}
		}
	}
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: devNull,
		GIT_TERMINAL_PROMPT: "0",
		GIT_OPTIONAL_LOCKS: "0",
		GIT_NO_REPLACE_OBJECTS: "1",
		GIT_NO_LAZY_FETCH: "1",
		LC_ALL: "C",
	};
	return new Promise((resolveResult, reject) => {
		execFile(
			"git",
			["--no-pager", "-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false", ...filterOverrides, ...args],
			{
				cwd,
				env,
				signal,
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 1024 * 1024,
				windowsHide: true,
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolveResult(stdout);
			},
		);
	});
}

/** A prepared checkout is never switched/reset to follow a moved PR head. */
export async function assertPrReviewCheckout(
	binding: PrReviewPlacement,
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	try {
		// sourceRootRelativePath is a workspace display/placement prefix, not a
		// subdirectory inside either Git checkout. Both bound cwds are repo roots.
		const expectedRoot = await realpath(binding.cwd);
		const sourceRoot = await realpath(binding.sourceCwd);
		const common = await realpath(binding.commonDirectory);
		if ((await realpath(cwd)) !== (await realpath(binding.cwd))) throw new Error("cwd changed");
		const [root, commonDir, head, status, originalRoot, originalCommon] = await Promise.all([
			readGit(cwd, ["rev-parse", "--show-toplevel"], signal),
			readGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
			readGit(cwd, ["rev-parse", "--verify", "HEAD"], signal),
			readGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], signal),
			readGit(binding.sourceCwd, ["rev-parse", "--show-toplevel"], signal),
			readGit(binding.sourceCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], signal),
		]);
		if (
			(await realpath(root.trim())) !== expectedRoot ||
			(await realpath(commonDir.trim())) !== common ||
			(await realpath(originalRoot.trim())) !== sourceRoot ||
			(await realpath(originalCommon.trim())) !== common ||
			head.trim() !== binding.pullRequest.headRefOid ||
			status !== ""
		)
			throw new Error("checkout identity or status changed");
		for (const marker of [
			"MERGE_HEAD",
			"CHERRY_PICK_HEAD",
			"REVERT_HEAD",
			"BISECT_LOG",
			"rebase-merge",
			"rebase-apply",
			"sequencer",
		]) {
			const path = await readGit(cwd, ["rev-parse", "--git-path", marker], signal);
			if (existsSync(resolve(cwd, path.trim()))) throw new Error("Git operation in progress");
		}
	} catch (cause) {
		throw new Error(PR_CHECKOUT_CHANGED, { cause });
	}
}

/** The provider must still identify the original authorized repository and exact head. */
export function assertBoundPullRequest(binding: PrReviewPlacement, pullRequest: ReviewPullRequestIdentity): void {
	const expected = binding.pullRequest;
	if (
		pullRequest.providerId !== expected.provider ||
		pullRequest.number !== expected.number ||
		pullRequest.url.toLowerCase() !== expected.url.toLowerCase() ||
		pullRequest.headRefOid !== expected.headRefOid
	)
		throw new Error(PR_CHECKOUT_CHANGED);
}
