import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { RejectedFrameSchema } from "@hansjm10/volt-protocol";
import { Compile } from "typebox/compile";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { githubCliCodeHostProvider, type ResolvedPullRequestCheckout } from "../../../src/core/code-host/index.ts";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import { serveIrohRemoteConnection } from "../../../src/core/remote/iroh/connection.ts";
import {
	type IrohRemotePrReviewRpcBackend,
	PrReviewPreparationError,
} from "../../../src/core/remote/iroh/pr-review-rpc.ts";
import { createEmptyIrohRemoteHostState } from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { getDefaultSessionDirPath, SessionManager } from "../../../src/core/session-manager.ts";
import {
	PrReviewCheckoutError,
	PrReviewCheckoutManager,
	type PrReviewPreparationRequest,
} from "../../../src/daemon/pr-review-checkout.ts";
import {
	type RemoteIntentHost,
	type RemoteStreamScope,
	remoteIntentServices,
	remoteStreamAllows,
} from "../../../src/daemon/remote-intents.ts";
import { WorkspaceSessions } from "../../../src/daemon/workspace-sessions.ts";
import { WorktreeManager } from "../../../src/daemon/worktree-manager.ts";
import { createIrohStreamPair } from "../../utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "../../utilities/remote-phone.ts";
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

/** A device's worktree management stream, as the daemon serves it, with `prReviews` as the daemon's PR review backend. */
async function managementStream(
	f: Awaited<ReturnType<typeof fixture>>,
	prReviews: IrohRemotePrReviewRpcBackend,
): Promise<RemotePhone> {
	const access = createIrohRemotePresetAccess("full");
	const authorization: IrohRemoteClientAuthorizationSuccess = {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "phone",
			label: "phone",
			allowedWorkspaces: [f.workspace.name],
			rpcGrant: access.rpcGrant,
			pairedAt: 1,
			lastSeenAt: 1,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: f.workspace,
		workspaceNames: [f.workspace.name],
		workspaces: [{ name: f.workspace.name, status: "available" }],
	};
	const unexpected = (): never => {
		throw new Error("unexpected backend");
	};
	const auditLogger = new IrohRemoteAuditLogger();
	cleanups.push(() => auditLogger.flush());
	const host: RemoteIntentHost = {
		agentDir: f.agentDir,
		workspaceSessions: new WorkspaceSessions({
			agentDir: f.agentDir,
			workspaces: () => [],
			worktrees: async () => [],
		}),
		auditLogger,
		stateManager: f.state,
		pushTargets: unexpected,
		worktrees: unexpected,
		agentOptions: unexpected,
		sessionContexts: unexpected,
		prReviews: () => prReviews,
		unregisterWorkspace: unexpected,
	};
	const scope: RemoteStreamScope = { kind: "management", purpose: "manage_worktrees" };
	const allows = remoteStreamAllows(scope);
	const pair = createIrohStreamPair();
	const connection = serveIrohRemoteConnection({
		stream: pair.host,
		grant: access.rpcGrant,
		redaction: { workspacePath: f.workspace.path, remoteWorkspacePath: "/workspace" },
		services: () => remoteIntentServices(host, authorization, scope, { keep: {} }),
		...(allows === undefined ? {} : { allows }),
	});
	const device = connectRemotePhone(pair.phone);
	cleanups.push(async () => {
		await connection.close().catch(() => undefined);
		await device.close();
	});
	await device.hello();
	return device;
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
		expect(await SessionManager.list(f.source, getDefaultSessionDirPath(f.agentDir))).toEqual([]);
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
	] as const)("answers typed %s without diagnostic text", async (code) => {
		const f = await fixture();
		const backend: IrohRemotePrReviewRpcBackend = {
			resolvePrReview: vi.fn<IrohRemotePrReviewRpcBackend["resolvePrReview"]>(),
			preparePrReview: vi
				.fn<IrohRemotePrReviewRpcBackend["preparePrReview"]>()
				.mockRejectedValue(new PrReviewPreparationError(code, `${f.root}/secret/checkout git stderr`)),
		};
		const device = await managementStream(f, backend);
		const outcome = await device.intent(
			"prepare_pr_review",
			{
				sessionId: "review-426",
				expectedPullRequest: { url: "https://github.com/owner/project/pull/414", headRefOid: "a".repeat(40) },
			},
			{ expectedOrdinal: null },
		);
		expect(outcome).toEqual({
			type: "rejected",
			intentId: outcome.intentId,
			reason: { code: "failed", message: code },
		});
		expect(Compile(RejectedFrameSchema).Check(outcome)).toBe(true);
		expect(backend.preparePrReview).toHaveBeenCalledOnce();
		const wire = JSON.stringify(device.frames);
		expect(wire).not.toContain("secret");
		expect(wire).not.toContain("stderr");
	});
});
