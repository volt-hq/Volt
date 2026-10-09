/**
 * #722: a phone lists and opens every conversation of its workspace, wherever
 * in it a terminal started it. Every directory's sessions are in the one
 * default store; the workspace owning a session is where its directory runs:
 * the innermost managed worktree's workspace, else the innermost registered
 * workspace. A subdirectory's and a worktree checkout's sessions are the
 * workspace's: listed for its phones with their working directory, opened by
 * id, and associated with their changes. A nested registered workspace's (a
 * local-only one too), a sibling path's sharing the root's prefix, and a
 * custom store's are not, and a session id never moves to another directory.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { uuidv7 } from "@hansjm10/volt-agent-core";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonConversationOpenError, openDaemonConversation } from "../../../src/client/daemon-conversation.ts";
import { ProtocolClient } from "../../../src/client/protocol-client.ts";
import { createIrohRemotePresetAccess } from "../../../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../../../src/core/remote/iroh/authorization.ts";
import { getDefaultSessionDir, SessionManager, type SessionReference } from "../../../src/core/session-manager.ts";
import { createIrohDaemonService } from "../../../src/daemon/iroh-service.ts";
import { listRemoteWorkspaceSessions } from "../../../src/daemon/remote-intents.ts";
import { nativeIrohAvailable, type PairedPhone, pairPhone } from "../../utilities/daemon-phone.ts";
import { createDaemonHarness, type DaemonHarness } from "../daemon-harness.ts";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Fixture {
	readonly harness: DaemonHarness;
	/** The workspace's `packages/app`. */
	readonly subdirectory: string;
	/** A managed worktree checkout of the workspace, and its `packages/app`. */
	readonly worktree: { readonly id: string; readonly path: string; readonly subdirectory: string };
	/** A registered workspace local to the host, nested in the workspace. */
	readonly nested: string;
	/** A directory beside the workspace whose path starts with the workspace's. */
	readonly sibling: string;
	/** A custom session store. */
	readonly customStore: string;
}

/** A daemon whose workspace is a Git checkout with `packages/app`, one managed worktree, and a nested local workspace. */
async function fixture(): Promise<Fixture> {
	const harness = await createDaemonHarness({ extensions: [createIrohDaemonService({ relayMode: "disabled" })] });
	cleanups.push(() => harness.dispose());
	const workspace = harness.workspacePath;
	const subdirectory = join(workspace, "packages", "app");
	mkdirSync(subdirectory, { recursive: true });
	writeFileSync(join(subdirectory, "README.md"), "app\n");
	git(workspace, "init", "--initial-branch=main");
	git(workspace, "add", ".");
	git(
		workspace,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.test",
		"-c",
		"commit.gpgsign=false",
		"commit",
		"-m",
		"base",
	);
	const created = await harness.control.request({
		type: "worktree_create",
		workspaceName: harness.workspaceName,
		worktreeName: "fix",
		baseRef: "main",
	});
	if (created.type !== "worktree_result") throw new Error(`The worktree was not created: ${JSON.stringify(created)}`);
	const nested = join(workspace, "private");
	mkdirSync(nested);
	expect(await harness.services.stateManager.insertWorkspace({ name: "private", path: nested, localOnly: true })).toBe(
		true,
	);
	const sibling = `${workspace}-other`;
	mkdirSync(sibling);
	return {
		harness,
		subdirectory,
		worktree: {
			id: created.worktree.id,
			path: created.worktree.path,
			subdirectory: join(created.worktree.path, "packages", "app"),
		},
		nested,
		sibling,
		customStore: join(workspace, "..", "custom-sessions"),
	};
}

/** A visible session a terminal started in `cwd` (`volt -p`), in the default store or `sessionDir`. */
async function terminalSession(f: Fixture, cwd: string, sessionDir?: string): Promise<SessionReference> {
	const manager = await SessionManager.create(cwd, sessionDir ?? getDefaultSessionDir(f.harness.agentDir), {
		id: uuidv7(),
	});
	await manager.logWriter.appendMessage({ role: "user", content: `started in ${cwd}`, timestamp: Date.now() });
	const ref = manager.getSessionRef();
	await manager.closePersistence();
	if (ref === undefined) throw new Error("The session was not stored");
	return ref;
}

/** A TUI's conversation opened in `cwd`, answered once: a worker hosts it while the client is attached. */
async function tuiConversation(f: Fixture, cwd: string): Promise<{ sessionId: string; client: ProtocolClient }> {
	const tui = await f.harness.connect("tui");
	f.harness.faux.setResponses([fauxAssistantMessage("answered in the subdirectory")]);
	const { opened, transport } = await openDaemonConversation(tui, {
		target: { kind: "new" },
		spawn: { env: {}, config: {}, cwd, persist: true, session: {} },
		clientKey: "tui-722",
	});
	const client = new ProtocolClient();
	cleanups.push(() => client.stop());
	await client.connect(transport);
	await client.promptAndWait("work in the subdirectory");
	return { sessionId: opened.sessionId, client };
}

function authorization(f: Fixture): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "read",
		client: {
			nodeId: "n-722",
			label: "phone",
			allowedWorkspaces: [f.harness.workspaceName],
			allowedTools: "read",
			rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: false,
		pairingSecretConsumed: false,
		workspace: { name: f.harness.workspaceName, path: f.harness.workspacePath },
		workspaceGeneration: f.harness.generation(),
		workspaceNames: [f.harness.workspaceName],
		workspaces: [{ name: f.harness.workspaceName, status: "available" }],
	};
}

/** The sessions in the workspace's listing, as its phones see them. */
async function listed(f: Fixture): Promise<Awaited<ReturnType<typeof listRemoteWorkspaceSessions>>> {
	return listRemoteWorkspaceSessions(
		{
			agentDir: f.harness.agentDir,
			workspaceSessions: f.harness.services.workspaceSessions,
			stateManager: f.harness.services.stateManager,
		},
		authorization(f),
	);
}

describe("#722 sessions started anywhere in a workspace", () => {
	it("are the workspace's: listed with their working directory, found by id, and associated with their changes", async () => {
		const f = await fixture();
		const { sessionId: subdirectoryId } = await tuiConversation(f, f.subdirectory);
		const worktree = await terminalSession(f, f.worktree.subdirectory);
		const root = await terminalSession(f, f.harness.workspacePath);
		const nested = await terminalSession(f, f.nested);
		const sibling = await terminalSession(f, f.sibling);
		const custom = await terminalSession(f, f.subdirectory, f.customStore);

		const sessions = await listed(f);
		expect(sessions.map((session) => session.sessionId).sort()).toEqual(
			[subdirectoryId, worktree.sessionId, root.sessionId].sort(),
		);
		const byId = new Map(sessions.map((session) => [session.sessionId, session]));
		expect(byId.get(subdirectoryId)).toMatchObject({ workingDirectory: "packages/app" });
		expect(byId.get(worktree.sessionId)).toMatchObject({
			worktreeId: f.worktree.id,
			workingDirectory: "packages/app",
		});
		expect(byId.get(root.sessionId)).not.toHaveProperty("workingDirectory");

		// What the daemon's stored-session checks (worker moves, last sessions, change observation, claims) decide.
		const owned = f.harness.services.workspaceSessions;
		for (const sessionId of [subdirectoryId, worktree.sessionId, root.sessionId]) {
			expect(await owned.find(f.harness.workspaceName, sessionId)).toMatchObject({ id: sessionId });
		}
		for (const ref of [nested, sibling, custom]) {
			expect(await owned.find(f.harness.workspaceName, ref.sessionId)).toBeUndefined();
		}
		// The nested local workspace owns its own; a custom store's is found only where its conversation runs from.
		expect(await owned.find("private", nested.sessionId)).toMatchObject({ id: nested.sessionId });
		expect(await owned.find(f.harness.workspaceName, custom.sessionId, f.customStore)).toMatchObject({
			id: custom.sessionId,
		});

		// The worker hosting the subdirectory's conversation reports its Git state: the daemon associates it.
		const changes = f.harness.services.changes;
		await vi.waitFor(
			() =>
				expect(
					changes.getChangeContext(f.harness.workspaceName, f.harness.generation(), subdirectoryId),
				).toMatchObject({ branch: "main" }),
			{ timeout: 15_000 },
		);
		// As does a worker hosting the worktree checkout's.
		const opened = await f.harness.openWorker(worktree, {
			spawn: { cwd: f.worktree.subdirectory, root: f.worktree.path, projectCwd: f.worktree.path },
			attach: "remote",
		});
		cleanups.push(async () => opened.release());
		await vi.waitFor(
			() =>
				expect(
					changes.getChangeContext(f.harness.workspaceName, f.harness.generation(), worktree.sessionId),
				).toMatchObject({ branch: expect.stringContaining("fix") }),
			{ timeout: 15_000 },
		);
	}, 120_000);

	it("never reuse an id stored for another directory for a TUI's new conversation", async () => {
		const f = await fixture();
		const sibling = await terminalSession(f, f.sibling);
		const tui = await f.harness.connect("tui");
		await expect(
			openDaemonConversation(tui, {
				target: { kind: "new", sessionId: sibling.sessionId },
				spawn: { env: {}, config: {}, cwd: f.subdirectory, persist: true, session: {} },
				clientKey: "tui-722-reuse",
			}),
		).rejects.toSatisfy((error) => error instanceof DaemonConversationOpenError && error.code === "session_exists");
		// The sibling's session is untouched, and still its own directory's.
		const store = getDefaultSessionDir(f.harness.agentDir);
		expect((await SessionManager.list(f.sibling, store)).map((session) => session.id)).toEqual([sibling.sessionId]);
		expect(await SessionManager.list(f.subdirectory, store)).toEqual([]);
	}, 60_000);
});

describe.runIf(nativeIrohAvailable)("#722 a phone of the workspace", () => {
	async function pair(f: Fixture): Promise<PairedPhone> {
		const phone = await pairPhone(f.harness);
		cleanups.push(() => phone.close());
		return phone;
	}

	it("lists and opens the subdirectory's and the worktree's sessions, and no other directory's", async () => {
		const f = await fixture();
		const subdirectory = await terminalSession(f, f.subdirectory);
		const worktree = await terminalSession(f, f.worktree.subdirectory);
		const nested = await terminalSession(f, f.nested);
		const sibling = await terminalSession(f, f.sibling);
		const custom = await terminalSession(f, f.subdirectory, f.customStore);
		const phone = await pair(f);

		const discovery = await phone.openWorkspace("workspaceDiscovery", "list_sessions");
		expect(discovery.handshake).toMatchObject({ success: true });
		await discovery.phone!.hello();
		const result = (await discovery.phone!.query("sessions")) as {
			type: string;
			data: { sessions: Array<{ sessionId: string; workingDirectory?: string; worktreeId?: string }> };
		};
		expect(result.type).toBe("result");
		expect(result.data.sessions.map((session) => session.sessionId).sort()).toEqual(
			[subdirectory.sessionId, worktree.sessionId].sort(),
		);
		expect(result.data.sessions).toContainEqual(
			expect.objectContaining({ sessionId: subdirectory.sessionId, workingDirectory: "packages/app" }),
		);
		expect(result.data.sessions).toContainEqual(
			expect.objectContaining({ sessionId: worktree.sessionId, worktreeId: f.worktree.id }),
		);

		for (const ref of [subdirectory, worktree]) {
			const opened = await phone.openConversation({ target: "session", sessionId: ref.sessionId });
			expect(opened.handshake).toMatchObject({
				success: true,
				sessionId: ref.sessionId,
				conversation: { workingDirectory: "packages/app" },
			});
			await opened.close();
		}
		for (const ref of [nested, sibling, custom]) {
			const refused = await phone.openConversation({ target: "session", sessionId: ref.sessionId });
			expect(refused.handshake).toMatchObject({ success: false, outcome: "session_unavailable" });
		}
		// A new conversation never takes an id another directory's session has.
		for (const ref of [nested, sibling]) {
			const refused = await phone.openConversation({ target: "new", sessionId: ref.sessionId });
			expect(refused.handshake).toMatchObject({ success: false, outcome: "invalid_conversation_target" });
		}
	}, 120_000);
});
