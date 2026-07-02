import { existsSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { getAgentDir, VERSION } from "../config.ts";
import { createDaemonClient } from "./control-client.ts";
import type { ControlResponse } from "./control-protocol.ts";
import { probeControlSocket } from "./control-server.ts";
import { readPidfile, runVoltDaemon } from "./main.ts";
import { getDaemonPaths } from "./paths.ts";
import { ensureDaemonRunning, probeDaemon } from "./spawn.ts";

const STOP_TIMEOUT_MS = 75_000; // 60s drain cap + margin
const DEFAULT_LOG_TAIL_LINES = 200;

type StatusResult = ControlResponse & { type: "status_result" };

function printDaemonUsage(): void {
	console.error(`Usage: volt daemon <command>

Commands:
  start                 Start the background daemon (no-op if already running).
  stop                  Ask the daemon to shut down gracefully.
  status [--json]       Show daemon status; exit 0 when running, 1 when not.
  restart               Stop then start; persistent state survives.
  logs [-f] [-n N]      Tail the daemon log (default ${DEFAULT_LOG_TAIL_LINES} lines).
  run --foreground      Run the daemon in this process (internal; used by start).
`);
}

async function requestStatus(agentDir: string): Promise<StatusResult | undefined> {
	const probe = await probeDaemon(agentDir);
	if (!probe.healthy) {
		return undefined;
	}
	return probeControlSocket(probe.socketPath, { version: VERSION });
}

async function daemonStart(agentDir: string): Promise<void> {
	const result = await ensureDaemonRunning(agentDir);
	if (!result.healthy) {
		console.error("Error: failed to start voltd (daemon did not become healthy within 5s).");
		console.error(`Check the log: ${getDaemonPaths(agentDir).logPath}`);
		process.exitCode = 1;
		return;
	}
	console.error(
		`voltd ${result.version ?? VERSION} ${result.spawned ? "started" : "already running"} (pid ${result.pid})`,
	);
	console.error(`socket: ${result.socketPath}`);
}

async function daemonStop(agentDir: string): Promise<void> {
	const paths = getDaemonPaths(agentDir);
	const probe = await probeDaemon(agentDir);
	if (!probe.healthy) {
		const pidfile = readPidfile(paths.pidfilePath);
		if (pidfile) {
			try {
				process.kill(pidfile.pid, "SIGTERM");
				console.error(`voltd socket unreachable; sent SIGTERM to pid ${pidfile.pid}`);
				return;
			} catch {
				// Process already gone.
			}
		}
		console.error("voltd is not running");
		return;
	}

	const client = createDaemonClient({
		socketPath: probe.socketPath,
		client: "cli",
		version: VERSION,
		reconnect: false,
	});
	try {
		await client.request({ type: "shutdown" });
	} catch {
		// The daemon may close the socket before the ok lands; fall through to the poll.
	} finally {
		await client.close();
	}

	const deadline = Date.now() + STOP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (!(await probeDaemon(agentDir)).healthy) {
			console.error("voltd stopped");
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	const pidfile = readPidfile(paths.pidfilePath);
	if (pidfile) {
		try {
			process.kill(pidfile.pid, "SIGTERM");
			console.error(`voltd did not stop over the control socket; sent SIGTERM to pid ${pidfile.pid}`);
			return;
		} catch {
			// Process already gone.
		}
	}
	console.error("Error: voltd did not stop within the timeout");
	process.exitCode = 1;
}

function formatUptime(startedAtMs: number): string {
	const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0 ? `${hours}h${minutes}m${seconds}s` : minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

async function daemonStatus(agentDir: string, json: boolean): Promise<void> {
	const status = await requestStatus(agentDir);
	if (!status) {
		if (json) {
			console.log(JSON.stringify({ running: false }));
		} else {
			console.error("voltd is not running");
		}
		process.exitCode = 1;
		return;
	}
	if (json) {
		console.log(JSON.stringify({ running: true, ...status, id: undefined }));
		return;
	}
	console.error(`voltd ${status.version} (protocol ${status.protocolVersion})`);
	console.error(`pid: ${status.pid}`);
	console.error(`uptime: ${formatUptime(status.startedAtMs)}`);
	console.error(`phone connections: ${status.phoneConnections}`);
	console.error(`workspaces: ${status.workspaces.length}`);
	for (const workspace of status.workspaces) {
		console.error(`  ${workspace.name} -> ${workspace.path}`);
	}
	console.error(`paired clients: ${status.clients.length}`);
	for (const client of status.clients) {
		console.error(`  ${client.clientNodeId}${client.label ? ` (${client.label})` : ""}`);
	}
	console.error(`leases: ${status.leases.length}`);
	for (const lease of status.leases) {
		console.error(
			`  ${lease.workspaceName}/${lease.sessionId}: ${lease.state} (streams ${lease.streamCount}, relays ${lease.relayCount})`,
		);
	}
}

function tailLines(content: string, count: number): string[] {
	const lines = content.split("\n");
	if (lines.at(-1) === "") {
		lines.pop();
	}
	return lines.slice(-count);
}

async function daemonLogs(agentDir: string, args: string[]): Promise<void> {
	const paths = getDaemonPaths(agentDir);
	const follow = args.includes("-f") || args.includes("--follow");
	let lineCount = DEFAULT_LOG_TAIL_LINES;
	const nIndex = args.findIndex((arg) => arg === "-n");
	if (nIndex !== -1) {
		const parsed = Number(args[nIndex + 1]);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			console.error("Error: -n requires a positive integer");
			process.exitCode = 1;
			return;
		}
		lineCount = parsed;
	}
	if (!existsSync(paths.logPath)) {
		console.error(`No daemon log at ${paths.logPath}`);
		process.exitCode = 1;
		return;
	}
	for (const line of tailLines(readFileSync(paths.logPath, "utf8"), lineCount)) {
		console.log(line);
	}
	if (!follow) {
		return;
	}
	let offset = statSync(paths.logPath).size;
	while (true) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		let size: number;
		try {
			size = statSync(paths.logPath).size;
		} catch {
			continue;
		}
		if (size < offset) {
			offset = 0; // rotated
		}
		if (size === offset) {
			continue;
		}
		const handle = await open(paths.logPath, "r");
		try {
			const { buffer, bytesRead } = await handle.read(Buffer.alloc(size - offset), 0, size - offset, offset);
			process.stdout.write(buffer.subarray(0, bytesRead));
			offset += bytesRead;
		} finally {
			await handle.close();
		}
	}
}

export interface DaemonCommandOptions {
	agentDir?: string;
	/** Bun cannot host the daemon (native Iroh adapter); reject like remote host does. */
	isBunBinary: boolean;
}

/** Router for `volt daemon <command>`; returns true when the args were handled. */
export async function handleDaemonCommand(args: string[], options: DaemonCommandOptions): Promise<boolean> {
	if (args[0] !== "daemon") {
		return false;
	}
	const command = args[1];
	if (command === undefined || command === "--help" || command === "-h") {
		printDaemonUsage();
		return true;
	}
	if (options.isBunBinary) {
		console.error("Error: volt daemon is not available from the Bun binary release yet.");
		console.error("Use a Node.js npm install or a source checkout with optional @number0/iroh dependencies.");
		process.exitCode = 1;
		return true;
	}
	const agentDir = options.agentDir ?? getAgentDir();
	const rest = args.slice(2);

	switch (command) {
		case "start":
			await daemonStart(agentDir);
			return true;
		case "stop":
			await daemonStop(agentDir);
			return true;
		case "status":
			await daemonStatus(agentDir, rest.includes("--json"));
			return true;
		case "restart":
			await daemonStop(agentDir);
			if ((process.exitCode ?? 0) === 0) {
				await daemonStart(agentDir);
			}
			return true;
		case "logs":
			await daemonLogs(agentDir, rest);
			return true;
		case "run": {
			if (!rest.includes("--foreground")) {
				console.error("Error: volt daemon run requires --foreground");
				process.exitCode = 1;
				return true;
			}
			const code = await runVoltDaemon({ agentDir, foreground: true });
			process.exitCode = code;
			return true;
		}
		default:
			console.error(`Error: Unknown daemon command: ${command}`);
			printDaemonUsage();
			process.exitCode = 1;
			return true;
	}
}
