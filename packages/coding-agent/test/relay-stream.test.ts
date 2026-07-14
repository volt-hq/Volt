import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { createIrohRemotePresetAccess } from "../src/core/remote/iroh/access-grant.ts";
import { type ControlServer, startControlServer } from "../src/daemon/control-server.ts";
import { RELAY_TOKEN_TTL_MS, type RelayOutcome, RelayRegistry } from "../src/daemon/relay-stream.ts";
import { connectRawRelayClient, FakePhoneIrohStream } from "./relay-doubles.ts";
import { createTestSocketEndpoint } from "./socket-test-helpers.ts";

interface RelayHarness {
	socketPath: string;
	registry: RelayRegistry;
	server: ControlServer;
}

const cleanups: Array<() => Promise<void> | void> = [];

async function startRelayHarness(): Promise<RelayHarness> {
	const endpoint = createTestSocketEndpoint("volt-relay");
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
		// server.close() waits for open sockets; admitted relays hold theirs.
		for (const relay of registry.activeRelays()) {
			relay.close("host_shutdown");
		}
		await server.close();
		endpoint.cleanup();
	});
	return { socketPath: endpoint.socketPath, registry, server };
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) {
		await cleanup();
	}
});

const RELAY_AUTHORIZATION = {
	clientNodeId: "n-phone-a",
	workspaceName: "ws",
	workspacePath: "/tmp/ws",
	allowedTools: "read",
	rpcGrant: createIrohRemotePresetAccess("full").rpcGrant,
};

const HANDSHAKE_VERBATIM = {
	hello: {
		type: "volt_iroh_hello",
		protocol: "volt-rpc/0",
		workspace: "ws",
		mode: "conversation",
		conversation: { target: "session", sessionId: "s-1" },
		clientInfo: { label: "phône 📱", nested: [1, 2, { deep: true }], nullish: null },
	},
	response: { child: "volt", features: ["multi_streams.v1", "conversation_streams.v1"] },
	initialInput: [104, 105, 10],
};

function mintTestRelay(
	registry: RelayRegistry,
	phone: FakePhoneIrohStream,
	settle: (outcome: RelayOutcome) => void,
	now?: number,
) {
	return registry.mint({
		workspaceName: "ws",
		sessionId: "s-1",
		clientNodeId: "n-phone-a",
		ownerControlConnectionId: "control-1",
		connectionId: "conn-1",
		streamId: "st-1",
		stream: phone,
		preamble: {
			handshake: HANDSHAKE_VERBATIM,
			authorization: RELAY_AUTHORIZATION,
			hostNodeId: "n-host-1",
			relayMode: "development",
			connectionId: "conn-1",
			streamId: "st-1",
			resolvedTarget: {
				sessionId: "s-1",
				sessionFilePath: "/tmp/ws/.sessions/s-1.jsonl",
				selection: "resumed",
				requestedSessionId: "s-1",
				workspaceName: "ws",
				workspacePath: "/tmp/ws",
			},
		},
		...(now === undefined ? {} : { now }),
		settle,
	});
}

describe("relay framing (§12.2.3)", () => {
	it("acks the relay hello then writes the preamble exactly: verbatim handshake plus authorization subset", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const settle = vi.fn();
		const relay = mintTestRelay(registry, phone, settle);

		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2));

		expect(client.messages[0]).toEqual({ type: "hello_ack", ok: true });
		expect(client.messages[1]).toEqual({
			type: "relay_preamble",
			relayId: relay.relayId,
			handshake: HANDSHAKE_VERBATIM,
			authorization: RELAY_AUTHORIZATION,
			hostNodeId: "n-host-1",
			relayMode: "development",
			connectionId: "conn-1",
			streamId: "st-1",
			resolvedTarget: {
				sessionId: "s-1",
				sessionFilePath: "/tmp/ws/.sessions/s-1.jsonl",
				selection: "resumed",
				requestedSessionId: "s-1",
				workspaceName: "ws",
				workspacePath: "/tmp/ws",
			},
		});
		expect(registry.activeCount()).toBe(1);
		expect(registry.activeForConversation("n-phone-a", "ws", "s-1")[0]).toMatchObject({
			connectionId: "conn-1",
			streamId: "st-1",
		});
		expect(settle).not.toHaveBeenCalled();
	});

	it("authorizes relay RPC only for the active relay owner and exact conversation scope", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const relay = mintTestRelay(registry, new FakePhoneIrohStream(), vi.fn());
		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2));

		const scope = { clientNodeId: "n-phone-a", workspaceName: "ws", sessionId: "s-1" };
		expect(registry.authorizeRpc(relay.relayId, "control-1", scope)).toMatchObject({
			ok: true,
			relay: { relayId: relay.relayId },
		});
		expect(registry.authorizeRpc(relay.relayId, "wrong-owner", scope)).toEqual({
			ok: false,
			code: "not_held",
			message: "relay is not owned by this control connection",
		});
		expect(registry.authorizeRpc(relay.relayId, "control-1", { ...scope, sessionId: "other" })).toEqual({
			ok: false,
			code: "session_mismatch",
			message: "relay RPC scope does not match active relay",
		});
		expect(registry.authorizeRpc("missing-relay", "control-1", scope)).toEqual({
			ok: false,
			code: "not_found",
			message: "active relay not found",
		});

		registry.closeActive(relay.relayId, "tui_disconnected");
		expect(registry.authorizeRpc(relay.relayId, "control-1", scope)).toEqual({
			ok: false,
			code: "not_found",
			message: "active relay not found",
		});
	});

	it("pumps raw binary bytes transparently in both directions, including bytes buffered with the hello", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const settle = vi.fn();
		const relay = mintTestRelay(registry, phone, settle);

		// Random binary (contains 0x0a newlines with near-certainty at this size);
		// the relay must never re-frame or reinterpret it.
		const trailing = randomBytes(1024);
		const client = connectRawRelayClient(socketPath, relay);
		client.socket.on("connect", () => {
			// Lands in the same stream as (usually the same chunk as) the hello: the
			// server must hand it to the pump as bufferedRemainder, not decode it.
			client.socket.write(trailing);
		});
		await vi.waitFor(() => expect(phone.receivedBytes().equals(trailing)).toBe(true));

		// TUI -> phone: chunk sizes straddle the 64 KiB relay read limit.
		const toPhone = [randomBytes(3), randomBytes(70_000), randomBytes(257)];
		for (const chunk of toPhone) {
			client.socket.write(chunk);
		}
		const expectedPhoneBytes = Buffer.concat([trailing, ...toPhone]);
		await vi.waitFor(() => expect(phone.receivedBytes().equals(expectedPhoneBytes)).toBe(true));

		// Phone -> TUI.
		const toTui = [randomBytes(129_537), randomBytes(1), randomBytes(4096)];
		for (const chunk of toTui) {
			phone.sendBytes(chunk);
		}
		const expectedTuiBytes = Buffer.concat(toTui);
		await vi.waitFor(() => expect(client.rawReceived().equals(expectedTuiBytes)).toBe(true));

		expect(settle).not.toHaveBeenCalled();
		expect(phone.finished).toBe(false);
	});

	it("propagates a TUI-side close to the phone's send side", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const settle = vi.fn();
		const relay = mintTestRelay(registry, phone, settle);

		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2));

		client.socket.end();
		await vi.waitFor(() => {
			expect(phone.finished).toBe(true);
			expect(settle).toHaveBeenCalledTimes(1);
		});
		expect(registry.activeCount()).toBe(0);
	});

	it("propagates phone EOF to the TUI and settles phone_disconnected with byte counts", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const settle = vi.fn();
		const relay = mintTestRelay(registry, phone, settle);

		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2));

		const up = randomBytes(2048); // TUI -> phone
		const down = randomBytes(512); // phone -> TUI
		client.socket.write(up);
		phone.sendBytes(down);
		await vi.waitFor(() => {
			expect(phone.receivedBytes().equals(up)).toBe(true);
			expect(client.rawReceived().equals(down)).toBe(true);
		});

		phone.end();
		await vi.waitFor(() => {
			expect(client.ended()).toBe(true);
			expect(settle).toHaveBeenCalledTimes(1);
		});
		const outcome = settle.mock.calls[0]?.[0] as RelayOutcome;
		expect(outcome.reason).toBe("phone_disconnected");
		expect(outcome.bytesUp).toBe(up.length);
		expect(outcome.bytesDown).toBe(down.length);
		expect(registry.activeCount()).toBe(0);
	});

	it("rejects reused, wrong, expired, and unknown tokens with bad_relay_token", async () => {
		const { socketPath, registry } = await startRelayHarness();

		// Single-use: a second redemption of an admitted relay is rejected.
		const phoneA = new FakePhoneIrohStream();
		const relayA = mintTestRelay(registry, phoneA, vi.fn());
		const clientA = connectRawRelayClient(socketPath, relayA);
		await vi.waitFor(() => expect(clientA.messages).toHaveLength(2));
		const reuse = connectRawRelayClient(socketPath, relayA);
		await reuse.closed;
		expect(reuse.messages).toEqual([{ type: "hello_ack", ok: false, error: "bad_relay_token" }]);

		// A wrong token is rejected without consuming the offer.
		const phoneB = new FakePhoneIrohStream();
		const relayB = mintTestRelay(registry, phoneB, vi.fn());
		const wrongToken = connectRawRelayClient(socketPath, {
			relayId: relayB.relayId,
			relayToken: "not-the-token",
		});
		await wrongToken.closed;
		expect(wrongToken.messages).toEqual([{ type: "hello_ack", ok: false, error: "bad_relay_token" }]);
		const retryB = connectRawRelayClient(socketPath, relayB);
		await vi.waitFor(() => expect(retryB.messages).toHaveLength(2));
		expect(retryB.messages[0]).toEqual({ type: "hello_ack", ok: true });

		// Expired token.
		const phoneC = new FakePhoneIrohStream();
		const relayC = mintTestRelay(registry, phoneC, vi.fn(), Date.now() - RELAY_TOKEN_TTL_MS - 1);
		const expired = connectRawRelayClient(socketPath, relayC);
		await expired.closed;
		expect(expired.messages).toEqual([{ type: "hello_ack", ok: false, error: "bad_relay_token" }]);

		// Unknown relayId.
		const unknown = connectRawRelayClient(socketPath, { relayId: "rl-nope", relayToken: "nope" });
		await unknown.closed;
		expect(unknown.messages).toEqual([{ type: "hello_ack", ok: false, error: "bad_relay_token" }]);
	});

	it("invalidates pending offers single-use", () => {
		const registry = new RelayRegistry();
		const phone = new FakePhoneIrohStream();
		const relay = mintTestRelay(registry, phone, vi.fn());

		expect(registry.pendingForConversation("n-phone-a", "ws", "s-1")).toHaveLength(1);
		expect(registry.invalidatePending(relay.relayId)?.relayId).toBe(relay.relayId);
		expect(registry.pendingForConversation("n-phone-a", "ws", "s-1")).toHaveLength(0);
		expect(registry.invalidatePending(relay.relayId)).toBeUndefined();
	});

	it("does not admit a revoked pending offer containing a buffered prompt", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const relay = mintTestRelay(registry, phone, vi.fn());
		const bufferedPrompt = Buffer.from(`${JSON.stringify({ id: "p1", type: "prompt", message: "do not run" })}\n`);
		(relay.preamble.handshake as { initialInput: number[] }).initialInput = Array.from(bufferedPrompt);

		// Revocation uses this same synchronous invalidation before acknowledging
		// the control request. The stale token must never expose initialInput.
		expect(registry.invalidatePending(relay.relayId)).toBe(relay);
		const client = connectRawRelayClient(socketPath, relay);
		await client.closed;

		expect(client.messages).toEqual([{ type: "hello_ack", ok: false, error: "bad_relay_token" }]);
		expect(client.rawReceived()).toEqual(Buffer.alloc(0));
		expect(registry.activeCount()).toBe(0);
	});

	it("settles with tui_disconnected when the TUI destroys the relay socket", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		const settle = vi.fn();
		const relay = mintTestRelay(registry, phone, settle);
		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2)); // ack + preamble

		client.socket.destroy();
		await vi.waitFor(() => expect(settle).toHaveBeenCalled());
		const outcome = settle.mock.calls[0]?.[0] as RelayOutcome;
		expect(outcome.reason).toBe("tui_disconnected");
	});

	it("pauses the TUI socket while a phone write is in flight (backpressure)", async () => {
		const { socketPath, registry } = await startRelayHarness();
		const phone = new FakePhoneIrohStream();
		// Gate writeAll so a second chunk can only be pulled once the first write
		// completes; without backpressure the pump reads ahead unboundedly.
		const writeGates: Array<() => void> = [];
		const writtenChunks: Buffer[] = [];
		phone.send.writeAll = (bytes: Array<number>) => {
			writtenChunks.push(Buffer.from(bytes));
			return new Promise<void>((resolve) => {
				writeGates.push(resolve);
			});
		};
		const relay = mintTestRelay(registry, phone, vi.fn());
		const client = connectRawRelayClient(socketPath, relay);
		await vi.waitFor(() => expect(client.messages).toHaveLength(2)); // ack + preamble

		client.socket.write("first");
		await vi.waitFor(() => expect(writtenChunks).toHaveLength(1));
		client.socket.write("second");
		// The daemon-side socket is paused while "first" is in flight; "second"
		// must stay buffered in the socket, not in the write queue.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(writtenChunks).toHaveLength(1);

		writeGates.shift()?.();
		await vi.waitFor(() => expect(writtenChunks).toHaveLength(2));
		expect(Buffer.concat(writtenChunks).toString("utf8")).toBe("firstsecond");
		for (const gate of writeGates.splice(0)) {
			gate();
		}
	});
});
