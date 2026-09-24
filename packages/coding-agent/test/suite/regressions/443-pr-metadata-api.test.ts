import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GitHubCliResult, runGitHubCli } from "../../../src/core/code-host/github-cli.ts";
import { capturePullRequestContextWithGitHubCli } from "../../../src/core/code-host/github-cli-context.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
let harness: Harness;
let host: string;
let metadata: Record<string, unknown>;
let payload: unknown;
let finalHead: string;
let metadataFailure: GitHubCliResult | undefined;
let checkPages: unknown[];

function response(value: unknown): GitHubCliResult {
	return { ok: true, stdout: Buffer.from(JSON.stringify(value)), stderr: "", timedOut: false, outputLimited: false };
}

function commit(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
	return {
		id: "COMMIT_head",
		oid: HEAD,
		statusCheckRollup: { contexts: { nodes, pageInfo: { hasNextPage, endCursor } } },
	};
}

function capture(signal?: AbortSignal) {
	return capturePullRequestContextWithGitHubCli({
		cwd: harness.tempDir,
		number: "443",
		maxPullRequestNumber: 2_147_483_647,
		signal,
	});
}

beforeEach(async () => {
	harness = await createHarness({ settings: { lsp: { enabled: false } } });
	host = "github.com";
	finalHead = HEAD;
	metadataFailure = undefined;
	checkPages = [];
	execFileSync("git", ["init", "--initial-branch=main"], { cwd: harness.tempDir, stdio: "pipe" });
	execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/project.git"], { cwd: harness.tempDir });
	metadata = {
		id: "PR_443",
		number: 443,
		title: "Metadata regression",
		body: "Body",
		url: "https://github.com/owner/project/pull/443",
		baseRefName: "main",
		headRefName: "feature",
		baseRefOid: BASE,
		headRefOid: HEAD,
		author: { login: "contributor" },
		state: "OPEN",
		isDraft: false,
		mergeable: "MERGEABLE",
		commits: { nodes: [{ commit: commit([]) }] },
	};
	payload = { data: { repository: { pullRequest: metadata } } };
	vi.mocked(runGitHubCli).mockReset();
	vi.mocked(runGitHubCli).mockImplementation(async (args, options) => {
		if (args[0] === "pr" && args[1] === "view") {
			// Emulate the gh 2.23 field allowlist, including the supported final head check.
			if (args.at(-1) !== "headRefOid")
				return { ...response(null), ok: false, stderr: 'Unknown JSON field: "baseRefOid"' };
			expect(args[2]).toBe(metadata.url);
			return response({ headRefOid: finalHead });
		}
		expect(args).toEqual(["api", "graphql", "--hostname", host, "--input", "-"]);
		const request = JSON.parse(options.input!) as { query: string; variables: Record<string, unknown> };
		if (request.query.includes("query VoltReviewPullRequestMetadata(")) {
			expect(request.variables).toEqual({ owner: "owner", name: "project", number: 443 });
			return metadataFailure ?? response(payload);
		}
		if (request.query.includes("query VoltReviewCommitChecks(")) {
			expect(request.variables.id).toBe("COMMIT_head");
			return response(checkPages.shift());
		}
		expect(request.variables.id).toBe("PR_443");
		const field = request.query.includes("closingIssuesReferences")
			? "closingIssuesReferences"
			: request.query.includes("reviewThreads")
				? "reviewThreads"
				: request.query.includes("reviews(first")
					? "reviews"
					: "comments";
		return response({ data: { node: { [field]: { nodes: [], pageInfo: { hasNextPage: false } } } } });
	});
});

afterEach(async () => {
	await harness.cleanupAsync();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("#443 authoritative PR metadata without gh pr view baseRefOid support", () => {
	it.each(["github.com", "github.enterprise.test"])(
		"pins API metadata to the selected repository on %s",
		async (hostname) => {
			host = hostname;
			metadata.url = `https://${host}/owner/project/pull/443`;
			execFileSync("git", ["remote", "set-url", "origin", `git@${host}:owner/project.git`], {
				cwd: harness.tempDir,
			});
			vi.stubEnv("GH_HOST", "other.test");
			vi.stubEnv("GH_REPO", "other/repository");
			const result = await capture();
			expect(result).toMatchObject({
				ok: true,
				pullRequest: {
					baseRefOid: BASE,
					headRefOid: HEAD,
					url: metadata.url,
					author: { login: "contributor" },
					reviewState: "ready",
					mergeability: "mergeable",
					checks: { state: "none", totalCount: 0 },
				},
				context: { manifest: { status: "complete" } },
			});
			expect(
				vi
					.mocked(runGitHubCli)
					.mock.calls.filter(([args]) => args[0] === "pr")
					.map(([args]) => args),
			).toEqual([["pr", "view", metadata.url, "--json", "headRefOid"]]);
		},
	);

	it("preserves canonical 64-character commit IDs", async () => {
		metadata.baseRefOid = "a".repeat(64);
		metadata.headRefOid = finalHead = "b".repeat(64);
		expect(await capture()).toMatchObject({
			ok: true,
			pullRequest: { baseRefOid: metadata.baseRefOid, headRefOid: finalHead },
		});
	});

	it.each(["baseRefOid", "headRefOid"])("rejects missing or noncanonical %s before context capture", async (field) => {
		for (const value of [undefined, null, "main", "a".repeat(39), "A".repeat(40), `${HEAD}\n`]) {
			metadata[field] = value;
			vi.mocked(runGitHubCli).mockClear();
			expect(await capture()).toMatchObject({
				ok: false,
				error: expect.stringContaining("Invalid GitHub API pull request metadata"),
			});
			expect(runGitHubCli).toHaveBeenCalledTimes(1);
		}
	});

	it.each([null, {}, { data: null }, { data: { repository: null } }, { data: { repository: { pullRequest: null } } }])(
		"rejects missing API data: %j",
		async (value) => {
			payload = value;
			expect(await capture()).toMatchObject({
				ok: false,
				remoteError: expect.stringContaining("repository access"),
			});
			expect(runGitHubCli).toHaveBeenCalledTimes(1);
		},
	);

	it("rejects GraphQL errors even alongside valid-looking partial metadata", async () => {
		payload = { data: { repository: { pullRequest: metadata } }, errors: [{ message: "private API diagnostic" }] };
		expect(await capture()).toMatchObject({
			ok: false,
			error: expect.stringContaining("Invalid GitHub API metadata response"),
		});
		expect(runGitHubCli).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ number: 444 },
		{ url: "https://github.com/other/project/pull/443" },
		{ url: "https://other.test/owner/project/pull/443" },
		{ url: "https://github.com/owner/project/pull/444" },
	])("rejects mismatched identity before context capture: %j", async (change) => {
		Object.assign(metadata, change);
		expect(await capture()).toMatchObject({
			ok: false,
			error: expect.stringContaining("identity could not be verified"),
		});
		expect(runGitHubCli).toHaveBeenCalledTimes(1);
	});

	it.each([
		"authentication failed",
		"network unavailable",
		"API rate limit exceeded",
		"GitHub CLI command timed out.",
		"GitHub CLI output exceeded its capture limit.",
		"Unable to start GitHub CLI.",
	])("does not retry or disguise metadata failure: %s", async (stderr) => {
		metadataFailure = { ...response(null), ok: false, stderr };
		const result = await capture();
		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining(stderr),
			remoteError: expect.stringContaining("Check gh installation"),
		});
		expect(runGitHubCli).toHaveBeenCalledTimes(1);
	});

	it("rejects malformed JSON rather than falling back to local refs", async () => {
		metadataFailure = { ...response(null), stdout: Buffer.from("not json") };
		expect(await capture()).toMatchObject({ ok: false });
		expect(runGitHubCli).toHaveBeenCalledTimes(1);
	});

	it.each(["c".repeat(40), "not-an-oid"])("retains the final head guard: %s", async (head) => {
		finalHead = head;
		expect(await capture()).toMatchObject({ ok: false });
	});

	it("passes cancellation to the metadata request and stops before context reads", async () => {
		const controller = new AbortController();
		vi.mocked(runGitHubCli).mockImplementationOnce(async (_args, options) => {
			expect(options.signal).toBe(controller.signal);
			controller.abort();
			throw new Error(options.cancellationMessage);
		});
		await expect(capture(controller.signal)).rejects.toThrow("cancelled");
		expect(runGitHubCli).toHaveBeenCalledTimes(1);
	});

	it("paginates mixed check types on the captured commit without reporting a partial passing summary", async () => {
		metadata.commits = {
			nodes: [
				{
					commit: commit([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }], true, "second"),
				},
			],
		};
		checkPages = [
			{
				data: {
					node: commit([
						{ __typename: "StatusContext", state: "FAILURE" },
						{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: null },
						{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
					]),
				},
			},
		];
		expect(await capture()).toMatchObject({
			ok: true,
			pullRequest: {
				checks: {
					state: "failing",
					totalCount: 4,
					passedCount: 1,
					failedCount: 1,
					pendingCount: 1,
					neutralCount: 1,
				},
			},
		});
	});

	it.each(["missing", "different head", "different commit", "errors", "repeated cursor"])(
		"omits incomplete optional check summaries: %s",
		async (problem) => {
			metadata.commits = {
				nodes: [{ commit: commit([{ __typename: "StatusContext", state: "SUCCESS" }], true, "second") }],
			};
			const next = commit([], problem === "repeated cursor", "second");
			if (problem === "different head") next.oid = BASE;
			if (problem === "different commit") next.id = "COMMIT_other";
			checkPages = [
				problem === "missing"
					? {}
					: { data: { node: next }, ...(problem === "errors" ? { errors: [{ message: "unavailable" }] } : {}) },
			];
			const result = await capture();
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error(result.error);
			expect(result.pullRequest.checks).toBeUndefined();
			expect(result.context.manifest.status).toBe("complete");
			expect(checkPages).toHaveLength(0);
		},
	);

	it("treats a null status rollup on the verified head as no checks", async () => {
		metadata.commits = { nodes: [{ commit: { id: "COMMIT_head", oid: HEAD, statusCheckRollup: null } }] };
		expect(await capture()).toMatchObject({ ok: true, pullRequest: { checks: { state: "none", totalCount: 0 } } });
	});
});
