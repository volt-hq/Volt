/**
 * Phase 2 (TUI) worktree integration — worktrees-design.md §5.2 / §9 Phase 2:
 * worktree_resolve/worktree_bind control handling, the TUI's workspace
 * resolution, the /worktree control-plane helper, relay sanitization root
 * switching, the managed-checkout path predicate, trust-path pinning helpers,
 * and new-session cwd/sessionDir overrides.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../src/config.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionServices } from "../src/core/agent-session-services.ts";
import type { ConversationFactoryResult } from "../src/core/host/hosted-conversation.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { IrohRemoteAuditLogger } from "../src/core/remote/iroh/audit.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import type { IrohRemoteWorkspaceWorktree } from "../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { getDefaultSessionDir, SessionManager, type SessionReference } from "../src/core/session-manager.ts";
import type { ControlRequest, ControlResponse, PhoneRelayPreamble } from "../src/daemon/control-protocol.ts";
import { type ControlConnection, type ControlServer, startControlServer } from "../src/daemon/control-server.ts";
import { ensureDaemonDirs, getDaemonPaths } from "../src/daemon/paths.ts";
import { releaseLocalSessionWorktree } from "../src/daemon/session-worktree.ts";
import type { EnsureDaemonResult } from "../src/daemon/spawn.ts";
import * as daemonSpawn from "../src/daemon/spawn.ts";
import { getRelaySanitizerOptions } from "../src/daemon/worker/serve-phone.ts";
import {
	getWorktreeCheckoutPath,
	getWorktreesRoot,
	handleWorktreeControlRequest,
	isPathUnderWorktreesRoot,
	resolveWorktreeParentCheckout,
	WorktreeManager,
} from "../src/daemon/worktree-manager.ts";
import { openDaemonWorktreeControl, resolveDaemonWorkspaceForCwd } from "../src/modes/interactive/worktree-control.ts";
import { createSessionManagerTestOwner } from "./session-manager-owner.ts";
import { createHostHarness } from "./suite/host-harness.ts";
import { adoptTestSession, connectTestClient } from "./utilities/host-client.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone } from "./utilities/remote-phone.ts";

const cleanups: Array<() => Promise<void> | void> = [];
const tempDirs: string[] = [];
const managerOwner = createSessionManagerTestOwner();
const HOST_FIXTURE_ROOT = join(tmpdir(), "volt-worktree-tui");
const HOST_PARENT_PATH = join(HOST_FIXTURE_ROOT, "parent-repo");
const HOST_AGENT_DIR = join(HOST_FIXTURE_ROOT, ".volt", "agent");
const HOST_WORKTREE_PATH = join(getWorktreesRoot(HOST_AGENT_DIR), "--repo--", "fix-login");

beforeEach(() => managerOwner.start());

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	await managerOwner.drain();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function createStubConnection(): { connection: ControlConnection; sent: ControlResponse[] } {
	const sent: ControlResponse[] = [];
	const connection: ControlConnection = {
		connectionId: "c-test",
		client: "tui",
		pid: 1,
		version: "0.0.0-test",
		capabilities: new Set(),
		send(message) {
			sent.push(message as ControlResponse);
		},
		close() {},
	};
	return { connection, sent };
}

async function createWorktreeFixture(): Promise<{
	agentDir: string;
	workspacePath: string;
	checkoutPath: string;
	stateManager: IrohRemoteHostStateManager;
	manager: WorktreeManager;
	worktree: IrohRemoteWorkspaceWorktree;
}> {
	const agentDir = makeTempDir("volt-wt-tui-agent-");
	const workspacePath = join(agentDir, "repo");
	mkdirSync(workspacePath, { recursive: true });
	const checkoutPath = getWorktreeCheckoutPath(agentDir, workspacePath, "fix-login");
	mkdirSync(checkoutPath, { recursive: true });
	const stateManager = new IrohRemoteHostStateManager();
	await stateManager.upsertWorkspace({ name: "repo", path: workspacePath });
	const worktree: IrohRemoteWorkspaceWorktree = {
		id: "fix-login",
		workspaceName: "repo",
		path: checkoutPath,
		branch: "volt/fix-login",
		createdAt: 1,
		sessionIds: [],
	};
	await stateManager.upsertWorktree(worktree);
	const manager = new WorktreeManager({
		agentDir,
		stateManager,
		auditLogger: new IrohRemoteAuditLogger(),
		runGit: async () => ({ ok: true, code: 0, stdout: "", stderr: "" }),
	});
	return { agentDir, workspacePath, checkoutPath, stateManager, manager, worktree };
}

describe("worktree_resolve / worktree_bind control requests (§5.2.2)", () => {
	it("resolves the checkout path and nested paths to the parent workspace", async () => {
		const fixture = await createWorktreeFixture();
		const { connection, sent } = createStubConnection();
		for (const path of [fixture.checkoutPath, join(fixture.checkoutPath, "src", "deep")]) {
			sent.length = 0;
			await handleWorktreeControlRequest(
				connection,
				{ type: "worktree_resolve", id: "1", path },
				{ manager: fixture.manager, stateManager: fixture.stateManager },
			);
			expect(sent).toEqual([
				{
					type: "worktree_resolve_result",
					id: "1",
					workspaceName: "repo",
					workspacePath: fixture.workspacePath,
					worktreeId: "fix-login",
					worktreePath: fixture.checkoutPath,
				},
			]);
		}
	});

	it("answers not_found for paths outside any worktree", async () => {
		const fixture = await createWorktreeFixture();
		const { connection, sent } = createStubConnection();
		await handleWorktreeControlRequest(
			connection,
			{ type: "worktree_resolve", id: "2", path: fixture.workspacePath },
			{ manager: fixture.manager, stateManager: fixture.stateManager },
		);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ type: "error", id: "2", code: "not_found" });
	});

	it("worktree_bind records the session binding; unknown ids fail", async () => {
		const fixture = await createWorktreeFixture();
		const { connection, sent } = createStubConnection();
		await handleWorktreeControlRequest(
			connection,
			{ type: "worktree_bind", id: "3", workspaceName: "repo", worktreeId: "fix-login", sessionId: "s-tui" },
			{ manager: fixture.manager, stateManager: fixture.stateManager },
		);
		expect(sent).toEqual([{ type: "ok", id: "3" }]);
		const bound = await fixture.stateManager.findWorktreeForSession("repo", "s-tui");
		expect(bound?.id).toBe("fix-login");

		sent.length = 0;
		await handleWorktreeControlRequest(
			connection,
			{ type: "worktree_bind", id: "4", workspaceName: "repo", worktreeId: "nope", sessionId: "s-tui" },
			{ manager: fixture.manager, stateManager: fixture.stateManager },
		);
		expect(sent[0]).toMatchObject({ type: "error", id: "4", code: "worktree_not_found" });
	});
});

describe("resolveDaemonWorkspaceForCwd (§5.2.2)", () => {
	function createFakeClient(handlers: {
		workspaces: Array<{ name: string; path: string }>;
		resolve?: (path: string) => ControlResponse;
	}) {
		const requests: ControlRequest[] = [];
		const request = vi.fn(async (req: Omit<ControlRequest, "id">): Promise<ControlResponse> => {
			const full = { ...req, id: "x" } as ControlRequest;
			requests.push(full);
			if (full.type === "status") {
				return {
					type: "status_result",
					id: "x",
					version: "0",
					protocolVersion: 1,
					pid: 1,
					startedAtMs: 0,
					environment: { source: "inherited", reason: "not resolved" },
					phoneConnections: 0,
					remoteTransport: { state: "ready" },
					workspaces: handlers.workspaces,
					clients: [],
					keepAwake: { enabled: false, state: "disabled" },
					workers: [],
				};
			}
			if (full.type === "worktree_resolve") {
				return (
					handlers.resolve?.(full.path) ?? {
						type: "error",
						id: "x",
						code: "not_found",
						message: "not a worktree",
					}
				);
			}
			if (full.type === "workspace_register") {
				return { type: "ok", id: "x" };
			}
			throw new Error(`unexpected request ${full.type}`);
		});
		return { request, requests };
	}

	it("uses the parent workspace on a worktree_resolve hit and never auto-registers", async () => {
		const client = createFakeClient({
			workspaces: [{ name: "repo", path: HOST_PARENT_PATH }],
			resolve: () => ({
				type: "worktree_resolve_result",
				id: "x",
				workspaceName: "repo",
				workspacePath: HOST_PARENT_PATH,
				worktreeId: "fix-login",
				worktreePath: HOST_WORKTREE_PATH,
			}),
		});
		const resolved = await resolveDaemonWorkspaceForCwd(client, HOST_WORKTREE_PATH);
		expect(resolved).toEqual({ name: "repo", path: HOST_PARENT_PATH, worktreeId: "fix-login" });
		expect(client.requests.some((req) => req.type === "workspace_register")).toBe(false);
	});

	it("registers nothing when no workspace contains the directory, sensitive or not (D17)", async () => {
		const client = createFakeClient({ workspaces: [{ name: "repo", path: HOST_PARENT_PATH }] });
		const projectPath = join(HOST_FIXTURE_ROOT, "elsewhere", "project");
		for (const path of [projectPath, homedir(), getAgentDir(), dirname(getAgentDir())]) {
			expect(await resolveDaemonWorkspaceForCwd(client, path)).toBeUndefined();
		}
		expect(client.requests.some((req) => req.type === "workspace_register")).toBe(false);
	});

	it("prefers the longest path-prefix match after checking managed worktrees", async () => {
		const client = createFakeClient({ workspaces: [{ name: "repo", path: HOST_PARENT_PATH }] });
		const resolved = await resolveDaemonWorkspaceForCwd(client, join(HOST_PARENT_PATH, "sub", "dir"));
		expect(resolved).toEqual({ name: "repo", path: HOST_PARENT_PATH });
		expect(client.requests.map((req) => req.type)).toEqual(["status", "worktree_resolve"]);
	});
});

interface ControlHarness {
	agentDir: string;
	socketPath: string;
	server: ControlServer;
	requests: ControlRequest[];
	connections: ControlConnection[];
	/** Connection that carried each request (probe connections carry only status). */
	requestConnections: Array<{ connection: ControlConnection; request: ControlRequest }>;
}

/** Real control server on the agentDir's daemon socket path, scripted responses. */
async function startControlHarness(
	respond: (connection: ControlConnection, request: ControlRequest) => void,
): Promise<ControlHarness> {
	const agentDir = makeTempDir("volt-wt-ctl-");
	const paths = getDaemonPaths(agentDir);
	ensureDaemonDirs(paths);
	const requests: ControlRequest[] = [];
	const connections: ControlConnection[] = [];
	const requestConnections: Array<{ connection: ControlConnection; request: ControlRequest }> = [];
	const server = await startControlServer({
		socketPath: paths.socketPath,
		version: "0.0.0-test",
		handlers: {
			onRequest(connection, request) {
				if (!connections.includes(connection)) {
					connections.push(connection);
				}
				requests.push(request);
				requestConnections.push({ connection, request });
				respond(connection, request);
			},
		},
	});
	cleanups.push(() => server.close());
	return { agentDir, socketPath: paths.socketPath, server, requests, connections, requestConnections };
}

function statusResult(id: string, workspaces: Array<{ name: string; path: string }>): ControlResponse {
	return {
		type: "status_result",
		id,
		version: "0.0.0-test",
		protocolVersion: 1,
		pid: 1,
		startedAtMs: 0,
		environment: { source: "inherited", reason: "not resolved" },
		phoneConnections: 0,
		remoteTransport: { state: "ready" },
		workspaces,
		clients: [],
		keepAwake: { enabled: false, state: "disabled" },
		workers: [],
	};
}

describe("openDaemonWorktreeControl (§5.2.1)", () => {
	it("creates a worktree in the resolved workspace and binds the session", async () => {
		const harness = await startControlHarness((connection, request) => {
			if (request.type === "status") {
				connection.send(statusResult(request.id, [{ name: "repo", path: HOST_PARENT_PATH }]));
				return;
			}
			if (request.type === "worktree_create") {
				connection.send({
					type: "worktree_result",
					id: request.id,
					worktree: {
						id: request.worktreeName ?? "generated-slug-01",
						workspaceName: request.workspaceName,
						path: join(
							getWorktreesRoot(HOST_AGENT_DIR),
							"--parent-repo--",
							request.worktreeName ?? "generated-slug-01",
						),
						branch: `volt/${request.worktreeName ?? "generated-slug-01"}`,
						createdAt: 1,
						sessionIds: [],
					},
				});
				return;
			}
			connection.send({ type: "ok", id: request.id });
		});

		const ensureDaemon = async (agentDir: string): Promise<EnsureDaemonResult> => ({
			healthy: true,
			state: "healthy",
			socketPath: getDaemonPaths(agentDir).socketPath,
			spawned: false,
		});
		const opened = await openDaemonWorktreeControl({
			cwd: join(HOST_PARENT_PATH, "sub"),
			agentDir: harness.agentDir,
			daemon: { ensure: ensureDaemon },
		});
		expect(opened.ok).toBe(true);
		if (!opened.ok) {
			return;
		}
		cleanups.push(() => opened.control.close());
		expect(opened.control.workspaceName).toBe("repo");
		expect(opened.control.workspacePath).toBe(HOST_PARENT_PATH);

		const created = await opened.control.createWorktree("fix-login");
		expect(created).toMatchObject({ ok: true, worktree: { id: "fix-login", branch: "volt/fix-login" } });
		expect(await opened.control.bindSession("fix-login", "s-new")).toBe(true);
		const bind = harness.requests.find((request) => request.type === "worktree_bind");
		expect(bind).toMatchObject({ workspaceName: "repo", worktreeId: "fix-login", sessionId: "s-new" });
	});

	it("takes the conversation's workspace when the TUI knows it, and registers none it does not", async () => {
		const harness = await startControlHarness((connection, request) => {
			if (request.type === "status") {
				connection.send(statusResult(request.id, [{ name: "repo", path: HOST_PARENT_PATH }]));
				return;
			}
			connection.send({ type: "error", id: request.id, code: "not_found", message: "no" });
		});
		const ensureDaemon = async (agentDir: string): Promise<EnsureDaemonResult> => ({
			healthy: true,
			state: "healthy",
			socketPath: getDaemonPaths(agentDir).socketPath,
			spawned: false,
		});
		const elsewhere = join(HOST_FIXTURE_ROOT, "elsewhere");
		const named = await openDaemonWorktreeControl({
			cwd: elsewhere,
			agentDir: harness.agentDir,
			workspaceName: "repo",
			daemon: { ensure: ensureDaemon },
		});
		expect(named).toMatchObject({ ok: true, control: { workspaceName: "repo", workspacePath: HOST_PARENT_PATH } });
		if (named.ok) await named.control.close();

		const unregistered = await openDaemonWorktreeControl({
			cwd: elsewhere,
			agentDir: harness.agentDir,
			daemon: { ensure: ensureDaemon },
		});
		expect(unregistered).toMatchObject({ ok: false, error: expect.stringContaining("no registered workspace") });
		expect(harness.requests.some((request) => request.type === "workspace_register")).toBe(false);
	});

	it("fails fast when the daemon is unavailable", async () => {
		const agentDir = makeTempDir("volt-wt-nodaemon-");
		const opened = await openDaemonWorktreeControl({
			cwd: join(HOST_FIXTURE_ROOT, "anywhere"),
			agentDir,
			daemon: {
				ensure: async () => ({
					healthy: false,
					state: "not-running",
					socketPath: getDaemonPaths(agentDir).socketPath,
					spawned: true,
				}),
			},
		});
		expect(opened.ok).toBe(false);
		if (!opened.ok) {
			expect(opened.error).toContain("not-running");
		}
	});

	it("needs the daemon of a TUI whose conversations run in its workers", async () => {
		const opened = await openDaemonWorktreeControl({
			cwd: join(HOST_FIXTURE_ROOT, "anywhere"),
			agentDir: makeTempDir("volt-wt-inprocess-"),
			daemon: undefined,
		});
		expect(opened).toEqual({ ok: false, error: "this terminal's conversations do not run in the daemon" });
	});
});

describe("relay sanitization root switching (§5.2.3)", () => {
	const authorizationBase = {
		clientNodeId: "n-1",
		workspaceName: "repo",
		workspacePath: HOST_PARENT_PATH,
		workspaceNames: ["repo"],
		workspaces: [{ name: "repo", status: "available" }],
		allowedTools: "read",
		rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
	} satisfies PhoneRelayPreamble["authorization"];

	it("keeps the parent root for non-worktree conversations", () => {
		expect(getRelaySanitizerOptions(authorizationBase, HOST_AGENT_DIR)).toEqual({
			workspacePath: HOST_PARENT_PATH,
		});
	});

	it("switches the root to the worktree and redacts the parent + worktrees root", () => {
		const options = getRelaySanitizerOptions(
			{
				...authorizationBase,
				worktreeId: "fix-login",
				worktreePath: HOST_WORKTREE_PATH,
			},
			HOST_AGENT_DIR,
		);
		expect(options).toEqual({
			workspacePath: HOST_WORKTREE_PATH,
			additionalRedactedPaths: [HOST_PARENT_PATH, getWorktreesRoot(HOST_AGENT_DIR)],
		});
	});

	it("maps nested worktree relay roots back under the registered workspace", () => {
		const options = getRelaySanitizerOptions(
			{
				...authorizationBase,
				worktreeId: "fix-login",
				worktreePath: HOST_WORKTREE_PATH,
				worktreeSourceRootRelativePath: "Volt",
			},
			HOST_AGENT_DIR,
		);
		expect(options).toEqual({
			remoteWorkspacePath: "/workspace/Volt",
			workspacePath: HOST_WORKTREE_PATH,
			additionalRedactedPaths: [HOST_PARENT_PATH, getWorktreesRoot(HOST_AGENT_DIR)],
		});
	});

	it("redacts worktree, parent, and worktrees-root paths on served relay frames", async () => {
		const parentPath = HOST_PARENT_PATH;
		const agentDir = HOST_AGENT_DIR;
		const worktreePath = HOST_WORKTREE_PATH;
		const text = `wt=${worktreePath}/file.ts parent=${parentPath}/file.ts root=${agentDir}/worktrees`;
		const harness = await createHostHarness({ whenUnattached: "keep", responses: [text] });
		cleanups.push(() => harness.cleanup());
		const conversation = await harness.openStartup();
		const pair = createIrohStreamPair();
		const connection = serveIrohRemoteConnection({
			host: harness.host,
			conversation,
			stream: pair.host,
			grant: authorizationBase.rpcGrant,
			redaction: getRelaySanitizerOptions({ ...authorizationBase, worktreeId: "fix-login", worktreePath }, agentDir),
			// A relayed phone stays on the TUI's conversation.
			redirect: {},
		});
		cleanups.push(() => connection.close());
		const phone = connectRemotePhone(pair.phone);
		await phone.hello();
		await phone.subscribe(conversation.id);

		expect(await phone.intent("prompt", { message: text })).toMatchObject({ type: "accepted" });
		await vi.waitFor(() =>
			expect(phone.frames.filter((frame) => frame.type === "entry" && frame.entry.type === "message")).toHaveLength(
				2,
			),
		);
		const serialized = JSON.stringify(phone.frames);
		expect(serialized).not.toContain(parentPath);
		expect(serialized).not.toContain(worktreePath);
		expect(serialized).not.toContain(`${agentDir}/worktrees`);
		expect(serialized).toContain("/workspace/file.ts");
	});
});

describe("managed checkout paths (§5.2.3)", () => {
	it("isPathUnderWorktreesRoot identifies daemon-managed checkout paths", () => {
		const agentDir = makeTempDir("volt-wt-root-");
		const root = getWorktreesRoot(agentDir);
		expect(isPathUnderWorktreesRoot(agentDir, join(root, "--repo--", "fix-login"))).toBe(true);
		expect(isPathUnderWorktreesRoot(agentDir, join(root, "--repo--", "fix-login", "src"))).toBe(true);
		expect(isPathUnderWorktreesRoot(agentDir, root)).toBe(false);
		expect(isPathUnderWorktreesRoot(agentDir, join(agentDir, "repo"))).toBe(false);
		expect(isPathUnderWorktreesRoot(agentDir, join(tmpdir(), "unrelated"))).toBe(false);
	});
});

describe("trust pinning helpers (§5.2.1)", () => {
	it("resolveWorktreeParentCheckout derives the parent from the gitdir pointer", () => {
		const agentDir = makeTempDir("volt-wt-trust-");
		const parent = join(agentDir, "parent-repo");
		mkdirSync(parent, { recursive: true });
		const checkout = join(getWorktreesRoot(agentDir), "--parent-repo--", "fix-login");
		mkdirSync(checkout, { recursive: true });
		writeFileSync(join(checkout, ".git"), `gitdir: ${join(parent, ".git", "worktrees", "fix-login")}\n`);

		expect(resolveWorktreeParentCheckout(agentDir, checkout)).toBe(parent);
		expect(resolveWorktreeParentCheckout(agentDir, join(checkout, "src", "deep"))).toBe(parent);
	});

	it("returns undefined outside the worktrees root and for unparseable pointers", () => {
		const agentDir = makeTempDir("volt-wt-trust2-");
		expect(resolveWorktreeParentCheckout(agentDir, join(agentDir, "parent-repo"))).toBeUndefined();

		const noGit = join(getWorktreesRoot(agentDir), "--repo--", "no-git");
		mkdirSync(noGit, { recursive: true });
		expect(resolveWorktreeParentCheckout(agentDir, noGit)).toBeUndefined();

		const badPointer = join(getWorktreesRoot(agentDir), "--repo--", "bad-pointer");
		mkdirSync(badPointer, { recursive: true });
		writeFileSync(join(badPointer, ".git"), "gitdir: relative/path\n");
		expect(resolveWorktreeParentCheckout(agentDir, badPointer)).toBeUndefined();

		const notWorktreeGitdir = join(getWorktreesRoot(agentDir), "--repo--", "odd");
		mkdirSync(notWorktreeGitdir, { recursive: true });
		writeFileSync(join(notWorktreeGitdir, ".git"), `gitdir: ${join(agentDir, "somewhere", "else")}\n`);
		expect(resolveWorktreeParentCheckout(agentDir, notWorktreeGitdir)).toBeUndefined();
	});
});

describe("new session into a worktree (§5.2.1 cwd/sessionDir overrides)", () => {
	async function createRuntimeFixture(parentCwd: string, agentDir: string) {
		const createdSessions: Array<{
			cwd: string;
			sessionDir: string;
			sessionRef: SessionReference | undefined;
			workspaceName?: string;
			baseRef?: string;
		}> = [];
		const makeSessionDouble = (sessionManager: SessionManager): AgentSession =>
			({
				sessionManager,
				sessionWriter: sessionManager.logWriter,
				settingsManager: { subscribeExtensionSettings: () => () => {} },
				extensionRunner: { hasHandlers: () => false },
				disposeSubagentToolManager: vi.fn(),
				dispose: vi.fn(),
				waitForClosed: vi.fn(async () => {}),
				suspendAdmission: vi.fn(() => () => {}),
				settleInvokingCommandInput: vi.fn(async () => {}),
				subscribe: vi.fn(() => () => {}),
				lost: new Promise<Error>(() => {}),
				work: { reconcile: async () => {}, cancelAll: async () => {}, running: () => [], busy: () => false },
				get sessionRef() {
					return sessionManager.getSessionRef();
				},
				get sessionId() {
					return sessionManager.getSessionId();
				},
			}) as unknown as AgentSession;
		const makeServices = (cwd: string): AgentSessionServices =>
			({
				cwd,
				agentDir,
				settingsManager: { getRequestedProfile: () => undefined },
			}) as unknown as AgentSessionServices;
		const createRuntime = vi.fn(
			async (options: {
				cwd: string;
				sessionManager: SessionManager;
				workspaceName?: string;
				baseRef?: string;
			}): Promise<ConversationFactoryResult> => {
				createdSessions.push({
					cwd: options.cwd,
					sessionDir: options.sessionManager.getSessionDir(),
					sessionRef: options.sessionManager.getSessionRef(),
					workspaceName: options.workspaceName,
					baseRef: options.baseRef,
				});
				return {
					session: makeSessionDouble(options.sessionManager),
					services: makeServices(options.cwd),
					diagnostics: [],
				} as unknown as ConversationFactoryResult;
			},
		);
		const parentSessionDir = getDefaultSessionDir(agentDir);
		const initialManager = await SessionManager.create(parentCwd, parentSessionDir);
		const { host, conversation } = adoptTestSession(
			makeSessionDouble(initialManager),
			makeServices(parentCwd),
			createRuntime as never,
		);
		// The TUI's client of its host: its new sessions open there and it moves to them.
		const runtime = await connectTestClient(host, conversation);
		return { runtime, createRuntime, createdSessions, parentSessionDir };
	}

	it("creates the session with the worktree cwd in the session dir it is given", async () => {
		const {
			agentDir,
			workspacePath: parentCwd,
			checkoutPath: worktreeCwd,
			manager,
			stateManager,
		} = await createWorktreeFixture();
		const paths = getDaemonPaths(agentDir);
		ensureDaemonDirs(paths);
		const server = await startControlServer({
			socketPath: paths.socketPath,
			version: "test",
			handlers: {
				async onRequest(connection, request) {
					if (request.type !== "worktree_restore") throw new Error(`Unexpected request: ${request.type}`);
					await handleWorktreeControlRequest(connection, request, { manager, stateManager });
				},
			},
		});
		cleanups.push(() => server.close());
		const ensure = vi.spyOn(daemonSpawn, "ensureDaemonRunning").mockResolvedValue({
			healthy: true,
			state: "healthy",
			spawned: false,
			socketPath: paths.socketPath,
		});
		cleanups.push(() => {
			ensure.mockRestore();
		});
		const fixture = await createRuntimeFixture(parentCwd, agentDir);
		cleanups.push(() => releaseLocalSessionWorktree(fixture.runtime.session.sessionManager));

		const result = await fixture.runtime.newSession({
			cwd: worktreeCwd,
			sessionDir: fixture.parentSessionDir,
			workspaceName: "parent-workspace",
			baseRef: "origin/main",
		});
		expect(result).toEqual({
			cancelled: false,
			sessionId: fixture.runtime.session.sessionId,
			seeded: false,
		});
		expect(fixture.createdSessions).toHaveLength(1);
		const created = fixture.createdSessions[0]!;
		expect(created.cwd).toBe(worktreeCwd);
		expect(created.sessionDir).toBe(fixture.parentSessionDir);
		expect(created.workspaceName).toBe("parent-workspace");
		expect(created.baseRef).toBe("origin/main");
		expect(fixture.runtime.session.sessionManager.getCwd()).toBe(worktreeCwd);
		// The store lists it for its own directory once it has persisted content (session
		// files flush on the first assistant message); its workspace owns it through the worktree.
		await fixture.runtime.session.sessionWriter.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "worktree session" }],
			api: "openai-completions",
			provider: "openai",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		const listed = await SessionManager.list(worktreeCwd, fixture.parentSessionDir);
		expect(listed.some((info) => info.id === fixture.runtime.session.sessionManager.getSessionId())).toBe(true);
	});

	it("without overrides, newSession keeps the current cwd and session dir (unchanged behavior)", async () => {
		const agentDir = makeTempDir("volt-wt-newsession2-");
		const parentCwd = join(agentDir, "parent-repo");
		mkdirSync(parentCwd, { recursive: true });
		const fixture = await createRuntimeFixture(parentCwd, agentDir);

		await fixture.runtime.newSession();
		expect(fixture.createdSessions[0]).toMatchObject({ cwd: parentCwd, sessionDir: fixture.parentSessionDir });
	});
});
