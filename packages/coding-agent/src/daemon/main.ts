import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { getAgentDir, VERSION } from "../config.ts";
import { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import type { ControlClientStatus, ControlRequest, ControlWorkspaceStatus } from "./control-protocol.ts";
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

/** Extension seam: later milestones register runtime/lease/engine facilities here. */
export interface VoltdRuntimeServices {
	paths: DaemonPaths;
	logger: DaemonLogger;
	state: VoltdStateStore;
	auditLogger: IrohRemoteAuditLogger;
	controlServer: ControlServer;
	requestShutdown(reason: "cli" | "signal"): void;
}

export type VoltdServiceExtension = (services: VoltdRuntimeServices) => {
	/** Extra request handling; return true when the request was handled. */
	handleRequest?(connection: ControlConnection, request: ControlRequest): Promise<boolean> | boolean;
	onConnectionClosed?(connection: ControlConnection): void;
	statusExtras?(): { leases?: never[] } | Record<string, unknown>;
	shutdown?(): Promise<void>;
};

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
	const auditLogger = new IrohRemoteAuditLogger({ path: paths.auditPath });

	let shuttingDown = false;
	let resolveExit: ((code: number) => void) | undefined;
	const exitPromise = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});

	let controlServer: ControlServer | undefined;
	let extensionInstances: ReturnType<VoltdServiceExtension>[] = [];

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

	const handleRequest = async (connection: ControlConnection, request: ControlRequest): Promise<void> => {
		for (const extension of extensionInstances) {
			if (await extension.handleRequest?.(connection, request)) {
				return;
			}
		}
		switch (request.type) {
			case "status": {
				const currentState = state.state;
				const workspaces: ControlWorkspaceStatus[] = currentState.workspaces.map((workspace) => ({
					name: workspace.name,
					path: workspace.path,
				}));
				const clients: ControlClientStatus[] = currentState.clients.map((client) => ({
					clientNodeId: client.nodeId,
					...(client.label === undefined ? {} : { label: client.label }),
					pairedAtMs: client.pairedAt ?? 0,
				}));
				connection.send({
					type: "status_result",
					id: request.id,
					version: VERSION,
					protocolVersion: PROTOCOL_VERSION,
					pid: process.pid,
					startedAtMs,
					leases: [],
					phoneConnections: 0,
					workspaces,
					clients,
				});
				return;
			}
			case "shutdown": {
				connection.send({ type: "ok", id: request.id });
				requestShutdown("cli");
				return;
			}
			case "clients_list": {
				connection.send({
					type: "clients_result",
					id: request.id,
					clients: state.state.clients.map((client) => ({
						clientNodeId: client.nodeId,
						...(client.label === undefined ? {} : { label: client.label }),
						pairedAtMs: client.pairedAt ?? 0,
					})),
				});
				return;
			}
			case "lease_acquire":
			case "lease_release":
			case "lease_rekey":
				// Lease integration lands with the broker; absent-daemon semantics apply.
				connection.send({
					type: "error",
					id: request.id,
					code: "unsupported",
					message: "lease broker is not available in this daemon build",
				});
				return;
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

	// Single instance is guaranteed by the socket bind.
	try {
		controlServer = await bindControlServer(paths, logger, handleRequest, () => shuttingDown, extensionInstances);
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
				controlServer = await bindControlServer(
					paths,
					logger,
					handleRequest,
					() => shuttingDown,
					extensionInstances,
				);
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
		paths,
		logger,
		state,
		auditLogger,
		controlServer,
		requestShutdown,
	};
	extensionInstances = extensions.map((extension) => extension(services));

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

async function bindControlServer(
	paths: DaemonPaths,
	logger: DaemonLogger,
	onRequest: (connection: ControlConnection, request: ControlRequest) => Promise<void>,
	isShuttingDown: () => boolean,
	extensionInstances: ReturnType<VoltdServiceExtension>[],
): Promise<ControlServer> {
	return startControlServer({
		socketPath: paths.socketPath,
		version: VERSION,
		handlers: {
			onRequest,
			isShuttingDown,
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
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
