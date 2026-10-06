/**
 * A control line over the limit ends the connection that reads it, so neither
 * side writes one: a client refuses an over-limit request before sending it,
 * and the daemon answers an over-limit response with `too_large`. Either way
 * the connection stays up (a worker's relayed phone frame, or its answer,
 * cannot end the worker's connection).
 */

import { afterEach, describe, expect, it } from "vitest";
import { ControlRequestTooLargeError, createDaemonClient } from "../src/daemon/control-client.ts";
import { CONTROL_MAX_LINE_BYTES, type ControlResponse } from "../src/daemon/control-protocol.ts";
import { startControlServer } from "../src/daemon/control-server.ts";
import { createTestSocketEndpoint } from "./socket-test-helpers.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("control line limit", () => {
	it("refuses an over-limit request locally and answers an over-limit response with too_large", async () => {
		const endpoint = createTestSocketEndpoint("volt-line-limit");
		cleanups.push(endpoint.cleanup);
		let oversized = true;
		const server = await startControlServer({
			socketPath: endpoint.socketPath,
			version: "0.0.0-test",
			handlers: {
				onRequest: (connection, request) => {
					if (request.type !== "status") return;
					if (!oversized) {
						connection.send({ type: "ok", id: request.id });
						return;
					}
					oversized = false;
					const padding = "x".repeat(CONTROL_MAX_LINE_BYTES);
					connection.send({ type: "ok", id: request.id, padding } as unknown as ControlResponse);
				},
			},
		});
		cleanups.push(() => server.close());
		const client = createDaemonClient({
			socketPath: endpoint.socketPath,
			client: "cli",
			version: "test",
			reconnect: false,
		});
		cleanups.push(() => client.close());
		await client.connect();

		await expect(
			client.request({ type: "workspace_register", name: "ws", path: "p".repeat(CONTROL_MAX_LINE_BYTES) }),
		).rejects.toBeInstanceOf(ControlRequestTooLargeError);
		expect(await client.request({ type: "status" })).toMatchObject({ type: "error", code: "too_large" });
		// The connection survived both.
		expect(await client.request({ type: "status" })).toMatchObject({ type: "ok" });
		expect(client.connectionState).toBe("connected");
	});
});
