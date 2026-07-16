import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IROH_REMOTE_ALPN } from "../src/core/remote/iroh/protocol.ts";
import { decodeIrohRemoteTicketPayload } from "../src/core/remote/iroh/ticket.ts";
import type { IrohBiStreamLike } from "../src/core/rpc/iroh-transport.ts";
import { createDaemonClient, type DaemonClient } from "../src/daemon/control-client.ts";
import type { ControlEvent } from "../src/daemon/control-protocol.ts";
import { loadIrohModule } from "../src/daemon/iroh-native.ts";
import {
	createIrohDaemonService,
	resolveIrohRelayConfig,
	VOLT_PRODUCTION_RELAY_URLS,
} from "../src/daemon/iroh-service.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { type DaemonProbeResult, probeDaemon } from "../src/daemon/spawn.ts";
import { readLineFromIroh } from "../src/daemon/workspace-streams.ts";

const native = loadIrohModule();
const nativeAvailable = native.iroh !== undefined;

interface PhoneEndpoint {
	connect(addr: unknown, alpn: number[]): Promise<PhoneConnection>;
	close(): Promise<void>;
}

interface PhoneBiStream extends IrohBiStreamLike {
	send: IrohBiStreamLike["send"] & {
		finish(): Promise<void>;
		stopped(): Promise<number | null>;
	};
}

interface PhoneConnection {
	remoteId(): { toString(): string };
	openBi(): Promise<PhoneBiStream>;
	closed(): Promise<string>;
	close(code: bigint, reason: number[]): void;
}

const ALPN = Array.from(Buffer.from(IROH_REMOTE_ALPN, "utf8"));

async function createPhoneEndpoint(): Promise<PhoneEndpoint> {
	const iroh = native.iroh;
	if (!iroh) {
		throw new Error("native iroh unavailable");
	}
	const builder = iroh.Endpoint.builder();
	iroh.presetMinimal(builder);
	builder.relayMode(iroh.RelayMode.disabled());
	const endpoint = (await builder.bind()) as unknown as PhoneEndpoint;
	return endpoint;
}

async function writeJsonLine(stream: IrohBiStreamLike, value: object): Promise<void> {
	await stream.send.writeAll(Array.from(Buffer.from(`${JSON.stringify(value)}\n`, "utf8")));
}

async function readJsonLine(
	stream: IrohBiStreamLike,
	rest: Buffer = Buffer.alloc(0),
): Promise<{ value: Record<string, unknown>; rest: Buffer }> {
	const result = await readLineFromIroh(stream.recv, rest, { maxLineBytes: 1024 * 1024 });
	if (result.line === undefined) {
		throw new Error("stream ended before a line was received");
	}
	return { value: JSON.parse(result.line) as Record<string, unknown>, rest: result.rest };
}

describe("relay config resolution", () => {
	it("defaults to the Volt production relays", () => {
		expect(resolveIrohRelayConfig({}, {})).toEqual({
			relayMode: "production",
			relayUrls: VOLT_PRODUCTION_RELAY_URLS,
		});
	});

	it("uses VOLT_IROH_RELAY_URLS for a self-managed relay fleet", () => {
		expect(
			resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_URLS: " https://r1.example.com , https://r2.example.com ," }),
		).toEqual({
			relayMode: "production",
			relayUrls: ["https://r1.example.com", "https://r2.example.com"],
		});
	});

	it("opts into the n0 public relays only via VOLT_IROH_RELAY_MODE=development", () => {
		expect(resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_MODE: "development" })).toEqual({
			relayMode: "development",
			relayUrls: [],
		});
		expect(resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_MODE: "disabled" })).toEqual({
			relayMode: "disabled",
			relayUrls: [],
		});
	});

	it("prefers explicit service config over the environment", () => {
		expect(
			resolveIrohRelayConfig(
				{ relayMode: "disabled" },
				{ VOLT_IROH_RELAY_MODE: "development", VOLT_IROH_RELAY_URLS: "https://ignored.example.com" },
			),
		).toEqual({ relayMode: "disabled", relayUrls: ["https://ignored.example.com"] });
		expect(
			resolveIrohRelayConfig(
				{ relayUrls: ["https://config.example.com"] },
				{ VOLT_IROH_RELAY_URLS: "https://env.example.com" },
			),
		).toEqual({ relayMode: "production", relayUrls: ["https://config.example.com"] });
	});

	it("warns on an invalid VOLT_IROH_RELAY_MODE and falls back to the default", () => {
		const resolved = resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_MODE: "n0" });
		expect(resolved.relayMode).toBe("production");
		expect(resolved.relayUrls).toEqual(VOLT_PRODUCTION_RELAY_URLS);
		expect(resolved.warning).toContain("VOLT_IROH_RELAY_MODE");
	});
});

describe.skipIf(!nativeAvailable)("voltd iroh service (loopback)", () => {
	let agentDir: string;
	let workspaceDir: string;
	let daemon: Promise<number>;
	let control: DaemonClient;
	const controlEvents: ControlEvent[] = [];

	beforeAll(async () => {
		agentDir = mkdtempSync(join(tmpdir(), "voltd-iroh-"));
		workspaceDir = join(agentDir, "ws");
		mkdirSync(workspaceDir, { recursive: true });
		daemon = runVoltDaemon({ agentDir, foreground: false }, [createIrohDaemonService({ relayMode: "disabled" })]);
		let status: DaemonProbeResult = await probeDaemon(agentDir);
		for (let attempt = 0; !status.healthy && attempt < 100; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeDaemon(agentDir);
		}
		expect(status.healthy).toBe(true);
		control = createDaemonClient({
			socketPath: status.socketPath,
			client: "cli",
			version: "test",
			authToken: status.authToken,
			reconnect: false,
			onEvent: (event) => controlEvents.push(event),
		});
		const registered = await control.request({ type: "workspace_register", name: "ws", path: workspaceDir });
		expect(registered.type).toBe("ok");
	}, 30_000);

	afterAll(async () => {
		try {
			await control.request({ type: "shutdown" });
		} catch {
			// daemon may already be gone
		}
		await control?.close();
		await daemon;
		rmSync(agentDir, { recursive: true, force: true });
	}, 30_000);

	it("pairs a phone, serves workspace discovery, and revokes", async () => {
		// Pair over the control plane.
		const pairResponse = await control.request({ type: "pair_request", workspaceName: "ws" });
		expect(pairResponse.type).toBe("pair_started");
		let ticketEvent: (ControlEvent & { type: "pairing_progress" }) | undefined;
		await expect
			.poll(
				() => {
					ticketEvent = controlEvents.find(
						(event): event is ControlEvent & { type: "pairing_progress" } =>
							event.type === "pairing_progress" && event.phase === "ticket",
					);
					return ticketEvent !== undefined;
				},
				{ timeout: 15_000 },
			)
			.toBe(true);
		const ticket = ticketEvent?.ticket;
		expect(ticket).toBeDefined();
		const payload = decodeIrohRemoteTicketPayload(ticket as string);
		expect(payload.workspace).toBe("ws");
		expect(payload.secret).toBeDefined();

		// Phone connects with the pairing secret and opens a workspaceDiscovery stream.
		const iroh = native.iroh;
		if (!iroh) {
			throw new Error("native iroh unavailable");
		}
		const phone = await createPhoneEndpoint();
		const endpointTicket = (
			iroh.EndpointTicket as unknown as { fromString(value: string): { endpointAddr(): unknown } }
		).fromString(payload.irohTicket);
		const connection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
		expect(connection.remoteId().toString()).toBe(payload.nodeId);
		const stream = await connection.openBi();
		await writeJsonLine(stream, {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "ws",
			secret: payload.secret,
			clientLabel: "vitest-phone",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		const handshake = await readJsonLine(stream);
		expect(handshake.value.type).toBe("volt_iroh_handshake");
		expect(handshake.value.success).toBe(true);
		expect(handshake.value.workspace).toBe("ws");

		// Pairing completion is pushed to the control client.
		await expect
			.poll(() => controlEvents.some((event) => event.type === "pairing_progress" && event.phase === "completed"), {
				timeout: 10_000,
			})
			.toBe(true);

		// list_sessions works over the discovery stream.
		await writeJsonLine(stream, { id: "ls-1", type: "list_sessions" });
		const listResponse = await readJsonLine(stream, handshake.rest);
		expect(listResponse.value.command).toBe("list_sessions");
		expect(listResponse.value.success).toBe(true);
		expect((listResponse.value.data as Record<string, unknown>).sessions).toEqual([]);
		connection.close(0n, Array.from(Buffer.from("done", "utf8")));
		await connection.closed();

		// The client is paired and reconnects WITHOUT the secret.
		const clients = await control.request({ type: "clients_list" });
		expect(clients.type).toBe("clients_result");
		if (clients.type === "clients_result") {
			expect(clients.clients).toHaveLength(1);
		}
		const pairedClientNodeId = clients.type === "clients_result" ? (clients.clients[0]?.clientNodeId as string) : "";

		// relay_rpc is bound to a live relay and its owning TUI control connection;
		// a regular control client cannot forge that authority.
		const missingRelay = await control.request({
			type: "relay_rpc",
			relayId: "rl-missing",
			clientNodeId: pairedClientNodeId,
			workspaceName: "ws",
			sessionId: "s-relay",
			command: { type: "register_push_target", id: "rp-1", args: {} },
		});
		expect(missingRelay).toMatchObject({ type: "error", code: "not_found", message: "active relay not found" });

		const reconnection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
		const reconnectStream = await reconnection.openBi();
		await writeJsonLine(reconnectStream, {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "ws",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		const reconnectHandshake = await readJsonLine(reconnectStream);
		expect(reconnectHandshake.value.success).toBe(true);
		await writeJsonLine(reconnectStream, { id: "ls-reconnect-1", type: "list_sessions" });
		const reconnectListResponse = await readJsonLine(reconnectStream, reconnectHandshake.rest);
		expect(reconnectListResponse.value.command).toBe("list_sessions");
		expect(reconnectListResponse.value.success).toBe(true);

		// Completing one stream must leave the multi-stream connection reusable.
		await reconnectStream.send.finish();
		expect(await reconnectStream.send.stopped()).toBeNull();
		await reconnectStream.recv.stop?.(0n);
		const reusedStream = await reconnection.openBi();
		await writeJsonLine(reusedStream, {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "ws",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		const reusedHandshake = await readJsonLine(reusedStream);
		expect(reusedHandshake.value.success).toBe(true);
		await writeJsonLine(reusedStream, { id: "ls-reconnect-2", type: "list_sessions" });
		const reusedListResponse = await readJsonLine(reusedStream, reusedHandshake.rest);
		expect(reusedListResponse.value.command).toBe("list_sessions");
		expect(reusedListResponse.value.success).toBe(true);
		reconnection.close(0n, Array.from(Buffer.from("done", "utf8")));
		await reconnection.closed();

		// Revocation closes the door: the next handshake is rejected.
		const clientNodeId = clients.type === "clients_result" ? clients.clients[0]?.clientNodeId : undefined;
		expect(clientNodeId).toBeDefined();
		const revoked = await control.request({ type: "client_revoke", clientNodeId: clientNodeId as string });
		expect(revoked.type).toBe("ok");
		const revokedConnection = await phone.connect(endpointTicket.endpointAddr(), ALPN);
		const revokedStream = await revokedConnection.openBi();
		await writeJsonLine(revokedStream, {
			type: "volt_iroh_hello",
			protocol: IROH_REMOTE_ALPN,
			workspace: "ws",
			workspaceDiscovery: { purpose: "list_sessions" },
		});
		const revokedHandshake = await readJsonLine(revokedStream);
		expect(revokedHandshake.value.success).toBe(false);
		expect(revokedHandshake.value.outcome).toBe("client_revoked");
		revokedConnection.close(0n, Array.from(Buffer.from("done", "utf8")));
		await revokedConnection.closed();
		await phone.close();
	}, 60_000);
});
