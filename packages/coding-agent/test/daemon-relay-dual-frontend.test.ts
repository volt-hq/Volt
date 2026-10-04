/**
 * §12.3.3 dual-frontend integration: a TUI-owned conversation served over the
 * daemon's byte relay. Real control server on a tmpdir socket, real relay
 * redemption via createDaemonClient().openRelay(), real relay-socket adapter,
 * a real conversation host over the faux provider, and the phone's stream
 * served on the remote profile as InteractiveMode.serveRelayConversation
 * serves it. Only the phone's Iroh stream is in memory.
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProvider, fauxAssistantMessage } from "@hansjm10/volt-ai";
import type { LiveItem } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationHost } from "../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../src/core/host/hosted-conversation.ts";
import type { ProtocolConnection } from "../src/core/protocol/server/connection.ts";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { serveIrohRemoteConnection } from "../src/core/remote/iroh/connection.ts";
import { createIrohRemoteHandshakeSuccess, type IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import { writeIrohRemoteHandshakeResponse } from "../src/core/remote/iroh/handshake-reader.ts";
import { IROH_REMOTE_ALPN } from "../src/core/remote/iroh/protocol.ts";
import { type IrohBiStreamLike, readIrohJsonlLine } from "../src/core/rpc/iroh-transport.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createDaemonClient, type DaemonClient } from "../src/daemon/control-client.ts";
import type { ControlRequest, RelayPreamble } from "../src/daemon/control-protocol.ts";
import { type ControlConnection, type ControlServer, startControlServer } from "../src/daemon/control-server.ts";
import {
	createIntegratedConversationHandshakeResponse,
	type IntegratedConversationSessionSelection,
} from "../src/daemon/handshake-responses.ts";
import { LeaseBroker } from "../src/daemon/lease-broker.ts";
import { ensureDaemonDirs, getDaemonPaths } from "../src/daemon/paths.ts";
import { type RelayLifecycleOwner, type RelayOutcome, RelayRegistry } from "../src/daemon/relay-stream.ts";
import {
	createDaemonAttach,
	createRelayWorkspaceUnregisterRetirement,
	createTuiRelayAuthorization,
	type DaemonAttach,
	type DaemonRelayOffer,
	getRelayServingSanitizerOptions,
	type OpenedRelay,
} from "../src/modes/interactive/daemon-attach.ts";
import { adaptRelaySocketToIrohStream } from "../src/modes/interactive/relay-stream-adapter.ts";
import { createTestSocketEndpoint } from "./socket-test-helpers.ts";
import { createHostHarness } from "./suite/host-harness.ts";
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

/** The TUI's conversation, held by the TUI's own client, in a host over the faux provider. */
async function openTuiConversation(): Promise<{
	host: ConversationHost;
	conversation: HostedConversation;
	faux: FauxProvider;
}> {
	const harness = await createHostHarness({ whenUnattached: "keep" });
	cleanups.push(() => harness.cleanup());
	const sessionManager = await SessionManager.create(harness.tempDir, join(harness.tempDir, "sessions"), {
		id: SESSION_ID,
	});
	const opened = await harness.host.open({ kind: "adopt", sessionManager });
	if (opened.cancelled) throw new Error("A startup open cannot be cancelled");
	await harness.host.attach(harness.client("tui"), opened.conversation);
	return { host: harness.host, conversation: opened.conversation, faux: harness.faux };
}

interface DaemonHarness {
	socketPath: string;
	registry: RelayRegistry;
	server: ControlServer;
}

async function startDaemonHarness(): Promise<DaemonHarness> {
	const endpoint = createTestSocketEndpoint("volt-dualfe");
	const registry = new RelayRegistry();
	let server: ControlServer;
	try {
		server = await startControlServer({
			socketPath: endpoint.socketPath,
			version: "0.0.0-test",
			handlers: {
				onRequest: () => {},
				relayAdmission: {
					admitRelay: (hello, socket, bufferedRemainder) =>
						registry.admit(hello.relayId, hello.relayToken, socket, bufferedRemainder),
				},
			},
		});
	} catch (error) {
		endpoint.cleanup();
		throw error;
	}
	cleanups.push(async () => {
		await Promise.all(
			registry.all().map((relay) => relay.close("host_shutdown", { pendingMessage: "daemon shutting down" })),
		);
		await server.close();
		endpoint.cleanup();
	});
	return { socketPath: endpoint.socketPath, registry, server };
}

interface OwnedRelayDaemonHarness {
	agentDir: string;
	workspaceDir: string;
	registry: RelayRegistry;
	broker: LeaseBroker;
	server: ControlServer;
	attach: DaemonAttach;
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
	const attach = createDaemonAttach({ cwd: workspaceDir, agentDir, autoStart: false });
	await attach.start();
	expect(await attach.acquire(SESSION_ID)).toMatchObject({ kind: "granted" });
	cleanups.push(async () => {
		await attach.dispose();
		await Promise.all(
			registry.all().map((relay) => relay.close("host_shutdown", { pendingMessage: "daemon shutting down" })),
		);
		await server.close();
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(workspaceDir, { recursive: true, force: true });
	});
	return { agentDir, workspaceDir, registry, broker, server, attach, relayedFrames };
}

/** Daemon side of one phone attach: the phone stream paused behind a minted relay offer. */
function mintPhoneRelay(registry: RelayRegistry, clientNodeId: string, streamId: string) {
	const phone = createRelayedPhoneStream();
	const settle = vi.fn();
	const relay = registry.mint({
		workspaceName: WORKSPACE.name,
		sessionId: SESSION_ID,
		clientNodeId,
		ownerControlConnectionId: "control-tui",
		connectionId: `conn-${clientNodeId}`,
		streamId,
		stream: phone.stream,
		preamble: {
			handshake: { hello: createPhoneHello(SESSION_ID), response: HANDSHAKE_RESPONSE, initialInput: [] },
			authorization: {
				clientNodeId,
				workspaceName: WORKSPACE.name,
				workspacePath: WORKSPACE.path,
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
				workspacePath: WORKSPACE.path,
			},
		},
		rejectPending: () => {},
		onSettled: settle,
	});
	return { phone, relay, settle };
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

/** The TUI's handshake response for a redeemed relay, as InteractiveMode.serveRelayConversation writes it. */
function relayHandshakeResponse(opened: Pick<OpenedRelay, "preamble">) {
	const handshake = opened.preamble.handshake;
	const authorization = createTuiRelayAuthorization(opened.preamble.authorization);
	const resolvedTarget = opened.preamble.resolvedTarget;
	const sessionSelection: IntegratedConversationSessionSelection =
		resolvedTarget.selection === "created"
			? { kind: "created", sessionId: resolvedTarget.sessionId }
			: {
					kind: resolvedTarget.selection,
					requestedSessionId: resolvedTarget.requestedSessionId ?? resolvedTarget.sessionId,
					sessionId: resolvedTarget.sessionId,
				};
	return createIntegratedConversationHandshakeResponse(
		{ hello: handshake.hello, response: handshake.response },
		authorization,
		resolvedTarget.sessionId,
		sessionSelection,
		// The phone verifies the saved host node id in the relayed handshake
		// response, so the TUI must echo the daemon's identity from the preamble.
		{ hostNodeId: opened.preamble.hostNodeId, relayMode: opened.preamble.relayMode },
	);
}

/**
 * TUI side of one relay offer, mirroring InteractiveMode.serveRelayConversation:
 * redeem the token, adapt the socket, write the handshake response, then serve
 * the stream on the remote profile as a redirect client of the TUI's conversation.
 */
async function serveRelayFromTui(
	client: DaemonClient,
	relay: RelayLifecycleOwner,
	target: { host: ConversationHost; conversation: HostedConversation },
): Promise<{ connection: ProtocolConnection; done: Promise<void> }> {
	const opened = await client.openRelay({ relayId: relay.relayId, relayToken: relay.relayToken });
	const relayedStream = adaptRelaySocketToIrohStream(opened.stream);
	await writeIrohRemoteHandshakeResponse(relayedStream.send, relayHandshakeResponse(opened));
	const authorization = createTuiRelayAuthorization(opened.preamble.authorization);
	const connection = serveIrohRemoteConnection({
		host: target.host,
		conversation: target.conversation,
		stream: relayedStream,
		initialInput: opened.preamble.handshake.initialInput,
		grant: authorization.client.rpcGrant,
		redaction: getRelayServingSanitizerOptions(opened.preamble.authorization, tmpdir()),
		// The phone stays on the TUI's conversation; a session change redirects it alone.
		redirect: {},
	});
	const done = connection.closed.catch(() => undefined).finally(() => relayedStream.close());
	return { connection, done };
}

/** TUI side of one owned relay offer, with relay intents forwarded to the daemon (serveRelayConversation). */
async function serveOwnedRelayFromTui(
	daemonAttach: DaemonAttach,
	offer: DaemonRelayOffer,
	openRelay: () => Promise<OpenedRelay>,
	target: { host: ConversationHost; conversation: HostedConversation },
): Promise<void> {
	const opened = await openRelay();
	const relayedStream = adaptRelaySocketToIrohStream(opened.stream);
	const authorizationSubset = opened.preamble.authorization;
	const authorization = createTuiRelayAuthorization(authorizationSubset);
	const relayedSessionId = offer.sessionId;
	const retirement = createRelayWorkspaceUnregisterRetirement(daemonAttach, () => relayedSessionId);
	try {
		await writeIrohRemoteHandshakeResponse(relayedStream.send, relayHandshakeResponse(opened));
		const connection = serveIrohRemoteConnection({
			host: target.host,
			conversation: target.conversation,
			stream: relayedStream,
			initialInput: opened.preamble.handshake.initialInput,
			grant: authorization.client.rpcGrant,
			redaction: getRelayServingSanitizerOptions(authorizationSubset, tmpdir()),
			redirect: {},
			relay: async (frame) => {
				const outcome = await daemonAttach.forwardRelayRpc(
					authorizationSubset.clientNodeId,
					relayedSessionId,
					frame,
				);
				if (!outcome) throw new Error("daemon_unavailable");
				if (frame.type === "unregister_workspace" && outcome.type === "accepted") {
					retirement.unregistered();
					// The answer is written first; then the stream ends.
					setImmediate(() => void connection.close({ code: "workspace_unregistered" }));
				}
				return outcome;
			},
		});
		await connection.closed;
	} catch {
		// Relay teardown surfaces to the phone via the daemon's close reason.
	} finally {
		await retirement.finalize();
		relayedStream.close();
		opened.finished();
	}
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
	it("releases the session's lease once, for the unregistered workspace, after a relayed unregister", async () => {
		const release = vi.fn(async () => {});
		const retirement = createRelayWorkspaceUnregisterRetirement({ release }, () => SESSION_ID);
		// Nothing was unregistered: the relay ends without releasing the lease.
		await retirement.finalize();
		expect(release).not.toHaveBeenCalled();

		retirement.unregistered();
		expect(release).not.toHaveBeenCalled();
		await retirement.finalize();
		await retirement.finalize();
		expect(release).toHaveBeenCalledTimes(1);
		expect(release).toHaveBeenCalledWith(SESSION_ID, "workspace_unregistered");
	});

	it("serves two co-attached phones from one TUI conversation: prompts land, the turn fans out, abort keeps both relays open", async () => {
		const { socketPath, registry } = await startDaemonHarness();
		const target = await openTuiConversation();
		const { conversation } = target;

		const client = createDaemonClient({
			socketPath,
			client: "tui",
			version: "0.0.0-test",
			reconnect: false,
		});
		cleanups.push(() => client.close());

		// Two phones with distinct clientNodeIds attach concurrently; the daemon
		// mints one relay offer each and the TUI redeems and serves both.
		const attachA = mintPhoneRelay(registry, "n-phone-a", "st-1");
		const attachB = mintPhoneRelay(registry, "n-phone-b", "st-2");
		const [servedA, servedB] = await Promise.all([
			serveRelayFromTui(client, attachA.relay, target),
			serveRelayFromTui(client, attachB.relay, target),
		]);
		expect(registry.activeCount()).toBe(2);

		// Both phones receive the TUI-written handshake success over the relay, then the conversation.
		const [phoneA, phoneB] = await Promise.all([
			connectRelayedPhone(attachA.phone),
			connectRelayedPhone(attachB.phone),
		]);

		// Phone A prompts; the TUI's in-process conversation runs it until it is aborted.
		const started = Promise.withResolvers<void>();
		target.faux.setResponses([
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
		await servedA.done;
		await vi.waitFor(() => {
			expect(attachA.settle).toHaveBeenCalledTimes(1);
			expect(registry.activeCount()).toBe(1);
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
		await servedB.done;
		await vi.waitFor(() => expect(registry.activeCount()).toBe(0));
		// The phones leaving never closes the TUI's conversation.
		expect(conversation.closed).toBe(false);
	});

	/**
	 * A phone relayed through the TUI unregisters the TUI's workspace: the TUI
	 * forwards the intent to the daemon, answers the phone with the daemon's
	 * outcome, ends the phone's stream, and releases the session's lease,
	 * which retires every relay of the session.
	 */
	async function unregisterThroughRelay(options: { pipelined?: object }) {
		const harness = await startOwnedRelayDaemonHarness();
		const target = await openTuiConversation();
		const relayServers: Promise<void>[] = [];
		harness.attach.onRelayOffer((offer, openRelay) => {
			relayServers.push(serveOwnedRelayFromTui(harness.attach, offer, openRelay, target));
		});

		const attachA = mintOwnedPhoneRelay(harness, "n-phone-a", "st-unregister-1");
		const attachB = mintOwnedPhoneRelay(harness, "n-phone-b", "st-unregister-2");
		await vi.waitFor(() => {
			expect(harness.attach.relayCount()).toBe(2);
			expect(harness.registry.activeCount()).toBe(2);
			expect(relayServers).toHaveLength(2);
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
			expect(harness.attach.relayCount()).toBe(0);
		});
		await Promise.all(relayServers);
		await Promise.all([phoneA.ended, phoneB.ended]);
		return { harness, target, attachA, attachB, phoneA, phoneB };
	}

	const UNREGISTER_ACCEPTED = {
		type: "accepted",
		intentId: "remove-relayed-workspace",
		ordinals: [],
		result: { workspaceName: WORKSPACE.name, unregistered: true },
	};

	it("delivers relay unregister before retiring every relay, lease record, and local relay tracker", async () => {
		const { harness, target, attachA, attachB, phoneA } = await unregisterThroughRelay({});

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
		expect(await harness.attach.listRuntimeStates(WORKSPACE.name)).toEqual(new Map());
		// The TUI keeps its conversation.
		expect(target.conversation.closed).toBe(false);
	}, 20_000);

	it("serves nothing a phone pipelined after its accepted unregister", async () => {
		const { phoneA } = await unregisterThroughRelay({
			pipelined: { type: "query", queryId: "pipelined-after-unregister", query: "intents" },
		});
		const tail = phoneA.frames.slice(phoneA.frames.findIndex((frame) => frame.type === "accepted"));
		expect(tail).toEqual([UNREGISTER_ACCEPTED, { type: "fatal", code: "workspace_unregistered" }]);
	}, 20_000);
});
