#!/usr/bin/env node
import { fork } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

/** Own the worker process, including provider operations that ignore request cancellation. */
export function supervisePilot(workerPath, args, { timeoutMs = 45 * 60_000, graceMs = 2_000 } = {}) {
	return new Promise((resolveExit, reject) => {
		const child = fork(workerPath, args, { execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] });
		let finishedCode;
		let cancelledCode;
		let workerReady = false;
		let killTimer;
		const cancel = (code) => {
			if (cancelledCode !== undefined) return;
			cancelledCode = code;
			if (child.connected && workerReady) child.send({ type: "pilot-cancel" }, () => {});
			killTimer = setTimeout(() => child.kill("SIGKILL"), graceMs);
		};
		const interrupt = () => cancel(130);
		const terminate = () => cancel(143);
		const deadline = setTimeout(() => cancel(124), timeoutMs);
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", terminate);
		const cleanup = () => {
			clearTimeout(deadline);
			clearTimeout(killTimer);
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
		};
		child.on("message", (message) => {
			if (message?.type === "pilot-ready") {
				workerReady = true;
				child.send({ type: cancelledCode === undefined ? "pilot-start" : "pilot-cancel" }, () => {});
				return;
			}
			if (
				!workerReady ||
				message?.type !== "pilot-finished" ||
				!Number.isInteger(message.exitCode) ||
				message.exitCode < 0 ||
				message.exitCode > 255
			)
				return;
			finishedCode = message.exitCode;
			// The worker sends completion only after artifacts and output streams settle.
			child.kill("SIGKILL");
		});
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("exit", (code) => {
			cleanup();
			resolveExit(cancelledCode ?? finishedCode ?? (code || 1));
		});
	});
}

/** No provider code is admitted until the supervisor grants startup. Owner loss is terminal. */
export function waitForPilotOwner() {
	if (!process.send || !process.connected) throw new Error("Pilot worker requires an IPC owner");
	return new Promise((start) => {
		process.once("disconnect", () => process.exit(130));
		process.on("message", (message) => {
			if (message?.type === "pilot-cancel") process.exit(130);
			if (message?.type === "pilot-start") start();
		});
		process.send({ type: "pilot-ready" });
	});
}

const launcherPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === launcherPath) {
	if (process.argv[2] === "--worker" && process.send) {
		process.argv.splice(2, 1);
		await waitForPilotOwner();
		const entryPath = fileURLToPath(
			new URL("../packages/coding-agent/benchmarks/compaction-quality.ts", import.meta.url),
		);
		process.argv[1] = entryPath;
		const jiti = createJiti(entryPath, {
			tsconfigPaths: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
		});
		await jiti.import(entryPath);
	} else {
		process.exitCode = await supervisePilot(launcherPath, ["--worker", ...process.argv.slice(2)]);
	}
}
