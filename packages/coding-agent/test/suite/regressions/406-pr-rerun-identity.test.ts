import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GitHubCliResult, runGitHubCli } from "../../../src/core/code-host/github-cli.ts";
import { capturePullRequestContextWithGitHubCli } from "../../../src/core/code-host/github-cli-context.ts";
import { MAX_PULL_REQUEST_NUMBER, prepareReviewWorkflow, reviewTargetForRerun } from "../../../src/core/review.ts";
import { appendReviewRun, getReviewRun, type ReviewRunRecord } from "../../../src/core/review-state.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

const URL = "https://github.com/contributor/project/pull/42";
const HEAD = "b".repeat(40);
const SECRET = "https://credential:private-token@private.example/repo raw-cli-diagnostic";
let harness: Harness;
let record: ReviewRunRecord;

function git(...args: string[]): void {
	execFileSync("git", args, { cwd: harness.tempDir, stdio: "pipe" });
}

function response(value: unknown): GitHubCliResult {
	return { ok: true, stdout: Buffer.from(JSON.stringify(value)), stderr: "", outputLimited: false, timedOut: false };
}

function savedTarget() {
	appendReviewRun(harness.sessionManager, record);
	const saved = getReviewRun(harness.sessionManager, record.runId);
	if (!saved) throw new Error("Missing saved review fixture");
	return reviewTargetForRerun(saved);
}

async function prepareRerun() {
	return prepareReviewWorkflow({
		target: savedTarget(),
		cwd: harness.tempDir,
		settingsManager: harness.settingsManager,
		modelRegistry: harness.session.modelRegistry,
		currentModel: harness.getModel(),
		sanitizeRemoteErrors: true,
	});
}

beforeEach(async () => {
	harness = await createHarness({ settings: { lsp: { enabled: false } } });
	git("init", "--initial-branch=local-topic");
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
	git("remote", "add", "origin", "https://github.com/contributor/project.git");
	git("remote", "add", "upstream", "https://github.com/parent/project.git");
	git("update-ref", "refs/remotes/origin/remote-topic", "HEAD");
	git("branch", "--set-upstream-to=origin/remote-topic");
	record = {
		schemaVersion: 1,
		runId: "review:rerun-identity",
		workflowAction: "review.pr",
		status: "cancelled",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "PR #42",
			diffCommand: `gh pr diff ${URL}`,
			identity: {
				kind: "pr",
				baseTree: "a".repeat(40),
				headTree: HEAD,
				pullRequest: {
					providerId: "github",
					number: 42,
					title: "Saved PR",
					body: "",
					url: URL,
					baseRefName: "main",
					headRefName: "remote-topic",
					baseRefOid: "a".repeat(40),
					headRefOid: HEAD,
				},
			},
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "incremental" },
	};
	vi.mocked(runGitHubCli).mockReset();
	vi.mocked(runGitHubCli).mockImplementation(async (args, options) => {
		if (args[0] === "pr" && args[1] === "view") {
			expect(args[2]).toBe(URL);
			return response(
				args.at(-1) === "headRefOid"
					? { headRefOid: HEAD }
					: {
							...record.target.identity.pullRequest,
							id: "PR_fork_42",
							url: URL,
						},
			);
		}
		if (args[0] === "api" && args[1] === "graphql") {
			const request = JSON.parse(options.input!) as { query: string; variables: { id: string } };
			expect(request.variables.id).toBe("PR_fork_42");
			const field = request.query.includes("closingIssuesReferences")
				? "closingIssuesReferences"
				: request.query.includes("reviewThreads")
					? "reviewThreads"
					: request.query.includes("reviews(first")
						? "reviews"
						: "comments";
			return response({
				data: { node: { [field]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
			});
		}
		throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
	});
});

afterEach(async () => {
	await harness.cleanupAsync();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("#406 PR rerun identity", () => {
	it.each([URL, "https://github.com/Contributor/Project/pull/42"])(
		"retains %s across gh default changes",
		async (url) => {
			record.target.identity.pullRequest!.url = url;
			git("config", "remote.upstream.gh-resolved", "base");
			vi.stubEnv("GH_REPO", "parent/project");
			const target = savedTarget();
			expect(target).toEqual({ kind: "pr", number: "42", expectedUrl: url });
			if (target.kind !== "pr") throw new Error("Expected PR target");
			expect(
				await capturePullRequestContextWithGitHubCli({
					...target,
					cwd: harness.tempDir,
					maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
				}),
			).toMatchObject({ ok: true, pullRequest: { url: URL, number: 42 } });
			expect(harness.eventsOfType("message_start")).toHaveLength(0);
		},
	);

	it.each(["tracking remote", "remote URL"])(
		"rejects a colliding PR after changing %s before GitHub or inference",
		async (change) => {
			if (change === "tracking remote") git("config", "branch.local-topic.remote", "upstream");
			else git("remote", "set-url", "origin", "https://github.com/parent/project.git");
			await expect(prepareRerun()).rejects.toThrow("selected pull request does not match");
			expect(runGitHubCli).not.toHaveBeenCalled();
			expect(harness.eventsOfType("message_start")).toHaveLength(0);
		},
	);

	it.each(["missing PR", "missing URL"])("rejects %s instead of resolving the current PR", async (missing) => {
		if (missing === "missing PR") delete record.target.identity.pullRequest;
		else record.target.identity.pullRequest!.url = "";
		await expect(prepareRerun()).rejects.toThrow("Start a new review");
		expect(runGitHubCli).not.toHaveBeenCalled();
		expect(harness.eventsOfType("message_start")).toHaveLength(0);
	});

	it.each([
		"not a URL",
		"https://github.com/contributor/project/pull/43",
		"https://credential:private-token@github.com/contributor/project/pull/42",
	])("rejects malformed or inconsistent saved identity: %s", async (url) => {
		record.target.identity.pullRequest!.url = url;
		await expect(prepareRerun()).rejects.toThrow("selected pull request does not match");
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it("keeps raw metadata failures off remote preparation errors", async () => {
		vi.mocked(runGitHubCli).mockResolvedValue({
			ok: false,
			stdout: Buffer.alloc(0),
			stderr: SECRET,
			outputLimited: false,
			timedOut: false,
		});
		await expect(prepareRerun()).rejects.toMatchObject({
			message: "Could not load pull request metadata with GitHub CLI.",
		});
		expect(harness.eventsOfType("message_start")).toHaveLength(0);
	});

	it("keeps credential-bearing remote errors sanitized", async () => {
		git("remote", "set-url", "origin", "https://credential:private-token@github.com/contributor/project.git");
		await expect(prepareRerun()).rejects.toMatchObject({
			message:
				"The review remote is not a supported credential-free GitHub URL. Check its configuration on the host.",
		});
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it("preserves non-PR reruns and the branch locator guard", () => {
		delete record.target.identity.pullRequest;
		record.target.identity.kind = "uncommitted";
		expect(reviewTargetForRerun(record)).toEqual({ kind: "uncommitted" });
		record.target.identity.kind = "commit";
		record.target.identity.headCommit = HEAD;
		expect(reviewTargetForRerun(record)).toEqual({ kind: "commit", sha: HEAD });
		record.target.identity.kind = "branch";
		expect(() => reviewTargetForRerun(record)).toThrow("does not retain a base locator");
		record.target.branchBase = { kind: "remote", remote: "upstream", remoteRef: "refs/heads/main" };
		expect(reviewTargetForRerun(record)).toEqual({ kind: "branch", branchBase: record.target.branchBase });
	});
});
