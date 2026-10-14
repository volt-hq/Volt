/**
 * `volt daemon extension-inventory` (hidden): one extension inventory as a
 * process of its own, started by the daemon's `ProcessWorkerLauncher` in the
 * root it evaluates. The request arrives as one JSON line on stdin; the result
 * leaves as one JSON line on fd 3 (stdout and stderr are its log, where an
 * extension's own output goes). It evaluates once and exits, ending the
 * detached process trees anything it ran started; past its deadline it exits
 * without a result.
 */

import { Socket } from "node:net";
import { isAbsolute } from "node:path";
import { EXTENSION_ERROR_MAX_CHARS } from "@hansjm10/volt-protocol";
import { SettingsManager } from "../../core/settings-manager.ts";
import { initTheme } from "../../core/theme/runtime.ts";
import { killTrackedDetachedChildren } from "../../utils/shell.ts";
import type { ExtensionInventoryProbeOutput } from "../extension-inventory.ts";
import type { ExtensionInventoryProbeRequest } from "../worker-launcher.ts";
import { evaluateExtensionInventory } from "./extension-inventory.ts";

/** How long an evaluation may run before the process exits without a result. */
export const EXTENSION_INVENTORY_PROCESS_DEADLINE_MS = 25_000;
const MAX_REQUEST_BYTES = 16 * 1024;
/** The process wrote its result, whether an evaluation or a failure. */
const WROTE_RESULT = 0;
/** It could not read its request or write its result. */
const FAILED = 4;
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

/** Write `output` as one line on the result fd, and wait until it is written. */
function writeResult(output: ExtensionInventoryProbeOutput): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = new Socket({ fd: RESULT_FD, readable: false, writable: true });
		socket.once("error", reject);
		socket.end(`${JSON.stringify(output)}\n`, () => resolve());
	});
}

/** Evaluate the requested inventory and write it; resolves with the process' exit code. */
export async function runExtensionInventoryProcess(agentDir: string): Promise<number> {
	process.title = "volt-extension-inventory";
	const deadline = setTimeout(() => {
		console.error(`${new Date().toISOString()} extension inventory did not finish; exiting`);
		killTrackedDetachedChildren();
		process.exit(FAILED);
	}, EXTENSION_INVENTORY_PROCESS_DEADLINE_MS);
	deadline.unref();
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
			inputs: [...inventory.inputs],
			cacheable: inventory.cacheable,
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
	return WROTE_RESULT;
}
