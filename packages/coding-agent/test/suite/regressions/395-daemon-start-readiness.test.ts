import * as childProcess from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDaemonCommand } from "../../../src/daemon/cli.ts";
import { type ControlSocketProbe, probeControlSocket } from "../../../src/daemon/control-server.ts";
import * as daemonLock from "../../../src/daemon/daemon-lock.ts";
import { runVoltDaemon, VOLTD_EXIT_STARTUP_CONTENDED } from "../../../src/daemon/main.ts";
import { getDaemonPaths } from "../../../src/daemon/paths.ts";
import { handleRemoteControlCommand } from "../../../src/daemon/remote-cli.ts";
import { ensureDaemonRunning, probeDaemon, spawnDetachedDaemon } from "../../../src/daemon/spawn.ts";
import { createHarness, type Harness } from "../harness.ts";

vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	spawn: vi.fn(),
}));

vi.mock("../../../src/daemon/control-server.ts", async (importOriginal) => ({
	...(await importOriginal<{ probeControlSocket: typeof probeControlSocket }>()),
	probeControlSocket: vi.fn(),
}));

class DaemonChild extends childProcess.ChildProcess {
	override readonly pid = 4242;
	override exitCode: number | null = null;
	override signalCode: NodeJS.Signals | null = null;
}

let harness: Harness;
let child: DaemonChild;
const originalExitCode = process.exitCode;

function healthyProbe(pid = child.pid): ControlSocketProbe {
	return {
		kind: "healthy",
		status: {
			type: "status_result",
			id: "probe",
			pid,
			version: "test",
			protocolVersion: 1,
			startedAtMs: 0,
			leases: [],
			phoneConnections: 0,
			workspaces: [],
			clients: [],
			remoteTransport: { state: "starting" },
			keepAwake: { enabled: false, state: "disabled" },
		},
	};
}

beforeEach(async () => {
	harness = await createHarness({ tools: [], settings: { lsp: { enabled: false } } });
	// These process tests only need the isolated agent directory. Stop the
	// session's background services before simulating the daemon's clock.
	harness.session.dispose();
	await harness.session.waitForClosed();
	child = new DaemonChild();
	vi.spyOn(child, "kill");
	vi.mocked(childProcess.spawn).mockReset().mockReturnValue(child);
	vi.mocked(probeControlSocket).mockReset().mockResolvedValue({ kind: "no-listener", cause: "not-found" });
	vi.useFakeTimers();
	vi.setSystemTime(0);
	process.exitCode = 0;
});

afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	process.exitCode = originalExitCode;
	await harness.cleanupAsync();
});

describe("#395 detached daemon startup readiness", () => {
	it("waits for a slow child and returns as soon as local control is healthy", async () => {
		vi.mocked(probeControlSocket).mockImplementation(async () =>
			Date.now() >= 30_000 ? healthyProbe() : { kind: "no-listener", cause: "not-found" },
		);
		let settled = false;
		const pending = spawnDetachedDaemon(harness.tempDir).then((result) => {
			settled = true;
			return result;
		});

		await vi.advanceTimersByTimeAsync(29_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toMatchObject({ ok: true, pid: child.pid });
		expect(childProcess.spawn).toHaveBeenCalledOnce();
		expect(child.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not wait for phone transport once local control is healthy", async () => {
		vi.mocked(probeControlSocket).mockResolvedValue(healthyProbe());
		await expect(spawnDetachedDaemon(harness.tempDir)).resolves.toMatchObject({ ok: true, pid: child.pid });
		expect(Date.now()).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it.each([
		{ code: 1, signal: null, reason: "exit code 1" },
		{ code: 0, signal: null, reason: "exit code 0" },
		{ code: 4, signal: null, reason: "exit code 4" },
		{ code: null, signal: "SIGTERM", reason: "signal SIGTERM" },
	] as const)("reports $reason promptly instead of waiting for the deadline", async ({ code, signal, reason }) => {
		setTimeout(() => {
			child.exitCode = code;
			child.signalCode = signal;
			child.emit("exit", code, signal);
		}, 25);
		const pending = spawnDetachedDaemon(harness.tempDir);
		await vi.advanceTimersByTimeAsync(100);
		await expect(pending).resolves.toMatchObject({
			ok: false,
			state: "not-running",
			pid: child.pid,
			error: `voltd exited before becoming healthy (${reason})`,
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports a spawn error without an unhandled error event or a readiness timeout", async () => {
		setTimeout(() => child.emit("error", new Error("spawn ENOENT")), 0);
		const pending = spawnDetachedDaemon(harness.tempDir);
		await vi.advanceTimersByTimeAsync(100);
		await expect(pending).resolves.toMatchObject({
			ok: false,
			state: "not-running",
			error: "failed to spawn voltd: spawn ENOENT",
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves the live child's PID and starting state after the 60-second deadline", async () => {
		const pending = ensureDaemonRunning(harness.tempDir);
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(pending).resolves.toMatchObject({
			healthy: false,
			state: "starting",
			spawned: true,
			pid: child.pid,
			error: expect.stringContaining("readiness unconfirmed after 60s; process still running (pid 4242)"),
		});
		expect(childProcess.spawn).toHaveBeenCalledOnce();
		expect(child.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reports an exit at the deadline rather than claiming the process is still alive", async () => {
		setTimeout(() => {
			child.exitCode = 4;
			child.emit("exit", 4, null);
		}, 60_000);
		const pending = spawnDetachedDaemon(harness.tempDir);
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(pending).resolves.toMatchObject({
			ok: false,
			state: "not-running",
			error: expect.stringContaining("exit code 4"),
		});
	});

	it("bounds the whole readiness wait even when socket probes do not respond", async () => {
		vi.mocked(probeControlSocket).mockImplementation(
			(_path, options) =>
				new Promise((resolve) => setTimeout(() => resolve({ kind: "unresponsive" }), options?.timeoutMs)),
		);
		const pending = spawnDetachedDaemon(harness.tempDir);
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(pending).resolves.toMatchObject({ ok: false, state: "starting" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("shares a probe budget across the pidfile and default endpoints", async () => {
		const paths = getDaemonPaths(harness.tempDir);
		mkdirSync(paths.daemonDir, { recursive: true });
		writeFileSync(paths.pidfilePath, JSON.stringify({ pid: child.pid, socketPath: "published-endpoint" }));
		vi.mocked(probeControlSocket)
			.mockImplementationOnce(
				() => new Promise((resolve) => setTimeout(() => resolve({ kind: "no-listener", cause: "refused" }), 250)),
			)
			.mockImplementationOnce(
				(_path, options) =>
					new Promise((resolve) => setTimeout(() => resolve({ kind: "unresponsive" }), options?.timeoutMs)),
			);
		const pending = probeDaemon(harness.tempDir, 500);
		await vi.advanceTimersByTimeAsync(500);
		await expect(pending).resolves.toMatchObject({ state: "unresponsive" });
		expect(vi.mocked(probeControlSocket).mock.calls.map((call) => call[1]?.timeoutMs)).toEqual([500, 250]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("accepts a healthy concurrent winner even when the spawned child exits", async () => {
		child.exitCode = 3;
		vi.mocked(probeControlSocket).mockResolvedValue(healthyProbe(5151));
		await expect(spawnDetachedDaemon(harness.tempDir)).resolves.toMatchObject({ ok: true, pid: 5151 });
	});

	it.each(["held", "contended"] as const)("distinguishes a %s startup lock from bind failure", async (reason) => {
		vi.spyOn(daemonLock, "acquireDaemonLock").mockResolvedValue({ ok: false, reason });
		const originalTitle = process.title;
		try {
			await expect(runVoltDaemon({ agentDir: harness.tempDir, foreground: false })).resolves.toBe(
				VOLTD_EXIT_STARTUP_CONTENDED,
			);
		} finally {
			process.title = originalTitle;
		}
	});

	it("waits for a delayed concurrent winner after the spawned child loses the startup lock", async () => {
		setTimeout(() => {
			child.exitCode = VOLTD_EXIT_STARTUP_CONTENDED;
			child.emit("exit", child.exitCode, null);
		}, 25);
		vi.mocked(probeControlSocket).mockImplementation(async () =>
			Date.now() >= 30_000 ? healthyProbe(5151) : { kind: "no-listener", cause: "not-found" },
		);
		let settled = false;
		const pending = ensureDaemonRunning(harness.tempDir).then((result) => {
			settled = true;
			return result;
		});

		await vi.advanceTimersByTimeAsync(29_999);
		expect(settled).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toMatchObject({ healthy: true, state: "healthy", pid: 5151, spawned: true });
		expect(childProcess.spawn).toHaveBeenCalledOnce();
		expect(child.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds contention polling without reporting the exited child as alive", async () => {
		setTimeout(() => {
			child.exitCode = VOLTD_EXIT_STARTUP_CONTENDED;
			child.emit("exit", child.exitCode, null);
		}, 30_000);
		const pending = ensureDaemonRunning(harness.tempDir);
		await vi.advanceTimersByTimeAsync(60_000);
		const result = await pending;
		expect(result).toMatchObject({
			healthy: false,
			state: "starting",
			spawned: true,
			error: expect.stringContaining("readiness unconfirmed after 60s; another starter held the startup lock"),
		});
		expect(result.pid).toBeUndefined();
		expect(result.error).not.toContain("process still running");
		expect(childProcess.spawn).toHaveBeenCalledOnce();
		expect(child.kill).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not accept a status from its own child after that child has exited", async () => {
		vi.mocked(probeControlSocket).mockImplementation(async () => {
			child.exitCode = 1;
			return healthyProbe();
		});
		await expect(spawnDetachedDaemon(harness.tempDir)).resolves.toMatchObject({ ok: false, state: "not-running" });
	});

	it.each(["start", "restart"])("prints an honest live-child timeout and log path for daemon %s", async (command) => {
		const output = vi.spyOn(console, "error").mockImplementation(() => {});
		const pending = handleDaemonCommand(["daemon", command], {
			agentDir: harness.tempDir,
			isStandaloneBinary: false,
		});
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(pending).resolves.toBe(true);
		expect(process.exitCode).toBe(1);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("process still running (pid 4242)"));
		expect(output).toHaveBeenCalledWith(`Check the log: ${getDaemonPaths(harness.tempDir).logPath}`);
		expect(child.kill).not.toHaveBeenCalled();
	});

	it("preserves startup diagnostics for remote commands that auto-start the daemon", async () => {
		vi.stubEnv("VOLT_CODING_AGENT_DIR", harness.tempDir);
		const output = vi.spyOn(console, "error").mockImplementation(() => {});
		const pending = handleRemoteControlCommand(["remote", "pair"], { isStandaloneBinary: false });
		await vi.advanceTimersByTimeAsync(60_000);
		await expect(pending).resolves.toBe(true);
		expect(process.exitCode).toBe(1);
		expect(output).toHaveBeenCalledWith(expect.stringContaining("process still running (pid 4242)"));
		expect(output).not.toHaveBeenCalledWith("voltd is not running. Start it with: volt daemon start");
		expect(output).toHaveBeenCalledWith(`Check the log: ${getDaemonPaths(harness.tempDir).logPath}`);
	});
});
