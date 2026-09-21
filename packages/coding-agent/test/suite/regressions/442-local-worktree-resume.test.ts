import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
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
import { startControlServer } from "../../../src/daemon/control-server.ts";
import { ensureDaemonDirs, getDaemonPaths } from "../../../src/daemon/paths.ts";
import * as daemonSpawn from "../../../src/daemon/spawn.ts";
import {
	handleWorktreeControlRequest,
	isWorktreeControlRequest,
	WorktreeManager,
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

async function fixture() {
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
	expect(await manager.archiveDisposable(workspace.name, record.id)).toEqual({ removed: true });
	expect(existsSync(record.path)).toBe(false);

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
		state,
		manager,
		record,
		ref,
		factory,
		requests,
		ensureDaemon,
	};
}

describe("#442 local archived-worktree resume", () => {
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

	it("restores CLI continuation before missing-cwd handling and provider startup", async () => {
		const f = await fixture();
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
		vi.stubEnv(ENV_SESSION_DIR, f.sessionDir);
		vi.stubEnv("VOLT_PROFILE", "");
		vi.stubEnv("VOLT_OFFLINE", "1");
		vi.stubEnv("VOLT_SKIP_VERSION_CHECK", "1");
		const selector = vi.spyOn(startupUi, "showStartupSelector");
		f.harness.setResponses([fauxAssistantMessage("Restored")]);
		try {
			process.chdir(f.source);
			Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
			await main([
				"--continue",
				"--print",
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
