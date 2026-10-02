import { Buffer } from "node:buffer";
import { createSocket, type Socket } from "node:dgram";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EndpointTicket } from "@hansjm10/volt-iroh";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { IROH_REMOTE_ALPN } from "../../../src/core/remote/iroh/protocol.ts";
import { decodeIrohRemoteTicketPayload, type IrohRemoteTicketPayload } from "../../../src/core/remote/iroh/ticket.ts";
import type { IrohBiStreamLike } from "../../../src/core/rpc/iroh-transport.ts";
import { createDaemonClient, type DaemonClient } from "../../../src/daemon/control-client.ts";
import type { ControlEvent } from "../../../src/daemon/control-protocol.ts";
import { loadIrohModule } from "../../../src/daemon/iroh-native.ts";
import { createIrohDaemonService, type IrohDaemonServiceDependencies } from "../../../src/daemon/iroh-service.ts";
import { runVoltDaemon } from "../../../src/daemon/main.ts";
import { getDaemonPaths } from "../../../src/daemon/paths.ts";
import { probeDaemon, spawnDetachedDaemon, waitForDaemonExit } from "../../../src/daemon/spawn.ts";
import { createEmptyVoltdState } from "../../../src/daemon/state.ts";
import { readLineFromIroh } from "../../../src/daemon/workspace-streams.ts";

const native = loadIrohModule();
const runNative = native.iroh !== undefined || process.env.VOLT_TEST_REQUIRE_NATIVE_IROH === "1";
const ALPN = Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"));
const FALLBACK_WARNING = "could not reuse the saved Iroh direct port";

interface RunningDaemon {
	control: DaemonClient;
	events: ControlEvent[];
	stop(): Promise<void>;
}

interface PhoneConnection {
	remoteId(): { toString(): string };
	openBi(): Promise<IrohBiStreamLike>;
	close(code: bigint, reason: number[]): void;
}

interface PhoneEndpoint {
	connect(addr: unknown, alpn: number[]): Promise<PhoneConnection>;
	close(): Promise<void>;
}

/** Connect to the healthy daemon for `agentDir` and wait until its phone transport is ready. */
async function connectReadyDaemon(
	agentDir: string,
): Promise<{ control: DaemonClient; events: ControlEvent[]; socketPath: string }> {
	const events: ControlEvent[] = [];
	let status = await probeDaemon(agentDir);
	for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		status = await probeDaemon(agentDir);
	}
	expect(status.healthy).toBe(true);
	const control = createDaemonClient({
		socketPath: status.socketPath,
		client: "cli",
		version: "test",
		authToken: status.authToken,
		reconnect: false,
		onEvent: (event) => events.push(event),
	});
	await expect
		.poll(
			async () => {
				const response = await control.request({ type: "status" });
				return response.type === "status_result" ? response.remoteTransport.state : undefined;
			},
			{ timeout: 15_000 },
		)
		.toBe("ready");
	return { control, events, socketPath: status.socketPath };
}

async function startDaemon(agentDir: string, dependencies: IrohDaemonServiceDependencies = {}): Promise<RunningDaemon> {
	const daemon = runVoltDaemon({ agentDir, foreground: false, extensionDisposeTimeoutMs: 50 }, [
		createIrohDaemonService({ relayMode: "disabled" }, dependencies),
	]);
	const { control, events } = await connectReadyDaemon(agentDir);
	let stopped = false;
	return {
		control,
		events,
		async stop() {
			if (stopped) return;
			stopped = true;
			await control.request({ type: "shutdown" }).catch(() => {});
			await control.close();
			await daemon;
		},
	};
}

function killIfAlive(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already exited.
	}
}

/**
 * Start a real voltd process the way `volt daemon start` does. A restart has
 * to cross a process boundary: the native endpoint keeps its UDP socket until
 * its JS wrapper is finalized or the process exits, so a second in-process
 * daemon could never rebind the saved port.
 */
async function spawnDaemonProcess(agentDir: string, spawnedPids: number[]): Promise<RunningDaemon> {
	const spawned = await spawnDetachedDaemon(agentDir);
	if (!spawned.ok || spawned.pid === undefined) {
		if (spawned.pid !== undefined) spawnedPids.push(spawned.pid);
		throw new Error(`voltd did not start: ${spawned.ok ? "no pid reported" : spawned.error}`);
	}
	const pid = spawned.pid;
	spawnedPids.push(pid);
	const { control, events, socketPath } = await connectReadyDaemon(agentDir);
	let stopped = false;
	return {
		control,
		events,
		async stop() {
			if (stopped) return;
			stopped = true;
			await control.request({ type: "shutdown" }).catch(() => {});
			await control.close();
			expect(await waitForDaemonExit({ agentDir, pid, socketPath, timeoutMs: 30_000 })).toBe("exited");
		},
	};
}

async function requestPairingTicket(running: RunningDaemon, workspaceName: string): Promise<IrohRemoteTicketPayload> {
	const started = await running.control.request({ type: "pair_request", workspaceName });
	if (started.type !== "pair_started") throw new Error("pair request did not start");
	let ticket: string | undefined;
	await expect
		.poll(
			() => {
				const event = running.events.find(
					(candidate) =>
						candidate.type === "pairing_progress" &&
						candidate.requestId === started.requestId &&
						candidate.phase === "ticket",
				);
				ticket = event?.type === "pairing_progress" ? event.ticket : undefined;
				return ticket;
			},
			{ timeout: 15_000 },
		)
		.toBeTypeOf("string");
	return decodeIrohRemoteTicketPayload(ticket as string);
}

function endpointAddrOf(irohTicket: string): { directAddresses(): string[] } {
	const iroh = native.iroh;
	if (!iroh) throw new Error("native iroh unavailable");
	return (iroh.EndpointTicket as unknown as typeof EndpointTicket).fromString(irohTicket).endpointAddr();
}

/** Distinct ports of the ticket's IPv4 direct addresses. */
function ipv4Ports(irohTicket: string): number[] {
	const ports = endpointAddrOf(irohTicket)
		.directAddresses()
		.filter((address) => /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address))
		.map((address) => Number(address.slice(address.lastIndexOf(":") + 1)));
	return [...new Set(ports)];
}

function persistedBindPort(agentDir: string): unknown {
	const state = JSON.parse(readFileSync(getDaemonPaths(agentDir).statePath, "utf8")) as {
		settings: { irohBindPort?: unknown };
	};
	return state.settings.irohBindPort;
}

async function createPhoneEndpoint(): Promise<PhoneEndpoint> {
	const iroh = native.iroh;
	if (!iroh) throw new Error("native iroh unavailable");
	const builder = iroh.Endpoint.builder();
	iroh.presetMinimal(builder);
	builder.relayMode(iroh.RelayMode.disabled());
	return (await builder.bind()) as unknown as PhoneEndpoint;
}

/** Open a workspace-discovery stream and return the host's handshake response. */
async function discoveryHandshake(
	connection: PhoneConnection,
	secret: string | undefined,
): Promise<Record<string, unknown>> {
	const stream = await connection.openBi();
	const hello = {
		type: "volt_iroh_hello",
		protocol: IROH_REMOTE_ALPN,
		workspace: "ws",
		...(secret === undefined ? {} : { secret, clientLabel: "regression-phone" }),
		workspaceDiscovery: { purpose: "list_sessions" },
	};
	await stream.send.writeAll(Array.from(Buffer.from(`${JSON.stringify(hello)}\n`, "utf8")));
	const result = await readLineFromIroh(stream.recv, Buffer.alloc(0), { maxLineBytes: 1024 * 1024 });
	if (result.line === undefined) throw new Error("stream ended before the handshake response");
	return JSON.parse(result.line) as Record<string, unknown>;
}

describe.runIf(runNative)("#487 relay-disabled pairings survive a daemon process restart", () => {
	it("reconnects a paired phone with its original ticket after the daemon restarts", async () => {
		vi.stubEnv("VOLT_IROH_RELAY_MODE", "disabled");
		vi.stubEnv("VOLT_DAEMON_INHERIT_ENV", "1");
		vi.stubEnv("VOLT_IROH_RELAY_URLS", undefined);
		vi.stubEnv("VOLT_IROH_RELAY_AUTH_TOKEN", undefined);
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-487-restart-"));
		const workspaceDir = join(agentDir, "ws");
		mkdirSync(workspaceDir, { recursive: true });
		const spawnedPids: number[] = [];
		let running: RunningDaemon | undefined;
		let phone: PhoneEndpoint | undefined;
		try {
			running = await spawnDaemonProcess(agentDir, spawnedPids);
			expect(
				(await running.control.request({ type: "workspace_register", name: "ws", path: workspaceDir })).type,
			).toBe("ok");
			const payload = await requestPairingTicket(running, "ws");
			const ticketPorts = ipv4Ports(payload.irohTicket);
			expect(ticketPorts).toHaveLength(1);

			phone = await createPhoneEndpoint();
			const pairing = await phone.connect(endpointAddrOf(payload.irohTicket), ALPN);
			expect(pairing.remoteId().toString()).toBe(payload.nodeId);
			expect(await discoveryHandshake(pairing, payload.secret)).toMatchObject({ success: true, workspace: "ws" });
			const pairingEvents = running.events;
			await expect
				.poll(
					() => pairingEvents.some((event) => event.type === "pairing_progress" && event.phase === "completed"),
					{ timeout: 10_000 },
				)
				.toBe(true);
			pairing.close(0n, Array.from(Buffer.from("done", "utf8")));
			await running.stop();

			running = await spawnDaemonProcess(agentDir, spawnedPids);
			const reconnection = await phone.connect(endpointAddrOf(payload.irohTicket), ALPN);
			expect(reconnection.remoteId().toString()).toBe(payload.nodeId);
			expect(await discoveryHandshake(reconnection, undefined)).toMatchObject({ success: true, workspace: "ws" });
			reconnection.close(0n, Array.from(Buffer.from("done", "utf8")));
			expect(persistedBindPort(agentDir)).toBe(ticketPorts[0]);
			expect(readFileSync(getDaemonPaths(agentDir).logPath, "utf8")).not.toContain(FALLBACK_WARNING);
		} finally {
			await running?.stop().catch(() => {});
			for (const pid of spawnedPids) killIfAlive(pid);
			await phone?.close().catch(() => {});
			rmSync(agentDir, { recursive: true, force: true });
			vi.unstubAllEnvs();
		}
	}, 90_000);
});

describe.runIf(runNative)("#487 saved direct port fallback", () => {
	beforeAll(() => {
		vi.stubEnv("VOLT_IROH_RELAY_MODE", undefined);
		vi.stubEnv("VOLT_IROH_RELAY_URLS", undefined);
		vi.stubEnv("VOLT_IROH_RELAY_AUTH_TOKEN", undefined);
	});

	afterAll(() => {
		vi.unstubAllEnvs();
	});

	it("falls back to a fresh port and persists it when the saved port is taken", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "voltd-487-fallback-"));
		const workspaceDir = join(agentDir, "ws");
		mkdirSync(workspaceDir, { recursive: true });
		const blocker: Socket = createSocket("udp4");
		let running: RunningDaemon | undefined;
		try {
			await new Promise<void>((resolve, reject) => {
				blocker.once("error", reject);
				blocker.bind(0, "0.0.0.0", () => resolve());
			});
			const takenPort = blocker.address().port;
			const paths = getDaemonPaths(agentDir);
			mkdirSync(paths.daemonDir, { recursive: true });
			const state = createEmptyVoltdState();
			state.settings.irohBindPort = takenPort;
			writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`);

			running = await startDaemon(agentDir, { directPortBindAttempts: 2, directPortRetryDelayMs: 10 });
			expect(
				(await running.control.request({ type: "workspace_register", name: "ws", path: workspaceDir })).type,
			).toBe("ok");
			const payload = await requestPairingTicket(running, "ws");
			const ticketPorts = ipv4Ports(payload.irohTicket);
			expect(ticketPorts).toHaveLength(1);
			expect(ticketPorts[0]).not.toBe(takenPort);
			expect(persistedBindPort(agentDir)).toBe(ticketPorts[0]);
			expect(readFileSync(paths.logPath, "utf8")).toContain(FALLBACK_WARNING);
		} finally {
			await running?.stop();
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
			rmSync(agentDir, { recursive: true, force: true });
		}
	}, 60_000);
});
