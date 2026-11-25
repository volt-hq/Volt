import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GitHubCliResult, runGitHubCli } from "../src/core/code-host/github-cli.ts";
import { githubCliCodeHostProvider } from "../src/core/code-host/github-cli-provider.ts";
import { listOpenPullRequestsWithGitHubCli } from "../src/core/code-host/github-cli-review-target.ts";

vi.mock("../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

const FIELDS = "number,title,url,author,headRefName,isDraft,updatedAt";

const roots: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	vi.mocked(runGitHubCli).mockReset();
});

function git(cwd: string, ...args: string[]): void {
	execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}

/** A repository on an unborn `main` with the given remotes, and no global Git configuration. */
function repository(remotes: Record<string, string>, trackingRemote?: string): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-open-prs-")));
	roots.push(root);
	const home = join(root, "home");
	mkdirSync(home);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("XDG_CONFIG_HOME", join(home, ".config"));
	const cwd = join(root, "repo");
	mkdirSync(cwd);
	git(cwd, "init", "-q", "-b", "main");
	for (const [name, url] of Object.entries(remotes)) git(cwd, "remote", "add", name, url);
	if (trackingRemote) git(cwd, "config", "branch.main.remote", trackingRemote);
	return cwd;
}

function result(overrides: Partial<Omit<GitHubCliResult, "stdout">> & { stdout?: string } = {}): GitHubCliResult {
	return {
		ok: overrides.ok ?? true,
		stdout: Buffer.from(overrides.stdout ?? ""),
		stderr: overrides.stderr ?? "",
		outputLimited: overrides.outputLimited ?? false,
		timedOut: overrides.timedOut ?? false,
	};
}

function item(number: number, overrides: Record<string, unknown> = {}, base = "https://github.com/owner/repo") {
	return {
		number,
		title: `PR ${number}`,
		url: `${base}/pull/${number}`,
		author: { login: "octocat", is_bot: false, name: "The Octocat" },
		headRefName: `topic-${number}`,
		isDraft: false,
		updatedAt: "2026-11-20T10:00:00Z",
		...overrides,
	};
}

function respond(items: unknown): void {
	vi.mocked(runGitHubCli).mockResolvedValueOnce(result({ stdout: JSON.stringify(items) }));
}

describe("listing open GitHub pull requests for review selection", () => {
	it("lists origin's open pull requests with only display fields, newest first", async () => {
		const cwd = repository({
			upstream: "https://github.com/other/fork.git",
			origin: "https://github.com/Owner/Repo.git",
		});
		respond([
			item(9, { isDraft: true }),
			item(7, { url: "https://github.com/Owner/Repo/pull/7", author: { login: "app/dependabot", is_bot: true } }),
		]);

		const listed = await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50 });

		expect(listed).toEqual({
			ok: true,
			repository: "owner/repo",
			pullRequests: [
				{
					number: 9,
					title: "PR 9",
					url: "https://github.com/owner/repo/pull/9",
					headRefName: "topic-9",
					isDraft: true,
					author: "octocat",
					updatedAt: Date.parse("2026-11-20T10:00:00Z"),
				},
				{
					number: 7,
					title: "PR 7",
					url: "https://github.com/Owner/Repo/pull/7",
					headRefName: "topic-7",
					isDraft: false,
					author: "app/dependabot",
					updatedAt: Date.parse("2026-11-20T10:00:00Z"),
				},
			],
			truncated: false,
		});
		expect(runGitHubCli).toHaveBeenCalledTimes(1);
		const [args, options] = vi.mocked(runGitHubCli).mock.calls[0]!;
		expect(args).toEqual([
			"pr",
			"list",
			"--repo",
			"github.com/owner/repo",
			"--state",
			"open",
			"--limit",
			"51",
			"--json",
			FIELDS,
		]);
		expect(options.cwd).toBe(cwd);
	});

	it("lists in the branch's tracking remote, as a numbered review resolves, including on GitHub Enterprise", async () => {
		const cwd = repository(
			{ origin: "https://github.com/owner/repo.git", enterprise: "git@ghe.example.com:Team/App.git" },
			"enterprise",
		);
		respond([item(3, {}, "https://ghe.example.com/team/app")]);

		const listed = await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50 });

		expect(listed).toMatchObject({ ok: true, repository: "team/app", pullRequests: [{ number: 3 }] });
		expect(vi.mocked(runGitHubCli).mock.calls[0]![0]).toContain("ghe.example.com/team/app");
	});

	it("is the GitHub provider's listing", () => {
		expect(githubCliCodeHostProvider.listOpenPullRequests).toBe(listOpenPullRequestsWithGitHubCli);
	});

	it("reports more open pull requests than the limit as truncated", async () => {
		const cwd = repository({ origin: "https://github.com/owner/repo.git" });
		respond(Array.from({ length: 51 }, (_, index) => item(100 - index)));
		const truncated = await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50 });
		expect(truncated).toMatchObject({ ok: true, truncated: true });
		expect(truncated.ok && truncated.pullRequests.map((pullRequest) => pullRequest.number)).toEqual(
			Array.from({ length: 50 }, (_, index) => 100 - index),
		);

		respond(Array.from({ length: 50 }, (_, index) => item(100 - index)));
		const complete = await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50 });
		expect(complete).toMatchObject({ ok: true, truncated: false });
		expect(complete.ok && complete.pullRequests).toHaveLength(50);
	});

	it("leaves out pull requests a review could not check out or show, and optional fields it cannot read", async () => {
		const cwd = repository({ origin: "https://github.com/owner/repo.git" });
		respond([
			item(20, { title: "bell\u0007title" }),
			item(19, { title: "x".repeat(513) }),
			item(18, { title: "" }),
			item(17, { headRefName: "bad..ref" }),
			item(16, { headRefName: "-option" }),
			item(15, { headRefName: "topic.lock" }),
			item(14, { headRefName: "with space" }),
			item(13, { author: null, updatedAt: "not a date" }),
			item(12, { author: { login: "line\nbreak" }, updatedAt: null }),
			item(11, { title: "x".repeat(512) }),
		]);

		const listed = await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50 });

		expect(listed).toEqual({
			ok: true,
			repository: "owner/repo",
			pullRequests: [
				{ number: 13, title: "PR 13", url: item(13).url, headRefName: "topic-13", isDraft: false },
				{ number: 12, title: "PR 12", url: item(12).url, headRefName: "topic-12", isDraft: false },
				{
					number: 11,
					title: "x".repeat(512),
					url: item(11).url,
					headRefName: "topic-11",
					isDraft: false,
					author: "octocat",
					updatedAt: Date.parse("2026-11-20T10:00:00Z"),
				},
			],
			truncated: false,
		});
	});

	it.each([
		["another repository's pull request", [item(1, { url: "https://github.com/other/repo/pull/1" })]],
		["a URL for another number", [item(1, { url: "https://github.com/owner/repo/pull/2" })]],
		["a non-pull-request URL", [item(1, { url: "https://github.com/owner/repo/issues/1" })]],
		["an insecure URL", [item(1, { url: "http://github.com/owner/repo/pull/1" })]],
		["a missing draft flag", [item(1, { isDraft: undefined })]],
		["a non-string title", [item(1, { title: 5 })]],
		["a non-string head branch", [item(1, { headRefName: null })]],
		["a number beyond the supported range", [item(2147483648)]],
		["a repeated number", [item(1), item(1)]],
		["more pull requests than requested", Array.from({ length: 52 }, (_, index) => item(index + 1))],
		["an object instead of a list", { pullRequests: [] }],
		["a non-object entry", [null]],
	])("fails the whole list for %s", async (_name, response) => {
		const cwd = repository({ origin: "https://github.com/owner/repo.git" });
		respond(response);
		expect(await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50 })).toEqual({
			ok: false,
			reason: "invalid_response",
		});
	});

	it("fails the whole list for malformed JSON", async () => {
		const cwd = repository({ origin: "https://github.com/owner/repo.git" });
		vi.mocked(runGitHubCli).mockResolvedValueOnce(result({ stdout: "[{not json" }));
		expect(await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50 })).toEqual({
			ok: false,
			reason: "invalid_response",
		});
	});

	it.each([
		[{ ok: false, stderr: "To get started with GitHub CLI, please run:  gh auth login" }, "not_authenticated"],
		[{ ok: false, stderr: "GraphQL: API rate limit exceeded for user" }, "rate_limited"],
		[{ ok: false, stderr: "dial tcp 140.82.112.6:443: connect: connection refused" }, "network"],
		[{ ok: false, timedOut: true, stderr: "GitHub CLI command timed out." }, "timeout"],
		[{ ok: false, outputLimited: true }, "output_limited"],
		[{ ok: false, stderr: "GraphQL: Could not resolve to a Repository" }, "provider_error"],
	] as const)("reports gh failure %j as %s, never its text", async (failure, reason) => {
		const cwd = repository({ origin: "https://github.com/owner/repo.git" });
		vi.mocked(runGitHubCli).mockResolvedValueOnce(result(failure));
		expect(await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50 })).toEqual({ ok: false, reason });
	});

	it("reports a thrown gh failure as a provider error", async () => {
		const cwd = repository({ origin: "https://github.com/owner/repo.git" });
		vi.mocked(runGitHubCli).mockRejectedValueOnce(new Error("spawn failure"));
		expect(await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50 })).toEqual({
			ok: false,
			reason: "provider_error",
		});
	});

	it.each([
		["no remote", {}],
		[
			"several remotes without origin or tracking",
			{ a: "https://github.com/a/r.git", b: "https://github.com/b/r.git" },
		],
		["a local path remote", { origin: "/srv/git/repo.git" }],
		["a credential-bearing remote", { origin: "https://user:token@github.com/owner/repo.git" }],
	])("does not list for %s", async (_name, remotes) => {
		const cwd = repository(remotes);
		expect(await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50 })).toEqual({
			ok: false,
			reason: "unsupported_repository",
		});
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it("does not run gh once cancelled or for an unsupported limit", async () => {
		const cwd = repository({ origin: "https://github.com/owner/repo.git" });
		const controller = new AbortController();
		controller.abort();
		expect(await listOpenPullRequestsWithGitHubCli({ cwd, limit: 50, signal: controller.signal })).toEqual({
			ok: false,
			reason: "cancelled",
		});
		for (const limit of [0, 101, 1.5]) {
			expect(await listOpenPullRequestsWithGitHubCli({ cwd, limit })).toEqual({
				ok: false,
				reason: "provider_error",
			});
		}
		expect(runGitHubCli).not.toHaveBeenCalled();
	});
});
