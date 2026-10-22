/**
 * `volt daemon extension-inventory` (hidden): one extension inventory as a
 * process of its own, started by the daemon's `ProcessWorkerLauncher` in the
 * root it evaluates. The request arrives as one JSON line on stdin; the result
 * leaves as one JSON line on fd 3 (stdout and stderr are its log, where an
 * extension's own output goes). It evaluates once, writes its result, closes
 * fd 3, and waits: the daemon then ends every process still descended from it,
 * which it can find only while this process runs, and then this process
 * (`ProcessTreeHold.end`). Every exit it performs also ends the processes
 * still descended from it (RFC §5.3, worker process tree), and the daemon then
 * ends what it can still find: past its deadline, or on SIGTERM, before it has
 * a result, it exits without one; the deadline comes before the daemon's own
 * timeout. Past its deadline after its result (the daemon is gone), it exits
 * as if stopped; on an uncaught error, with code 1.
 */

import { Socket } from "node:net";
import { isAbsolute } from "node:path";
import { EXTENSION_ERROR_MAX_CHARS } from "@hansjm10/volt-protocol";
import { SettingsManager } from "../../core/settings-manager.ts";
import { initTheme } from "../../core/theme/runtime.ts";
import type { ExtensionInventoryProbeOutput } from "../extension-inventory.ts";
import { exitOnUncaughtError, killOwnDescendants } from "../process-tree.ts";
import { EXTENSION_INVENTORY_EXIT_CODES, type ExtensionInventoryProbeRequest } from "../worker-launcher.ts";
import { evaluateExtensionInventory } from "./extension-inventory.ts";

/**
 * How long an evaluation may run before the process exits without a result: before the daemon's timeout
 * (`EXTENSION_INVENTORY_TIMEOUT_MS`).
 */
export const EXTENSION_INVENTORY_PROCESS_DEADLINE_MS = 15_000;
const MAX_REQUEST_BYTES = 16 * 1024;
const { wroteResult: WROTE_RESULT, failed: FAILED } = EXTENSION_INVENTORY_EXIT_CODES;
/** The fd its result goes to. */
const RESULT_FD = 3;

function isRequest(value: unknown): value is ExtensionInventoryProbeRequest {
	if (typeof value !== "object" || value === null) return false;
	const fields = value as Record<string, unknown>;
	return (
		typeof fields.root === "string" &&
		isAbsolute(fields.root) &&
		typeof fields.projectTrusted === "boolean" &&
		(fields.profile === undefined || typeof fields.profile === "string")
	);
}

/** Read the request line from stdin. */
function readRequest(): Promise<ExtensionInventoryProbeRequest> {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		let buffered = "";
		const finish = (error: Error | undefined, request?: ExtensionInventoryProbeRequest) => {
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			stdin.off("error", onEnd);
			stdin.destroy();
			if (error) reject(error);
			else if (request) resolve(request);
		};
		const onData = (chunk: string) => {
			buffered += chunk;
			const newline = buffered.indexOf("\n");
			if (newline === -1) {
				if (buffered.length > MAX_REQUEST_BYTES) finish(new Error("The extension inventory request is too large"));
				return;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(buffered.slice(0, newline));
			} catch {
				finish(new Error("The extension inventory request is not JSON"));
				return;
			}
			if (!isRequest(parsed)) finish(new Error("The extension inventory request is malformed"));
			else finish(undefined, parsed);
		};
		const onEnd = () => finish(new Error("No extension inventory request on stdin"));
		stdin.setEncoding("utf8");
		stdin.on("data", onData);
		stdin.once("end", onEnd);
		stdin.once("error", onEnd);
	});
}

/** Write `output` as one line on the result fd, and wait until it is written and the fd closed. */
function writeResult(output: ExtensionInventoryProbeOutput): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = new Socket({ fd: RESULT_FD, readable: false, writable: true });
		socket.once("error", reject);
		// Closed, so the daemon reads the end of the result while this process waits to be stopped.
		socket.end(`${JSON.stringify(output)}\n`, () => {
			socket.destroy();
			resolve();
		});
	});
}

/**
 * Evaluate the requested inventory, write it, and wait to be stopped; resolves with the process' exit code once
 * it is (or it could not read its request or write its result).
 */
export async function runExtensionInventoryProcess(agentDir: string): Promise<number> {
	process.title = "volt-extension-inventory";
	exitOnUncaughtError("volt extension inventory");
	let answered = false;
	const stopped = Promise.withResolvers<void>();
	/** Exit without a result, ending the processes still descended from this one. */
	const abandon = (reason: string): never => {
		console.error(`${new Date().toISOString()} extension inventory ${reason}; exiting`);
		killOwnDescendants();
		process.exit(FAILED);
	};
	/** Without a result, abandon it; with one, return, and the caller ends this process's descendants and exits. */
	const stop = (reason: string) => {
		if (!answered) abandon(reason);
		console.error(`${new Date().toISOString()} extension inventory ${reason} after its result; exiting`);
		stopped.resolve();
	};
	const deadline = setTimeout(
		() => stop(answered ? "was not stopped" : "did not finish"),
		EXTENSION_INVENTORY_PROCESS_DEADLINE_MS,
	);
	deadline.unref();
	process.once("SIGTERM", () => stop("received SIGTERM"));
	let request: ExtensionInventoryProbeRequest;
	try {
		request = await readRequest();
	} catch (error) {
		console.error(`volt extension inventory: ${error instanceof Error ? error.message : String(error)}`);
		return FAILED;
	}
	console.error(`${new Date().toISOString()} extension inventory pid ${process.pid} of ${request.root}`);
	// The theme extensions see; the global one, as a worker uses.
	initTheme(SettingsManager.create(agentDir, agentDir, { projectTrusted: false }).getTheme(), false);
	let output: ExtensionInventoryProbeOutput;
	try {
		const inventory = await evaluateExtensionInventory({ ...request, agentDir });
		output = {
			ok: true,
			projectTrusted: inventory.projectTrusted,
			extensions: [...inventory.extensions],
			reviewEngines: [...inventory.reviewEngines],
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`${new Date().toISOString()} extension inventory failed: ${message}`);
		output = { ok: false, error: message.slice(0, EXTENSION_ERROR_MAX_CHARS) };
	}
	try {
		await writeResult(output);
	} catch (error) {
		console.error(`volt extension inventory: ${error instanceof Error ? error.message : String(error)}`);
		return FAILED;
	}
	answered = true;
	// Running until the daemon stops it, so that it can find what the extensions started; the deadline if it is gone.
	deadline.ref();
	await stopped.promise;
	return WROTE_RESULT;
}
