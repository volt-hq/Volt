import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GitHubCliResult, runGitHubCli } from "../../../src/core/code-host/github-cli.ts";
import { capturePullRequestContextWithGitHubCli } from "../../../src/core/code-host/github-cli-context.ts";
import { prepareReviewWorkflow } from "../../../src/core/review.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

const HEAD = "b".repeat(40);
const BRANCH = "volt/pairing-e2e-ca";
const MAX_PR = 2_147_483_647;
const SECRET = "https://credential:private-token@private.example/repo raw-cli-diagnostic";
let harness: Harness;
let host: string;
let view: Record<string, unknown>;
let candidates: Array<Record<string, unknown>>;
let failPhase: "list" | "metadata" | "final" | undefined;
let paginateComments: boolean;
let finalHead: string;

function git(...args: string[]): string {
	return execFileSync("git", args, { cwd: harness.tempDir, encoding: "utf8" }).trim();
}

function response(value: unknown): GitHubCliResult {
	return { ok: true, stdout: Buffer.from(JSON.stringify(value)), stderr: "", outputLimited: false, timedOut: false };
}

function candidate(number = 4, state = "OPEN"): Record<string, unknown> {
	return {
		id: `PR_${number}`,
		number,
		url: `https://${host}/volt-hq/iroh-ffi/pull/${number}`,
		state,
		headRefName: BRANCH,
		headRepository: { name: "iroh-ffi" },
		headRepositoryOwner: { login: "volt-hq" },
	};
}

function capture(number?: string) {
	return capturePullRequestContextWithGitHubCli({ cwd: harness.tempDir, number, maxPullRequestNumber: MAX_PR });
}

beforeEach(async () => {
	harness = await createHarness({ settings: { lsp: { enabled: false } } });
	host = "github.com";
	failPhase = undefined;
	paginateComments = false;
	finalHead = HEAD;
	git("init", "--initial-branch=review/iroh-pr-4");
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
	git("remote", "add", "origin", "https://github.com/volt-hq/iroh-ffi.git");
	git("remote", "add", "upstream", "git@github.com:n0-computer/iroh-ffi.git");
	git("update-ref", `refs/remotes/origin/${BRANCH}`, "HEAD");
	git("branch", "--set-upstream-to", `origin/${BRANCH}`);
	candidates = [candidate()];
	view = {
		...candidate(),
		title: "Review fixture",
		body: "Body",
		baseRefName: "main",
		baseRefOid: "a".repeat(40),
		headRefOid: HEAD,
	};
	vi.mocked(runGitHubCli).mockReset();
	vi.mocked(runGitHubCli).mockImplementation(async (args, options) => {
		const phase = args[1] === "list" ? "list" : args.at(-1) === "headRefOid" ? "final" : "metadata";
		if (args[0] === "pr" && failPhase === phase) {
			return { ok: false, stdout: Buffer.alloc(0), stderr: SECRET, outputLimited: false, timedOut: false };
		}
		if (args[0] === "pr" && args[1] === "list") {
			expect(args[args.indexOf("--repo") + 1]).toBe(`${host}/volt-hq/iroh-ffi`);
			expect(args[args.indexOf("--head") + 1]).toBe(BRANCH);
			return response(candidates);
		}
		if (args[0] === "pr" && args[1] === "view") {
			// Both numbered and current-PR lookups must ignore gh's implicit repository selection.
			expect(args[2]).toBe(phase === "final" ? view.url : `https://${host}/volt-hq/iroh-ffi/pull/4`);
			return response(phase === "final" ? { headRefOid: finalHead } : view);
		}
		if (args[0] === "api" && args[1] === "graphql") {
			expect(args[args.indexOf("--hostname") + 1]).toBe(host);
			const request = JSON.parse(options.input!) as {
				query: string;
				variables: { id: string; cursor: string | null };
			};
			expect(request.variables.id).toBe("PR_4");
			const field = request.query.includes("closingIssuesReferences")
				? "closingIssuesReferences"
				: request.query.includes("reviewThreads")
					? "reviewThreads"
					: request.query.includes("reviews(first")
						? "reviews"
						: "comments";
			const comments = field === "comments" && paginateComments;
			return response({
				data: {
					node: {
						[field]: {
							nodes: comments ? [{ id: request.variables.cursor ?? "first", body: "Discussion" }] : [],
							pageInfo: {
								hasNextPage: comments && request.variables.cursor === null,
								endCursor: comments ? "second" : null,
							},
						},
					},
				},
			});
		}
		throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
	});
});

afterEach(async () => {
	await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("#405 current-PR capture", () => {
	it("uses the tracked repository/branch in a fork and pins the final head check to the PR URL", async () => {
		const result = await capture();
		expect(result).toMatchObject({
			ok: true,
			pullRequest: { number: 4, headRefName: BRANCH, headRefOid: HEAD, url: view.url },
		});
		const calls = vi.mocked(runGitHubCli).mock.calls;
		expect(calls[0]![0]).toEqual(expect.arrayContaining(["--repo", "github.com/volt-hq/iroh-ffi", "--head", BRANCH]));
		expect(calls.at(-1)![0]).toEqual(["pr", "view", view.url, "--json", "headRefOid"]);
	});

	it("pins GHES and paginated discussion reads to the captured host and node", async () => {
		host = "github.enterprise.test";
		git("remote", "set-url", "origin", `ssh://git@${host}/volt-hq/iroh-ffi.git`);
		candidates = [candidate()];
		view.url = candidates[0]!.url;
		paginateComments = true;
		const result = await capture();
		expect(result).toMatchObject({
			ok: true,
			context: { manifest: { status: "complete", discussionEntryCount: 2 } },
		});
		expect(vi.mocked(runGitHubCli).mock.calls.filter(([args]) => args[0] === "api")).toHaveLength(6);
	});

	it("reports a genuine no-match through remote workflow preparation before inference", async () => {
		candidates = [];
		await expect(
			prepareReviewWorkflow({
				target: { kind: "pr" },
				cwd: harness.tempDir,
				settingsManager: harness.settingsManager,
				modelRegistry: harness.session.modelRegistry,
				currentModel: harness.getModel(),
				sanitizeRemoteErrors: true,
			}),
		).rejects.toThrow("No pull request matches the tracked branch");
		expect(vi.mocked(runGitHubCli)).toHaveBeenCalledTimes(1);
		expect(harness.eventsOfType("message_start")).toHaveLength(0);
	});

	it("rejects multiple active matches rather than selecting the first", async () => {
		candidates = [candidate(), candidate(5)];
		expect(await capture()).toMatchObject({
			ok: false,
			remoteError: expect.stringContaining("Multiple pull requests"),
		});
		expect(vi.mocked(runGitHubCli)).toHaveBeenCalledTimes(1);
	});

	it("prefers a unique active match over historical PRs and still permits a unique historical match", async () => {
		candidates = [candidate(5, "MERGED"), candidate()];
		expect(await capture()).toMatchObject({ ok: true, pullRequest: { number: 4 } });
		candidates = [candidate(4, "CLOSED")];
		expect(await capture()).toMatchObject({ ok: true, pullRequest: { number: 4 } });
		candidates = [candidate(4, "CLOSED"), candidate(5, "MERGED")];
		expect(await capture()).toMatchObject({
			ok: false,
			remoteError: expect.stringContaining("Multiple pull requests"),
		});
	});

	describe.each(["CLOSED", "MERGED"])("historical %s PRs with unavailable heads", (state) => {
		it.each(["headRepository", "headRepositoryOwner", "both"])(
			"preserves a verified active match with null %s in either list order",
			async (field) => {
				const historical = candidate(5, state);
				if (field !== "headRepositoryOwner") historical.headRepository = null;
				if (field !== "headRepository") historical.headRepositoryOwner = null;
				for (const list of [
					[historical, candidate()],
					[candidate(), historical],
				]) {
					candidates = list;
					expect(await capture()).toMatchObject({
						ok: true,
						pullRequest: { number: 4, url: view.url },
						context: { manifest: { status: "complete" } },
					});
					expect(vi.mocked(runGitHubCli).mock.calls.at(-1)![0]).toEqual([
						"pr",
						"view",
						view.url,
						"--json",
						"headRefOid",
					]);
				}
			},
		);

		it.each([false, true])(
			"fails closed without an active match (verified historical match: %s)",
			async (includeVerified) => {
				candidates = [
					{ ...candidate(5, state), headRepository: null, headRepositoryOwner: null },
					...(includeVerified ? [candidate(4, "CLOSED")] : []),
				];
				expect(await capture()).toMatchObject({
					ok: false,
					remoteError: expect.stringContaining("head repository metadata is unavailable"),
				});
				expect(vi.mocked(runGitHubCli)).toHaveBeenCalledTimes(1);
			},
		);
	});

	it("still rejects multiple active matches alongside an unavailable historical head", async () => {
		candidates = [
			{ ...candidate(3, "CLOSED"), headRepository: null, headRepositoryOwner: null },
			candidate(),
			candidate(5),
		];
		expect(await capture()).toMatchObject({
			ok: false,
			remoteError: expect.stringContaining("Multiple pull requests"),
		});
		expect(vi.mocked(runGitHubCli)).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ state: "OPEN", headRepository: null },
		{ state: "OPEN", headRepositoryOwner: null },
		{ state: "UNKNOWN", headRepository: null },
		{ state: "CLOSED", headRepository: {} },
		{ state: "CLOSED", headRepository: null, headRepositoryOwner: {} },
		{ state: "CLOSED", headRepository: null, headRefName: null },
		{ state: "CLOSED", headRepository: null, url: "not a URL" },
	])("does not ignore invalid candidates alongside an active match: %j", async (overrides) => {
		candidates = [candidate(), { ...candidate(5), ...overrides }];
		expect(await capture()).toMatchObject({ ok: false });
		expect(vi.mocked(runGitHubCli)).toHaveBeenCalledTimes(1);
	});

	it("does not accept another fork or branch with the same branch/PR number", async () => {
		candidates = [
			{ ...candidate(), headRepositoryOwner: { login: "other-fork" } },
			{ ...candidate(), headRefName: "other-branch" },
		];
		expect(await capture()).toMatchObject({
			ok: false,
			remoteError: expect.stringContaining("No pull request matches"),
		});
	});

	it("fails closed when the PR list reaches its completeness bound", async () => {
		candidates = Array.from({ length: 100 }, (_, i) => candidate(i + 1));
		expect(await capture()).toMatchObject({ ok: false, remoteError: expect.stringContaining("unique pull request") });
	});

	it.each(["untracked", "detached", "local upstream", "ambiguous remote", "credential URL"])(
		"fails safely for %s configuration without querying GitHub",
		async (configuration) => {
			if (configuration === "untracked") git("branch", "--unset-upstream");
			if (configuration === "detached") git("checkout", "--detach");
			if (configuration === "local upstream") git("config", "branch.review/iroh-pr-4.remote", ".");
			if (configuration === "ambiguous remote")
				git("remote", "set-url", "--add", "origin", "https://github.com/other/repo.git");
			if (configuration === "credential URL")
				git("remote", "set-url", "origin", "https://credential:private-token@github.com/volt-hq/iroh-ffi.git");
			const result = await capture();
			expect(result).toMatchObject({ ok: false, remoteError: expect.stringMatching(/host|branch/) });
			expect(JSON.stringify(result)).not.toContain("private-token");
			expect(vi.mocked(runGitHubCli)).not.toHaveBeenCalled();
		},
	);

	it("allows explicitly numbered capture without tracking and still pins later reads", async () => {
		git("branch", "--unset-upstream");
		expect(await capture("4")).toMatchObject({ ok: true });
		expect(vi.mocked(runGitHubCli).mock.calls[0]![0].slice(0, 3)).toEqual(["pr", "view", view.url]);
		expect(vi.mocked(runGitHubCli).mock.calls.at(-1)![0][2]).toBe(view.url);
	});

	it("pins a numbered review to the fork even when gh's default is upstream", async () => {
		git("config", "remote.upstream.gh-resolved", "base");
		candidates = [];
		view.headRefName = "another-pr-branch";
		expect(await capture("4")).toMatchObject({
			ok: true,
			pullRequest: { number: 4, url: view.url, headRefName: "another-pr-branch" },
			context: { manifest: { status: "complete" } },
		});
		expect(vi.mocked(runGitHubCli).mock.calls.some(([args]) => args[1] === "list")).toBe(false);
	});

	it("prefers a numbered review's configured tracking remote over origin", async () => {
		git("remote", "set-url", "origin", "https://github.com/n0-computer/iroh-ffi.git");
		git("remote", "set-url", "upstream", "git@github.com:volt-hq/iroh-ffi.git");
		git("update-ref", `refs/remotes/upstream/${BRANCH}`, "HEAD");
		git("branch", "--set-upstream-to", `upstream/${BRANCH}`);
		expect(await capture("4")).toMatchObject({ ok: true, pullRequest: { url: view.url } });
	});

	it.each(["detached", "local upstream", "single non-origin remote", "unborn"])(
		"resolves a numbered review with %s through an explicit repository",
		async (configuration) => {
			if (configuration === "detached") git("checkout", "--detach");
			if (configuration === "local upstream") git("config", "branch.review/iroh-pr-4.remote", ".");
			if (configuration === "single non-origin remote") {
				git("branch", "--unset-upstream");
				git("remote", "remove", "upstream");
				git("remote", "rename", "origin", "fork");
			}
			if (configuration === "unborn") git("checkout", "--orphan", "new-branch");
			expect(await capture("4")).toMatchObject({ ok: true, pullRequest: { url: view.url } });
		},
	);

	it("pins numbered GHES metadata, discussion, and final head reads to the selected host", async () => {
		host = "github.enterprise.test";
		git("remote", "set-url", "origin", `ssh://git@${host}/volt-hq/iroh-ffi.git`);
		view.url = candidate().url;
		paginateComments = true;
		expect(await capture("4")).toMatchObject({
			ok: true,
			pullRequest: { url: view.url },
			context: { manifest: { status: "complete", discussionEntryCount: 2 } },
		});
	});

	it.each(["missing remotes", "ambiguous remotes", "missing tracked remote", "ambiguous URL", "credential URL"])(
		"does not guess or query GitHub for a numbered PR with %s",
		async (configuration) => {
			if (configuration === "missing remotes") {
				git("remote", "remove", "origin");
				git("remote", "remove", "upstream");
			}
			if (configuration === "ambiguous remotes") {
				git("branch", "--unset-upstream");
				git("remote", "rename", "origin", "fork");
			}
			if (configuration === "missing tracked remote") git("config", "branch.review/iroh-pr-4.remote", "missing");
			if (configuration === "ambiguous URL")
				git("remote", "set-url", "--add", "origin", "https://github.com/other/repo.git");
			if (configuration === "credential URL")
				git("remote", "set-url", "origin", "https://credential:private-token@github.com/volt-hq/iroh-ffi.git");
			const result = await capture("4");
			expect(result).toMatchObject({ ok: false, remoteError: expect.stringContaining("host") });
			expect(JSON.stringify(result)).not.toContain("private-token");
			expect(vi.mocked(runGitHubCli)).not.toHaveBeenCalled();
		},
	);

	it("accepts GitHub's canonical repository casing for a numbered PR", async () => {
		git("remote", "set-url", "origin", "git@github.com:Volt-HQ/Iroh-FFI.git");
		view.url = "https://github.com/Volt-HQ/Iroh-FFI/pull/4";
		expect(await capture("4")).toMatchObject({ ok: true, pullRequest: { url: view.url } });
	});

	it("rejects a different PR number returned by the numbered lookup", async () => {
		view.number = 5;
		view.url = "https://github.com/volt-hq/iroh-ffi/pull/5";
		expect(await capture("4")).toMatchObject({ ok: false, error: expect.stringContaining("identity") });
		expect(vi.mocked(runGitHubCli)).toHaveBeenCalledTimes(1);
	});

	it("rejects the same numbered PR from another repository before capturing discussion", async () => {
		view.url = "https://github.com/n0-computer/iroh-ffi/pull/4";
		expect(await capture("4")).toMatchObject({ ok: false, error: expect.stringContaining("identity") });
		expect(vi.mocked(runGitHubCli)).toHaveBeenCalledTimes(1);
	});

	it.each(["metadata", "final"] as const)("sanitizes numbered PR failures during %s", async (phase) => {
		failPhase = phase;
		const result = await capture("4");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected capture failure");
		expect(result.remoteError).toBeTruthy();
		expect(result.remoteError).not.toContain("private-token");
	});

	it.each(["list", "metadata", "final"] as const)(
		"does not expose raw CLI diagnostics remotely during %s",
		async (phase) => {
			failPhase = phase;
			const result = await capture();
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("Expected capture failure");
			expect(result.remoteError).toBeTruthy();
			expect(result.remoteError).not.toContain("private-token");
			expect(result.remoteError).not.toContain("raw-cli-diagnostic");
		},
	);

	it.each(["url", "id", "headRefName"])(
		"rejects metadata whose %s differs from the selected target",
		async (field) => {
			view[field] = field === "url" ? "https://github.com/another/repo/pull/4" : "different";
			expect(await capture()).toMatchObject({
				ok: false,
				error: expect.stringContaining("identity could not be verified"),
			});
			expect(vi.mocked(runGitHubCli).mock.calls.every(([args]) => args[0] === "pr")).toBe(true);
		},
	);

	it.each([
		"https://credential:private-token@github.com/volt-hq/iroh-ffi/pull/4",
		"https://github.com/volt-hq/iroh-ffi/pull/5",
		"not a URL",
	])("rejects malformed or mismatched candidate identity: %s", async (url) => {
		candidates = [{ ...candidate(), url }];
		const result = await capture();
		expect(result).toMatchObject({ ok: false });
		expect(JSON.stringify(result)).not.toContain("private-token");
		expect(vi.mocked(runGitHubCli)).toHaveBeenCalledTimes(1);
	});

	it.each([undefined, "4"])("retains the exact-head movement guard (number: %s)", async (number) => {
		finalHead = "c".repeat(40);
		expect(await capture(number)).toMatchObject({
			ok: false,
			remoteError: expect.stringContaining("pull request changed"),
		});
	});

	it.each([undefined, "4"])("does not issue GitHub requests after cancellation (number: %s)", async (number) => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			capturePullRequestContextWithGitHubCli({
				cwd: harness.tempDir,
				number,
				maxPullRequestNumber: MAX_PR,
				signal: controller.signal,
			}),
		).rejects.toThrow("cancelled");
		expect(vi.mocked(runGitHubCli)).not.toHaveBeenCalled();
	});
});
