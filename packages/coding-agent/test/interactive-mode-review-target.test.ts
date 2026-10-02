import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewTarget } from "../src/core/review.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function installGh(directory: string, source: string): void {
	const fixture = join(directory, "fake-gh.mjs");
	writeFileSync(fixture, source);
	if (process.platform === "win32") {
		writeFileSync(
			join(directory, "gh.cmd"),
			`@echo off\r\n"${process.execPath}" "${fixture}" %*\r\nexit /b %errorlevel%\r\n`,
		);
		return;
	}
	const executable = join(directory, "gh");
	writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
	chmodSync(executable, 0o755);
}

describe("InteractiveMode review target selection", () => {
	const directories: string[] = [];
	const initialPath = process.env.PATH;

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
		if (initialPath === undefined) delete process.env.PATH;
		else process.env.PATH = initialPath;
	});

	function createContext(selection: (options: string[]) => string | undefined) {
		const directory = join(tmpdir(), `volt-review-target-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(directory, { recursive: true });
		directories.push(directory);
		for (const args of [
			["init", "--initial-branch=topic"],
			[
				"-c",
				"user.name=Review Test",
				"-c",
				"user.email=review@example.test",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--allow-empty",
				"-m",
				"fixture",
			],
			["remote", "add", "origin", "https://github.com/contributor/project.git"],
			["update-ref", "refs/remotes/origin/topic", "HEAD"],
			["branch", "--set-upstream-to=origin/topic"],
		])
			execFileSync("git", args, { cwd: directory, stdio: "pipe" });
		return {
			directory,
			context: {
				sessionManager: { getCwd: () => directory },
				showExtensionSelector: vi.fn(async (_title: string, options: string[]) => selection(options)),
				promptForReviewBaseBranch: vi.fn(async () => "main"),
				showExtensionInput: vi.fn(async () => ""),
			},
		};
	}

	const promptForReviewTarget = Reflect.get(InteractiveMode.prototype, "promptForReviewTarget") as (
		this: ReturnType<typeof createContext>["context"],
	) => Promise<ReviewTarget | undefined>;

	it("puts an unambiguous current PR first and retains its repository-qualified identity", async () => {
		const { directory, context } = createContext((options) => options[0]);
		installGh(
			directory,
			`process.stdout.write(JSON.stringify([{
			id: "PR_42", number: 42, title: "Fix   selector behavior",
			url: "https://github.com/contributor/project/pull/42", state: "OPEN", headRefName: "topic",
			headRepository: { name: "project" }, headRepositoryOwner: { login: "contributor" }
		}]));\n`,
		);
		process.env.PATH = `${directory}${delimiter}${initialPath ?? ""}`;

		await expect(promptForReviewTarget.call(context)).resolves.toEqual({
			kind: "pr",
			number: "42",
			expectedUrl: "https://github.com/contributor/project/pull/42",
		});
		expect(context.showExtensionSelector).toHaveBeenCalledWith("Review what?", [
			"Current PR #42 — Fix selector behavior",
			"Against base branch",
			"Uncommitted changes",
			"Pull request",
			"Specific commit",
		]);
	});

	it("silently preserves the existing selector when the PR probe fails", async () => {
		const { directory, context } = createContext((options) =>
			options.find((option) => option === "Uncommitted changes"),
		);
		installGh(directory, `process.stderr.write("authentication or network failure\\n"); process.exitCode = 1;\n`);
		process.env.PATH = `${directory}${delimiter}${initialPath ?? ""}`;

		await expect(promptForReviewTarget.call(context)).resolves.toEqual({ kind: "uncommitted" });
		expect(context.showExtensionSelector).toHaveBeenCalledWith("Review what?", [
			"Against base branch",
			"Uncommitted changes",
			"Pull request",
			"Specific commit",
		]);
	});
});
