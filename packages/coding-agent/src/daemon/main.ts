import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { getAgentDir, VERSION } from "../config.ts";
import { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import type {
	ControlClientStatus,
	ControlLeaseStatus,
	ControlRequest,
	ControlWorkspaceStatus,
} from "./control-protocol.ts";
import { PROTOCOL_VERSION } from "./control-protocol.ts";
import {
	type ControlConnection,
	type ControlServer,
	probeControlSocket,
	startControlServer,
} from "./control-server.ts";
import type { DaemonLogger } from "./log.ts";
import { createDaemonLogger } from "./log.ts";
import { type DaemonPaths, ensureDaemonDirs, getDaemonPaths } from "./paths.ts";
import { VoltdStateStore } from "./state.ts";

export interface Clock {
	now(): number;
}

export interface VoltdConfig {
	agentDir?: string;
	socketPath?: string;
	logPath?: string;
	foreground: boolean;
	clock?: Clock;
}

export interface PidfileContents {
	pid: number;
	version: string;
	startedAtMs: number;
	socketPath: string;
}

export function readPidfile(pidfilePath: string): PidfileContents | undefined {
	try {
		const parsed = JSON.parse(readFileSync(pidfilePath, "utf8")) as Partial<PidfileContents>;
		if (typeof parsed.pid !== "number" || typeof parsed.socketPath !== "string") {
			return undefined;
		}
		return {
			pid: parsed.pid,
			version: typeof parsed.version === "string" ? parsed.version : "unknown",
			startedAtMs: typeof parsed.startedAtMs === "number" ? parsed.startedAtMs : 0,
			socketPath: parsed.socketPath,
		};
	} catch {
		return undefined;
	}
}

export const VOLTD_EXIT_ALREADY_RUNNING = 3;
export const VOLTD_EXIT_BIND_FAILED = 4;

/** Facilities later milestones build on (lease broker, Iroh host, theme service). */
export interface VoltdRuntimeServices {
	agentDir: string;
	paths: DaemonPaths;
	logger: DaemonLogger;
	state: VoltdStateStore;
	stateManager: IrohRemoteHostStateManager;
	auditLogger: IrohRemoteAuditLogger;
	controlServer: ControlServer;
	requestShutdown(reason: "cli" | "signal"): void;
}

export interface VoltdServiceExtensionInstance {
	/** Extra request handling; return true when the request was handled. */
	handleRequest?(connection: ControlConnection, request: ControlRequest): Promise<boolean> | boolean;
	onConnectionClosed?(connection: ControlConnection): void;
	statusExtras?(): { leases?: ControlLeaseStatus[]; phoneConnections?: number };
	shutdown?(): Promise<void>;
}

export type VoltdServiceExtension = (services: VoltdRuntimeServices) => VoltdServiceExtensionInstance;

export async function runVoltDaemon(config: VoltdConfig, extensions: VoltdServiceExtension[] = []): Promise<number> {
	process.title = "voltd";
	const agentDir = config.agentDir ?? getAgentDir();
	const basePaths = getDaemonPaths(agentDir);
	const paths: DaemonPaths = {
		...basePaths,
		socketPath: config.socketPath ?? basePaths.socketPath,
		logPath: config.logPath ?? basePaths.logPath,
	};
	ensureDaemonDirs(paths);
	const logger = createDaemonLogger({
		logPath: paths.logPath,
		echoToStderr: config.foreground && process.stderr.isTTY,
	});
	const log = logger.child("daemon");
	const clock: Clock = config.clock ?? { now: () => Date.now() };
	const startedAtMs = clock.now();

	const state = new VoltdStateStore({ agentDir, statePath: paths.statePath });
	let migratedFromLegacyState = false;
	try {
		migratedFromLegacyState = (await state.load()).migratedFromLegacyState;
	} catch (error) {
		log("error", `failed to load state: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const stateManager = new IrohRemoteHostStateManager({
		store: {
			read: () => state.getHostState(),
			write: (hostState) => {
				state.setHostState(hostState);
			},
		},
	});
	const auditLogger = new IrohRemoteAuditLogger({ path: paths.auditPath });

	let shuttingDown = false;
	let resolveExit: ((code: number) => void) | undefined;
	const exitPromise = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});

	const extensionInstances: VoltdServiceExtensionInstance[] = [];
	let controlServer: ControlServer | undefined;

	const shutdown = async (reason: "cli" | "signal") => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		log("info", `shutting down (${reason})`);
		for (const extension of extensionInstances) {
			try {
				await extension.shutdown?.();
			} catch (error) {
				log("error", `extension shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		controlServer?.broadcast({ type: "daemon_shutdown" });
		await state.close().catch(() => {});
		await auditLogger.log({ type: "daemon_shutdown", success: true, details: { reason } }).catch(() => {});
		await controlServer?.close().catch(() => {});
		rmSync(paths.pidfilePath, { force: true });
		log("info", "shutdown complete");
		resolveExit?.(0);
	};

	const requestShutdown = (reason: "cli" | "signal") => {
		void shutdown(reason);
	};

	const toClientStatuses = (): ControlClientStatus[] =>
		state.state.clients.map((client) => ({
			clientNodeId: client.nodeId,
			...(client.label === undefined ? {} : { label: client.label }),
			pairedAtMs: client.pairedAt ?? 0,
		}));

	const handleRequest = async (connection: ControlConnection, request: ControlRequest): Promise<void> => {
		for (const extension of extensionInstances) {
			if (await extension.handleRequest?.(connection, request)) {
				return;
			}
		}
		switch (request.type) {
			case "status": {
				const workspaces: ControlWorkspaceStatus[] = state.state.workspaces.map((workspace) => ({
					name: workspace.name,
					path: workspace.path,
				}));
				let leases: ControlLeaseStatus[] = [];
				let phoneConnections = 0;
				for (const extension of extensionInstances) {
					const extras = extension.statusExtras?.();
					if (extras?.leases) {
						leases = leases.concat(extras.leases);
					}
					phoneConnections += extras?.phoneConnections ?? 0;
				}
				connection.send({
					type: "status_result",
					id: request.id,
					version: VERSION,
					protocolVersion: PROTOCOL_VERSION,
					pid: process.pid,
					startedAtMs,
					leases,
					phoneConnections,
					workspaces,
					clients: toClientStatuses(),
				});
				return;
			}
			case "shutdown": {
				connection.send({ type: "ok", id: request.id });
				requestShutdown("cli");
				return;
			}
			case "clients_list": {
				connection.send({ type: "clients_result", id: request.id, clients: toClientStatuses() });
				return;
			}
			case "workspace_register": {
				let workspacePath: string;
				try {
					const stats = await stat(request.path);
					if (!stats.isDirectory()) {
						throw new Error(`Workspace path is not a directory: ${request.path}`);
					}
					workspacePath = await realpath(request.path);
				} catch (error) {
					connection.send({
						type: "error",
						id: request.id,
						code: "invalid_workspace",
						message: error instanceof Error ? error.message : String(error),
					});
					return;
				}
				await stateManager.upsertWorkspace({ name: request.name, path: workspacePath });
				await auditLogger
					.log({
						type: "workspace_registered",
						workspace: request.name,
						success: true,
						details: { path: workspacePath, source: "control" },
					})
					.catch(() => {});
				connection.send({ type: "ok", id: request.id });
				return;
			}
			case "workspace_unregister": {
				// State-only fallback (no Iroh extension running).
				const removedWorkspace = await stateManager.unregisterWorkspace(request.name);
				if (!removedWorkspace) {
					connection.send({
						type: "error",
						id: request.id,
						code: "not_found",
						message: `No registered workspace named ${request.name}`,
					});
					return;
				}
				await stateManager.removeLiveActivitiesForWorkspace(request.name);
				connection.send({ type: "ok", id: request.id });
				return;
			}
			case "client_revoke": {
				// State-only fallback (no Iroh extension running).
				const result = await stateManager.revokeClient(request.clientNodeId);
				await auditLogger
					.log({
						type: "client_revoked",
						clientNodeId: request.clientNodeId,
						success: result.revoked,
						error: result.revoked ? undefined : "client not found",
					})
					.catch(() => {});
				if (!result.revoked) {
					connection.send({ type: "error", id: request.id, code: "not_found", message: "client not found" });
					return;
				}
				connection.send({ type: "ok", id: request.id });
				return;
			}
			case "client_approve_repair": {
				const result = await stateManager.approveClientRePair(request.clientNodeId);
				await auditLogger
					.log({
						type: "client_repair_approved",
						clientNodeId: request.clientNodeId,
						success: result.approved,
						error: result.approved ? undefined : "revoked client not found",
					})
					.catch(() => {});
				if (!result.approved) {
					connection.send({
						type: "error",
						id: request.id,
						code: "not_found",
						message: "revoked client not found",
					});
					return;
				}
				connection.send({ type: "ok", id: request.id });
				return;
			}
			default:
				connection.send({
					type: "error",
					id: request.id,
					code: "unsupported",
					message: `unsupported control request: ${request.type}`,
				});
				return;
		}
	};

	const bindControlServer = () =>
		startControlServer({
			socketPath: paths.socketPath,
			version: VERSION,
			handlers: {
				onRequest: handleRequest,
				isShuttingDown: () => shuttingDown,
				onConnectionClosed(connection) {
					for (const extension of extensionInstances) {
						extension.onConnectionClosed?.(connection);
					}
				},
				log(level, message) {
					logger.log(level === "info" ? "info" : level, "control", message);
				},
			},
		});

	// Single instance is guaranteed by the socket bind.
	try {
		controlServer = await bindControlServer();
	} catch (error) {
		if (isErrnoException(error) && error.code === "EADDRINUSE") {
			const healthy = await probeControlSocket(paths.socketPath, { version: VERSION });
			if (healthy) {
				log("info", `another daemon is healthy (pid ${healthy.pid}); exiting`);
				return VOLTD_EXIT_ALREADY_RUNNING;
			}
			log("warn", "stale socket detected; unlinking and retrying bind once");
			rmSync(paths.socketPath, { force: true });
			try {
				controlServer = await bindControlServer();
			} catch (retryError) {
				log("error", `bind retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
				return VOLTD_EXIT_BIND_FAILED;
			}
		} else {
			log("error", `bind failed: ${error instanceof Error ? error.message : String(error)}`);
			return VOLTD_EXIT_BIND_FAILED;
		}
	}

	// Pidfile is advisory; liveness truth is always the socket probe.
	writeFileSync(
		paths.pidfilePath,
		`${JSON.stringify({ pid: process.pid, version: VERSION, startedAtMs, socketPath: paths.socketPath } satisfies PidfileContents)}\n`,
		{ mode: 0o600 },
	);

	const services: VoltdRuntimeServices = {
		agentDir,
		paths,
		logger,
		state,
		stateManager,
		auditLogger,
		controlServer,
		requestShutdown,
	};
	for (const extension of extensions) {
		extensionInstances.push(extension(services));
	}

	const onSignal = () => requestShutdown("signal");
	process.on("SIGTERM", onSignal);
	process.on("SIGINT", onSignal);

	await auditLogger
		.log({ type: "daemon_started", success: true, details: { version: VERSION, migratedFromLegacyState } })
		.catch(() => {});
	log("info", `voltd ${VERSION} listening`, { socketPath: paths.socketPath, pid: process.pid });

	const code = await exitPromise;
	process.off("SIGTERM", onSignal);
	process.off("SIGINT", onSignal);
	return code;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
