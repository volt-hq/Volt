import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import type { ControlEvent } from "../src/daemon/control-protocol.ts";
import { createDaemonLogger } from "../src/daemon/log.ts";
import { readPidfile, runVoltDaemon, VOLTD_EXIT_ALREADY_RUNNING } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { type DaemonProbeResult, ensureDaemonRunning, probeDaemon, waitForDaemonExit } from "../src/daemon/spawn.ts";

// A leftover regular file at the socket path is a POSIX-only failure mode:
// Windows control sockets are named pipes (\\.\pipe\...) with no on-disk
// entry, and the OS removes the pipe when the owning process exits.
const posixIt = process.platform === "win32" ? it.skip : it;
const win32It = process.platform === "win32" ? it : it.skip;

describe("voltd lifecycle", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-life-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	async function waitForDaemon(): Promise<DaemonProbeResult> {
		let status = await probeDaemon(agentDir);
		for (let attempt = 0; !status.healthy && attempt < 50; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeDaemon(agentDir);
		}
		expect(status.healthy).toBe(true);
		return status;
	}

	it("serves status, rejects a second instance, and shuts down gracefully", async () => {
		const paths = getDaemonPaths(agentDir);
		const daemon = runVoltDaemon({ agentDir, foreground: false });

		// Probe until healthy.
		const status = await waitForDaemon();
		expect(status.pid).toBe(process.pid);

		// Pidfile is advisory but present and truthful.
		const pidfile = readPidfile(paths.pidfilePath);
		expect(pidfile?.pid).toBe(process.pid);
		expect(pidfile?.socketPath).toBe(status.socketPath);

		// A second daemon on the same agent dir exits with already_running.
		await expect(runVoltDaemon({ agentDir, foreground: false })).resolves.toBe(VOLTD_EXIT_ALREADY_RUNNING);

		// Control client sees the shutdown broadcast on graceful shutdown.
		const events: ControlEvent[] = [];
		const client = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
			onEvent: (event) => events.push(event),
		});
		const shutdownResponse = await client.request({ type: "shutdown" });
		expect(shutdownResponse.type).toBe("ok");
		await expect(daemon).resolves.toBe(0);
		expect(events.some((event) => event.type === "daemon_shutdown")).toBe(true);
		await client.close();

		// Socket and pidfile removed; audit records started + shutdown.
		expect(existsSync(paths.socketPath)).toBe(false);
		expect(existsSync(paths.pidfilePath)).toBe(false);
		const auditLines = readFileSync(paths.auditPath, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string });
		expect(auditLines.map((line) => line.type)).toEqual(["daemon_started", "daemon_shutdown"]);
	}, 20_000);

	it("serializes instances that request different custom socket paths", async () => {
		const paths = getDaemonPaths(agentDir);
		const customSocketPath = (label: string) =>
			process.platform === "win32"
				? `\\\\.\\pipe\\voltd-custom-${label}-${randomUUID()}`
				: join(paths.daemonDir, `custom-${label}.sock`);
		const firstSocketPath = customSocketPath("first");
		const daemon = runVoltDaemon({ agentDir, foreground: false, socketPath: firstSocketPath });
		const status = await waitForDaemon();
		expect(status.socketPath).toBe(firstSocketPath);

		await expect(
			runVoltDaemon({ agentDir, foreground: false, socketPath: customSocketPath("second") }),
		).resolves.toBe(VOLTD_EXIT_ALREADY_RUNNING);

		const client = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
		});
		await client.request({ type: "shutdown" });
		await client.close();
		await expect(daemon).resolves.toBe(0);
	}, 20_000);

	posixIt(
		"recovers from a stale socket file",
		async () => {
			const paths = getDaemonPaths(agentDir);
			mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
			// A leftover regular file at the socket path produces EADDRINUSE on bind.
			writeFileSync(paths.socketPath, "", { mode: 0o600 });
			const daemon = runVoltDaemon({ agentDir, foreground: false });
			const status = await waitForDaemon();
			const client = createDaemonClient({
				socketPath: status.socketPath,
				client: "cli",
				version: "test",
				authToken: status.authToken,
				reconnect: false,
			});
			await client.request({ type: "shutdown" });
			await client.close();
			await expect(daemon).resolves.toBe(0);
		},
		20_000,
	);

	win32It(
		"uses a fresh Windows pipe when the legacy default pipe was pre-created",
		async () => {
			const paths = getDaemonPaths(agentDir);
			const precreatedPipe = createServer((socket) => {
				socket.destroy();
			});
			await new Promise<void>((resolve, reject) => {
				precreatedPipe.once("error", reject);
				precreatedPipe.listen(paths.socketPath, () => {
					precreatedPipe.off("error", reject);
					resolve();
				});
			});

			let daemon: Promise<number> | undefined;
			let daemonSocketPath: string | undefined;
			let daemonAuthToken: string | undefined;
			let shutdownRequested = false;
			try {
				daemon = runVoltDaemon({ agentDir, foreground: false });
				const status = await waitForDaemon();
				daemonSocketPath = status.socketPath;
				daemonAuthToken = status.authToken;
				expect(daemonSocketPath).toBeDefined();
				expect(daemonSocketPath).not.toBe(paths.socketPath);
				const client = createDaemonClient({
					socketPath: daemonSocketPath,
					client: "cli",
					version: "test",
					authToken: daemonAuthToken,
					reconnect: false,
				});
				try {
					await client.request({ type: "shutdown" });
					shutdownRequested = true;
				} finally {
					await client.close();
				}
				await expect(daemon).resolves.toBe(0);
			} finally {
				if (!shutdownRequested && daemonSocketPath) {
					const client = createDaemonClient({
						socketPath: daemonSocketPath,
						client: "cli",
						version: "test",
						authToken: daemonAuthToken,
						reconnect: false,
					});
					await client.request({ type: "shutdown" }).catch(() => {});
					await client.close().catch(() => {});
					await daemon?.catch(() => {});
				}
				await new Promise<void>((resolve) => {
					precreatedPipe.close(() => resolve());
				});
			}
		},
		20_000,
	);

	win32It(
		"auto-starts on a fresh pipe when the legacy default pipe is unresponsive",
		async () => {
			const paths = getDaemonPaths(agentDir);
			const precreatedPipe = createServer((socket) => {
				socket.destroy();
			});
			await new Promise<void>((resolve, reject) => {
				precreatedPipe.once("error", reject);
				precreatedPipe.listen(paths.socketPath, () => {
					precreatedPipe.off("error", reject);
					resolve();
				});
			});
			try {
				const result = await ensureDaemonRunning(agentDir);
				expect(result.healthy).toBe(true);
				expect(result.spawned).toBe(true);
				expect(result.socketPath).not.toBe(paths.socketPath);
				const client = createDaemonClient({
					socketPath: result.socketPath,
					client: "cli",
					version: "test",
					authToken: result.authToken,
					reconnect: false,
				});
				await client.request({ type: "shutdown" });
				await client.close();
				expect(
					await waitForDaemonExit({
						agentDir,
						pid: result.pid,
						socketPath: result.socketPath,
						timeoutMs: 10_000,
					}),
				).toBe("exited");
			} finally {
				await new Promise<void>((resolve) => {
					precreatedPipe.close(() => resolve());
				});
			}
		},
		30_000,
	);

	it("request/response correlation works over the control client", async () => {
		const daemon = runVoltDaemon({ agentDir, foreground: false });
		const healthy = await waitForDaemon();
		const client = createDaemonClient({
			socketPath: healthy.socketPath,
			client: "tui",
			version: "test",
			authToken: healthy.authToken,
			reconnect: false,
		});
		const [statusResponse, clientsResponse, unsupported] = await Promise.all([
			client.request({ type: "status" }),
			client.request({ type: "clients_list" }),
			client.request({ type: "viewer_subscribe", viewerFeedId: "vf-nope" }),
		]);
		expect(statusResponse.type).toBe("status_result");
		expect(clientsResponse.type).toBe("clients_result");
		expect(unsupported.type).toBe("error");
		await client.request({ type: "shutdown" });
		await client.close();
		await expect(daemon).resolves.toBe(0);
	}, 20_000);

	it("broadcasts daemon_shutdown before extension shutdown completes", async () => {
		// Regression: the broadcast used to run AFTER the extension shutdown loop,
		// which can drain streaming runtimes for up to 60s — control clients
		// waited blind for the whole drain.
		let releaseExtension: () => void = () => {};
		const extensionGate = new Promise<void>((resolve) => {
			releaseExtension = resolve;
		});
		let extensionShutdownStarted = false;
		const daemon = runVoltDaemon({ agentDir, foreground: false }, [
			() => ({
				async shutdown() {
					extensionShutdownStarted = true;
					await extensionGate;
				},
			}),
		]);
		const healthy = await waitForDaemon();

		const events: ControlEvent[] = [];
		const client = createDaemonClient({
			socketPath: healthy.socketPath,
			client: "cli",
			version: "test",
			authToken: healthy.authToken,
			reconnect: false,
			onEvent: (event) => events.push(event),
		});
		await client.request({ type: "shutdown" });

		// The broadcast must arrive while the extension is still draining.
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline && !events.some((event) => event.type === "daemon_shutdown")) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(events.some((event) => event.type === "daemon_shutdown")).toBe(true);
		expect(extensionShutdownStarted).toBe(true);

		releaseExtension();
		await expect(daemon).resolves.toBe(0);
		await client.close();
	}, 20_000);
});

describe("daemon log rotation", () => {
	it("rotates at the size threshold keeping one rotated file", () => {
		const dir = mkdtempSync(join(tmpdir(), "voltd-log-"));
		try {
			const logPath = join(dir, "voltd.log");
			const logger = createDaemonLogger({ logPath });
			const bigDetail = "x".repeat(1024 * 1024);
			for (let index = 0; index < 11; index++) {
				logger.log("info", "test", `entry ${index}`, { pad: bigDetail });
			}
			expect(existsSync(`${logPath}.1`)).toBe(true);
			expect(existsSync(logPath)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
