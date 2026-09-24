import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GitHubCliResult, runGitHubCli } from "../../../src/core/code-host/github-cli.ts";
import { capturePullRequestContextWithGitHubCli } from "../../../src/core/code-host/github-cli-context.ts";
import { MAX_PULL_REQUEST_NUMBER, type ReviewTarget, resolveReviewTarget } from "../../../src/core/review.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

const FORK_URL = "https://github.com/contributor/project/pull/42";
const PARENT_URL = "https://github.com/parent/project/pull/42";
const HEAD = "b".repeat(40);
let harness: Harness;
let candidates: Array<Record<string, unknown>>;
let metadataUrl: string;

function git(...args: string[]): void {
	execFileSync("git", args, { cwd: harness.tempDir, stdio: "pipe" });
}

function response(value: unknown): GitHubCliResult {
	return { ok: true, stdout: Buffer.from(JSON.stringify(value)), stderr: "", outputLimited: false, timedOut: false };
}

function createPicker(onSelect?: () => void) {
	return {
		sessionManager: { getCwd: () => harness.tempDir },
		showExtensionSelector: vi.fn(async (_title: string, options: string[]) => {
			onSelect?.();
			return options.find((option) => option.startsWith("Current PR"));
		}),
	};
}

const promptForReviewTarget = Reflect.get(InteractiveMode.prototype, "promptForReviewTarget") as (
	this: ReturnType<typeof createPicker>,
) => Promise<ReviewTarget | undefined>;

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
	git("config", "remote.upstream.gh-resolved", "base");
	git("update-ref", "refs/remotes/origin/remote-topic", "HEAD");
	git("branch", "--set-upstream-to=origin/remote-topic");
	candidates = [
		{
			id: "PR_fork_42",
			number: 42,
			title: "Fork   change",
			url: FORK_URL,
			state: "OPEN",
			headRefName: "remote-topic",
			headRepository: { name: "project" },
			headRepositoryOwner: { login: "contributor" },
		},
	];
	metadataUrl = FORK_URL;
	vi.mocked(runGitHubCli).mockReset();
	vi.mocked(runGitHubCli).mockImplementation(async (args, options) => {
		if (args[0] === "pr" && args[1] === "list") {
			expect(args[args.indexOf("--repo") + 1]).toBe("github.com/contributor/project");
			expect(args[args.indexOf("--head") + 1]).toBe("remote-topic");
			return response(candidates);
		}
		if (args[0] === "pr" && args[1] === "view") {
			// Simulate gh preferring the parent when repository identity is omitted.
			if (args[2] === "--json") return response({ number: 42, title: "Parent change", url: PARENT_URL });
			expect(args[2]).toBe(FORK_URL);
			return response({ headRefOid: HEAD });
		}
		if (args[0] === "api" && args[1] === "graphql") {
			const request = JSON.parse(options.input!) as { query: string; variables: { id: string } };
			if (request.query.includes("query VoltReviewPullRequestMetadata(")) {
				expect(request.variables).toEqual({ owner: "contributor", name: "project", number: 42 });
				return response({
					data: {
						repository: {
							pullRequest: {
								id: "PR_fork_42",
								number: 42,
								title: "Fork change",
								body: "",
								url: metadataUrl,
								baseRefName: "main",
								headRefName: "remote-topic",
								baseRefOid: "a".repeat(40),
								headRefOid: HEAD,
							},
						},
					},
				});
			}
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
});

describe("#411 current-PR picker identity", () => {
	it("advertises and captures the fork's PR even when gh defaults to the parent's same-numbered PR", async () => {
		const picker = createPicker();
		const target = await promptForReviewTarget.call(picker);
		expect(picker.showExtensionSelector).toHaveBeenCalledWith(
			"Review what?",
			expect.arrayContaining(["Current PR #42 — Fork change"]),
		);
		expect(target).toEqual({ kind: "pr", number: "42", expectedUrl: FORK_URL });
		if (target?.kind !== "pr") throw new Error("Expected a selected PR");
		const captured = await capturePullRequestContextWithGitHubCli({
			...target,
			cwd: harness.tempDir,
			maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
		});
		expect(captured).toMatchObject({
			ok: true,
			pullRequest: { url: FORK_URL, number: 42, title: "Fork change" },
			fetchPlan: {
				remote: "origin",
				remoteUrl: "https://github.com/contributor/project.git",
				head: { remoteRef: "refs/pull/42/head" },
			},
		});
	});

	it.each(["no matching fork PR", "ambiguous fork PRs", "parent candidate", "missing tracking"])(
		"omits the current-PR entry for %s instead of falling back to gh inference",
		async (scenario) => {
			if (scenario === "no matching fork PR") candidates = [];
			if (scenario === "ambiguous fork PRs")
				candidates.push({ ...candidates[0], id: "PR_43", number: 43, url: FORK_URL.replace("42", "43") });
			if (scenario === "parent candidate") candidates[0]!.url = PARENT_URL;
			if (scenario === "missing tracking") git("branch", "--unset-upstream");
			const picker = createPicker();
			expect(await promptForReviewTarget.call(picker)).toBeUndefined();
			expect(picker.showExtensionSelector).toHaveBeenCalledWith("Review what?", [
				"Against base branch",
				"Uncommitted changes",
				"Pull request",
				"Specific commit",
			]);
			expect(vi.mocked(runGitHubCli).mock.calls.some(([args]) => args[1] === "view")).toBe(false);
		},
	);

	it.each(["remote URL", "tracking remote"])(
		"rejects a %s change while the picker is open through snapshot resolution",
		async (change) => {
			const picker = createPicker(() => {
				if (change === "remote URL") git("remote", "set-url", "origin", "https://github.com/other/project.git");
				else git("config", "branch.local-topic.remote", "upstream");
			});
			const target = await promptForReviewTarget.call(picker);
			if (!target) throw new Error("Expected a selected PR");
			vi.mocked(runGitHubCli).mockClear();
			expect(await resolveReviewTarget(target, harness.tempDir)).toMatchObject({
				error: expect.stringContaining("selected pull request does not match"),
			});
			expect(vi.mocked(runGitHubCli)).not.toHaveBeenCalled();
		},
	);

	it.each([
		PARENT_URL,
		"https://github.enterprise.test/contributor/project/pull/42",
		"https://github.com/contributor/project/pull/43",
		"https://credential:secret@github.com/contributor/project/pull/42",
		"not a URL",
		"",
	])("rejects mismatched or invalid selected identity before querying GitHub: %s", async (expectedUrl) => {
		const result = await capturePullRequestContextWithGitHubCli({
			cwd: harness.tempDir,
			number: "42",
			expectedUrl,
			maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
		});
		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining("selected pull request does not match"),
		});
		expect(JSON.stringify(result)).not.toContain("secret");
		expect(vi.mocked(runGitHubCli)).not.toHaveBeenCalled();
	});

	it("accepts canonical repository casing without changing the selected repository", async () => {
		expect(
			await capturePullRequestContextWithGitHubCli({
				cwd: harness.tempDir,
				number: "42",
				expectedUrl: "https://github.com/Contributor/Project/pull/42",
				maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
			}),
		).toMatchObject({ ok: true, pullRequest: { url: FORK_URL } });
	});

	it("still rejects metadata from the parent's same-numbered PR before discussion capture", async () => {
		const target = await promptForReviewTarget.call(createPicker());
		if (target?.kind !== "pr") throw new Error("Expected a selected PR");
		metadataUrl = PARENT_URL;
		expect(
			await capturePullRequestContextWithGitHubCli({
				...target,
				cwd: harness.tempDir,
				maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
			}),
		).toMatchObject({ ok: false, error: expect.stringContaining("identity could not be verified") });
		expect(vi.mocked(runGitHubCli).mock.calls.filter(([args]) => args[0] === "api")).toHaveLength(1);
	});
});
