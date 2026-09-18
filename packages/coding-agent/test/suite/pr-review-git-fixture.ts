import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

/** Build once per test file; only independent copies are exposed to individual tests. */
export function createPrReviewGitSeed(baseContent: string, headCommitMessage: string) {
	const root = mkdtempSync(join(tmpdir(), "volt-pr-review-git-seed-"));
	const source = join(root, "workspace");
	const remote = join(root, "remote.git");
	try {
		mkdirSync(source);
		git(source, "init", "--initial-branch=main");
		git(source, "config", "user.name", "Test");
		git(source, "config", "user.email", "test@example.test");
		git(source, "config", "commit.gpgsign", "false");
		// Keep checkout bytes stable even when the host enables core.autocrlf.
		writeFileSync(join(source, ".gitattributes"), "value.txt text eol=lf\n");
		writeFileSync(join(source, "value.txt"), baseContent);
		git(source, "add", ".gitattributes", "value.txt");
		git(source, "commit", "-m", "base");
		const base = git(source, "rev-parse", "HEAD");
		git(source, "checkout", "-b", "topic");
		writeFileSync(join(source, "value.txt"), "PR head\n");
		git(source, "commit", "-am", headCommitMessage);
		const head = git(source, "rev-parse", "HEAD");
		git(root, "init", "--bare", remote);
		git(source, "push", remote, "HEAD:refs/pull/414/head");
		git(source, "checkout", "main");

		return {
			copyTo(targetSource: string, targetRemote: string) {
				// No shared worktree, hardlinks or object alternates: config, index, refs,
				// objects and the bare remote must remain mutable per fixture. The seed
				// has no linked worktrees/submodules whose metadata would need relocation.
				cpSync(source, targetSource, { recursive: true, force: false, errorOnExist: true });
				cpSync(remote, targetRemote, { recursive: true, force: false, errorOnExist: true });
				return { base, head };
			},
			dispose() {
				rmSync(root, { recursive: true, force: true });
			},
		};
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}
