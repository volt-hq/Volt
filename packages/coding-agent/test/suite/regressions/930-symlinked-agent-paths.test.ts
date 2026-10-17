/**
 * #930: with the agent directory reached through a symlink, a phone keeps the
 * working directory of a session in a managed worktree, and every path under
 * the worktrees root is redacted whichever way it is spelled.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import { createIrohRemoteProjectionSanitizer } from "../../../src/core/remote/iroh/sanitizer.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { getDefaultSessionDir, SessionManager } from "../../../src/core/session-manager.ts";
import type { PhoneRelayPreamble } from "../../../src/daemon/control-protocol.ts";
import { listRemoteWorkspaceSessions, workspaceStreamRedaction } from "../../../src/daemon/remote-intents.ts";
import { getRelaySanitizerOptions } from "../../../src/daemon/worker/serve-phone.ts";
import { WorkspaceSessions } from "../../../src/daemon/workspace-sessions.ts";
import { getWorktreesRoot } from "../../../src/daemon/worktree-manager.ts";
import { createSessionManagerTestOwner, type SessionManagerTestOwner } from "../../session-manager-owner.ts";
import { seedSession } from "../../utilities/seed-log.ts";

const RPC_GRANT = createIrohRemotePresetAccess("full").rpcGrant;

let base: string;
let agentDir: string;
let workspacePath: string;
/** The worktree checkout, spelled through the symlinked agent directory. */
let checkout: string;
let owner: SessionManagerTestOwner;

beforeEach(() => {
	// The only symlink is the one made here, so the test behaves the same on every OS.
	base = mkdtempSync(join(realpathSync(tmpdir()), "volt-930-"));
	mkdirSync(join(base, "real"));
	const linked = join(base, "linked");
	symlinkSync(join(base, "real"), linked, process.platform === "win32" ? "junction" : "dir");
	agentDir = join(linked, "agent");
	workspacePath = join(linked, "repo");
	checkout = join(agentDir, "worktrees", "--ws--", "fix-login");
	mkdirSync(workspacePath, { recursive: true });
	mkdirSync(join(checkout, "packages", "app"), { recursive: true });
	owner = createSessionManagerTestOwner();
	owner.start();
});

afterEach(async () => {
	await owner.drain();
	rmSync(base, { recursive: true, force: true });
});

function authorization(): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-phone",
			label: "phone",
			allowedWorkspaces: ["ws"],
			allowedTools: "read",
			rpcGrant: RPC_GRANT,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: "ws", path: workspacePath },
		workspaceNames: ["ws"],
		workspaces: [{ name: "ws", status: "available" }],
	};
}

async function storeSession(id: string, cwd: string, name?: string): Promise<void> {
	const manager = await SessionManager.create(cwd, getDefaultSessionDir(agentDir), { id });
	await seedSession(
		manager,
		(seed) => {
			seed.user(`${id} prompt`);
			seed.assistant("done");
			if (name !== undefined) seed.sessionName(name);
		},
		{ at: Date.UTC(2026, 0, 1) },
	);
}

async function listSessions(stateManager: IrohRemoteHostStateManager) {
	return listRemoteWorkspaceSessions(
		{
			agentDir,
			workspaceSessions: new WorkspaceSessions({
				agentDir,
				workspaces: () => [{ name: "ws", path: workspacePath }],
				worktrees: () => stateManager.listWorktrees(),
			}),
			stateManager,
		},
		authorization(),
	);
}

describe("#930 symlinked agent directory", () => {
	it("keeps the working directory of a session in a worktree reached through the symlink", async () => {
		const stateManager = new IrohRemoteHostStateManager();
		await stateManager.upsertWorkspace({ name: "ws", path: workspacePath });
		await stateManager.upsertWorktree({
			id: "fix-login",
			workspaceName: "ws",
			path: checkout,
			branch: "volt/fix-login",
			createdAt: 1,
			sessionIds: [],
		});
		await stateManager.bindWorktreeSession("ws", "fix-login", "s-worktree");
		await storeSession("s-worktree", join(checkout, "packages", "app"));

		expect(await listSessions(stateManager)).toEqual([
			expect.objectContaining({
				sessionId: "s-worktree",
				worktreeId: "fix-login",
				workingDirectory: "packages/app",
			}),
		]);
	});

	it("redacts the worktrees root from session titles in either spelling", async () => {
		const resolvedCheckout = join(getWorktreesRoot(agentDir), "--ws--", "fix-login");
		await storeSession("s-titled", workspacePath, `see ${checkout}/a.ts and ${resolvedCheckout}/b.ts`);

		const [session] = await listSessions(new IrohRemoteHostStateManager());
		expect(session?.sessionName).toBe("see /workspace/--ws--/fix-login/a.ts and /workspace/--ws--/fix-login/b.ts");
	});

	it("redacts both spellings on worktree streams and on a phone's worktree conversation", () => {
		// Another checkout of the worktrees root, as `git worktree list` prints it.
		const text = `${join(agentDir, "worktrees", "--ws--", "other")} ${join(getWorktreesRoot(agentDir), "--ws--", "other")}`;
		const relay = {
			clientNodeId: "n-phone",
			workspaceName: "ws",
			workspacePath,
			workspaceNames: ["ws"],
			workspaces: [{ name: "ws", status: "available" }],
			allowedTools: "read",
			rpcGrant: RPC_GRANT,
			worktreeId: "fix-login",
			worktreePath: checkout,
		} satisfies PhoneRelayPreamble["authorization"];
		for (const options of [
			workspaceStreamRedaction("manage_worktrees", workspacePath, agentDir),
			getRelaySanitizerOptions(relay, agentDir),
		]) {
			expect(createIrohRemoteProjectionSanitizer(options).sanitizeText(text)).toBe(
				"/workspace/--ws--/other /workspace/--ws--/other",
			);
		}
	});
});
