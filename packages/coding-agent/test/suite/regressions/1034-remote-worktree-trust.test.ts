import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import { getWorktreeCheckoutPath, WorktreeManager } from "../../../src/daemon/worktree-manager.ts";
import { createIrohRemoteHostStateFixture } from "../../utilities/iroh-host-state.ts";

/**
 * #1034: the daemon decided a remote conversation's project trust from the
 * registered workspace, but the conversation loaded project resources from
 * its worktree checkout. A checkout carrying `.volt/extensions` that its
 * clean parent lacks (a fetched pull request head, say) ran them without any
 * trust decision. Resources are now looked for where they load from; the
 * decision stays the workspace's.
 */
describe("#1034 remote worktree conversations look for resources that need trust in their checkout", () => {
	let root: string;
	let agentDir: string;
	let workspace: IrohRemoteWorkspace;
	let checkout: string;
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
		stateManager = new IrohRemoteHostStateManager({
			initialState: createIrohRemoteHostStateFixture({ workspaces: [workspace], worktrees: [worktree] }),
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
});
