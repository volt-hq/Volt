import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { Socket } from "node:net";
import { getAgentDir, VERSION } from "../config.ts";
import { IrohRemoteAuditLogger } from "../core/remote/iroh/audit.ts";
import { IrohRemoteHostStateManager } from "../core/remote/iroh/state-manager.ts";
import {
	getCurrentThemeName,
	getResolvedThemeColors,
	getThemeByName,
	initTheme,
	onThemeChange,
	setTheme,
} from "../core/theme/runtime.ts";
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
import { KeepAwakeController, type KeepAwakeControllerOptions } from "./keep-awake.ts";
import type { DaemonLogger } from "./log.ts";
import { createDaemonLogger } from "./log.ts";
import { type DaemonPaths, ensureDaemonDirs, getDaemonPaths } from "./paths.ts";
import { verifyPidfileProcess } from "./process-identity.ts";
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
	/** Keep-awake controller overrides (tests inject a fake spawn here). */
	keepAwake?: KeepAwakeControllerOptions;
}

export interface PidfileContents {
	pid: number;
	version: string;
	startedAtMs: number;
	socketPath: string;
	/** Per-daemon instance token; optional for pidfiles written by older versions. */
	token?: string;
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
			...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
		};
	} catch {
		return undefined;
	}
}

export const VOLTD_EXIT_ALREADY_RUNNING = 3;
export const VOLTD_EXIT_BIND_FAILED = 4;
export const VOLTD_EXIT_INCOMPATIBLE_RUNNING = 5;

const DAEMON_BIND_WAIT_TIMEOUT_MS = 75_000;
const DAEMON_BIND_WAIT_POLL_MS = 200;

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Facilities later milestones build on (lease broker, Iroh host, theme service). */
export interface VoltdRuntimeServices {
	agentDir: string;
	paths: DaemonPaths;
	logger: DaemonLogger;
	state: VoltdStateStore;
	stateManager: IrohRemoteHostStateManager;
	auditLogger: IrohRemoteAuditLogger;
	controlServer: ControlServer;
	keepAwake: KeepAwakeController;
	requestShutdown(reason: "cli" | "signal"): void;
}

export interface VoltdServiceExtensionInstance {
	/** Extra request handling; return true when the request was handled. */
	handleRequest?(connection: ControlConnection, request: ControlRequest): Promise<boolean> | boolean;
	onConnectionClosed?(connection: ControlConnection): void;
	/** The daemon's active theme changed (theme_set or an extension setTheme). */
	onThemeChanged?(): void;
	/** Keep-awake status changed (control toggle, phone RPC toggle, or degradation). */
	onKeepAwakeChanged?(): void;
	statusExtras?(): { leases?: ControlLeaseStatus[]; phoneConnections?: number; relayCount?: number };
	/** Redeem a relay hello token; true when the socket was taken over. */
	admitRelay?(relayId: string, relayToken: string, socket: Socket, bufferedRemainder: Buffer): boolean;
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
	const pidfileToken = randomUUID();

	const state = new VoltdStateStore({ agentDir, statePath: paths.statePath });
	let migratedFromLegacyState = false;
	try {
		const loadResult = await state.load();
		migratedFromLegacyState = loadResult.migratedFromLegacyState;
		if (loadResult.recoveredFromCorruptStatePath) {
			log(
				"error",
				`state file was unparseable and was quarantined to ${loadResult.recoveredFromCorruptStatePath}; ` +
					`started from empty state (Iroh identity and paired clients were reset, phones must pair again)`,
			);
		}
	} catch (error) {
		log("error", `failed to load state: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	// The daemon's theme instance: persisted name from voltd state, no hot-reload
	// watcher (that is the rendering TUI's job).
	initTheme(state.state.settings.themeName, false);
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
	const removeOwnedPidfile = () => {
		const current = readPidfile(paths.pidfilePath);
		if (!current) {
			return;
		}
		const owned = current.token === pidfileToken || (current.token === undefined && current.pid === process.pid);
		if (owned) {
			rmSync(paths.pidfilePath, { force: true });
		}
	};
	const exitPromise = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});

	const extensionInstances: VoltdServiceExtensionInstance[] = [];
	let controlServer: ControlServer | undefined;

	const keepAwake = new KeepAwakeController({
		...config.keepAwake,
		log: (level, message) => logger.log(level, "keep-awake", message),
		onStatusChanged: (status) => {
			config.keepAwake?.onStatusChanged?.(status);
			controlServer?.broadcast({ type: "keep_awake_changed", keepAwake: status });
			for (const extension of extensionInstances) {
				extension.onKeepAwakeChanged?.();
			}
		},
	});

	const shutdown = async (reason: "cli" | "signal") => {
		if (shuttingDown) {
			return;
		}
		shuttingDown = true;
		log("info", `shutting down (${reason})`);
		// Tell control clients up front: extension shutdown can drain streaming
		// runtimes for up to 60s and clients must not wait blind. New hellos are
		// already rejected via the isShuttingDown gate.
		controlServer?.broadcast({ type: "daemon_shutdown" });
		for (const extension of extensionInstances) {
			try {
				await extension.shutdown?.();
			} catch (error) {
				log("error", `extension shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		await keepAwake.shutdown().catch(() => {});
		await state.close().catch(() => {});
		await auditLogger.log({ type: "daemon_shutdown", success: true, details: { reason } }).catch(() => {});
		await controlServer?.close().catch(() => {});
		removeOwnedPidfile();
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
					keepAwake: keepAwake.status,
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
			case "theme_set": {
				// Validate before applying: runtime setTheme falls back to dark on
				// failure, which must not clobber the active theme on a bad request.
				if (!getThemeByName(request.theme)) {
					connection.send({
						type: "error",
						id: request.id,
						code: "invalid_theme",
						message: `unknown theme: ${request.theme}`,
					});
					return;
				}
				const result = setTheme(request.theme, false);
				if (!result.success) {
					connection.send({
						type: "error",
						id: request.id,
						code: "invalid_theme",
						message: result.error ?? `unknown theme: ${request.theme}`,
					});
					return;
				}
				state.updateSettings({ themeName: request.theme });
				connection.send({ type: "ok", id: request.id });
				return;
			}
			case "keep_awake_set": {
				const status = keepAwake.setEnabled(request.enabled);
				state.updateSettings({ keepAwakeEnabled: request.enabled });
				connection.send({ type: "keep_awake_result", id: request.id, keepAwake: status });
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
				relayAdmission: {
					admitRelay(hello, socket, bufferedRemainder) {
						for (const extension of extensionInstances) {
							if (extension.admitRelay?.(hello.relayId, hello.relayToken, socket, bufferedRemainder)) {
								return true;
							}
						}
						return false;
					},
				},
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
			const deadline = Date.now() + DAEMON_BIND_WAIT_TIMEOUT_MS;
			let socketProbe = await probeControlSocket(paths.socketPath, { version: VERSION });
			let loggedShutdownWait = false;
			while (
				socketProbe.kind === "live-rejected" &&
				socketProbe.reason === "shutting_down" &&
				Date.now() < deadline
			) {
				if (!loggedShutdownWait) {
					loggedShutdownWait = true;
					log("info", "another daemon is shutting down; waiting for socket release");
				}
				await sleep(DAEMON_BIND_WAIT_POLL_MS);
				socketProbe = await probeControlSocket(paths.socketPath, { version: VERSION, timeoutMs: 500 });
			}
			if (socketProbe.kind === "healthy") {
				log("info", `another daemon is healthy (pid ${socketProbe.status.pid}); exiting`);
				return VOLTD_EXIT_ALREADY_RUNNING;
			}
			if (socketProbe.kind === "live-rejected" && socketProbe.reason === "protocol_mismatch") {
				log(
					"error",
					`another daemon is running with protocol ${socketProbe.protocolVersion ?? "unknown"}; not removing its socket`,
				);
				return VOLTD_EXIT_INCOMPATIBLE_RUNNING;
			}
			if (socketProbe.kind === "live-rejected" || socketProbe.kind === "unresponsive") {
				log("error", "control socket is owned by a live daemon that is not healthy; not removing it");
				return VOLTD_EXIT_BIND_FAILED;
			}
			const pidfile = readPidfile(paths.pidfilePath);
			if (pidfile && (await verifyPidfileProcess(pidfile)) === "match") {
				log("error", `pidfile still verifies live daemon pid ${pidfile.pid}; not removing socket`);
				return VOLTD_EXIT_BIND_FAILED;
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
		`${JSON.stringify({ pid: process.pid, version: VERSION, startedAtMs, socketPath: paths.socketPath, token: pidfileToken } satisfies PidfileContents)}\n`,
		{ mode: 0o600 },
	);

	// Broadcast every successful theme change (control theme_set, or an extension
	// calling ctx.ui.setTheme inside a daemon-owned runtime) to all control
	// clients as a resolved-token snapshot, and let service extensions push it
	// onward (e.g. host_theme_tokens frames to capable phones, §9.5).
	onThemeChange(() => {
		controlServer?.broadcast({
			type: "theme_snapshot",
			themeName: getCurrentThemeName() ?? "dark",
			tokens: getResolvedThemeColors(),
		});
		for (const extension of extensionInstances) {
			extension.onThemeChanged?.();
		}
	});

	const services: VoltdRuntimeServices = {
		agentDir,
		paths,
		logger,
		state,
		stateManager,
		auditLogger,
		controlServer,
		keepAwake,
		requestShutdown,
	};
	for (const extension of extensions) {
		extensionInstances.push(extension(services));
	}

	// Re-apply the persisted keep-awake assertion now that extensions exist, so
	// their onKeepAwakeChanged hooks observe the startup transition.
	if (state.state.settings.keepAwakeEnabled === true) {
		keepAwake.setEnabled(true);
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
