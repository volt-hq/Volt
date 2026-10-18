import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHello } from "../../../src/core/remote/iroh/handshake.ts";
import type { IrohRemoteWorkspace, IrohRemoteWorkspaceWorktree } from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { getDefaultSessionDir, SessionManager } from "../../../src/core/session-manager.ts";
import { SQLiteSessionStoreClient } from "../../../src/core/session-store/index.ts";
import { type ConversationOpenServices, resolveConversationOpen } from "../../../src/daemon/conversation-open.ts";
import { WorkspaceSessions } from "../../../src/daemon/workspace-sessions.ts";
import { getWorktreeCheckoutPath, WorktreeManager } from "../../../src/daemon/worktree-manager.ts";
import { createIrohRemoteHostStateFixture } from "../../utilities/iroh-host-state.ts";

const TOOL_POLICY = { tools: ["read"], allowUnlistedExtensionTools: false };

function sessionHello(sessionId: string): IrohRemoteHello {
	return {
		type: "volt_iroh_hello",
		protocol: "volt/1",
		workspace: "ws",
		mode: "conversation",
		conversation: { target: "session", sessionId },
	} as unknown as IrohRemoteHello;
}

/**
 * #934: a phone's conversation open read the whole session (twice, in a
 * workspace with managed worktrees) only for its cwd, and every daemon store
 * lookup started a store worker of its own. The daemon reads summaries; the
 * worker that hosts the conversation loads it.
 */
describe("#934 daemon conversation opens read session summaries", () => {
	let root: string;
	let agentDir: string;
	let sessionDir: string;
	let workspace: IrohRemoteWorkspace;
	let worktreePath: string;
	let stateManager: IrohRemoteHostStateManager;
	let worktrees: WorktreeManager;
	const owned: WorkspaceSessions[] = [];

	beforeEach(() => {
		root = realpathSync.native(mkdtempSync(join(tmpdir(), "volt-934-")));
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		sessionDir = getDefaultSessionDir(agentDir);
		workspace = { name: "ws", path: join(root, "repo") };
		mkdirSync(join(workspace.path, "packages", "app"), { recursive: true });
		worktreePath = getWorktreeCheckoutPath(agentDir, workspace.path, "fix-login");
		mkdirSync(join(worktreePath, "src"), { recursive: true });
		const worktree: IrohRemoteWorkspaceWorktree = {
			id: "fix-login",
			workspaceName: "ws",
			path: worktreePath,
			branch: "volt/fix-login",
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
		vi.restoreAllMocks();
		for (const sessions of owned.splice(0)) await sessions.close();
		await rm(root, { recursive: true, force: true });
	});

	function workspaceSessions(retainStore = false): WorkspaceSessions {
		const sessions = new WorkspaceSessions({
			agentDir,
			workspaces: () => [workspace],
			worktrees: () => stateManager.listWorktrees(),
			retainStore,
		});
		owned.push(sessions);
		return sessions;
	}

	/** The daemon's open services, as `IrohDaemonService` wires them. */
	function services(): ConversationOpenServices {
		return {
			workspaceSessions: workspaceSessions(),
			toolPolicy: () => TOOL_POLICY,
			projectTrusted: () => true,
			resolveWorktree: async (name, _hello, id, placement) =>
				id === undefined ? undefined : worktrees.resolveSessionWorktree(name, id, { placement }),
			resolveWorkingDirectory: async ({ workspace, worktree, workingDirectory }) => {
				const result = worktree
					? await worktrees.resolveWorktreeWorkingDirectory(workspace, worktree, workingDirectory)
					: await worktrees.validateWorkingDirectory(workspace, workingDirectory);
				if (!result.ok) throw new Error(result.error);
				return result.directory;
			},
			prepareWorktreeRuntime: (name, id, sessionId) => worktrees.beginRuntimePreparation(name, id, sessionId),
			preparePrReviewSession: async () => undefined,
			bindWorktreeSession: (name, id, sessionId) => worktrees.bindSession(name, id, sessionId),
		};
	}

	async function storeSession(sessionId: string, cwd: string): Promise<void> {
		const manager = await SessionManager.create(cwd, sessionDir, { id: sessionId });
		await manager.closePersistence();
	}

	function authorization(): IrohRemoteClientAuthorizationSuccess {
		return {
			ok: true,
			allowTools: "read",
			client: {
				nodeId: "n-phone",
				label: "phone",
				allowedWorkspaces: ["ws"],
				allowedTools: "read",
				rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
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

	it("resumes an unbound workspace session without loading it or placing it in a worktree", async () => {
		await storeSession("s-root", join(workspace.path, "packages", "app"));
		const loadSession = vi.spyOn(SQLiteSessionStoreClient.prototype, "loadSession");

		const opened = await resolveConversationOpen(sessionHello("s-root"), authorization(), services());

		expect(opened.selection).toEqual({ kind: "resumed", requestedSessionId: "s-root", sessionId: "s-root" });
		expect(opened.worktree).toBeUndefined();
		expect(opened.workingDirectory).toBe("packages/app");
		expect(await opened.prepare(1)).toMatchObject({
			session: { sessionId: "s-root", sessionDirectory: sessionDir },
			cwd: join(workspace.path, "packages", "app"),
			root: workspace.path,
		});
		expect((await stateManager.listWorktrees("ws"))[0]?.sessionIds).toEqual([]);
		expect(loadSession).not.toHaveBeenCalled();
	});

	it("places an unbound session inside a checkout in its worktree and heals the binding, without loading it", async () => {
		await storeSession("s-checkout", join(worktreePath, "src"));
		const loadSession = vi.spyOn(SQLiteSessionStoreClient.prototype, "loadSession");

		const opened = await resolveConversationOpen(sessionHello("s-checkout"), authorization(), services());

		expect(opened.selection).toMatchObject({ kind: "resumed", sessionId: "s-checkout" });
		expect(opened.worktree?.id).toBe("fix-login");
		expect(opened.workingDirectory).toBe("src");
		expect((await stateManager.listWorktrees("ws"))[0]?.sessionIds).toEqual(["s-checkout"]);
		expect(loadSession).not.toHaveBeenCalled();
	});

	it("serves a retaining instance's lookups from one store worker, replaced once after it fails", async () => {
		const sessions = workspaceSessions(true);
		const open = vi.spyOn(SQLiteSessionStoreClient, "open");
		// No store yet: nothing is opened, or created.
		expect(await sessions.locate("s-a")).toBeUndefined();
		expect(open).not.toHaveBeenCalled();

		await storeSession("s-a", workspace.path);
		open.mockClear();
		await Promise.all([sessions.find("ws", "s-a"), sessions.locate("s-a"), sessions.list("ws")]);
		expect((await sessions.owned("ws", ["s-a"])).has("s-a")).toBe(true);
		expect(open).toHaveBeenCalledTimes(1);

		// The held store worker fails: the next lookup opens one replacement that later lookups reuse.
		const held = await open.mock.results[0]!.value;
		await held.close();
		expect((await sessions.find("ws", "s-a"))?.id).toBe("s-a");
		expect(await sessions.locate("s-a")).toMatchObject({ id: "s-a" });
		await sessions.list("ws");
		expect(open).toHaveBeenCalledTimes(2);

		// Closed: the lease is released, and each lookup opens the store again.
		await sessions.close();
		await sessions.locate("s-a");
		await sessions.locate("s-a");
		expect(open).toHaveBeenCalledTimes(4);
	});
});
