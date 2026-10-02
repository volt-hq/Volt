import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GitHubCliResult, runGitHubCli } from "../../../src/core/code-host/github-cli.ts";
import { githubCliCodeHostProvider } from "../../../src/core/code-host/github-cli-provider.ts";
import { type ReviewSnapshot, type ReviewTarget, resolveReviewSnapshot } from "../../../src/core/review-snapshot.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("../../../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

const OPTIONS = { maxCommitRefBytes: 1_024, maxPullRequestNumber: 2_147_483_647 };
const PR_URL = "https://github.com/volt-hq/selected/pull/4";
const REMOTE_URL = "git@github.com:volt-hq/selected.git";
let harness: Harness;
let selected: string;
let other: string;
let baseOid: string;
let headOid: string;
let otherOid: string;
let view: Record<string, unknown>;
const snapshots: ReviewSnapshot[] = [];

function git(...args: string[]): string {
	return execFileSync("git", args, {
		cwd: harness.tempDir,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

function response(value: unknown): GitHubCliResult {
	return { ok: true, stdout: Buffer.from(JSON.stringify(value)), stderr: "", outputLimited: false, timedOut: false };
}

beforeEach(async () => {
	harness = await createHarness({ settings: { lsp: { enabled: false } } });
	vi.stubEnv("GIT_SSH_COMMAND", undefined);
	vi.stubEnv("GIT_SSH", undefined);
	git("init", "--initial-branch=main");
	git("config", "user.name", "Review Test");
	git("config", "user.email", "review@example.test");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(harness.tempDir, "tracked.txt"), "base\n");
	git("add", "tracked.txt");
	git("commit", "-m", "base");
	baseOid = git("rev-parse", "HEAD");
	git("checkout", "-b", "feature");
	writeFileSync(join(harness.tempDir, "tracked.txt"), "selected PR\n");
	git("commit", "-am", "selected PR");
	headOid = git("rev-parse", "HEAD");

	selected = join(harness.tempDir, "selected.git");
	other = join(harness.tempDir, "other.git");
	for (const remote of [selected, other]) {
		mkdirSync(remote);
		git("init", "--bare", "--initial-branch=main", remote);
	}
	git("push", selected, "main", "feature", "HEAD:refs/pull/4/head");
	git("checkout", "-b", "other", "main");
	writeFileSync(join(harness.tempDir, "tracked.txt"), "unrelated PR\n");
	git("commit", "-am", "unrelated PR");
	otherOid = git("rev-parse", "HEAD");
	git("push", other, "HEAD:refs/heads/main", "HEAD:refs/pull/4/head");
	git("checkout", "feature");
	git("remote", "add", "fork", REMOTE_URL);

	// Only SSH and GitHub API transport are faked: real selection, capture, Git fetch,
	// object verification and snapshot reads run without network access or inference.
	const ssh = join(harness.tempDir, "ssh.mjs");
	writeFileSync(
		ssh,
		`import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
if (args.at(-2) !== "git@github.com" || args.at(-1) !== "fixture-upload-pack 'volt-hq/selected.git'") {
  throw new Error("Unexpected SSH target or lost remote-specific uploadpack: " + JSON.stringify(args));
}
appendFileSync(${JSON.stringify(join(harness.tempDir, "ssh.log"))}, JSON.stringify(args) + "\\n");
const result = spawnSync("git", ["upload-pack", ${JSON.stringify(selected)}], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
`,
	);
	git("config", "core.sshCommand", `"${process.execPath.replaceAll("\\", "/")}" "${ssh.replaceAll("\\", "/")}"`);
	git("config", "ssh.variant", "simple");
	git("config", "remote.fork.uploadpack", "fixture-upload-pack");
	git("update-ref", "refs/remotes/fork/feature", headOid);
	view = {
		id: "PR_4",
		number: 4,
		title: "Selected PR",
		body: "Body",
		url: PR_URL,
		baseRefName: "main",
		headRefName: "feature",
		baseRefOid: baseOid,
		headRefOid: headOid,
		state: "OPEN",
		headRepository: { name: "selected" },
		headRepositoryOwner: { login: "volt-hq" },
	};
	vi.mocked(runGitHubCli).mockReset();
	vi.mocked(runGitHubCli).mockImplementation(async (args, options) => {
		if (args[0] === "pr" && args[1] === "list") {
			expect(args[args.indexOf("--repo") + 1]).toBe("github.com/volt-hq/selected");
			expect(args[args.indexOf("--head") + 1]).toBe("feature");
			return response([view]);
		}
		if (args[0] === "pr" && args[1] === "view") {
			expect(args[2]).toBe(PR_URL);
			return response({ headRefOid: view.headRefOid });
		}
		if (args[0] === "api" && args[1] === "graphql") {
			expect(args[args.indexOf("--hostname") + 1]).toBe("github.com");
			const { query, variables } = JSON.parse(options.input!) as { query: string; variables: unknown };
			if (query.includes("query VoltReviewPullRequestMetadata(")) {
				expect(variables).toEqual({ owner: "volt-hq", name: "selected", number: 4 });
				return response({ data: { repository: { pullRequest: view } } });
			}
			const field = query.includes("closingIssuesReferences")
				? "closingIssuesReferences"
				: query.includes("reviewThreads")
					? "reviewThreads"
					: query.includes("reviews(first")
						? "reviews"
						: "comments";
			return response({ data: { node: { [field]: { nodes: [], pageInfo: { hasNextPage: false } } } } });
		}
		throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
	});
});

afterEach(async () => {
	for (const snapshot of snapshots.splice(0)) await snapshot.dispose();
	await harness.cleanupAsync();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

async function assertSelectedSnapshot(target: ReviewTarget, onProgress?: (message: string) => void) {
	const refsBefore = git("show-ref");
	const headBefore = git("rev-parse", "HEAD");
	const result = await resolveReviewSnapshot(target, harness.tempDir, { ...OPTIONS, onProgress });
	if ("error" in result) throw new Error(result.error);
	snapshots.push(result);
	expect(result.identity).toMatchObject({ baseCommit: baseOid, headCommit: headOid, pullRequest: { url: PR_URL } });
	for (const [side, content] of [
		["base", "base\n"],
		["head", "selected PR\n"],
	] as const) {
		const file = await result.readFile(side, "tracked.txt");
		if (!file?.available) throw new Error(`Missing ${side} snapshot file`);
		expect(file.content.toString()).toBe(content);
	}
	expect(result.changedFiles.map((file) => file.path)).toEqual(["tracked.txt"]);
	expect(result.diffCommand).toBe(`gh pr diff ${PR_URL}`);
	expect(JSON.stringify(result.identity)).not.toContain(REMOTE_URL);
	expect(JSON.stringify(result.identity)).not.toContain("fetchPlan");
	expect(result.codeHostContext?.rendered).not.toContain(REMOTE_URL);
	expect(readFileSync(join(harness.tempDir, "ssh.log"), "utf8")).toContain("fixture-upload-pack");
	expect(git("show-ref")).toBe(refsBefore);
	expect(git("rev-parse", "HEAD")).toBe(headBefore);
	expect(existsSync(join(harness.tempDir, ".git", "FETCH_HEAD"))).toBe(false);
}

describe("#411 selected PR repository snapshot transport", () => {
	it("captures the selected transport and PR refs together without persisting transport in identity", async () => {
		const captured = await githubCliCodeHostProvider.capturePullRequestContext({
			cwd: harness.tempDir,
			number: "4",
			...OPTIONS,
		});
		if (!captured.ok) throw new Error(captured.error);
		expect(captured.fetchPlan).toEqual({
			remote: "fork",
			remoteUrl: REMOTE_URL,
			base: { remoteRef: "refs/heads/main", localRef: "refs/review/base" },
			head: { remoteRef: "refs/pull/4/head", localRef: "refs/review/head" },
			diffCommand: `gh pr diff ${PR_URL}`,
		});
		expect(captured.pullRequest).not.toHaveProperty("remote");
		expect(captured.pullRequest).not.toHaveProperty("remoteUrl");
	});

	it("fetches a numbered PR from a sole non-origin remote without tracking", async () => {
		await assertSelectedSnapshot({ kind: "pr", number: "4" });
	});

	it.each(["4", undefined])(
		"fetches the tracked repository despite conflicting origin refs (number: %s)",
		async (number) => {
			git("remote", "add", "origin", other);
			git("branch", "--set-upstream-to", "fork/feature");
			await assertSelectedSnapshot({ kind: "pr", number });
		},
	);

	it("keeps the selected fetch URL when tracking and remote configuration change after capture", async () => {
		git("remote", "add", "origin", other);
		git("branch", "--set-upstream-to", "fork/feature");
		await assertSelectedSnapshot({ kind: "pr", number: "4" }, (message) => {
			if (message !== "Fetching pull request history…") return;
			git("config", "branch.feature.remote", "origin");
			git("remote", "set-url", "fork", other);
		});
	});

	it("still rejects a fetched head that differs from captured metadata", async () => {
		view.headRefOid = otherOid;
		await expect(resolveReviewSnapshot({ kind: "pr", number: "4" }, harness.tempDir, OPTIONS)).resolves.toMatchObject(
			{
				error: "The pull request moved while Volt captured it. Retry the review.",
			},
		);
	});

	it("does not fall back to origin when the selected repository lacks the PR ref", async () => {
		git("remote", "add", "origin", other);
		git("push", "--force", "origin", "main", "HEAD:refs/pull/4/head");
		git("branch", "--set-upstream-to", "fork/feature");
		git("--git-dir", selected, "update-ref", "-d", "refs/pull/4/head");
		await expect(resolveReviewSnapshot({ kind: "pr", number: "4" }, harness.tempDir, OPTIONS)).resolves.toMatchObject(
			{
				remoteError: "Could not fetch the exact pull request snapshot.",
			},
		);
	});
});
