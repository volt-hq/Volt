import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GitHubCliResult, runGitHubCli } from "../../../src/core/code-host/github-cli.ts";
import { githubCliCodeHostProvider } from "../../../src/core/code-host/index.ts";

vi.mock("../../../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

const PR_URL = "https://github.com/volt-hq/project/pull/414";
const REMOTE_URL = "git@github.com:volt-hq/project.git";
const HEAD_OID = "b".repeat(40);
let cwd: string;
let view: Record<string, unknown>;
let listed: Record<string, unknown>[];

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function response(value: unknown): GitHubCliResult {
	return { ok: true, stdout: Buffer.from(JSON.stringify(value)), stderr: "", outputLimited: false, timedOut: false };
}

function resolve(number: string | undefined = "414", expectedUrl?: string, signal?: AbortSignal) {
	return githubCliCodeHostProvider.resolvePullRequestCheckout({
		cwd,
		number,
		expectedUrl,
		signal,
		maxPullRequestNumber: 2_147_483_647,
	});
}

function trackCurrentBranch() {
	git("update-ref", "refs/remotes/origin/feature", git("rev-parse", "HEAD"));
	git("branch", "--set-upstream-to", "origin/feature");
}

beforeEach(() => {
	// Pure checkout resolution uses only disposable Git metadata and mocked gh, not inference.
	cwd = mkdtempSync(join(tmpdir(), "volt-414-checkout-"));
	git("init", "--initial-branch=feature");
	git(
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
	);
	git("remote", "add", "origin", REMOTE_URL);
	view = {
		id: "PR_414",
		number: 414,
		title: "Review checkout",
		url: PR_URL,
		headRefName: "feature",
		headRefOid: HEAD_OID,
		headRepository: { name: "project", nameWithOwner: "volt-hq/project" },
		headRepositoryOwner: { login: "volt-hq" },
	};
	listed = [{ ...view, state: "OPEN" }];
	vi.mocked(runGitHubCli).mockReset();
	vi.mocked(runGitHubCli).mockImplementation(async (args) => {
		if (args[0] === "pr" && args[1] === "list") return response(listed);
		if (args[0] === "pr" && args[1] === "view") return response(view);
		throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
	});
});

afterEach(() => {
	rmSync(cwd, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("#414 lightweight PR checkout target", () => {
	it("returns a pinned base transport without fetching or capturing review context", async () => {
		const refs = git("show-ref");
		const head = git("rev-parse", "HEAD");
		const result = await resolve("414", PR_URL);
		expect(result).toEqual({
			ok: true,
			target: {
				pullRequest: {
					provider: "github",
					url: PR_URL,
					number: 414,
					title: "Review checkout",
					repository: "volt-hq/project",
					headRefName: "feature",
					headRefOid: HEAD_OID,
				},
				repository: {
					providerId: "github",
					host: "github.com",
					owner: "volt-hq",
					name: "project",
					canonicalId: "github:github.com/volt-hq/project",
				},
				headRepository: {
					providerId: "github",
					host: "github.com",
					owner: "volt-hq",
					name: "project",
					canonicalId: "github:github.com/volt-hq/project",
				},
				remote: "origin",
				remoteUrl: REMOTE_URL,
				headRef: "refs/pull/414/head",
			},
		});
		expect(runGitHubCli).toHaveBeenCalledExactlyOnceWith(
			[
				"pr",
				"view",
				PR_URL,
				"--json",
				"id,number,title,url,headRefName,headRefOid,headRepository,headRepositoryOwner",
			],
			expect.objectContaining({ cwd, stdoutMaxBytes: 64 * 1024, stderrMaxBytes: 16 * 1024, timeoutMs: 15_000 }),
		);
		expect(git("show-ref")).toBe(refs);
		expect(git("rev-parse", "HEAD")).toBe(head);
		expect(existsSync(join(cwd, ".git", "FETCH_HEAD"))).toBe(false);
	});

	it("uses the base repository PR ref for a fork rather than a fork transport", async () => {
		view.headRepository = { name: "forked-project", nameWithOwner: "contributor/forked-project" };
		view.headRepositoryOwner = { login: "contributor" };
		await expect(resolve()).resolves.toMatchObject({
			ok: true,
			target: {
				headRepository: { owner: "contributor", name: "forked-project" },
				remoteUrl: REMOTE_URL,
				headRef: "refs/pull/414/head",
			},
		});
	});

	it("retains GHES identity and SHA-256 heads", async () => {
		const remoteUrl = "ssh://git@github.enterprise.test/volt-hq/project.git";
		git("remote", "set-url", "origin", remoteUrl);
		view.url = "https://github.enterprise.test/volt-hq/project/pull/414";
		view.headRefOid = "c".repeat(64);
		await expect(resolve()).resolves.toMatchObject({
			ok: true,
			target: {
				repository: { host: "github.enterprise.test" },
				headRepository: { host: "github.enterprise.test" },
				remoteUrl,
				pullRequest: { headRefOid: "c".repeat(64) },
			},
		});
	});

	it("selects the tracked remote instead of a conflicting origin", async () => {
		git("remote", "rename", "origin", "selected");
		git("remote", "add", "origin", "https://github.com/unrelated/project.git");
		git("config", "branch.feature.remote", "selected");
		await expect(resolve()).resolves.toMatchObject({
			ok: true,
			target: { remote: "selected", remoteUrl: REMOTE_URL },
		});
	});

	it("resolves current PR using the tracked repository and verifies the listed identity", async () => {
		trackCurrentBranch();
		await expect(resolveCurrent()).resolves.toMatchObject({ ok: true, target: { headRef: "refs/pull/414/head" } });
		expect(vi.mocked(runGitHubCli).mock.calls[0]![0]).toEqual(
			expect.arrayContaining(["--repo", "github.com/volt-hq/project", "--head", "feature"]),
		);
		expect(vi.mocked(runGitHubCli).mock.calls).toHaveLength(2);
	});

	it.each([
		{ id: "PR_replaced" },
		{ headRefName: "other" },
		{ headRepositoryOwner: { login: "other" }, headRepository: { name: "project" } },
	])("rejects a changed current PR identity: %j", async (changed) => {
		trackCurrentBranch();
		Object.assign(view, changed);
		await expect(resolveCurrent()).resolves.toMatchObject({ ok: false });
	});

	it("rejects ambiguous current PRs before loading metadata", async () => {
		trackCurrentBranch();
		listed.push({ ...listed[0], id: "PR_415", number: 415, url: PR_URL.replace("414", "415") });
		await expect(resolveCurrent()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("Multiple") });
		expect(runGitHubCli).toHaveBeenCalledTimes(1);
	});

	it.each(["", "0", "-1", "01", "1.5", "2147483648", "9007199254740993", "414\n"])(
		"rejects invalid PR numbers before gh: %j",
		async (number) => {
			await expect(resolve(number)).resolves.toMatchObject({ ok: false });
			expect(runGitHubCli).not.toHaveBeenCalled();
		},
	);

	it.each([
		"https://github.com/other/project/pull/414",
		"https://github.com/volt-hq/project/pull/415",
		"https://secret:token@github.com/volt-hq/project/pull/414",
		`${PR_URL}?override=true`,
	])("treats expected URL as an assertion, never an override: %s", async (url) => {
		await expect(resolve("414", url)).resolves.toMatchObject({ ok: false });
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it.each([
		{ number: 415 },
		{ url: "https://github.com/other/project/pull/414" },
		{ headRefOid: "b".repeat(39) },
		{ headRefOid: `${"b".repeat(40)}\n` },
		{ headRefOid: `${"b".repeat(39)}\n` },
		{ headRefOid: "B".repeat(40) },
		{ headRefOid: "z".repeat(40) },
		{ headRefName: "feature:other" },
		{ headRefName: "../feature" },
		{ headRefName: "feature//other" },
		{ headRefName: "feature.lock/other" },
		{ headRefName: "feature@{1}" },
		{ headRefName: "feature\n" },
		{ headRefName: "x".repeat(1025) },
		{ title: "x".repeat(513) },
		{ title: "bad\u001b[0m" },
		{ headRepository: null },
		{ headRepositoryOwner: null },
		{ headRepository: { name: "../project" } },
		{ headRepository: { name: "project", nameWithOwner: "other/project" } },
	])("fails safely for unverified metadata: %j", async (changed) => {
		Object.assign(view, changed);
		await expect(resolve()).resolves.toMatchObject({ ok: false });
	});

	it("rejects credential-bearing selected remote URLs without exposing them", async () => {
		git("remote", "set-url", "origin", "https://secret:token@github.com/volt-hq/project.git");
		const result = await resolve();
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it("sanitizes CLI failures and malformed responses", async () => {
		vi.mocked(runGitHubCli).mockResolvedValueOnce({ ...response(null), ok: false, stderr: "secret-token" });
		const failed = await resolve();
		expect(failed).toMatchObject({ ok: false, error: expect.stringContaining("authentication") });
		expect(JSON.stringify(failed)).not.toContain("secret-token");
		vi.mocked(runGitHubCli).mockResolvedValueOnce({
			...response(null),
			stdout: Buffer.from("secret-token not json"),
		});
		const malformed = await resolve();
		expect(malformed.ok).toBe(false);
		expect(JSON.stringify(malformed)).not.toContain("secret-token");
	});

	it("returns a sanitized cancellation without invoking gh", async () => {
		await expect(resolve("414", undefined, AbortSignal.abort())).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("cancelled"),
		});
		expect(runGitHubCli).not.toHaveBeenCalled();
	});
});

function resolveCurrent() {
	return githubCliCodeHostProvider.resolvePullRequestCheckout({ cwd, maxPullRequestNumber: 2_147_483_647 });
}
