/**
 * Every hello proves its secret (the pidfile token, a spawn's worker token,
 * an offer's relay token) without sending it, bound to the daemon's challenge
 * on that connection and the socket path the client dialed, and the daemon
 * proves it back on every answer. On Windows the daemon's socket is a named
 * pipe whose name another local account can list and, once the daemon is
 * gone, take. An endpoint that cannot prove the secret is never trusted: not
 * as a daemon, not as a relay, not for its refusals, and not as the owner of
 * a stale startup lock. And a hello it captures is good nowhere else: not
 * replayed on another connection, nor relayed live to the daemon.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonClient } from "../src/daemon/control-client.ts";
import {
	ControlLineDecoder,
	createHelloProof,
	daemonProofMatches,
	encodeControlLine,
	type HelloBinding,
	type HelloMessage,
	PROTOCOL_VERSION,
} from "../src/daemon/control-protocol.ts";
import { type ControlServer, probeControlSocket, startControlServer } from "../src/daemon/control-server.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { ensureDaemonDirs, getDaemonPaths } from "../src/daemon/paths.ts";
import { probeDaemon } from "../src/daemon/spawn.ts";
import { createTestSocketEndpoint, greetControlClient, listenTestServer } from "./socket-test-helpers.ts";

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
 * took: it greets like the daemon, answers every hello with `ack` without
 * knowing any secret, then a relay preamble or a status. It records every
 * byte it receives, and the hellos.
 */
async function startImpostor(
	path: string,
	ack: Record<string, unknown>,
): Promise<{ received: string[]; hellos: HelloMessage[] }> {
	const received: string[] = [];
	const hellos: HelloMessage[] = [];
	const server = createServer((socket: Socket) => {
		const decoder = new ControlLineDecoder();
		// Its clients hang up on it mid-answer (EPIPE on Windows pipes).
		socket.on("error", () => {});
		greetControlClient(socket);
		socket.on("data", (chunk) => {
			received.push(chunk.toString("utf8"));
			for (const message of decoder.push(chunk)) {
				const request = message as Record<string, unknown>;
				if (request.type === "hello") {
					hellos.push(message as HelloMessage);
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
	return { received, hellos };
}

/** A daemon's control server on `path` with the pidfile token, answering every request with ok. */
async function startDaemonServer(path: string): Promise<ControlServer> {
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
	return server;
}

/** A raw connection to `path`: the daemon's challenge, then whatever lines the test sends and reads. */
async function connectRaw(path: string): Promise<{
	readonly challenge: string;
	send(message: object): void;
	next(): Promise<Record<string, unknown>>;
}> {
	const socket = createConnection(path);
	socket.on("error", () => {});
	cleanups.push(() => socket.destroy());
	const decoder = new ControlLineDecoder();
	const lines: Record<string, unknown>[] = [];
	const waiting: Array<(line: Record<string, unknown>) => void> = [];
	socket.on("data", (chunk: Buffer) => {
		for (const message of decoder.push(chunk)) {
			const line = message as Record<string, unknown>;
			const waiter = waiting.shift();
			if (waiter) waiter(line);
			else lines.push(line);
		}
	});
	const next = (): Promise<Record<string, unknown>> => {
		const line = lines.shift();
		return line === undefined ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(line);
	};
	const greeting = await next();
	expect(greeting.type).toBe("hello_challenge");
	return { challenge: String(greeting.nonce), send: (message) => socket.write(encodeControlLine(message)), next };
}

function controlHello(proof: ReturnType<typeof createHelloProof>): HelloMessage {
	return {
		type: "hello",
		role: "control",
		protocolVersion: PROTOCOL_VERSION,
		pid: 1,
		version: "test",
		client: "tui",
		controlProof: proof,
	};
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

	it("is no relay when it never greets: the open fails instead of waiting", async () => {
		const path = socketPath();
		const silent = createServer((socket: Socket) => {
			socket.on("error", () => {});
		});
		await listenTestServer(silent, path);
		cleanups.push(() => new Promise<void>((resolve) => silent.close(() => resolve())));
		const client = createDaemonClient({
			socketPath: path,
			client: "tui",
			version: "test",
			reconnect: false,
			helloTimeoutMs: 200,
		});
		cleanups.push(() => client.close());

		await expect(client.openRelay({ relayId: "rl-1", relayToken: "relay-token-0123456789" })).rejects.toThrow(
			/timed out/,
		);
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

describe("a hello's proof", () => {
	it("is good for its own connection to the daemon, and the daemon proves itself on it", async () => {
		const path = socketPath();
		await startDaemonServer(path);
		const raw = await connectRaw(path);
		const binding: HelloBinding = { challenge: raw.challenge, socketPath: path };
		const proof = createHelloProof("control", TOKEN, binding);
		raw.send(controlHello(proof));
		const ack = await raw.next();
		expect(ack).toMatchObject({ type: "hello_ack", ok: true });
		expect(daemonProofMatches("control", TOKEN, binding, proof, ack.daemonProof as string)).toBe(true);
	});

	it("is refused when it was made for another challenge, or for another socket", async () => {
		const path = socketPath();
		await startDaemonServer(path);
		for (const bindingOf of [
			(challenge: string): HelloBinding => ({ challenge: `${challenge.slice(1)}A`, socketPath: path }),
			(challenge: string): HelloBinding => ({ challenge, socketPath: `${path}-squatted` }),
		]) {
			const raw = await connectRaw(path);
			raw.send(controlHello(createHelloProof("control", TOKEN, bindingOf(raw.challenge))));
			const ack = await raw.next();
			expect(ack).toMatchObject({ type: "hello_ack", ok: false, error: "auth_failed" });
			expect(ack.daemonProof).toBeUndefined();
		}
	});

	it("captured on one connection is refused when replayed on another", async () => {
		const path = socketPath();
		await startDaemonServer(path);
		const first = await connectRaw(path);
		const captured = controlHello(
			createHelloProof("control", TOKEN, { challenge: first.challenge, socketPath: path }),
		);
		first.send(captured);
		expect(await first.next()).toMatchObject({ type: "hello_ack", ok: true });

		const replay = await connectRaw(path);
		replay.send(captured);
		expect(await replay.next()).toMatchObject({ type: "hello_ack", ok: false, error: "auth_failed" });
	});

	it("captured by a squatter is refused when replayed to the daemon", async () => {
		const daemonPath = socketPath();
		await startDaemonServer(daemonPath);
		const stale = socketPath();
		const impostor = await startImpostor(stale, { ok: true, connectionId: "c-1" });
		const client = createDaemonClient({
			socketPath: stale,
			client: "tui",
			version: "test",
			authToken: TOKEN,
			reconnect: false,
		});
		cleanups.push(() => client.close());
		await expect(client.connect()).rejects.toThrow(/did not prove/);
		const [captured] = impostor.hellos;
		if (captured === undefined) throw new Error("The squatter captured no hello");

		const replay = await connectRaw(daemonPath);
		replay.send(captured);
		expect(await replay.next()).toMatchObject({ type: "hello_ack", ok: false, error: "auth_failed" });
	});

	it("relayed live from a squatted name to the daemon is refused", async () => {
		const daemonPath = socketPath();
		await startDaemonServer(daemonPath);
		const stale = socketPath();
		// The squatter greets the client with the daemon's own challenge and forwards the client's hello.
		const forwarded = Promise.withResolvers<Record<string, unknown>>();
		const squatter = createServer((socket: Socket) => {
			socket.on("error", () => {});
			void (async () => {
				const upstream = await connectRaw(daemonPath);
				greetControlClient(socket, upstream.challenge);
				const decoder = new ControlLineDecoder();
				socket.on("data", (chunk: Buffer) => {
					for (const message of decoder.push(chunk)) {
						if ((message as Record<string, unknown>).type !== "hello") continue;
						upstream.send(message as object);
						void upstream.next().then(forwarded.resolve);
					}
				});
			})();
		});
		await listenTestServer(squatter, stale);
		cleanups.push(() => new Promise<void>((resolve) => squatter.close(() => resolve())));
		const client = createDaemonClient({
			socketPath: stale,
			client: "tui",
			version: "test",
			authToken: TOKEN,
			reconnect: false,
		});
		cleanups.push(() => client.close());
		void client.connect().catch(() => undefined);

		expect(await forwarded.promise).toMatchObject({ type: "hello_ack", ok: false, error: "auth_failed" });
	});
});
