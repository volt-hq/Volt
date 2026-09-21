import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Compile } from "typebox/compile";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { githubCliCodeHostProvider, type ResolvedPullRequestCheckout } from "../../../src/core/code-host/index.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import {
	handleIrohRemotePrReviewRpcCommand,
	type IrohRemotePrReviewRpcBackend,
	PrReviewPreparationError,
} from "../../../src/core/remote/iroh/pr-review-rpc.ts";
import { createEmptyIrohRemoteHostState } from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { RpcErrorResponseSchema } from "../../../src/core/rpc/schema/responses.ts";
import { getDefaultSessionDirPath, SessionManager } from "../../../src/core/session-manager.ts";
import {
	PrReviewCheckoutError,
	PrReviewCheckoutManager,
	type PrReviewPreparationRequest,
} from "../../../src/daemon/pr-review-checkout.ts";
import { WorktreeManager } from "../../../src/daemon/worktree-manager.ts";
import { createHarness } from "../harness.ts";
import { createPrReviewGitSeed } from "../pr-review-git-fixture.ts";

let seed: ReturnType<typeof createPrReviewGitSeed>;
beforeAll(() => {
	seed = createPrReviewGitSeed("base\n", "PR head");
});
afterAll(() => seed?.dispose());
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
	const harness = await createHarness({ settings: { lsp: { enabled: false } } });
	cleanups.push(() => harness.cleanupAsync());
	const root = realpathSync(harness.tempDir);
	const source = join(root, "workspace");
	const remote = join(root, "remote.git");
	const { head } = seed.copyTo(source, remote);
	const workspace = { name: "project", path: source };
	const agentDir = join(root, "agent");
	const state = new IrohRemoteHostStateManager({
		initialState: { ...createEmptyIrohRemoteHostState(), workspaces: [workspace] },
	});
	const auditLogger = new IrohRemoteAuditLogger();
	cleanups.push(() => auditLogger.flush());
	const worktrees = new WorktreeManager({
		agentDir,
		stateManager: state,
		auditLogger,
		maxWorktreesPerWorkspace: 0,
	});
	const repository: ResolvedPullRequestCheckout["repository"] = {
		providerId: "github",
		host: "github.com",
		owner: "owner",
		name: "project",
		canonicalId: "github:github.com/owner/project",
	};
	const target: ResolvedPullRequestCheckout = {
		pullRequest: {
			provider: "github",
			url: "https://github.com/owner/project/pull/414",
			number: 414,
			title: "PR",
			repository: "owner/project",
			headRefName: "topic",
			headRefOid: head,
		},
		repository,
		headRepository: repository,
		remote: "origin",
		remoteUrl: remote,
		headRef: "refs/pull/414/head",
	};
	const manager = new PrReviewCheckoutManager({
		agentDir,
		stateManager: state,
		worktrees,
		hasActiveSession: () => false,
		provider: {
			...githubCliCodeHostProvider,
			resolvePullRequestCheckout: async () => ({ ok: true, target }),
		},
	});
	const request: PrReviewPreparationRequest = {
		sessionId: "review-426",
		number: "414",
		expectedPullRequest: { url: target.pullRequest.url, headRefOid: head },
	};
	const authority = { workspaceGeneration: 1, assertCurrent: () => {} };
	return { root, source, agentDir, workspace, state, worktrees, manager, request, authority };
}

describe("#426 PR review capacity errors", () => {
	it("preserves the real worktree capacity rejection without creating a checkout or session", async () => {
		const f = await fixture();
		const create = vi.spyOn(f.worktrees, "create");
		const preparation = f.manager.prepare(f.workspace, f.request, f.authority);
		await expect(preparation).rejects.toBeInstanceOf(PrReviewCheckoutError);
		await expect(preparation).rejects.toMatchObject({
			code: "worktree_limit_reached",
			message: "worktree_limit_reached",
		});
		expect(create).toHaveBeenCalledOnce();
		await expect(create.mock.results[0].value).resolves.toEqual({ ok: false, error: "worktree_limit_reached" });
		expect(await f.state.listWorktrees()).toEqual([]);
		expect(existsSync(join(f.agentDir, "worktrees"))).toBe(false);
		expect(await SessionManager.list(f.source, getDefaultSessionDirPath(f.source, f.agentDir))).toEqual([]);
	});

	it("keeps other worktree failures generic and excludes host diagnostics", async () => {
		const f = await fixture();
		vi.spyOn(f.worktrees, "create").mockResolvedValue({
			ok: false,
			error: "git_failed",
			detail: `${f.root}/private-checkout git stderr`,
		});
		await expect(f.manager.prepare(f.workspace, f.request, f.authority)).rejects.toMatchObject({
			code: "review_preparation_failed",
			message: "review_preparation_failed",
		});
		expect(await f.state.listWorktrees()).toEqual([]);
	});

	it.each([
		"worktree_limit_reached",
		"review_preparation_failed",
		"review_preparation_stale",
		"review_preparation_conflict",
	] as const)("serializes typed %s without diagnostic text", async (code) => {
		const command = {
			id: "prepare-426",
			type: "prepare_pr_review",
			workspaceName: "project",
			sessionId: "review-426",
			expectedPullRequest: { url: "https://github.com/owner/project/pull/414", headRefOid: "a".repeat(40) },
		};
		const backend: IrohRemotePrReviewRpcBackend = {
			resolvePrReview: vi.fn<IrohRemotePrReviewRpcBackend["resolvePrReview"]>(),
			preparePrReview: vi
				.fn<IrohRemotePrReviewRpcBackend["preparePrReview"]>()
				.mockRejectedValue(new PrReviewPreparationError(code, "/secret/checkout git stderr")),
		};
		const result = await handleIrohRemotePrReviewRpcCommand(command, {
			authorizedWorkspaceName: "project",
			backend,
		});
		expect(result).toEqual({
			handled: true,
			response: {
				id: command.id,
				type: "response",
				command: command.type,
				success: false,
				error: code,
				errorCode: code,
			},
		});
		if (!result.handled) throw new Error("PR review command was not handled");
		expect(Compile(RpcErrorResponseSchema).Check(result.response)).toBe(true);
	});
});
