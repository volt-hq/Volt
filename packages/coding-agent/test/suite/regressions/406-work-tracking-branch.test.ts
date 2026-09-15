import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGitHubCli } from "../../../src/core/code-host/github-cli.ts";
import { discoverPullRequestWithGitHubCli } from "../../../src/core/code-host/github-cli-discovery.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

const LOCAL_BRANCH = "review/local-topic";
const REMOTE_BRANCH = "volt/remote-topic";
const SECRET = "https://credential:private-token@private.example/repo raw-cli-diagnostic";
let harness: Harness;
let headOid: string;
let expectedBranch: string;
let responses: Record<string, Array<Record<string, unknown>>>;

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: harness.tempDir, encoding: "utf8" }).trim();
}

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		number: 42,
		title: "Tracked fork PR",
		state: "OPEN",
		isDraft: false,
		headRefName: expectedBranch,
		headRefOid: headOid,
		headRepository: { name: "fork" },
		headRepositoryOwner: { login: "contributor" },
		...overrides,
	};
}

function discover(signal?: AbortSignal) {
	return discoverPullRequestWithGitHubCli({ cwd: harness.tempDir, branch: LOCAL_BRANCH, headOid, signal });
}

beforeEach(async () => {
	harness = await createHarness({ settings: { lsp: { enabled: false } } });
	git("init", `--initial-branch=${LOCAL_BRANCH}`);
	git(
		"-c",
		"user.name=Work Test",
		"-c",
		"user.email=work@example.test",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"--allow-empty",
		"-m",
		"fixture",
	);
	headOid = git("rev-parse", "HEAD");
	git("remote", "add", "origin", "https://github.com/contributor/fork.git");
	git("remote", "add", "upstream", "git@github.com:volt-hq/volt.git");
	git("update-ref", `refs/remotes/origin/${REMOTE_BRANCH}`, headOid);
	git("branch", `--set-upstream-to=origin/${REMOTE_BRANCH}`);
	expectedBranch = REMOTE_BRANCH;
	responses = { "contributor/fork": [], "volt-hq/volt": [pullRequest()] };
	vi.mocked(runGitHubCli).mockReset();
	vi.mocked(runGitHubCli).mockImplementation(async (args) => {
		expect(args.slice(0, 2)).toEqual(["pr", "list"]);
		expect(args[args.indexOf("--head") + 1]).toBe(expectedBranch);
		const repository = args[args.indexOf("--repo") + 1]!;
		return {
			ok: true,
			stdout: Buffer.from(JSON.stringify(responses[repository] ?? [])),
			stderr: "",
			outputLimited: false,
			timedOut: false,
		};
	});
});

afterEach(async () => {
	await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("#406 Work tracked head identity", () => {
	it("uses the renamed tracking branch for a fork PR targeting upstream", async () => {
		const request = { cwd: harness.tempDir, branch: LOCAL_BRANCH, headOid };
		expect(await discoverPullRequestWithGitHubCli(request)).toMatchObject({
			state: "resolved",
			pullRequest: {
				number: 42,
				headBranch: REMOTE_BRANCH,
				matchedHeadOid: headOid,
				repository: { canonicalId: "github:github.com/volt-hq/volt" },
				headRepository: { canonicalId: "github:github.com/contributor/fork" },
			},
		});
		expect(request.branch).toBe(LOCAL_BRANCH);
		expect(vi.mocked(runGitHubCli).mock.calls.map(([args]) => args[args.indexOf("--repo") + 1])).toEqual([
			"contributor/fork",
			"volt-hq/volt",
		]);
	});

	it("uses a non-origin tracking remote, including slash-delimited remote names", async () => {
		git("remote", "rename", "origin", "fork/team");
		git("remote", "add", "origin", "https://github.com/other/project.git");
		expect(await discover()).toMatchObject({
			state: "resolved",
			pullRequest: { headBranch: REMOTE_BRANCH, headRepository: { owner: "contributor" } },
		});
	});

	it("resolves the requested local branch rather than the currently checked-out branch", async () => {
		git("branch", "other-topic");
		git("update-ref", "refs/remotes/upstream/other-topic", headOid);
		git("branch", "--set-upstream-to=upstream/other-topic", "other-topic");
		git("checkout", "other-topic");
		expect(await discover()).toMatchObject({ state: "resolved", pullRequest: { headBranch: REMOTE_BRANCH } });
	});

	it("does not accept colliding numbers from another fork, branch, or head OID", async () => {
		responses["contributor/fork"] = [
			pullRequest({ headRepositoryOwner: { login: "other" } }),
			pullRequest({ headRefName: LOCAL_BRANCH }),
			pullRequest({ headRefOid: "f".repeat(40) }),
		];
		expect(await discover()).toMatchObject({ state: "resolved", pullRequest: { repository: { owner: "volt-hq" } } });
		responses["volt-hq/volt"] = [];
		expect(await discover()).toEqual({ state: "none" });
	});

	it("reports two exact active matches with the same PR number as ambiguous", async () => {
		responses["contributor/fork"] = [pullRequest()];
		expect(await discover()).toEqual({ state: "ambiguous" });
	});

	it("retains active/historical precedence with a renamed tracked branch", async () => {
		responses["contributor/fork"] = [pullRequest({ state: "MERGED" })];
		expect(await discover()).toMatchObject({ state: "resolved", pullRequest: { status: "open" } });
		responses["volt-hq/volt"] = [];
		expect(await discover()).toMatchObject({ state: "resolved", pullRequest: { status: "merged" } });
		responses["volt-hq/volt"] = [pullRequest({ state: "CLOSED" })];
		expect(await discover()).toEqual({ state: "ambiguous" });
	});

	it.each(["absent", "local-only"])("preserves exact-OID/same-name fallback for %s tracking", async (tracking) => {
		git("branch", "--unset-upstream");
		if (tracking === "local-only") {
			git("branch", "local-source");
			git("branch", "--set-upstream-to=local-source");
		}
		git("update-ref", `refs/remotes/origin/${LOCAL_BRANCH}`, headOid);
		expectedBranch = LOCAL_BRANCH;
		responses["volt-hq/volt"] = [pullRequest()];
		expect(await discover()).toMatchObject({ state: "resolved", pullRequest: { headBranch: LOCAL_BRANCH } });
	});

	it("preserves the unique-repository fallback for an untracked branch", async () => {
		git("branch", "--unset-upstream");
		git("remote", "remove", "upstream");
		expectedBranch = LOCAL_BRANCH;
		responses["contributor/fork"] = [pullRequest()];
		expect(await discover()).toMatchObject({ state: "resolved", pullRequest: { headBranch: LOCAL_BRANCH } });
	});

	it("does not guess among repositories for untracked branches without matching refs", async () => {
		git("branch", "--unset-upstream");
		expect(await discover()).toEqual({ state: "unavailable", reason: "repository_ambiguous" });
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it("rejects an ambiguous tracked remote", async () => {
		git("remote", "set-url", "--add", "origin", "https://github.com/other/project.git");
		expect(await discover()).toEqual({ state: "unavailable", reason: "repository_ambiguous" });
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"rejects credential-bearing tracked URLs without leaking them (additional URL: %s)",
		async (additional) => {
			git(
				"remote",
				"set-url",
				...(additional ? ["--add"] : []),
				"origin",
				"https://credential:private-token@github.com/contributor/fork.git",
			);
			expect(await discover()).toEqual({ state: "unavailable", reason: "unsupported_repository" });
			expect(runGitHubCli).not.toHaveBeenCalled();
		},
	);

	it("does not fall back to another remote for an unsupported tracked transport", async () => {
		git("remote", "set-url", "origin", "/private/local-repository");
		expect(await discover()).toEqual({ state: "unavailable", reason: "unsupported_repository" });
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it("rejects a pattern matching multiple local refs rather than selecting a different branch", async () => {
		git("branch", "review/other");
		expect(await discoverPullRequestWithGitHubCli({ cwd: harness.tempDir, branch: "review/*", headOid })).toEqual({
			state: "unavailable",
			reason: "invalid_response",
		});
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it("keeps raw GitHub failures out of discovery outcomes", async () => {
		vi.mocked(runGitHubCli).mockResolvedValue({
			ok: false,
			stdout: Buffer.alloc(0),
			stderr: SECRET,
			outputLimited: false,
			timedOut: false,
		});
		expect(await discover()).toEqual({ state: "unavailable", reason: "not_authenticated" });
	});

	it("does not issue GitHub requests after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		expect(await discover(controller.signal)).toEqual({ state: "unavailable", reason: "cancelled" });
		expect(runGitHubCli).not.toHaveBeenCalled();
	});
});
