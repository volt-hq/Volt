/**
 * P4 (control-server relay hello): after a relay hello, handleHello removes the
 * data listener and sets handedOffToRelay=true, THEN calls admitRelay — all
 * inside onData's generic try/catch. If admitRelay throws synchronously, the
 * exception propagates to that catch, which calls fatal("frame_too_large") —
 * a misleading error on a socket the relay path may already own.
 *
 * This test injects an admitRelay that throws synchronously to exercise the
 * exact control-flow. Correct behavior: the client must NOT observe a
 * fatal{error:"frame_too_large"} frame that misreports a relay-admission
 * failure as a framing error. If that frame appears, the bug is real (RED).
 */

import type { Buffer } from "node:buffer";
import { createConnection, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
	ControlLineDecoder,
	encodeControlLine,
	type HelloMessage,
	PROTOCOL_VERSION,
} from "../src/daemon/control-protocol.ts";
import { type ControlServer, startControlServer } from "../src/daemon/control-server.ts";
import { createTestSocketEndpoint } from "./socket-test-helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

function tempSocketPath(): string {
	const endpoint = createTestSocketEndpoint("volt-p4");
	cleanups.push(endpoint.cleanup);
	return endpoint.socketPath;
}

describe("P4 relay hello: admitRelay throwing must not emit a misleading fatal(frame_too_large)", () => {
	it("does not report a bogus frame_too_large fatal when admitRelay throws synchronously", async () => {
		const socketPath = tempSocketPath();

		let admitRelayCalled = false;
		const server: ControlServer = await startControlServer({
			socketPath,
			version: "0.0.0-test",
			handlers: {
				onRequest: () => {},
				relayAdmission: {
					admitRelay: () => {
						admitRelayCalled = true;
						// Inject a synchronous throw to drive the exact interleaving the
						// finding describes (no sleeps / races needed).
						throw new Error("boom from admitRelay");
					},
				},
			},
		});
		cleanups.push(() => server.close());

		const client: Socket = createConnection(socketPath);
		cleanups.push(() => {
			client.destroy();
		});
		client.on("error", () => {});

		const decoder = new ControlLineDecoder();
		const framesReceived: Array<Record<string, unknown>> = [];

		const done = new Promise<void>((resolve) => {
			client.on("data", (chunk: Buffer) => {
				try {
					for (const message of decoder.push(chunk)) {
						framesReceived.push(message as Record<string, unknown>);
					}
				} catch {
					// ignore decode errors here
				}
			});
			// Resolve once the connection closes (server destroys socket) or after a grace period.
			client.on("close", () => resolve());
			setTimeout(resolve, 750);
		});

		await new Promise<void>((resolve) => client.on("connect", () => resolve()));

		const relayHello: HelloMessage = {
			type: "hello",
			role: "relay",
			protocolVersion: PROTOCOL_VERSION,
			relayId: "r-1",
			relayToken: "tok-1",
		};
		client.write(encodeControlLine(relayHello));

		await done;

		// Sanity: the injected admitRelay ran, so we truly exercised the relay path.
		expect(admitRelayCalled).toBe(true);

		// Correct behavior: the client must NOT receive a fatal frame that
		// misreports the admitRelay failure as "frame_too_large".
		const misleadingFatal = framesReceived.find((f) => f.type === "fatal" && f.error === "frame_too_large");
		expect(misleadingFatal, `received misleading fatal frame: ${JSON.stringify(framesReceived)}`).toBeUndefined();
	});
});
