import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { encodeControlLine, PROTOCOL_VERSION } from "../src/daemon/control-protocol.ts";
import { probeControlSocket } from "../src/daemon/control-server.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

function tempSocketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "volt-probe-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return join(dir, "control.sock");
}

async function startProbeServer(socketPath: string, handle: (socket: Socket) => void): Promise<Server> {
	return new Promise((resolve) => {
		const server = createServer(handle);
		server.listen(socketPath, () => resolve(server));
	});
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
