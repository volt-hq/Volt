/**
 * #985: the `/review` picker offers the current branch's pull request from
 * the daemon's change association, without asking the code host, for any
 * provider (Azure DevOps included). It does so only while the conversation is
 * on the linked change's branch and a numbered review would resolve the same
 * repository; otherwise it probes the code host as before. A review started
 * with the offered URL resolves the same pull request.
 */

import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import type { IntentOption } from "@hansjm10/volt-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopbackClient } from "../../../src/client/protocol-client.ts";
import { type GitHubCliResult, runGitHubCli } from "../../../src/core/code-host/github-cli.ts";
import { capturePullRequestIdentityWithGitHubCli } from "../../../src/core/code-host/github-cli-context.ts";
import { findCodeHostIdentity, parseCodeHostPullRequestUrl } from "../../../src/core/code-host/identity.ts";
import type { CodeHostLinkedPullRequest } from "../../../src/core/code-host/types.ts";
import { localProfile } from "../../../src/core/protocol/profiles.ts";
import { serveConnection } from "../../../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../../../src/core/protocol/transport/loopback-transport.ts";
import { MAX_PULL_REQUEST_NUMBER } from "../../../src/core/review.ts";
import { createHostHarness, type HostHarness } from "../host-harness.ts";

vi.mock("../../../src/core/code-host/github-cli.ts", () => ({ runGitHubCli: vi.fn() }));

const FORK_URL = "https://github.com/contributor/project/pull/42";
const AZURE_REMOTE = "https://fabrikam@dev.azure.com/fabrikam/Fabrikam%20Fiber/_git/Fiber";
const AZURE_URL = "https://dev.azure.com/fabrikam/fabrikam%20fiber/_git/fiber/pullrequest/5";
const HEAD = "b".repeat(40);
let harness: HostHarness;
let client: LoopbackClient;
let linked: CodeHostLinkedPullRequest | undefined;
let linkReads: number;

function git(...args: string[]): void {
	execFileSync("git", args, { cwd: harness.tempDir, stdio: "pipe" });
}

function response(value: unknown): GitHubCliResult {
	return { ok: true, stdout: Buffer.from(JSON.stringify(value)), stderr: "", outputLimited: false, timedOut: false };
}

function linkedPullRequest(overrides: Partial<CodeHostLinkedPullRequest> = {}): CodeHostLinkedPullRequest {
	return {
		provider: "github",
		repository: { host: "github.com", path: "contributor/project" },
		number: 42,
		title: "Linked   change",
		branch: "local-topic",
		...overrides,
	};
}

async function completion(field: "url" | "number"): Promise<IntentOption | undefined> {
	const { completions } = await client.query("intent_completions", { intent: "review", field });
	return completions[0];
}

function probed(): boolean {
	return vi.mocked(runGitHubCli).mock.calls.some(([args]) => args[0] === "pr" && args[1] === "list");
}

beforeEach(async () => {
	harness = await createHostHarness({ globalSettings: { lsp: { enabled: false } } });
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
	linked = linkedPullRequest();
	linkReads = 0;
	vi.mocked(runGitHubCli).mockReset();
	vi.mocked(runGitHubCli).mockImplementation(async (args) => {
		if (args[0] === "pr" && args[1] === "list") {
			return response([
				{
					id: "PR_fork_42",
					number: 42,
					title: "Probed change",
					url: FORK_URL,
					state: "OPEN",
					headRefName: "remote-topic",
					headRepository: { name: "project" },
					headRepositoryOwner: { login: "contributor" },
				},
			]);
		}
		if (args[0] === "pr" && args[1] === "view") {
			expect(args[2]).toBe(FORK_URL);
			return response({ headRefOid: HEAD });
		}
		if (args[0] === "api" && args[1] === "graphql") {
			return response({
				data: {
					repository: {
						pullRequest: {
							id: "PR_fork_42",
							number: 42,
							title: "Linked change",
							body: "",
							url: FORK_URL,
							baseRefName: "main",
							headRefName: "remote-topic",
							baseRefOid: "a".repeat(40),
							headRefOid: HEAD,
						},
					},
				},
			});
		}
		throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
	});
	const conversation = await harness.openStartup();
	await conversation.session.gitContextProvider.refresh();
	// Served as a daemon worker serves a TUI: with the daemon's answer for the conversation's linked pull request.
	const pair = createLoopbackRpcTransportPair();
	const connection = serveConnection(pair.server, localProfile, {
		host: harness.host,
		conversation,
		services: () => ({
			changePullRequest: async () => {
				linkReads++;
				return linked;
			},
		}),
	});
	client = new LoopbackClient({}, connection.closed);
	await client.connect(pair.client);
	await connection.ready;
});

afterEach(async () => {
	await client.stop();
	await harness.cleanup();
	vi.restoreAllMocks();
});

describe("#985 current-PR picker from the daemon's change association", () => {
	it("offers the linked pull request without asking the code host, and a review of its URL resolves it", async () => {
		const offered = await completion("url");
		expect(offered).toEqual({ value: FORK_URL, label: "#42 — Linked change", description: "Current branch" });
		expect(await completion("number")).toEqual({
			value: "42",
			label: "#42 Linked change",
			description: "Current branch",
		});
		expect(runGitHubCli).not.toHaveBeenCalled();
		expect(linkReads).toBe(1);

		await expect(
			capturePullRequestIdentityWithGitHubCli({
				cwd: harness.tempDir,
				number: "42",
				expectedUrl: offered?.value,
				maxPullRequestNumber: MAX_PULL_REQUEST_NUMBER,
			}),
		).resolves.toMatchObject({ ok: true, pullRequest: { url: FORK_URL, number: 42 } });
	});

	it("offers an Azure DevOps pull request by its web URL", async () => {
		git("remote", "set-url", "origin", AZURE_REMOTE);
		linked = linkedPullRequest({
			provider: "azure-devops",
			repository: { host: "dev.azure.com", path: "fabrikam/fabrikam fiber/fiber" },
			number: 5,
		});
		expect(await completion("url")).toEqual({
			value: AZURE_URL,
			label: "#5 — Linked change",
			description: "Current branch",
		});
		expect(runGitHubCli).not.toHaveBeenCalled();
	});

	it.each([
		["no linked pull request", undefined],
		["a link to another branch", linkedPullRequest({ branch: "other-topic" })],
		// The fork's tracking remote selects the fork, so a numbered review would not resolve the parent's PR.
		[
			"a link to the parent repository",
			linkedPullRequest({ repository: { host: "github.com", path: "parent/project" } }),
		],
		["a link from another provider", linkedPullRequest({ provider: "gitlab" })],
		["a number out of range", linkedPullRequest({ number: MAX_PULL_REQUEST_NUMBER + 1 })],
	])("probes the code host for %s", async (_label, link) => {
		linked = link;
		expect(await completion("url")).toEqual({
			value: FORK_URL,
			label: "#42 — Probed change",
			description: "Current branch",
		});
		expect(probed()).toBe(true);
	});
});

describe("#985 pull request URLs from a linked repository", () => {
	it("builds each provider's URL as its own parser reads it back", () => {
		const github = findCodeHostIdentity("github");
		expect(github?.pullRequestUrl({ host: "github.com", path: "contributor/project" }, 42)).toBe(FORK_URL);
		expect(github?.pullRequestUrl({ host: "github.com", path: "contributor/project/extra" }, 42)).toBeUndefined();
		expect(github?.pullRequestUrl({ host: "github.com/evil", path: "contributor/project" }, 42)).toBeUndefined();

		const azure = findCodeHostIdentity("azure-devops");
		const url = azure?.pullRequestUrl({ host: "dev.azure.com", path: "fabrikam/fabrikam fiber/fiber" }, 5);
		expect(url).toBe(AZURE_URL);
		expect(parseCodeHostPullRequestUrl(AZURE_URL)).toEqual({ url: AZURE_URL, number: 5 });
		expect(azure?.pullRequestUrl({ host: "github.com", path: "fabrikam/fabrikam fiber/fiber" }, 5)).toBeUndefined();
		expect(azure?.pullRequestUrl({ host: "dev.azure.com", path: "fabrikam/fiber" }, 5)).toBeUndefined();
	});
});
