import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PrReviewLaunch } from "../../../src/core/pr-review-placement.ts";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHello } from "../../../src/core/remote/iroh/handshake.ts";
import { resolveIrohRemoteWorkspaceProjectTrusted } from "../../../src/core/remote/iroh/host-policy.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { ProjectTrustStore } from "../../../src/core/trust-manager.ts";
import { type ConversationOpenServices, resolveConversationOpen } from "../../../src/daemon/conversation-open.ts";
import { WorkspaceSessions } from "../../../src/daemon/workspace-sessions.ts";
import {
	getConversationProjectRoot,
	getWorktreeCheckoutPath,
	WorktreeManager,
} from "../../../src/daemon/worktree-manager.ts";
import { createIrohRemoteHostStateFixture } from "../../utilities/iroh-host-state.ts";

/**
 * #1034: the daemon decided a remote conversation's project trust from the
 * registered workspace, but the conversation loaded project resources from
 * its worktree checkout. A checkout carrying `.volt/extensions` that its
 * clean parent lacks (a fetched pull request head, say) ran them without any
 * trust decision. Resources are now looked for where they load from; the
 * decision stays the workspace's.
 *
 * A checkout that holds a pull request review holds content its author
 * controls, so a trusted workspace would still have run a fork's project
 * extensions there. Its conversations now load project resources from the
 * same repository in the workspace instead, never from the review's head.
 */
describe("#1034 remote worktree conversations take project trust and resources from where they load", () => {
	let root: string;
	let agentDir: string;
	let workspace: IrohRemoteWorkspace;
	let checkout: string;
	let reviewCheckout: string;
	let stateManager: IrohRemoteHostStateManager;
	let worktrees: WorktreeManager;
	const owned: WorkspaceSessions[] = [];

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-1034-")));
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		// The parent checkout holds nothing that needs trust, and no decision was made for it.
		workspace = { name: "ws", path: join(root, "repo") };
		mkdirSync(join(workspace.path, "src"), { recursive: true });
		checkout = getWorktreeCheckoutPath(agentDir, workspace.path, "pr-head");
		mkdirSync(join(checkout, ".volt", "extensions"), { recursive: true });
		writeFileSync(join(checkout, ".volt", "extensions", "payload.ts"), "export default () => {};\n");
		const worktree: IrohRemoteWorkspaceWorktree = {
			id: "pr-head",
			workspaceName: "ws",
			path: checkout,
			branch: "volt/pr-head",
			createdAt: 1,
			sessionIds: [],
		};
		// A prepared pull request review: the fork's head carries project extensions of its own.
		reviewCheckout = getWorktreeCheckoutPath(agentDir, workspace.path, "review");
		mkdirSync(join(reviewCheckout, ".volt", "extensions"), { recursive: true });
		writeFileSync(join(reviewCheckout, ".volt", "extensions", "payload.ts"), "export default () => {};\n");
		const review: IrohRemoteWorkspaceWorktree = {
			id: "review",
			workspaceName: "ws",
			path: reviewCheckout,
			branch: "volt/review",
			createdAt: 1,
			sessionIds: ["review-session"],
			prReviewLaunches: [reviewLaunch(reviewCheckout)],
		};
		stateManager = new IrohRemoteHostStateManager({
			initialState: createIrohRemoteHostStateFixture({ workspaces: [workspace], worktrees: [worktree, review] }),
		});
		worktrees = new WorktreeManager({
			agentDir,
			stateManager,
			auditLogger: new IrohRemoteAuditLogger(),
			flushState: async () => {},
		});
	});

	afterEach(async () => {
		for (const sessions of owned.splice(0)) await sessions.close();
		await rm(root, { recursive: true, force: true });
	});

	/** The receipt of a pull request review prepared in `cwd` and bound to its session. */
	function reviewLaunch(cwd: string): PrReviewLaunch {
		return {
			sessionId: "review-session",
			requestFingerprint: "a".repeat(64),
			disposition: "created",
			sessionGeneration: "generation-1",
			storeId: "store-1",
			placement: {
				workspaceName: "ws",
				workspaceGeneration: 1,
				worktreeId: "review",
				cwd,
				sourceCwd: workspace.path,
				commonDirectory: join(workspace.path, ".git"),
				pullRequest: {
					provider: "github",
					url: "https://github.com/owner/repo/pull/7",
					number: 7,
					title: "Fork change",
					repository: "owner/repo",
					headRefName: "topic",
					headRefOid: "b".repeat(40),
				},
				repositoryId: "github:github.com/owner/repo",
				headRepositoryId: "github:github.com/contributor/repo",
				remote: "origin",
			},
		};
	}

	function trusted(resourcesRoot: string): boolean {
		return resolveIrohRemoteWorkspaceProjectTrusted(workspace, {
			resourcesRoot,
			trustStore: new ProjectTrustStore(agentDir),
		});
	}

	/** The daemon's open services, with project trust as `IrohDaemonService` wires it. */
	function services(): ConversationOpenServices {
		const sessions = new WorkspaceSessions({
			agentDir,
			workspaces: () => [workspace],
			worktrees: () => stateManager.listWorktrees(),
		});
		owned.push(sessions);
		return {
			workspaceSessions: sessions,
			toolPolicy: () => ({ tools: [], allowUnlistedExtensionTools: false }),
			projectTrusted: (openWorkspace, resourcesRoot) =>
				resolveIrohRemoteWorkspaceProjectTrusted(openWorkspace, {
					resourcesRoot,
					trustStore: new ProjectTrustStore(agentDir),
				}),
			resolveWorktree: async (name, hello) =>
				hello.mode === "conversation" && hello.conversation.target === "new" && hello.conversation.worktreeId
					? worktrees.findWorktree(name, hello.conversation.worktreeId)
					: undefined,
			resolveWorkingDirectory: async ({ workspace: openWorkspace, worktree, workingDirectory }) => {
				const result = worktree
					? await worktrees.resolveWorktreeWorkingDirectory(openWorkspace, worktree, workingDirectory)
					: await worktrees.validateWorkingDirectory(openWorkspace, workingDirectory);
				if (!result.ok) throw new Error(result.error);
				return result.directory;
			},
			prepareWorktreeRuntime: (name, id, sessionId) => worktrees.beginRuntimePreparation(name, id, sessionId),
			preparePrReviewSession: async () => undefined,
			bindWorktreeSession: (name, id, sessionId) => worktrees.bindSession(name, id, sessionId),
		};
	}

	function authorization(): IrohRemoteClientAuthorizationSuccess {
		return {
			ok: true,
			allowTools: "",
			client: {
				nodeId: "n-phone",
				label: "phone",
				allowedWorkspaces: ["ws"],
				allowedTools: "",
				rpcGrant: createIrohRemotePresetAccess("chat").rpcGrant,
				pairedAt: 1,
				lastSeenAt: 2,
			},
			paired: false,
			pairingSecretConsumed: false,
			workspace,
			workspaceGeneration: 1,
			workspaceNames: ["ws"],
			workspaces: [{ name: "ws", status: "available" }],
		};
	}

	function newConversationHello(worktreeId?: string): IrohRemoteHello {
		return {
			type: "volt_iroh_hello",
			protocol: "volt/1",
			workspace: "ws",
			mode: "conversation",
			conversation: { target: "new", ...(worktreeId === undefined ? {} : { worktreeId }) },
		} as unknown as IrohRemoteHello;
	}

	it("does not trust a checkout that holds resources needing trust when its workspace was never trusted", () => {
		expect(trusted(workspace.path)).toBe(true);
		expect(trusted(checkout)).toBe(false);
	});

	it("trusts the checkout as decided for its workspace", () => {
		new ProjectTrustStore(agentDir).set(workspace.path, true);
		expect(trusted(checkout)).toBe(true);
		new ProjectTrustStore(agentDir).set(workspace.path, false);
		expect(trusted(checkout)).toBe(false);
	});

	it("opens a phone conversation in the checkout untrusted, and one in the clean workspace trusted", async () => {
		const inCheckout = await resolveConversationOpen(newConversationHello("pr-head"), authorization(), services());
		expect(inCheckout.worktree?.id).toBe("pr-head");
		expect(inCheckout.compatibility.projectTrusted).toBe(false);

		const inWorkspace = await resolveConversationOpen(newConversationHello(), authorization(), services());
		expect(inWorkspace.worktree).toBeUndefined();
		expect(inWorkspace.compatibility.projectTrusted).toBe(true);
	});

	it("opens a pull request review's conversation with the trusted workspace's project resources, not the head's", async () => {
		mkdirSync(join(workspace.path, ".volt", "extensions"), { recursive: true });
		writeFileSync(join(workspace.path, ".volt", "extensions", "own.ts"), "export default () => {};\n");
		new ProjectTrustStore(agentDir).set(workspace.path, true);

		const inReview = await resolveConversationOpen(newConversationHello("review"), authorization(), services());
		expect(inReview.worktree?.id).toBe("review");
		expect(inReview.compatibility.projectTrusted).toBe(true);
		// It works in the review's checkout and loads its project resources from the workspace.
		expect(await inReview.prepare(1)).toMatchObject({
			cwd: reviewCheckout,
			root: reviewCheckout,
			projectCwd: workspace.path,
			projectTrusted: true,
		});

		// A checkout that never held a review keeps loading its own.
		const inCheckout = await resolveConversationOpen(newConversationHello("pr-head"), authorization(), services());
		expect(await inCheckout.prepare(1)).toMatchObject({ cwd: checkout, root: checkout, projectCwd: checkout });
	});

	it("trusts a pull request review as its workspace's own resources need", async () => {
		const reviewTrusted = async () =>
			(await resolveConversationOpen(newConversationHello("review"), authorization(), services())).compatibility
				.projectTrusted;
		// The head's extensions do not load, so they need no trust; nothing in the workspace does either.
		expect(await reviewTrusted()).toBe(true);

		mkdirSync(join(workspace.path, ".volt", "skills"), { recursive: true });
		expect(await reviewTrusted()).toBe(false);
		new ProjectTrustStore(agentDir).set(workspace.path, true);
		expect(await reviewTrusted()).toBe(true);
	});

	it("loads a nested repository's review from that repository in the workspace", () => {
		const review = {
			path: reviewCheckout,
			sourceRootRelativePath: "apps/web",
			prReviewLaunches: [reviewLaunch(reviewCheckout)],
		};
		expect(getConversationProjectRoot(workspace, review)).toBe(join(workspace.path, "apps", "web"));
		expect(getConversationProjectRoot(workspace, { ...review, prReviewLaunches: undefined })).toBe(reviewCheckout);
		expect(getConversationProjectRoot(workspace, undefined)).toBe(workspace.path);
	});
});
