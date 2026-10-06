import { mkdirSync, mkdtempSync, realpathSync as nodeRealpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import type { IrohRemoteWorkspaceWorktree } from "../src/core/remote/iroh/state.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";
import {
	type ConversationOpenServices,
	createConversationOpenError,
	resolveConversationOpen,
} from "../src/daemon/conversation-open.ts";
import { resolveWorkspaceDirectory } from "../src/daemon/workspace-directory.ts";
import type { WorktreeRuntimePreparation } from "../src/daemon/worktree-manager.ts";
import { createSessionManagerTestOwner } from "./session-manager-owner.ts";

const realpathSync = nodeRealpathSync.native;

const TOOL_POLICY = { tools: ["read"], allowUnlistedExtensionTools: false };

let newSessionSequence = 0;

function createConversationHello(conversation: Record<string, unknown>): IrohRemoteHello {
	return {
		type: "volt_iroh_hello",
		protocol: "volt/1",
		workspace: "ws",
		mode: "conversation",
		conversation:
			conversation.target === "new" && conversation.sessionId === undefined
				? { ...conversation, sessionId: `new-session-${++newSessionSequence}` }
				: conversation,
	} as unknown as IrohRemoteHello;
}

/**
 * A phone's conversation open as the daemon resolves it before the worker
 * registry routes it (conversation-open.ts): placement read-only, and the
 * spawn's log, worktree binding, and worktree pin only when a worker spawns.
 */
describe("worktree conversation placement (conversation open)", () => {
	let agentDir: string;
	let workspacePath: string;
	let worktreePath: string;
	let sessionDir: string;
	let worktree: IrohRemoteWorkspaceWorktree;
	let authorization: IrohRemoteClientAuthorizationSuccess;
	const managerOwner = createSessionManagerTestOwner();

	beforeEach(() => {
		managerOwner.start();
		agentDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-worktree-runtime-")));
		workspacePath = join(agentDir, "repo");
		worktreePath = join(agentDir, "worktrees", "--repo--", "fix-login");
		mkdirSync(workspacePath, { recursive: true });
		mkdirSync(worktreePath, { recursive: true });
		// Parent-keyed: worktree sessions are stored with the workspace's.
		sessionDir = getDefaultSessionDir(workspacePath, agentDir);
		worktree = {
			id: "fix-login",
			workspaceName: "ws",
			path: worktreePath,
			branch: "volt/fix-login",
			baseRef: "origin/main",
			createdAt: 1,
			sessionIds: [],
		};
		authorization = {
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
				lastSessionIdByWorkspace: { ws: "s-last" },
			},
			paired: false,
			pairingSecretConsumed: false,
			workspace: { name: "ws", path: workspacePath },
			workspaceNames: ["ws"],
			workspaces: [{ name: "ws", status: "available" }],
		};
	});

	afterEach(async () => {
		await managerOwner.drain();
		rmSync(agentDir, { recursive: true, force: true });
	});

	/** The daemon's open services, with the worktree resolution and the binding under test. */
	function createServices(options: {
		resolveWorktree?: ConversationOpenServices["resolveWorktree"];
		resolveWorkingDirectory?: ConversationOpenServices["resolveWorkingDirectory"];
		bindWorktreeSession?: ConversationOpenServices["bindWorktreeSession"];
	}) {
		const preparations: Array<{ published: boolean; released: boolean }> = [];
		const prepareWorktreeRuntime = vi.fn(async (): Promise<WorktreeRuntimePreparation> => {
			const preparation = { published: false, released: false };
			preparations.push(preparation);
			return {
				publish: async <T>(publish: () => T): Promise<T> => {
					preparation.published = true;
					return publish();
				},
				release: async () => {
					preparation.released = true;
				},
			};
		});
		const projectTrusted = vi.fn(() => true);
		const services: ConversationOpenServices = {
			agentDir,
			toolPolicy: () => TOOL_POLICY,
			projectTrusted,
			resolveWorktree: options.resolveWorktree ?? (async () => undefined),
			resolveWorkingDirectory:
				options.resolveWorkingDirectory ??
				(async ({ rootPath, workingDirectory }) => {
					const resolved = await resolveWorkspaceDirectory(rootPath, workingDirectory);
					if (!resolved.ok) throw createConversationOpenError("invalid_conversation_target", resolved.error);
					return resolved.value;
				}),
			prepareWorktreeRuntime,
			preparePrReviewSession: async () => undefined,
			bindWorktreeSession: options.bindWorktreeSession ?? (async () => {}),
		};
		return { services, prepareWorktreeRuntime, preparations, projectTrusted };
	}

	async function storeSession(sessionId: string, cwd: string): Promise<void> {
		const manager = await SessionManager.create(cwd, sessionDir, { id: sessionId });
		await manager.closePersistence();
	}

	/** Whether the workspace's session store holds `sessionId` (empty sessions included). */
	async function isStored(sessionId: string): Promise<boolean> {
		return (await SessionManager.findForResume(sessionDir, sessionId)) !== undefined;
	}

	it("worktree-bound new places the spawn in the worktree with the parent-keyed log; binds once, after the log exists", async () => {
		const resolveWorktree = vi.fn(async () => worktree);
		const bindWorktreeSession = vi.fn(async () => {});
		const { services, prepareWorktreeRuntime, preparations, projectTrusted } = createServices({
			resolveWorktree,
			bindWorktreeSession,
		});
		const hello = createConversationHello({ target: "new", worktreeId: "fix-login" });

		const opened = await resolveConversationOpen(hello, authorization, services);
		expect(resolveWorktree).toHaveBeenCalledExactlyOnceWith("ws", hello, "new-session-1");
		expect(opened).toMatchObject({
			sessionId: "new-session-1",
			selection: { kind: "created", sessionId: "new-session-1" },
			worktree: { id: "fix-login", path: worktreePath },
			toolPolicy: TOOL_POLICY,
		});
		expect(opened.workingDirectory).toBeUndefined();
		// The resolution is read-only: nothing exists until a worker spawns for it.
		expect(await isStored("new-session-1")).toBe(false);
		expect(bindWorktreeSession).not.toHaveBeenCalled();

		const spawn = await opened.prepare(3);
		expect(spawn).toMatchObject({
			origin: "phone",
			workspace: { name: "ws", path: workspacePath, generation: 3 },
			session: { sessionId: "new-session-1", sessionDirectory: sessionDir },
			cwd: worktreePath,
			root: worktreePath,
			projectCwd: worktreePath,
			baseRef: "origin/main",
			toolPolicy: TOOL_POLICY,
			projectTrusted: true,
		});
		expect(spawn).not.toHaveProperty("profile");
		// Trust is evaluated against the registered (parent) workspace.
		expect(projectTrusted).toHaveBeenCalledWith(authorization.workspace);
		expect(await isStored("new-session-1")).toBe(true);
		expect(bindWorktreeSession).toHaveBeenCalledExactlyOnceWith("ws", "fix-login", "new-session-1");
		expect(prepareWorktreeRuntime).toHaveBeenCalledExactlyOnceWith("ws", "fix-login", "new-session-1");
		expect(preparations).toEqual([{ published: true, released: false }]);

		// A reattach to the same conversation must not re-bind.
		const reattach = await resolveConversationOpen(
			createConversationHello({ target: "session", sessionId: "new-session-1" }),
			authorization,
			services,
		);
		expect(reattach.selection).toEqual({
			kind: "resumed",
			requestedSessionId: "new-session-1",
			sessionId: "new-session-1",
		});
		expect((await reattach.prepare(3)).cwd).toBe(worktreePath);
		expect(bindWorktreeSession).toHaveBeenCalledTimes(1);
	});

	it("worktree-bound new preserves a selected workspace-relative subfolder under the checkout", async () => {
		mkdirSync(join(workspacePath, "packages", "app"), { recursive: true });
		mkdirSync(join(worktreePath, "packages", "app"), { recursive: true });
		const { services } = createServices({ resolveWorktree: async () => worktree });
		const hello = createConversationHello({
			target: "new",
			worktreeId: "fix-login",
			workingDirectory: "packages/app",
		});

		const opened = await resolveConversationOpen(hello, authorization, services);

		expect(opened).toMatchObject({
			worktree: { id: "fix-login", path: worktreePath },
			workingDirectory: "packages/app",
		});
		expect(await opened.prepare(1)).toMatchObject({
			cwd: join(worktreePath, "packages", "app"),
			root: worktreePath,
			projectCwd: worktreePath,
			session: { sessionDirectory: sessionDir },
		});
	});

	it("nested-repo worktree new uses the nested checkout root for project config and preserves remote cwd", async () => {
		const nestedWorktree: IrohRemoteWorkspaceWorktree = {
			...worktree,
			sourceRootRelativePath: "Volt",
		};
		mkdirSync(join(worktreePath, "packages", "coding-agent"), { recursive: true });
		const resolveWorkingDirectory = vi.fn(async () => ({
			absolutePath: join(worktreePath, "packages", "coding-agent"),
			relativePath: "packages/coding-agent",
		}));
		const { services } = createServices({ resolveWorktree: async () => nestedWorktree, resolveWorkingDirectory });
		const hello = createConversationHello({
			target: "new",
			worktreeId: "fix-login",
			workingDirectory: "Volt/packages/coding-agent",
		});

		const opened = await resolveConversationOpen(hello, authorization, services);

		expect(resolveWorkingDirectory).toHaveBeenCalledWith({
			workspace: authorization.workspace,
			rootPath: worktreePath,
			workingDirectory: "Volt/packages/coding-agent",
			worktree: nestedWorktree,
		});
		expect(opened).toMatchObject({
			worktree: { id: "fix-login", path: worktreePath, sourceRootRelativePath: "Volt" },
			workingDirectory: "Volt/packages/coding-agent",
		});
		expect(await opened.prepare(1)).toMatchObject({
			cwd: join(worktreePath, "packages", "coding-agent"),
			projectCwd: worktreePath,
			session: { sessionDirectory: sessionDir },
		});
	});

	it("non-worktree new keeps the parent cwd and the same derived session dir", async () => {
		const bindWorktreeSession = vi.fn(async () => {});
		const { services, prepareWorktreeRuntime } = createServices({ bindWorktreeSession });

		const opened = await resolveConversationOpen(createConversationHello({ target: "new" }), authorization, services);
		expect(opened.selection.kind).toBe("created");
		expect(opened.worktree).toBeUndefined();
		expect(await opened.prepare(1)).toMatchObject({
			cwd: workspacePath,
			root: workspacePath,
			projectCwd: workspacePath,
			session: { sessionDirectory: sessionDir },
			toolPolicy: TOOL_POLICY,
			projectTrusted: true,
		});
		expect(bindWorktreeSession).not.toHaveBeenCalled();
		expect(prepareWorktreeRuntime).not.toHaveBeenCalled();
	});

	it("non-worktree new can run from a selected workspace-relative subfolder while keeping projectCwd at the root", async () => {
		mkdirSync(join(workspacePath, "packages", "app"), { recursive: true });
		const { services } = createServices({});

		const opened = await resolveConversationOpen(
			createConversationHello({ target: "new", workingDirectory: "packages/app" }),
			authorization,
			services,
		);

		expect(opened.workingDirectory).toBe("packages/app");
		expect(await opened.prepare(1)).toMatchObject({
			cwd: join(workspacePath, "packages", "app"),
			projectCwd: workspacePath,
			session: { sessionDirectory: sessionDir },
		});
	});

	it("resolves a target-new retry after its log exists as a resume of that session", async () => {
		const { services } = createServices({});
		const hello = createConversationHello({ target: "new", sessionId: "same-session" });

		const first = await resolveConversationOpen(hello, authorization, services);
		// Before a spawn prepared the log, a retry names the same new session (the registry coalesces their spawns).
		const early = await resolveConversationOpen(hello, authorization, services);
		expect(early.selection).toEqual({ kind: "created", sessionId: "same-session" });
		await first.prepare(1);

		const retry = await resolveConversationOpen(hello, authorization, services);
		expect(retry.selection).toEqual({
			kind: "resumed",
			requestedSessionId: "same-session",
			sessionId: "same-session",
		});
		expect(await isStored("same-session")).toBe(true);
	});

	it("rejects a target-new retry when placement differs from the stored session", async () => {
		mkdirSync(join(workspacePath, "packages/app"), { recursive: true });
		const { services } = createServices({});
		const placed = await resolveConversationOpen(
			createConversationHello({ target: "new", sessionId: "placed-session", workingDirectory: "packages/app" }),
			authorization,
			services,
		);
		await placed.prepare(1);

		await expect(
			resolveConversationOpen(
				createConversationHello({ target: "new", sessionId: "placed-session" }),
				authorization,
				services,
			),
		).rejects.toMatchObject({ outcome: "invalid_conversation_target" });
	});

	it("resume of a bound session places the spawn in the worktree without re-binding", async () => {
		await storeSession("s-resume", worktreePath);
		const resolveWorktree = vi.fn(async () => worktree);
		const bindWorktreeSession = vi.fn(async () => {});
		const { services, prepareWorktreeRuntime } = createServices({ resolveWorktree, bindWorktreeSession });
		const hello = createConversationHello({ target: "session", sessionId: "s-resume" });

		const resumed = await resolveConversationOpen(hello, authorization, services);
		expect(resolveWorktree).toHaveBeenCalledExactlyOnceWith("ws", hello, "s-resume");
		expect(resumed).toMatchObject({
			selection: { kind: "resumed", requestedSessionId: "s-resume", sessionId: "s-resume" },
			worktree: { id: "fix-login" },
		});
		expect(await resumed.prepare(1)).toMatchObject({
			session: { sessionId: "s-resume", sessionDirectory: sessionDir },
			cwd: worktreePath,
			root: worktreePath,
			projectCwd: worktreePath,
		});
		expect(bindWorktreeSession).not.toHaveBeenCalled();
		// The checkout is pinned (and restored if archived) for the spawn.
		expect(prepareWorktreeRuntime).toHaveBeenCalledExactlyOnceWith("ws", "fix-login", "s-resume");
	});

	it("target last resolves the binding via the client's last session id", async () => {
		const resolveWorktree = vi.fn(async () => worktree);
		const { services } = createServices({ resolveWorktree });
		const hello = createConversationHello({ target: "last" });
		await resolveConversationOpen(hello, authorization, services);
		expect(resolveWorktree).toHaveBeenCalledExactlyOnceWith("ws", hello, "s-last");
	});

	it("created_after_missing under a resolved worktree binds the replacement session id (#83)", async () => {
		const resolveWorktree = vi.fn(async () => worktree);
		const bindWorktreeSession = vi.fn(async () => {});
		const { services } = createServices({ resolveWorktree, bindWorktreeSession });
		const hello = createConversationHello({ target: "last" });

		const opened = await resolveConversationOpen(hello, authorization, services);

		expect(resolveWorktree).toHaveBeenCalledExactlyOnceWith("ws", hello, "s-last");
		expect(opened.selection).toMatchObject({ kind: "created_after_missing", requestedSessionId: "s-last" });
		expect(opened.sessionId).not.toBe("s-last");
		await opened.prepare(1);
		expect(bindWorktreeSession).toHaveBeenCalledExactlyOnceWith("ws", "fix-login", opened.sessionId);
	});

	it("fails the spawn of a new worktree session whose binding fails, releasing the worktree pin", async () => {
		const { services, preparations } = createServices({
			resolveWorktree: async () => worktree,
			bindWorktreeSession: async () => {
				throw new Error("bind failed");
			},
		});
		const opened = await resolveConversationOpen(
			createConversationHello({ target: "new", worktreeId: "fix-login" }),
			authorization,
			services,
		);

		await expect(opened.prepare(1)).rejects.toThrow("bind failed");
		expect(preparations).toEqual([{ published: false, released: true }]);
	});

	it("refuses a stored session whose cwd left the workspace it is opened under", async () => {
		// A session written in the worktree, opened without its worktree: its cwd is outside the root.
		await storeSession("s-escaped", worktreePath);
		const { services } = createServices({});

		await expect(
			resolveConversationOpen(
				createConversationHello({ target: "session", sessionId: "s-escaped" }),
				authorization,
				services,
			),
		).rejects.toMatchObject({ outcome: "session_unavailable" });
	});

	it("propagates conversation-open errors from worktree resolution (missing checkout)", async () => {
		const invalidTarget = createServices({
			resolveWorktree: async () => {
				throw createConversationOpenError("invalid_conversation_target", "unknown or unavailable worktree");
			},
		});
		await expect(
			resolveConversationOpen(
				createConversationHello({ target: "new", worktreeId: "ghost" }),
				authorization,
				invalidTarget.services,
			),
		).rejects.toMatchObject({ outcome: "invalid_conversation_target" });

		const unavailable = createServices({
			resolveWorktree: async () => {
				throw createConversationOpenError("session_unavailable", "worktree checkout is unavailable");
			},
		});
		await expect(
			resolveConversationOpen(
				createConversationHello({ target: "session", sessionId: "s-y" }),
				authorization,
				unavailable.services,
			),
		).rejects.toMatchObject({ outcome: "session_unavailable" });
		expect(await isStored("s-y")).toBe(false);
		expect(invalidTarget.prepareWorktreeRuntime).not.toHaveBeenCalled();
		expect(unavailable.prepareWorktreeRuntime).not.toHaveBeenCalled();
	});
});

describe("worktree session-dir keying (§5.1.7 filterCwd pin)", () => {
	it("a session with a worktree cwd in the parent session dir stays visible in the parent listing", async () => {
		const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "volt-worktree-sessiondir-")));
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		const managerOwner = createSessionManagerTestOwner();
		managerOwner.start();
		try {
			// The daemon always uses the env-aware agent dir; pin that setup here so
			// SessionManager.list's filterCwd stays OFF for the parent's default dir.
			process.env[ENV_AGENT_DIR] = agentDir;
			const parentPath = join(agentDir, "repo");
			const worktreePath = join(agentDir, "worktrees", "--repo--", "fix-login");
			mkdirSync(parentPath, { recursive: true });
			mkdirSync(worktreePath, { recursive: true });

			const parentSessionDir = getDefaultSessionDir(parentPath, agentDir);
			const worktreeSession = await SessionManager.create(worktreePath, parentSessionDir, {
				id: "s-worktree",
			});
			const parentSession = await SessionManager.create(parentPath, parentSessionDir, { id: "s-parent" });
			await worktreeSession.logWriter.appendMessage({
				role: "user",
				content: "worktree session",
				timestamp: Date.now(),
			});
			await parentSession.logWriter.appendMessage({
				role: "user",
				content: "parent session",
				timestamp: Date.now(),
			});

			// The daemon's list_sessions call shape: parent cwd + parent default dir.
			const sessions = await SessionManager.list(parentPath, parentSessionDir);
			const ids = sessions.map((session) => session.id);
			expect(ids).toContain("s-worktree");
			expect(ids).toContain("s-parent");
		} finally {
			await managerOwner.drain();
			if (originalAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = originalAgentDir;
			}
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
