import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { classifyDaemonSignalError, type DaemonStopSignalResult, escalateDaemonExit } from "../src/daemon/cli.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { classifyPublishedDaemonGeneration, waitForDaemonExit } from "../src/daemon/spawn.ts";

function scriptedExitWaits(results: Array<"exited" | "timeout">) {
	let index = 0;
	return vi.fn(async () => results[index++] ?? "timeout");
}

describe("daemon stop escalation", () => {
	it.each([
		["ESRCH", "gone"],
		["EPERM", "refused"],
		["EINVAL", "refused"],
	] as const)("classifies %s process-signal errors as %s", (code, expected) => {
		const error = Object.assign(new Error(`signal failed: ${code}`), { code });
		expect(classifyDaemonSignalError(error)).toBe(expected);
	});

	it("fails closed when a process-signal failure has no OS errno", () => {
		expect(classifyDaemonSignalError(new Error("unknown signal failure"))).toBe("refused");
	});

	it("returns after the single graceful wait when the daemon exits", async () => {
		const waitForExit = scriptedExitWaits(["exited"]);
		const sendSignal = vi.fn(async (): Promise<DaemonStopSignalResult> => "sent");

		await expect(
			escalateDaemonExit({
				gracefulShutdownRequested: true,
				gracefulTimeoutMs: 75_000,
				signalGraceTimeoutMs: 5_000,
				waitForExit,
				sendSignal,
			}),
		).resolves.toBe("exited");
		expect(waitForExit.mock.calls).toEqual([[75_000]]);
		expect(sendSignal).not.toHaveBeenCalled();
	});

	it("uses a short wait after SIGTERM instead of a second graceful timeout", async () => {
		const waitForExit = scriptedExitWaits(["timeout", "exited"]);
		const sendSignal = vi.fn(async (): Promise<DaemonStopSignalResult> => "sent");

		await expect(
			escalateDaemonExit({
				gracefulShutdownRequested: true,
				gracefulTimeoutMs: 75_000,
				signalGraceTimeoutMs: 5_000,
				waitForExit,
				sendSignal,
			}),
		).resolves.toBe("exited");
		expect(waitForExit.mock.calls).toEqual([[75_000], [5_000]]);
		expect(sendSignal.mock.calls).toEqual([["SIGTERM"]]);
	});

	it("escalates from verified SIGTERM to SIGKILL after the short grace", async () => {
		const waitForExit = scriptedExitWaits(["timeout", "timeout", "exited"]);
		const sendSignal = vi.fn(async (): Promise<DaemonStopSignalResult> => "sent");

		await expect(
			escalateDaemonExit({
				gracefulShutdownRequested: true,
				gracefulTimeoutMs: 75_000,
				signalGraceTimeoutMs: 5_000,
				waitForExit,
				sendSignal,
			}),
		).resolves.toBe("exited");
		expect(waitForExit.mock.calls).toEqual([[75_000], [5_000], [5_000]]);
		expect(sendSignal.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
	});

	it("stops escalation when process identity verification refuses a signal", async () => {
		const waitForExit = scriptedExitWaits(["timeout"]);
		const sendSignal = vi.fn(async (): Promise<DaemonStopSignalResult> => "refused");

		await expect(
			escalateDaemonExit({
				gracefulShutdownRequested: true,
				gracefulTimeoutMs: 75_000,
				signalGraceTimeoutMs: 5_000,
				waitForExit,
				sendSignal,
			}),
		).resolves.toBe("refused");
		expect(waitForExit.mock.calls).toEqual([[75_000]]);
		expect(sendSignal.mock.calls).toEqual([["SIGTERM"]]);
	});

	it("treats a replacement pidfile generation as the target having exited", async () => {
		const target = {
			pid: 101,
			version: "test",
			startedAtMs: 1_000,
			socketPath: "/tmp/voltd.sock",
			token: "generation-a",
		};
		const replacement = { ...target, token: "generation-b" };
		expect(classifyPublishedDaemonGeneration(target, replacement)).toBe("retired");

		const waitForExit = scriptedExitWaits([]);
		const sendSignal = vi.fn(async (): Promise<DaemonStopSignalResult> => "gone");
		await expect(
			escalateDaemonExit({
				gracefulShutdownRequested: false,
				gracefulTimeoutMs: 75_000,
				signalGraceTimeoutMs: 5_000,
				waitForExit,
				sendSignal,
			}),
		).resolves.toBe("exited");
		expect(sendSignal.mock.calls).toEqual([["SIGTERM"]]);
		expect(waitForExit).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")(
		"finishes the target-generation wait when a replacement owns the shared socket",
		async () => {
			const agentDir = mkdtempSync(join(tmpdir(), "volt-stop-generation-"));
			const paths = getDaemonPaths(agentDir);
			mkdirSync(paths.daemonDir, { recursive: true });
			const target = {
				pid: process.pid,
				version: "test",
				startedAtMs: 1_000,
				socketPath: paths.socketPath,
				token: "generation-a",
			};
			writeFileSync(paths.pidfilePath, `${JSON.stringify({ ...target, token: "generation-b" })}\n`);
			const replacementSocket = createServer((socket) => socket.destroy());
			try {
				await new Promise<void>((resolve, reject) => {
					replacementSocket.once("error", reject);
					replacementSocket.listen(paths.socketPath, resolve);
				});
				await expect(
					waitForDaemonExit({
						agentDir,
						pid: target.pid,
						pidfile: target,
						socketPath: paths.socketPath,
						timeoutMs: 50,
					}),
				).resolves.toBe("exited");
			} finally {
				if (replacementSocket.listening) {
					await new Promise<void>((resolve, reject) => {
						replacementSocket.close((error) => (error ? reject(error) : resolve()));
					});
				}
				rmSync(agentDir, { force: true, recursive: true });
			}
		},
	);

	it("reports timeout only after SIGKILL also fails to terminate the daemon", async () => {
		const waitForExit = scriptedExitWaits(["timeout", "timeout", "timeout"]);
		const sendSignal = vi.fn(async (): Promise<DaemonStopSignalResult> => "sent");

		await expect(
			escalateDaemonExit({
				gracefulShutdownRequested: true,
				gracefulTimeoutMs: 75_000,
				signalGraceTimeoutMs: 5_000,
				waitForExit,
				sendSignal,
			}),
		).resolves.toBe("timeout");
		expect(sendSignal.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
	});

	it("gives an unreachable verified daemon a full drain after the initial SIGTERM", async () => {
		const waitForExit = scriptedExitWaits(["timeout", "exited"]);
		const sendSignal = vi.fn(async (): Promise<DaemonStopSignalResult> => "sent");

		await expect(
			escalateDaemonExit({
				gracefulShutdownRequested: false,
				gracefulTimeoutMs: 75_000,
				signalGraceTimeoutMs: 5_000,
				waitForExit,
				sendSignal,
			}),
		).resolves.toBe("exited");
		expect(waitForExit.mock.calls).toEqual([[75_000], [5_000]]);
		expect(sendSignal.mock.calls).toEqual([["SIGTERM"], ["SIGTERM"]]);
	});
});
