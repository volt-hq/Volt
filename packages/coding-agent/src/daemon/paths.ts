import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";

/** Unix domain socket paths are capped around 104 (macOS) / 108 (Linux) bytes. */
const MAX_SOCKET_PATH_BYTES = 100;

export interface DaemonPaths {
	daemonDir: string;
	socketPath: string;
	pidfilePath: string;
	logPath: string;
	statePath: string;
	auditPath: string;
}

export function getDaemonDir(agentDir: string = getAgentDir()): string {
	return join(agentDir, "daemon");
}

function getFallbackSocketPath(): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	if (runtimeDir) {
		return join(runtimeDir, `voltd-${uid}.sock`);
	}
	return join(`/tmp/voltd-${uid}`, "voltd.sock");
}

/**
 * Default socket path lives in the daemon dir; when the agent dir is nested
 * deep enough to overflow the platform socket-path limit, fall back to a
 * runtime dir. The actual path is recorded in the pidfile, which clients read
 * when the default probe fails.
 */
export function getDaemonSocketPath(agentDir: string = getAgentDir()): string {
	const defaultPath = join(getDaemonDir(agentDir), "voltd.sock");
	if (Buffer.byteLength(defaultPath, "utf8") <= MAX_SOCKET_PATH_BYTES) {
		return defaultPath;
	}
	return getFallbackSocketPath();
}

export function getDaemonPaths(agentDir: string = getAgentDir()): DaemonPaths {
	const daemonDir = getDaemonDir(agentDir);
	return {
		daemonDir,
		socketPath: getDaemonSocketPath(agentDir),
		pidfilePath: join(daemonDir, "voltd.pid"),
		logPath: join(daemonDir, "voltd.log"),
		statePath: join(daemonDir, "state.json"),
		auditPath: join(daemonDir, "audit.jsonl"),
	};
}

/** Create the daemon dir (0700) and, for fallback sockets, the socket's parent dir. */
export function ensureDaemonDirs(paths: DaemonPaths): void {
	mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
	if (!paths.socketPath.startsWith(paths.daemonDir)) {
		const socketDir = dirname(paths.socketPath);
		mkdirSync(socketDir, { recursive: true, mode: 0o700 });
		assertPrivateSocketDir(socketDir);
	}
}

/**
 * The fallback socket dir lives under a shared parent (/tmp or
 * XDG_RUNTIME_DIR) at a predictable path, and mkdir with recursive silently
 * accepts a pre-existing directory without touching its mode. Verify the
 * directory is ours before placing the socket in it, and tighten loose
 * permissions on one we own.
 */
function assertPrivateSocketDir(dir: string): void {
	if (process.platform === "win32") {
		return;
	}
	const stats = lstatSync(dir);
	if (!stats.isDirectory()) {
		throw new Error(`voltd socket directory ${dir} is not a directory`);
	}
	const uid = typeof process.getuid === "function" ? process.getuid() : stats.uid;
	if (stats.uid !== uid) {
		throw new Error(`refusing to use voltd socket directory ${dir}: owned by uid ${stats.uid}, not ${uid}`);
	}
	if ((stats.mode & 0o077) !== 0) {
		chmodSync(dir, 0o700);
	}
}
