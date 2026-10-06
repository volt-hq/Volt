/**
 * A daemon on a temporary agent directory, run in this process with its real
 * control socket (Phase 7 plan §7, "New harness"). Its conversation workers
 * run in this process too (`InProcessWorkerLauncher`) and connect over that
 * socket with role `worker`; they reach the faux provider this harness
 * registers, so no real provider is involved. One workspace is registered.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxProvider, type FauxProvider } from "@hansjm10/volt-ai";
import { getDefaultSessionDir, SessionManager, type SessionReference } from "../../src/core/session-manager.ts";
import { createDaemonClient, type DaemonClient } from "../../src/daemon/control-client.ts";
import type { ControlResponse, WorkerSpawnSpec } from "../../src/daemon/control-protocol.ts";
import { runVoltDaemon, type VoltdRuntimeServices, type VoltdServiceExtension } from "../../src/daemon/main.ts";
import { probeDaemon } from "../../src/daemon/spawn.ts";
import { InProcessWorkerLauncher, type WorkerLauncher } from "../../src/daemon/worker-launcher.ts";
import type { LiveWorker, WorkerClientKind, WorkerRegistry } from "../../src/daemon/worker-registry.ts";

export interface DaemonHarnessOptions {
	/** Daemon service extensions beside the control plane, such as the Iroh service. */
	readonly extensions?: readonly VoltdServiceExtension[];
	/** How workers start; in this process by default. */
	readonly workerLauncher?: WorkerLauncher;
	/** `remote.detachedRuntimeTtlMs`; the daemon's default otherwise. */
	readonly detachedRuntimeTtlMs?: number;
}

/** What a harness worker opens beside its stored session. */
export type HarnessSpawn = Partial<Omit<WorkerSpawnSpec, "workerId" | "session" | "workspace">>;

export interface DaemonHarness {
	readonly agentDir: string;
	readonly workspaceName: string;
	readonly workspacePath: string;
	readonly faux: FauxProvider;
	/** A CLI control connection to the daemon. */
	readonly control: DaemonClient;
	readonly services: VoltdRuntimeServices;
	readonly workers: WorkerRegistry;
	/** The workspace's current authority generation. */
	generation(): number;
	/** A stored, empty session in the workspace. */
	createSession(): Promise<SessionReference>;
	/**
	 * Open `ref` in a worker as a phone's open does: resolves with the live
	 * worker hosting it, through a spawn when none does. With `attach`, a
	 * client of that kind attaches with the lookup until `release`; without,
	 * the worker is left detached.
	 */
	openWorker(
		ref: SessionReference,
		options?: { spawn?: HarnessSpawn; attach?: WorkerClientKind },
	): Promise<{ worker: LiveWorker; release: () => void }>;
	status(): Promise<Extract<ControlResponse, { type: "status_result" }>>;
	/** Shut the daemon down; resolves with its exit code. */
	shutdown(): Promise<number>;
	/** Shut the daemon down and remove its directory. */
	dispose(): Promise<void>;
}

export async function createDaemonHarness(options: DaemonHarnessOptions = {}): Promise<DaemonHarness> {
	const root = mkdtempSync(join(tmpdir(), "volt-daemon-harness-"));
	const agentDir = join(root, "agent");
	const workspacePath = realpathSync.native(root);
	mkdirSync(join(workspacePath, "ws"), { recursive: true });
	const workspaceDir = join(workspacePath, "ws");
	mkdirSync(agentDir, { recursive: true });
	const faux = createFauxProvider();
	const model = faux.getModel();
	writeFileSync(
		join(agentDir, "models.json"),
		`${JSON.stringify({
			providers: {
				[model.provider]: {
					api: model.api,
					apiKey: "faux-key",
					baseUrl: model.baseUrl,
					models: [{ id: model.id }],
				},
			},
		})}\n`,
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		`${JSON.stringify({ defaultProvider: model.provider, defaultModel: model.id })}\n`,
	);

	let services: VoltdRuntimeServices | undefined;
	const capture: VoltdServiceExtension = (runtime) => {
		services = runtime;
		return {};
	};
	const daemon = runVoltDaemon(
		{ agentDir, foreground: false, workerLauncher: options.workerLauncher ?? new InProcessWorkerLauncher() },
		[capture, ...(options.extensions ?? [])],
	);
	let probe = await probeDaemon(agentDir);
	for (let attempt = 0; !probe.healthy && attempt < 100; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
		probe = await probeDaemon(agentDir);
	}
	if (!probe.healthy || !services) throw new Error("The harness daemon did not start");
	const runtime: VoltdRuntimeServices = services;
	if (options.detachedRuntimeTtlMs !== undefined) {
		runtime.state.updateSettings({ detachedRuntimeTtlMs: options.detachedRuntimeTtlMs });
	}
	const control = createDaemonClient({
		socketPath: probe.socketPath,
		client: "cli",
		version: "test",
		...(probe.authToken === undefined ? {} : { authToken: probe.authToken }),
		reconnect: false,
	});
	await control.connect();
	const workspaceName = "ws";
	const registered = await control.request({ type: "workspace_register", name: workspaceName, path: workspaceDir });
	if (registered.type !== "ok") throw new Error(`The harness workspace was not registered: ${registered.type}`);

	const generation = (): number => {
		const record = runtime.state
			.getHostState()
			.workspaceGenerations?.find((candidate) => candidate.workspaceName === workspaceName);
		if (record === undefined) throw new Error("The harness workspace has no generation");
		return record.generation;
	};
	let stopped: Promise<number> | undefined;
	let disposed: Promise<void> | undefined;
	const shutdown = (): Promise<number> => {
		stopped ??= (async () => {
			try {
				await control.request({ type: "shutdown" }).catch(() => undefined);
				return await daemon;
			} finally {
				await control.close().catch(() => undefined);
			}
		})();
		return stopped;
	};

	return {
		agentDir,
		workspaceName,
		workspacePath: workspaceDir,
		faux,
		control,
		services: runtime,
		workers: runtime.workers,
		generation,
		async createSession() {
			const manager = await SessionManager.create(workspaceDir, getDefaultSessionDir(workspaceDir, agentDir));
			const ref = manager.getSessionRef();
			await manager.closePersistence();
			if (!ref) throw new Error("The harness session has no reference");
			return ref;
		},
		openWorker(ref, openOptions = {}) {
			const kind = openOptions.attach;
			const current = generation();
			return runtime.workers.open(
				{ workspaceName, workspaceGeneration: current, sessionId: ref.sessionId },
				{
					origin: "phone",
					prepare: async () => ({
						origin: "phone",
						workspace: { name: workspaceName, path: workspaceDir, generation: current },
						session: ref,
						cwd: workspaceDir,
						root: workspaceDir,
						projectCwd: workspaceDir,
						toolPolicy: { tools: ["read"], allowUnlistedExtensionTools: false },
						projectTrusted: false,
						...openOptions.spawn,
					}),
					attach: (worker) => ({ worker, release: kind === undefined ? () => {} : worker.attach(kind) }),
				},
			);
		},
		async status() {
			const status = await control.request({ type: "status" });
			if (status.type !== "status_result") throw new Error(`Unexpected ${status.type}`);
			return status;
		},
		shutdown,
		dispose() {
			disposed ??= (async () => {
				try {
					await shutdown();
				} finally {
					rmSync(root, { recursive: true, force: true });
				}
			})();
			return disposed;
		},
	};
}
