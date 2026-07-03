import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import type { ControlEvent } from "../src/daemon/control-protocol.ts";
import { probeControlSocket } from "../src/daemon/control-server.ts";
import { createDaemonLogger } from "../src/daemon/log.ts";
import { readPidfile, runVoltDaemon, VOLTD_EXIT_ALREADY_RUNNING } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";

describe("voltd lifecycle", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-life-"));
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("serves status, rejects a second instance, and shuts down gracefully", async () => {
		const paths = getDaemonPaths(agentDir);
		const daemon = runVoltDaemon({ agentDir, foreground: false });

		// Probe until healthy.
		let status = await probeControlSocket(paths.socketPath, { version: "test" });
		for (let attempt = 0; !status && attempt < 50; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeControlSocket(paths.socketPath, { version: "test" });
		}
		expect(status).toBeDefined();
		expect(status?.pid).toBe(process.pid);

		// Pidfile is advisory but present and truthful.
		const pidfile = readPidfile(paths.pidfilePath);
		expect(pidfile?.pid).toBe(process.pid);
		expect(pidfile?.socketPath).toBe(paths.socketPath);

		// A second daemon on the same agent dir exits with already_running.
		await expect(runVoltDaemon({ agentDir, foreground: false })).resolves.toBe(VOLTD_EXIT_ALREADY_RUNNING);

		// Control client sees the shutdown broadcast on graceful shutdown.
		const events: ControlEvent[] = [];
		const client = createDaemonClient({
			socketPath: paths.socketPath,
			client: "cli",
			version: "test",
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

	it("recovers from a stale socket file", async () => {
		const paths = getDaemonPaths(agentDir);
		mkdirSync(paths.daemonDir, { recursive: true, mode: 0o700 });
		// A leftover regular file at the socket path produces EADDRINUSE on bind.
		writeFileSync(paths.socketPath, "", { mode: 0o600 });
		const daemon = runVoltDaemon({ agentDir, foreground: false });
		let status = await probeControlSocket(paths.socketPath, { version: "test" });
		for (let attempt = 0; !status && attempt < 50; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeControlSocket(paths.socketPath, { version: "test" });
		}
		expect(status).toBeDefined();
		const client = createDaemonClient({
			socketPath: paths.socketPath,
			client: "cli",
			version: "test",
			reconnect: false,
		});
		await client.request({ type: "shutdown" });
		await client.close();
		await expect(daemon).resolves.toBe(0);
	}, 20_000);

	it("request/response correlation works over the control client", async () => {
		const paths = getDaemonPaths(agentDir);
		const daemon = runVoltDaemon({ agentDir, foreground: false });
		let healthy = await probeControlSocket(paths.socketPath, { version: "test" });
		for (let attempt = 0; !healthy && attempt < 50; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			healthy = await probeControlSocket(paths.socketPath, { version: "test" });
		}
		const client = createDaemonClient({
			socketPath: paths.socketPath,
			client: "tui",
			version: "test",
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
		const paths = getDaemonPaths(agentDir);
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
		let healthy = await probeControlSocket(paths.socketPath, { version: "test" });
		for (let attempt = 0; !healthy && attempt < 50; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			healthy = await probeControlSocket(paths.socketPath, { version: "test" });
		}
		expect(healthy).toBeDefined();

		const events: ControlEvent[] = [];
		const client = createDaemonClient({
			socketPath: paths.socketPath,
			client: "cli",
			version: "test",
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
