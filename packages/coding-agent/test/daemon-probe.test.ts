import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { encodeControlLine, PROTOCOL_VERSION } from "../src/daemon/control-protocol.ts";
import { probeControlSocket } from "../src/daemon/control-server.ts";
import { createTestSocketEndpoint, listenTestServer } from "./socket-test-helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

function tempSocketPath(): string {
	const endpoint = createTestSocketEndpoint("volt-probe");
	cleanups.push(endpoint.cleanup);
	return endpoint.socketPath;
}

async function startProbeServer(socketPath: string, handle: (socket: Socket) => void): Promise<Server> {
	const server = createServer(handle);
	await listenTestServer(server, socketPath);
	return server;
}

describe("control socket probe classification", () => {
	it("classifies a shutting-down daemon as live instead of stale", async () => {
		const socketPath = tempSocketPath();
		const server = await startProbeServer(socketPath, (socket) => {
			socket.once("data", () => {
				socket.end(
					encodeControlLine({
						type: "hello_ack",
						ok: false,
						error: "shutting_down",
						version: "0.0.0-test",
						protocolVersion: PROTOCOL_VERSION,
					}),
				);
			});
		});
		cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

		await expect(probeControlSocket(socketPath, { version: "test" })).resolves.toMatchObject({
			kind: "live-rejected",
			reason: "shutting_down",
		});
	});

	it("classifies a missing socket as no-listener", async () => {
		await expect(probeControlSocket(tempSocketPath(), { version: "test", timeoutMs: 50 })).resolves.toMatchObject({
			kind: "no-listener",
		});
	});
});
