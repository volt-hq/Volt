import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { azureDevOpsCodeHostProvider } from "../src/core/code-host/azure-devops-provider.ts";
import * as azureRemote from "../src/core/code-host/azure-devops-remote.ts";
import { canonicalizeGitHubRemoteUrl } from "../src/core/code-host/github-cli-discovery.ts";
import { findCodeHostIdentity, parseCodeHostPullRequestUrl } from "../src/core/code-host/identity.ts";
import { type ReviewPullRequestIdentity, resolveCodeHostProvider } from "../src/core/code-host/index.ts";
import { probeCurrentBranchPullRequest } from "../src/core/review.ts";
import { resolveReviewSnapshot } from "../src/core/review-snapshot.ts";

const AZURE_REMOTE_URL = "https://fabrikam@dev.azure.com/fabrikam/Fabrikam%20Fiber/_git/Fiber";
const PULL_REQUEST_URL = "https://dev.azure.com/fabrikam/Fabrikam%20Fiber/_git/Fiber/pullrequest/5";
const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const REPOSITORY_ID = "66666666-7777-8888-9999-000000000000";
const CANONICAL_ID = "azure-devops:dev.azure.com/fabrikam/fabrikam fiber/fiber";
const CREDENTIAL_VARIABLES = ["VOLT_ADO_PAT", "AZURE_DEVOPS_EXT_PAT", "PATH"] as const;

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture {
	root: string;
	repository: string;
	remoteUrl: string;
	baseOid: string;
	headOid: string;
}

function createFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "volt-azure-devops-"));
	const remote = join(root, "remote.git");
	mkdirSync(remote);
	git(remote, "init", "--bare", "--initial-branch=main");
	const repository = join(root, "work");
	mkdirSync(repository);
	git(repository, "init", "--initial-branch=main");
	git(repository, "config", "user.email", "review@example.test");
	git(repository, "config", "user.name", "Review Test");
	git(repository, "config", "commit.gpgsign", "false");
	writeFileSync(join(repository, "value.txt"), "base\n");
	git(repository, "add", "value.txt");
	git(repository, "commit", "-m", "base");
	git(repository, "remote", "add", "origin", remote);
	git(repository, "push", "origin", "main");
	const baseOid = git(repository, "rev-parse", "HEAD");
	git(repository, "checkout", "-b", "topic");
	writeFileSync(join(repository, "value.txt"), "head\n");
	git(repository, "commit", "-am", "head");
	git(repository, "push", "-u", "origin", "topic");
	const headOid = git(repository, "rev-parse", "HEAD");
	return { root, repository, remoteUrl: git(repository, "remote", "get-url", "origin"), baseOid, headOid };
}

const repositoryJson = { id: REPOSITORY_ID, name: "Fiber", project: { id: PROJECT_ID, name: "Fabrikam Fiber" } };

function pullRequestJson(fixture: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		pullRequestId: 5,
		codeReviewId: 5,
		status: "active",
		isDraft: false,
		title: "Change value",
		description: "Sets the value to head.",
		sourceRefName: "refs/heads/topic",
		targetRefName: "refs/heads/main",
		mergeStatus: "conflicts",
		createdBy: { displayName: "Pat Author", uniqueName: "author@fabrikam.test" },
		lastMergeSourceCommit: { commitId: fixture.headOid },
		lastMergeTargetCommit: { commitId: fixture.baseOid },
		repository: repositoryJson,
		...overrides,
	};
}

interface FakeAzureDevOps {
	pullRequest: Record<string, unknown>;
	/** The source commit reported after the first metadata read. */
	laterHeadOid?: string;
	pullRequests?: unknown[];
	threads?: unknown[];
	statuses?: unknown[];
	evaluations?: unknown[];
	workItemReferences?: unknown[];
	workItems?: unknown[];
	workItemComments?: Record<string, unknown[]>;
}

interface RecordedRequest {
	url: URL;
	authorization: string | null;
}

function installFakeAzureDevOps(state: FakeAzureDevOps): RecordedRequest[] {
	const requests: RecordedRequest[] = [];
	let pullRequestReads = 0;
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
		const json = (body: unknown, status = 200): Response =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json; charset=utf-8; api-version=7.1" },
			});
		const path = decodeURIComponent(url.pathname).toLowerCase();
		const byName = "/fabrikam/fabrikam fiber/_apis/git/repositories/fiber/pullrequests";
		const byId = `/fabrikam/${PROJECT_ID}/_apis/git/repositories/${REPOSITORY_ID}/pullrequests/5`;
		if (path === byName) return json({ value: state.pullRequests ?? [] });
		if (path === `${byName}/5`) {
			pullRequestReads++;
			return json(
				pullRequestReads > 1 && state.laterHeadOid
					? { ...state.pullRequest, lastMergeSourceCommit: { commitId: state.laterHeadOid } }
					: state.pullRequest,
			);
		}
		if (path === `${byId}/statuses`) return json({ value: state.statuses ?? [] });
		if (path === `${byId}/threads`) return json({ value: state.threads ?? [] });
		if (path === `${byId}/workitems`) return json({ value: state.workItemReferences ?? [] });
		if (path === `/fabrikam/${PROJECT_ID}/_apis/policy/evaluations`) return json({ value: state.evaluations ?? [] });
		if (path === "/fabrikam/_apis/wit/workitems") return json({ value: state.workItems ?? [] });
		const comments = /^\/fabrikam\/fabrikam fiber\/_apis\/wit\/workitems\/(\d+)\/comments$/.exec(path);
		if (comments?.[1]) return json({ comments: state.workItemComments?.[comments[1]] ?? [] });
		return json({ message: `No fixture for ${path}` }, 404);
	});
	return requests;
}

function installAzureCli(directory: string, source: string): string {
	const bin = join(directory, "bin");
	mkdirSync(bin, { recursive: true });
	const script = join(bin, "fake-az.mjs");
	writeFileSync(script, source);
	if (process.platform === "win32") {
		writeFileSync(
			join(bin, "az.cmd"),
			`@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit /b %errorlevel%\r\n`,
		);
	} else {
		const executable = join(bin, "az");
		writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
		chmodSync(executable, 0o755);
	}
	return bin;
}

const MAX_PULL_REQUEST_NUMBER = 2_147_483_647;

describe("Azure DevOps code-host provider", () => {
	let fixture: Fixture;
	const saved = new Map<string, string | undefined>();

	beforeEach(() => {
		fixture = createFixture();
		for (const variable of CREDENTIAL_VARIABLES) saved.set(variable, process.env[variable]);
		process.env.VOLT_ADO_PAT = "test-pat";
		// Model the local transport fixture as its Azure DevOps repository; remote selection and fetch use it.
		const canonicalize = azureRemote.canonicalizeAzureDevOpsRemoteUrl;
		vi.spyOn(azureRemote, "canonicalizeAzureDevOpsRemoteUrl").mockImplementation((value) =>
			canonicalize(value === fixture.remoteUrl ? AZURE_REMOTE_URL : value),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		for (const [variable, value] of saved) {
			if (value === undefined) delete process.env[variable];
			else process.env[variable] = value;
		}
		rmSync(fixture.root, { recursive: true, force: true });
	});

	it("recognizes Azure DevOps remote forms that GitHub does not claim", () => {
		vi.restoreAllMocks();
		for (const remote of [
			"https://dev.azure.com/fabrikam/Fabrikam%20Fiber/_git/Fiber",
			AZURE_REMOTE_URL,
			"git@ssh.dev.azure.com:v3/fabrikam/Fabrikam%20Fiber/Fiber",
			"ssh://git@ssh.dev.azure.com/v3/fabrikam/Fabrikam%20Fiber/Fiber",
			"https://fabrikam.visualstudio.com/Fabrikam%20Fiber/_git/Fiber",
			"https://fabrikam.visualstudio.com/DefaultCollection/Fabrikam%20Fiber/_git/Fiber",
			"fabrikam@vs-ssh.visualstudio.com:v3/fabrikam/Fabrikam%20Fiber/Fiber",
		]) {
			expect(azureRemote.canonicalizeAzureDevOpsRemoteUrl(remote)?.canonicalId, remote).toBe(CANONICAL_ID);
			expect(canonicalizeGitHubRemoteUrl(remote), remote).toBeNull();
		}
		for (const remote of [
			"https://fabrikam:secret@dev.azure.com/fabrikam/Fabrikam%20Fiber/_git/Fiber",
			"https://someone@dev.azure.com/fabrikam/Fabrikam%20Fiber/_git/Fiber",
			"http://dev.azure.com/fabrikam/Fabrikam%20Fiber/_git/Fiber",
			"https://dev.azure.com/fabrikam/Fabrikam%20Fiber/_git/Fiber?x=1",
			"https://dev.azure.com/fabrikam/_git/Fiber",
			"https://dev.azure.com/-fabrikam/Fabrikam%20Fiber/_git/Fiber",
			"https://dev.azure.com/fabrikam/Fabrikam%2FFiber/_git/Fiber",
			"git@ssh.dev.azure.com:v2/fabrikam/Fabrikam%20Fiber/Fiber",
			"https://github.com/fabrikam/fiber",
			"git@github.com:fabrikam/fiber.git",
		]) {
			expect(azureRemote.canonicalizeAzureDevOpsRemoteUrl(remote), remote).toBeNull();
		}
		expect(parseCodeHostPullRequestUrl(PULL_REQUEST_URL)).toEqual({ url: PULL_REQUEST_URL, number: 5 });
		expect(parseCodeHostPullRequestUrl("https://github.com/fabrikam/fiber/pull/3")).toMatchObject({ number: 3 });
		for (const url of [
			`${PULL_REQUEST_URL}?_a=files`,
			PULL_REQUEST_URL.replace("/5", "/0"),
			PULL_REQUEST_URL.replace("https:", "http:"),
		]) {
			expect(parseCodeHostPullRequestUrl(url), url).toBeUndefined();
		}
		expect(findCodeHostIdentity("azure-devops")?.isCanonicalPullRequestCheckout).toBe(
			azureDevOpsCodeHostProvider.isCanonicalPullRequestCheckout,
		);
	});

	it("captures a numbered pull request's work items, discussion, checks, and source-branch snapshot", async () => {
		const author = { displayName: "Rae Viewer", uniqueName: "reviewer@fabrikam.test" };
		const requests = installFakeAzureDevOps({
			pullRequest: pullRequestJson(fixture),
			statuses: [
				{ id: 1, state: "pending", context: { genre: "ci", name: "build" } },
				{ id: 2, state: "succeeded", context: { genre: "ci", name: "build" } },
			],
			evaluations: [
				{ status: "running", configuration: { isEnabled: true } },
				{ status: "rejected", configuration: { isEnabled: false } },
			],
			threads: [
				{
					id: 2,
					status: "active",
					threadContext: {
						filePath: "/value.txt",
						rightFileStart: { line: 1, offset: 1 },
						rightFileEnd: { line: 1, offset: 5 },
					},
					comments: [
						{ id: 2, parentCommentId: 1, content: "It is the new value.", commentType: "text", author },
						{ id: 1, parentCommentId: 0, content: "Why head?", commentType: "text", author },
					],
				},
				{
					id: 1,
					status: "fixed",
					threadContext: null,
					comments: [{ id: 1, parentCommentId: 0, content: "Looks right.", commentType: "text", author }],
				},
				{
					id: 3,
					status: "active",
					comments: [{ id: 1, content: "Rae Viewer voted 10", commentType: "system", author }],
				},
				{
					id: 4,
					isDeleted: true,
					comments: [{ id: 1, content: "Deleted thread", commentType: "text", author }],
				},
			],
			workItemReferences: [{ id: "42" }],
			workItems: [
				{
					id: 42,
					fields: {
						"System.Title": "Value is wrong",
						"System.Description": "<p>It should be head.</p>",
						"System.State": "Active",
						"System.Reason": "New",
						"System.TeamProject": "Fabrikam Fiber",
						"System.CreatedBy": { displayName: "Pm", uniqueName: "pm@fabrikam.test" },
					},
				},
			],
			workItemComments: { "42": [{ id: 9, text: "Confirmed.", createdBy: author }] },
		});

		const snapshot = await resolveReviewSnapshot({ kind: "pr", number: "5" }, fixture.repository, {
			maxCommitRefBytes: 1_024,
			maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
		});
		if ("error" in snapshot) throw new Error(snapshot.error);
		try {
			expect(snapshot.identity).toMatchObject({ baseCommit: fixture.baseOid, headCommit: fixture.headOid });
			expect(snapshot.identity.pullRequest).toEqual({
				providerId: "azure-devops",
				number: 5,
				title: "Change value",
				body: "Sets the value to head.",
				url: PULL_REQUEST_URL,
				baseRefName: "main",
				headRefName: "topic",
				baseRefOid: fixture.baseOid,
				headRefOid: fixture.headOid,
				author: { login: "author@fabrikam.test" },
				reviewState: "ready",
				mergeability: "conflicting",
				checks: {
					state: "pending",
					totalCount: 2,
					passedCount: 1,
					pendingCount: 1,
					failedCount: 0,
					neutralCount: 0,
					unknownCount: 0,
				},
				observedAt: expect.any(Number),
			});
			expect(snapshot.diffCommand).toBe(`git diff ${fixture.baseOid}...${fixture.headOid}`);
			expect(snapshot.changedFiles.map((file) => file.path)).toEqual(["value.txt"]);

			const context = snapshot.codeHostContext;
			expect(context?.manifest).toMatchObject({
				status: "complete",
				linkedIssueCount: 1,
				discussionEntryCount: 4,
				limitations: [],
			});
			expect(context?.linkedIssues).toEqual([
				expect.objectContaining({
					id: "42",
					repository: "Fabrikam Fiber",
					number: 42,
					title: "Value is wrong",
					body: "<p>It should be head.</p>",
					url: "https://dev.azure.com/fabrikam/Fabrikam%20Fiber/_workitems/edit/42",
					state: "Active",
					relationship: "manual",
				}),
			]);
			expect(context?.discussionEntries.map((entry) => [entry.kind, entry.id, entry.replyToId])).toEqual([
				["pr-comment", "thread/1/comment/1", undefined],
				["review-thread-comment", "thread/2/comment/1", undefined],
				["review-thread-comment", "thread/2/comment/2", "thread/2/comment/1"],
				["linked-issue-comment", "workitem/42/comment/9", undefined],
			]);
			expect(context?.discussionEntries[0]?.thread).toMatchObject({ id: "1", isResolved: true });
			expect(context?.discussionEntries[1]?.thread).toMatchObject({
				id: "2",
				isResolved: false,
				path: "value.txt",
				line: 1,
				diffSide: "RIGHT",
			});
			expect(context?.rendered).toMatch(/^# Azure DevOps pull request context\n/);
			expect(context?.rendered).not.toContain("voted");
			expect(context?.rendered).not.toContain("Deleted thread");
		} finally {
			await snapshot.dispose();
		}
		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) {
			expect(request.url.host).toBe("dev.azure.com");
			expect(request.authorization).toBe(`Basic ${Buffer.from(":test-pat").toString("base64")}`);
		}
	});

	it("resolves the current branch's active pull request through the registry", async () => {
		installFakeAzureDevOps({
			pullRequest: pullRequestJson(fixture),
			pullRequests: [
				{
					pullRequestId: 3,
					status: "abandoned",
					title: "Earlier attempt",
					sourceRefName: "refs/heads/topic",
					repository: repositoryJson,
				},
				{
					pullRequestId: 5,
					status: "active",
					title: "Change value",
					sourceRefName: "refs/heads/topic",
					repository: repositoryJson,
				},
				{
					pullRequestId: 7,
					status: "active",
					title: "From a fork",
					sourceRefName: "refs/heads/topic",
					forkSource: { repository: { id: "fork" } },
					repository: repositoryJson,
				},
			],
		});
		const resolved = await resolveCodeHostProvider({ cwd: fixture.repository });
		expect(resolved.ok && resolved.provider).toBe(azureDevOpsCodeHostProvider);
		await expect(probeCurrentBranchPullRequest(fixture.repository)).resolves.toEqual({
			number: 5,
			title: "Change value",
			url: PULL_REQUEST_URL,
		});
		const captured = await azureDevOpsCodeHostProvider.capturePullRequestIdentity({
			cwd: fixture.repository,
			expectedUrl: PULL_REQUEST_URL,
			maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
		});
		expect(captured).toMatchObject({
			ok: true,
			pullRequest: { number: 5, headRefName: "topic", headRefOid: fixture.headOid },
			fetchPlan: {
				remote: "origin",
				remoteUrl: fixture.remoteUrl,
				base: { remoteRef: "refs/heads/main" },
				head: { remoteRef: "refs/heads/topic" },
			},
		});
	});

	it("refuses fork pull requests, a mismatched selection, and a head that moved during capture", async () => {
		const capture = (expectedUrl?: string) =>
			azureDevOpsCodeHostProvider.capturePullRequestIdentity({
				cwd: fixture.repository,
				number: "5",
				...(expectedUrl === undefined ? {} : { expectedUrl }),
				maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
			});
		installFakeAzureDevOps({ pullRequest: pullRequestJson(fixture, { forkSource: { repository: { id: "fork" } } }) });
		await expect(capture()).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("Pull requests from Azure DevOps forks are not supported yet"),
		});

		vi.mocked(globalThis.fetch).mockRestore();
		installFakeAzureDevOps({ pullRequest: pullRequestJson(fixture) });
		await expect(capture(PULL_REQUEST_URL.replace("/5", "/6"))).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("does not match the resolved review target"),
		});

		vi.mocked(globalThis.fetch).mockRestore();
		installFakeAzureDevOps({ pullRequest: pullRequestJson(fixture), laterHeadOid: "c".repeat(40) });
		await expect(capture()).resolves.toMatchObject({
			ok: false,
			error: "The pull request moved while Volt captured its Azure DevOps context. Retry the review.",
		});
	});

	it("verifies the head without a CLI and does not publish or check out yet", async () => {
		const state: FakeAzureDevOps = { pullRequest: pullRequestJson(fixture) };
		installFakeAzureDevOps(state);
		const identity: ReviewPullRequestIdentity = {
			providerId: "azure-devops",
			number: 5,
			title: "Change value",
			body: "",
			url: PULL_REQUEST_URL,
			baseRefName: "main",
			headRefName: "topic",
			baseRefOid: fixture.baseOid,
			headRefOid: fixture.headOid,
		};
		await expect(azureDevOpsCodeHostProvider.verifyPullRequestHead(fixture.repository, identity)).resolves.toBe(
			undefined,
		);
		await expect(
			azureDevOpsCodeHostProvider.verifyPullRequestHead(fixture.repository, identity, { command: ["az"] }),
		).rejects.toThrow("no CLI command applies");
		state.pullRequest = pullRequestJson(fixture, { lastMergeSourceCommit: { commitId: "d".repeat(40) } });
		await expect(azureDevOpsCodeHostProvider.verifyPullRequestHead(fixture.repository, identity)).rejects.toThrow(
			"The pull request head moved after this review was captured.",
		);
		await expect(
			azureDevOpsCodeHostProvider.publishPullRequestReview({
				cwd: fixture.repository,
				pullRequest: identity,
				body: "Review",
				comments: [],
			}),
		).rejects.toThrow("Publishing reviews to Azure DevOps is not supported yet");
		await expect(
			azureDevOpsCodeHostProvider.resolvePullRequestCheckout({
				cwd: fixture.repository,
				number: "5",
				maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
			}),
		).resolves.toMatchObject({ ok: false, error: expect.stringContaining("not supported for Azure DevOps") });
	});

	it("falls back to the Azure CLI account's token when no personal access token is set", async () => {
		delete process.env.VOLT_ADO_PAT;
		delete process.env.AZURE_DEVOPS_EXT_PAT;
		const requests = installFakeAzureDevOps({ pullRequest: pullRequestJson(fixture) });
		const log = join(fixture.root, "az-args.json");
		const bin = installAzureCli(fixture.root, "process.exit(1);\n");
		process.env.PATH = `${bin}${delimiter}${saved.get("PATH") ?? ""}`;
		const capture = () =>
			azureDevOpsCodeHostProvider.capturePullRequestIdentity({
				cwd: fixture.repository,
				number: "5",
				maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
			});
		await expect(capture()).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("No Azure DevOps credentials are available on the host"),
		});
		expect(requests).toHaveLength(0);

		installAzureCli(
			fixture.root,
			`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ accessToken: "cli-token", expires_on: Math.floor(Date.now() / 1000) + 3600 }));
`,
		);
		await expect(capture()).resolves.toMatchObject({ ok: true, pullRequest: { number: 5 } });
		expect(JSON.parse(readFileSync(log, "utf8"))).toEqual(
			expect.arrayContaining(["account", "get-access-token", "--resource", "499b84ac-1321-427f-aa17-267ca6975798"]),
		);
		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) expect(request.authorization).toBe("Bearer cli-token");
	});
});
