import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GitHubCliResult, runGitHubCli } from "../../../src/core/code-host/github-cli.ts";
import { githubCliCodeHostProvider } from "../../../src/core/code-host/github-cli-provider.ts";
import type { ReviewPullRequestIdentity } from "../../../src/core/code-host/types.ts";
import { publishReviewRun } from "../../../src/core/review-publish.ts";
import type { ReviewRunRecord } from "../../../src/core/review-state.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

const HEAD = "b".repeat(40);
let harness: Harness;
let pullRequest: ReviewPullRequestIdentity;
let selectedHead: string;
let defaultHead: string;

function response(value: unknown): GitHubCliResult {
	return { ok: true, stdout: Buffer.from(JSON.stringify(value)), stderr: "", outputLimited: false, timedOut: false };
}

function publish() {
	const run: ReviewRunRecord = {
		schemaVersion: 1,
		runId: "review:pinned-publication",
		workflowAction: "review.pr",
		status: "completed",
		startedAt: 1,
		endedAt: 2,
		target: {
			description: "PR #4",
			diffCommand: `gh pr diff ${pullRequest.url}`,
			identity: { kind: "pr", baseTree: "base-tree", headTree: "head-tree", pullRequest },
			files: [],
		},
		options: { scope: [], effort: "standard", includeOptional: false, scopeMode: "full" },
		result: {
			completionStatus: "complete",
			summary: "No findings.",
			findings: [],
			coverage: {
				changedFileInventoryComplete: true,
				filesInspected: [],
				hunksInspected: [],
				commandsRun: [],
				failedVerificationAttempts: [],
				exclusions: [],
				uncheckedAreas: [],
				residualRisk: [],
				modelReportedLimitations: [],
			},
			overallCorrectness: "correct",
			overallExplanation: "No findings remain.",
		},
	};
	return publishReviewRun(harness.tempDir, run);
}

beforeEach(async () => {
	harness = await createHarness({ settings: { lsp: { enabled: false } } });
	pullRequest = {
		providerId: "github",
		number: 4,
		title: "Captured fork PR",
		body: "",
		url: "https://github.com/fork/project/pull/4",
		baseRefName: "main",
		headRefName: "feature",
		baseRefOid: "a".repeat(40),
		headRefOid: HEAD,
	};
	selectedHead = HEAD;
	defaultHead = HEAD;
	vi.mocked(runGitHubCli).mockReset();
	vi.mocked(runGitHubCli).mockImplementation(async (args) => {
		if (args[0] === "pr" && args[1] === "view") {
			return response({ headRefOid: args[2] === pullRequest.url ? selectedHead : defaultHead });
		}
		if (args[0] === "repo") return response({ nameWithOwner: "upstream/project" });
		if (args[0] === "api") return response({ id: 99 });
		throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
	});
});

afterEach(async () => {
	await harness.cleanupAsync();
	vi.restoreAllMocks();
});

describe("#411 pinned PR publication", () => {
	describe.each(["github.com", "github.enterprise.test"])("captured host %s", (hostname) => {
		it.each([HEAD, "c".repeat(40)])("ignores a default upstream PR with head %s", async (upstreamHead) => {
			defaultHead = upstreamHead;
			pullRequest.url = `https://${hostname}/Fork/Project/pull/4`;

			await expect(publish()).resolves.toMatchObject({ reviewId: 99 });

			const calls = vi.mocked(runGitHubCli).mock.calls;
			expect(calls).toHaveLength(2);
			expect(calls[0]![0]).toEqual(["pr", "view", pullRequest.url, "--json", "headRefOid"]);
			const [args, options] = calls[1]!;
			expect(args).toEqual([
				"api",
				"--method",
				"POST",
				"repos/fork/project/pulls/4/reviews",
				"--hostname",
				hostname,
				"--input",
				"-",
			]);
			expect(JSON.parse(options.input!)).toMatchObject({ commit_id: HEAD, event: "COMMENT", comments: [] });
		});
	});

	it("refuses a moved captured head even when the default upstream head still matches", async () => {
		selectedHead = "c".repeat(40);
		await expect(publish()).rejects.toThrow(/head moved/);
		expect(vi.mocked(runGitHubCli).mock.calls.map(([args]) => args)).toEqual([
			["pr", "view", pullRequest.url, "--json", "headRefOid"],
		]);
	});

	it.each([
		"not a URL",
		"https://github.com/fork/project/pull/5",
		"https://github.com/fork/project/pull/4?other=1",
		"https://credential:secret@github.com/fork/project/pull/4",
		"http://github.com/fork/project/pull/4",
	])("rejects invalid or inconsistent identity before verification or posting: %s", async (url) => {
		pullRequest.url = url;
		await expect(publish()).rejects.toThrow(/identity/);
		await expect(
			githubCliCodeHostProvider.publishPullRequestReview({
				cwd: harness.tempDir,
				pullRequest,
				body: "Review",
				comments: [],
			}),
		).rejects.toThrow(/identity/);
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it("rejects a different provider before verification or posting", async () => {
		pullRequest.providerId = "other-host";
		await expect(githubCliCodeHostProvider.verifyPullRequestHead(harness.tempDir, pullRequest)).rejects.toThrow(
			/cannot operate on code-host provider/,
		);
		await expect(
			githubCliCodeHostProvider.publishPullRequestReview({
				cwd: harness.tempDir,
				pullRequest,
				body: "Review",
				comments: [],
			}),
		).rejects.toThrow(/cannot operate on code-host provider/);
		expect(runGitHubCli).not.toHaveBeenCalled();
	});
});
