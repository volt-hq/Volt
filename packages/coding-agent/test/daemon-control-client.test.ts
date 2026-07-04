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

describe("daemon control client reconnect", () => {
	it("keeps retrying after the initial dial fails", async () => {
		const socketPath = tempSocketPath();
		const stateChanges: string[] = [];
		const client = createDaemonClient({
			socketPath,
			client: "tui",
			version: "0.0.0-test",
			reconnect: true,
			minBackoffMs: 20,
			maxBackoffMs: 20,
			onConnectionStateChange: (state) => stateChanges.push(state),
		});

		await expect(client.connect()).rejects.toThrow();
		expect(client.connectionState).toBe("reconnecting");

		let helloCount = 0;
		const server = await new Promise<Server>((resolve) => {
			const created = createServer((socket: Socket) => {
				const decoder = new ControlLineDecoder();
				socket.on("data", (chunk) => {
					for (const message of decoder.push(chunk)) {
						if ((message as Record<string, unknown>).type === "hello") {
							helloCount++;
							socket.write(
								encodeControlLine({
									type: "hello_ack",
									ok: true,
									connectionId: `c-${helloCount}`,
									version: "0.0.0-test",
									protocolVersion: PROTOCOL_VERSION,
								}),
							);
						}
					}
				});
			});
			created.listen(socketPath, () => resolve(created));
		});
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		cleanups.push(() => client.close());

		const deadline = Date.now() + 2000;
		while (Date.now() < deadline && client.connectionState !== "connected") {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(client.connectionState).toBe("connected");
		expect(helloCount).toBeGreaterThanOrEqual(1);
		expect(stateChanges).toContain("connected");
	});

	it("stops reconnecting after a protocol mismatch", async () => {
		const socketPath = tempSocketPath();
		let helloCount = 0;
		const server = await new Promise<Server>((resolve) => {
			const created = createServer((socket: Socket) => {
				const decoder = new ControlLineDecoder();
				socket.on("data", (chunk) => {
					for (const message of decoder.push(chunk)) {
						if ((message as Record<string, unknown>).type === "hello") {
							helloCount++;
							socket.end(
								encodeControlLine({
									type: "hello_ack",
									ok: false,
									error: "protocol_mismatch",
									version: "older",
									protocolVersion: PROTOCOL_VERSION + 1,
								}),
							);
						}
					}
				});
			});
			created.listen(socketPath, () => resolve(created));
		});
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
		const client = createDaemonClient({
			socketPath,
			client: "tui",
			version: "0.0.0-test",
			reconnect: true,
			minBackoffMs: 20,
			maxBackoffMs: 20,
		});
		cleanups.push(() => client.close());

		await expect(client.connect()).rejects.toThrow(/protocol_mismatch/);
		expect(client.connectionState).toBe("gone");
		expect(client.goneReason).toBe("protocol_mismatch");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(helloCount).toBe(1);
	});

	it("goes gone when a reconnect-disabled connection drops after hello", async () => {
		// Regression: `volt remote pair` uses a reconnect-disabled client and awaits
		// onConnectionStateChange("gone"). When the established connection dropped,
		// the close handler called scheduleReconnect(), which early-returns for a
		// reconnect-disabled client WITHOUT emitting a state change — so the pair
		// command hung forever.
		const socketPath = tempSocketPath();
		const serverSockets: Socket[] = [];
		const server = await new Promise<Server>((resolve) => {
			const created = createServer((socket: Socket) => {
				serverSockets.push(socket);
				const decoder = new ControlLineDecoder();
				socket.on("error", () => {});
				socket.on("data", (chunk) => {
					for (const message of decoder.push(chunk)) {
						if ((message as Record<string, unknown>).type === "hello") {
							socket.write(
								encodeControlLine({
									type: "hello_ack",
									ok: true,
									connectionId: "c-1",
									version: "0.0.0-test",
									protocolVersion: PROTOCOL_VERSION,
								}),
							);
						}
					}
				});
			});
			created.listen(socketPath, () => resolve(created));
		});
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

		const stateChanges: string[] = [];
		const client = createDaemonClient({
			socketPath,
			client: "tui",
			version: "0.0.0-test",
			reconnect: false,
			onConnectionStateChange: (state) => stateChanges.push(state),
		});
		cleanups.push(() => client.close());
		await client.connect();
		expect(client.connectionState).toBe("connected");

		serverSockets[0]?.destroy();
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline && client.connectionState !== "gone") {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(client.connectionState).toBe("gone");
		expect(client.goneReason).toBe("closed");
		expect(stateChanges).toContain("gone");
	});

	it("does not stack a second connection when the backoff timer races a manual reconnect", async () => {
		// Regression: after a disconnect, a manual connect() (e.g. from request())
		// re-established the socket, and the still-armed backoff timer then dialed
		// AGAIN, orphaning the healthy connection and delivering every daemon
		// event twice.
		const socketPath = tempSocketPath();
		const serverSockets: Socket[] = [];
		let helloCount = 0;
		const server = await new Promise<Server>((resolve) => {
			const created = createServer((socket: Socket) => {
				serverSockets.push(socket);
				const decoder = new ControlLineDecoder();
				socket.on("data", (chunk) => {
					for (const message of decoder.push(chunk)) {
						if ((message as Record<string, unknown>).type === "hello") {
							helloCount++;
							socket.write(
								encodeControlLine({
									type: "hello_ack",
									ok: true,
									connectionId: `c-${helloCount}`,
									version: "0.0.0-test",
									protocolVersion: PROTOCOL_VERSION,
								}),
							);
						}
					}
				});
				socket.on("error", () => {});
			});
			created.listen(socketPath, () => resolve(created));
		});
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

		const client = createDaemonClient({
			socketPath,
			client: "tui",
			version: "0.0.0-test",
			reconnect: true,
			// Large enough that the manual reconnect below reliably wins the race.
			minBackoffMs: 300,
			maxBackoffMs: 300,
		});
		cleanups.push(() => client.close());
		await client.connect();
		expect(helloCount).toBe(1);

		// Server drops the connection; the client arms a ~300ms backoff dial.
		serverSockets[0]?.destroy();
		const disconnectDeadline = Date.now() + 2000;
		while (Date.now() < disconnectDeadline && client.connectionState === "connected") {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(client.connectionState).toBe("reconnecting");
		// Manual reconnect wins the race before the timer fires.
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline && client.connectionState !== "connected") {
			await client.connect().catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		expect(client.connectionState).toBe("connected");
		expect(helloCount).toBe(2);

		// Give the backoff timer ample time to fire; it must not dial again.
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(helloCount).toBe(2);
	});
});
