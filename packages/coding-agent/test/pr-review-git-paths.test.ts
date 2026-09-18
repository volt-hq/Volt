import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runPrReviewGit } from "../src/daemon/pr-review-git.ts";
import { readPrReviewOperationPaths, readPrReviewRepositoryPaths } from "../src/utils/pr-review-git-paths.ts";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", `core.hooksPath=${devNull}`, ...args], { cwd, encoding: "utf8" });
}

const markers = [
	"MERGE_HEAD",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"BISECT_LOG",
	"rebase-merge",
	"rebase-apply",
	"sequencer",
];

describe("PR review Git path queries", () => {
	let root: string;
	let source: string;
	let worktree: string;
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "volt-pr-git-paths-"));
		source = join(root, "source repo");
		worktree = join(root, "linked worktree");
		mkdirSync(source);
		git(source, "init", "--initial-branch=main");
		git(source, "config", "user.name", "Test");
		git(source, "config", "user.email", "test@example.test");
		git(source, "config", "commit.gpgsign", "false");
		git(source, "commit", "--allow-empty", "-m", "initial");
		git(source, "worktree", "add", "--detach", worktree, "HEAD");
	});
	afterAll(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it.each([false, true])("resolves batched paths in a linked=%s checkout with spaces", async (linked) => {
		const cwd = linked ? worktree : source;
		const read = vi.fn(async (args: string[]) => {
			const result = await runPrReviewGit(args, cwd);
			expect(result.ok).toBe(true);
			return result.stdout;
		});
		const paths = await readPrReviewRepositoryPaths(read);
		expect(realpathSync(paths.root)).toBe(realpathSync(cwd));
		expect(realpathSync(paths.commonDirectory)).toBe(realpathSync(join(source, ".git")));
		expect(read).toHaveBeenCalledTimes(1);
		read.mockClear();
		expect(await readPrReviewOperationPaths(read)).toEqual(
			markers.map((marker) => git(cwd, "rev-parse", "--path-format=absolute", "--git-path", marker).trimEnd()),
		);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("preserves leading and trailing whitespace in path components", async () => {
		const repository = resolve(tmpdir(), " repo ");
		const commonDirectory = resolve(tmpdir(), " common dir ");
		expect(await readPrReviewRepositoryPaths(async () => `${repository}\n${commonDirectory}\n`)).toEqual({
			root: repository,
			commonDirectory,
		});
		const paths = markers.map((marker) => join(commonDirectory, marker));
		expect(await readPrReviewOperationPaths(async () => `${paths.join("\n")}\n`)).toEqual(paths);
	});

	for (const query of ["repository", "operations"] as const) {
		const readPaths = query === "repository" ? readPrReviewRepositoryPaths : readPrReviewOperationPaths;
		const paths = Array.from({ length: query === "repository" ? 2 : 7 }, (_, i) => resolve(tmpdir(), `path-${i}`));
		it.each([
			["empty", ""],
			["truncated", `${paths.slice(0, -1).join("\n")}\n`],
			["extra path", `${[...paths, resolve(tmpdir(), "extra")].join("\n")}\n`],
			["missing terminator", paths.join("\n")],
			["empty record", `${["", ...paths.slice(1)].join("\n")}\n`],
			["relative path", `${["relative", ...paths.slice(1)].join("\n")}\n`],
			["NUL", `${[`${paths[0]}\0suffix`, ...paths.slice(1)].join("\n")}\n`],
			["CR", `${[`${paths[0]}\rsuffix`, ...paths.slice(1)].join("\n")}\n`],
			["embedded newline", `${[`${paths[0]}\nsuffix`, ...paths.slice(1)].join("\n")}\n`],
		])(`rejects malformed batched ${query} output: %s`, async (_name, output) => {
			await expect(readPaths(async () => output)).rejects.toThrow("Invalid PR checkout Git paths.");
		});

		it.each([new Error("Git failed"), new DOMException("Cancelled", "AbortError")])(
			`propagates batched ${query} read failures without returning partial paths: %s`,
			async (error) => {
				await expect(
					readPaths(async () => {
						throw error;
					}),
				).rejects.toBe(error);
			},
		);
	}

	it.skipIf(process.platform === "win32")(
		"rejects ambiguous batched paths from a newline-named checkout",
		async () => {
			const path = join(root, "newline\nworktree");
			git(source, "worktree", "add", "--detach", path, "HEAD");
			await expect(readPrReviewRepositoryPaths(async (args) => git(path, ...args))).rejects.toThrow(
				"Invalid PR checkout Git paths.",
			);
		},
	);
});
