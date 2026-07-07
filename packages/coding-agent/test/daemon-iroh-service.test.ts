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
import { probeControlSocket } from "../src/daemon/control-server.ts";
import { loadIrohModule } from "../src/daemon/iroh-native.ts";
import {
	createIrohDaemonService,
	resolveIrohRelayConfig,
	VOLT_PRODUCTION_RELAY_URLS,
} from "../src/daemon/iroh-service.ts";
import { runVoltDaemon } from "../src/daemon/main.ts";
import { getDaemonPaths } from "../src/daemon/paths.ts";
import { readLineFromIroh } from "../src/daemon/workspace-streams.ts";

const native = loadIrohModule();
const nativeAvailable = native.iroh !== undefined;

interface PhoneEndpoint {
	connect(addr: unknown, alpn: number[]): Promise<PhoneConnection>;
	close(): Promise<void>;
}

interface PhoneConnection {
	remoteId(): { toString(): string };
	openBi(): Promise<IrohBiStreamLike>;
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
			relayMode: "custom",
			relayUrls: VOLT_PRODUCTION_RELAY_URLS,
		});
	});

	it("uses VOLT_IROH_RELAY_URLS for a custom relay fleet", () => {
		expect(
			resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_URLS: " https://r1.example.com , https://r2.example.com ," }),
		).toEqual({
			relayMode: "custom",
			relayUrls: ["https://r1.example.com", "https://r2.example.com"],
		});
	});

	it("opts into the n0 public relays only via VOLT_IROH_RELAY_MODE=default", () => {
		expect(resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_MODE: "default" })).toEqual({
			relayMode: "default",
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
				{ VOLT_IROH_RELAY_MODE: "default", VOLT_IROH_RELAY_URLS: "https://ignored.example.com" },
			),
		).toEqual({ relayMode: "disabled", relayUrls: ["https://ignored.example.com"] });
		expect(
			resolveIrohRelayConfig(
				{ relayUrls: ["https://config.example.com"] },
				{ VOLT_IROH_RELAY_URLS: "https://env.example.com" },
			),
		).toEqual({ relayMode: "custom", relayUrls: ["https://config.example.com"] });
	});

	it("warns on an invalid VOLT_IROH_RELAY_MODE and falls back to the default", () => {
		const resolved = resolveIrohRelayConfig({}, { VOLT_IROH_RELAY_MODE: "n0" });
		expect(resolved.relayMode).toBe("custom");
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
		const paths = getDaemonPaths(agentDir);
		let status = await probeControlSocket(paths.socketPath, { version: "test" });
		for (let attempt = 0; status.kind !== "healthy" && attempt < 100; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			status = await probeControlSocket(paths.socketPath, { version: "test" });
		}
		expect(status.kind).toBe("healthy");
		control = createDaemonClient({
			socketPath: paths.socketPath,
			client: "cli",
			version: "test",
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

		// The client is paired and reconnects WITHOUT the secret.
		const clients = await control.request({ type: "clients_list" });
		expect(clients.type).toBe("clients_result");
		if (clients.type === "clients_result") {
			expect(clients.clients).toHaveLength(1);
		}
		const pairedClientNodeId = clients.type === "clients_result" ? (clients.clients[0]?.clientNodeId as string) : "";

		// relay_rpc: state-touching RPC commands forwarded from a TUI relay run
		// against the daemon's real state and return the verbatim RPC response.
		const liveActivityTokenHash = "a".repeat(64);
		const pushRegister = await control.request({
			type: "relay_rpc",
			clientNodeId: pairedClientNodeId,
			workspaceName: "ws",
			sessionId: "s-relay",
			command: {
				type: "register_push_target",
				id: "rp-1",
				args: {
					provider: "fcm",
					platform: "ios",
					pushTargetId: "pt-1",
					pushTargetAuthToken: "auth-token",
					enabled: true,
					liveActivity: {
						activityId: "act-1",
						pushToken: "live-token",
						tokenHash: liveActivityTokenHash,
						tokenEnvironment: "production",
					},
				},
			},
		});
		expect(pushRegister.type).toBe("relay_rpc_result");
		if (pushRegister.type === "relay_rpc_result") {
			expect(pushRegister.response).toMatchObject({
				id: "rp-1",
				command: "register_push_target",
				success: true,
				data: { status: "registered", pushTargetId: "pt-1" },
			});
		}

		// Live activity registration finds the delivery channel registered above.
		const liveActivityRegister = await control.request({
			type: "relay_rpc",
			clientNodeId: pairedClientNodeId,
			workspaceName: "ws",
			sessionId: "s-relay",
			command: {
				type: "register_live_activity",
				id: "la-1",
				workspaceName: "ws",
				sessionId: "s-relay",
				activityId: "act-1",
				tokenHash: liveActivityTokenHash,
				tokenEnvironment: "production",
				platform: "ios",
			},
		});
		expect(liveActivityRegister.type).toBe("relay_rpc_result");
		if (liveActivityRegister.type === "relay_rpc_result") {
			expect(liveActivityRegister.response).toMatchObject({
				id: "la-1",
				command: "register_live_activity",
				success: true,
				data: { status: "registered", activityId: "act-1" },
			});
		}

		// A session mismatch surfaces the real error instead of a blind success.
		const mismatchedRegister = await control.request({
			type: "relay_rpc",
			clientNodeId: pairedClientNodeId,
			workspaceName: "ws",
			sessionId: "s-relay",
			command: {
				type: "register_live_activity",
				id: "la-2",
				workspaceName: "ws",
				sessionId: "s-other",
				activityId: "act-1",
				tokenHash: liveActivityTokenHash,
				tokenEnvironment: "production",
				platform: "ios",
			},
		});
		expect(mismatchedRegister.type).toBe("relay_rpc_result");
		if (mismatchedRegister.type === "relay_rpc_result") {
			expect(mismatchedRegister.response).toMatchObject({ success: false, error: "session_mismatch" });
		}

		// Unknown clients are rejected before touching state.
		const unknownClient = await control.request({
			type: "relay_rpc",
			clientNodeId: "not-a-client",
			workspaceName: "ws",
			sessionId: "s-relay",
			command: { type: "unregister_live_activity", id: "la-3", workspaceName: "ws", sessionId: "s-relay" },
		});
		expect(unknownClient.type).toBe("error");

		// unregister_workspace over relay_rpc is scoped to the bound workspace and only
		// honors the documented `workspaceName` field.
		const scratchWorkspaceDir = join(agentDir, "ws2");
		mkdirSync(scratchWorkspaceDir, { recursive: true });
		const scratchRegistered = await control.request({
			type: "workspace_register",
			name: "ws2",
			path: scratchWorkspaceDir,
		});
		expect(scratchRegistered.type).toBe("ok");

		// A relay bound to "ws" cannot unregister the unrelated workspace "ws2".
		const crossWorkspaceUnregister = await control.request({
			type: "relay_rpc",
			clientNodeId: pairedClientNodeId,
			workspaceName: "ws",
			sessionId: "s-relay",
			command: { type: "unregister_workspace", id: "uw-x", workspaceName: "ws2" },
		});
		expect(crossWorkspaceUnregister.type).toBe("relay_rpc_result");
		if (crossWorkspaceUnregister.type === "relay_rpc_result") {
			expect(crossWorkspaceUnregister.response).toMatchObject({ success: false, error: "session_mismatch" });
		}

		// The legacy/undocumented `name` field is not honored.
		const legacyFieldUnregister = await control.request({
			type: "relay_rpc",
			clientNodeId: pairedClientNodeId,
			workspaceName: "ws2",
			sessionId: "s-relay",
			command: { type: "unregister_workspace", id: "uw-y", name: "ws2" },
		});
		expect(legacyFieldUnregister.type).toBe("relay_rpc_result");
		if (legacyFieldUnregister.type === "relay_rpc_result") {
			expect(legacyFieldUnregister.response).toMatchObject({ success: false, error: "session_mismatch" });
		}

		// A relay bound to "ws2" may unregister "ws2" and reports refreshed metadata.
		const workspaceUnregister = await control.request({
			type: "relay_rpc",
			clientNodeId: pairedClientNodeId,
			workspaceName: "ws2",
			sessionId: "s-relay",
			command: { type: "unregister_workspace", id: "uw-1", workspaceName: "ws2" },
		});
		expect(workspaceUnregister.type).toBe("relay_rpc_result");
		if (workspaceUnregister.type === "relay_rpc_result") {
			expect(workspaceUnregister.response).toMatchObject({
				id: "uw-1",
				command: "unregister_workspace",
				success: true,
				data: { removedWorkspace: "ws2" },
			});
			expect(workspaceUnregister.workspaceMetadata?.workspaceNames).toContain("ws");
			expect(workspaceUnregister.workspaceMetadata?.workspaceNames).not.toContain("ws2");
		}

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
		reconnection.close(0n, Array.from(Buffer.from("done", "utf8")));

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
		await phone.close();
	}, 60_000);
});
