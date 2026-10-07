/**
 * A client of a host that runs elsewhere resumes after a connection that
 * ended unannounced (Phase 7 slice 8): `connectThrough` opens its
 * conversation again with backoff, and the client keeps its transcript,
 * holds what it asks meanwhile, and resumes after its position on the new
 * connection, where what it asked goes out again and is answered once. A
 * host that ends the connection shutting down is reconnected to only when it
 * restarts; otherwise the client quits. A move whose target cannot be
 * reached goes back to the conversation the client left.
 */

import { clientActiveBranch } from "@hansjm10/volt-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type ConnectorTarget,
	type ConversationConnector,
	ConversationUnavailableError,
	connectThrough,
	type OpenedConversation,
	type ReconnectAttempt,
} from "../../src/client/conversation-connector.ts";
import { type ProtocolClient, ProtocolConnectionLostError } from "../../src/client/protocol-client.ts";
import type { ConversationHost } from "../../src/core/host/conversation-host.ts";
import type { HostedConversation } from "../../src/core/host/hosted-conversation.ts";
import type { HostedRedirect } from "../../src/core/host/targets.ts";
import { localProfile } from "../../src/core/protocol/profiles.ts";
import { type ProtocolConnection, serveConnection } from "../../src/core/protocol/server/connection.ts";
import { createLoopbackRpcTransportPair } from "../../src/core/protocol/transport/loopback-transport.ts";
import type { RpcTransport } from "../../src/core/protocol/transport/transport.ts";
import { createHostHarness, type HostHarness } from "./host-harness.ts";

const HOSTED_HERE: HostedRedirect = { async commit() {}, async abort() {} };

/** A connector to a host "elsewhere": each open serves a fresh connection; the test ends them as a crash or a stop would. */
class RemoteHostConnector implements ConversationConnector {
	readonly reconnects = true;
	/** Whether the host restarts when it ends a connection shutting down. */
	restarting = false;
	/** Failures the next opens throw, in order. */
	readonly failNext: Error[] = [];
	readonly opened: ConnectorTarget[] = [];
	readonly connections: Array<{ connection: ProtocolConnection; server: RpcTransport }> = [];
	private readonly host: ConversationHost;
	private readonly startup: HostedConversation;

	constructor(host: ConversationHost, startup: HostedConversation) {
		this.host = host;
		this.startup = startup;
	}

	async open(target: ConnectorTarget): Promise<OpenedConversation> {
		this.opened.push(target);
		const failure = this.failNext.shift();
		if (failure) throw failure;
		const conversation = target.kind === "startup" ? this.startup : this.host.get(target.sessionId);
		if (!conversation) throw new Error("Not open here");
		const pair = createLoopbackRpcTransportPair();
		const connection = serveConnection(pair.server, localProfile, {
			host: this.host,
			conversation,
			anchor: false,
			clientKey: "the-tui",
			redirect: { hostTarget: async () => HOSTED_HERE, hostsClientMoves: true, hostsStoredSessions: true },
		});
		this.connections.push({ connection, server: pair.server });
		return { transport: pair.client, sessionId: conversation.id, notices: [] };
	}

	/** The connection serving the client now. */
	get current(): { connection: ProtocolConnection; server: RpcTransport } {
		const current = this.connections.at(-1);
		if (!current) throw new Error("Nothing is served");
		return current;
	}

	async hostRestarting(): Promise<boolean> {
		return this.restarting;
	}

	stopServing(): void {}

	async dispose(): Promise<void> {}

	daemonWorkspaceName(): string | undefined {
		return undefined;
	}

	onThemeSnapshot(): () => void {
		return () => {};
	}
}

function userTexts(client: ProtocolClient): string[] {
	return clientActiveBranch(client.state).flatMap((entry) => {
		const message = entry.type === "message" ? entry.payload?.message : undefined;
		if (message?.role !== "user") return [];
		return [
			typeof message.content === "string"
				? message.content
				: message.content.map((block) => ("text" in block ? block.text : "")).join(""),
		];
	});
}

describe("a client resuming after a lost connection", () => {
	const harnesses: HostHarness[] = [];
	const clients: ProtocolClient[] = [];

	afterEach(async () => {
		for (const client of clients.splice(0)) await client.stop().catch(() => undefined);
		for (const harness of harnesses.splice(0)) await harness.cleanup();
	});

	async function start(options: Parameters<typeof connectThrough>[1] = {}) {
		const harness = await createHostHarness({ whenUnattached: "keep", responses: ["one", "two", "three"] });
		harnesses.push(harness);
		const startup = await harness.openStartup();
		const connector = new RemoteHostConnector(harness.host, startup);
		const client = await connectThrough(connector, options);
		clients.push(client);
		return { harness, startup, connector, client };
	}

	it("keeps its transcript, holds what the user sends, and resumes after its position once reopened", async () => {
		const attempts: ReconnectAttempt[] = [];
		const reconnected = vi.fn();
		const { startup, connector, client } = await start({
			onReconnecting: (attempt) => attempts.push(attempt),
			onReconnected: reconnected,
		});
		await client.promptAndWait("first");
		const held = client.state.entries.length;
		// The host is unreachable at first; the second attempt reaches it.
		connector.failNext.push(new Error("The daemon is not running"));

		await connector.current.server.close();
		await vi.waitFor(() => expect(client.disconnected).toBe(true));
		expect(client.state.entries).toHaveLength(held);
		const sent = client.prompt("typed while disconnected");

		await sent;
		await client.waitForIdle();
		expect(reconnected).toHaveBeenCalledOnce();
		expect(attempts.map(({ attempt, reason }) => [attempt, reason])).toEqual([
			[1, "lost"],
			[2, "lost"],
		]);
		expect(attempts[1]?.error?.message).toBe("The daemon is not running");
		expect(connector.opened.slice(1)).toEqual([
			{ kind: "session", sessionId: startup.id, resume: true },
			{ kind: "session", sessionId: startup.id, resume: true },
		]);
		// One prompt each, once: the resumed subscription continued after the client's position.
		expect(userTexts(client)).toEqual(["first", "typed while disconnected"]);
		expect(
			startup.session.messages.filter((message) => message.role === "user").map((message) => message.content),
		).toHaveLength(2);
	});

	it("fails an intent that went out unanswered when the connection was lost, and does not send it again", async () => {
		const { startup, connector, client } = await start();
		const running = client.intent("bash", { command: "sleep 2 && echo once" });
		await vi.waitFor(() => expect(startup.session.isBashRunning).toBe(true));

		await connector.current.server.close();
		await expect(running).rejects.toBeInstanceOf(ProtocolConnectionLostError);
		await vi.waitFor(() => expect(client.disconnected).toBe(false), { timeout: 10_000 });
		await vi.waitFor(() => expect(startup.session.isBashRunning).toBe(false), { timeout: 10_000 });
		await new Promise((resolve) => setTimeout(resolve, 500));
		const runs = client.state.entries.filter(
			(entry) => entry.type === "message" && entry.payload?.message.role === "bashExecution",
		);
		expect(runs).toHaveLength(1);
	});

	it("resumes after the host shut down only when the host restarts; otherwise the client quits", async () => {
		const restarting = await start();
		restarting.connector.restarting = true;
		await restarting.connector.current.connection.shutdown();
		await vi.waitFor(() => expect(restarting.connector.connections).toHaveLength(2));
		await vi.waitFor(() => expect(restarting.client.disconnected).toBe(false));
		await restarting.client.promptAndWait("after the restart");
		expect(userTexts(restarting.client)).toEqual(["after the restart"]);

		const shutdownRequested = vi.fn();
		const asked = await start({ onShutdownRequested: shutdownRequested });
		await asked.connector.current.connection.shutdown();
		await vi.waitFor(() => expect(shutdownRequested).toHaveBeenCalledOnce());
		expect(asked.connector.connections).toHaveLength(1);
		await expect(asked.client.prompt("too late")).rejects.toThrow();
	});

	it("stops when its conversation can no longer be opened", async () => {
		const stopped = vi.fn();
		const { connector, client } = await start({ onStopped: stopped });
		connector.failNext.push(new ConversationUnavailableError("The conversation is gone"));
		await connector.current.server.close();
		await vi.waitFor(() => expect(stopped).toHaveBeenCalledOnce());
		expect(stopped.mock.calls[0]?.[0]).toBeInstanceOf(ConversationUnavailableError);
		await expect(client.prompt("nowhere")).rejects.toThrow("The conversation is gone");
	});

	it("goes back to the conversation it left when a move's target cannot be reached", async () => {
		const moveFailed = vi.fn();
		const { startup, connector, client } = await start({ onMoveFailed: moveFailed });
		await client.promptAndWait("stay here");
		connector.failNext.push(new Error("The target's worker did not start"));

		const target = (await client.intent("new_session", {})).conversation;
		await vi.waitFor(() => expect(moveFailed).toHaveBeenCalledOnce());
		expect(moveFailed.mock.calls[0]).toEqual([
			expect.objectContaining({ message: "The target's worker did not start" }),
			target,
		]);
		await vi.waitFor(() => {
			expect(client.moving).toBeUndefined();
			expect(client.conversation).toBe(startup.id);
		});
		await client.caughtUp();
		expect(userTexts(client)).toEqual(["stay here"]);
	});
});
