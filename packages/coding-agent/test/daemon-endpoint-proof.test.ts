/**
 * Every hello proves its secret (the pidfile token, a spawn's worker token,
 * an offer's relay token) without sending it, and the daemon proves it back
 * on every answer. On Windows the daemon's socket is a named pipe whose name
 * another local account can list and, once the daemon is gone, take; an
 * endpoint that cannot prove the secret is never trusted: not as a daemon,
 * not as a relay, not for its refusals, and not as the owner of a stale
 * startup lock.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import { ControlLineDecoder, encodeControlLine, PROTOCOL_VERSION } from "../src/daemon/control-protocol.ts";
import { probeControlSocket, startControlServer } from "../src/daemon/control-server.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { ensureDaemonDirs, getDaemonPaths } from "../src/daemon/paths.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import { createTestSocketEndpoint, listenTestServer } from "./socket-test-helpers.ts";

const TOKEN = "pidfile-token-0123456789";

const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function socketPath(): string {
	const endpoint = createTestSocketEndpoint("volt-endpoint-proof");
	cleanups.push(endpoint.cleanup);
	return endpoint.socketPath;
}

/**
 * An endpoint that is not the daemon, as at a stale pipe name someone else
 * took: it answers every hello with `ack`, without knowing any secret, then
 * a relay preamble or a status. It records every byte it receives.
 */
async function startImpostor(path: string, ack: Record<string, unknown>): Promise<{ received: string[] }> {
	const received: string[] = [];
	const server = createServer((socket: Socket) => {
		const decoder = new ControlLineDecoder();
		socket.on("data", (chunk) => {
			received.push(chunk.toString("utf8"));
			for (const message of decoder.push(chunk)) {
				const request = message as Record<string, unknown>;
				if (request.type === "hello") {
					socket.write(
						encodeControlLine({
							type: "hello_ack",
							version: "0.0.0-test",
							protocolVersion: PROTOCOL_VERSION,
							...ack,
						}),
					);
					if (request.role === "relay") socket.write(encodeControlLine({ type: "relay_preamble", kind: "phone" }));
				} else if (request.type === "status") {
					socket.write(encodeControlLine({ type: "status_result", id: request.id, pid: 1 }));
				}
			}
		});
	});
	await listenTestServer(server, path);
	cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
	return { received };
}

describe("an endpoint that cannot prove the secret", () => {
	it.each([
		{ answer: "an admission with no proof", ack: { ok: true, connectionId: "c-1" } },
		{
			answer: "an admission with a forged proof",
			ack: { ok: true, connectionId: "c-1", daemonProof: "A".repeat(43) },
		},
	])("is no daemon when it answers with $answer, and never learns the token", async ({ ack }) => {
		const path = socketPath();
		const impostor = await startImpostor(path, ack);
		const client = createDaemonClient({
			socketPath: path,
			client: "tui",
			version: "test",
			authToken: TOKEN,
			reconnect: false,
		});
		cleanups.push(() => client.close());

		await expect(client.connect()).rejects.toThrow(/did not prove/);
		expect(await probeControlSocket(path, { version: "test", authToken: TOKEN })).toMatchObject({
			kind: "unresponsive",
		});
		expect(impostor.received.join("")).toContain("controlProof");
		expect(impostor.received.join("")).not.toContain(TOKEN);
	});

	it("is not believed when it refuses, so a client keeps looking for its daemon", async () => {
		const path = socketPath();
		await startImpostor(path, { ok: false, error: "protocol_mismatch", protocolVersion: PROTOCOL_VERSION + 1 });
		const client = createDaemonClient({
			socketPath: path,
			client: "tui",
			version: "test",
			authToken: TOKEN,
			reconnect: false,
		});
		cleanups.push(() => client.close());

		await expect(client.connect()).rejects.toThrow(/protocol_mismatch \(unproven\)/);
		// A proven mismatch would end the client for good; this one does not.
		expect(client.goneReason).toBe("dial_failed");
		expect(await probeControlSocket(path, { version: "test", authToken: TOKEN })).toMatchObject({
			kind: "unresponsive",
		});
	});

	it("is no relay, and never learns the offer's token", async () => {
		const path = socketPath();
		const impostor = await startImpostor(path, { ok: true });
		const client = createDaemonClient({ socketPath: path, client: "tui", version: "test", reconnect: false });
		cleanups.push(() => client.close());
		const relayToken = "relay-token-0123456789";

		await expect(client.openRelay({ relayId: "rl-1", relayToken })).rejects.toThrow(/did not prove/);
		expect(impostor.received.join("")).toContain("relayProof");
		expect(impostor.received.join("")).not.toContain(relayToken);
	});

	it("does not keep a stale startup lock held: a new daemon starts", async () => {
		const root = mkdtempSync(join(tmpdir(), "volt-endpoint-proof-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const agentDir = join(root, "agent");
		const paths = getDaemonPaths(agentDir);
		ensureDaemonDirs(paths);
		// A daemon that is gone: its process exited without removing its lock or pidfile.
		const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
		await new Promise((resolve) => gone.once("exit", resolve));
		const pid = gone.pid;
		if (pid === undefined) throw new Error("No pid");
		mkdirSync(paths.lockDirPath, { mode: 0o700 });
		writeFileSync(
			join(paths.lockDirPath, "owner.json"),
			`${JSON.stringify({ pid, startedAtMs: Date.now() - 1_000, token: "stale-lock" })}\n`,
		);
		// Its endpoint's name, now held by something that refuses as a newer daemon would.
		const stale = socketPath();
		await startImpostor(stale, { ok: false, error: "protocol_mismatch", protocolVersion: PROTOCOL_VERSION + 1 });
		writeFileSync(
			paths.pidfilePath,
			`${JSON.stringify({ pid, version: "test", startedAtMs: Date.now() - 1_000, socketPath: stale, token: TOKEN })}\n`,
		);

		const daemon = runVoltDaemon({ agentDir, foreground: false });
		let exited: number | undefined;
		void daemon.then((code) => {
			exited = code;
		});
		await vi.waitFor(
			async () => {
				expect(exited).toBeUndefined();
				expect((await probeDaemon(agentDir)).healthy).toBe(true);
			},
			{ timeout: 20_000 },
		);
		const probe = await probeDaemon(agentDir);
		const control = createDaemonClient({
			socketPath: probe.socketPath,
			client: "cli",
			version: "test",
			...(probe.authToken === undefined ? {} : { authToken: probe.authToken }),
			reconnect: false,
		});
		cleanups.push(() => control.close());
		await control.request({ type: "shutdown" });
		await expect(daemon).resolves.toBe(0);
	}, 30_000);
});

describe("the daemon", () => {
	it("proves its refusals, so they are believed", async () => {
		const path = socketPath();
		const server = await startControlServer({
			socketPath: path,
			version: "test",
			authToken: TOKEN,
			handlers: { onRequest: () => {}, isShuttingDown: () => true },
		});
		cleanups.push(() => server.close());

		expect(await probeControlSocket(path, { version: "test", authToken: TOKEN })).toMatchObject({
			kind: "live-rejected",
			reason: "shutting_down",
		});
		const client = createDaemonClient({
			socketPath: path,
			client: "tui",
			version: "test",
			authToken: TOKEN,
			reconnect: false,
		});
		cleanups.push(() => client.close());
		await expect(client.connect()).rejects.toThrow(/rejected hello: shutting_down$/);
	});

	it("admits a client that proves the token, and refuses one that cannot", async () => {
		const path = socketPath();
		const server = await startControlServer({
			socketPath: path,
			version: "test",
			authToken: TOKEN,
			handlers: {
				onRequest(connection, request) {
					connection.send({ type: "ok", id: request.id });
				},
			},
		});
		cleanups.push(() => server.close());

		const client = createDaemonClient({
			socketPath: path,
			client: "tui",
			version: "test",
			authToken: TOKEN,
			reconnect: false,
		});
		cleanups.push(() => client.close());
		await client.connect();
		expect(client.connectionState).toBe("connected");

		for (const authToken of [undefined, "another-daemons-token"]) {
			const refused = createDaemonClient({
				socketPath: path,
				client: "tui",
				version: "test",
				...(authToken === undefined ? {} : { authToken }),
				reconnect: false,
			});
			cleanups.push(() => refused.close());
			await expect(refused.connect()).rejects.toThrow(/auth_failed/);
		}
	});
});
