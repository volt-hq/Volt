/**
 * Regression: a provisional lease_pending and its terminal lease_granted can
 * arrive in a single socket read (the daemon writes them back-to-back when a
 * drain completes quickly). The client must hand the terminal response to a
 * later waitForResponse call instead of dropping it on the already-resolved
 * original request promise — that drop left the drain handoff hanging forever.
 */

import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import { ControlLineDecoder, encodeControlLine, PROTOCOL_VERSION } from "../src/daemon/control-protocol.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	// Reverse order: the client must close before the server stops waiting on
	// its open connection.
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

/**
 * Minimal control-plane server that answers a lease_acquire with the
 * provisional and terminal frames coalesced into ONE socket write, so both
 * arrive in the same client read.
 */
function startCoalescingServer(socketPath: string, terminal: "lease_granted" | "error"): Promise<Server> {
	return new Promise((resolve) => {
		const server = createServer((socket: Socket) => {
			const decoder = new ControlLineDecoder();
			socket.on("data", (chunk) => {
				for (const message of decoder.push(chunk)) {
					const request = message as Record<string, unknown>;
					if (request.type === "hello") {
						socket.write(
							encodeControlLine({
								type: "hello_ack",
								ok: true,
								connectionId: "c-1",
								version: "0.0.0-test",
								protocolVersion: PROTOCOL_VERSION,
							}),
						);
						continue;
					}
					if (request.type === "lease_acquire") {
						const terminalFrame =
							terminal === "lease_granted"
								? {
										type: "lease_granted",
										id: request.id,
										workspaceName: request.workspaceName,
										sessionId: request.sessionId,
										handoff: "warm",
									}
								: { type: "error", id: request.id, code: "drain_failed", message: "drain cancelled" };
						socket.write(
							Buffer.concat([
								encodeControlLine({ type: "lease_pending", id: request.id, viewerFeedId: "vf-1" }),
								encodeControlLine(terminalFrame),
							]),
						);
					}
				}
			});
		});
		server.listen(socketPath, () => resolve(server));
	});
}

async function connectClient(socketPath: string) {
	const client = createDaemonClient({ socketPath, client: "tui", version: "0.0.0-test", reconnect: false });
	cleanups.push(() => client.close());
	await client.connect();
	return client;
}

function tempSocketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-control-client-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "control.sock");
}

describe("daemon control client provisional responses", () => {
	it("delivers a terminal lease_granted that arrives in the same read as lease_pending", async () => {
		const socketPath = tempSocketPath();
		const server = await startCoalescingServer(socketPath, "lease_granted");
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const client = await connectClient(socketPath);

		const provisional = await client.request({ type: "lease_acquire", workspaceName: "ws", sessionId: "s-1" });
		expect(provisional.type).toBe("lease_pending");
		const terminal = await client.waitForResponse(provisional.id);
		expect(terminal).toMatchObject({ type: "lease_granted", handoff: "warm" });
	});

	it("delivers a terminal drain error that arrives in the same read as lease_pending", async () => {
		const socketPath = tempSocketPath();
		const server = await startCoalescingServer(socketPath, "error");
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const client = await connectClient(socketPath);

		const provisional = await client.request({ type: "lease_acquire", workspaceName: "ws", sessionId: "s-1" });
		expect(provisional.type).toBe("lease_pending");
		const terminal = await client.waitForResponse(provisional.id);
		expect(terminal).toMatchObject({ type: "error", code: "drain_failed" });
	});
});
