import assert from "node:assert/strict";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { LspClient } from "../../src/core/lsp/client.ts";
import { waitForLsp } from "../../src/core/lsp/outcome.ts";

// Run in a fresh Node process with strict unhandled rejections. Do not attach
// an observer to the abandoned work until after its rejection has been checked.
const scenario = process.argv[2];
if (scenario === "preaborted" || scenario === "later-abort") {
	const controller = new AbortController();
	let fail!: (error: Error) => void;
	const startup = new Promise<void>((_, reject) => {
		fail = reject;
	});
	if (scenario === "preaborted") controller.abort();
	const wait = waitForLsp(startup, controller.signal);
	controller.abort();
	await assert.rejects(wait, { outcome: "cancelled", reason: "aborted" });
	const error = new Error("startup failed after cancellation");
	fail(error);
	await nextTurn();
	await nextTurn();
	await assert.rejects(startup, (actual) => actual === error);
} else {
	const timeout = scenario === "client-timeout";
	const client = new LspClient({
		serverName: "fake",
		rootDir: process.cwd(),
		command: [
			process.execPath,
			fileURLToPath(new URL("./fake-lsp-server.mjs", import.meta.url)),
			timeout ? "--hang-initialize" : "--init-error",
		],
		requestTimeoutMs: timeout ? 100 : 5000,
	});
	try {
		if (scenario === "client-disposed") client.dispose();
		const startup = client.start();
		assert.equal(client.start(), startup);
		if (scenario !== "client-disposed") {
			assert.equal(client.isStarting, true);
			const deadline = Date.now() + 10000;
			while (client.isStarting) {
				assert.ok(Date.now() < deadline, "startup must settle within its deadline");
				await delay(10);
			}
		}
		await nextTurn();
		await nextTurn();
		assert.equal(client.isAlive, false);
		assert.equal(client.isReady, false);
		assert.equal(client.start(), startup);
		await assert.rejects(startup, {
			outcome: timeout ? "timeout" : "unavailable",
			reason: timeout ? "startup-timeout" : scenario === "client-disposed" ? "disposed" : "startup-failed",
		});
	} finally {
		client.dispose();
	}
}
console.log("lifecycle settled without an unhandled rejection");
