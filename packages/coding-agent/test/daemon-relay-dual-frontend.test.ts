/**
 * §12.3.3 dual-frontend integration: a TUI-owned conversation served over the
 * daemon's byte relay. Real control server on a tmpdir socket with a lease
 * broker, the TUI host's real daemon link (lease, relay redemption, relayed
 * intents), its relay serving on the remote profile, and a real conversation
 * host over the faux provider. Only the phone's Iroh stream is in memory.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { LiveItem } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type IrohBiStreamLike, readIrohJsonlLine } from "../src/core/protocol/transport/iroh-transport.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { createIrohRemoteHandshakeSuccess, type IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import { IROH_REMOTE_ALPN } from "../src/core/remote/iroh/protocol.ts";
import type { ControlRequest, RelayPreamble } from "../src/daemon/control-protocol.ts";
import { type ControlConnection, type ControlServer, startControlServer } from "../src/daemon/control-server.ts";
import { LeaseBroker } from "../src/daemon/lease-broker.ts";
import { ensureDaemonDirs, getDaemonPaths } from "../src/daemon/paths.ts";
import { type RelayOutcome, RelayRegistry } from "../src/daemon/relay-stream.ts";
import { createDaemonLink } from "../src/modes/interactive/host/daemon-link.ts";
import { createTuiHarness, type TuiHarness } from "./suite/tui-harness.ts";
import { createIrohStreamPair } from "./utilities/iroh-stream-pair.ts";
import { connectRemotePhone, type RemotePhone } from "./utilities/remote-phone.ts";

const SESSION_ID = "s-relay";
const WORKSPACE = { name: "ws", path: "/tmp/ws" };
const RPC_GRANT = createIrohRemotePresetAccess("full").rpcGrant;
const RELAY_WORKSPACE_NAMES = [WORKSPACE.name, "beta"];
const RELAY_WORKSPACES: RelayPreamble["authorization"]["workspaces"] = [
	{ name: WORKSPACE.name, status: "available" },
	{ name: "beta", status: "available" },
	{ name: "offline", status: "missing" },
];

function createRelayWorkspaceMetadata(): Pick<RelayPreamble["authorization"], "workspaceNames" | "workspaces"> {
	return {
		workspaceNames: [...RELAY_WORKSPACE_NAMES],
		workspaces: RELAY_WORKSPACES.map((workspace) => ({ ...workspace })),
	};
}

function createPhoneHello(sessionId: string): IrohRemoteHello {
	return {
		type: "volt_iroh_hello",
		protocol: IROH_REMOTE_ALPN,
		workspace: WORKSPACE.name,
		mode: "conversation",
		conversation: { target: "session", sessionId },
	};
}

const HANDSHAKE_RESPONSE = createIrohRemoteHandshakeSuccess({
	workspace: WORKSPACE.name,
	clientNodeId: "n-phone",
	child: "volt",
	features: ["multi_streams.v1", "conversation_streams.v1"],
});

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) {
		await cleanup();
	}
});

/**
 * A phone's Iroh stream as the daemon holds it after the handshake (`stream`),
 * the phone's own end of it, and every byte the daemon wrote toward the phone,
 * recorded as it was written.
 */
interface RelayedPhoneStream {
	readonly stream: IrohBiStreamLike;
	readonly phoneEnd: IrohBiStreamLike;
	receivedFrames(): Array<Record<string, unknown>>;
}

function createRelayedPhoneStream(): RelayedPhoneStream {
	const pair = createIrohStreamPair();
	const received: Buffer[] = [];
	return {
		stream: {
			recv: pair.host.recv,
			send: {
				writeAll: async (bytes) => {
					received.push(Buffer.from(bytes));
					await pair.host.send.writeAll(bytes);
				},
				finish: async () => {
					await pair.host.send.finish?.();
				},
				reset: (errorCode) => pair.host.send.reset?.(errorCode),
			},
		},
		phoneEnd: pair.phone,
		receivedFrames: () =>
			Buffer.concat(received)
				.toString("utf8")
				.split("\n")
				.filter((line) => line.trim().length > 0)
				.map((line) => JSON.parse(line) as Record<string, unknown>),
	};
}

/** Read the TUI-written handshake response the relay delivered, then speak protocol 1 frames on the conversation. */
async function connectRelayedPhone(relayed: RelayedPhoneStream): Promise<RemotePhone> {
	const handshake = await readIrohJsonlLine(relayed.phoneEnd.recv);
	if (handshake.line === undefined) throw new Error("The relay ended before the handshake response");
	const response = JSON.parse(handshake.line) as Record<string, unknown>;
	expect(response.success).toBe(true);
	expect(response.sessionId).toBe(SESSION_ID);
	// Saved-host identity verification: the relayed handshake response must
	// prove the daemon's node id, not the TUI's absence of one.
	expect(response.hostNodeId).toBe("n-daemon-host");
	expect(response).toMatchObject({
		remoteHost: { workspaceNames: RELAY_WORKSPACE_NAMES, workspaces: RELAY_WORKSPACES },
	});
	const phone = connectRemotePhone(relayed.phoneEnd, handshake.rest);
	const welcome = await phone.hello();
	expect(welcome).toMatchObject({ profile: "remote", conversation: SESSION_ID });
	await phone.subscribe(SESSION_ID);
	return phone;
}

interface OwnedRelayDaemonHarness {
	agentDir: string;
	workspaceDir: string;
	registry: RelayRegistry;
	broker: LeaseBroker;
	server: ControlServer;
	/** The TUI host, its client connected and holding the session's lease. */
	tui: TuiHarness;
	/** The relayed frames the daemon ran for the TUI. */
	relayedFrames: Array<Extract<ControlRequest, { type: "relay_rpc" }>["frame"]>;
}

async function startOwnedRelayDaemonHarness(): Promise<OwnedRelayDaemonHarness> {
	const agentDir = mkdtempSync(join(tmpdir(), "volt-dualfe-owned-"));
	const workspaceDir = mkdtempSync(join(tmpdir(), "volt-dualfe-owned-ws-"));
	const paths = getDaemonPaths(agentDir);
	ensureDaemonDirs(paths);
	const authToken = randomUUID();
	const registry = new RelayRegistry();
	const relayedFrames: OwnedRelayDaemonHarness["relayedFrames"] = [];
	let workspaceRegistered = true;
	const broker = new LeaseBroker({
		isRuntimeStreaming: () => false,
		waitForRuntimeIdle: async () => {},
		disposeRuntime: async () => {},
		closePhoneStreams: () => {},
		closeRelays: (record, reason) => {
			for (const relayId of Array.from(record.relayIds)) {
				void registry.get(relayId)?.close(reason);
			}
		},
		beginTuiLeaseHandoff: () => {},
		commitTuiLeaseHandoff: () => {},
		cancelTuiLeaseHandoff: () => {},
		releaseTuiLease: () => {},
		audit: () => {},
	});
	const handleRequest = async (connection: ControlConnection, request: ControlRequest): Promise<void> => {
		switch (request.type) {
			case "status":
				connection.send({
					type: "status_result",
					id: request.id,
					version: "0.0.0-test",
					protocolVersion: 1,
					pid: process.pid,
					startedAtMs: 0,
					environment: { source: "inherited", reason: "not resolved" },
					leases: broker.list().map((record) => ({
						workspaceName: record.workspaceName,
						sessionId: record.sessionId,
						state: record.state,
						relayCount: record.relayIds.size,
						streamCount: record.streamCount,
					})),
					phoneConnections: registry.activeCount(),
					remoteTransport: { state: "ready" },
					workspaces: workspaceRegistered ? [{ name: WORKSPACE.name, path: workspaceDir }] : [],
					clients: [],
					keepAwake: { enabled: false, state: "disabled" },
					workers: [],
				});
				return;
			case "lease_acquire": {
				const outcome = await broker.acquireForTui({
					connectionId: connection.connectionId,
					workspaceName: request.workspaceName,
					sessionId: request.sessionId,
					force: request.force,
				});
				connection.send(
					outcome.kind === "granted"
						? {
								type: "lease_granted",
								id: request.id,
								workspaceName: request.workspaceName,
								sessionId: request.sessionId,
								handoff: outcome.handoff,
							}
						: {
								type: "lease_denied",
								id: request.id,
								reason: outcome.kind === "denied" ? outcome.reason : "draining_elsewhere",
							},
				);
				return;
			}
			case "lease_release": {
				const released = broker.releaseFromTui(
					connection.connectionId,
					request.workspaceName,
					request.sessionId,
					request.reason,
				);
				connection.send(
					released.ok
						? { type: "ok", id: request.id }
						: { type: "error", id: request.id, code: released.code, message: "lease not held" },
				);
				return;
			}
			case "relay_rpc": {
				const authorized = registry.authorizeRpc(request.relayId, connection.connectionId, {
					clientNodeId: request.clientNodeId,
					workspaceName: request.workspaceName,
					sessionId: request.sessionId,
				});
				if (!authorized.ok) {
					connection.send({
						type: "error",
						id: request.id,
						code: authorized.code,
						message: authorized.message,
					});
					return;
				}
				const frame = request.frame;
				relayedFrames.push(frame);
				if (frame.type !== "unregister_workspace") {
					connection.send({ type: "error", id: request.id, code: "unsupported", message: frame.type });
					return;
				}
				workspaceRegistered = false;
				connection.send({
					type: "relay_rpc_result",
					id: request.id,
					frame: {
						type: "accepted",
						intentId: frame.intentId,
						ordinals: [],
						result: { workspaceName: WORKSPACE.name, unregistered: true },
					},
				});
				return;
			}
			default:
				connection.send({ type: "error", id: request.id, code: "unsupported", message: request.type });
		}
	};
	const server = await startControlServer({
		socketPath: paths.socketPath,
		version: "0.0.0-test",
		authToken,
		handlers: {
			onRequest: handleRequest,
			onConnectionClosed: (connection) => broker.releaseAllForConnection(connection.connectionId),
			relayAdmission: {
				admitRelay: (hello, socket, bufferedRemainder) =>
					registry.admit(hello.relayId, hello.relayToken, socket, bufferedRemainder),
			},
		},
	});
	writeFileSync(
		paths.pidfilePath,
		`${JSON.stringify({
			pid: process.pid,
			version: "0.0.0-test",
			startedAtMs: Date.now(),
			socketPath: paths.socketPath,
			token: authToken,
		})}\n`,
		{ mode: 0o600 },
	);
	cleanups.push(async () => {
		await Promise.all(
			registry.all().map((relay) => relay.close("host_shutdown", { pendingMessage: "daemon shutting down" })),
		);
		await server.close();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(workspaceDir, { recursive: true, force: true });
	});
	// The TUI shows the session in the workspace; once its client is ready, its host leases the session.
	const tui = await createTuiHarness({
		link: createDaemonLink({ cwd: workspaceDir, agentDir, autoStart: false }),
		startup: { id: SESSION_ID, cwd: workspaceDir },
	});
	cleanups.push(() => tui.cleanup());
	await tui.connect();
	expect(broker.lookup(WORKSPACE.name, SESSION_ID)?.state).toBe("tui-owned");
	return { agentDir, workspaceDir, registry, broker, server, tui, relayedFrames };
}

function mintOwnedPhoneRelay(harness: OwnedRelayDaemonHarness, clientNodeId: string, streamId: string) {
	const record = harness.broker.lookup(WORKSPACE.name, SESSION_ID);
	const ownerControlConnectionId = record?.tuiConnectionId;
	if (!ownerControlConnectionId) {
		throw new Error("TUI lease has no control owner");
	}
	const phone = createRelayedPhoneStream();
	let framesAtSettlement: Array<Record<string, unknown>> = [];
	const settle = vi.fn((outcome: RelayOutcome) => {
		framesAtSettlement = phone.receivedFrames();
		harness.broker.unregisterRelay(WORKSPACE.name, SESSION_ID, relay.relayId);
		harness.server.sendTo(ownerControlConnectionId, {
			type: "relay_closed",
			relayId: relay.relayId,
			reason: outcome.reason,
		});
	});
	const relay = harness.registry.mint({
		workspaceName: WORKSPACE.name,
		sessionId: SESSION_ID,
		clientNodeId,
		ownerControlConnectionId,
		connectionId: `conn-${clientNodeId}`,
		streamId,
		stream: phone.stream,
		preamble: {
			kind: "phone",
			handshake: { hello: createPhoneHello(SESSION_ID), response: HANDSHAKE_RESPONSE, initialInput: [] },
			authorization: {
				clientNodeId,
				workspaceName: WORKSPACE.name,
				workspacePath: harness.workspaceDir,
				...createRelayWorkspaceMetadata(),
				allowedTools: "",
				rpcGrant: RPC_GRANT,
			},
			hostNodeId: "n-daemon-host",
			relayMode: "development",
			connectionId: `conn-${clientNodeId}`,
			streamId,
			resolvedTarget: {
				sessionId: SESSION_ID,
				selection: "resumed",
				requestedSessionId: SESSION_ID,
				workspaceName: WORKSPACE.name,
				workspacePath: harness.workspaceDir,
			},
		},
		rejectPending: () => {},
		onSettled: settle,
	});
	if (!harness.broker.registerRelay(WORKSPACE.name, SESSION_ID, relay.relayId)) {
		throw new Error("TUI lease rejected relay registration");
	}
	harness.server.sendTo(ownerControlConnectionId, {
		type: "relay_offer",
		clientKind: "phone",
		relayId: relay.relayId,
		relayToken: relay.relayToken,
		workspaceName: WORKSPACE.name,
		sessionId: SESSION_ID,
		clientNodeId,
		connectionId: relay.connectionId,
		streamId,
	});
	return { phone, relay, settle, framesAtSettlement: () => framesAtSettlement };
}

/** The live items the phone received after its subscription's reset. */
function liveItemsAfterReset(phone: RemotePhone): LiveItem[] {
	const reset = phone.frames.findIndex((frame) => frame.type === "live" && frame.reset === true);
	return phone.frames.slice(reset + 1).flatMap((frame) => (frame.type === "live" ? frame.items : []));
}

function hasUserEntry(phone: RemotePhone, text: string): boolean {
	return phone.frames.some(
		(frame) =>
			frame.type === "entry" &&
			frame.entry.type === "message" &&
			frame.entry.view?.role === "user" &&
			frame.entry.view.text === text,
	);
}

function busy(phone: RemotePhone): boolean | undefined {
	let value: boolean | undefined;
	for (const item of phone.frames.flatMap((frame) => (frame.type === "live" ? frame.items : []))) {
		if (item.type === "set" && item.value.kind === "phase") value = item.value.busy;
	}
	return value;
}

describe("dual-frontend relayed conversation (§12.3.3)", () => {
	it("serves two co-attached phones from one TUI conversation: prompts land, the turn fans out, abort keeps both relays open", async () => {
		const harness = await startOwnedRelayDaemonHarness();
		const { registry, tui } = harness;
		const conversation = tui.connector.conversation;

		// Two phones with distinct clientNodeIds attach concurrently; the daemon
		// offers one relay each, and the TUI host redeems and serves both.
		const attachA = mintOwnedPhoneRelay(harness, "n-phone-a", "st-1");
		const attachB = mintOwnedPhoneRelay(harness, "n-phone-b", "st-2");
		await vi.waitFor(() => {
			expect(tui.relayCount()).toBe(2);
			expect(registry.activeCount()).toBe(2);
		});

		// Both phones receive the TUI-written handshake success over the relay, then the conversation.
		const [phoneA, phoneB] = await Promise.all([
			connectRelayedPhone(attachA.phone),
			connectRelayedPhone(attachB.phone),
		]);

		// Phone A prompts; the TUI's in-process conversation runs it until it is aborted.
		const started = Promise.withResolvers<void>();
		tui.faux.setResponses([
			(_context, options) =>
				new Promise((resolve) => {
					started.resolve();
					const stop = () => resolve(fauxAssistantMessage("stopped", { stopReason: "aborted" }));
					if (options?.signal?.aborted) stop();
					else options?.signal?.addEventListener("abort", stop, { once: true });
				}),
		]);
		expect(await phoneA.intent("prompt", { message: "hello from phone a" })).toMatchObject({ type: "accepted" });
		await started.promise;

		// The turn fans out to BOTH phones through their relays: the phone's
		// prompt as an entry, the busy phase, and the intents' changed state.
		await vi.waitFor(() => {
			for (const phone of [phoneA, phoneB]) {
				expect(hasUserEntry(phone, "hello from phone a")).toBe(true);
				expect(busy(phone)).toBe(true);
				expect(liveItemsAfterReset(phone)).toContainEqual(expect.objectContaining({ type: "set", key: "intents" }));
			}
		});

		// Abort from phone B stops the turn; both relays and streams stay open.
		expect(await phoneB.intent("abort", {})).toMatchObject({ type: "accepted" });
		await vi.waitFor(() => {
			for (const phone of [phoneA, phoneB]) expect(busy(phone)).toBe(false);
		});
		expect(conversation.session.isBusy).toBe(false);
		expect(registry.activeCount()).toBe(2);
		for (const phone of [phoneA, phoneB]) {
			expect(phone.frames.some((frame) => frame.type === "ended" || frame.type === "fatal")).toBe(false);
		}
		expect(attachA.settle).not.toHaveBeenCalled();
		expect(attachB.settle).not.toHaveBeenCalled();

		// Both phones keep receiving the conversation after the abort.
		conversation.liveState.notice("info", "after abort");
		await vi.waitFor(() => {
			for (const phone of [phoneA, phoneB]) {
				expect(liveItemsAfterReset(phone)).toContainEqual(
					expect.objectContaining({ type: "notice", message: "after abort" }),
				);
			}
		});

		// Phone A hangs up: its relay settles phone_disconnected and its serving
		// connection ends, while phone B stays attached and live.
		await phoneA.close();
		await vi.waitFor(() => {
			expect(attachA.settle).toHaveBeenCalledTimes(1);
			expect(registry.activeCount()).toBe(1);
			expect(tui.relayCount()).toBe(1);
		});
		expect(attachA.settle.mock.calls[0]?.[0]?.reason).toBe("phone_disconnected");

		conversation.liveState.notice("info", "only phone b");
		await vi.waitFor(() =>
			expect(liveItemsAfterReset(phoneB)).toContainEqual(
				expect.objectContaining({ type: "notice", message: "only phone b" }),
			),
		);
		expect(attachB.settle).not.toHaveBeenCalled();

		await phoneB.close();
		await vi.waitFor(() => {
			expect(registry.activeCount()).toBe(0);
			expect(tui.relayCount()).toBe(0);
		});
		// The phones leaving never closes the TUI's conversation.
		expect(conversation.closed).toBe(false);
	}, 20_000);

	/**
	 * A phone relayed through the TUI unregisters the TUI's workspace: the TUI
	 * forwards the intent to the daemon, answers the phone with the daemon's
	 * outcome, ends the phone's stream, and releases the session's lease,
	 * which retires every relay of the session.
	 */
	async function unregisterThroughRelay(options: { pipelined?: object }) {
		const harness = await startOwnedRelayDaemonHarness();
		const { tui } = harness;

		const attachA = mintOwnedPhoneRelay(harness, "n-phone-a", "st-unregister-1");
		const attachB = mintOwnedPhoneRelay(harness, "n-phone-b", "st-unregister-2");
		await vi.waitFor(() => {
			expect(tui.relayCount()).toBe(2);
			expect(harness.registry.activeCount()).toBe(2);
		});
		const [phoneA, phoneB] = await Promise.all([
			connectRelayedPhone(attachA.phone),
			connectRelayedPhone(attachB.phone),
		]);

		phoneA.send({
			type: "unregister_workspace",
			intentId: "remove-relayed-workspace",
			input: { workspaceName: WORKSPACE.name },
		});
		if (options.pipelined) phoneA.send(options.pipelined);

		await vi.waitFor(() => {
			expect(attachA.settle).toHaveBeenCalledTimes(1);
			expect(attachB.settle).toHaveBeenCalledTimes(1);
			expect(harness.registry.activeCount()).toBe(0);
			expect(tui.relayCount()).toBe(0);
		});
		await Promise.all([phoneA.ended, phoneB.ended]);
		return { harness, tui, attachA, attachB, phoneA, phoneB };
	}

	const UNREGISTER_ACCEPTED = {
		type: "accepted",
		intentId: "remove-relayed-workspace",
		ordinals: [],
		result: { workspaceName: WORKSPACE.name, unregistered: true },
	};

	it("delivers relay unregister before retiring every relay, lease record, and local relay tracker", async () => {
		const { harness, tui, attachA, attachB, phoneA } = await unregisterThroughRelay({});

		// The daemon ran the unregister; the TUI answered the phone with the daemon's outcome.
		expect(harness.relayedFrames).toEqual([
			{
				type: "unregister_workspace",
				intentId: "remove-relayed-workspace",
				input: { workspaceName: WORKSPACE.name },
			},
		]);
		// The answer was delivered before the relay retired; then the stream ended for the unregistered workspace.
		expect(attachA.framesAtSettlement()).toContainEqual(UNREGISTER_ACCEPTED);
		const tail = phoneA.frames.slice(phoneA.frames.findIndex((frame) => frame.type === "accepted"));
		expect(tail).toEqual([UNREGISTER_ACCEPTED, { type: "fatal", code: "workspace_unregistered" }]);
		// Phone B's relay retires with the lease.
		expect(attachB.settle.mock.calls[0]?.[0]?.reason).toBe("workspace_unregistered");
		expect(harness.broker.lookup(WORKSPACE.name, SESSION_ID)).toBeUndefined();
		// The TUI keeps its conversation.
		expect(tui.connector.conversation.closed).toBe(false);
	}, 20_000);

	it("serves nothing a phone pipelined after its accepted unregister", async () => {
		const { phoneA } = await unregisterThroughRelay({
			pipelined: { type: "query", queryId: "pipelined-after-unregister", query: "intents" },
		});
		const tail = phoneA.frames.slice(phoneA.frames.findIndex((frame) => frame.type === "accepted"));
		expect(tail).toEqual([UNREGISTER_ACCEPTED, { type: "fatal", code: "workspace_unregistered" }]);
	}, 20_000);
});
