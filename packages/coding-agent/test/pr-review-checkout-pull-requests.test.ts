import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { azureDevOpsCodeHostProvider } from "../src/core/code-host/azure-devops-provider.ts";
import {
	type CodeHostOpenPullRequestListResult,
	type CodeHostProvider,
	type CodeHostPullRequestDiscoveryUnavailableReason,
	githubCliCodeHostProvider,
} from "../src/core/code-host/index.ts";
import { IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import { PullRequestListError } from "../src/core/remote/iroh/pr-review-rpc.ts";
import { createEmptyIrohRemoteHostState } from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { PrReviewCheckoutManager } from "../src/daemon/pr-review-checkout.ts";
import { WorktreeManager } from "../src/daemon/worktree-manager.ts";
import { createPrReviewGitSeed } from "./suite/pr-review-git-fixture.ts";

let gitSeed: ReturnType<typeof createPrReviewGitSeed>;
beforeAll(() => {
	gitSeed = createPrReviewGitSeed("base\n", "head");
});
afterAll(() => gitSeed?.dispose());

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const listed: CodeHostOpenPullRequestListResult = {
	ok: true,
	repository: "owner/project",
	pullRequests: [
		{
			number: 414,
			title: "Isolated PR review",
			url: "https://github.com/owner/project/pull/414",
			headRefName: "topic",
			isDraft: false,
			author: "octocat",
			updatedAt: 1_795_168_800_000,
		},
	],
	truncated: true,
};

/** A registered workspace on the PR review seed; `provider` replaces remote-based provider selection. */
function fixture(provider?: CodeHostProvider) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "volt-pr-list-")));
	const source = join(root, "workspace");
	gitSeed.copyTo(source, join(root, "remote.git"));
	const workspace = { name: "project", path: source };
	const stateManager = new IrohRemoteHostStateManager({
		initialState: {
			...createEmptyIrohRemoteHostState(),
			workspaces: [workspace],
			workspaceGenerationCounter: 1,
			workspaceGenerations: [{ workspaceName: workspace.name, generation: 1 }],
		},
	});
	const audit = new IrohRemoteAuditLogger({ path: join(root, "audit.jsonl") });
	const agentDir = join(root, "agent");
	const manager = new PrReviewCheckoutManager({
		agentDir,
		stateManager,
		worktrees: new WorktreeManager({ agentDir, stateManager, auditLogger: audit }),
		...(provider === undefined ? {} : { provider }),
		hasActiveSession: () => false,
	});
	let active = true;
	const controller = new AbortController();
	const authority = {
		workspaceGeneration: 1,
		signal: controller.signal,
		assertCurrent: () => {
			if (!active) throw new Error("revoked");
		},
	};
	cleanups.push(async () => {
		await audit.flush();
		rmSync(root, { recursive: true, force: true });
	});
	return {
		source,
		workspace,
		manager,
		authority,
		revoke: () => {
			active = false;
		},
	};
}

function listingProvider(listOpenPullRequests: NonNullable<CodeHostProvider["listOpenPullRequests"]>) {
	return { ...githubCliCodeHostProvider, listOpenPullRequests: vi.fn(listOpenPullRequests) };
}

/** The code a failed listing throws. */
async function failureCode(listing: Promise<unknown>): Promise<string> {
	const error = await listing.then(
		() => undefined,
		(thrown: unknown) => thrown,
	);
	expect(error).toBeInstanceOf(PullRequestListError);
	return (error as PullRequestListError).code;
}

describe("PrReviewCheckoutManager.listPullRequests", () => {
	it("lists through the provider and remote a numbered review resolves with, bounded to the protocol limit", async () => {
		const f = fixture();
		execFileSync("git", ["remote", "add", "origin", "https://github.com/Owner/Project.git"], { cwd: f.source });
		const listing = vi
			.spyOn(githubCliCodeHostProvider as Required<CodeHostProvider>, "listOpenPullRequests")
			.mockResolvedValue(listed);

		const answer = await f.manager.listPullRequests(f.workspace, {}, f.authority);

		expect(answer).toEqual({
			workspaceName: "project",
			provider: "github",
			repository: "owner/project",
			pullRequests: listed.ok ? listed.pullRequests : [],
			truncated: true,
		});
		expect(listing).toHaveBeenCalledExactlyOnceWith({ cwd: f.source, limit: 50, signal: f.authority.signal });
	});

	it("answers unsupported when no remote names a repository a provider lists", async () => {
		const f = fixture();
		expect(await failureCode(f.manager.listPullRequests(f.workspace, {}, f.authority))).toBe(
			"pull_request_list_unsupported",
		);
	});

	it("answers unsupported for a provider that cannot list pull requests", async () => {
		const f = fixture(azureDevOpsCodeHostProvider);
		expect(await failureCode(f.manager.listPullRequests(f.workspace, {}, f.authority))).toBe(
			"pull_request_list_unsupported",
		);
	});

	it.each([
		["not_authenticated", "pull_request_list_not_authenticated"],
		["unsupported_repository", "pull_request_list_unsupported"],
		["repository_ambiguous", "pull_request_list_unsupported"],
		["rate_limited", "pull_request_list_failed"],
		["network", "pull_request_list_failed"],
		["timeout", "pull_request_list_failed"],
		["output_limited", "pull_request_list_failed"],
		["invalid_response", "pull_request_list_failed"],
		["provider_error", "pull_request_list_failed"],
		["cancelled", "pull_request_list_failed"],
	] satisfies Array<[CodeHostPullRequestDiscoveryUnavailableReason, string]>)(
		"maps the provider's %s to %s",
		async (reason, code) => {
			const f = fixture(listingProvider(async () => ({ ok: false, reason })));
			expect(await failureCode(f.manager.listPullRequests(f.workspace, {}, f.authority))).toBe(code);
		},
	);

	it("answers failed when the provider throws, without its message", async () => {
		const f = fixture(
			listingProvider(async () => {
				throw new Error("gh stderr with /private/path");
			}),
		);
		const error = await f.manager.listPullRequests(f.workspace, {}, f.authority).catch((thrown: unknown) => thrown);
		expect(error).toBeInstanceOf(PullRequestListError);
		expect((error as Error).message).toBe("pull_request_list_failed");
	});

	it.each([
		{ sourceWorktreeId: "missing" },
		{ workingDirectory: "missing/folder" },
		{ workingDirectory: "../outside" },
	])("answers failed for an unusable source %j without listing", async (request) => {
		const provider = listingProvider(async () => listed);
		const f = fixture(provider);
		expect(await failureCode(f.manager.listPullRequests(f.workspace, request, f.authority))).toBe(
			"pull_request_list_failed",
		);
		expect(provider.listOpenPullRequests).not.toHaveBeenCalled();
	});

	it("checks its authority before listing and before answering", async () => {
		const before = listingProvider(async () => listed);
		const revokedFirst = fixture(before);
		revokedFirst.revoke();
		await expect(
			revokedFirst.manager.listPullRequests(revokedFirst.workspace, {}, revokedFirst.authority),
		).rejects.toThrow("revoked");
		expect(before.listOpenPullRequests).not.toHaveBeenCalled();

		let revokeDuringListing = (): void => {};
		const during = fixture(
			listingProvider(async () => {
				revokeDuringListing();
				return listed;
			}),
		);
		revokeDuringListing = during.revoke;
		await expect(during.manager.listPullRequests(during.workspace, {}, during.authority)).rejects.toThrow("revoked");
	});
});
