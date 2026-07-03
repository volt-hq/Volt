import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { ENV_AGENT_DIR, getAgentDir, getPackageDir, VERSION } from "../config.ts";
import { type ControlSocketProbe, probeControlSocket } from "./control-server.ts";
import { type PidfileContents, readPidfile } from "./main.ts";
import { type DaemonPaths, ensureDaemonDirs, getDaemonPaths } from "./paths.ts";

const SPAWN_HEALTH_TIMEOUT_MS = 5000;
const SPAWN_HEALTH_POLL_MS = 100;
export const DAEMON_SHUTDOWN_TIMEOUT_MS = 75_000;
const DAEMON_EXIT_POLL_MS = 200;

export type DaemonProbeState = "healthy" | "shutting-down" | "protocol-mismatch" | "unresponsive" | "not-running";

export interface DaemonProbeResult {
	healthy: boolean;
	state: DaemonProbeState;
	pid?: number;
	version?: string;
	protocolVersion?: number;
	startedAtMs?: number;
	socketPath: string;
}

function daemonProbeFromSocketProbe(socketPath: string, probe: ControlSocketProbe): DaemonProbeResult {
	if (probe.kind === "healthy") {
		return {
			healthy: true,
			state: "healthy",
			pid: probe.status.pid,
			version: probe.status.version,
			protocolVersion: probe.status.protocolVersion,
			startedAtMs: probe.status.startedAtMs,
			socketPath,
		};
	}
	if (probe.kind === "live-rejected") {
		return {
			healthy: false,
			state: probe.reason === "protocol_mismatch" ? "protocol-mismatch" : "shutting-down",
			...(probe.version === undefined ? {} : { version: probe.version }),
			...(probe.protocolVersion === undefined ? {} : { protocolVersion: probe.protocolVersion }),
			socketPath,
		};
	}
	if (probe.kind === "unresponsive") {
		return { healthy: false, state: "unresponsive", socketPath };
	}
	return { healthy: false, state: "not-running", socketPath };
}

/**
 * Probe the daemon socket (default path, falling back to the pidfile-recorded
 * socket path when the default answers nothing).
 */
export async function probeDaemon(agentDir: string = getAgentDir()): Promise<DaemonProbeResult> {
	const paths = getDaemonPaths(agentDir);
	const probe = await probeControlSocket(paths.socketPath, { version: VERSION });
	const result = daemonProbeFromSocketProbe(paths.socketPath, probe);
	if (result.state !== "not-running") {
		return result;
	}
	const pidfile = readPidfile(paths.pidfilePath);
	if (pidfile && pidfile.socketPath !== paths.socketPath) {
		const fallbackProbe = await probeControlSocket(pidfile.socketPath, { version: VERSION });
		const fallbackResult = daemonProbeFromSocketProbe(pidfile.socketPath, fallbackProbe);
		if (fallbackResult.state !== "not-running") {
			return fallbackResult;
		}
	}
	return { healthy: false, state: "not-running", socketPath: paths.socketPath };
}

export function resolveDaemonCliInvocation(): { nodeArgs: string[]; entry: string } {
	const packageDir = getPackageDir();
	const sourceEntry = join(packageDir, "src", "cli.ts");
	if (existsSync(sourceEntry)) {
		return { nodeArgs: ["--conditions", "volt-source"], entry: sourceEntry };
	}
	return { nodeArgs: [], entry: join(packageDir, "dist", "cli.js") };
}

export interface SpawnDaemonResult {
	ok: boolean;
	pid?: number;
	socketPath: string;
	error?: string;
}

export interface WaitForDaemonExitOptions {
	agentDir?: string;
	pid?: number;
	pidfile?: PidfileContents;
	socketPath?: string;
	timeoutMs?: number;
}

function processIsGone(pid: number | undefined): boolean {
	if (!pid || pid === process.pid) {
		return true;
	}
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return !(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EPERM");
	}
}

export async function waitForDaemonExit(options: WaitForDaemonExitOptions = {}): Promise<"exited" | "timeout"> {
	const agentDir = options.agentDir ?? getAgentDir();
	const paths = getDaemonPaths(agentDir);
	const deadline = Date.now() + (options.timeoutMs ?? DAEMON_SHUTDOWN_TIMEOUT_MS);
	const targetPid = options.pid ?? options.pidfile?.pid;
	const socketPath = options.socketPath ?? options.pidfile?.socketPath ?? paths.socketPath;
	while (Date.now() < deadline) {
		const socketProbe = await probeControlSocket(socketPath, { version: VERSION, timeoutMs: 500 });
		if (processIsGone(targetPid) && socketProbe.kind === "no-listener") {
			return "exited";
		}
		await new Promise((resolve) => setTimeout(resolve, DAEMON_EXIT_POLL_MS));
	}
	return "timeout";
}

/** Spawn a detached daemon and wait (up to 5s) for the socket to answer a status probe. */
export async function spawnDetachedDaemon(agentDir: string = getAgentDir()): Promise<SpawnDaemonResult> {
	const paths: DaemonPaths = getDaemonPaths(agentDir);
	ensureDaemonDirs(paths);
	const { nodeArgs, entry } = resolveDaemonCliInvocation();
	const logFd = openSync(paths.logPath, "a", 0o600);
	const child = spawn(process.execPath, [...nodeArgs, entry, "daemon", "run", "--foreground"], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		cwd: agentDir,
		env: { ...process.env, [ENV_AGENT_DIR]: agentDir },
	});
	// An unhandled "error" event would crash the calling CLI process; capture it
	// and surface it through the health-wait result instead.
	let spawnError: Error | undefined;
	child.once("error", (error) => {
		spawnError = error;
	});
	child.unref();
	// The child received duplicated descriptors at spawn; close the parent copy.
	closeSync(logFd);

	const deadline = Date.now() + SPAWN_HEALTH_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (spawnError) {
			return { ok: false, socketPath: paths.socketPath, error: `failed to spawn voltd: ${spawnError.message}` };
		}
		const probe = await probeDaemon(agentDir);
		if (probe.healthy) {
			return { ok: true, pid: probe.pid, socketPath: probe.socketPath };
		}
		await new Promise((resolve) => setTimeout(resolve, SPAWN_HEALTH_POLL_MS));
	}
	return { ok: false, socketPath: paths.socketPath, error: "daemon did not become healthy within 5s" };
}

export interface EnsureDaemonResult extends DaemonProbeResult {
	spawned: boolean;
}

/** Probe the socket; if no healthy daemon answers, spawn one detached. */
export async function ensureDaemonRunning(agentDir: string = getAgentDir()): Promise<EnsureDaemonResult> {
	let probe = await probeDaemon(agentDir);
	if (probe.healthy) {
		return { ...probe, spawned: false };
	}
	if (probe.state === "protocol-mismatch" || probe.state === "unresponsive") {
		return { ...probe, spawned: false };
	}
	if (probe.state === "shutting-down") {
		await waitForDaemonExit({ agentDir, socketPath: probe.socketPath });
		probe = await probeDaemon(agentDir);
		if (probe.state !== "not-running") {
			return { ...probe, spawned: false };
		}
	}
	const spawned = await spawnDetachedDaemon(agentDir);
	if (!spawned.ok) {
		return { healthy: false, state: "not-running", socketPath: spawned.socketPath, spawned: true };
	}
	const healthyProbe = await probeDaemon(agentDir);
	return { ...healthyProbe, spawned: true };
}
