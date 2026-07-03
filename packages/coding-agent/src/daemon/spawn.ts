import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { ENV_AGENT_DIR, getAgentDir, getPackageDir, VERSION } from "../config.ts";
import { probeControlSocket } from "./control-server.ts";
import { readPidfile } from "./main.ts";
import { type DaemonPaths, ensureDaemonDirs, getDaemonPaths } from "./paths.ts";

const SPAWN_HEALTH_TIMEOUT_MS = 5000;
const SPAWN_HEALTH_POLL_MS = 100;

export interface DaemonProbeResult {
	healthy: boolean;
	pid?: number;
	version?: string;
	protocolVersion?: number;
	startedAtMs?: number;
	socketPath: string;
}

/**
 * Probe the daemon socket (default path, falling back to the pidfile-recorded
 * socket path when the default answers nothing).
 */
export async function probeDaemon(agentDir: string = getAgentDir()): Promise<DaemonProbeResult> {
	const paths = getDaemonPaths(agentDir);
	const status = await probeControlSocket(paths.socketPath, { version: VERSION });
	if (status) {
		return {
			healthy: true,
			pid: status.pid,
			version: status.version,
			protocolVersion: status.protocolVersion,
			startedAtMs: status.startedAtMs,
			socketPath: paths.socketPath,
		};
	}
	const pidfile = readPidfile(paths.pidfilePath);
	if (pidfile && pidfile.socketPath !== paths.socketPath) {
		const fallbackStatus = await probeControlSocket(pidfile.socketPath, { version: VERSION });
		if (fallbackStatus) {
			return {
				healthy: true,
				pid: fallbackStatus.pid,
				version: fallbackStatus.version,
				protocolVersion: fallbackStatus.protocolVersion,
				startedAtMs: fallbackStatus.startedAtMs,
				socketPath: pidfile.socketPath,
			};
		}
	}
	return { healthy: false, socketPath: paths.socketPath };
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
	const probe = await probeDaemon(agentDir);
	if (probe.healthy) {
		return { ...probe, spawned: false };
	}
	const spawned = await spawnDetachedDaemon(agentDir);
	if (!spawned.ok) {
		return { healthy: false, socketPath: spawned.socketPath, spawned: true };
	}
	const healthyProbe = await probeDaemon(agentDir);
	return { ...healthyProbe, spawned: true };
}
