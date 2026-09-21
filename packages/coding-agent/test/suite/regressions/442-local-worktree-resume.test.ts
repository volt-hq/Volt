import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as startupUi from "../../../src/cli/startup-ui.ts";
import { ENV_AGENT_DIR, ENV_SESSION_DIR } from "../../../src/config.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { restoreStdout } from "../../../src/core/output-guard.ts";
import { IrohRemoteAuditLogger } from "../../../src/core/remote/iroh/audit.ts";
import { createEmptyIrohRemoteHostState, writeIrohRemoteHostState } from "../../../src/core/remote/iroh/state.ts";
import { IrohRemoteHostStateManager } from "../../../src/core/remote/iroh/state-manager.ts";
import { getDefaultSessionDirPath, SessionManager } from "../../../src/core/session-manager.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { stopThemeWatcher } from "../../../src/core/theme/runtime.ts";
import { createDaemonClient } from "../../../src/daemon/control-client.ts";
import { isControlRequest } from "../../../src/daemon/control-protocol.ts";
import { startControlServer } from "../../../src/daemon/control-server.ts";
import { ensureDaemonDirs, getDaemonPaths } from "../../../src/daemon/paths.ts";
import * as daemonSpawn from "../../../src/daemon/spawn.ts";
import { tryAcquireWorktreeLock } from "../../../src/daemon/worktree-lock.ts";
import {
	handleWorktreeControlRequest,
	isWorktreeControlRequest,
	WorktreeManager,
	WorktreeRetentionSweeper,
} from "../../../src/daemon/worktree-manager.ts";
import { main } from "../../../src/main.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness } from "../harness.ts";
import { createPrReviewGitSeed } from "../pr-review-git-fixture.ts";

let seed: ReturnType<typeof createPrReviewGitSeed>;
const cleanups: Array<() => Promise<void>> = [];
beforeAll(() => {
	seed = createPrReviewGitSeed("base\n", "PR head");
});
afterAll(() => seed?.dispose());
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

async function fixture(archive = true) {
	const harness = await createHarness({ settings: { lsp: { enabled: false } } });
	cleanups.push(() => harness.cleanupAsync());
	const root = realpathSync(harness.tempDir);
	const source = join(root, "workspace");
	seed.copyTo(source, join(root, "remote.git"));
	const agentDir = join(root, "agent");
	const paths = getDaemonPaths(agentDir);
	ensureDaemonDirs(paths);
	const statePath = join(root, "state.json");
	const workspace = { name: "project", path: source };
	await writeIrohRemoteHostState(statePath, { ...createEmptyIrohRemoteHostState(), workspaces: [workspace] });
	const state = new IrohRemoteHostStateManager({ statePath });
	const manager = new WorktreeManager({
		agentDir,
		stateManager: state,
		auditLogger: new IrohRemoteAuditLogger({ sink: { write: () => {} } }),
		maxWorktreesPerWorkspace: 1,
		hasActiveRuntimeForSession: () => false,
		reserveSessionsForRemoval: () => () => {},
	});
	const created = await manager.create(workspace, { id: "local" });
	if (!created.ok) throw new Error(created.error);
	const record = created.worktree;
	const sessionDir = getDefaultSessionDirPath(source, agentDir);
	const session = await SessionManager.create(record.path, sessionDir, { id: "local-session" });
	session.appendMessage({ role: "user", content: "Retained conversation", timestamp: Date.now() });
	await session.flush();
	const ref = session.getSessionRef()!;
	await session.closePersistence();
	await manager.bindSession(workspace.name, record.id, ref.sessionId);
	if (archive) {
		expect(await manager.archiveDisposable(workspace.name, record.id)).toEqual({ removed: true });
		expect(existsSync(record.path)).toBe(false);
	}

	const requests: string[] = [];
	const server = await startControlServer({
		socketPath: paths.socketPath,
		version: "test",
		handlers: {
			async onRequest(connection, request) {
				requests.push(request.type);
				if (!isWorktreeControlRequest(request)) throw new Error(`Unexpected request: ${request.type}`);
				await handleWorktreeControlRequest(connection, request, { manager, stateManager: state });
			},
		},
	});
	cleanups.push(() => server.close());
	const ensureDaemon = vi.spyOn(daemonSpawn, "ensureDaemonRunning").mockResolvedValue({
		healthy: true,
		state: "healthy",
		spawned: false,
		socketPath: paths.socketPath,
	});
	const factory: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: harness.authStorage,
			settingsManager: SettingsManager.inMemory({ lsp: { enabled: false } }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: harness.getModel(),
				noTools: "all",
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	return {
		harness,
		source,
		agentDir,
		sessionDir,
		workspace,
		statePath,
		state,
		manager,
		record,
		ref,
		factory,
		requests,
		ensureDaemon,
		server,
	};
}

describe("#442 local archived-worktree resume", () => {
	it("requires a complete session reference on the local control protocol", () => {
		const request = { type: "worktree_restore", id: "request", path: "/checkout" };
		const sessionRef = {
			sessionDirectory: "/sessions",
			storeId: "store",
			sessionId: "session",
			sessionGeneration: "generation",
		};
		expect(isControlRequest({ ...request, sessionRef })).toBe(true);
		expect(isControlRequest({ ...request, sessionId: "session" })).toBe(false);
		for (const field of Object.keys(sessionRef)) {
			expect(isControlRequest({ ...request, sessionRef: { ...sessionRef, [field]: "" } })).toBe(false);
		}
	});

	it.each(["default", "custom"])("restores unbound local sessions from their %s store", async (store) => {
		const f = await fixture(false);
		vi.stubEnv(ENV_AGENT_DIR, f.agentDir);
		const local = await SessionManager.create(
			f.record.path,
			store === "custom" ? join(f.harness.tempDir, "custom-sessions") : undefined,
		);
		const ref = local.getSessionRef()!;
		await local.closePersistence();
		expect(ref.sessionDirectory).not.toBe(f.sessionDir);
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({ removed: true });
		const runtime = await createAgentSessionRuntime(f.factory, {
			cwd: f.record.path,
			agentDir: f.agentDir,
			sessionManager: await SessionManager.open(ref),
		});
		cleanups.push(() => runtime.dispose());
		expect(runtime.cwd).toBe(f.record.path);
		expect(runtime.session.sessionId).toBe(ref.sessionId);
		expect(await f.state.findWorktreeForSession(f.workspace.name, ref.sessionId)).toBeUndefined();
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({
			removed: false,
			reason: "busy",
		});
		await runtime.dispose();
		await vi.waitFor(() => expect(f.server.connections()).toHaveLength(0));
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({ removed: true });
	});

	it.each(["store", "generation", "cwd", "same-id-other-store"])(
		"rejects an invalid %s reference even with an existing ID binding",
		async (invalid) => {
			const f = await fixture();
			let sessionRef = f.ref;
			if (invalid === "store") sessionRef = { ...f.ref, storeId: "wrong-store" };
			if (invalid === "generation") {
				await SessionManager.delete(f.ref);
				const replacement = await SessionManager.create(f.record.path, f.sessionDir, { id: f.ref.sessionId });
				await replacement.closePersistence();
			}
			if (invalid === "same-id-other-store") {
				const other = await SessionManager.create(f.source, join(f.harness.tempDir, "other-store"), {
					id: f.ref.sessionId,
				});
				sessionRef = other.getSessionRef()!;
				await other.closePersistence();
			}
			const client = createDaemonClient({
				socketPath: f.server.socketPath,
				client: "cli",
				version: "test",
				reconnect: false,
			});
			cleanups.push(() => client.close());
			expect(
				await client.request({
					type: "worktree_restore",
					path: invalid === "cwd" ? join(f.record.path, "subdirectory") : f.record.path,
					sessionRef,
				}),
			).toMatchObject({ type: "error", code: "worktree_restore_failed" });
			expect(existsSync(f.record.path)).toBe(false);
			expect(await f.manager.create(f.workspace, { id: "after-rejection" })).toMatchObject({ ok: true });
		},
	);

	it.each(["startup", "switch"])("restores the original checkout before runtime %s", async (mode) => {
		const f = await fixture();
		const runtime = await createAgentSessionRuntime(f.factory, {
			cwd: mode === "startup" ? f.record.path : f.source,
			agentDir: f.agentDir,
			sessionManager: mode === "startup" ? await SessionManager.open(f.ref) : SessionManager.inMemory(f.source),
		});
		cleanups.push(() => runtime.dispose());
		if (mode === "switch") await runtime.switchSession(f.ref);
		expect(runtime.cwd).toBe(f.record.path);
		expect(runtime.session.sessionId).toBe(f.ref.sessionId);
		expect(runtime.session.messages).toMatchObject([{ role: "user", content: "Retained conversation" }]);
		expect(git(f.record.path, "rev-parse", "HEAD")).toBe(git(f.source, "rev-parse", "HEAD"));
		expect((await f.state.listWorktrees())[0].checkoutArchive).toBeUndefined();
		expect(f.requests).toContain("worktree_restore");
	});

	it.each(["startup", "switch"])("finishes interrupted restoration before runtime %s", async (mode) => {
		const f = await fixture();
		const archived = (await f.state.listWorktrees())[0];
		await f.state.upsertWorktree({
			...archived,
			checkoutArchive: { ...archived.checkoutArchive!, restoring: true },
		});
		git(f.source, "worktree", "add", "--no-checkout", f.record.path, f.record.branch);
		expect(existsSync(join(f.record.path, "value.txt"))).toBe(false);
		const runtime = await createAgentSessionRuntime(f.factory, {
			cwd: mode === "startup" ? f.record.path : f.source,
			agentDir: f.agentDir,
			sessionManager: mode === "startup" ? await SessionManager.open(f.ref) : SessionManager.inMemory(f.source),
		});
		cleanups.push(() => runtime.dispose());
		if (mode === "switch") await runtime.switchSession(f.ref);
		expect(readFileSync(join(runtime.cwd, "value.txt"), "utf8")).toBe("base\n");
		expect((await f.state.listWorktrees())[0].checkoutArchive).toBeUndefined();
		await expect(f.manager.bindSession(f.workspace.name, f.record.id, f.ref.sessionId)).resolves.toBeUndefined();
	});

	it("protects startup and same-checkout replacements until switching away", async () => {
		const f = await fixture();
		const runtime = await createAgentSessionRuntime(
			async (options) => {
				if (options.cwd === f.record.path)
					expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({
						removed: false,
						reason: "busy",
					});
				return f.factory(options);
			},
			{
				cwd: f.record.path,
				agentDir: f.agentDir,
				sessionManager: await SessionManager.open(f.ref),
			},
		);
		cleanups.push(() => runtime.dispose());
		await runtime.newSession();
		expect(await f.manager.create(f.workspace, { id: "blocked" })).toMatchObject({
			ok: false,
			error: "worktree_limit_reached",
		});
		await runtime.newSession({ cwd: f.source });
		await vi.waitFor(() => expect(f.server.connections()).toHaveLength(0));
		expect(await f.manager.create(f.workspace, { id: "replacement" })).toMatchObject({ ok: true });
		expect(existsSync(f.record.path)).toBe(false);
	});

	it.each(["disconnect", "restart"])("protects active local work through daemon %s", async (failure) => {
		const f = await fixture();
		const runtime = await createAgentSessionRuntime(f.factory, {
			cwd: f.record.path,
			agentDir: f.agentDir,
			sessionManager: await SessionManager.open(f.ref),
		});
		cleanups.push(() => runtime.dispose());
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		f.harness.setResponses([
			async () => {
				entered.resolve();
				await finish.promise;
				return fauxAssistantMessage("Continued safely");
			},
		]);
		const turn = runtime.session.prompt("Continue");
		try {
			await entered.promise;
			for (const connection of f.server.connections()) connection.close();
			await vi.waitFor(() => expect(f.server.connections()).toHaveLength(0));
			const state = failure === "restart" ? new IrohRemoteHostStateManager({ statePath: f.statePath }) : f.state;
			const auditLogger = new IrohRemoteAuditLogger({ sink: { write: () => {} } });
			const manager =
				failure === "restart"
					? new WorktreeManager({
							agentDir: f.agentDir,
							stateManager: state,
							auditLogger,
							maxWorktreesPerWorkspace: 1,
							hasActiveRuntimeForSession: () => false,
							reserveSessionsForRemoval: () => () => {},
						})
					: f.manager;
			expect(runtime.session.isStreaming).toBe(true);
			expect(await manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({
				removed: false,
				reason: "busy",
			});
			expect(await manager.create(f.workspace, { id: "capacity-pressure" })).toMatchObject({
				ok: false,
				error: "worktree_limit_reached",
			});
			expect(await manager.remove(f.workspace, f.record.id, { force: true })).toEqual({
				ok: false,
				error: "worktree_busy",
			});
			const swept = Promise.withResolvers<void>();
			const sweeper = new WorktreeRetentionSweeper({
				manager,
				stateManager: state,
				auditLogger: new IrohRemoteAuditLogger({
					sink: {
						write: (event) => {
							if (event.type === "worktree_retention_skipped_dirty" && event.details?.reason === "busy")
								swept.resolve();
						},
					},
				}),
				getRetentionPolicy: () => ({ enabled: true, ttlMs: 60_000 }),
				now: () => Date.now() + 120_000,
			});
			try {
				await swept.promise;
			} finally {
				sweeper.dispose();
			}
			expect(existsSync(f.record.path)).toBe(true);
			expect(runtime.session.isStreaming).toBe(true);
		} finally {
			finish.resolve();
			await turn;
		}
		expect(runtime.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Continued safely" }],
		});
		// Same-cwd replacement inherits the actual lock, not a stale socket state.
		await runtime.newSession();
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({
			removed: false,
			reason: "busy",
		});
		await runtime.dispose();
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({ removed: true });
	});

	it("refuses cwd-bound startup while reclamation owns the exclusive lock", async () => {
		const f = await fixture(false);
		const lock = tryAcquireWorktreeLock(f.agentDir, f.record.path, false)!;
		const factory = vi.fn(f.factory);
		try {
			await expect(
				createAgentSessionRuntime(factory, {
					cwd: f.record.path,
					agentDir: f.agentDir,
					sessionManager: await SessionManager.open(f.ref),
				}),
			).rejects.toThrow("being reclaimed");
			expect(factory).not.toHaveBeenCalled();
		} finally {
			lock.close();
		}
		await vi.waitFor(() => expect(f.server.connections()).toHaveLength(0));
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({ removed: true });
	});

	it("protects an ephemeral managed-checkout session without a daemon connection", async () => {
		const f = await fixture(false);
		const runtime = await createAgentSessionRuntime(f.factory, {
			cwd: f.record.path,
			agentDir: f.agentDir,
			sessionManager: SessionManager.inMemory(f.record.path),
		});
		cleanups.push(() => runtime.dispose());
		expect(f.requests).toEqual([]);
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({
			removed: false,
			reason: "busy",
		});
		await runtime.dispose();
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({ removed: true });
	});

	it("releases protection when runtime creation fails", async () => {
		const f = await fixture();
		await expect(
			createAgentSessionRuntime(
				async () => {
					expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({
						removed: false,
						reason: "busy",
					});
					throw new Error("factory failed");
				},
				{
					cwd: f.record.path,
					agentDir: f.agentDir,
					sessionManager: await SessionManager.open(f.ref),
				},
			),
		).rejects.toThrow("factory failed");
		await vi.waitFor(() => expect(f.server.connections()).toHaveLength(0));
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({ removed: true });
	});

	it("releases late restore completions on disconnect without releasing another owner's pin", async () => {
		const f = await fixture();
		const first = createDaemonClient({
			socketPath: f.server.socketPath,
			client: "cli",
			version: "test",
			reconnect: false,
		});
		const second = createDaemonClient({
			socketPath: f.server.socketPath,
			client: "cli",
			version: "test",
			reconnect: false,
		});
		cleanups.push(
			() => first.close(),
			() => second.close(),
		);
		const request = { type: "worktree_restore", path: f.record.path, sessionRef: f.ref } as const;
		expect(await first.request(request)).toMatchObject({ type: "ok" });
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const acquire = f.manager.acquireLocalSessionWorktree.bind(f.manager);
		vi.spyOn(f.manager, "acquireLocalSessionWorktree").mockImplementationOnce(async (...args) => {
			const release = await acquire(...args);
			entered.resolve();
			await finish.promise;
			return release;
		});
		const pending = expect(second.request(request)).rejects.toThrow("daemon connection closed");
		try {
			await entered.promise;
			await second.close();
			await pending;
			await vi.waitFor(() => expect(f.server.connections()).toHaveLength(1));
		} finally {
			finish.resolve();
		}
		await f.server.quiesce();
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({
			removed: false,
			reason: "busy",
		});
		await first.close();
		await vi.waitFor(() => expect(f.server.connections()).toHaveLength(0));
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({ removed: true });
	});

	it("retains protection until asynchronous runtime teardown finishes", async () => {
		const f = await fixture();
		const runtime = await createAgentSessionRuntime(f.factory, {
			cwd: f.record.path,
			agentDir: f.agentDir,
			sessionManager: await SessionManager.open(f.ref),
		});
		cleanups.push(() => runtime.dispose());
		for (const connection of f.server.connections()) connection.close();
		await vi.waitFor(() => expect(f.server.connections()).toHaveLength(0));
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const dispose = runtime.session.disposeSubagentToolManager.bind(runtime.session);
		vi.spyOn(runtime.session, "disposeSubagentToolManager").mockImplementationOnce(async () => {
			entered.resolve();
			await finish.promise;
			await dispose();
		});
		const closing = runtime.dispose();
		try {
			await entered.promise;
			expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({
				removed: false,
				reason: "busy",
			});
		} finally {
			finish.resolve();
			await closing;
		}
		await vi.waitFor(() => expect(f.server.connections()).toHaveLength(0));
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({ removed: true });
	});

	it("does not re-enter local restoration for a runtime owned by the same daemon process", async () => {
		const f = await fixture();
		const preparation = await f.manager.beginRuntimePreparation(f.workspace.name, f.record.id, f.ref.sessionId);
		cleanups.push(() => preparation.release());
		f.ensureDaemon.mockResolvedValue({
			healthy: true,
			state: "healthy",
			spawned: false,
			socketPath: f.server.socketPath,
			pid: process.pid,
		});
		const runtime = await createAgentSessionRuntime(f.factory, {
			cwd: f.record.path,
			agentDir: f.agentDir,
			sessionManager: await SessionManager.open(f.ref),
		});
		cleanups.push(() => runtime.dispose());
		expect(f.requests).not.toContain("worktree_restore");
		await preparation.release();
		expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({
			removed: false,
			reason: "busy",
		});
	});

	it.each([
		["branch", "branch changed"],
		["capacity", "capacity exhausted"],
		["binding", "does not match"],
		["daemon", "voltd is unavailable"],
	])("cancels local /resume on %s failures without exiting the current session", async (failure, message) => {
		const f = await fixture();
		if (failure === "branch") git(f.source, "branch", "-f", f.record.branch, "topic");
		if (failure === "capacity")
			expect(await f.manager.create(f.workspace, { id: "protected" })).toMatchObject({ ok: true });
		if (failure === "binding") {
			const other = await f.manager.create(f.workspace, { id: "other" });
			if (!other.ok) throw new Error(other.error);
			await f.state.upsertWorktree({
				...(await f.state.listWorktrees()).find((record) => record.id === f.record.id)!,
				sessionIds: [],
			});
			await f.manager.bindSession(f.workspace.name, other.worktree.id, f.ref.sessionId);
		}
		if (failure === "daemon")
			f.ensureDaemon.mockResolvedValue({
				healthy: false,
				state: "not-running",
				spawned: false,
				socketPath: "unused",
			});
		const runtime = await createAgentSessionRuntime(f.factory, {
			cwd: f.source,
			agentDir: f.agentDir,
			sessionManager: SessionManager.inMemory(f.source),
		});
		cleanups.push(() => runtime.dispose());
		const previous = runtime.session;
		const showError = vi.fn();
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: runtime,
			statusContainer: { clear: vi.fn() },
			showError,
		}) as InteractiveMode;
		const resume = Reflect.get(InteractiveMode.prototype, "handleResumeSession") as (
			this: InteractiveMode,
			ref: typeof f.ref,
		) => Promise<{ cancelled: boolean; seeded: boolean }>;
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("Unexpected TUI exit");
		});
		await expect(resume.call(context, f.ref)).resolves.toEqual({ cancelled: true, seeded: false });
		expect(showError).toHaveBeenCalledWith(expect.stringContaining(message));
		expect(process.exit).not.toHaveBeenCalled();
		expect(runtime.session).toBe(previous);
		expect(runtime.cwd).toBe(f.source);
		expect(existsSync(f.record.path)).toBe(false);
		const retained = await SessionManager.open(f.ref);
		try {
			expect(retained.getCwd()).toBe(f.record.path);
		} finally {
			await retained.closePersistence();
		}
	});

	it.each([
		["print", "continue"],
		["json", "continue"],
		["print", "fresh-default"],
		["json", "fresh-default"],
		["print", "fresh-custom"],
		["json", "fresh-custom"],
	])("protects CLI %s %s through provider completion", async (mode, start) => {
		const f = await fixture(start === "continue");
		const previousCwd = process.cwd();
		const previousExitCode = process.exitCode;
		const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const model = f.harness.getModel();
		writeFileSync(
			join(f.agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[model.provider]: {
						api: f.harness.faux.api,
						apiKey: "faux-key",
						baseUrl: model.baseUrl,
						models: f.harness.faux.models,
					},
				},
			}),
		);
		vi.stubEnv("HOME", f.harness.tempDir);
		vi.stubEnv(ENV_AGENT_DIR, f.agentDir);
		vi.stubEnv(
			ENV_SESSION_DIR,
			start === "continue"
				? f.sessionDir
				: start === "fresh-custom"
					? join(f.harness.tempDir, "custom-sessions")
					: "",
		);
		vi.stubEnv("VOLT_PROFILE", "");
		vi.stubEnv("VOLT_OFFLINE", "1");
		vi.stubEnv("VOLT_SKIP_VERSION_CHECK", "1");
		const selector = vi.spyOn(startupUi, "showStartupSelector");
		let reclamation: Awaited<ReturnType<WorktreeManager["create"]>> | undefined;
		f.harness.setResponses([
			async () => {
				reclamation = await f.manager.create(f.workspace, { id: "during-prompt" });
				return fauxAssistantMessage("Restored");
			},
		]);
		try {
			process.chdir(start === "continue" ? f.source : f.record.path);
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
			await main([
				...(start === "continue" ? ["--continue"] : []),
				...(mode === "print" ? ["--print"] : ["--mode", "json"]),
				"--offline",
				"--no-approve",
				"--no-extensions",
				"--no-skills",
				"--no-themes",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-tools",
				"--provider",
				model.provider,
				"--model",
				model.id,
				"Resume",
			]);
			expect(selector).not.toHaveBeenCalled();
			expect(existsSync(f.record.path)).toBe(true);
			expect(f.harness.getPendingResponseCount()).toBe(0);
			expect(process.exitCode).not.toBe(1);
			expect(reclamation).toMatchObject({ ok: false, error: "worktree_limit_reached" });
			await vi.waitFor(() => expect(f.server.connections()).toHaveLength(0));
			expect(await f.manager.archiveDisposable(f.workspace.name, f.record.id)).toEqual({ removed: true });
		} finally {
			restoreStdout();
			stopThemeWatcher();
			process.chdir(previousCwd);
			process.exitCode = previousExitCode;
			if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
			else Reflect.deleteProperty(process.stdin, "isTTY");
		}
	});
});
