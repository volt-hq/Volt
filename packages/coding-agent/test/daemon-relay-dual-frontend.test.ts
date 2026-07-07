/**
 * §12.3.3 dual-frontend integration: a TUI-owned conversation served over the
 * daemon's byte relay. Real control server on a tmpdir socket, real relay
 * redemption via createDaemonClient().openRelay(), real relay-socket adapter,
 * real runIrohRemoteRpcMode — only the phone transport and the session runtime
 * are doubles.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { IrohRemoteClientAuthorizationSuccess } from "../src/core/remote/iroh/authorization.ts";
import type { IrohRemoteHandshakeSuccess, IrohRemoteHello } from "../src/core/remote/iroh/handshake.ts";
import { writeIrohRemoteHandshakeResponse } from "../src/core/remote/iroh/handshake-reader.ts";
import { IrohRemoteHostStateManager } from "../src/core/remote/iroh/state-manager.ts";
import { createDaemonClient, type DaemonClient } from "../src/daemon/control-client.ts";
import { type ControlServer, startControlServer } from "../src/daemon/control-server.ts";
import {
	handleIntegratedConversationRpcCommand,
	REMOTE_SESSION_LIST_CURSOR_TTL_MS,
} from "../src/daemon/conversation-commands.ts";
import {
	createIntegratedConversationHandshakeResponse,
	decorateRemoteHostState,
	type IntegratedConversationSessionSelection,
} from "../src/daemon/handshake-responses.ts";
import { type PendingRelay, RelayRegistry } from "../src/daemon/relay-stream.ts";
import { adaptRelaySocketToIrohStream } from "../src/modes/interactive/relay-stream-adapter.ts";
import { runIrohRemoteRpcMode } from "../src/modes/rpc/iroh-remote-rpc-mode.ts";
import { createTestSession } from "./iroh-stream-doubles.ts";
import { FakePhoneIrohStream } from "./relay-doubles.ts";

const SESSION_ID = "s-relay";
const WORKSPACE = { name: "ws", path: "/tmp/ws" };

function createFanoutSession(sessionId: string) {
	const session = createTestSession(sessionId, null);
	const subscribers = new Set<(event: AgentSessionEvent) => void>();
	session.subscribe = vi.fn((handler: (event: AgentSessionEvent) => void) => {
		subscribers.add(handler);
		return () => {
			subscribers.delete(handler);
		};
	});
	const abort = vi.fn(async () => {});
	return {
		session: Object.assign(session, { abort }),
		abort,
		emit(event: AgentSessionEvent) {
			for (const handler of Array.from(subscribers)) {
				handler(event);
			}
		},
	};
}

function createAuthorization(clientNodeId: string): IrohRemoteClientAuthorizationSuccess {
	return {
		ok: true,
		allowTools: "",
		client: {
			nodeId: clientNodeId,
			label: clientNodeId,
			allowedWorkspaces: [WORKSPACE.name],
			allowedTools: "",
			pairedAt: 1,
			lastSeenAt: 2,
		},
		paired: true,
		pairingSecretConsumed: false,
		workspace: WORKSPACE,
		workspaceNames: [WORKSPACE.name],
		workspaces: [{ name: WORKSPACE.name, status: "available" }],
	};
}

function createPhoneHello(sessionId: string): IrohRemoteHello {
	return {
		type: "volt_iroh_hello",
		protocol: "volt-rpc/0",
		workspace: WORKSPACE.name,
		mode: "conversation",
		conversation: { target: "session", sessionId },
	} as IrohRemoteHello;
}

const HANDSHAKE_RESPONSE = {
	child: "volt",
	features: ["multi_streams.v1", "conversation_streams.v1"],
} as unknown as IrohRemoteHandshakeSuccess;

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

interface DaemonHarness {
	socketPath: string;
	registry: RelayRegistry;
	server: ControlServer;
}

async function startDaemonHarness(): Promise<DaemonHarness> {
	const dir = mkdtempSync(join(tmpdir(), "volt-dualfe-"));
	const socketPath = join(dir, "s.sock");
	const registry = new RelayRegistry();
	const server = await startControlServer({
		socketPath,
		version: "0.0.0-test",
		handlers: {
			onRequest: () => {},
			relayAdmission: {
				admitRelay: (hello, socket, bufferedRemainder) =>
					registry.admit(hello.relayId, hello.relayToken, socket, bufferedRemainder),
			},
		},
	});
	cleanups.push(async () => {
		for (const relay of registry.activeRelays()) {
			relay.close("host_shutdown");
		}
		await server.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return { socketPath, registry, server };
}

/** Daemon side of one phone attach: the phone stream paused behind a minted relay offer. */
function mintPhoneRelay(registry: RelayRegistry, clientNodeId: string, streamId: string) {
	const phone = new FakePhoneIrohStream();
	const settle = vi.fn();
	const relay = registry.mint({
		workspaceName: WORKSPACE.name,
		sessionId: SESSION_ID,
		clientNodeId,
		connectionId: `conn-${clientNodeId}`,
		streamId,
		stream: phone,
		preamble: {
			handshake: { hello: createPhoneHello(SESSION_ID), response: HANDSHAKE_RESPONSE },
			authorization: { clientNodeId, workspaceName: WORKSPACE.name, workspacePath: WORKSPACE.path },
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
		settle,
	});
	return { phone, relay, settle };
}

/**
 * TUI side of one relay offer, mirroring InteractiveMode.serveRelayConversation:
 * redeem the token, adapt the socket, write the handshake response, then serve
 * the stream from the shared in-process runtime via runIrohRemoteRpcMode.
 */
async function serveRelayFromTui(
	client: DaemonClient,
	relay: PendingRelay,
	runtimeHost: AgentSessionRuntime,
	tuiSessionId: string,
) {
	const opened = await client.openRelay({ relayId: relay.relayId, relayToken: relay.relayToken });
	const relayedStream = adaptRelaySocketToIrohStream(opened.stream);
	const handshake = opened.preamble.handshake as { hello: IrohRemoteHello; response: IrohRemoteHandshakeSuccess };
	const authorizationSubset = opened.preamble.authorization;
	const authorization = createAuthorization(authorizationSubset.clientNodeId);
	// The phone verifies the saved host node id in the relayed handshake
	// response, so the TUI must echo the daemon's identity from the preamble.
	const responseContext = { hostNodeId: opened.preamble.hostNodeId, relayMode: opened.preamble.relayMode };
	const resolvedTarget = opened.preamble.resolvedTarget;
	const sessionSelection: IntegratedConversationSessionSelection =
		resolvedTarget.selection === "created"
			? { kind: "created", sessionId: resolvedTarget.sessionId }
			: {
					kind: resolvedTarget.selection,
					requestedSessionId: resolvedTarget.requestedSessionId ?? resolvedTarget.sessionId,
					sessionId: resolvedTarget.sessionId,
				};

	const handshakeResponse = createIntegratedConversationHandshakeResponse(
		{ hello: handshake.hello, response: handshake.response },
		authorization,
		tuiSessionId,
		sessionSelection,
		responseContext,
	);
	await writeIrohRemoteHandshakeResponse(relayedStream.send, handshakeResponse);

	const done = runIrohRemoteRpcMode(runtimeHost, {
		stream: relayedStream,
		disposeRuntimeOnClose: false,
		workspaceName: WORKSPACE.name,
		workspacePath: WORKSPACE.path,
		suppressExtensionUiRequests: true,
		decorateOutbound: (value) => decorateRemoteHostState(value, authorization, responseContext),
		remoteCommandHandler: (command) =>
			handleIntegratedConversationRpcCommand(
				command as { type: string } & Record<string, unknown>,
				authorization,
				{
					stateManager: new IrohRemoteHostStateManager(),
					sessionListCursors: new Map(),
					sessionListCursorTtlMs: REMOTE_SESSION_LIST_CURSOR_TTL_MS,
				},
				runtimeHost,
			),
	}).finally(() => {
		relayedStream.close();
	});
	return { relayedStream, done };
}

describe("dual-frontend relayed conversation (§12.3.3)", () => {
	it("serves two co-attached phones from one TUI runtime: prompts land, events fan out, abort keeps both relays open", async () => {
		const { socketPath, registry } = await startDaemonHarness();
		const fanout = createFanoutSession(SESSION_ID);
		const dispose = vi.fn(async () => {});
		const runtimeHost = {
			session: fanout.session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose,
			setRebindSession: vi.fn(),
			listSessions: vi.fn(async () => []),
		} as unknown as AgentSessionRuntime;

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
			serveRelayFromTui(client, attachA.relay, runtimeHost, SESSION_ID),
			serveRelayFromTui(client, attachB.relay, runtimeHost, SESSION_ID),
		]);
		expect(registry.activeCount()).toBe(2);

		// Both phones receive the TUI-written handshake success over the relay.
		await vi.waitFor(() => {
			for (const attach of [attachA, attachB]) {
				const first = attach.phone.receivedFrames()[0];
				expect(first?.success).toBe(true);
				expect(first?.sessionId).toBe(SESSION_ID);
				// Saved-host identity verification: the relayed handshake response
				// must prove the daemon's node id, not the TUI's absence of one.
				expect(first?.hostNodeId).toBe("n-daemon-host");
			}
		});

		// Phone A prompts; the TUI's in-process runtime receives it.
		attachA.phone.sendLine({ id: "p1", type: "prompt", message: "hello from phone a" });
		await vi.waitFor(() => {
			expect(fanout.session.prompt).toHaveBeenCalledWith("hello from phone a", expect.anything());
			const responses = attachA.phone.receivedFrames().filter((frame) => frame.command === "prompt");
			expect(responses).toHaveLength(1);
			expect(responses[0]?.success).toBe(true);
		});

		// A streamed turn (including the user entry for the phone prompt) fans
		// out to BOTH phones through their relays.
		fanout.emit({
			type: "message_start",
			message: { role: "user", content: [{ type: "text", text: "hello from phone a" }] },
		} as unknown as AgentSessionEvent);
		fanout.emit({ type: "agent_start" } as AgentSessionEvent);
		await vi.waitFor(() => {
			for (const attach of [attachA, attachB]) {
				const frames = attach.phone.receivedFrames();
				const userEntry = frames.find((frame) => frame.type === "message_start");
				expect((userEntry?.message as Record<string, unknown> | undefined)?.role).toBe("user");
				expect(frames.some((frame) => frame.type === "agent_start")).toBe(true);
			}
		});

		// Abort from phone B stops the turn; both relays and streams stay open.
		attachB.phone.sendLine({ id: "a1", type: "abort" });
		await vi.waitFor(() => {
			const responses = attachB.phone.receivedFrames().filter((frame) => frame.command === "abort");
			expect(responses).toHaveLength(1);
			expect(responses[0]?.success).toBe(true);
		});
		expect(fanout.abort).toHaveBeenCalled();
		expect(registry.activeCount()).toBe(2);
		expect(attachA.phone.finished).toBe(false);
		expect(attachB.phone.finished).toBe(false);
		expect(attachA.settle).not.toHaveBeenCalled();
		expect(attachB.settle).not.toHaveBeenCalled();

		// Both phones keep receiving events after the abort.
		fanout.emit({ type: "agent_end" } as unknown as AgentSessionEvent);
		await vi.waitFor(() => {
			for (const attach of [attachA, attachB]) {
				expect(attach.phone.receivedFrames().some((frame) => frame.type === "agent_end")).toBe(true);
			}
		});
		expect(dispose).not.toHaveBeenCalled();

		// Phone A hangs up: its relay settles phone_disconnected and its serving
		// loop ends, while phone B stays attached and live.
		attachA.phone.end();
		await servedA.done;
		await vi.waitFor(() => {
			expect(attachA.settle).toHaveBeenCalledTimes(1);
			expect(registry.activeCount()).toBe(1);
		});
		expect(attachA.settle.mock.calls[0]?.[0]?.reason).toBe("phone_disconnected");

		fanout.emit({ type: "agent_start" } as AgentSessionEvent);
		await vi.waitFor(() => {
			const frames = attachB.phone.receivedFrames().filter((frame) => frame.type === "agent_start");
			expect(frames.length).toBeGreaterThanOrEqual(2);
		});
		expect(attachB.settle).not.toHaveBeenCalled();

		attachB.phone.end();
		await servedB.done;
		await vi.waitFor(() => expect(registry.activeCount()).toBe(0));
		expect(dispose).not.toHaveBeenCalled();
	});
});
